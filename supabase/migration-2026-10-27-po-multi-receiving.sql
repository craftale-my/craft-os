-- ============================================================================
-- Craft OS — Procurement: receive one PO across multiple deliveries (2026-10-27)
--
-- Phase 1 allowed exactly one receiving per purchase order: any shortfall
-- closed the PO as `partially_received`. This migration lets a PO be received
-- in several deliveries:
--
--   * submit_receiving accepts POs in status `sent` OR `partially_received`.
--   * Each call inserts its own receivings row, receiving_items lines,
--     stock_in inventory_transactions and latest-price updates.
--   * purchase_order_items.received_quantity becomes CUMULATIVE across
--     deliveries; shortage_quantity = ordered - cumulative received (>= 0).
--   * receiving_items.expected_quantity = what was still outstanding on that
--     line when this delivery arrived; shortage = expected - actual.
--   * The PO becomes `received` once every line is fully received, otherwise
--     it stays `partially_received`.
--   * Over-receiving is blocked: a line cannot take more than its outstanding
--     quantity.
--   * A delivery must bring in something (at least one line > 0).
--
-- Permission checks are unchanged (use_procurement + can_access_branch, the
-- same order as before). Signature unchanged, so existing grants and the
-- frontend call stay valid; grants are restated anyway.
--
-- Re-runnable until migration-2026-10-27-cost-fix.sql has run; after that it STOPS (re-running
-- it would put back older function versions — re-run the later file instead).
-- ============================================================================

-- Stop if a later file already replaced what this one defines.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'receiving_items' and column_name = 'conversion_rate_used') then
    raise exception 'STOP: migration-2026-10-27-po-multi-receiving.sql is superseded by migration-2026-10-27-cost-fix.sql. Re-running it would restore older function versions; re-run migration-2026-10-27-cost-fix.sql instead.';
  end if;
end $$;

-- 1. Drop the one-receiving-per-PO rule; keep a plain lookup index instead.
drop index if exists receivings_one_per_po;
create index if not exists receivings_po_idx on receivings (po_id, received_at);

-- 2. Multi-delivery receiving RPC.
create or replace function submit_receiving(
  p_po_id             uuid,
  p_invoice_photo_url text,
  p_goods_photo_url   text,
  p_notes             text,
  p_lines             jsonb
) returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_receiving_id    uuid;
  v_branch_id       uuid;
  v_status          text;
  v_has_discrepancy boolean := false;
  v_any_received    boolean := false;
  v_line            jsonb;
  v_po_item         purchase_order_items%rowtype;
  v_actual          numeric;
  v_price           numeric;
  v_outstanding     numeric;
  v_shortage        numeric;
  v_conv            numeric;
  v_seen            uuid[] := '{}';
begin
  -- Authorisation before the PO lookup, so unauthorised callers cannot probe
  -- whether a PO id exists from the error message.
  if not has_procurement_cap('use_procurement') then
    raise exception 'Not authorised to receive goods';
  end if;

  -- Lock the PO row: serialises concurrent deliveries against the same PO.
  select branch_id, status into v_branch_id, v_status
    from purchase_orders where id = p_po_id
    for update;

  if not found then
    raise exception 'Purchase order not found';
  end if;

  if not can_access_branch(v_branch_id) then
    raise exception 'Not authorised to receive against this purchase order';
  end if;

  if v_status not in ('sent', 'partially_received') then
    raise exception 'Purchase order must be "sent" or "partially_received" to receive (current: %)', v_status;
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
       and po_id = p_po_id
       for update;

    if not found then
      raise exception 'PO line % does not belong to this purchase order', v_line->>'po_item_id';
    end if;

    if v_po_item.id = any(v_seen) then
      raise exception 'PO line % appears more than once', v_po_item.id;
    end if;
    v_seen := v_seen || v_po_item.id;

    v_actual := (v_line->>'actual_quantity')::numeric;
    v_price  := coalesce((v_line->>'unit_price')::numeric, v_po_item.unit_price);

    if v_actual is null or v_actual < 0 then
      raise exception 'Received quantity must be zero or more';
    end if;

    if v_price < 0 then
      raise exception 'Unit price must be zero or more';
    end if;

    v_outstanding := greatest(v_po_item.quantity_ordered - v_po_item.received_quantity, 0);

    if v_actual > v_outstanding then
      raise exception 'Cannot receive % on line % — only % outstanding',
        v_actual, v_po_item.id, v_outstanding;
    end if;

    v_shortage := v_outstanding - v_actual;
    if v_shortage > 0 then
      v_has_discrepancy := true;
    end if;

    insert into receiving_items
      (receiving_id, po_item_id, expected_quantity, actual_quantity, shortage, unit_price)
    values
      (v_receiving_id, v_po_item.id, v_outstanding, v_actual, v_shortage, v_price);

    -- purchase_order_items.unit_price stays the agreed order price.
    update purchase_order_items
       set received_quantity = received_quantity + v_actual,
           shortage_quantity = greatest(quantity_ordered - (received_quantity + v_actual), 0)
     where id = v_po_item.id;

    if v_actual > 0 then
      v_any_received := true;

      select conversion_rate into v_conv from items where id = v_po_item.item_id;

      insert into inventory_transactions
        (item_id, branch_id, transaction_type, quantity, reference_type, reference_id, created_by)
      values
        (v_po_item.item_id, v_branch_id, 'stock_in', v_actual * v_conv,
         'receiving', v_receiving_id, auth.uid());

      -- Only lines that actually arrived carry an invoice price.
      insert into item_price_history (item_id, price, source, receiving_id)
      values (v_po_item.item_id, v_price, 'receiving', v_receiving_id);

      update items set latest_price = v_price where id = v_po_item.item_id;
    end if;
  end loop;

  if not v_any_received then
    raise exception 'Nothing to receive — enter a quantity on at least one line';
  end if;

  -- Lines left out of p_lines are still outstanding too.
  if exists (
    select 1 from purchase_order_items
     where po_id = p_po_id and not (id = any(v_seen))
       and received_quantity < quantity_ordered
  ) then
    v_has_discrepancy := true;
  end if;

  update receivings set has_discrepancy = v_has_discrepancy where id = v_receiving_id;

  update purchase_orders
     set status = case
       when exists (
         select 1 from purchase_order_items
          where po_id = p_po_id and received_quantity < quantity_ordered
       ) then 'partially_received'
       else 'received'
     end
   where id = p_po_id;

  return v_receiving_id;
end;
$$;

revoke all on function submit_receiving(uuid, text, text, text, jsonb) from public;
revoke all on function submit_receiving(uuid, text, text, text, jsonb) from anon;
grant execute on function submit_receiving(uuid, text, text, text, jsonb) to authenticated;
