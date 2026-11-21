-- ============================================================================
-- Craft OS — Procurement: costing fix (brief §4.4 defect 1, §8 step 4) (2026-10-27)
--
-- Problem (Phase 1): submit_receiving read items.conversion_rate LIVE and
-- stored only the base-unit quantity, while receiving_items.unit_price is per
-- PURCHASE unit. Every cost per base unit (item page, stock value) was derived
-- later as latest_price / items.conversion_rate, so editing conversion_rate
-- (e.g. the supplier moves a bag from 250 g to 200 g) silently re-priced all
-- historical stock, and every unit was valued at the latest invoice price.
--
-- Fix (additive):
--   * purchase_order_items.conversion_rate_used — stamped when the PO line is
--     created (trigger) and frozen afterwards.
--   * receiving_items.conversion_rate_used — stamped by submit_receiving
--     (= the PO line's stamped rate: the price on the PO is per that pack).
--   * inventory_transactions.unit_cost — RM per BASE unit (numeric, unrounded),
--     stamped at write time:
--       - stock_in (receiving): invoice unit_price / conversion_rate_used.
--       - any other row written without a cost (manual adjustments): the
--         item's moving-average cost at that branch at that moment
--         (fallbacks: last stamped receipt cost, then latest_price /
--         conversion_rate).
--   * inventory_valuation view (security_invoker): balance, stock value
--     (sum of quantity * unit_cost) and average unit cost per item x branch.
--   * Backfill of existing rows from current values. BEST EFFORT: rows written
--     before this migration can only use today's conversion_rate.
--
-- Prerequisites: migration-2026-07-29-procurement.sql,
--   migration-2026-07-30-procurement-grants-fix.sql,
--   migration-2026-10-27-po-multi-receiving.sql (run before this file).
-- Re-runnable until migration-2026-10-27-overdelivery-close-short.sql has run; after that it STOPS (re-running
-- it would put back older function versions — re-run the later file instead).
-- ============================================================================

-- Stop if a later file already replaced what this one defines.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'receiving_items' and column_name = 'over_quantity') then
    raise exception 'STOP: migration-2026-10-27-cost-fix.sql is superseded by migration-2026-10-27-overdelivery-close-short.sql. Re-running it would restore older function versions; re-run migration-2026-10-27-overdelivery-close-short.sql instead.';
  end if;
end $$;

-- 1. Columns -----------------------------------------------------------------
alter table purchase_order_items  add column if not exists conversion_rate_used numeric;
alter table receiving_items       add column if not exists conversion_rate_used numeric;
alter table inventory_transactions add column if not exists unit_cost numeric;  -- RM per base unit

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'purchase_order_items_conversion_rate_used_check') then
    alter table purchase_order_items add constraint purchase_order_items_conversion_rate_used_check
      check (conversion_rate_used is null or conversion_rate_used > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'receiving_items_conversion_rate_used_check') then
    alter table receiving_items add constraint receiving_items_conversion_rate_used_check
      check (conversion_rate_used is null or conversion_rate_used > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'inventory_transactions_unit_cost_check') then
    alter table inventory_transactions add constraint inventory_transactions_unit_cost_check
      check (unit_cost is null or unit_cost >= 0);
  end if;
end $$;

-- 2. Cost helper: moving-average cost per base unit of an item at a branch ---
--    using ledger rows created strictly before p_before (null = all rows).
create or replace function inventory_avg_unit_cost(
  p_item_id uuid, p_branch_id uuid, p_before timestamptz default null
) returns numeric
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    -- moving average at the branch, while the branch holds stock
    (select case when sum(t.quantity) > 0
                 then sum(t.quantity * t.unit_cost) / sum(t.quantity) end
       from inventory_transactions t
      where t.item_id = p_item_id and t.branch_id = p_branch_id
        and t.unit_cost is not null
        and (p_before is null or t.created_at < p_before)),
    -- otherwise the last stamped receipt cost (any branch)
    (select t.unit_cost
       from inventory_transactions t
      where t.item_id = p_item_id and t.transaction_type = 'stock_in'
        and t.unit_cost is not null
        and (p_before is null or t.created_at < p_before)
      order by t.created_at desc
      limit 1),
    -- otherwise the item's catalogue price
    (select i.latest_price / i.conversion_rate from items i
      where i.id = p_item_id and i.conversion_rate > 0)
  );
$$;

