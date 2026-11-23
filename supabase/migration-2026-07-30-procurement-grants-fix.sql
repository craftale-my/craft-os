-- ============================================================================
-- Craft OS — Procurement 补丁 (2026-07-30)
--
-- 修正 2026-07-29 那份 migration 的两个授权问题:
--   1. 授权检查排到了 PO 查找之后 —— 未授权调用方能靠两种不同报错探测
--      某个 PO id 是否存在。
--   2. `revoke ... from public` 撤不掉 Supabase 对 public schema 函数的
--      默认授权(那是显式 GRANT 给 anon 的),所以匿名仍可调用这些函数。
--
-- 已经跑过 2026-07-29 那份的,只需要跑这一份。幂等。
-- ============================================================================

create or replace function submit_receiving(
  p_po_id             uuid,
  p_invoice_photo_url text,
  p_goods_photo_url   text,
  p_notes             text,
  p_lines             jsonb
) returns uuid
language plpgsql security definer as $$
declare
  v_receiving_id    uuid;
  v_branch_id       uuid;
  v_status          text;
  v_has_discrepancy boolean := false;
  v_line            jsonb;
  v_po_item         purchase_order_items%rowtype;
  v_actual          numeric;
  v_price           numeric;
  v_shortage        numeric;
  v_conv            numeric;
begin
  -- 授权检查排在 PO 查找之前 —— 否则未授权的调用方能通过「PO 不存在」和
  -- 「无权限」两种不同报错,探测出某个 PO id 是否存在。
  if not has_procurement_cap('use_procurement') then
    raise exception 'Not authorised to receive goods';
  end if;

  -- 锁住 PO 行,防止并发重复收货(配合 receivings(po_id) 唯一索引)
  select branch_id, status into v_branch_id, v_status
    from purchase_orders where id = p_po_id
    for update;

  if not found then
    raise exception 'Purchase order not found';
  end if;

  if not can_access_branch(v_branch_id) then
    raise exception 'Not authorised to receive against this purchase order';
  end if;

  if v_status <> 'sent' then
    raise exception 'Purchase order must be in "sent" status to receive (current: %)', v_status;
  end if;

  if coalesce(p_invoice_photo_url, '') = '' then
    raise exception 'Invoice photo is required';
  end if;

  if jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then
    raise exception 'At least one line is required';
  end if;

  insert into receivings (po_id, received_by, invoice_photo_url, goods_photo_url, notes)
  values (p_po_id, auth.uid(), p_invoice_photo_url,
          nullif(p_goods_photo_url, ''), nullif(p_notes, ''))
  returning id into v_receiving_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    select * into v_po_item
      from purchase_order_items
     where id = (v_line->>'po_item_id')::uuid
       and po_id = p_po_id;

    if not found then
      raise exception 'PO line % does not belong to this purchase order', v_line->>'po_item_id';
    end if;

    v_actual := (v_line->>'actual_quantity')::numeric;
    v_price  := coalesce((v_line->>'unit_price')::numeric, v_po_item.unit_price);

    if v_actual is null or v_actual < 0 then
      raise exception 'Received quantity must be zero or more';
    end if;

    v_shortage := greatest(v_po_item.quantity_ordered - v_actual, 0);
    if v_shortage > 0 then
      v_has_discrepancy := true;
    end if;

    insert into receiving_items
      (receiving_id, po_item_id, expected_quantity, actual_quantity, shortage, unit_price)
    values
      (v_receiving_id, v_po_item.id, v_po_item.quantity_ordered, v_actual, v_shortage, v_price);

    -- 注意:不覆盖 purchase_order_items.unit_price —— 那是下单时谈好的价,
    -- 留着才能跟 invoice 实际价对比。
    update purchase_order_items
       set received_quantity = v_actual,
           shortage_quantity = v_shortage
     where id = v_po_item.id;

    select conversion_rate into v_conv from items where id = v_po_item.item_id;

    -- 换算成基础单位入库
    if v_actual > 0 then
      insert into inventory_transactions
        (item_id, branch_id, transaction_type, quantity, reference_type, reference_id, created_by)
      values
        (v_po_item.item_id, v_branch_id, 'stock_in', v_actual * v_conv,
         'receiving', v_receiving_id, auth.uid());
    end if;

    insert into item_price_history (item_id, price, source, receiving_id)
    values (v_po_item.item_id, v_price, 'receiving', v_receiving_id);

    update items set latest_price = v_price where id = v_po_item.item_id;
  end loop;

  update receivings set has_discrepancy = v_has_discrepancy where id = v_receiving_id;

  update purchase_orders
     set status = case when v_has_discrepancy then 'partially_received' else 'received' end
   where id = p_po_id;

  return v_receiving_id;
end;
$$;

-- Supabase 对 public schema 的函数有默认授权(GRANT EXECUTE TO anon, authenticated),
-- 那是**显式**授给 anon 的 —— `revoke from public` 撤不掉,必须点名撤 anon。
revoke all on function submit_receiving(uuid, text, text, text, jsonb) from public;
revoke all on function submit_receiving(uuid, text, text, text, jsonb) from anon;
grant execute on function submit_receiving(uuid, text, text, text, jsonb) to authenticated;

-- 同理:采购的权限辅助函数不该对匿名开放。
revoke all on function has_procurement_cap(text) from anon;
revoke all on function can_access_branch(uuid)  from anon;
revoke all on function current_branch_id()      from anon;
