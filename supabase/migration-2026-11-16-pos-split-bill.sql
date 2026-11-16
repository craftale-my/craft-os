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
-- The trailing comment in the body is deliberate: migration-2026-10-25-pos-hardening-verify.sql
-- checks that pos_bill_totals' definition mentions oi.order_type (it guards against the pre-H4
-- body coming back); the per-line order type now lives in pos_bill_input. Keep it on a code line.
create or replace function pos_bill_totals(p_bill_id uuid) returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select pos_compute_bill(x.i) from (select pos_bill_input(p_bill_id) as i) x where x.i is not null   -- S2: lines carry oi.order_type via pos_bill_input
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

notify pgrst, 'reload schema';
select 'pos split bill applied' as result;
