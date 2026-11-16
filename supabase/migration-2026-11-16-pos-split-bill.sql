-- ============================================================================
-- Craft OS — POS split bill and move items, Part A (2026-11-16). Run on craft-os-dev after
-- migration-2026-10-30-pos-discounts.sql. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-11-17-pos-split-bill.md
-- Design: docs/superpowers/specs/2026-11-16-pos-split-bill-design.md (§3–§6, Part A)
--
-- S1  Schema: bills.split_from (set only on a paid part: the table bill it came from),
--     order_items.split_from_item (a row cut from a line's quantity), pos_discount_log action
--     'split'. The order_items insert triggers leave a cut row's catalog discount and order type
--     as its line was ordered.
-- S2  Preview: pos_bill_input (the input pos_bill_totals computes on; pos_bill_totals re-created
--     on it, numbers unchanged), pos_split_line_discount, pos_split_check, pos_split_input and
--     the RPC pos_split_totals.
-- S3  checkout_items: one call pays the selected units as their own, already paid bill.
--     checkout_bill's payment writing moves into pos_check_payments / pos_insert_payments /
--     pos_pay_and_close, used by both. pos_checkout_state also answers a split part paid under
--     one of the screen's checkout ids. pos_move_units cuts or moves the units.
-- S4  move_items: selected units to another table (its open bill, or a new one).
-- S5  Receipt "Split from <bill> · <table>"; the Z report's sources count by order_items.bill_id.
-- Re-run hazards: re-running migration-2026-10-30-pos-discounts.sql puts back the old
-- order_items_catalog_discount, pos_bill_totals and pos_receipt_payload, and
-- migration-2026-10-25-pos-hardening.sql the old order_items_order_type and pos_checkout_state;
-- migration-2026-10-29-pos-device-till.sql the old checkout_bill — re-run this file after any of
-- them (and migration-2026-11-17-pos-bill-parts.sql after this one, once it exists).
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_check_discount(text,integer)') is null then
    raise exception 'STOP: run migration-2026-10-30-pos-discounts.sql first (pos_check_discount is missing)';
  end if;
end $$;

-- ── S1. Schema ──────────────────────────────────────────────────────────────
alter table bills       add column if not exists split_from      uuid references bills(id);
alter table order_items add column if not exists split_from_item uuid references order_items(id);
create index if not exists bills_split_from_idx on bills(split_from) where split_from is not null;
alter table pos_discount_log drop constraint if exists pos_discount_log_action_check;
alter table pos_discount_log add constraint pos_discount_log_action_check check (action in ('set', 'clear', 'split'));

-- order_items_catalog_discount: the live text of migration-2026-10-30-pos-discounts.sql with the
-- line marked S1 added — a cut row keeps the catalog discount its line was ordered with.
create or replace function order_items_catalog_discount() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.split_from_item is not null then return new; end if;                          -- S1
  select c.discount_bp, case when c.discount_bp > 0 then c.name end
    into new.catalog_discount_bp, new.catalog_discount_name
    from orders o join menu_catalogs c on c.id = o.catalog_id
   where o.id = new.order_id;
  new.catalog_discount_bp := coalesce(new.catalog_discount_bp, 0);
  return new;
end $$;
revoke all on function order_items_catalog_discount() from public, anon, authenticated;

-- order_items_order_type: the live text of migration-2026-10-25-pos-hardening.sql with the line
-- marked S1 added — a cut row keeps its line's order type (a merged takeaway stays takeaway).
create or replace function order_items_order_type() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.split_from_item is not null then return new; end if;                          -- S1
  select b.order_type into new.order_type from bills b where b.id = new.bill_id;
  return new;
end $$;
revoke all on function order_items_order_type() from public, anon, authenticated;

-- ── S2. The bill input, shared ──────────────────────────────────────────────
-- The object pos_bill_totals (migration-2026-10-30-pos-discounts.sql) built inline, unchanged.
create or replace function pos_bill_input(p_bill_id uuid) returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'orderType', b.order_type,
    'tableId', b.table_id,
    'sstRegistered', coalesce(s.sst_registered, true),
    'cashRounding', coalesce(s.cash_rounding, 'nearest_5_sen'),
    'rules', coalesce((
      select jsonb_agg(jsonb_build_object('rateBp', r.rate_bp, 'orderTypes', to_jsonb(r.order_types),
                                          'tableIds', to_jsonb(r.table_ids), 'productIds', to_jsonb(r.product_ids))
                       order by r.sort_order, r.created_at, r.id)
        from service_charge_rules r where r.branch_id = b.branch_id and r.is_active), '[]'::jsonb),
    'billDiscount', case when b.discount_kind is null then null
                         else jsonb_build_object('kind', b.discount_kind, 'value', b.discount_value) end,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object('id', oi.id,
                                          'productId', oi.product_id, 'unitPriceSen', oi.unit_price_sen, 'qty', oi.qty,
                                          'sstRateBp', oi.sst_rate_bp, 'takeawayFeeSen', oi.takeaway_fee_sen,
                                          'voided', oi.voided_at is not null,
                                          'orderType', oi.order_type,
                                          'catalogDiscountBp', oi.catalog_discount_bp,
                                          'discount', case when oi.discount_kind is null then null
                                                           else jsonb_build_object('kind', oi.discount_kind, 'value', oi.discount_value) end)
                       order by oi.id)
        from order_items oi where oi.bill_id = b.id), '[]'::jsonb))
  from bills b
  left join branch_pos_settings s on s.branch_id = b.branch_id
  where b.id = p_bill_id
