-- ============================================================================
-- Craft OS — Procurement: over-delivery + close short (2026-10-27)
--
-- A) Over-delivery (owner decision): when a supplier delivers more than is
--    outstanding on a PO line, submit_receiving now stocks in the ACTUAL
--    quantity instead of rejecting it.
--      * receiving_items.over_quantity  — extra beyond what was outstanding
--        (purchase units, >= 0).
--      * receivings.has_over_delivery    — the receipt contains such a line.
--      * purchase_order_items.received_quantity may exceed quantity_ordered;
--        the PO becomes `received` once every line is >= ordered.
--      * A note (p_notes) is required when any line is over-delivered.
--      * The extra is costed like the rest of the line: invoice price /
--        stamped pack size (conversion_rate_used / unit_cost stamping from
--        migration-2026-10-27-cost-fix.sql is kept).
--
-- B) Close short (owner decision, brief §7.9): a manager-level user
--    (manage_procurement + can_access_branch) ends a `partially_received` PO
--    that will never be completed.
--      * New status `closed_short` (CHECK widened — only adds a value).
--      * purchase_orders.closed_by / closed_at / close_reason.
--      * RPC close_po_short(p_po_id, p_reason). No stock movement; the line
--        shortage_quantity values stay as the record of what never arrived.
--      * A guard trigger stops anyone moving a PO to `closed_short` or editing
--        the close fields except through the RPC (the existing update policy
--        would otherwise let a supervisor change a `sent` PO's status).
--      * submit_receiving refuses closed-short POs.
--
-- Prerequisites (run order): migration-2026-07-29-procurement.sql,
--   migration-2026-07-30-procurement-grants-fix.sql,
--   migration-2026-10-27-po-multi-receiving.sql,
--   migration-2026-10-27-cost-fix.sql, then this file.
-- Idempotent: safe to run more than once.
-- ============================================================================

-- 1. Columns --------------------------------------------------------------------
alter table receiving_items add column if not exists over_quantity numeric not null default 0;
alter table receivings      add column if not exists has_over_delivery boolean not null default false;

alter table purchase_orders add column if not exists closed_by    uuid;
alter table purchase_orders add column if not exists closed_at    timestamptz;
alter table purchase_orders add column if not exists close_reason text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'receiving_items_over_quantity_check') then
    alter table receiving_items add constraint receiving_items_over_quantity_check
      check (over_quantity >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'purchase_orders_closed_by_fkey') then
    alter table purchase_orders add constraint purchase_orders_closed_by_fkey
      foreign key (closed_by) references staff (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'purchase_orders_closed_short_fields_check') then
    alter table purchase_orders add constraint purchase_orders_closed_short_fields_check
      check (status <> 'closed_short'
             or (closed_at is not null and length(trim(coalesce(close_reason, ''))) > 0));
  end if;
end $$;

-- 2. Widen the status CHECK (additive: only allows one more value) ------------
alter table purchase_orders drop constraint if exists purchase_orders_status_check;
alter table purchase_orders add constraint purchase_orders_status_check
  check (status in ('draft', 'sent', 'partially_received', 'received', 'cancelled', 'closed_short'));

-- 3. Guard: closed_short only through close_po_short() ------------------------
create or replace function guard_po_close_short()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if coalesce(current_setting('craft.close_po_short', true), '') = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.status = 'closed_short' or new.closed_by is not null
       or new.closed_at is not null or new.close_reason is not null then
      raise exception 'Use the Close short action to close a purchase order short';
    end if;
  elsif (new.status = 'closed_short') is distinct from (old.status = 'closed_short')
     or new.closed_by    is distinct from old.closed_by
     or new.closed_at    is distinct from old.closed_at
     or new.close_reason is distinct from old.close_reason then
    raise exception 'Use the Close short action to close a purchase order short';
  end if;
  return new;
end;
$$;

drop trigger if exists purchase_orders_guard_close_short on purchase_orders;
create trigger purchase_orders_guard_close_short
  before insert or update on purchase_orders
  for each row execute function guard_po_close_short();

