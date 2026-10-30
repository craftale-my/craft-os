-- ============================================================================
-- Craft OS — POS discounts (2026-10-30). Run on craft-os-dev after
-- migration-2026-10-29-pos-device-till.sql. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-30-pos-discounts.md
-- Design: docs/superpowers/specs/2026-10-30-pos-discounts-design.md
--
-- D1  Schema: menu_catalogs.discount_bp (Staff Meal = 5000); order_items keeps the catalog's
--     discount and name from when it was ordered (trigger order_items_catalog_discount) and its
--     item discount; bills keep the bill discount; pos_discount_log records every set and clear;
--     reason_templates gains the 'discount' action.
-- D2  Totals: pos_compute_bill applies catalog → item → bill (shared pro rata) discounts before
--     service charge and SST and returns grossSen, catalogDiscountSen, itemDiscountSen,
--     billDiscountSen and lines[]; mirrored by computeBill (src/features/pos/checkout/bill.ts),
--     both pass billVectors.json. pos_bill_totals passes the discounts and each item's id.
-- D3  RPCs: set_item_discount, clear_item_discount, set_bill_discount, clear_bill_discount;
--     merge_bills refuses a source bill with a bill discount.
-- D4  Receipt and Z report: discount rows under items, the bill discount line, a Discounts section.
-- Re-run hazards: re-running migration-2026-10-25-pos-hardening.sql puts back the old
-- pos_compute_bill, pos_bill_totals and pos_shift_report; migration-2026-10-24-pos-checkout-fn.sql
-- the old pos_receipt_payload; migration-2026-10-29-pos-device-till.sql the old merge_bills —
-- re-run this file after any of them.
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_actor()') is null or to_regprocedure('pos_current_device()') is null then
    raise exception 'STOP: run migration-2026-10-29-pos-device-till.sql first (pos_actor is missing)';
  end if;
end $$;

-- ── D1. Schema ──────────────────────────────────────────────────────────────
alter table menu_catalogs add column if not exists discount_bp integer not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'menu_catalogs_discount_bp_check') then
    alter table menu_catalogs add constraint menu_catalogs_discount_bp_check
      check (discount_bp between 0 and 10000 and discount_bp % 100 = 0);
  end if;
end $$;

alter table order_items
  add column if not exists catalog_discount_bp   integer not null default 0,
  add column if not exists catalog_discount_name text,
  add column if not exists discount_kind         text,
  add column if not exists discount_value        integer,
  add column if not exists discount_reason       text,
  add column if not exists discount_approved_by  uuid,
  add column if not exists discount_by           uuid,
  add column if not exists discount_at           timestamptz;
alter table bills
  add column if not exists discount_kind         text,
  add column if not exists discount_value        integer,
  add column if not exists discount_reason       text,
  add column if not exists discount_approved_by  uuid,
  add column if not exists discount_by           uuid,
  add column if not exists discount_at           timestamptz;
-- a discount is all there or all gone; the reason may be empty when the template does not ask for one
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'order_items_discount_check') then
    alter table order_items add constraint order_items_discount_check check (
      (discount_kind is null and discount_value is null and discount_reason is null
         and discount_approved_by is null and discount_by is null and discount_at is null)
      or (discount_approved_by is not null and discount_by is not null and discount_at is not null
          and ((discount_kind = 'amount' and discount_value > 0)
               or (discount_kind = 'percent' and discount_value between 100 and 10000 and discount_value % 100 = 0))));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bills_discount_check') then
    alter table bills add constraint bills_discount_check check (
      (discount_kind is null and discount_value is null and discount_reason is null
         and discount_approved_by is null and discount_by is null and discount_at is null)
      or (discount_approved_by is not null and discount_by is not null and discount_at is not null
          and ((discount_kind = 'amount' and discount_value > 0)
               or (discount_kind = 'percent' and discount_value between 100 and 10000 and discount_value % 100 = 0))));
  end if;
end $$;

-- the order's catalog discount and name, fixed when the item is ordered
create or replace function order_items_catalog_discount() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  select c.discount_bp, case when c.discount_bp > 0 then c.name end
    into new.catalog_discount_bp, new.catalog_discount_name
    from orders o join menu_catalogs c on c.id = o.catalog_id
   where o.id = new.order_id;
  new.catalog_discount_bp := coalesce(new.catalog_discount_bp, 0);
  return new;
end $$;
revoke all on function order_items_catalog_discount() from public, anon, authenticated;
drop trigger if exists order_items_catalog_discount on order_items;
create trigger order_items_catalog_discount before insert on order_items
  for each row execute function order_items_catalog_discount();

