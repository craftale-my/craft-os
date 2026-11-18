-- ============================================================================
-- Craft OS — POS sales reports, W3 (2026-11-18). Run on craft-os-dev after
-- migration-2026-11-17-menu-picks.sql. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-11-18-pos-sales-reports.md
-- Design: docs/superpowers/specs/2026-11-18-pos-sales-reports-design.md
--
-- R1  pos_business_day: the business day of a time (06:00 to 05:59 the next morning, Malaysia time).
--     pos_report_scope: the caller manages every outlet asked for (pos_manages_outlet), the range is 1 to
--     366 whole business days; returns its UTC bounds [start_at, end_at). pos_report_paid_bills: the
--     sales of a scope (status 'paid', closed_at in the bounds). pos_report_cards: the Overview cards of
--     one period. Index pos_discount_log(branch_id, created_at).
-- R2  pos_report_sales: the cards of the range and of the period of the same length before it, daily,
--     hourly, the sales summary (the Z report's arithmetic), order types, sources, top 10 products.
-- R3  pos_report_lines: the live lines of the paid bills with their discounts and their net after
--     discounts (bills.totals.lines). pos_report_products, pos_report_payments, pos_report_sst.
-- R4  pos_report_audit (discounts set and cleared, voids, refunds), pos_report_drawer (one row per
--     shift), pos_report_ledger (bills, lines with their SST share, payments).
-- The reports read the totals frozen at checkout and never re-price. Refunds are listed apart and never
-- taken out of sales or SST. Every report is stable security definer, granted to authenticated only;
-- the helpers are internal.
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file; the reports never write).
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_picks_rules()') is null or to_regprocedure('pos_manages_outlet(uuid)') is null
     or to_regprocedure('pos_shift_expected_cash(uuid)') is null or to_regclass('public.bill_parts') is null then
    raise exception 'STOP: run migration-2026-11-17-menu-picks.sql first (pos_picks_rules, pos_manages_outlet, pos_shift_expected_cash or bill_parts is missing)';
  end if;
end $$;

-- ── R1. Index ───────────────────────────────────────────────────────────────
-- The Discounts tab reads the log by outlet and time. The paid bills already have theirs
-- (bills_branch_paid_closed_idx, migration-2026-11-17-menu-picks.sql).
create index if not exists pos_discount_log_branch_created_idx on pos_discount_log(branch_id, created_at);

-- ── R1. The business day, the scope, the sales of a scope ───────────────────
-- 06:00 to 05:59 the next morning, Malaysia time: a bill closed at 01:30 belongs to the day before.
create or replace function pos_business_day(p_at timestamptz) returns date
language sql immutable security definer set search_path = public, pg_temp as $$
  select ((p_at at time zone 'Asia/Kuala_Lumpur') - interval '6 hours')::date
$$;
revoke all on function pos_business_day(timestamptz) from public, anon, authenticated;

-- Every report starts here: the outlets asked for are all the caller's (a Craft OS back-office login
-- with access_settings and the outlet in its scope; a tablet's session is not one), the range is whole
-- business days, from <= to, at most 366 days. Returns the UTC bounds, end exclusive.
create or replace function pos_report_scope(p_branch_ids uuid[], p_from date, p_to date,
                                            out start_at timestamptz, out end_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if p_branch_ids is null or cardinality(p_branch_ids) = 0 then
    raise exception 'Choose at least one outlet.';
  end if;
  if p_from is null or p_to is null then
    raise exception 'Choose a valid date range.';
  end if;
  if p_from > p_to then
    raise exception 'The start date is after the end date.';
  end if;
  if p_to - p_from + 1 > 366 then
    raise exception 'Choose at most 366 days.';
  end if;
  foreach v_id in array p_branch_ids loop
    if v_id is null or not pos_manages_outlet(v_id) then
      raise exception 'You cannot see reports for this outlet.';
    end if;
  end loop;
  start_at := (p_from + time '06:00') at time zone 'Asia/Kuala_Lumpur';
  end_at   := (p_to + 1 + time '06:00') at time zone 'Asia/Kuala_Lumpur';
end $$;
revoke all on function pos_report_scope(uuid[], date, date) from public, anon, authenticated;

-- The sales: paid bills (a split part is its own paid bill; voided and merged bills are not sales)
-- closed inside the bounds. Uses bills_branch_paid_closed_idx.
create or replace function pos_report_paid_bills(p_branch_ids uuid[], p_start timestamptz, p_end timestamptz)
returns setof bills
language sql stable security definer set search_path = public, pg_temp as $$
  select b.* from bills b
   where b.branch_id = any (p_branch_ids) and b.status = 'paid'
     and b.closed_at >= p_start and b.closed_at < p_end
$$;
revoke all on function pos_report_paid_bills(uuid[], timestamptz, timestamptz) from public, anon, authenticated;

-- The Overview cards of one period (spec §5.1). Voids: items voided in the period (a voided bill's
-- items are voided with it); refunds by their own time, never taken off the sales.
create or replace function pos_report_cards(p_branch_ids uuid[], p_start timestamptz, p_end timestamptz) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'nettSen', coalesce(sum(b.total_sen), 0),
    'bills', count(*)::integer,
    'pax', coalesce(sum(b.pax), 0)::integer,
    'discountSen', coalesce(sum(coalesce((b.totals->>'catalogDiscountSen')::integer, 0)
                                + coalesce((b.totals->>'itemDiscountSen')::integer, 0)
                                + coalesce((b.totals->>'billDiscountSen')::integer, 0)), 0),
    'voidSen', (select coalesce(sum(oi.unit_price_sen * oi.qty), 0)
                  from order_items oi join bills vb on vb.id = oi.bill_id
                 where vb.branch_id = any (p_branch_ids) and oi.voided_at >= p_start and oi.voided_at < p_end),
    'refundSen', (select coalesce(sum(r.amount_sen), 0)
                    from refunds r
                   where r.branch_id = any (p_branch_ids) and r.created_at >= p_start and r.created_at < p_end))
    from pos_report_paid_bills(p_branch_ids, p_start, p_end) b