$$;
revoke all on function pos_bill_input(uuid) from public, anon;
grant execute on function pos_bill_input(uuid) to authenticated;   -- pos_bill_totals is security invoker and calls it

-- pos_bill_totals: re-created on pos_bill_input (S2); null for an unknown bill, as before.
create or replace function pos_bill_totals(p_bill_id uuid) returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select pos_compute_bill(x.i) from (select pos_bill_input(p_bill_id) as i) x where x.i is not null
$$;
revoke all on function pos_bill_totals(uuid) from public, anon;
grant execute on function pos_bill_totals(uuid) to authenticated;

-- ── S2. The selected part ───────────────────────────────────────────────────
-- An item discount carried by p_take of a line's p_line_qty units (spec §5): a percent as it is;
-- an amount shared by value, floor(value × take / qty) — all of it for the whole line; none when
-- the share is 0. Internal.
create or replace function pos_split_line_discount(p_kind text, p_value integer, p_line_qty integer, p_take integer) returns jsonb
language sql immutable set search_path = public, pg_temp as $$
  select case
    when p_kind is null then null
    when p_kind = 'percent' then jsonb_build_object('kind', 'percent', 'value', p_value)
    when p_take >= p_line_qty then jsonb_build_object('kind', 'amount', 'value', p_value)
    when floor(p_value::numeric * p_take / p_line_qty) > 0
      then jsonb_build_object('kind', 'amount', 'value', floor(p_value::numeric * p_take / p_line_qty)::integer)
  end
$$;
revoke all on function pos_split_line_discount(text, integer, integer, integer) from public, anon, authenticated;