-- every discount set or cleared (written only by the D3 RPCs; read by the outlet, like its bills)
create table if not exists pos_discount_log (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  bill_id       uuid not null references bills(id),
  order_item_id uuid references order_items(id),          -- null = the bill discount
  action        text not null check (action in ('set', 'clear')),
  kind          text check (kind in ('amount', 'percent')),
  value         integer,
  reason        text,
  approved_by   uuid,                                      -- null on a clear (no PIN)
  actor         uuid,
  device_id     uuid default pos_current_device(),
  created_at    timestamptz not null default now()
);
alter table pos_discount_log enable row level security;
revoke all on pos_discount_log from public, anon, authenticated;
grant select on pos_discount_log to authenticated;
drop policy if exists pos_read on pos_discount_log;
create policy pos_read on pos_discount_log for select to authenticated
  using (branch_id in (select pos_readable_branches()));
create index if not exists pos_discount_log_bill_idx on pos_discount_log(bill_id);
create index if not exists pos_discount_log_branch_created_idx on pos_discount_log(branch_id, created_at);

alter table reason_templates drop constraint if exists reason_templates_action_check;
alter table reason_templates add constraint reason_templates_action_check
  check (action in ('void_item', 'void_bill', 'refund', 'discount'));

-- A discount's kind and value as the cashier sent them (the same words as discountProblem in
-- src/features/pos/checkout/discounts.ts). Internal.
create or replace function pos_check_discount(p_kind text, p_value integer) returns void
language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if p_kind = 'percent' then
    if p_value is null or p_value < 100 or p_value > 10000 or p_value % 100 <> 0 then
      raise exception 'Enter a whole percent from 1 to 100';
    end if;
  elsif p_kind = 'amount' then
    if p_value is null or p_value <= 0 then raise exception 'Enter an amount above RM 0.00'; end if;
  else
    raise exception 'Choose Amount or Percent';
  end if;
end $$;
revoke all on function pos_check_discount(text, integer) from public, anon, authenticated;

-- Catalogs → Discount %: a whole percent 0–100 of every item ordered from the catalog
create or replace function menu_set_catalog_discount(p_id uuid, p_bp integer) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform menu_require_editor();
  if p_bp is null or p_bp < 0 or p_bp > 10000 or p_bp % 100 <> 0 then
    raise exception 'Enter a whole percent from 0 to 100';
  end if;
  update menu_catalogs set discount_bp = p_bp where id = p_id;
  if not found then raise exception 'Catalog not found — refresh and try again'; end if;
end $$;
revoke all on function menu_set_catalog_discount(uuid, integer) from public, anon;
grant execute on function menu_set_catalog_discount(uuid, integer) to authenticated;