$$;
revoke all on function pos_report_cards(uuid[], timestamptz, timestamptz) from public, anon, authenticated;

-- ── R2. Sales: Overview, Sales summary, Daily and Hourly sales (spec §5.1–5.4) ─
-- previous = the period of the same length just before (Malaysia has no daylight saving, so the bounds
-- shift by whole days). The summary is pos_shift_report's arithmetic (migration-2026-11-17-pos-bill-parts.sql
-- B6): before discounts = totals.grossSen (subtotal for an old bill), gross = subtotal − bill discount.
create or replace function pos_report_sales(p_branch_ids uuid[], p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s     record;
  v_out jsonb;
begin
  select * into s from pos_report_scope(p_branch_ids, p_from, p_to);
  with pb as (
    select b.*, pos_business_day(b.closed_at) as bday,
           coalesce((b.totals->>'grossSen')::integer, b.subtotal_sen) as before_disc,
           coalesce((b.totals->>'catalogDiscountSen')::integer, 0) as cat_disc,
           coalesce((b.totals->>'itemDiscountSen')::integer, 0) as item_disc,
           coalesce((b.totals->>'billDiscountSen')::integer, 0) as bill_disc
      from pos_report_paid_bills(p_branch_ids, s.start_at, s.end_at) b),
  rf as (                                             -- refunds per outlet and business day of their own time
    select r.branch_id, pos_business_day(r.created_at) as bday, sum(r.amount_sen) as refund
      from refunds r
     where r.branch_id = any (p_branch_ids) and r.created_at >= s.start_at and r.created_at < s.end_at
     group by r.branch_id, pos_business_day(r.created_at)),
  bd as (                                             -- sales per outlet and business day
    select pb.branch_id, pb.bday, count(*)::integer as bills, coalesce(sum(pb.pax), 0)::integer as pax,
           sum(pb.before_disc) as gross, sum(pb.cat_disc + pb.item_disc + pb.bill_disc) as disc,
           sum(pb.takeaway_fee_sen) as fee, sum(pb.service_charge_sen) as sc, sum(pb.sst_sen) as sst,
           sum(pb.rounding_sen) as rounding, sum(pb.total_sen) as nett
      from pb
     group by pb.branch_id, pb.bday),
  days as (                                           -- an outlet-day with a sale or a refund
    select coalesce(bd.branch_id, rf.branch_id) as branch_id, coalesce(bd.bday, rf.bday) as bday,
           coalesce(bd.bills, 0) as bills, coalesce(bd.pax, 0) as pax, coalesce(bd.gross, 0) as gross,
           coalesce(bd.disc, 0) as disc, coalesce(bd.fee, 0) as fee, coalesce(bd.sc, 0) as sc,
           coalesce(bd.sst, 0) as sst, coalesce(bd.rounding, 0) as rounding, coalesce(bd.nett, 0) as nett,
           coalesce(rf.refund, 0) as refund
      from bd
      full join rf on rf.branch_id = bd.branch_id and rf.bday = bd.bday),
  hours as (                                          -- 0–23, the Malaysia hour of closed_at
    select h.hr, count(pb.id)::integer as bills, coalesce(sum(pb.total_sen), 0) as nett
      from generate_series(0, 23) as h(hr)
      left join pb on extract(hour from pb.closed_at at time zone 'Asia/Kuala_Lumpur')::integer = h.hr
     group by h.hr),
  best as (                                           -- top 10 products by quantity, today's name
    select coalesce(min(p.name), min(oi.name_snapshot)) as name, sum(oi.qty)::integer as qty,
           sum(oi.unit_price_sen * oi.qty) as val
      from order_items oi
      join pb on pb.id = oi.bill_id
      left join menu_products p on p.id = oi.product_id
     where oi.voided_at is null
     group by coalesce(oi.product_id::text, oi.name_snapshot)
     order by qty desc, val desc, name
     limit 10)
  select jsonb_build_object(
    'current', pos_report_cards(p_branch_ids, s.start_at, s.end_at),
    'previous', pos_report_cards(p_branch_ids, s.start_at - (s.end_at - s.start_at), s.start_at),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object(
               'branchId', d.branch_id, 'outlet', br.name, 'day', to_char(d.bday, 'YYYY-MM-DD'),
               'bills', d.bills, 'pax', d.pax, 'grossSen', d.gross, 'discountSen', d.disc, 'takeawayFeeSen', d.fee,
               'serviceChargeSen', d.sc, 'sstSen', d.sst, 'roundingSen', d.rounding, 'nettSen', d.nett,
               'refundSen', d.refund)
             order by d.bday, br.name, d.branch_id)
        from days d join branches br on br.id = d.branch_id), '[]'::jsonb),
    'hourly', (select jsonb_agg(jsonb_build_object('hour', x.hr, 'bills', x.bills, 'nettSen', x.nett) order by x.hr)
                 from hours x),
    'summary', (
      select jsonb_build_object(
               'beforeDiscountsSen', coalesce(sum(pb.before_disc), 0),
               'catalogDiscountSen', coalesce(sum(pb.cat_disc), 0),
               'itemDiscountSen', coalesce(sum(pb.item_disc), 0),
               'billDiscountSen', coalesce(sum(pb.bill_disc), 0),
               'grossSen', coalesce(sum(pb.subtotal_sen - pb.bill_disc), 0),
               'takeawayFeeSen', coalesce(sum(pb.takeaway_fee_sen), 0),
               'serviceChargeSen', coalesce(sum(pb.service_charge_sen), 0),
               'sstSen', coalesce(sum(pb.sst_sen), 0),
               'roundingSen', coalesce(sum(pb.rounding_sen), 0),
               'nettSen', coalesce(sum(pb.total_sen), 0))
        from pb),
    'orderTypes', (
      select jsonb_agg(jsonb_build_object(
               'orderType', x.ot,
               'bills', (select count(*)::integer from pb where pb.order_type = x.ot),
               'nettSen', (select coalesce(sum(pb.total_sen), 0) from pb where pb.order_type = x.ot))
             order by x.ord)
        from (values ('dine_in', 1), ('takeaway', 2)) as x(ot, ord)),
    'sources', (
      select jsonb_agg(jsonb_build_object(
               'source', x.src,
               'orders', (select count(distinct oi.order_id)::integer
                            from order_items oi join orders o on o.id = oi.order_id
                           where oi.bill_id in (select pb.id from pb) and o.source = x.src),
               'itemSen', (select coalesce(sum(oi.unit_price_sen * oi.qty), 0)
                             from order_items oi join orders o on o.id = oi.order_id
                            where oi.bill_id in (select pb.id from pb) and o.source = x.src and oi.voided_at is null))
             order by x.ord)
        from (values ('counter', 1), ('qr', 2)) as x(src, ord)),
    'topProducts', coalesce((
      select jsonb_agg(jsonb_build_object('name', t.name, 'qty', t.qty, 'valueSen', t.val)
                       order by t.qty desc, t.val desc, t.name)
        from best t), '[]'::jsonb))
    into v_out;
  return v_out;
