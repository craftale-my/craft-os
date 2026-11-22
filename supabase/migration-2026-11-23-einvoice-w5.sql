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

-- ── E2. The outlet's start date (spec W5.3) ──────────────────────────────────
-- einvoice_from: the first business day we report for the outlet; null = we do not report it (Feedme still
-- does). Only HQ (all_branches + access_settings, as for an outlet's kind and dates) changes it — no signed-in
-- user (the SQL editor, the service role) passes. Free to set or move later; moving it earlier or clearing it
-- is refused once the outlet has a live document (draft, submitted or valid).
alter table branches add column if not exists einvoice_from date;

create or replace function branches_einvoice_from_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.einvoice_from is not distinct from old.einvoice_from then
    return new;
  end if;
  if auth.uid() is not null and not (has_menu_cap('all_branches') and has_menu_cap('access_settings')) then
    raise exception 'Only HQ can change when an outlet''s e-invoices start.';
  end if;
  if old.einvoice_from is not null
     and (new.einvoice_from is null or new.einvoice_from < old.einvoice_from)
     and exists (select 1 from einvoice_documents d
                  where d.branch_id = new.id and d.status in ('draft', 'submitted', 'valid')) then
    raise exception 'E-invoices were already sent for this outlet: the start date can only move later.';
  end if;
  return new;
end $$;
revoke all on function branches_einvoice_from_guard() from public, anon, authenticated;
drop trigger if exists branches_einvoice_from_guard on branches;
create trigger branches_einvoice_from_guard before update of einvoice_from on branches
  for each row execute function branches_einvoice_from_guard();

-- The E-invoice screen's "Report e-invoices from" (null clears it). The trigger above holds the rules.
create or replace function einvoice_set_outlet_start(p_branch_id uuid, p_from date) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not (has_menu_cap('all_branches') and has_menu_cap('access_settings')) then
    raise exception 'Only HQ can change when an outlet''s e-invoices start.';
  end if;
  update branches set einvoice_from = p_from where id = p_branch_id;
  if not found then
    raise exception 'Outlet not found';
  end if;
  return jsonb_build_object('ok', true, 'branchId', p_branch_id, 'einvoiceFrom', p_from);
end $$;
revoke all on function einvoice_set_outlet_start(uuid, date) from public, anon;
grant execute on function einvoice_set_outlet_start(uuid, date) to authenticated;

-- ── E3. The daily job's bookkeeping (spec W5.4) ──────────────────────────────
-- One row per run (written by the Edge Function's `run`), and one row per thing that can fail repeatedly:
-- CON|<outlet>|YYYY-MM (a month's consolidated invoice), CCN|<outlet>|YYYY-MM (its consolidated credit note),
-- CN|<refund id> (a single credit note). At 3 failures the run skips the key and the banner shows it.
create table if not exists einvoice_job_runs (
  id           uuid primary key default gen_random_uuid(),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  environment  text not null check (environment in ('sandbox', 'production')),
  outcome      text not null check (outcome in ('not_set_up', 'ok', 'errors')),
  report       jsonb not null default '{}'::jsonb
);
create index if not exists einvoice_job_runs_started_idx on einvoice_job_runs(started_at desc);

create table if not exists einvoice_job_attempts (
  key           text primary key,
  kind          text not null check (kind in ('consolidated_invoice', 'consolidated_credit_note', 'credit_note')),
  branch_id     uuid not null references branches(id),
  period_start  date,
  refund_id     uuid references refunds(id),
  failures      integer not null default 0 check (failures >= 0),
  last_error    text,
  updated_at    timestamptz not null default now()
);
create index if not exists einvoice_job_attempts_failing_idx on einvoice_job_attempts(failures) where failures > 0;

do $$
declare t text;
begin
  foreach t in array array['einvoice_job_runs', 'einvoice_job_attempts']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists einvoice_read on %I', t);
    execute format('create policy einvoice_read on %I for select to authenticated using (has_menu_cap(''access_settings''))', t);
  end loop;
end $$;

-- ── E4. What a document is built from (spec W5.2, W5.3, W5.6) ────────────────
-- The ledger lines of some bills as JSON, one array per bill, in order item id order. Internal.
create or replace function einvoice_bill_lines(p_bill_ids uuid[]) returns table (bill_id uuid, lines jsonb)
language sql stable security definer set search_path = public, pg_temp as $$
  select x.bill_id,
         jsonb_agg(jsonb_build_object(
           'itemId', x.item_id, 'name', x.name, 'qty', x.qty, 'unitPriceSen', x.unit_price_sen, 'grossSen', x.gross_sen,
           'catalogDiscountSen', x.catalog_discount_sen, 'itemDiscountSen', x.item_discount_sen,
           'billShareSen', x.bill_share_sen, 'netSen', x.net_sen, 'takeawayFeeSen', x.takeaway_fee_sen,
           'sstBaseSen', x.sst_base_sen, 'taxRateBp', x.tax_rate_bp, 'sstSen', x.sst_sen) order by x.item_id)
    from pos_ledger_lines(p_bill_ids) x
   group by x.bill_id
$$;
revoke all on function einvoice_bill_lines(uuid[]) from public, anon, authenticated;

-- One bill as the single-invoice builder needs it: the totals frozen at checkout (never re-priced; null on a bill
-- that has none, which the builder refuses), the ledger lines, the business day and the outlet's start date.
create or replace function einvoice_bill_source(p_bill_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'bill', jsonb_build_object('id', b.id, 'branchId', b.branch_id, 'billNo', b.bill_no, 'status', b.status,
                               'closedAt', b.closed_at, 'businessDay', pos_business_day(b.closed_at),
                               'totalSen', b.total_sen, 'refundedSen', b.refunded_sen, 'einvoiceFrom', br.einvoice_from),
    'totals', b.totals,
    'lines', coalesce((select l.lines from einvoice_bill_lines(array[b.id]) l), '[]'::jsonb))
  from bills b
  join branches br on br.id = b.branch_id
  where b.id = p_bill_id
$$;
revoke all on function einvoice_bill_source(uuid) from public, anon, authenticated;
grant execute on function einvoice_bill_source(uuid) to service_role;

-- An outlet's paid bills of one business month (p_month: any day in it) still to consolidate: on or after the
-- outlet's start date (none without one), at most RM 10,000, in no live document. day = the business day.
create or replace function einvoice_unlinked_paid_bills(p_branch_id uuid, p_month date)
returns table (id uuid, bill_no text, day date, totals jsonb, total_sen integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select b.id, b.bill_no, pos_business_day(b.closed_at), b.totals, b.total_sen
    from bills b
    join branches br on br.id = b.branch_id
   where b.branch_id = p_branch_id
     and b.status = 'paid'
     and br.einvoice_from is not null
     and b.closed_at >= (greatest(date_trunc('month', p_month::timestamp)::date, br.einvoice_from) + time '06:00')
                        at time zone 'Asia/Kuala_Lumpur'
     and b.closed_at <  ((date_trunc('month', p_month::timestamp) + interval '1 month')::date + time '06:00')
                        at time zone 'Asia/Kuala_Lumpur'
     and b.total_sen <= 1000000
     and not exists (select 1 from einvoice_bill_links l where l.bill_id = b.id)
   order by b.closed_at, b.bill_no
$$;
revoke all on function einvoice_unlinked_paid_bills(uuid, date) from public, anon, authenticated;
grant execute on function einvoice_unlinked_paid_bills(uuid, date) to service_role;

-- The screen's "Bills over RM 10,000": paid, on or after their outlet's start date, in no live document.
-- Nothing for a caller without access_settings.
create or replace function einvoice_large_bills()
returns table (id uuid, branch_id uuid, bill_no text, day date, total_sen integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select b.id, b.branch_id, b.bill_no, pos_business_day(b.closed_at), b.total_sen
    from bills b
    join branches br on br.id = b.branch_id
   where has_menu_cap('access_settings')
     and b.status = 'paid'
     and b.total_sen > 1000000
     and br.einvoice_from is not null
     and pos_business_day(b.closed_at) >= br.einvoice_from
     and not exists (select 1 from einvoice_bill_links l where l.bill_id = b.id)
   order by b.closed_at
$$;
revoke all on function einvoice_large_bills() from public, anon;
grant execute on function einvoice_large_bills() to authenticated;

-- einvoice_create_document: the live text of migration-2026-10-26-einvoice.sql with the guard marked W5 added:
-- every bill it claims, and the bill of every refund, is paid, of the document's outlet and on or after the
-- outlet's start date.
create or replace function einvoice_create_document(p_doc jsonb, p_bill_ids uuid[], p_refund_ids uuid[])
returns einvoice_documents
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id   uuid := gen_random_uuid();
  v_kind text := p_doc->>'kind';
  v_row  einvoice_documents;
begin
  if exists (                                                                                     -- W5
    select 1
      from bills b
      join branches br on br.id = b.branch_id
     where (b.id = any (coalesce(p_bill_ids, '{}'))
            or b.id in (select r.bill_id from refunds r where r.id = any (coalesce(p_refund_ids, '{}'))))
       and (b.branch_id <> (p_doc->>'branchId')::uuid or b.status <> 'paid' or br.einvoice_from is null
            or pos_business_day(b.closed_at) < br.einvoice_from)) then
    raise exception 'A bill in this document is not reported by us (another outlet, not paid, or before the outlet''s e-invoice start date)';
  end if;

  insert into einvoice_documents (id, kind, environment, branch_id, code_number, bill_id,
                                  period_start, period_end, buyer, total_sen, created_by)
  values (v_id, v_kind, p_doc->>'environment', (p_doc->>'branchId')::uuid,
          case v_kind when 'invoice' then 'INV' when 'credit_note' then 'CN'
                      when 'consolidated_invoice' then 'CON' else 'CCN' end
            || '-' || to_char(now() at time zone 'Asia/Kuala_Lumpur', 'YYMMDD')
            || '-' || upper(substr(replace(v_id::text, '-', ''), 1, 6)),
          (p_doc->>'billId')::uuid, (p_doc->>'periodStart')::date, (p_doc->>'periodEnd')::date,
          case when jsonb_typeof(p_doc->'buyer') = 'object' then p_doc->'buyer' end,
          (p_doc->>'totalSen')::integer, (p_doc->>'createdBy')::uuid)
  returning * into v_row;

  begin
    insert into einvoice_bill_links (bill_id, document_id)
    select unnest(coalesce(p_bill_ids, '{}')), v_id;
    insert into einvoice_refund_links (refund_id, document_id)
    select unnest(coalesce(p_refund_ids, '{}')), v_id;
  exception when unique_violation then
    raise exception 'A bill or refund in this document already has a live e-invoice';
  end;
  return v_row;
end $$;
revoke all on function einvoice_create_document(jsonb, uuid[], uuid[]) from public, anon, authenticated;
grant execute on function einvoice_create_document(jsonb, uuid[], uuid[]) to service_role;

-- ── E5. Refunds due a credit note (spec W5.5) ────────────────────────────────
-- A refund is due once its bill sits in a VALID document (the credit note quotes its LHDN UUID) and the refund
-- is in no live credit note. A refund of a bill not reported yet waits; a bill before the start date is never
-- reported, so its refunds never come up. refund_day = the refund's own business day.
create or replace function einvoice_pending_single_refunds()
returns table (refund_id uuid, bill_id uuid, branch_id uuid, bill_no text, amount_sen integer, refund_day date,
               totals jsonb, invoice_code text, invoice_uuid text, invoice_buyer jsonb)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.id, b.id, b.branch_id, b.bill_no, r.amount_sen, pos_business_day(r.created_at), b.totals,
         d.code_number, d.lhdn_uuid, d.buyer
    from refunds r
    join bills b on b.id = r.bill_id
    join einvoice_bill_links l on l.bill_id = b.id
    join einvoice_documents d on d.id = l.document_id and d.kind = 'invoice' and d.status = 'valid'
   where not exists (select 1 from einvoice_refund_links rl where rl.refund_id = r.id)
   order by r.created_at, r.id
$$;
revoke all on function einvoice_pending_single_refunds() from public, anon, authenticated;
grant execute on function einvoice_pending_single_refunds() to service_role;

-- An outlet's refunds of one business month (p_month: any day in it) whose bills sit in valid consolidated invoices.
create or replace function einvoice_pending_consolidated_refunds(p_branch_id uuid, p_month date)
returns table (refund_id uuid, bill_id uuid, branch_id uuid, bill_no text, amount_sen integer, refund_day date,
               totals jsonb, invoice_code text, invoice_uuid text, invoice_buyer jsonb)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.id, b.id, b.branch_id, b.bill_no, r.amount_sen, pos_business_day(r.created_at), b.totals,
         d.code_number, d.lhdn_uuid, d.buyer
    from refunds r
    join bills b on b.id = r.bill_id
    join einvoice_bill_links l on l.bill_id = b.id
    join einvoice_documents d on d.id = l.document_id and d.kind = 'consolidated_invoice' and d.status = 'valid'
   where b.branch_id = p_branch_id
     and pos_business_day(r.created_at) >= date_trunc('month', p_month::timestamp)::date
     and pos_business_day(r.created_at) <  (date_trunc('month', p_month::timestamp) + interval '1 month')::date
     and not exists (select 1 from einvoice_refund_links rl where rl.refund_id = r.id)
   order by r.created_at, r.id
$$;
revoke all on function einvoice_pending_consolidated_refunds(uuid, date) from public, anon, authenticated;
grant execute on function einvoice_pending_consolidated_refunds(uuid, date) to service_role;

-- The outlet-months (month = its first day) that have consolidated refunds due, before p_before (the first day
-- of the current business month: a month's refunds are credited after it ends).
create or replace function einvoice_consolidated_refund_months(p_before date)
returns table (branch_id uuid, month date)
language sql stable security definer set search_path = public, pg_temp as $$
  select distinct b.branch_id, date_trunc('month', pos_business_day(r.created_at)::timestamp)::date
    from refunds r
    join bills b on b.id = r.bill_id
    join einvoice_bill_links l on l.bill_id = b.id
    join einvoice_documents d on d.id = l.document_id and d.kind = 'consolidated_invoice' and d.status = 'valid'
   where pos_business_day(r.created_at) < p_before
     and not exists (select 1 from einvoice_refund_links rl where rl.refund_id = r.id)
   order by 2, 1
$$;
revoke all on function einvoice_consolidated_refund_months(date) from public, anon, authenticated;
grant execute on function einvoice_consolidated_refund_months(date) to service_role;

-- ── E6. Attempts and the reconciliation's input (spec W5.4, W5.9) ────────────
-- One more failure, or (p_ok) back to none. Returns the failures after the call.
create or replace function einvoice_record_attempt(p_key text, p_kind text, p_branch_id uuid, p_period_start date,
                                                   p_refund_id uuid, p_ok boolean, p_error text) returns integer
language sql security definer set search_path = public, pg_temp as $$
  insert into einvoice_job_attempts as a (key, kind, branch_id, period_start, refund_id, failures, last_error, updated_at)
  values (p_key, p_kind, p_branch_id, p_period_start, p_refund_id,
          case when p_ok then 0 else 1 end, case when p_ok then null else left(p_error, 1000) end, now())
  on conflict (key) do update
    set failures   = case when p_ok then 0 else a.failures + 1 end,
        last_error = case when p_ok then null else left(p_error, 1000) end,
        updated_at = now()
  returning failures
$$;
revoke all on function einvoice_record_attempt(text, text, uuid, date, uuid, boolean, text) from public, anon, authenticated;
grant execute on function einvoice_record_attempt(text, text, uuid, date, uuid, boolean, text) to service_role;

-- Every paid bill of the business days p_from..p_to with its ledger lines, and Reports → Overview's nett for each
-- outlet and business month those bills fall in (pos_report_cards over the whole month). Read only.
create or replace function einvoice_reconcile_source(p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with pb as (
    select b.* from bills b
     where b.status = 'paid'
       and b.closed_at >= (p_from + time '06:00') at time zone 'Asia/Kuala_Lumpur'
       and b.closed_at <  (p_to + 1 + time '06:00') at time zone 'Asia/Kuala_Lumpur'),
  bl as (select * from einvoice_bill_lines(array(select pb.id from pb))),
  m as (select distinct pb.branch_id, date_trunc('month', pos_business_day(pb.closed_at)::timestamp)::date as first_day
          from pb)
  select jsonb_build_object(
    'bills', coalesce((
      select jsonb_agg(jsonb_build_object('id', pb.id, 'branchId', pb.branch_id, 'billNo', pb.bill_no,
                                          'day', pos_business_day(pb.closed_at), 'totalSen', pb.total_sen,
                                          'totals', pb.totals, 'lines', coalesce(bl.lines, '[]'::jsonb))
                       order by pb.closed_at, pb.id)
        from pb left join bl on bl.bill_id = pb.id), '[]'::jsonb),
    'months', coalesce((
      select jsonb_agg(jsonb_build_object(
               'branchId', m.branch_id, 'month', to_char(m.first_day, 'YYYY-MM'),
               'overviewSen', (pos_report_cards(array[m.branch_id],
                                                (m.first_day + time '06:00') at time zone 'Asia/Kuala_Lumpur',
                                                ((m.first_day + interval '1 month')::date + time '06:00')
                                                  at time zone 'Asia/Kuala_Lumpur')->>'nettSen')::bigint)
             order by m.first_day, m.branch_id)
        from m), '[]'::jsonb))
$$;
revoke all on function einvoice_reconcile_source(date, date) from public, anon, authenticated;
grant execute on function einvoice_reconcile_source(date, date) to service_role;

notify pgrst, 'reload schema';
select 'einvoice w5 applied' as result;