-- ── D2. Totals ──────────────────────────────────────────────────────────────
-- The live text of migration-2026-10-25-pos-hardening.sql (H4) with the lines marked D added:
-- live lines in input order → catalog discount → item discount → subtotal → bill discount,
-- shared pro rata (floor, then the leftover sen to the largest net first, ties to the earlier
-- line, never below zero) → service charge and SST on the shared-down nets.
create or replace function pos_compute_bill(p_input jsonb) returns jsonb
language sql immutable security invoker set search_path = public, pg_temp as $$
  with raw as (                                                                       -- D
    select x.ord, x.l, (x.l->>'unitPriceSen')::bigint * (x.l->>'qty')::bigint as gross
      from jsonb_array_elements(coalesce(p_input->'lines', '[]'::jsonb)) with ordinality as x(l, ord)
     where not coalesce((x.l->>'voided')::boolean, false)
  ),
  cat as (                                                                            -- D
    select r.*, round(r.gross * coalesce((r.l->>'catalogDiscountBp')::integer, 0) / 10000.0)::bigint as cat_off
      from raw r
  ),
  itm as (                                                                            -- D
    select c.*,
           case when coalesce(jsonb_typeof(c.l->'discount'), 'null') <> 'object' or c.gross - c.cat_off <= 0 then 0
                when c.l->'discount'->>'kind' = 'percent'
                  then round((c.gross - c.cat_off) * (c.l->'discount'->>'value')::bigint / 10000.0)::bigint
                else least((c.l->'discount'->>'value')::bigint, c.gross - c.cat_off) end as item_off
      from cat c
  ),
  nets as (select i.*, i.gross - i.cat_off - i.item_off as net from itm i),          -- D
  bd as (                                                                             -- D
    select s.subtotal,
           case when coalesce(jsonb_typeof(p_input->'billDiscount'), 'null') <> 'object' or s.subtotal <= 0 then 0
                when p_input->'billDiscount'->>'kind' = 'percent'
                  then round(s.subtotal * (p_input->'billDiscount'->>'value')::bigint / 10000.0)::bigint
                else least((p_input->'billDiscount'->>'value')::bigint, s.subtotal) end as bill_off
      from (select coalesce(sum(net), 0)::bigint as subtotal from nets) s
  ),
  fl as (                                                                             -- D
    select n.*, case when bd.bill_off > 0 then floor(bd.bill_off::numeric * n.net / bd.subtotal)::bigint else 0 end as floor_share
      from nets n, bd
  ),
  lo as (select bd.bill_off - coalesce((select sum(floor_share) from fl), 0) as left_over from bd),   -- D
  rm as (                                                                             -- D
    select fl.*,
           coalesce(sum(fl.net - fl.floor_share) over (order by fl.net desc, fl.ord
                                                       rows between unbounded preceding and 1 preceding), 0) as room_before
      from fl
  ),
  sh as (                                                                             -- D
    select rm.*, rm.floor_share + least(rm.net - rm.floor_share, greatest(0, lo.left_over - rm.room_before)) as share
      from rm, lo
  ),
  lines as (
    select sh.ord, sh.l->'id' as id, sh.gross, sh.cat_off, sh.item_off, sh.share,     -- D
           sh.net - sh.share as amount,                                               -- D: what it is charged on
           (sh.l->>'productId') as product_id,
           (sh.l->>'sstRateBp')::integer as sst_bp,
           coalesce((sh.l->>'takeawayFeeSen')::bigint, 0) * (sh.l->>'qty')::bigint as fee,
           coalesce(sh.l->>'orderType', p_input->>'orderType') as order_type          -- H4: the line's own order type
      from sh
  ),
  rated as (
    select ln.*,
           (select (rr.rule->>'rateBp')::integer
              from jsonb_array_elements(coalesce(p_input->'rules', '[]'::jsonb)) with ordinality as rr(rule, ord)
             where (rr.rule->'orderTypes') ? ln.order_type                                   -- H4
               and (jsonb_typeof(rr.rule->'tableIds') is distinct from 'array'
                    or (ln.order_type = 'dine_in'                                              -- H4: a takeaway line has no table
                        and p_input->>'tableId' is not null and (rr.rule->'tableIds') ? (p_input->>'tableId')))
               and (jsonb_typeof(rr.rule->'productIds') is distinct from 'array'
                    or (ln.product_id is not null and (rr.rule->'productIds') ? ln.product_id))
             order by rr.ord
             limit 1) as sc_bp
      from lines ln
  ),
  sc as (
    select sc_bp as rate_bp, sum(amount) as base, round(sum(amount) * sc_bp / 10000.0) as amt
      from rated where sc_bp > 0 group by sc_bp
  ),
  taxed as (
    select sst_bp, amount + case when order_type = 'takeaway' then fee else 0 end as base_part   -- H4
      from lines
  ),
  sst as (
    select sst_bp as rate_bp, sum(base_part) as base, round(sum(base_part) * sst_bp / 10000.0) as amt
      from taxed
     where sst_bp > 0 and coalesce((p_input->>'sstRegistered')::boolean, true)
     group by sst_bp
  ),
  t as (
    select bd.subtotal, bd.bill_off,                                                  -- D
           coalesce((select sum(gross) from lines), 0) as gross_total,               -- D
           coalesce((select sum(cat_off) from lines), 0) as cat_total,               -- D
           coalesce((select sum(item_off) from lines), 0) as item_total,             -- D
           coalesce((select sum(amt) from sc), 0) as sc_total,
           coalesce((select sum(amt) from sst), 0) as sst_total,
           coalesce((select sum(fee) from lines where order_type = 'takeaway'), 0) as fee_total             -- H4
      from bd
  ),
  b as (
    select t.*, t.subtotal - t.bill_off + t.sc_total + t.sst_total + t.fee_total as before_rounding from t   -- D: − bill_off
  ),
  m as (
    -- remainder normalised to 0..4 so a negative amount rounds like roundingDeltaSen (bill.ts)
    select b.*, ((b.before_rounding % 5) + 5) % 5 as r5 from b
  ),
  fin as (
    select m.*,
           case when coalesce(p_input->>'cashRounding', 'nearest_5_sen') <> 'nearest_5_sen' then 0
                when m.r5 in (1, 2) then -m.r5         -- …1, …2 → down
                when m.r5 in (3, 4) then 5 - m.r5      -- …3, …4 → up
                else 0 end as rounding
      from m
  )
  select jsonb_build_object(
    'subtotalSen', fin.subtotal, 'serviceChargeSen', fin.sc_total, 'sstSen', fin.sst_total,
    'takeawayFeeSen', fin.fee_total, 'beforeRoundingSen', fin.before_rounding, 'roundingSen', fin.rounding,
    'totalSen', fin.before_rounding + fin.rounding,
    'sstGroups', coalesce((select jsonb_agg(jsonb_build_object('rateBp', rate_bp, 'baseSen', base, 'amountSen', amt) order by rate_bp) from sst), '[]'::jsonb),
    'serviceChargeGroups', coalesce((select jsonb_agg(jsonb_build_object('rateBp', rate_bp, 'baseSen', base, 'amountSen', amt) order by rate_bp) from sc), '[]'::jsonb),
    'grossSen', fin.gross_total, 'catalogDiscountSen', fin.cat_total,                                   -- D
    'itemDiscountSen', fin.item_total, 'billDiscountSen', fin.bill_off,                                -- D
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'catalogDiscountSen', cat_off,  -- D
                                                           'itemDiscountSen', item_off, 'billShareSen', share,
                                                           'netSen', amount) order by ord) from lines), '[]'::jsonb))
  from fin