end $$;
revoke all on function pos_report_sales(uuid[], date, date) from public, anon;
grant execute on function pos_report_sales(uuid[], date, date) to authenticated;

-- ── R3. The lines of the sales (spec §4) ────────────────────────────────────
-- One row per live line of the paid bills in the bounds, with its discounts and its net after discounts
-- as frozen in bills.totals.lines (a bill without them: price × qty, no discount). sst_base_sen is what
-- its SST was charged on: the net, plus a takeaway line's fee (pos_compute_bill). Internal.
create or replace function pos_report_lines(p_branch_ids uuid[], p_start timestamptz, p_end timestamptz)
returns table (item_id uuid, bill_id uuid, branch_id uuid, bill_no text, bday date, order_id uuid, product_id uuid,
               name text, qty integer, unit_price_sen integer, sst_rate_bp integer, modifiers jsonb,
               gross_sen integer, catalog_discount_sen integer, item_discount_sen integer, bill_share_sen integer,
               net_sen integer, sst_base_sen integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select oi.id, b.id, b.branch_id, b.bill_no, pos_business_day(b.closed_at), oi.order_id, oi.product_id,
         oi.name_snapshot, oi.qty, oi.unit_price_sen, oi.sst_rate_bp, oi.modifiers_snapshot,
         oi.unit_price_sen * oi.qty,
         coalesce((l.v->>'catalogDiscountSen')::integer, 0),
         coalesce((l.v->>'itemDiscountSen')::integer, 0),
         coalesce((l.v->>'billShareSen')::integer, 0),
         coalesce((l.v->>'netSen')::integer, oi.unit_price_sen * oi.qty),
         coalesce((l.v->>'netSen')::integer, oi.unit_price_sen * oi.qty)
           + case when coalesce(oi.order_type, b.order_type) = 'takeaway' then oi.takeaway_fee_sen * oi.qty else 0 end
    from pos_report_paid_bills(p_branch_ids, p_start, p_end) b
    join order_items oi on oi.bill_id = b.id and oi.voided_at is null
    left join lateral (
      select x.v from jsonb_array_elements(coalesce(b.totals->'lines', '[]'::jsonb)) as x(v)
       where x.v->>'id' = oi.id::text) l on true
$$;
revoke all on function pos_report_lines(uuid[], timestamptz, timestamptz) from public, anon, authenticated;

-- ── R3. Products, add-ons and categories (spec §5.5) ────────────────────────
-- Per product (today's name and category): quantity, gross (price × qty), discounts (gross − net), net.
-- Add-ons: per option name on the lines, count = units, value = priceDeltaSen × qty.
create or replace function pos_report_products(p_branch_ids uuid[], p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s     record;
  v_out jsonb;
begin
  select * into s from pos_report_scope(p_branch_ids, p_from, p_to);
  with ln as (
    select x.*, p.name as product_name, c.id as category_id, c.name as category
      from pos_report_lines(p_branch_ids, s.start_at, s.end_at) x
      left join menu_products p on p.id = x.product_id
      left join menu_categories c on c.id = p.category_id),
  per_product as (
    select coalesce(min(ln.product_name), min(ln.name)) as name, min(ln.category) as category,
           sum(ln.qty)::integer as qty, sum(ln.gross_sen) as gross, sum(ln.net_sen) as net
      from ln
     group by coalesce(ln.product_id::text, ln.name)),
  add_ons as (
    select coalesce(m.v->>'name', 'Add-on') as name, sum(ln.qty)::integer as n,
           sum(coalesce((m.v->>'priceDeltaSen')::integer, 0) * ln.qty) as val
      from ln
      cross join jsonb_array_elements(coalesce(ln.modifiers, '[]'::jsonb)) as m(v)
     group by coalesce(m.v->>'name', 'Add-on')),
  per_category as (
    select min(ln.category) as category, sum(ln.qty)::integer as qty, sum(ln.net_sen) as net
      from ln
     group by ln.category_id)
  select jsonb_build_object(
    'products', coalesce((
      select jsonb_agg(jsonb_build_object('name', x.name, 'category', x.category, 'qty', x.qty, 'grossSen', x.gross,
                                          'discountSen', x.gross - x.net, 'netSen', x.net)
                       order by x.qty desc, x.net desc, x.name)
        from per_product x), '[]'::jsonb),
    'addOns', coalesce((
      select jsonb_agg(jsonb_build_object('name', x.name, 'count', x.n, 'valueSen', x.val)
                       order by x.n desc, x.val desc, x.name)
        from add_ons x), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('category', x.category, 'qty', x.qty, 'netSen', x.net)
                       order by x.net desc, x.category nulls last)
        from per_category x), '[]'::jsonb))
    into v_out;
  return v_out;
end $$;
revoke all on function pos_report_products(uuid[], date, date) from public, anon;
grant execute on function pos_report_products(uuid[], date, date) to authenticated;

-- ── R3. Payments (spec §5.6) ────────────────────────────────────────────────
-- The payments of the bills sold in the range (a part payment is a payment like any other), so the total
-- equals Nett sales; refunds by their own time. Methods by name and kind across outlets.
create or replace function pos_report_payments(p_branch_ids uuid[], p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s     record;
  v_out jsonb;
begin
  select * into s from pos_report_scope(p_branch_ids, p_from, p_to);
  with pm as (
    select p.method_name as name, p.kind, count(*)::integer as n, sum(p.amount_sen) as amt
      from payments p
      join pos_report_paid_bills(p_branch_ids, s.start_at, s.end_at) b on b.id = p.bill_id
     group by p.method_name, p.kind),
  rm as (
    select r.method_name as name, coalesce(r.kind, 'other') as kind, count(*)::integer as n, sum(r.amount_sen) as amt
      from refunds r
     where r.branch_id = any (p_branch_ids) and r.created_at >= s.start_at and r.created_at < s.end_at
     group by r.method_name, coalesce(r.kind, 'other'))
  select jsonb_build_object('methods', coalesce((
    select jsonb_agg(jsonb_build_object(
             'name', coalesce(pm.name, rm.name), 'kind', coalesce(pm.kind, rm.kind),
             'count', coalesce(pm.n, 0), 'amountSen', coalesce(pm.amt, 0),
             'refundCount', coalesce(rm.n, 0), 'refundSen', coalesce(rm.amt, 0),
             'netSen', coalesce(pm.amt, 0) - coalesce(rm.amt, 0))
           order by coalesce(pm.name, rm.name), coalesce(pm.kind, rm.kind))
      from pm full join rm on rm.name = pm.name and rm.kind = pm.kind), '[]'::jsonb))
    into v_out;
  return v_out;
end $$;
revoke all on function pos_report_payments(uuid[], date, date) from public, anon;
grant execute on function pos_report_payments(uuid[], date, date) to authenticated;

-- ── R3. SST (spec §5.7) ─────────────────────────────────────────────────────
-- Per rate: taxable base and SST from the bills' totals.sstGroups (as charged; service charge carries no
-- SST). Exempt: the net of the 0% lines. Then one row per month of the business days (SST-02).
create or replace function pos_report_sst(p_branch_ids uuid[], p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s     record;
  v_out jsonb;
begin
  select * into s from pos_report_scope(p_branch_ids, p_from, p_to);
  with grp as (
    select to_char(pos_business_day(b.closed_at), 'YYYY-MM') as ym, (g.v->>'rateBp')::integer as rate_bp,
           (g.v->>'baseSen')::bigint as base, (g.v->>'amountSen')::bigint as amt
      from pos_report_paid_bills(p_branch_ids, s.start_at, s.end_at) b
      cross join jsonb_array_elements(coalesce(b.totals->'sstGroups', '[]'::jsonb)) as g(v)),
  ex as (
    select to_char(ln.bday, 'YYYY-MM') as ym, sum(ln.net_sen) as exempt
      from pos_report_lines(p_branch_ids, s.start_at, s.end_at) ln
     where ln.sst_rate_bp = 0
     group by to_char(ln.bday, 'YYYY-MM')),
  months as (select grp.ym from grp union select ex.ym from ex)
  select jsonb_build_object(
    'rates', coalesce((
      select jsonb_agg(jsonb_build_object('rateBp', x.rate_bp, 'baseSen', x.base, 'sstSen', x.amt) order by x.rate_bp)
        from (select grp.rate_bp, sum(grp.base) as base, sum(grp.amt) as amt from grp group by grp.rate_bp) x), '[]'::jsonb),
    'exemptSen', coalesce((select sum(ex.exempt) from ex), 0),
    'months', coalesce((
      select jsonb_agg(jsonb_build_object(
               'month', m.ym,
               'rates', coalesce((
                 select jsonb_agg(jsonb_build_object('rateBp', x.rate_bp, 'baseSen', x.base, 'sstSen', x.amt) order by x.rate_bp)
                   from (select grp.rate_bp, sum(grp.base) as base, sum(grp.amt) as amt
                           from grp where grp.ym = m.ym group by grp.rate_bp) x), '[]'::jsonb),
               'exemptSen', coalesce((select ex.exempt from ex where ex.ym = m.ym), 0))
             order by m.ym)
        from months m), '[]'::jsonb))
    into v_out;
  return v_out;
end $$;
revoke all on function pos_report_sst(uuid[], date, date) from public, anon;
grant execute on function pos_report_sst(uuid[], date, date) to authenticated;

notify pgrst, 'reload schema';
select 'pos reports applied' as result;
