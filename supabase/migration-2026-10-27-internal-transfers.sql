-- ============================================================================
-- Craft OS — Internal transfers: internal POs to HQ (brief §7.2, §8 step 10)
-- (2026-10-27)
--
-- Flow (owner, 2026-10-26): a branch raises a PO to the HQ supplier row (an
-- "internal PO"), HQ (Cheras) ships it with ship_internal_po() — transfer_out
-- at HQ — and the branch receives it on the normal receiving screen with a
-- mandatory photo and the actual quantity — transfer_in at the branch.
-- Stock enters the branch ledger only on receipt; shipped-but-not-received is
-- "in transit".
--
-- Units: purchase_order_items quantities (ordered / shipped / received /
-- transit loss) are in the PO line's purchase unit, like the rest of the PO.
-- po_shipment_items.qty_shipped is in base units (brief shape) and
-- po_shipment_items.quantity repeats it in purchase units.
--
-- Costing (moving average, see migration-2026-10-27-cost-fix.sql):
--   * ship: transfer_out at HQ's current moving-average cost, stamped on the
--     shipment line (HQ's average does not change).
--   * receive: transfer_in at the shipped unit cost (weighted over the line's
--     shipments if it shipped more than once). No item_price_history row and no
--     items.latest_price change — internal moves are not supplier prices.
--   * delivery_fee (Lalamove) is recorded on the PO only, never in item cost
--     (brief: PROPOSED, pending OK).
--
-- Shortfall in transit (received < in transit): a receipt on an internal PO
-- settles everything in transit. The part that did not arrive is recorded as
-- transit loss — receiving_items.transit_loss and
-- purchase_order_items.transit_loss_quantity — valued at the shipped cost and
-- shown on the PO. The stock already left HQ, so the group's stock value drops
-- by exactly that amount. The lost quantity becomes "to ship" again (HQ can
-- re-send it) or a manager closes the PO short.
--
-- Guards: shipped / transit-loss columns change only inside the RPCs; a PO
-- with shipped goods cannot be cancelled and its shipped lines cannot be
-- deleted or re-pointed; an internal PO cannot be raised by HQ to itself;
-- close_po_short refuses while goods are in transit.
--
-- Supplier POs: unchanged. submit_receiving only hands internal POs to
-- receive_internal_po(); the supplier code path is the same as before.
--
-- Ledger: transaction_type CHECK widened with 'transfer_out', 'transfer_in'
-- (drop + re-add with a larger set, brief §7.1); transfer_id column added.
--
-- Prerequisites: migration-2026-10-27-overdelivery-close-short.sql,
--   migration-2026-10-27-security-hardening.sql, migration-2026-10-27-wastage.sql.
-- Idempotent: safe to run more than once.
-- ============================================================================

-- 1. Schema ---------------------------------------------------------------------
alter table suppliers
  add column if not exists internal_branch_id uuid references branches(id);
create unique index if not exists suppliers_internal_branch_uniq
  on suppliers (internal_branch_id) where internal_branch_id is not null;

alter table purchase_orders add column if not exists delivery_fee numeric;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'purchase_orders_delivery_fee_check') then
    alter table purchase_orders add constraint purchase_orders_delivery_fee_check
      check (delivery_fee is null or delivery_fee >= 0);
  end if;
end $$;

alter table purchase_order_items
  add column if not exists shipped_quantity numeric not null default 0;
alter table purchase_order_items
  add column if not exists transit_loss_quantity numeric not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'purchase_order_items_transfer_qty_check') then
    alter table purchase_order_items add constraint purchase_order_items_transfer_qty_check
      check (shipped_quantity >= 0 and transit_loss_quantity >= 0);
  end if;
end $$;

alter table receiving_items add column if not exists transit_loss numeric not null default 0;

create table if not exists po_shipments (
  id             uuid primary key default gen_random_uuid(),
  po_id          uuid not null references purchase_orders(id),
  from_branch_id uuid not null references branches(id),
  shipped_by     uuid references staff(id),
  shipped_at     timestamptz not null default now(),
  notes          text
);
create index if not exists po_shipments_po_idx on po_shipments (po_id);