$$;
revoke all on function pos_compute_bill(jsonb) from public, anon;
grant execute on function pos_compute_bill(jsonb) to authenticated;

-- The live text of migration-2026-10-25-pos-hardening.sql with the lines marked D added. Lines go
-- in order item id order: computeBill gets them in the same order (billView), so a bill
-- discount's leftover sen lands on the same line on both sides.
create or replace function pos_bill_totals(p_bill_id uuid) returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select pos_compute_bill(jsonb_build_object(
    'orderType', b.order_type,
    'tableId', b.table_id,
    'sstRegistered', coalesce(s.sst_registered, true),
    'cashRounding', coalesce(s.cash_rounding, 'nearest_5_sen'),
    'rules', coalesce((
      select jsonb_agg(jsonb_build_object('rateBp', r.rate_bp, 'orderTypes', to_jsonb(r.order_types),
                                          'tableIds', to_jsonb(r.table_ids), 'productIds', to_jsonb(r.product_ids))
                       order by r.sort_order, r.created_at, r.id)
        from service_charge_rules r where r.branch_id = b.branch_id and r.is_active), '[]'::jsonb),
    'billDiscount', case when b.discount_kind is null then null                                         -- D
                         else jsonb_build_object('kind', b.discount_kind, 'value', b.discount_value) end,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object('id', oi.id,                                                  -- D
                                          'productId', oi.product_id, 'unitPriceSen', oi.unit_price_sen, 'qty', oi.qty,
                                          'sstRateBp', oi.sst_rate_bp, 'takeawayFeeSen', oi.takeaway_fee_sen,
                                          'voided', oi.voided_at is not null,
                                          'orderType', oi.order_type,                                   -- H4
                                          'catalogDiscountBp', oi.catalog_discount_bp,                  -- D
                                          'discount', case when oi.discount_kind is null then null      -- D
                                                           else jsonb_build_object('kind', oi.discount_kind, 'value', oi.discount_value) end)
                       order by oi.id)
        from order_items oi where oi.bill_id = b.id), '[]'::jsonb)))
  from bills b
  left join branch_pos_settings s on s.branch_id = b.branch_id
  where b.id = p_bill_id
$$;
revoke all on function pos_bill_totals(uuid) from public, anon;
grant execute on function pos_bill_totals(uuid) to authenticated;

