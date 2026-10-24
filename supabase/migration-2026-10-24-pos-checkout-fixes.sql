-- ============================================================================
-- Craft OS — POS Phase 1 · Checkout fixes from the Sub-plan 3 final review (2026-10-24)
-- Run on craft-os-dev after migration-2026-10-24-pos-checkout.sql, -checkout-fn.sql
-- and -bill-actions-fn.sql. Idempotent — safe to re-run.
-- Review: .superpowers/sdd/s3-final-review.md (I1, I2)
-- Owner decision 2026-10-24 (end of file): refunds go back the original route —
-- pos_refundable_methods, and refund_bill redefined once more.
--
-- This file is now the canonical definition of has_menu_cap, staff_has_cap and
-- refund_bill. Re-running an older migration that also defines them
-- (2026-10-22-pos-menu, 2026-10-24-pos-checkout, 2026-10-24-pos-bill-actions-fn)
-- puts back the older bodies — re-run this file afterwards.
-- Sub-plan 4a: refund_bill is canonical in migration-2026-10-24-pos-shifts-fn.sql now
-- (the open shift, shift_id and kind on each refund). After re-running THIS file,
-- re-run migration-2026-10-24-pos-shifts-fn.sql too, and then
-- migration-2026-10-25-pos-hardening.sql (shifts-fn brings back an old checkout_bill).
-- ============================================================================

-- ── I1. Capabilities end with the person: only live staff hold them ────────
-- A resigned person keeps is_active = true (see pos_my_branch): status = 'resigned'
-- is what really ends access, so both are checked. Same rule as before otherwise:
-- mirrors buildRoleCaps (src/shared/lib/lookups.tsx) over DEFAULT_SYSTEM_ROLE_CAPS
-- (src/shared/types/index.ts); the Owner's setting in system_role_permissions wins.
create or replace function has_menu_cap(p_cap text) returns boolean
language sql security definer stable set search_path = public, pg_temp as $$
  select coalesce((
    select coalesce(
      (select (srp.permissions ->> p_cap)::boolean
         from system_role_permissions srp
        where srp.system_role = s.system_role),
      case p_cap
        when 'access_settings' then s.system_role in ('owner','admin','manager')
        when 'pos_supervise'   then s.system_role in ('owner','admin','manager','supervisor')
        else false
      end)
    from staff s
    where s.id = auth.uid() and s.is_active and s.status = 'active'
  ), false)
$$;

-- The same rule for any staff member (the approver of a void or refund). Internal.
create or replace function staff_has_cap(p_staff_id uuid, p_cap text) returns boolean
language sql security definer stable set search_path = public, pg_temp as $$
  select coalesce((
    select coalesce(
      (select (srp.permissions ->> p_cap)::boolean
         from system_role_permissions srp
        where srp.system_role = s.system_role),
      case p_cap
        when 'access_settings' then s.system_role in ('owner','admin','manager')
        when 'pos_supervise'   then s.system_role in ('owner','admin','manager','supervisor')
        else false
      end)
    from staff s
    where s.id = p_staff_id and s.is_active and s.status = 'active'
  ), false)
$$;
revoke all on function staff_has_cap(uuid, text) from public, anon, authenticated;

-- ── I1. The caller's branch, for RLS policies ──────────────────────────────
-- pos_my_branch() raises and is internal, so a policy cannot use it. This one
-- answers null instead (signed out, not live, or no branch): a policy comparing
-- branch_id = null is simply false.
create or replace function pos_caller_branch() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select s.branch_id from staff s
   where s.id = auth.uid() and s.is_active and s.status = 'active'
$$;
revoke all on function pos_caller_branch() from public, anon;
grant execute on function pos_caller_branch() to authenticated;

-- ── I1. Settings tables: a manager edits their own branch only ─────────────
-- Reads stay open to every signed-in staff member (pos_read, unchanged).
drop policy if exists service_charge_rules_manage on service_charge_rules;
create policy service_charge_rules_manage on service_charge_rules for all to authenticated
  using      (branch_id = pos_caller_branch() and has_menu_cap('access_settings'))
  with check (branch_id = pos_caller_branch() and has_menu_cap('access_settings'));
drop policy if exists payment_methods_manage on payment_methods;
create policy payment_methods_manage on payment_methods for all to authenticated
  using      (branch_id = pos_caller_branch() and has_menu_cap('access_settings'))
  with check (branch_id = pos_caller_branch() and has_menu_cap('access_settings'));
drop policy if exists reason_templates_manage on reason_templates;
create policy reason_templates_manage on reason_templates for all to authenticated
  using      (branch_id = pos_caller_branch() and has_menu_cap('access_settings'))
  with check (branch_id = pos_caller_branch() and has_menu_cap('access_settings'));