create table if not exists po_shipment_items (
  id             uuid primary key default gen_random_uuid(),
  shipment_id    uuid not null references po_shipments(id),
  po_item_id     uuid not null references purchase_order_items(id),
  item_id        uuid not null references items(id),
  quantity       numeric not null check (quantity > 0),     -- purchase units of the PO line
  qty_shipped    numeric not null check (qty_shipped > 0),  -- base units
  unit_cost      numeric check (unit_cost is null or unit_cost >= 0), -- RM per base unit at HQ
  transaction_id uuid references inventory_transactions(id)
);
create index if not exists po_shipment_items_shipment_idx on po_shipment_items (shipment_id);
create index if not exists po_shipment_items_po_item_idx on po_shipment_items (po_item_id);

-- Ledger widening
alter table inventory_transactions
  drop constraint if exists inventory_transactions_transaction_type_check;
alter table inventory_transactions
  add constraint inventory_transactions_transaction_type_check
  check (transaction_type in ('stock_in', 'adjustment', 'wastage', 'transfer_out', 'transfer_in'));
alter table inventory_transactions add column if not exists transfer_id uuid;  -- po_shipments.id

-- HQ supplier row (brief: one row, internal_branch_id = Cheras)
insert into suppliers (name, status, internal_branch_id)
select 'Craft Cafe HQ (Cheras)', 'active', b.id
  from branches b
 where b.name = 'Cheras'
   and not exists (select 1 from suppliers s where s.internal_branch_id = b.id);

-- 2. Read access for HQ ---------------------------------------------------------
-- HQ staff must see internal POs addressed to their branch (and their lines and
-- receipts) to ship them. Permissive policies, OR-ed with the existing ones.
create or replace function is_internal_po_source(p_supplier_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select s.internal_branch_id is not null and can_access_branch(s.internal_branch_id)
      from suppliers s where s.id = p_supplier_id
  ), false)
$$;

drop policy if exists purchase_orders_select_hq on purchase_orders;
create policy purchase_orders_select_hq on purchase_orders
  for select to authenticated
  using (has_procurement_cap('use_procurement') and is_internal_po_source(supplier_id));

drop policy if exists purchase_order_items_select_hq on purchase_order_items;
create policy purchase_order_items_select_hq on purchase_order_items
  for select to authenticated
  using (exists (select 1 from purchase_orders p
                  where p.id = purchase_order_items.po_id
                    and has_procurement_cap('use_procurement')
                    and is_internal_po_source(p.supplier_id)));

drop policy if exists receivings_select_hq on receivings;
create policy receivings_select_hq on receivings
  for select to authenticated
  using (exists (select 1 from purchase_orders p
                  where p.id = receivings.po_id
                    and has_procurement_cap('use_procurement')
                    and is_internal_po_source(p.supplier_id)));

drop policy if exists receiving_items_select_hq on receiving_items;
create policy receiving_items_select_hq on receiving_items
  for select to authenticated
  using (exists (select 1 from receivings r join purchase_orders p on p.id = r.po_id
                  where r.id = receiving_items.receiving_id
                    and has_procurement_cap('use_procurement')
                    and is_internal_po_source(p.supplier_id)));

alter table po_shipments enable row level security;
alter table po_shipment_items enable row level security;

drop policy if exists po_shipments_select on po_shipments;
create policy po_shipments_select on po_shipments
  for select to authenticated
  using (has_procurement_cap('use_procurement')
         and (can_access_branch(from_branch_id)
              or exists (select 1 from purchase_orders p
                          where p.id = po_shipments.po_id and can_access_branch(p.branch_id))));

drop policy if exists po_shipment_items_select on po_shipment_items;
create policy po_shipment_items_select on po_shipment_items
  for select to authenticated
  using (exists (select 1 from po_shipments sh join purchase_orders p on p.id = sh.po_id
                  where sh.id = po_shipment_items.shipment_id
                    and has_procurement_cap('use_procurement')
                    and (can_access_branch(sh.from_branch_id) or can_access_branch(p.branch_id))));

-- Writes only through the RPCs.
revoke all on po_shipments, po_shipment_items from anon, authenticated;
grant select on po_shipments, po_shipment_items to authenticated;