-- ── D3. Discounts on an open bill ───────────────────────────────────────────
-- Like void_order_item: the bill row locked, the item read again under the lock, the reason
-- and the supervisor's PIN checked, the change logged, bills.updated_at bumped so the other
-- tablets hear of it at once. Setting again replaces; it never stacks.
create or replace function set_item_discount(p_item_id uuid, p_kind text, p_value integer, p_reason text,
                                             p_approver_id uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_item   order_items;
  v_bill   bills;
  v_reason text;
  v_err    text;
begin
  perform pos_check_discount(p_kind, p_value);
  select * into v_item from order_items where id = p_item_id;
  if not found then raise exception 'Item not found'; end if;
  select * into v_bill from bills where id = v_item.bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Item not found'; end if;
  select * into v_item from order_items where id = p_item_id;            -- again, under the bill lock
  if v_item.bill_id <> v_bill.id then raise exception 'The bill just changed — please try again'; end if;
  if v_bill.status <> 'open' then raise exception 'Only an open bill can be discounted'; end if;
  if v_item.voided_at is not null then raise exception 'A voided item cannot be discounted'; end if;
  v_reason := pos_check_reason(v_branch, 'discount', p_reason);
  v_err := pos_check_approver(v_branch, p_approver_id, p_pin);
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  update order_items
     set discount_kind = p_kind, discount_value = p_value, discount_reason = v_reason,
         discount_approved_by = p_approver_id, discount_by = pos_actor(), discount_at = now()
   where id = p_item_id;
  insert into pos_discount_log(branch_id, bill_id, order_item_id, action, kind, value, reason, approved_by, actor)
  values (v_branch, v_bill.id, p_item_id, 'set', p_kind, p_value, v_reason, p_approver_id, pos_actor());
  update bills set updated_at = now() where id = v_bill.id;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function set_item_discount(uuid, text, integer, text, uuid, text) from public, anon;
grant execute on function set_item_discount(uuid, text, integer, text, uuid, text) to authenticated;

-- No PIN: removing a discount only raises the price. Logged with who removed it.
create or replace function clear_item_discount(p_item_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_item   order_items;
  v_bill   bills;
begin
  select * into v_item from order_items where id = p_item_id;
  if not found then raise exception 'Item not found'; end if;
  select * into v_bill from bills where id = v_item.bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Item not found'; end if;
  select * into v_item from order_items where id = p_item_id;            -- again, under the bill lock
  if v_item.bill_id <> v_bill.id then raise exception 'The bill just changed — please try again'; end if;
  if v_bill.status <> 'open' then raise exception 'Discounts can only change on an open bill'; end if;
  if v_item.discount_kind is null then return jsonb_build_object('ok', true); end if;   -- a retry
  update order_items
     set discount_kind = null, discount_value = null, discount_reason = null,
         discount_approved_by = null, discount_by = null, discount_at = null
   where id = p_item_id;
  insert into pos_discount_log(branch_id, bill_id, order_item_id, action, kind, value, reason, actor)
  values (v_branch, v_bill.id, p_item_id, 'clear', v_item.discount_kind, v_item.discount_value, v_item.discount_reason, pos_actor());
  update bills set updated_at = now() where id = v_bill.id;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function clear_item_discount(uuid) from public, anon;
grant execute on function clear_item_discount(uuid) to authenticated;

create or replace function set_bill_discount(p_bill_id uuid, p_kind text, p_value integer, p_reason text,
                                             p_approver_id uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_bill   bills;
  v_reason text;
  v_err    text;
begin
  perform pos_check_discount(p_kind, p_value);
  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  if v_bill.status <> 'open' then raise exception 'Only an open bill can be discounted'; end if;
  v_reason := pos_check_reason(v_branch, 'discount', p_reason);
  v_err := pos_check_approver(v_branch, p_approver_id, p_pin);
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  update bills
     set discount_kind = p_kind, discount_value = p_value, discount_reason = v_reason,
         discount_approved_by = p_approver_id, discount_by = pos_actor(), discount_at = now(), updated_at = now()
   where id = p_bill_id;
  insert into pos_discount_log(branch_id, bill_id, action, kind, value, reason, approved_by, actor)
  values (v_branch, p_bill_id, 'set', p_kind, p_value, v_reason, p_approver_id, pos_actor());
  return jsonb_build_object('ok', true);
end $$;
revoke all on function set_bill_discount(uuid, text, integer, text, uuid, text) from public, anon;
grant execute on function set_bill_discount(uuid, text, integer, text, uuid, text) to authenticated;

create or replace function clear_bill_discount(p_bill_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_bill   bills;
begin
  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  if v_bill.status <> 'open' then raise exception 'Discounts can only change on an open bill'; end if;
  if v_bill.discount_kind is null then return jsonb_build_object('ok', true); end if;   -- a retry
  update bills
     set discount_kind = null, discount_value = null, discount_reason = null,
         discount_approved_by = null, discount_by = null, discount_at = null, updated_at = now()
   where id = p_bill_id;
  insert into pos_discount_log(branch_id, bill_id, action, kind, value, reason, actor)
  values (v_branch, p_bill_id, 'clear', v_bill.discount_kind, v_bill.discount_value, v_bill.discount_reason, pos_actor());
  return jsonb_build_object('ok', true);
end $$;
revoke all on function clear_bill_discount(uuid) from public, anon;
grant execute on function clear_bill_discount(uuid) to authenticated;

-- merge_bills: the live text of migration-2026-10-29-pos-device-till.sql with the line marked D
-- added — a bill discount does not move with its items, so the source bill must drop it first.
CREATE OR REPLACE FUNCTION merge_bills(p_from_bill uuid, p_into_bill uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch uuid := pos_my_branch();
  v_from   bills;
  v_into   bills;
begin
  if p_from_bill is null or p_into_bill is null or p_from_bill = p_into_bill then
    raise exception 'Choose two different bills';
  end if;
  -- lock both in one fixed order, so two iPads merging the same pair cannot deadlock
  perform 1 from bills where id in (p_from_bill, p_into_bill) order by id for update;
  select * into v_from from bills where id = p_from_bill and branch_id = v_branch;
  select * into v_into from bills where id = p_into_bill and branch_id = v_branch;
  if v_from.id is null or v_into.id is null then raise exception 'Bill not found'; end if;
  if v_from.status <> 'open' or v_into.status <> 'open' then raise exception 'Only open bills can be merged'; end if;
  if v_from.discount_kind is not null then raise exception 'Remove the bill discount before merging'; end if;   -- D
  if v_from.order_type = 'dine_in' and v_into.order_type = 'takeaway' then
    raise exception 'Merge the takeaway bill into the table''s bill, not the other way round';
  end if;
  update orders set bill_id = v_into.id where bill_id = v_from.id;
  update order_items set bill_id = v_into.id where bill_id = v_from.id;
  update bills
     set pax = case when v_into.pax is null and v_from.pax is null then null
                    else least(99, coalesce(v_into.pax, 0) + coalesce(v_from.pax, 0)) end
   where id = v_into.id;
  update bills
     set status = 'merged', merged_into = v_into.id, closed_at = now(), closed_by = pos_actor(), closed_device_id = pos_current_device()
   where id = v_from.id;
end $function$;

-- ── D4. Receipt: the live text of migration-2026-10-24-pos-checkout-fn.sql with the lines marked D
--    added — each item's catalog and item discounts (amounts from the frozen totals' lines) and
--    the bill discount. Exactly ReceiptPayload (src/features/pos/print/receipt.ts). ─
create or replace function pos_receipt_payload(p_bill_id uuid, p_reprint boolean) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'kind', 'receipt',
    'route', s.receipt_route,
    'reprint', p_reprint,
    'header', jsonb_build_object(
      'title', coalesce(nullif(trim(br.receipt_title), ''), br.name),
      'legalName', nullif(trim(br.legal_name), ''),
      'registrationNo', nullif(trim(br.registration_no), ''),
      'sstNo', nullif(trim(br.sst_no), ''),
      'address', nullif(trim(br.address), ''),
      'phone', nullif(trim(br.phone), ''),
      'email', nullif(trim(br.email), '')),
    'billNo', b.bill_no,
    'closedAt', to_char(b.closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'cashier', (select st.name from staff st where st.id = b.closed_by),
    'tableLabel', t.label,
    'pax', b.pax,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'qty', oi.qty, 'name', oi.name_snapshot, 'unitSen', oi.unit_price_sen,
               'amountSen', oi.unit_price_sen * oi.qty,
               'mods', (select coalesce(jsonb_agg(m->>'name' order by ord), '[]'::jsonb)
                          from jsonb_array_elements(oi.modifiers_snapshot) with ordinality as x(m, ord)),
               'discounts', (select coalesce(jsonb_agg(d.j order by d.k), '[]'::jsonb) from (                -- D
                   select 1 as k, jsonb_build_object(
                            'label', coalesce(oi.catalog_discount_name, 'Catalog') || ' ' || (oi.catalog_discount_bp / 100) || '%',
                            'amountSen', (ln.l->>'catalogDiscountSen')::integer) as j
                    where coalesce((ln.l->>'catalogDiscountSen')::integer, 0) > 0
                   union all
                   select 2, jsonb_build_object(
                            'label', case when oi.discount_kind = 'percent' then 'Discount ' || (oi.discount_value / 100) || '%'
                                          else 'Discount' end,
                            'amountSen', (ln.l->>'itemDiscountSen')::integer)
                    where coalesce((ln.l->>'itemDiscountSen')::integer, 0) > 0) d))
             order by o.placed_at, oi.name_snapshot, oi.id)
        from order_items oi join orders o on o.id = oi.order_id
        left join lateral (select x.l from jsonb_array_elements(coalesce(b.totals->'lines', '[]'::jsonb)) as x(l)  -- D
                            where x.l->>'id' = oi.id::text) ln on true
       where oi.bill_id = b.id and oi.voided_at is null), '[]'::jsonb),
    'itemCount', (select coalesce(sum(oi.qty), 0) from order_items oi where oi.bill_id = b.id and oi.voided_at is null),
    'subtotalSen', b.subtotal_sen,
    'billDiscountSen', coalesce((b.totals->>'billDiscountSen')::integer, 0),                                -- D
    'sstGroups', coalesce(b.totals->'sstGroups', '[]'::jsonb),
    'serviceChargeGroups', coalesce(b.totals->'serviceChargeGroups', '[]'::jsonb),
    'takeawayFeeSen', b.takeaway_fee_sen,
    'roundingSen', b.rounding_sen,
    'totalSen', b.total_sen,
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object('name', p.method_name, 'kind', p.kind, 'amountSen', p.amount_sen,
                                          'tenderedSen', p.tendered_sen, 'reference', p.reference)
                       order by p.line_no, p.id)
        from payments p where p.bill_id = b.id), '[]'::jsonb),
    'changeSen', (select coalesce(sum(p.change_sen), 0) from payments p where p.bill_id = b.id),
    'footer', coalesce(s.receipt_footer, 'This is an official receipt. Thank you for visiting us.'))
  from bills b
  join branches br on br.id = b.branch_id
  left join branch_pos_settings s on s.branch_id = b.branch_id
  left join dining_tables t on t.id = b.table_id
  where b.id = p_bill_id