-- 4. Close-short RPC -------------------------------------------------------------
create or replace function close_po_short(p_po_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_branch_id uuid;
  v_status    text;
begin
  if not has_procurement_cap('manage_procurement') then
    raise exception 'Not authorised to close purchase orders short';
  end if;

  select branch_id, status into v_branch_id, v_status
    from purchase_orders where id = p_po_id
    for update;

  if not found then
    raise exception 'Purchase order not found';
  end if;

  if not can_access_branch(v_branch_id) then
    raise exception 'Not authorised to close this purchase order';
  end if;

  if v_status <> 'partially_received' then
    raise exception 'Only a partially received purchase order can be closed short (current: %)', v_status;
  end if;

  if length(trim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A reason is required to close a purchase order short';
  end if;

  perform set_config('craft.close_po_short', 'on', true);

  update purchase_orders
     set status       = 'closed_short',
         closed_by    = auth.uid(),
         closed_at    = now(),
         close_reason = trim(p_reason)
   where id = p_po_id;

  perform set_config('craft.close_po_short', '', true);
end;
$$;

revoke all on function close_po_short(uuid, text) from public;
revoke all on function close_po_short(uuid, text) from anon;
grant execute on function close_po_short(uuid, text) to authenticated;

-- 5. submit_receiving: accept over-delivery, refuse closed-short POs -----------
-- (Same as the cost-fix version — stamps conversion_rate_used and unit_cost —
-- with the over-receive block replaced by over-delivery recording.)
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
  v_over            numeric;
  v_has_over        boolean := false;
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

  if v_status = 'closed_short' then
    raise exception 'This purchase order was closed short — nothing more can be received on it';
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

    -- Over-delivery is accepted: the actual quantity goes into stock and the
    -- extra (purchase units) is recorded on the line; the receipt is flagged.
    v_over     := greatest(v_actual - v_outstanding, 0);
    v_shortage := greatest(v_outstanding - v_actual, 0);
    -- has_discrepancy keeps meaning "something is still short";
    -- over-delivery has its own flag.
    if v_shortage > 0 then
      v_has_discrepancy := true;
    end if;
    if v_over > 0 then
      v_has_over := true;
    end if;

    -- The pack size the PO line was raised in (stamped at PO creation);
    -- the live item rate only for lines created before the stamp existed.
    v_conv := v_po_item.conversion_rate_used;
    if v_conv is null then
      select conversion_rate into v_conv from items where id = v_po_item.item_id;
    end if;

    insert into receiving_items
      (receiving_id, po_item_id, expected_quantity, actual_quantity, shortage, unit_price,
       conversion_rate_used, over_quantity)
    values
      (v_receiving_id, v_po_item.id, v_outstanding, v_actual, v_shortage, v_price, v_conv, v_over);

    -- purchase_order_items.unit_price stays the agreed order price.
    -- received_quantity may now exceed quantity_ordered (over-delivery).
    update purchase_order_items
       set received_quantity = received_quantity + v_actual,
           shortage_quantity = greatest(quantity_ordered - (received_quantity + v_actual), 0)
     where id = v_po_item.id;

    if v_actual > 0 then
      v_any_received := true;

      insert into inventory_transactions
        (item_id, branch_id, transaction_type, quantity, reference_type, reference_id, created_by,
         unit_cost)
      values
        (v_po_item.item_id, v_branch_id, 'stock_in', v_actual * v_conv,
         'receiving', v_receiving_id, auth.uid(),
         v_price / v_conv);

      -- Only lines that actually arrived carry an invoice price.
      insert into item_price_history (item_id, price, source, receiving_id)
      values (v_po_item.item_id, v_price, 'receiving', v_receiving_id);

      update items set latest_price = v_price where id = v_po_item.item_id;
    end if;
  end loop;

  if not v_any_received then
    raise exception 'Nothing to receive — enter a quantity on at least one line';
  end if;

  if v_has_over and length(trim(coalesce(p_notes, ''))) = 0 then
    raise exception 'A note is required when a delivery exceeds what is outstanding';
  end if;

  -- Lines left out of p_lines are still outstanding too.
  if exists (
    select 1 from purchase_order_items
     where po_id = p_po_id and not (id = any(v_seen))
       and received_quantity < quantity_ordered
  ) then
    v_has_discrepancy := true;
  end if;

  update receivings
     set has_discrepancy   = v_has_discrepancy,
         has_over_delivery = v_has_over
   where id = v_receiving_id;

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