-- 3. Guards -----------------------------------------------------------------------
create or replace function guard_internal_po()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_internal_branch uuid;
begin
  select internal_branch_id into v_internal_branch from suppliers where id = new.supplier_id;
  if v_internal_branch is not null and v_internal_branch = new.branch_id then
    raise exception 'A branch cannot raise an internal purchase order to itself';
  end if;
  if tg_op = 'UPDATE' then
    if new.status = 'cancelled' and old.status <> 'cancelled' and exists (
         select 1 from purchase_order_items where po_id = old.id and shipped_quantity > 0) then
      raise exception 'This purchase order has shipped goods and cannot be cancelled';
    end if;
    if (new.supplier_id is distinct from old.supplier_id or new.branch_id is distinct from old.branch_id)
       and exists (select 1 from po_shipments where po_id = old.id) then
      raise exception 'Supplier and branch cannot change after goods were shipped';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists purchase_orders_guard_internal on purchase_orders;
create trigger purchase_orders_guard_internal
  before insert or update on purchase_orders
  for each row execute function guard_internal_po();

create or replace function guard_po_item_transfer()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if coalesce(current_setting('craft.internal_transfer', true), '') = 'on' then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' then
    if new.shipped_quantity <> 0 or new.transit_loss_quantity <> 0 then
      raise exception 'Shipped quantities are set by shipping, not by editing the order';
    end if;
  elsif tg_op = 'UPDATE' then
    if new.shipped_quantity is distinct from old.shipped_quantity
       or new.transit_loss_quantity is distinct from old.transit_loss_quantity then
      raise exception 'Shipped quantities are set by shipping, not by editing the order';
    end if;
    if old.shipped_quantity > 0 and (
         new.item_id is distinct from old.item_id
         or new.quantity_ordered < old.shipped_quantity - old.transit_loss_quantity) then
      raise exception 'This line has shipped goods: the item cannot change and the quantity cannot go below what was shipped';
    end if;
  elsif tg_op = 'DELETE' then
    if old.shipped_quantity > 0 then
      raise exception 'This line has shipped goods and cannot be removed';
    end if;
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists purchase_order_items_guard_transfer on purchase_order_items;
create trigger purchase_order_items_guard_transfer
  before insert or update or delete on purchase_order_items
  for each row execute function guard_po_item_transfer();