-- p_items = [{ "itemId": uuid, "qty": int }] checked against the bill (spec §4.2). The callers that
-- write hold the bill's row lock. Returns the number of units selected. Internal.
create or replace function pos_split_check(p_bill bills, p_items jsonb) returns integer
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_e     jsonb;
  v_id    uuid;
  v_qty   integer;
  v_line  order_items;
  v_seen  uuid[] := '{}';
  v_units integer := 0;
  v_live  integer;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 100 then
    raise exception 'Invalid selection';
  end if;
  for v_e in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_e) <> 'object' or jsonb_typeof(v_e->'itemId') is distinct from 'string'
       or (v_e->>'itemId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(v_e->'qty') is distinct from 'number'
       or (v_e->'qty')::numeric <> trunc((v_e->'qty')::numeric)
       or (v_e->'qty')::numeric < 1 or (v_e->'qty')::numeric > 100 then
      raise exception 'Invalid selection';
    end if;
    v_id  := (v_e->>'itemId')::uuid;
    v_qty := (v_e->'qty')::numeric::integer;
    if v_id = any (v_seen) then raise exception 'Invalid selection'; end if;
    v_seen := v_seen || v_id;
    select * into v_line from order_items where id = v_id;
    if not found or v_line.bill_id <> p_bill.id or v_line.voided_at is not null or v_line.qty < v_qty then
      raise exception 'The bill changed. Check the items again.';
    end if;
    v_units := v_units + v_qty;
  end loop;
  select coalesce(sum(qty), 0)::integer into v_live from order_items where bill_id = p_bill.id and voided_at is null;
  if v_units >= v_live then raise exception 'Select fewer items, or pay the whole bill'; end if;
  return v_units;
end $$;
revoke all on function pos_split_check(bills, jsonb) from public, anon, authenticated;

-- The pos_compute_bill input of the selected part (spec §4.2, §5): the bill's own input with only
-- the selected lines, each at its chosen qty with its share of an item amount discount; a percent
-- bill discount copied; an amount bill discount V shared as round(V × part base / bill base), the
-- bases being the line nets after catalog and item discounts (pos_compute_bill's subtotalSen).
-- Checked first by pos_split_check. Internal.
create or replace function pos_split_input(p_bill_id uuid, p_items jsonb) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_bill      bills;
  v_input     jsonb := pos_bill_input(p_bill_id);
  v_part      jsonb;
  v_part_base numeric;
  v_bill_base numeric;
  v_share     integer;
begin
  select * into v_bill from bills where id = p_bill_id;
  v_part := jsonb_set(v_input, '{lines}', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', oi.id, 'productId', oi.product_id, 'unitPriceSen', oi.unit_price_sen, 'qty', s.qty,
             'sstRateBp', oi.sst_rate_bp, 'takeawayFeeSen', oi.takeaway_fee_sen, 'voided', false,
             'orderType', oi.order_type, 'catalogDiscountBp', oi.catalog_discount_bp,
             'discount', pos_split_line_discount(oi.discount_kind, oi.discount_value, oi.qty, s.qty))
           order by oi.id)
      from (select (e->>'itemId')::uuid as item_id, (e->'qty')::numeric::integer as qty
              from jsonb_array_elements(p_items) e) s
      join order_items oi on oi.id = s.item_id), '[]'::jsonb));
  v_part := jsonb_set(v_part, '{billDiscount}', 'null'::jsonb);
  if v_bill.discount_kind = 'percent' then
    v_part := jsonb_set(v_part, '{billDiscount}', jsonb_build_object('kind', 'percent', 'value', v_bill.discount_value));
  elsif v_bill.discount_kind = 'amount' then
    v_part_base := (pos_compute_bill(v_part)->>'subtotalSen')::numeric;
    v_bill_base := (pos_compute_bill(jsonb_set(v_input, '{billDiscount}', 'null'::jsonb))->>'subtotalSen')::numeric;
    v_share := case when v_bill_base > 0 then round(v_bill.discount_value * v_part_base / v_bill_base)::integer else 0 end;
    if v_share > 0 then
      v_part := jsonb_set(v_part, '{billDiscount}', jsonb_build_object('kind', 'amount', 'value', v_share));
    end if;
  end if;
  return v_part;
end $$;
revoke all on function pos_split_input(uuid, jsonb) from public, anon, authenticated;

