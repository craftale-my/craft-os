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