revoke all on function inventory_avg_unit_cost(uuid, uuid, timestamptz) from public;
revoke all on function inventory_avg_unit_cost(uuid, uuid, timestamptz) from anon;
revoke all on function inventory_avg_unit_cost(uuid, uuid, timestamptz) from authenticated;
-- Internal: only the stamp trigger / backfill call it (no direct client access,
-- so a supervisor cannot read another branch's average cost through it).

-- 3. Stamp triggers -------------------------------------------------------------
-- PO lines: stamp the item's conversion rate at creation; never change it later.
create or replace function stamp_po_item_conversion_rate()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and old.conversion_rate_used is not null then
    new.conversion_rate_used := old.conversion_rate_used;
  elsif new.conversion_rate_used is null
        or (tg_op = 'UPDATE' and old.conversion_rate_used is null) then
    select conversion_rate into new.conversion_rate_used from items where id = new.item_id;
  end if;
  return new;
end;
$$;

drop trigger if exists purchase_order_items_stamp_conversion on purchase_order_items;
create trigger purchase_order_items_stamp_conversion
  before insert or update on purchase_order_items
  for each row execute function stamp_po_item_conversion_rate();

-- Ledger rows without a cost (manual adjustments): moving-average cost now.
create or replace function stamp_inventory_unit_cost()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if new.unit_cost is null then
    new.unit_cost := inventory_avg_unit_cost(new.item_id, new.branch_id, null);
  end if;
  return new;
end;
$$;

drop trigger if exists inventory_transactions_stamp_unit_cost on inventory_transactions;
create trigger inventory_transactions_stamp_unit_cost
  before insert on inventory_transactions
  for each row execute function stamp_inventory_unit_cost();

-- 4. Backfill (best effort: uses today's conversion_rate) ---------------------
update purchase_order_items poi
   set conversion_rate_used = i.conversion_rate
  from items i
 where i.id = poi.item_id and poi.conversion_rate_used is null;

update receiving_items ri
   set conversion_rate_used = poi.conversion_rate_used
  from purchase_order_items poi
 where poi.id = ri.po_item_id and ri.conversion_rate_used is null;

-- stock_in rows from receivings: invoice price / stamped rate. If one receiving
-- has several lines for the same item, use their quantity-weighted cost.
update inventory_transactions t
   set unit_cost = c.cost
  from (
    select ri.receiving_id, poi.item_id,
           sum(ri.actual_quantity * ri.unit_price)
             / nullif(sum(ri.actual_quantity * ri.conversion_rate_used), 0) as cost
      from receiving_items ri
      join purchase_order_items poi on poi.id = ri.po_item_id
     where ri.actual_quantity > 0
     group by ri.receiving_id, poi.item_id
  ) c
 where t.unit_cost is null
   and t.transaction_type = 'stock_in'
   and t.reference_type = 'receiving'
   and t.reference_id = c.receiving_id
   and t.item_id = c.item_id;

-- Remaining rows (adjustments etc.), in time order, at the moving average
-- before each row.
do $$
declare r record;
begin
  for r in select id, item_id, branch_id, created_at
             from inventory_transactions
            where unit_cost is null
            order by created_at, id
  loop
    update inventory_transactions
       set unit_cost = inventory_avg_unit_cost(r.item_id, r.branch_id, r.created_at)
     where id = r.id;
  end loop;
end $$;

-- 5. submit_receiving: stamp conversion_rate_used and unit_cost ---------------
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

    -- The pack size the PO line was raised in (stamped at PO creation);
    -- the live item rate only for lines created before the stamp existed.
    v_conv := v_po_item.conversion_rate_used;
    if v_conv is null then
      select conversion_rate into v_conv from items where id = v_po_item.item_id;
    end if;

    insert into receiving_items
      (receiving_id, po_item_id, expected_quantity, actual_quantity, shortage, unit_price,
       conversion_rate_used)
    values
      (v_receiving_id, v_po_item.id, v_outstanding, v_actual, v_shortage, v_price, v_conv);

    -- purchase_order_items.unit_price stays the agreed order price.
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

-- 6. Valuation view -------------------------------------------------------------
-- Same row set as inventory_balances (active items x active branches). Rows
-- without a stamped cost (none after the backfill) fall back to the catalogue
-- price so the value is never silently zero.
create or replace view inventory_valuation
with (security_invoker = true) as
select i.id as item_id,
       b.id as branch_id,
       coalesce(sum(t.quantity), 0) as balance,
       coalesce(sum(t.quantity * coalesce(t.unit_cost, i.latest_price / nullif(i.conversion_rate, 0))), 0)
         as stock_value,
       case when coalesce(sum(t.quantity), 0) > 0
            then sum(t.quantity * coalesce(t.unit_cost, i.latest_price / nullif(i.conversion_rate, 0)))
                 / sum(t.quantity)
       end as avg_unit_cost,
       count(t.id) filter (where t.unit_cost is null) as uncosted_rows
  from items i
  cross join branches b
  left join inventory_transactions t on t.item_id = i.id and t.branch_id = b.id
 where i.status = 'active' and b.is_active
 group by i.id, b.id;

revoke all on inventory_valuation from anon;
revoke all on inventory_valuation from public;
grant select on inventory_valuation to authenticated;
