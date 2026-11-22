-- ============================================================================
-- Craft OS — MyInvois e-invoice W5, catch-up and automation (2026-11-23). Run on craft-os-dev after
-- migration-2026-11-18-pos-reports.sql and migration-2026-10-26-einvoice.sql (and the POS chain up to
-- migration-2026-11-22-pos-feedme-habits.sql). Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-11-23-einvoice-w5.md
-- Design: docs/superpowers/specs/2026-10-26-myinvois-einvoice-design.md (W5)
--
-- E1  pos_ledger_lines(bill ids): the sales ledger's lines with their SST share, for any set of paid bills;
--     pos_report_ledger re-created to read its lines from it (same output), so an e-invoice and
--     Reports → Ledger export agree to the sen.
-- E2  branches.einvoice_from (the outlet's start date) with its guard trigger and einvoice_set_outlet_start.
-- E3  einvoice_job_runs (one row per daily run) and einvoice_job_attempts (failures per outlet-month or refund).
-- E4  What a document is built from: einvoice_bill_lines, einvoice_bill_source (ledger lines),
--     einvoice_unlinked_paid_bills (business month, start date, RM 10,000 out), einvoice_large_bills (the
--     screen), einvoice_create_document (refuses bills before the start date).
-- E5  Refunds due a credit note: einvoice_pending_single_refunds, einvoice_pending_consolidated_refunds,
--     einvoice_consolidated_refund_months.
-- E6  einvoice_record_attempt; einvoice_reconcile_source (the reconciliation's input).
-- The daily job itself (pg_net, pg_cron) is migration-2026-11-23-einvoice-w5-cron.sql.
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_report_ledger(uuid[], date, date)') is null
     or to_regprocedure('einvoice_create_document(jsonb, uuid[], uuid[])') is null then
    raise exception 'STOP: run migration-2026-11-18-pos-reports.sql and migration-2026-10-26-einvoice.sql first (pos_report_ledger or einvoice_create_document is missing)';
  end if;
end $$;

-- ── E1. The sales ledger's lines, shared (spec W5.2) ────────────────────────
-- One row per live line of the given paid bills: pos_report_lines' figures (gross, catalog / item /
-- bill-share discount, net after discounts as frozen in bills.totals.lines; a bill without them: price ×
-- qty, no discount), the packaging fee of a takeaway line, the SST base (net + that fee), the rate it is
-- taxed at (its own rate when the bill has an SST group of that rate, else 0: a 0% line or an outlet not
-- registered) and its SST: its share of the group, by largest remainder on the SST base (floors first, the
-- sen left to the largest remainders, ties by order item id), so the lines add up to the group. Internal.
create or replace function pos_ledger_lines(p_bill_ids uuid[])
returns table (item_id uuid, bill_id uuid, branch_id uuid, bill_no text, bday date, name text, qty integer,
               unit_price_sen integer, sst_rate_bp integer, gross_sen integer, catalog_discount_sen integer,
               item_discount_sen integer, bill_share_sen integer, net_sen integer, takeaway_fee_sen integer,
               sst_base_sen integer, tax_rate_bp integer, sst_sen integer)
language sql stable security definer set search_path = public, pg_temp as $$
  with pb as (
    select b.* from bills b where b.id = any (p_bill_ids) and b.status = 'paid'),
  ln as (
    select oi.id as item_id, pb.id as bill_id, pb.branch_id, pb.bill_no, pos_business_day(pb.closed_at) as bday,
           oi.name_snapshot as name, oi.qty, oi.unit_price_sen, oi.sst_rate_bp,
           oi.unit_price_sen * oi.qty as gross_sen,
           coalesce((l.v->>'catalogDiscountSen')::integer, 0) as catalog_discount_sen,
           coalesce((l.v->>'itemDiscountSen')::integer, 0) as item_discount_sen,
           coalesce((l.v->>'billShareSen')::integer, 0) as bill_share_sen,
           coalesce((l.v->>'netSen')::integer, oi.unit_price_sen * oi.qty) as net_sen,
           case when coalesce(oi.order_type, pb.order_type) = 'takeaway' then oi.takeaway_fee_sen * oi.qty else 0 end
             as takeaway_fee_sen
      from pb
      join order_items oi on oi.bill_id = pb.id and oi.voided_at is null
      left join lateral (
        select x.v from jsonb_array_elements(coalesce(pb.totals->'lines', '[]'::jsonb)) as x(v)
         where x.v->>'id' = oi.id::text) l on true),
  grp as (
    select pb.id as bill_id, (g.v->>'rateBp')::integer as rate_bp, (g.v->>'amountSen')::bigint as amt
      from pb cross join jsonb_array_elements(coalesce(pb.totals->'sstGroups', '[]'::jsonb)) as g(v)),
  w as (
    select ln.*, ln.net_sen + ln.takeaway_fee_sen as sst_base_sen, grp.rate_bp as group_rate_bp,
           coalesce(grp.amt, 0) as amt,
           sum(ln.net_sen + ln.takeaway_fee_sen) over (partition by ln.bill_id, ln.sst_rate_bp) as base_total
      from ln
      left join grp on grp.bill_id = ln.bill_id and grp.rate_bp = ln.sst_rate_bp),
  fl as (
    select w.*,
           case when w.amt > 0 and w.base_total > 0 then (w.amt * w.sst_base_sen) / w.base_total else 0 end as floor_sst,
           case when w.amt > 0 and w.base_total > 0 then (w.amt * w.sst_base_sen) % w.base_total else 0 end as rem
      from w),
  shares as (
    select fl.*,
           fl.amt - sum(fl.floor_sst) over (partition by fl.bill_id, fl.sst_rate_bp) as left_over,
           row_number() over (partition by fl.bill_id, fl.sst_rate_bp order by fl.rem desc, fl.item_id) as rk
      from fl)
  select s.item_id, s.bill_id, s.branch_id, s.bill_no, s.bday, s.name, s.qty, s.unit_price_sen, s.sst_rate_bp,
         s.gross_sen, s.catalog_discount_sen, s.item_discount_sen, s.bill_share_sen, s.net_sen, s.takeaway_fee_sen,
         s.sst_base_sen,
         case when s.group_rate_bp > 0 then s.group_rate_bp else 0 end,
         (s.floor_sst + case when s.rk <= s.left_over then 1 else 0 end)::integer
    from shares s
$$;
revoke all on function pos_ledger_lines(uuid[]) from public, anon, authenticated;

-- pos_report_ledger: the live text of migration-2026-11-18-pos-reports.sql (R4) with its line CTEs (grp, w, fl,
-- shares) replaced by pos_ledger_lines. bills and payments unchanged; lines in the same order with the same keys.
create or replace function pos_report_ledger(p_branch_ids uuid[], p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s     record;
  v_out jsonb;
begin
  select * into s from pos_report_scope(p_branch_ids, p_from, p_to);
  if p_to - p_from + 1 > 92 then
    raise exception 'Export at most 92 days at a time.';
  end if;
  with pb as (select b.* from pos_report_paid_bills(p_branch_ids, s.start_at, s.end_at) b)
  select jsonb_build_object(
    'bills', coalesce((
      select jsonb_agg(jsonb_build_object(
               'outlet', br.name, 'businessDate', to_char(pos_business_day(pb.closed_at), 'YYYY-MM-DD'),
               'closedAt', to_char(pb.closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'billNo', pb.bill_no, 'orderType', pb.order_type, 'table', t.label, 'pax', pb.pax,
               'grossSen', coalesce((pb.totals->>'grossSen')::integer, pb.subtotal_sen),
               'discountSen', coalesce((pb.totals->>'catalogDiscountSen')::integer, 0)
                              + coalesce((pb.totals->>'itemDiscountSen')::integer, 0)
                              + coalesce((pb.totals->>'billDiscountSen')::integer, 0),
               'takeawayFeeSen', pb.takeaway_fee_sen, 'serviceChargeSen', pb.service_charge_sen,
               'sstSen', pb.sst_sen, 'roundingSen', pb.rounding_sen, 'totalSen', pb.total_sen,
               'refundedSen', pb.refunded_sen)
             order by pb.closed_at, pb.id)
        from pb
        join branches br on br.id = pb.branch_id
        left join dining_tables t on t.id = pb.table_id), '[]'::jsonb),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'outlet', br.name, 'billNo', x.bill_no, 'item', x.name, 'qty', x.qty, 'unitPriceSen', x.unit_price_sen,
               'catalogDiscountSen', x.catalog_discount_sen, 'itemDiscountSen', x.item_discount_sen,
               'billShareSen', x.bill_share_sen, 'netSen', x.net_sen, 'sstRateBp', x.sst_rate_bp,
               'sstSen', x.sst_sen)
             order by pb.closed_at, x.bill_id, x.item_id)
        from pos_ledger_lines(array(select pb.id from pb)) x
        join pb on pb.id = x.bill_id
        join branches br on br.id = x.branch_id), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'outlet', br.name, 'billNo', pb.bill_no, 'partNo', bp.part_no, 'method', p.method_name, 'kind', p.kind,
               'amountSen', p.amount_sen, 'tenderedSen', p.tendered_sen, 'changeSen', p.change_sen,
               'reference', p.reference,
               'takenAt', to_char(p.taken_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
             order by pb.closed_at, pb.id, p.taken_at, p.line_no, p.id)
        from payments p
        join pb on pb.id = p.bill_id
        join branches br on br.id = pb.branch_id
        left join bill_parts bp on bp.id = p.part_id), '[]'::jsonb))
    into v_out;
  return v_out;
end $$;
revoke all on function pos_report_ledger(uuid[], date, date) from public, anon;
grant execute on function pos_report_ledger(uuid[], date, date) to authenticated;

notify pgrst, 'reload schema';
select 'einvoice w5 applied' as result;
