-- ============================================================================
-- Craft OS — POS Sub-plan 4a functions: shifts, Pay in / Pay out, the Z report (2026-10-24).
-- Run on craft-os-dev after migration-2026-10-24-pos-shifts.sql. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-24-pos-shifts.md
-- Design: docs/superpowers/specs/2026-10-24-pos-shifts-design.md
--
-- New: pos_current_shift, open_shift, record_cash_move, close_shift, pos_shift_list,
-- pos_shift_zreport, reprint_zreport, save_shift_settings, and the internal
-- pos_shift_expected_cash, pos_shift_report (the Z report) and pos_queue_zreport.
-- A wrong approver PIN answers {"ok": false, "error": ...} instead of raising, as in
-- migration-2026-10-24-pos-bill-actions-fn.sql: a raise would roll back the
-- failed-attempt counter (and close_shift's first count).
--
-- Canonical from here on: checkout_bill (the live text of
-- migration-2026-10-24-pos-checkout-fn.sql) and refund_bill (the last definition in
-- migration-2026-10-24-pos-checkout-fixes.sql), each with only the lines marked "4a"
-- added: both take the branch's open shift FOR SHARE ("Open the shift first" when
-- there is none) and stamp it on the payment / refund rows (checkout_bill on the
-- paid bill too); refund_bill also keeps the payment's kind. Re-running
-- checkout-fn, bill-actions-fn or checkout-fixes brings an old body back — re-run
-- this file afterwards (the shifts verify's A section fails until then).
-- Pre-pilot hardening: checkout_bill and pos_shift_report are canonical in
-- migration-2026-10-25-pos-hardening.sql now — after re-running THIS file, re-run that one too.
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regclass('public.pos_shifts') is null or to_regclass('public.pos_cash_moves') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'branch_pos_settings'
                       and column_name = 'cash_variance_limit_sen') then
    raise exception 'STOP: run migration-2026-10-24-pos-shifts.sql first (pos_shifts is missing)';
  end if;
  -- nested, not "or": PostgreSQL does not promise left-to-right evaluation, and the
  -- function text can only be read once refund_bill is known to exist
  if to_regprocedure('refund_bill(uuid,uuid,integer,uuid,text,uuid,text)') is null
     or to_regprocedure('pos_refundable_methods(uuid)') is null then
    raise exception 'STOP: run migration-2026-10-24-pos-checkout-fixes.sql first (refund_bill is not the original-route version)';
  elsif pg_get_functiondef(to_regprocedure('refund_bill(uuid,uuid,integer,uuid,text,uuid,text)'))
          not like '%Refunds go back the way the bill was paid%' then
    raise exception 'STOP: run migration-2026-10-24-pos-checkout-fixes.sql first (refund_bill is not the original-route version)';
  end if;
  if to_regprocedure('pos_check_approver(uuid,uuid,text)') is null then
    raise exception 'STOP: run migration-2026-10-24-pos-bill-actions-fn.sql first (pos_check_approver is missing)';
  end if;
end $$;