$$;
revoke all on function pos_receipt_payload(uuid, boolean) from public, anon, authenticated;

-- ── D4. Z report: the live text of migration-2026-10-25-pos-hardening.sql with the lines marked D
--    changed — gross sales net of bill discounts, Before discounts / Discounts, and a Discounts
--    section. Exactly ZReport in src/features/pos/print/zreport.ts. Internal. ─
create or replace function pos_shift_report(p_shift_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with s as (
    select sh.*, coalesce(sh.closed_at, now()) as until,
           -- H5: the close of the branch's shift before this one (null when there is none)
           (select max(p.closed_at) from pos_shifts p
             where p.branch_id = sh.branch_id and p.status = 'closed' and p.opened_at < sh.opened_at) as prev_close
      from pos_shifts sh where sh.id = p_shift_id
  ),
  sb as (                                                                -- the shift's bills
    select b.* from bills b where b.shift_id = p_shift_id
  ),
  t as (
    select count(*)::integer as bill_count, coalesce(sum(sb.pax), 0)::integer as pax,
           coalesce(sum(sb.subtotal_sen - coalesce((sb.totals->>'billDiscountSen')::integer, 0)), 0)::integer as gross,   -- D
           coalesce(sum(sb.takeaway_fee_sen), 0)::integer as fee,
           coalesce(sum(sb.service_charge_sen), 0)::integer as sc, coalesce(sum(sb.sst_sen), 0)::integer as sst,
           coalesce(sum(sb.rounding_sen), 0)::integer as rounding, coalesce(sum(sb.total_sen), 0)::integer as nett,
           coalesce(sum(coalesce((sb.totals->>'grossSen')::integer, sb.subtotal_sen)), 0)::integer as before_disc,           -- D
           coalesce(sum(coalesce((sb.totals->>'catalogDiscountSen')::integer, 0)), 0)::integer as cat_disc,                  -- D
           coalesce(sum(coalesce((sb.totals->>'itemDiscountSen')::integer, 0)), 0)::integer as item_disc,                    -- D
           coalesce(sum(coalesce((sb.totals->>'billDiscountSen')::integer, 0)), 0)::integer as bill_disc,                    -- D
           (count(*) filter (where coalesce((sb.totals->>'catalogDiscountSen')::integer, 0) > 0))::integer as cat_bills,      -- D
           (count(*) filter (where coalesce((sb.totals->>'billDiscountSen')::integer, 0) > 0))::integer as bill_disc_bills   -- D
      from sb
  ),
  vi as (                                                                -- items voided since the last close
    select oi.*, b.bill_no from order_items oi join bills b on b.id = oi.bill_id, s
     where b.branch_id = s.branch_id and oi.voided_at <= s.until
       and (oi.voided_at > s.prev_close or (s.prev_close is null and oi.voided_at >= s.opened_at))   -- H5
  ),
  vb as (                                                                -- bills voided since the last close
    select b.* from bills b, s
     where b.branch_id = s.branch_id and b.status = 'voided' and b.closed_at <= s.until
       and (b.closed_at > s.prev_close or (s.prev_close is null and b.closed_at >= s.opened_at))     -- H5
  ),
  rf as (select r.* from refunds r where r.shift_id = p_shift_id),
  mv as (select m.* from pos_cash_moves m where m.shift_id = p_shift_id),
  pm as (
    select p.method_id, min(p.method_name) as name, min(p.kind) as kind, count(*)::integer as n, sum(p.amount_sen)::integer as amt
      from payments p where p.shift_id = p_shift_id group by p.method_id
  ),
  rm as (
    select r.method_id, min(r.method_name) as name, min(coalesce(r.kind, 'other')) as kind, count(*)::integer as n,
           sum(r.amount_sen)::integer as amt
      from rf r group by r.method_id
  )
  select jsonb_build_object(
    'branch', (select coalesce(nullif(trim(br.receipt_title), ''), br.name) from branches br where br.id = s.branch_id),
    'openedAt', to_char(s.opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'openedBy', (select st.name from staff st where st.id = s.opened_by),
    'closedAt', to_char(s.until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'closedBy', (select st.name from staff st where st.id = s.closed_by),
    'summary', jsonb_build_object(
      'billCount', t.bill_count, 'pax', t.pax, 'nettSen', t.nett,
      'avgPerBillSen', case when t.bill_count > 0 then round(t.nett::numeric / t.bill_count)::integer else 0 end,
      'avgPerPaxSen', case when t.pax > 0 then round(t.nett::numeric / t.pax)::integer else 0 end,
      'voidBillCount', (select count(*)::integer from vb),
      'voidSen', (select coalesce(sum(vi.unit_price_sen * vi.qty), 0)::integer from vi),
      'refundSen', (select coalesce(sum(rf.amount_sen), 0)::integer from rf)),
    'sales', jsonb_build_object(
      'grossSen', t.gross, 'takeawayFeeSen', t.fee, 'serviceChargeSen', t.sc, 'sstSen', t.sst,
      'roundingSen', t.rounding, 'nettSen', t.nett,
      'beforeDiscountsSen', t.before_disc, 'discountSen', t.cat_disc + t.item_disc + t.bill_disc),                       -- D
    'discounts', jsonb_build_object(                                                                                       -- D
      'catalogSen', t.cat_disc, 'catalogBills', t.cat_bills,
      'itemSen', t.item_disc,
      'itemCount', (select count(*)::integer from sb, jsonb_array_elements(coalesce(sb.totals->'lines', '[]'::jsonb)) as x(l)
                     where coalesce((x.l->>'itemDiscountSen')::integer, 0) > 0),
      'billSen', t.bill_disc, 'billCount', t.bill_disc_bills),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', coalesce(pm.name, rm.name), 'kind', coalesce(pm.kind, rm.kind),
               'count', coalesce(pm.n, 0), 'amountSen', coalesce(pm.amt, 0),
               'refundCount', coalesce(rm.n, 0), 'refundSen', coalesce(rm.amt, 0),
               'netSen', coalesce(pm.amt, 0) - coalesce(rm.amt, 0))
             order by coalesce(pm.name, rm.name))
        from pm full join rm on rm.method_id = pm.method_id), '[]'::jsonb),
    'orderTypes', (
      select jsonb_agg(jsonb_build_object(
               'orderType', x.ot,
               'bills', (select count(*)::integer from sb where sb.order_type = x.ot),
               'nettSen', (select coalesce(sum(sb.total_sen), 0)::integer from sb where sb.order_type = x.ot))
             order by x.ord)
        from (values ('dine_in', 1), ('takeaway', 2)) as x(ot, ord)),
    'sources', (
      select jsonb_agg(jsonb_build_object(
               'source', x.src,
               'orders', (select count(*)::integer from orders o where o.bill_id in (select sb.id from sb) and o.source = x.src),
               'itemSen', (select coalesce(sum(oi.unit_price_sen * oi.qty), 0)::integer
                             from order_items oi join orders o on o.id = oi.order_id
                            where o.bill_id in (select sb.id from sb) and o.source = x.src and oi.voided_at is null))
             order by x.ord)
        from (values ('counter', 1), ('qr', 2)) as x(src, ord)),
    'cash', jsonb_build_object(
      'openingFloatSen', s.opening_float_sen,
      'cashSalesSen', coalesce((select sum(p.amount_sen) from payments p where p.shift_id = s.id and p.kind = 'cash'), 0)::integer,
      'cashRefundSen', coalesce((select sum(rf.amount_sen) from rf where rf.kind = 'cash'), 0)::integer,
      'moves', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'kind', mv.kind, 'amountSen', mv.amount_sen, 'reason', mv.reason,
                 'by', (select st.name from staff st where st.id = mv.created_by),
                 'approvedBy', (select st.name from staff st where st.id = mv.approved_by),
                 'at', to_char(mv.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
               order by mv.created_at, mv.id)
          from mv), '[]'::jsonb),
      'payInSen', coalesce((select sum(mv.amount_sen) from mv where mv.kind = 'pay_in'), 0)::integer,
      'payOutSen', coalesce((select sum(mv.amount_sen) from mv where mv.kind = 'pay_out'), 0)::integer,
      'expectedSen', coalesce(s.expected_cash_sen, pos_shift_expected_cash(s.id)),
      'firstCountSen', s.first_count_sen,
      'firstVarianceSen', s.first_variance_sen,
      'countedSen', s.counted_cash_sen,
      'varianceSen', s.variance_sen,
      'varianceReason', s.variance_reason,
      'varianceApprovedBy', (select st.name from staff st where st.id = s.variance_approved_by)),
    'voids', jsonb_build_object(
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'at', to_char(vi.voided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                 'billNo', vi.bill_no, 'name', vi.name_snapshot, 'qty', vi.qty,
                 'valueSen', vi.unit_price_sen * vi.qty, 'reason', vi.void_reason,
                 'by', (select st.name from staff st where st.id = vi.voided_by),
                 'approvedBy', (select st.name from staff st where st.id = vi.void_approved_by))
               order by vi.voided_at, vi.id)
          from vi), '[]'::jsonb),
      'bills', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'at', to_char(vb.closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                 'billNo', vb.bill_no, 'reason', vb.void_reason,
                 'by', (select st.name from staff st where st.id = vb.closed_by),
                 'approvedBy', (select st.name from staff st where st.id = vb.void_approved_by))
               order by vb.closed_at, vb.id)
          from vb), '[]'::jsonb)),
    'refunds', coalesce((
      select jsonb_agg(jsonb_build_object(
               'at', to_char(rf.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'billNo', (select b.bill_no from bills b where b.id = rf.bill_id),
               'amountSen', rf.amount_sen, 'method', rf.method_name, 'reason', rf.reason,
               'approvedBy', (select st.name from staff st where st.id = rf.approved_by))
             order by rf.created_at, rf.id)
        from rf), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object('name', x.name, 'qty', x.qty, 'valueSen', x.value)
                       order by x.qty desc, x.value desc, x.name)
        from (select oi.name_snapshot as name, sum(oi.qty)::integer as qty, sum(oi.unit_price_sen * oi.qty)::integer as value
                from order_items oi
               where oi.bill_id in (select sb.id from sb) and oi.voided_at is null
               group by oi.name_snapshot) x), '[]'::jsonb))
  from s, t
$$;
revoke all on function pos_shift_report(uuid) from public, anon, authenticated;
