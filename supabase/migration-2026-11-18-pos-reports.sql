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

notify pgrst, 'reload schema';
select 'pos reports applied' as result;