-- 4. In-transit view ----------------------------------------------------------------
-- One row per internal PO line. Quantities in the line's purchase unit;
-- shipped_unit_cost is RM per base unit (weighted over the line's shipments).
create or replace view po_transfer_lines with (security_invoker = true) as
select
  poi.id                         as po_item_id,
  po.id                          as po_id,
  po.po_number,
  po.status                      as po_status,
  s.internal_branch_id           as from_branch_id,
  po.branch_id                   as to_branch_id,
  poi.item_id,
  coalesce(poi.conversion_rate_used, i.conversion_rate) as conversion_rate,
  poi.quantity_ordered,
  poi.shipped_quantity,
  poi.received_quantity,
  poi.transit_loss_quantity,
  greatest(poi.shipped_quantity - poi.received_quantity - poi.transit_loss_quantity, 0) as in_transit_quantity,
  case when po.status in ('sent', 'partially_received')
       then greatest(poi.quantity_ordered - poi.shipped_quantity + poi.transit_loss_quantity, 0)
       else 0 end                as to_ship_quantity,
  sc.shipped_unit_cost,
  greatest(poi.shipped_quantity - poi.received_quantity - poi.transit_loss_quantity, 0)
    * coalesce(poi.conversion_rate_used, i.conversion_rate) * sc.shipped_unit_cost as in_transit_value,
  poi.transit_loss_quantity
    * coalesce(poi.conversion_rate_used, i.conversion_rate) * sc.shipped_unit_cost as transit_loss_value
from purchase_order_items poi
join purchase_orders po on po.id = poi.po_id
join suppliers s        on s.id = po.supplier_id and s.internal_branch_id is not null
join items i            on i.id = poi.item_id
left join lateral (
  select case when sum(si.qty_shipped) > 0
              then sum(si.qty_shipped * si.unit_cost) / sum(si.qty_shipped) end as shipped_unit_cost
    from po_shipment_items si
   where si.po_item_id = poi.id and si.unit_cost is not null
) sc on true;

grant select on po_transfer_lines to authenticated;

-- 5. ship_internal_po ---------------------------------------------------------------
-- p_lines: [{ "po_item_id": uuid, "quantity": numeric (purchase units) }, ...]
create or replace function ship_internal_po(p_po_id uuid, p_lines jsonb, p_notes text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_po          purchase_orders%rowtype;
  v_from        uuid;
  v_shipment_id uuid;
  v_line        jsonb;
  v_po_item     purchase_order_items%rowtype;
  v_item        items%rowtype;
  v_qty         numeric;
  v_conv        numeric;
  v_base        numeric;
  v_to_ship     numeric;
  v_on_hand     numeric;
  v_cost        numeric;
  v_tx_id       uuid;
  v_seen        uuid[] := '{}';
begin
  if not has_procurement_cap('use_procurement') then
    raise exception 'Not authorised to ship transfers';
  end if;

  select * into v_po from purchase_orders where id = p_po_id for update;
  if not found then
    raise exception 'Purchase order not found';
  end if;

  select internal_branch_id into v_from from suppliers where id = v_po.supplier_id;
  if v_from is null then
    raise exception 'Only internal purchase orders (to HQ) can be shipped';
  end if;
  if not can_access_branch(v_from) then
    raise exception 'Not authorised to ship from this branch';
  end if;
  if v_po.status not in ('sent', 'partially_received') then
    raise exception 'Purchase order must be "sent" or "partially_received" to ship (current: %)', v_po.status;
  end if;
  if jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then
    raise exception 'At least one line is required';
  end if;

  insert into po_shipments (po_id, from_branch_id, shipped_by, notes)
  values (p_po_id, v_from, auth.uid(), nullif(btrim(p_notes), ''))
  returning id into v_shipment_id;

  perform set_config('craft.internal_transfer', 'on', true);

  for v_line in select * from jsonb_array_elements(p_lines) loop
    select * into v_po_item from purchase_order_items
     where id = (v_line->>'po_item_id')::uuid and po_id = p_po_id
     for update;
    if not found then
      raise exception 'PO line % does not belong to this purchase order', v_line->>'po_item_id';
    end if;
    if v_po_item.id = any(v_seen) then
      raise exception 'PO line % appears more than once', v_po_item.id;
    end if;
    v_seen := v_seen || v_po_item.id;

    v_qty := (v_line->>'quantity')::numeric;
    if v_qty is null or v_qty < 0 then
      raise exception 'Shipped quantity must be zero or more';
    end if;
    continue when v_qty = 0;

    select * into v_item from items where id = v_po_item.item_id;
    v_conv := coalesce(v_po_item.conversion_rate_used, v_item.conversion_rate);
    v_base := v_qty * v_conv;

    v_to_ship := greatest(v_po_item.quantity_ordered - v_po_item.shipped_quantity
                          + v_po_item.transit_loss_quantity, 0);
    if v_qty > v_to_ship then
      raise exception 'Cannot ship % % of %: only % left to ship',
        rtrim(to_char(v_qty, 'FM999999990.###'), '.'), v_item.purchase_unit, v_item.name,
        rtrim(to_char(v_to_ship, 'FM999999990.###'), '.');
    end if;

    -- Same lock key as log_wastage: serialises stock-outs per item and branch.
    perform pg_advisory_xact_lock(hashtext('stock_out:' || v_item.id::text || ':' || v_from::text));
    select coalesce(sum(quantity), 0) into v_on_hand
      from inventory_transactions where item_id = v_item.id and branch_id = v_from;
    if v_base > v_on_hand then
      raise exception 'Cannot ship % % of %: only % % on hand at HQ',
        rtrim(to_char(v_base, 'FM999999990.###'), '.'), v_item.base_unit, v_item.name,
        rtrim(to_char(v_on_hand, 'FM999999990.###'), '.'), v_item.base_unit;
    end if;

    v_cost := inventory_avg_unit_cost(v_item.id, v_from, null);

    insert into inventory_transactions
      (item_id, branch_id, transaction_type, quantity, reference_type, reference_id,
       created_by, unit_cost, transfer_id, notes)
    values
      (v_item.id, v_from, 'transfer_out', -v_base, 'po_shipment', v_shipment_id,
       auth.uid(), v_cost, v_shipment_id, 'To ' || (select name from branches where id = v_po.branch_id)
         || ' · ' || v_po.po_number)
    returning id into v_tx_id;

    insert into po_shipment_items (shipment_id, po_item_id, item_id, quantity, qty_shipped, unit_cost, transaction_id)
    values (v_shipment_id, v_po_item.id, v_item.id, v_qty, v_base, v_cost, v_tx_id);

    update purchase_order_items
       set shipped_quantity = shipped_quantity + v_qty
     where id = v_po_item.id;
  end loop;

  perform set_config('craft.internal_transfer', '', true);

  if not exists (select 1 from po_shipment_items where shipment_id = v_shipment_id) then
    raise exception 'Nothing to ship — enter a quantity on at least one line';
  end if;

  return v_shipment_id;
end;
$$;

revoke all on function ship_internal_po(uuid, jsonb, text) from public, anon;
grant execute on function ship_internal_po(uuid, jsonb, text) to authenticated;

-- 6. receive_internal_po (called by submit_receiving only) ---------------------------
-- p_lines: [{ "po_item_id": uuid, "actual_quantity": numeric (purchase units) }, ...]
-- Every line with goods in transit must be present; the receipt settles them.
create or replace function receive_internal_po(
  p_po_id uuid, p_photo_url text, p_goods_photo_url text, p_notes text, p_lines jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_branch_id    uuid;
  v_receiving_id uuid;
  v_line         jsonb;
  v_po_item      purchase_order_items%rowtype;
  v_item         items%rowtype;
  v_in_transit   numeric;
  v_actual       numeric;
  v_loss         numeric;
  v_conv         numeric;
  v_cost         numeric;
  v_shipment     uuid;
  v_seen         uuid[] := '{}';
  v_any          boolean := false;
  v_has_loss     boolean := false;
begin
  -- The caller (submit_receiving) has checked the capability, branch access
  -- and status, and holds the PO row lock.
  select branch_id into v_branch_id from purchase_orders where id = p_po_id;

  if coalesce(btrim(p_photo_url), '') = '' then
    raise exception 'A delivery photo is required';
  end if;
  if jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then
    raise exception 'At least one line is required';
  end if;

  insert into receivings (po_id, received_by, invoice_photo_url, goods_photo_url, notes)
  values (p_po_id, auth.uid(), p_photo_url, nullif(p_goods_photo_url, ''), nullif(btrim(p_notes), ''))
  returning id into v_receiving_id;

  perform set_config('craft.internal_transfer', 'on', true);

  for v_line in select * from jsonb_array_elements(p_lines) loop
    select * into v_po_item from purchase_order_items
     where id = (v_line->>'po_item_id')::uuid and po_id = p_po_id
     for update;
    if not found then
      raise exception 'PO line % does not belong to this purchase order', v_line->>'po_item_id';
    end if;
    if v_po_item.id = any(v_seen) then
      raise exception 'PO line % appears more than once', v_po_item.id;
    end if;
    v_seen := v_seen || v_po_item.id;

    v_actual := (v_line->>'actual_quantity')::numeric;
    if v_actual is null or v_actual < 0 then
      raise exception 'Received quantity must be zero or more';
    end if;

    v_in_transit := greatest(v_po_item.shipped_quantity - v_po_item.received_quantity
                             - v_po_item.transit_loss_quantity, 0);
    select * into v_item from items where id = v_po_item.item_id;
    if v_actual > v_in_transit then
      raise exception 'Cannot receive % % of %: only % shipped and not yet received',
        rtrim(to_char(v_actual, 'FM999999990.###'), '.'), v_item.purchase_unit, v_item.name,
        rtrim(to_char(v_in_transit, 'FM999999990.###'), '.');
    end if;
    continue when v_in_transit = 0;

    v_loss := v_in_transit - v_actual;
    v_conv := coalesce(v_po_item.conversion_rate_used, v_item.conversion_rate);

    -- Shipped cost of this line (weighted over its shipments) and the latest
    -- shipment, which pairs the transfer_in with a transfer_out.
    select sum(si.qty_shipped * si.unit_cost) / nullif(sum(si.qty_shipped), 0)
      into v_cost
      from po_shipment_items si where si.po_item_id = v_po_item.id and si.unit_cost is not null;
    select si.shipment_id into v_shipment
      from po_shipment_items si join po_shipments sh on sh.id = si.shipment_id
     where si.po_item_id = v_po_item.id
     order by sh.shipped_at desc limit 1;

    insert into receiving_items
      (receiving_id, po_item_id, expected_quantity, actual_quantity, shortage, unit_price,
       conversion_rate_used, over_quantity, transit_loss)
    values
      (v_receiving_id, v_po_item.id, v_in_transit, v_actual, v_loss,
       coalesce(v_cost, 0) * v_conv, v_conv, 0, v_loss);

    update purchase_order_items
       set received_quantity     = received_quantity + v_actual,
           transit_loss_quantity = transit_loss_quantity + v_loss,
           shortage_quantity     = greatest(quantity_ordered - (received_quantity + v_actual), 0)
     where id = v_po_item.id;

    if v_loss > 0 then
      v_has_loss := true;
    end if;

    if v_actual > 0 then
      v_any := true;
      insert into inventory_transactions
        (item_id, branch_id, transaction_type, quantity, reference_type, reference_id,
         created_by, unit_cost, transfer_id)
      values
        (v_item.id, v_branch_id, 'transfer_in', v_actual * v_conv, 'receiving', v_receiving_id,
         auth.uid(), v_cost, v_shipment);
      -- No item_price_history / latest_price: internal moves are not supplier prices.
    end if;
  end loop;

  -- Lines in transit that were left out would be silently unsettled.
  if exists (
    select 1 from purchase_order_items
     where po_id = p_po_id and not (id = any(v_seen))
       and shipped_quantity - received_quantity - transit_loss_quantity > 0) then
    raise exception 'Every line with goods in transit must be included in the receipt';
  end if;

  perform set_config('craft.internal_transfer', '', true);

  if not exists (select 1 from receiving_items where receiving_id = v_receiving_id) then
    raise exception 'Nothing is in transit on this purchase order yet';
  end if;
  if v_has_loss and length(btrim(coalesce(p_notes, ''))) = 0 then
    raise exception 'A note is required when less arrived than was shipped';
  end if;

  update receivings
     set has_discrepancy = v_has_loss or exists (
           select 1 from purchase_order_items
            where po_id = p_po_id and received_quantity < quantity_ordered)
   where id = v_receiving_id;

  update purchase_orders
     set status = case
       when exists (select 1 from purchase_order_items
                     where po_id = p_po_id and received_quantity < quantity_ordered)
       then 'partially_received' else 'received' end
   where id = p_po_id;

  return v_receiving_id;
end;
$$;

revoke all on function receive_internal_po(uuid, text, text, text, jsonb) from public, anon, authenticated;

-- 7. submit_receiving: hand internal POs to receive_internal_po --------------------
create or replace function submit_receiving(p_po_id uuid, p_invoice_photo_url text, p_goods_photo_url text, p_notes text, p_lines jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_internal_from   uuid;
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

  -- Internal PO (supplier row is an HQ branch): transfer_in at the shipped cost.
  -- The supplier-PO path below is unchanged.
  select s.internal_branch_id into v_internal_from
    from purchase_orders p join suppliers s on s.id = p.supplier_id
   where p.id = p_po_id;
  if v_internal_from is not null then
    return receive_internal_po(p_po_id, p_invoice_photo_url, p_goods_photo_url, p_notes, p_lines);
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
$function$;

revoke all on function submit_receiving(uuid, text, text, text, jsonb) from public, anon;
grant execute on function submit_receiving(uuid, text, text, text, jsonb) to authenticated;

-- 8. close_po_short: refuse while goods are in transit -------------------------------
create or replace function close_po_short(p_po_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
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

  -- Internal POs: goods on the road must be received (or recorded lost) first.
  if exists (select 1 from purchase_order_items
              where po_id = p_po_id
                and shipped_quantity - received_quantity - transit_loss_quantity > 0) then
    raise exception 'Goods are still in transit on this purchase order — receive them first';
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
$function$;

revoke all on function close_po_short(uuid, text) from public, anon;
grant execute on function close_po_short(uuid, text) to authenticated;