-- The selected part's totals, read by the picker after each change (spec §4.2). Read-only, no lock.
create or replace function pos_split_totals(p_bill_id uuid, p_items jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_bill bills;
begin
  select * into v_bill from bills where id = p_bill_id and branch_id = pos_my_branch();
  if not found then raise exception 'Bill not found'; end if;
  if v_bill.status <> 'open' then
    raise exception 'This bill is already %', case v_bill.status when 'paid' then 'paid'
                                                                 when 'voided' then 'voided'
                                                                 else 'merged into another bill' end;
  end if;
  perform pos_split_check(v_bill, p_items);
  return pos_compute_bill(pos_split_input(v_bill.id, p_items));
end $$;
revoke all on function pos_split_totals(uuid, jsonb) from public, anon;
grant execute on function pos_split_totals(uuid, jsonb) to authenticated;

-- ── S3. Payments, shared by checkout_bill and checkout_items ─────────────────
-- checkout_bill's checks of p_payments (migration-2026-10-29-pos-device-till.sql), unchanged, against
-- p_due. Nothing is written. Internal.
create or replace function pos_check_payments(p_branch uuid, p_payments jsonb, p_due integer) returns void
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_p   jsonb;
  v_m   payment_methods;
  v_sum integer := 0;
begin
  if p_payments is null or jsonb_typeof(p_payments) <> 'array' then raise exception 'Invalid payments'; end if;
  if jsonb_array_length(p_payments) > 10 then raise exception 'Too many payments on one bill'; end if;
  for v_p in select * from jsonb_array_elements(p_payments) loop
    if jsonb_typeof(v_p) <> 'object' or jsonb_typeof(v_p->'methodId') is distinct from 'string'
       or (v_p->>'methodId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Invalid payment';
    end if;
    if jsonb_typeof(v_p->'amountSen') is distinct from 'number'
       or (v_p->'amountSen')::numeric <> trunc((v_p->'amountSen')::numeric)
       or (v_p->'amountSen')::numeric <= 0 or (v_p->'amountSen')::numeric > 10000000 then
      raise exception 'Invalid payment amount';
    end if;
    select * into v_m from payment_methods
     where id = (v_p->>'methodId')::uuid and branch_id = p_branch and is_active;
    if not found then raise exception 'Payment method is not available at this branch'; end if;
    if jsonb_typeof(v_p->'tenderedSen') = 'number' then
      if (v_p->'tenderedSen')::numeric <> trunc((v_p->'tenderedSen')::numeric)
         or (v_p->'tenderedSen')::numeric > 10000000 then
        raise exception 'Invalid cash received';
      end if;
      if v_m.kind <> 'cash' then raise exception 'Only cash can be tendered above the amount'; end if;
      if (v_p->'tenderedSen')::numeric < (v_p->'amountSen')::numeric then
        raise exception 'Cash received is less than the amount';
      end if;
    elsif v_p->'tenderedSen' is not null and jsonb_typeof(v_p->'tenderedSen') <> 'null' then
      raise exception 'Invalid cash received';
    end if;
    if v_m.needs_reference
       and nullif(trim(case when jsonb_typeof(v_p->'reference') = 'string' then v_p->>'reference' end), '') is null then
      raise exception 'Enter the reference for %', v_m.name;
    end if;
    v_sum := v_sum + (v_p->'amountSen')::numeric::integer;
  end loop;
  if v_sum <> p_due then
    raise exception 'Payments (RM %) do not match the total (RM %)',
      to_char(v_sum / 100.0, 'FM999999990.00'), to_char(p_due / 100.0, 'FM999999990.00');
  end if;
end $$;
revoke all on function pos_check_payments(uuid, jsonb, integer) from public, anon, authenticated;

-- The payment rows of one checked p_payments, line_no from 1 (checkout_bill's insert, unchanged).
-- p_part_id: Part B (migration-2026-11-17-pos-bill-parts.sql) writes it to payments.part_id. Internal.
create or replace function pos_insert_payments(p_bill_id uuid, p_branch uuid, p_shift uuid, p_payments jsonb,
                                               p_part_id uuid default null) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  v_p        jsonb;
  v_m        payment_methods;
  v_amount   integer;
  v_tendered integer;
  v_n        integer := 0;
begin
  for v_p in select * from jsonb_array_elements(p_payments) loop
    v_n := v_n + 1;
    select * into v_m from payment_methods where id = (v_p->>'methodId')::uuid;
    v_amount   := (v_p->'amountSen')::numeric::integer;
    v_tendered := case when v_m.kind = 'cash' and jsonb_typeof(v_p->'tenderedSen') = 'number'
                       then (v_p->'tenderedSen')::numeric::integer end;
    insert into payments(bill_id, branch_id, method_id, method_name, kind, amount_sen, tendered_sen,
                         change_sen, reference, taken_by, line_no, shift_id)
    values (p_bill_id, p_branch, v_m.id, v_m.name, v_m.kind, v_amount, v_tendered,
            coalesce(v_tendered - v_amount, 0),
            nullif(trim(left(case when jsonb_typeof(v_p->'reference') = 'string' then v_p->>'reference' end, 60)), ''),
            pos_actor(), v_n, p_shift);
  end loop;
end $$;
revoke all on function pos_insert_payments(uuid, uuid, uuid, jsonb, uuid) from public, anon, authenticated;

-- A checked checkout written (checkout_bill's tail, unchanged): the payments, the bill paid with its
-- frozen totals and the six money columns, the receipt queued. Internal.
create or replace function pos_pay_and_close(p_bill_id uuid, p_branch uuid, p_shift uuid, p_payments jsonb,
                                             p_totals jsonb, p_checkout_id uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_queued boolean;
begin
  perform pos_insert_payments(p_bill_id, p_branch, p_shift, p_payments);
  update bills
     set status = 'paid', closed_at = now(), closed_by = pos_actor(), closed_device_id = pos_current_device(), checkout_id = p_checkout_id,
         shift_id = p_shift,
         totals = p_totals,
         subtotal_sen       = (p_totals->>'subtotalSen')::integer,
         service_charge_sen = (p_totals->>'serviceChargeSen')::integer,
         sst_sen            = (p_totals->>'sstSen')::integer,
         takeaway_fee_sen   = (p_totals->>'takeawayFeeSen')::integer,
         rounding_sen       = (p_totals->>'roundingSen')::integer,
         total_sen          = (p_totals->>'totalSen')::integer
   where id = p_bill_id;
  v_queued := pos_queue_receipt(p_bill_id, false);
  update bills set receipt_queued = v_queued where id = p_bill_id;
  return pos_checkout_result(p_bill_id);
end $$;
revoke all on function pos_pay_and_close(uuid, uuid, uuid, jsonb, jsonb, uuid) from public, anon, authenticated;

-- checkout_bill: the live text of migration-2026-10-29-pos-device-till.sql with the lines marked S3
-- changed — the checks and writing of the payments are pos_check_payments and pos_pay_and_close.
-- Same checks in the same order, same messages, same rows written.
CREATE OR REPLACE FUNCTION checkout_bill(p_bill_id uuid, p_payments jsonb, p_checkout_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch    uuid := pos_my_branch();
  v_bill      bills;
  v_totals    jsonb;
  v_shift     uuid;                                                -- 4a
begin
  if p_checkout_id is null then raise exception 'Checkout id is missing'; end if;
  -- a resend of a checkout that already went through gets the first answer —
  -- but only for the same bill of the caller's branch
  select * into v_bill from bills where checkout_id = p_checkout_id;
  if found then
    if v_bill.id <> p_bill_id or v_bill.branch_id <> v_branch then
      raise exception 'This checkout id belongs to another bill';
    end if;
    -- H2: the first result is replayed only for the very same payments
    if not pos_checkout_same_payments(v_bill.id, p_payments) then
      raise exception 'This payment was already recorded with other amounts — check Today''s bills';
    end if;
    return pos_checkout_result(v_bill.id);
  end if;

  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  if v_bill.checkout_id is not distinct from p_checkout_id then  -- won by the same checkout while we waited
    if not pos_checkout_same_payments(v_bill.id, p_payments) then                                   -- H2
      raise exception 'This payment was already recorded with other amounts — check Today''s bills';  -- H2
    end if;                                                                                          -- H2
    return pos_checkout_result(v_bill.id);
  end if;
  -- 4a: money moves only inside the branch's open shift. FOR SHARE lets checkouts run
  -- side by side, while close_shift (FOR UPDATE) waits for one in flight and then counts it.
  select id into v_shift from pos_shifts where branch_id = v_branch and status = 'open' for share;
  if not found then raise exception 'Open the shift first'; end if;
  if v_bill.status <> 'open' then
    raise exception 'This bill is already %', case v_bill.status when 'paid' then 'paid'
                                                                 when 'voided' then 'voided'
                                                                 else 'merged into another bill' end;
  end if;
  if not exists (select 1 from order_items where bill_id = v_bill.id and voided_at is null) then
    raise exception 'This bill has no items to pay for';
  end if;

  v_totals := pos_bill_totals(v_bill.id);
  perform pos_check_payments(v_branch, p_payments, (v_totals->>'totalSen')::integer);          -- S3: validate before writing
  return pos_pay_and_close(v_bill.id, v_branch, v_shift, p_payments, v_totals, p_checkout_id); -- S3: payments, paid, receipt
end $function$;

-- ── S3. Moving units (spec §4.5), shared by checkout_items and move_items ─────
-- Each entry of a checked p_items onto bill p_to: a whole line keeps its row (same id, order,
-- discounts, void history); part of a line is cut into a copy with qty = taken (every snapshot
-- column copied, its share of an item amount discount, split_from_item = the line) and the line
-- keeps the rest. Returns { "<line id>": "<cut row id>" } for the cut lines. Internal.
create or replace function pos_move_units(p_items jsonb, p_to uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_e    jsonb;
  v_line order_items;
  v_take integer;
  v_cut  jsonb;
  v_new  uuid;
  v_map  jsonb := '{}'::jsonb;
begin
  for v_e in select * from jsonb_array_elements(p_items) loop
    select * into v_line from order_items where id = (v_e->>'itemId')::uuid;
    v_take := (v_e->'qty')::numeric::integer;
    if v_take >= v_line.qty then
      update order_items set bill_id = p_to where id = v_line.id;
    else
      v_cut := pos_split_line_discount(v_line.discount_kind, v_line.discount_value, v_line.qty, v_take);
      insert into order_items(order_id, bill_id, product_id, variant_id, name_snapshot, unit_price_sen, sst_rate_bp,
                              modifiers_snapshot, print_route, qty, note, takeaway_fee_sen, order_type,
                              catalog_discount_bp, catalog_discount_name,
                              discount_kind, discount_value, discount_reason, discount_approved_by, discount_by, discount_at,
                              split_from_item)
      values (v_line.order_id, p_to, v_line.product_id, v_line.variant_id, v_line.name_snapshot, v_line.unit_price_sen, v_line.sst_rate_bp,
              v_line.modifiers_snapshot, v_line.print_route, v_take, v_line.note, v_line.takeaway_fee_sen, v_line.order_type,
              v_line.catalog_discount_bp, v_line.catalog_discount_name,
              v_cut->>'kind', (v_cut->>'value')::integer,
              case when v_cut is not null then v_line.discount_reason end,
              case when v_cut is not null then v_line.discount_approved_by end,
              case when v_cut is not null then v_line.discount_by end,
              case when v_cut is not null then v_line.discount_at end,
              v_line.id)
      returning id into v_new;
      update order_items
         set qty = qty - v_take,
             discount_value = case when discount_kind = 'amount'
                                   then discount_value - coalesce((v_cut->>'value')::integer, 0) else discount_value end
       where id = v_line.id;
      v_map := v_map || jsonb_build_object(v_line.id::text, v_new);
    end if;
  end loop;
  return v_map;
end $$;
revoke all on function pos_move_units(jsonb, uuid) from public, anon, authenticated;

-- ── S3. Pay selected (spec §4.3): the selected units become their own bill, already paid ──
create or replace function checkout_items(p_bill_id uuid, p_items jsonb, p_payments jsonb, p_checkout_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_bill   bills;
  v_part   bills;
  v_shift  uuid;
  v_input  jsonb;
  v_totals jsonb;
  v_disc   jsonb;
  v_map    jsonb;
  v_left   integer;
begin
  if p_checkout_id is null then raise exception 'Checkout id is missing'; end if;
  -- 1. a resend of a split payment that went through gets the first answer
  select * into v_part from bills where checkout_id = p_checkout_id;
  if found then
    if v_part.split_from is distinct from p_bill_id or v_part.branch_id <> v_branch then
      raise exception 'This checkout id belongs to another bill';
    end if;
    if not pos_checkout_same_payments(v_part.id, p_payments) then
      raise exception 'This payment was already recorded with other amounts — check Today''s bills';
    end if;
    return pos_checkout_result(v_part.id);
  end if;
  -- 2. the table's bill locked, then the id once more (a resend that waited behind the first), the shift
  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  select * into v_part from bills where checkout_id = p_checkout_id;
  if found then
    if v_part.split_from is distinct from p_bill_id then raise exception 'This checkout id belongs to another bill'; end if;
    if not pos_checkout_same_payments(v_part.id, p_payments) then
      raise exception 'This payment was already recorded with other amounts — check Today''s bills';
    end if;
    return pos_checkout_result(v_part.id);
  end if;
  select id into v_shift from pos_shifts where branch_id = v_branch and status = 'open' for share;
  if not found then raise exception 'Open the shift first'; end if;
  if v_bill.status <> 'open' then
    raise exception 'This bill is already %', case v_bill.status when 'paid' then 'paid'
                                                                 when 'voided' then 'voided'
                                                                 else 'merged into another bill' end;
  end if;
  perform pos_split_check(v_bill, p_items);
  -- 3. the part's money exactly as pos_split_totals showed it; the payments checked before any write
  v_input  := pos_split_input(v_bill.id, p_items);
  v_totals := pos_compute_bill(v_input);
  v_disc   := case when jsonb_typeof(v_input->'billDiscount') = 'object' then v_input->'billDiscount' end;
  perform pos_check_payments(v_branch, p_payments, (v_totals->>'totalSen')::integer);
  -- 4. the paid part: same table and order type, no pax, its bill discount share with the original approval
  insert into bills(branch_id, bill_no, table_id, order_type, status, split_from, checkout_id, shift_id,
                    closed_at, closed_by, closed_device_id,
                    discount_kind, discount_value, discount_reason, discount_approved_by, discount_by, discount_at)
  values (v_branch, pos_next_bill_no(v_branch), v_bill.table_id, v_bill.order_type, 'paid', v_bill.id, p_checkout_id, v_shift,
          now(), pos_actor(), pos_current_device(),
          v_disc->>'kind', (v_disc->>'value')::integer,
          case when v_disc is not null then v_bill.discount_reason end,
          case when v_disc is not null then v_bill.discount_approved_by end,
          case when v_disc is not null then v_bill.discount_by end,
          case when v_disc is not null then v_bill.discount_at end)
  returning * into v_part;
  -- 5. the selected units
  v_map := pos_move_units(p_items, v_part.id);
  -- 6. the bill discount (spec §5): the part's share logged; an amount's rest stays on the table bill
  if v_disc is not null then
    insert into pos_discount_log(branch_id, bill_id, action, kind, value, reason, approved_by, actor)
    values (v_branch, v_part.id, 'split', v_disc->>'kind', (v_disc->>'value')::integer,
            v_bill.discount_reason, v_bill.discount_approved_by, pos_actor());
    if v_bill.discount_kind = 'amount' then
      v_left := v_bill.discount_value - (v_disc->>'value')::integer;
      if v_left > 0 then
        update bills set discount_value = v_left where id = v_bill.id;
      else
        update bills
           set discount_kind = null, discount_value = null, discount_reason = null,
               discount_approved_by = null, discount_by = null, discount_at = null
         where id = v_bill.id;
      end if;
      insert into pos_discount_log(branch_id, bill_id, action, kind, value, reason, approved_by, actor)
      values (v_branch, v_bill.id, 'split', 'amount', greatest(v_left, 0), v_bill.discount_reason, v_bill.discount_approved_by, pos_actor());
    end if;
  end if;
  -- 7. the cut rows' new ids in the frozen lines, then the payments, the receipt, the result
  v_totals := jsonb_set(v_totals, '{lines}', coalesce((
    select jsonb_agg(case when v_map ? (x.l->>'id') then jsonb_set(x.l, '{id}', v_map->(x.l->>'id')) else x.l end order by x.ord)
      from jsonb_array_elements(v_totals->'lines') with ordinality as x(l, ord)), '[]'::jsonb));
  update bills set updated_at = now() where id = v_bill.id;      -- a bills event: the other tablets refresh the table
  return pos_pay_and_close(v_part.id, v_branch, v_shift, p_payments, v_totals, p_checkout_id);
end $$;
revoke all on function checkout_items(uuid, jsonb, jsonb, uuid) from public, anon;
grant execute on function checkout_items(uuid, jsonb, jsonb, uuid) to authenticated;

-- pos_checkout_state: the live text of migration-2026-10-25-pos-hardening.sql with the lines marked
-- S3 added — the result is also a part of this bill paid under one of the screen's checkout ids
-- (the Payment screen's split mode follows the table bill, which stays open).
create or replace function pos_checkout_state(p_bill_id uuid, p_checkout_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_bill   bills;
begin
  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch;
  if not found then raise exception 'Bill not found'; end if;
  return jsonb_build_object(
    'status', v_bill.status,
    'billNo', v_bill.bill_no,
    'mergedIntoBillNo', (select m.bill_no from bills m where m.id = v_bill.merged_into),
    'totals', case when v_bill.status = 'open' then pos_bill_totals(v_bill.id) end,
    'result', case when v_bill.status = 'paid' and v_bill.checkout_id = any(coalesce(p_checkout_ids, '{}'::uuid[]))
                   then pos_checkout_result(v_bill.id)
                   else (select pos_checkout_result(p.id) from bills p                                    -- S3
                          where p.split_from = v_bill.id                                                  -- S3
                            and p.checkout_id = any(coalesce(p_checkout_ids, '{}'::uuid[]))               -- S3
                          order by p.closed_at limit 1) end);                                             -- S3
end $$;
revoke all on function pos_checkout_state(uuid, uuid[]) from public, anon;
grant execute on function pos_checkout_state(uuid, uuid[]) to authenticated;

notify pgrst, 'reload schema';
select 'pos split bill applied' as result;
