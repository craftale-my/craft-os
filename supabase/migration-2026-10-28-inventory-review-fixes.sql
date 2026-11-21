-- ============================================================================
-- Craft OS — Inventory v2 review fixes (2026-10-28)
--
-- Fixes from the PR #9 code review. Run AFTER every other file in PR #9
-- (it is #11 in the run order). Idempotent: safe to run more than once.
--
-- What this changes:
--   1. purchase_orders: a client (the app's `authenticated` role) can only
--      move a PO draft → sent, draft → cancelled or sent → cancelled. Every
--      other status change (received, partially_received, back to draft …)
--      comes from the RPCs. Before, a supervisor could PATCH an internal PO
--      with goods in transit to 'received' and strand the stock.
--   2. purchase_order_items: received_quantity / shortage_quantity are set
--      by receiving only; a client cannot insert or edit them.
--   3. suppliers: a client cannot set or change internal_branch_id (the HQ
--      marker), and cannot delete the HQ supplier or a supplier with open
--      POs (on delete set null would turn internal POs into supplier POs).
--   4. inventory_transactions: a negative manual adjustment takes the same
--      stock-out lock as wastage / shipping / production and cannot take a
--      branch below zero.
--   5. receiving_photo_readable: a path under <po_id>/ or wastage/<branch>/
--      is decided by that PO or branch alone. Before, a forged row pointing at
--      another branch's path (log_wastage / submit_receiving accept any path)
--      unlocked it through the "row that references it" fallback.
--   6. receive_internal_po: transfer_in is costed at the shipments still in
--      transit, not the average of every shipment on the line (which included
--      shipments already received at another cost).
--   7. preview_production / produce_batch: an ingredient with no cost at the
--      branch blocks production instead of being booked at RM 0.
--
-- "Client" = current_user is authenticated or anon. Inside the SECURITY
-- DEFINER RPCs current_user is the function owner (postgres), so the RPCs
-- are unaffected.
--
-- This file is now the canonical version of receiving_photo_readable,
-- receive_internal_po, preview_production and produce_batch. The older files
-- that define them STOP if re-run after this one.
-- ============================================================================

-- 1. PO status: clients make only the draft/sent/cancel moves -----------------
create or replace function guard_po_status_client()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.status not in ('draft', 'sent') then
      raise exception 'A new purchase order starts as draft or sent';
    end if;
  elsif new.status is distinct from old.status
        and not ((old.status = 'draft' and new.status in ('sent', 'cancelled'))
                 or (old.status = 'sent' and new.status = 'cancelled')) then
    raise exception 'Purchase order status cannot change from % to % here — receiving and Close short set it',
      old.status, new.status;
  end if;
  return new;
end;
$$;
revoke all on function guard_po_status_client() from public, anon, authenticated;

drop trigger if exists purchase_orders_guard_status_client on purchase_orders;
create trigger purchase_orders_guard_status_client
  before insert or update on purchase_orders
  for each row execute function guard_po_status_client();

-- 2. PO lines: received / shortage quantities come from receiving only --------
create or replace function guard_po_item_receipt_client()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.received_quantity <> 0 or new.shortage_quantity <> 0 then
      raise exception 'Received quantities are set by receiving, not by editing the order';
    end if;
  elsif new.received_quantity is distinct from old.received_quantity
        or new.shortage_quantity is distinct from old.shortage_quantity then
    raise exception 'Received quantities are set by receiving, not by editing the order';
  end if;
  return new;
end;
$$;
revoke all on function guard_po_item_receipt_client() from public, anon, authenticated;

drop trigger if exists purchase_order_items_guard_receipt_client on purchase_order_items;
create trigger purchase_order_items_guard_receipt_client
  before insert or update on purchase_order_items
  for each row execute function guard_po_item_receipt_client();

-- 3. Suppliers: the HQ marker is not editable from the app --------------------
create or replace function guard_supplier_internal()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' then
    if new.internal_branch_id is not null then
      raise exception 'The HQ supplier is set up by the database, not from the app';
    end if;
  elsif tg_op = 'UPDATE' then
    if new.internal_branch_id is distinct from old.internal_branch_id then
      raise exception 'The HQ supplier is set up by the database, not from the app';
    end if;
  elsif tg_op = 'DELETE' then
    if old.internal_branch_id is not null then
      raise exception 'The HQ supplier cannot be deleted — internal transfers depend on it';
    end if;
    -- supplier_id is ON DELETE SET NULL: it would orphan orders still in progress.
    if exists (select 1 from purchase_orders
                where supplier_id = old.id and status in ('sent', 'partially_received')) then
      raise exception 'This supplier has open purchase orders — set it inactive instead';
    end if;
    return old;
  end if;
  return new;
end;
$$;
revoke all on function guard_supplier_internal() from public, anon, authenticated;

drop trigger if exists suppliers_guard_internal on suppliers;
create trigger suppliers_guard_internal
  before insert or update or delete on suppliers
  for each row execute function guard_supplier_internal();

-- 4. Negative adjustments: same stock-out lock, never below zero --------------
create or replace function guard_adjustment_stock_out()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_on_hand numeric;
begin
  if new.transaction_type <> 'adjustment' or new.quantity >= 0 then
    return new;
  end if;
  -- Same key as log_wastage / ship_internal_po / produce_batch.
  perform pg_advisory_xact_lock(hashtext('stock_out:' || new.item_id::text || ':' || new.branch_id::text));
  select coalesce(sum(quantity), 0) into v_on_hand
    from inventory_transactions
   where item_id = new.item_id and branch_id = new.branch_id;
  if -new.quantity > v_on_hand then
    raise exception 'Cannot adjust out % : only % on hand at this branch',
      rtrim(to_char(-new.quantity, 'FM999999990.###'), '.'),
      rtrim(to_char(v_on_hand, 'FM999999990.###'), '.');
  end if;
  return new;
end;
$$;
revoke all on function guard_adjustment_stock_out() from public, anon, authenticated;

drop trigger if exists inventory_transactions_guard_adjustment on inventory_transactions;
create trigger inventory_transactions_guard_adjustment
  before insert on inventory_transactions
  for each row execute function guard_adjustment_stock_out();

-- 5. Photo read: a structured path is decided by its PO / branch alone --------
create or replace function receiving_photo_readable(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_seg1 text := split_part(p_name, '/', 1);
  v_seg2 text := split_part(p_name, '/', 2);
  v_uuid_re constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  if p_name is null or not has_procurement_cap('use_procurement') then
    return false;
  end if;

  -- Wastage photos: wastage/<branch_id>/... — the branch decides.
  if v_seg1 = 'wastage' then
    return v_seg2 ~ v_uuid_re and can_access_branch(v_seg2::uuid);
  end if;

  -- Receiving photos: <po_id>/... — the PO decides.
  if v_seg1 ~ v_uuid_re then
    return exists (select 1 from purchase_orders po
                    where po.id = v_seg1::uuid
                      and (can_access_branch(po.branch_id) or is_internal_po_source(po.supplier_id)));
  end if;

  -- Any other (legacy) path: the row that references it decides.
  return exists (
      select 1 from receivings r join purchase_orders po on po.id = r.po_id
       where (r.invoice_photo_url = p_name or r.goods_photo_url = p_name)
         and (can_access_branch(po.branch_id) or is_internal_po_source(po.supplier_id)))
    or exists (
      select 1 from wastage_logs w
       where w.photo_path = p_name and can_access_branch(w.branch_id));
end;
$$;
revoke all on function receiving_photo_readable(text) from public, anon;
grant execute on function receiving_photo_readable(text) to authenticated;

-- 6. receive_internal_po: cost the goods in transit only ----------------------
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
    -- Cost only the goods still on the road. Receipts settle shipments oldest
    -- first, so what is in transit is the newest shipments: walk them newest
    -- first until the in-transit quantity (base units) is covered.
    select sum(x.take * x.unit_cost) / nullif(sum(x.take), 0)
      into v_cost
      from (
        select si.unit_cost,
               least(si.qty_shipped,
                     greatest(v_in_transit * v_conv
                              - coalesce(sum(si.qty_shipped) over (
                                  order by sh.shipped_at desc, si.id
                                  rows between unbounded preceding and 1 preceding), 0),
                              0)) as take
          from po_shipment_items si
          join po_shipments sh on sh.id = si.shipment_id
         where si.po_item_id = v_po_item.id
      ) x
     where x.unit_cost is not null and x.take > 0;
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

-- 7. Production: no cost, no batch ------------------------------------------
create or replace function preview_production(
  p_item_id   uuid,
  p_branch_id uuid,
  p_batches   numeric default 1
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_date   date := business_date_of(now());
  v_recipe recipes%rowtype;
  v_lines  jsonb;
  v_total  numeric;
  v_short  boolean;
  v_nocost boolean;
begin
  if not has_procurement_cap('use_procurement') then
    raise exception 'Not authorised to produce batches';
  end if;
  if p_branch_id is null or not can_access_branch(p_branch_id) then
    raise exception 'Not authorised to produce at this branch';
  end if;
  if p_batches is null or p_batches <= 0 then
    raise exception 'Number of batches must be greater than zero';
  end if;

  select * into v_recipe from recipes where id = recipe_for_date(p_item_id, v_date);
  if not found then
    raise exception 'No verified recipe is in effect for this item on %', v_date;
  end if;

  select jsonb_agg(x order by x.sort_order),
         sum(x.line_cost),
         bool_or(x.short),
         bool_or(x.unit_cost is null)
    into v_lines, v_total, v_short, v_nocost
    from (
      select l.sort_order,
             l.item_id,
             i.name,
             i.base_unit,
             l.qty_base * p_batches as need,
             coalesce(oh.on_hand, 0) as on_hand,
             inventory_avg_unit_cost(l.item_id, p_branch_id, null) as unit_cost,
             l.qty_base * p_batches
               * coalesce(inventory_avg_unit_cost(l.item_id, p_branch_id, null), 0) as line_cost,
             coalesce(oh.on_hand, 0) < l.qty_base * p_batches as short
        from recipe_lines l
        join items i on i.id = l.item_id
        left join lateral (
          select sum(t.quantity) as on_hand
            from inventory_transactions t
           where t.item_id = l.item_id and t.branch_id = p_branch_id
        ) oh on true
       where l.recipe_id = v_recipe.id
    ) x;

  return jsonb_build_object(
    'recipe_id',      v_recipe.id,
    'version',        v_recipe.version,
    'effective_from', v_recipe.effective_from,
    'business_date',  v_date,
    'yield_qty',      v_recipe.yield_qty,
    'batches',        p_batches,
    'output_qty',     v_recipe.yield_qty * p_batches,
    'lines',          coalesce(v_lines, '[]'::jsonb),
    'total_cost',     coalesce(v_total, 0),
    'unit_cost',      coalesce(v_total, 0) / (v_recipe.yield_qty * p_batches),
    'missing_cost',   coalesce(v_nocost, false),
    'can_produce',    not coalesce(v_short, false) and not coalesce(v_nocost, false)
  );
end;
$$;

create or replace function produce_batch(
  p_item_id   uuid,
  p_branch_id uuid,
  p_batches   numeric default 1,
  p_note      text default null
) returns production_batches
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_date    date := business_date_of(now());
  v_item    items%rowtype;
  v_recipe  recipes%rowtype;
  v_batch   production_batches%rowtype;
  v_out_qty numeric;
  v_total   numeric := 0;
  v_short   text := '';
  v_nocost  text := '';
  v_tx_id   uuid;
  r         record;
begin
  if not has_procurement_cap('use_procurement') then
    raise exception 'Not authorised to produce batches';
  end if;
  if p_branch_id is null or not can_access_branch(p_branch_id) then
    raise exception 'Not authorised to produce at this branch';
  end if;
  if p_batches is null or p_batches <= 0 then
    raise exception 'Number of batches must be greater than zero';
  end if;
  if not exists (select 1 from branches where id = p_branch_id and is_active) then
    raise exception 'Branch not found';
  end if;

  select * into v_item from items where id = p_item_id;
  if not found then
    raise exception 'Item not found';
  end if;
  if v_item.category <> 'semi_finished' or v_item.status <> 'active' then
    raise exception 'Item is not an active semi-finished item';
  end if;

  select * into v_recipe from recipes where id = recipe_for_date(p_item_id, v_date);
  if not found then
    raise exception 'No verified recipe is in effect for this item on %', v_date;
  end if;
  v_out_qty := v_recipe.yield_qty * p_batches;

  -- Same stock-out lock as wastage and shipping; taken in item order so two
  -- runs sharing ingredients cannot deadlock.
  for r in select l.item_id from recipe_lines l
            where l.recipe_id = v_recipe.id order by l.item_id loop
    perform pg_advisory_xact_lock(hashtext('stock_out:' || r.item_id::text || ':' || p_branch_id::text));
  end loop;

  -- Shortage check: list every short ingredient in one message.
  for r in
    select i.name, i.base_unit, i.status, l.qty_base * p_batches as need,
           coalesce((select sum(t.quantity) from inventory_transactions t
                      where t.item_id = l.item_id and t.branch_id = p_branch_id), 0) as on_hand
      from recipe_lines l join items i on i.id = l.item_id
     where l.recipe_id = v_recipe.id
     order by l.sort_order
  loop
    if r.status <> 'active' then
      raise exception 'Ingredient % is inactive', r.name;
    end if;
    if r.need > r.on_hand then
      v_short := v_short || case when v_short = '' then '' else '; ' end
        || format('%s needs %s %s, only %s %s on hand',
                  r.name,
                  rtrim(to_char(r.need, 'FM999999990.999'), '.'), r.base_unit,
                  rtrim(to_char(r.on_hand, 'FM999999990.999'), '.'), r.base_unit);
    end if;
  end loop;
  if v_short <> '' then
    raise exception 'Not enough stock to produce %: %', v_item.name, v_short;
  end if;
  -- No cost would book the ingredient at RM 0 and undervalue the output.
  for r in
    select i.name
      from recipe_lines l join items i on i.id = l.item_id
     where l.recipe_id = v_recipe.id
       and inventory_avg_unit_cost(l.item_id, p_branch_id, null) is null
     order by l.sort_order
  loop
    v_nocost := v_nocost || case when v_nocost = '' then '' else ', ' end || r.name;
  end loop;
  if v_nocost <> '' then
    raise exception 'Cannot produce %: no cost for % — set a price on the item first', v_item.name, v_nocost;
  end if;

  insert into production_batches (recipe_id, item_id, branch_id, batches, output_qty,
                                  total_cost, unit_cost, business_date, note, created_by)
  values (v_recipe.id, p_item_id, p_branch_id, p_batches, v_out_qty,
          0, 0, v_date, nullif(btrim(p_note), ''), auth.uid())
  returning * into v_batch;

  -- Ingredients out at their current moving-average cost.
  for r in
    select l.item_id, l.qty_base * p_batches as qty,
           coalesce(inventory_avg_unit_cost(l.item_id, p_branch_id, null), 0) as unit_cost
      from recipe_lines l
     where l.recipe_id = v_recipe.id
     order by l.sort_order
  loop
    insert into inventory_transactions (item_id, branch_id, transaction_type, quantity,
                                        reference_type, reference_id, created_by,
                                        notes, unit_cost)
    values (r.item_id, p_branch_id, 'production_out', -r.qty,
            'production', v_batch.id, auth.uid(),
            'Used in ' || v_item.name, r.unit_cost)
    returning id into v_tx_id;

    insert into production_batch_lines (batch_id, item_id, qty_base, unit_cost, line_cost, transaction_id)
    values (v_batch.id, r.item_id, r.qty, r.unit_cost, r.qty * r.unit_cost, v_tx_id);

    v_total := v_total + r.qty * r.unit_cost;
  end loop;

  -- Output in at total cost / output quantity.
  insert into inventory_transactions (item_id, branch_id, transaction_type, quantity,
                                      reference_type, reference_id, created_by,
                                      notes, unit_cost)
  values (p_item_id, p_branch_id, 'production_in', v_out_qty,
          'production', v_batch.id, auth.uid(),
          format('Batch of %s (recipe v%s)', v_item.name, v_recipe.version),
          v_total / v_out_qty)
  returning id into v_tx_id;

  update production_batches
     set total_cost = v_total,
         unit_cost  = v_total / v_out_qty,
         transaction_id = v_tx_id
   where id = v_batch.id
  returning * into v_batch;

  return v_batch;
end;
$$;

revoke all on function preview_production(uuid, uuid, numeric) from public, anon;
grant execute on function preview_production(uuid, uuid, numeric) to authenticated;
revoke all on function produce_batch(uuid, uuid, numeric, text) from public, anon;
grant execute on function produce_batch(uuid, uuid, numeric, text) to authenticated;