-- ── The top bar: the branch's open shift, never the expected cash ───────────
-- { shift: null | { id, openedAt, openedByName, openingFloatSen },
--   openBillCount, lastFloatSen (the last closed shift's float, for the Open shift sheet), now }
create or replace function pos_current_shift() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
begin
  return jsonb_build_object(
    'shift', (select jsonb_build_object(
                'id', s.id,
                'openedAt', to_char(s.opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'openedByName', (select st.name from staff st where st.id = s.opened_by),
                'openingFloatSen', s.opening_float_sen)
                from pos_shifts s where s.branch_id = v_branch and s.status = 'open'),
    'openBillCount', (select count(*) from bills b where b.branch_id = v_branch and b.status = 'open'),
    'lastFloatSen', (select s.opening_float_sen from pos_shifts s
                      where s.branch_id = v_branch and s.status = 'closed'
                      order by s.closed_at desc, s.opened_at desc limit 1),
    'now', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end $$;
revoke all on function pos_current_shift() from public, anon;
grant execute on function pos_current_shift() to authenticated;

-- ── Open shift: any live POS staff of the branch ───────────────────────────
create or replace function open_shift(p_float_sen integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_open   pos_shifts;
begin
  if p_float_sen is null or p_float_sen < 0 or p_float_sen > 10000000 then
    raise exception 'Enter the opening float (RM 0.00 to RM 100000.00)';
  end if;
  select * into v_open from pos_shifts where branch_id = v_branch and status = 'open';
  if not found then
    begin
      insert into pos_shifts(branch_id, opened_by, opening_float_sen) values (v_branch, auth.uid(), p_float_sen);
      return pos_current_shift();
    exception when unique_violation then                                  -- another iPad opened it a moment ago
      select * into v_open from pos_shifts where branch_id = v_branch and status = 'open';
    end;
  end if;
  raise exception 'A shift is already open — opened by % at %',
    coalesce((select name from staff where id = v_open.opened_by), 'someone'),
    to_char(v_open.opened_at at time zone 'Asia/Kuala_Lumpur', 'HH24:MI');
end $$;
revoke all on function open_shift(integer) from public, anon;
grant execute on function open_shift(integer) to authenticated;

-- ── Pay in / Pay out, idempotent on p_id. Pay out needs an approver + PIN ───
-- Answers { ok: true, id, kind, amountSen } or { ok: false, error } (a wrong PIN, or a
-- resend of the same id with another kind or amount). Every other refusal raises.
create or replace function record_cash_move(p_id uuid, p_kind text, p_amount_sen integer, p_reason text,
                                            p_approver_id uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch   uuid := pos_my_branch();
  v_existing pos_cash_moves;
  v_shift    uuid;
  v_reason   text := nullif(trim(p_reason), '');
  v_err      text;
begin
  if p_id is null then raise exception 'Cash move id is missing'; end if;
  select * into v_existing from pos_cash_moves where id = p_id;
  if found then
    if v_existing.branch_id <> v_branch then raise exception 'This cash move id belongs to another branch'; end if;
    if v_existing.kind is distinct from p_kind or v_existing.amount_sen is distinct from p_amount_sen then
      return jsonb_build_object('ok', false, 'error',
        format('This was already recorded as %s RM %s — close and reopen to record another',
               case v_existing.kind when 'pay_in' then 'Pay in' else 'Pay out' end,
               to_char(v_existing.amount_sen / 100.0, 'FM999999990.00')));
    end if;
    return jsonb_build_object('ok', true, 'id', v_existing.id, 'kind', v_existing.kind, 'amountSen', v_existing.amount_sen);
  end if;
  if p_kind is null or p_kind not in ('pay_in', 'pay_out') then raise exception 'Choose Pay in or Pay out'; end if;
  if p_amount_sen is null or p_amount_sen <= 0 or p_amount_sen > 10000000 then
    raise exception 'Enter the amount (RM 0.01 to RM 100000.00)';
  end if;
  if v_reason is null then raise exception 'Enter a reason'; end if;
  if length(v_reason) > 200 then raise exception 'Reason is too long'; end if;
  select id into v_shift from pos_shifts where branch_id = v_branch and status = 'open' for share;
  if not found then raise exception 'Open the shift first'; end if;
  if p_kind = 'pay_out' then
    v_err := pos_check_approver(v_branch, p_approver_id, p_pin);
    if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  end if;
  insert into pos_cash_moves(id, shift_id, branch_id, kind, amount_sen, reason, created_by, approved_by)
  values (p_id, v_shift, v_branch, p_kind, p_amount_sen, v_reason, auth.uid(),
          case when p_kind = 'pay_out' then p_approver_id end)
  on conflict (id) do nothing;
  if not found then                                                       -- the same id won meanwhile
    return record_cash_move(p_id, p_kind, p_amount_sen, p_reason, p_approver_id, p_pin);
  end if;
  return jsonb_build_object('ok', true, 'id', p_id, 'kind', p_kind, 'amountSen', p_amount_sen);
end $$;
revoke all on function record_cash_move(uuid, text, integer, text, uuid, text) from public, anon;
grant execute on function record_cash_move(uuid, text, integer, text, uuid, text) to authenticated;

-- ── Expected cash = float + cash payments − cash refunds + pay in − pay out ──
-- Cash payments count amount_sen (the change is already taken off). Internal.
create or replace function pos_shift_expected_cash(p_shift_id uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select (s.opening_float_sen
          + coalesce((select sum(p.amount_sen) from payments p where p.shift_id = s.id and p.kind = 'cash'), 0)
          - coalesce((select sum(r.amount_sen) from refunds r where r.shift_id = s.id and r.kind = 'cash'), 0)
          + coalesce((select sum(m.amount_sen) from pos_cash_moves m where m.shift_id = s.id and m.kind = 'pay_in'), 0)
          - coalesce((select sum(m.amount_sen) from pos_cash_moves m where m.shift_id = s.id and m.kind = 'pay_out'), 0)
         )::integer
    from pos_shifts s where s.id = p_shift_id
$$;
revoke all on function pos_shift_expected_cash(uuid) from public, anon, authenticated;

-- ── The Z report (Feedme "Close up", without discount, delivery and member) ─
-- Exactly ZReport in src/features/pos/print/zreport.ts. A bill belongs to the shift it
-- was checked out in (bills.shift_id: a bill of RM 0.00 has no payment rows); voids (no
-- money moves) by their time, opened_at..closed_at (now() while the shift is still open).
-- Money in integer sen, times ISO UTC. Internal.
create or replace function pos_shift_report(p_shift_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with s as (
    select sh.*, coalesce(sh.closed_at, now()) as until from pos_shifts sh where sh.id = p_shift_id
  ),
  sb as (                                                                -- the shift's bills
    select b.* from bills b where b.shift_id = p_shift_id
  ),
  t as (
    select count(*)::integer as bill_count, coalesce(sum(sb.pax), 0)::integer as pax,
           coalesce(sum(sb.subtotal_sen), 0)::integer as gross, coalesce(sum(sb.takeaway_fee_sen), 0)::integer as fee,
           coalesce(sum(sb.service_charge_sen), 0)::integer as sc, coalesce(sum(sb.sst_sen), 0)::integer as sst,
           coalesce(sum(sb.rounding_sen), 0)::integer as rounding, coalesce(sum(sb.total_sen), 0)::integer as nett
      from sb
  ),
  vi as (                                                                -- items voided during the shift
    select oi.*, b.bill_no from order_items oi join bills b on b.id = oi.bill_id, s
     where b.branch_id = s.branch_id and oi.voided_at >= s.opened_at and oi.voided_at <= s.until
  ),
  vb as (                                                                -- bills voided during the shift
    select b.* from bills b, s
     where b.branch_id = s.branch_id and b.status = 'voided' and b.closed_at >= s.opened_at and b.closed_at <= s.until
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
      'roundingSen', t.rounding, 'nettSen', t.nett),
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

-- queue a Z report on the branch's receipt route (print_jobs.kind 'receipt', as the
-- refund slip); false = no receipt printer set. Internal.
create or replace function pos_queue_zreport(p_branch_id uuid, p_report jsonb, p_reprint boolean) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_route text;
begin
  select s.receipt_route into v_route from branch_pos_settings s where s.branch_id = p_branch_id;
  if v_route is null then return false; end if;
  insert into print_jobs(branch_id, route, kind, payload)
  values (p_branch_id, v_route, 'receipt',
          jsonb_build_object('kind', 'zreport', 'route', v_route, 'reprint', p_reprint, 'report', p_report));
  return true;
end $$;
revoke all on function pos_queue_zreport(uuid, jsonb, boolean) from public, anon, authenticated;

-- ── Close shift: blind count; above the limit an approver + PIN + reason ────
-- Answers { ok: true, shiftId, report, printed }, or { ok: false, needsApproval: true,
-- expectedSen, varianceSen, limitSen } (above the limit with no approver yet, or with an
-- approver who was shown another expected cash), or { ok: false, error } (a wrong PIN).
-- The first count is stored on the first call, with its variance against the expected
-- cash at that moment, and never replaced. Once the first count was above the limit
-- (by that stored variance), the close needs the approver, the PIN and a reason even if a new
-- count is within it (the cashier has seen the expected cash by then). p_expected_sen is
-- the expected cash the approver was shown: when it changed meanwhile (a sale, refund or
-- pay in / out on another iPad) the answer is "needs approval" again with the new
-- figures, before the PIN is tried. A resend of a close that went through (same count)
-- gets the same answer; any other call on a closed shift is refused.
create or replace function close_shift(p_shift_id uuid, p_counted_sen integer, p_reason text,
                                       p_approver_id uuid, p_pin text, p_expected_sen integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch   uuid := pos_my_branch();
  v_shift    pos_shifts;
  v_expected integer;
  v_var      integer;
  v_limit    integer;
  v_above    boolean;
  v_reason   text;
  v_err      text;
  v_report   jsonb;
  v_printed  boolean;
begin
  if p_counted_sen is null or p_counted_sen < 0 or p_counted_sen > 10000000 then
    raise exception 'Enter the counted cash (RM 0.00 to RM 100000.00)';
  end if;
  -- FOR UPDATE: waits for a checkout or refund in flight (they hold the shift FOR SHARE)
  select * into v_shift from pos_shifts where id = p_shift_id and branch_id = v_branch for update;
  if not found then raise exception 'Shift not found'; end if;
  if v_shift.status = 'closed' then
    if v_shift.counted_cash_sen = p_counted_sen and v_shift.report is not null then
      return jsonb_build_object('ok', true, 'shiftId', v_shift.id, 'report', v_shift.report,
                                'printed', coalesce(v_shift.report_printed, false));
    end if;
    raise exception 'This shift is already closed';
  end if;
  v_expected := pos_shift_expected_cash(v_shift.id);
  v_var      := p_counted_sen - v_expected;
  -- the first count and its variance against the expected cash at that moment, stored together, never replaced
  if v_shift.first_count_sen is null then
    update pos_shifts set first_count_sen = p_counted_sen, first_variance_sen = v_var where id = v_shift.id;
  end if;
  v_limit    := coalesce((select s.cash_variance_limit_sen from branch_pos_settings s where s.branch_id = v_branch), 500);
  -- v_shift was read before the first count was stored: on the first call this is this count's variance.
  -- The first count is judged by its own variance, not against the expected cash now: a pay in recorded
  -- after the figure was shown cannot bring it within the limit. (A shift counted before
  -- first_variance_sen existed falls back to the old rule.)
  v_above    := abs(v_var) > v_limit
                or abs(coalesce(v_shift.first_variance_sen, v_shift.first_count_sen - v_expected, v_var)) > v_limit;
  if v_above then
    if p_approver_id is null or p_expected_sen is distinct from v_expected then
      return jsonb_build_object('ok', false, 'needsApproval', true,
                                'expectedSen', v_expected, 'varianceSen', v_var, 'limitSen', v_limit);
    end if;
    v_reason := nullif(trim(p_reason), '');
    if v_reason is null then raise exception 'Enter a reason for the difference'; end if;
    if length(v_reason) > 200 then raise exception 'Reason is too long'; end if;
    v_err := pos_check_approver(v_branch, p_approver_id, p_pin);
    if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  end if;
  update pos_shifts
     set status = 'closed', counted_cash_sen = p_counted_sen, expected_cash_sen = v_expected, variance_sen = v_var,
         variance_reason = case when v_above then v_reason end,
         variance_approved_by = case when v_above then p_approver_id end,
         closed_by = auth.uid(), closed_at = clock_timestamp()   -- not now(): after any wait for the lock
   where id = v_shift.id;
  v_report  := pos_shift_report(v_shift.id);
  v_printed := pos_queue_zreport(v_branch, v_report, false);
  update pos_shifts set report = v_report, report_printed = v_printed where id = v_shift.id;
  return jsonb_build_object('ok', true, 'shiftId', v_shift.id, 'report', v_report, 'printed', v_printed);
end $$;
revoke all on function close_shift(uuid, integer, text, uuid, text, integer) from public, anon;
grant execute on function close_shift(uuid, integer, text, uuid, text, integer) to authenticated;

-- ── Past shifts (Approve POS voids & refunds): the last 30 closed, newest first ─
create or replace function pos_shift_list() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
begin
  if not has_menu_cap('pos_supervise') then raise exception 'Only a supervisor can see past shifts'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', x.id,
             'openedAt', to_char(x.opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'closedAt', to_char(x.closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'openedBy', (select st.name from staff st where st.id = x.opened_by),
             'closedBy', (select st.name from staff st where st.id = x.closed_by),
             'nettSen', coalesce((x.report->'summary'->>'nettSen')::integer, 0),
             'varianceSen', x.variance_sen)
           order by x.closed_at desc, x.opened_at desc)
      from (select * from pos_shifts s where s.branch_id = v_branch and s.status = 'closed'
             order by s.closed_at desc, s.opened_at desc limit 30) x), '[]'::jsonb);
end $$;
revoke all on function pos_shift_list() from public, anon;
grant execute on function pos_shift_list() to authenticated;

-- the frozen Z report of one closed shift of the caller's branch
create or replace function pos_shift_zreport(p_shift_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_report jsonb;
begin
  if not has_menu_cap('pos_supervise') then raise exception 'Only a supervisor can see past shifts'; end if;
  select s.report into v_report from pos_shifts s
   where s.id = p_shift_id and s.branch_id = v_branch and s.status = 'closed';
  if v_report is null then raise exception 'Shift not found'; end if;
  return v_report;
end $$;
revoke all on function pos_shift_zreport(uuid) from public, anon;
grant execute on function pos_shift_zreport(uuid) to authenticated;

-- the same Z report again, marked REPRINT
create or replace function reprint_zreport(p_shift_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_report jsonb;
begin
  if not has_menu_cap('pos_supervise') then raise exception 'Only a supervisor can reprint a Z report'; end if;
  select s.report into v_report from pos_shifts s
   where s.id = p_shift_id and s.branch_id = v_branch and s.status = 'closed';
  if v_report is null then raise exception 'Shift not found'; end if;
  if not pos_queue_zreport(v_branch, v_report, true) then
    raise exception 'No receipt printer is set — choose one in POS settings';
  end if;
end $$;
revoke all on function reprint_zreport(uuid) from public, anon;
grant execute on function reprint_zreport(uuid) to authenticated;

-- ── POS settings → Shifts: the branch's cash variance limit (access_settings) ─
create or replace function save_shift_settings(p_cash_variance_limit_sen integer) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
begin
  if not has_menu_cap('access_settings') then raise exception 'Only a manager can change the shift settings'; end if;
  if p_cash_variance_limit_sen is null or p_cash_variance_limit_sen < 0 or p_cash_variance_limit_sen > 1000000 then
    raise exception 'Enter a cash variance limit between RM 0.00 and RM 10000.00';
  end if;
  insert into branch_pos_settings(branch_id) values (v_branch) on conflict (branch_id) do nothing;
  update branch_pos_settings
     set cash_variance_limit_sen = p_cash_variance_limit_sen, updated_at = now()
   where branch_id = v_branch;
end $$;
revoke all on function save_shift_settings(integer) from public, anon;
grant execute on function save_shift_settings(integer) to authenticated;

-- ── Checkout, re-created: the live text of migration-2026-10-24-pos-checkout-fn.sql with
--    only the lines marked "4a" added (the open shift, FOR SHARE, stamped on each payment and the bill) ─
-- p_payments: [{ methodId: uuid, amountSen: int > 0, tenderedSen: int|null (cash only), reference: text|null }]
create or replace function checkout_bill(p_bill_id uuid, p_payments jsonb, p_checkout_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch    uuid := pos_my_branch();
  v_bill      bills;
  v_totals    jsonb;
  v_total     integer;
  v_sum       integer := 0;
  v_p         jsonb;
  v_m         payment_methods;
  v_amount    integer;
  v_tendered  integer;
  v_n         integer := 0;
  v_queued    boolean;
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
    return pos_checkout_result(v_bill.id);
  end if;

  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  if v_bill.checkout_id is not distinct from p_checkout_id then  -- won by the same checkout while we waited
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
  if p_payments is null or jsonb_typeof(p_payments) <> 'array' then raise exception 'Invalid payments'; end if;
  if jsonb_array_length(p_payments) > 10 then raise exception 'Too many payments on one bill'; end if;

  v_totals := pos_bill_totals(v_bill.id);
  v_total  := (v_totals->>'totalSen')::integer;

  -- validate every payment before writing anything
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
     where id = (v_p->>'methodId')::uuid and branch_id = v_branch and is_active;
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
  if v_sum <> v_total then
    raise exception 'Payments (RM %) do not match the total (RM %)',
      to_char(v_sum / 100.0, 'FM999999990.00'), to_char(v_total / 100.0, 'FM999999990.00');
  end if;

  for v_p in select * from jsonb_array_elements(p_payments) loop
    v_n := v_n + 1;
    select * into v_m from payment_methods where id = (v_p->>'methodId')::uuid;
    v_amount   := (v_p->'amountSen')::numeric::integer;
    v_tendered := case when v_m.kind = 'cash' and jsonb_typeof(v_p->'tenderedSen') = 'number'
                       then (v_p->'tenderedSen')::numeric::integer end;
    insert into payments(bill_id, branch_id, method_id, method_name, kind, amount_sen, tendered_sen,
                         change_sen, reference, taken_by, line_no, shift_id)            -- 4a: shift_id
    values (v_bill.id, v_branch, v_m.id, v_m.name, v_m.kind, v_amount, v_tendered,
            coalesce(v_tendered - v_amount, 0),
            nullif(trim(left(case when jsonb_typeof(v_p->'reference') = 'string' then v_p->>'reference' end, 60)), ''),
            auth.uid(), v_n, v_shift);                                          -- 4a: v_shift
  end loop;

  update bills
     set status = 'paid', closed_at = now(), closed_by = auth.uid(), checkout_id = p_checkout_id,
         shift_id = v_shift,                                                     -- 4a: the bill's shift
         totals = v_totals,
         subtotal_sen       = (v_totals->>'subtotalSen')::integer,
         service_charge_sen = (v_totals->>'serviceChargeSen')::integer,
         sst_sen            = (v_totals->>'sstSen')::integer,
         takeaway_fee_sen   = (v_totals->>'takeawayFeeSen')::integer,
         rounding_sen       = (v_totals->>'roundingSen')::integer,
         total_sen          = v_total
   where id = v_bill.id;
  v_queued := pos_queue_receipt(v_bill.id, false);
  update bills set receipt_queued = v_queued where id = v_bill.id;
  return pos_checkout_result(v_bill.id);
end $$;
revoke all on function checkout_bill(uuid, jsonb, uuid) from public, anon;
grant execute on function checkout_bill(uuid, jsonb, uuid) to authenticated;

-- ── Refund, re-created: the last refund_bill of migration-2026-10-24-pos-checkout-fixes.sql
--    with only the lines marked "4a" added (the open shift NOW, FOR SHARE; shift_id and kind) ─
create or replace function refund_bill(p_refund_id uuid, p_bill_id uuid, p_amount_sen integer, p_method_id uuid,
                                       p_reason text, p_approver_id uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch      uuid := pos_my_branch();
  v_bill        bills;
  v_existing    refunds;
  v_method_name text;
  v_paid        integer;
  v_back        integer;
  v_reason      text;
  v_err         text;
  v_route       text;
  v_kind        text;                                              -- 4a
  v_shift       uuid;                                              -- 4a
begin
  if p_refund_id is null then raise exception 'Refund id is missing'; end if;
  -- a resend of a refund that already went through gets the same reply as the first time
  select * into v_existing from refunds where id = p_refund_id;
  if found then
    if v_existing.branch_id <> v_branch then
      raise exception 'This refund id belongs to another bill';
    end if;
    if v_existing.bill_id <> p_bill_id or v_existing.amount_sen is distinct from p_amount_sen
       or v_existing.method_id is distinct from p_method_id then
      return jsonb_build_object('ok', false, 'error',
        format('This refund was already recorded as RM %s by %s — close and reopen to refund more',
               to_char(v_existing.amount_sen / 100.0, 'FM999999990.00'), v_existing.method_name));
    end if;
    return jsonb_build_object('ok', true, 'amountSen', v_existing.amount_sen,
                              'refundedSen', (select refunded_sen from bills where id = p_bill_id),
                              'slipQueued', v_existing.slip_queued);
  end if;
  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  select * into v_existing from refunds where id = p_refund_id;        -- the same refund won while we waited
  if found then
    if v_existing.bill_id <> p_bill_id or v_existing.amount_sen is distinct from p_amount_sen
       or v_existing.method_id is distinct from p_method_id then
      return jsonb_build_object('ok', false, 'error',
        format('This refund was already recorded as RM %s by %s — close and reopen to refund more',
               to_char(v_existing.amount_sen / 100.0, 'FM999999990.00'), v_existing.method_name));
    end if;
    return jsonb_build_object('ok', true, 'amountSen', v_existing.amount_sen, 'refundedSen', v_bill.refunded_sen,
                              'slipQueued', v_existing.slip_queued);
  end if;
  -- 4a: a refund belongs to the shift open NOW (a refund of an old bill too); FOR SHARE as in checkout_bill
  select id into v_shift from pos_shifts where branch_id = v_branch and status = 'open' for share;
  if not found then raise exception 'Open the shift first'; end if;
  if v_bill.status <> 'paid' then raise exception 'Only a paid bill can be refunded'; end if;
  if p_amount_sen is null or p_amount_sen <= 0 then raise exception 'Invalid refund amount'; end if;
  if p_amount_sen > v_bill.total_sen - v_bill.refunded_sen then
    raise exception 'Refund is more than what is left on this bill (RM %)',
      to_char((v_bill.total_sen - v_bill.refunded_sen) / 100.0, 'FM999999990.00');
  end if;
  -- the original route: a method this bill was paid with, up to what it has left
  -- (the bill row is locked above, so two refunds of one bill cannot both pass)
  select p.method_name, p.kind into v_method_name, v_kind                 -- 4a: the kind too
    from payments p where p.bill_id = v_bill.id and p.method_id = p_method_id
   order by p.line_no limit 1;
  if not found then
    raise exception 'Refunds go back the way the bill was paid — choose one of its payment methods';
  end if;
  select coalesce(sum(p.amount_sen), 0)::integer into v_paid
    from payments p where p.bill_id = v_bill.id and p.method_id = p_method_id;
  select coalesce(sum(r.amount_sen), 0)::integer into v_back
    from refunds r where r.bill_id = v_bill.id and r.method_id = p_method_id;
  if p_amount_sen > v_paid - v_back then
    raise exception 'Refund is more than was paid by % on this bill (RM % left)',
      v_method_name, to_char(greatest(v_paid - v_back, 0) / 100.0, 'FM999999990.00');
  end if;
  v_reason := pos_check_reason(v_branch, 'refund', p_reason);
  v_err := pos_check_approver(v_branch, p_approver_id, p_pin);
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  insert into refunds(id, bill_id, branch_id, amount_sen, method_id, method_name, reason, approved_by, created_by,
                      shift_id, kind)                                                   -- 4a
  values (p_refund_id, v_bill.id, v_branch, p_amount_sen, p_method_id, v_method_name, v_reason, p_approver_id, auth.uid(),
          v_shift, v_kind);                                                             -- 4a
  update bills set refunded_sen = refunded_sen + p_amount_sen where id = v_bill.id;
  select s.receipt_route into v_route from branch_pos_settings s where s.branch_id = v_branch;
  if v_route is not null then
    insert into print_jobs(branch_id, route, kind, payload)
    values (v_branch, v_route, 'receipt', pos_refund_slip_payload(p_refund_id));
    update refunds set slip_queued = true where id = p_refund_id;
  end if;
  return jsonb_build_object('ok', true, 'amountSen', p_amount_sen, 'refundedSen', v_bill.refunded_sen + p_amount_sen,
                            'slipQueued', v_route is not null);
end $$;
revoke all on function refund_bill(uuid, uuid, integer, uuid, text, uuid, text) from public, anon;
grant execute on function refund_bill(uuid, uuid, integer, uuid, text, uuid, text) to authenticated;

-- PostgREST picks up the new functions now, not at its next poll
notify pgrst, 'reload schema';

select 'shifts functions applied' as result;