-- ── I2. Refund: a resend must match what was recorded ──────────────────────
-- Same as migration-2026-10-24-pos-bill-actions-fn.sql except the two replay
-- branches: a resend of a recorded refund with another bill, amount or method is
-- refused with what was actually recorded (a lost reply must never let the till
-- pay out a different amount than the slip and bills.refunded_sen say). The reply
-- now also carries amountSen, the amount of this refund.
create or replace function refund_bill(p_refund_id uuid, p_bill_id uuid, p_amount_sen integer, p_method_id uuid,
                                       p_reason text, p_approver_id uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch   uuid := pos_my_branch();
  v_bill     bills;
  v_existing refunds;
  v_m        payment_methods;
  v_reason   text;
  v_err      text;
  v_route    text;
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
  if v_bill.status <> 'paid' then raise exception 'Only a paid bill can be refunded'; end if;
  if p_amount_sen is null or p_amount_sen <= 0 then raise exception 'Invalid refund amount'; end if;
  if p_amount_sen > v_bill.total_sen - v_bill.refunded_sen then
    raise exception 'Refund is more than what is left on this bill (RM %)',
      to_char((v_bill.total_sen - v_bill.refunded_sen) / 100.0, 'FM999999990.00');
  end if;
  select * into v_m from payment_methods where id = p_method_id and branch_id = v_branch and is_active;
  if not found then raise exception 'Payment method is not available at this branch'; end if;
  v_reason := pos_check_reason(v_branch, 'refund', p_reason);
  v_err := pos_check_approver(v_branch, p_approver_id, p_pin);
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  insert into refunds(id, bill_id, branch_id, amount_sen, method_id, method_name, reason, approved_by, created_by)
  values (p_refund_id, v_bill.id, v_branch, p_amount_sen, v_m.id, v_m.name, v_reason, p_approver_id, auth.uid());
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

-- ── Owner decision 2026-10-24: refunds go back the original route ──────────
-- A refund may only go back by a payment method the bill was actually paid with,
-- and never more than was paid by that method less what was already refunded by
-- it. Cash counts its payment's amount_sen (after change), not what was tendered.

-- What each of the bill's payment methods can still give back. One row per method
-- the bill was paid with, in the order the payments were taken; method_name and
-- kind are the payment's snapshot (the first payment line of that method).
create or replace function pos_refundable_methods(p_bill_id uuid)
returns table(method_id uuid, method_name text, kind text, paid_sen integer, refunded_sen integer, left_sen integer)
language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  v_branch uuid := pos_my_branch();
begin
  if not exists (select 1 from bills b where b.id = p_bill_id and b.branch_id = v_branch) then
    raise exception 'Bill not found';
  end if;
  return query
    with firsts as (
      select distinct on (p.method_id) p.method_id, p.method_name, p.kind, p.line_no
        from payments p
       where p.bill_id = p_bill_id and p.method_id is not null
       order by p.method_id, p.line_no
    ), paid as (
      select p.method_id, sum(p.amount_sen)::integer as amount
        from payments p
       where p.bill_id = p_bill_id and p.method_id is not null
       group by p.method_id
    ), back as (
      select r.method_id, sum(r.amount_sen)::integer as amount
        from refunds r
       where r.bill_id = p_bill_id and r.method_id is not null
       group by r.method_id
    )
    select f.method_id, f.method_name, f.kind, pd.amount,
           coalesce(bk.amount, 0), pd.amount - coalesce(bk.amount, 0)
      from firsts f
      join paid pd on pd.method_id = f.method_id
      left join back bk on bk.method_id = f.method_id
     order by f.line_no;
end $$;
revoke all on function pos_refundable_methods(uuid) from public, anon;
grant execute on function pos_refundable_methods(uuid) to authenticated;

-- refund_bill, canonical from here on. The replay branches are exactly the I2
-- version above; only a NEW refund changed: the method must be one the bill was
-- paid with (it need not still be active at the branch), the amount is capped by
-- what that method has left on this bill, and the refund row's method_name is the
-- payment's snapshot (so the slip says what the receipt said).
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
  if v_bill.status <> 'paid' then raise exception 'Only a paid bill can be refunded'; end if;
  if p_amount_sen is null or p_amount_sen <= 0 then raise exception 'Invalid refund amount'; end if;
  if p_amount_sen > v_bill.total_sen - v_bill.refunded_sen then
    raise exception 'Refund is more than what is left on this bill (RM %)',
      to_char((v_bill.total_sen - v_bill.refunded_sen) / 100.0, 'FM999999990.00');
  end if;
  -- the original route: a method this bill was paid with, up to what it has left
  -- (the bill row is locked above, so two refunds of one bill cannot both pass)
  select p.method_name into v_method_name
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
  insert into refunds(id, bill_id, branch_id, amount_sen, method_id, method_name, reason, approved_by, created_by)
  values (p_refund_id, v_bill.id, v_branch, p_amount_sen, p_method_id, v_method_name, v_reason, p_approver_id, auth.uid());
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

select 'checkout fixes applied' as result;
