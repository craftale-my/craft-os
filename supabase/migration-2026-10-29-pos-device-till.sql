-- ============================================================================
-- Craft OS — POS till on device sessions (2026-10-29): Sub-plan C1 of devices, PIN login
-- and outlets. Run on craft-os-dev after migration-2026-10-29-pos-devices.sql.
-- Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-29-pos-device-till.md
-- Design: docs/superpowers/specs/2026-10-29-pos-devices-outlets-design.md (§2 offline queue, §4)
--
-- T1  Every front-of-house RPC now runs on the device context. pos_my_branch() returns the
--     outlet from pos_ctx(), so the 26 RPCs that call it follow without being re-created;
--     the new pos_actor() is the session's staff member, and the nine RPCs that recorded
--     auth.uid() as the actor (checkout_bill, close_shift, merge_bills, open_shift,
--     place_counter_order, record_cash_move, refund_bill, void_bill, void_order_item) and
--     pos_pin_attempt (the approval lockout's caller) are re-created from their live text
--     with auth.uid() → pos_actor() (pos_pin_attempt: pos_actor() for a device, auth.uid() for a
--     Craft OS login, so My PIN keeps working). pos_shift_list, pos_shift_zreport and
--     reprint_zreport check pos_supervise of pos_actor() instead of has_menu_cap (a device has
--     no staff row).
--     TRANSITION (removed in Sub-plan C3): pos_ctx() still accepts a staff login at its home
--     branch, with pos_my_branch()'s old messages, so the Craft OS /pos keeps working until
--     the POS app replaces it. A device is never treated as a staff login.
-- T2  Printing: pos_print_branch() refuses a POS tablet that is not the outlet's printing
--     tablet (not_printing_tablet); claim_print_job, finish_print_job, requeue_print_job and
--     insert_test_print's own-outlet path use it (no staff session needed). TRANSITION: a
--     staff login (today's print agent) still prints for its home branch.
-- T3  Reads: pos_readable_branches() — a device reads its own outlet, a staff login the
--     outlets of staff_outlet_scope. The open read policies (pos_read) of the branch tables
--     and order_items, and dining_tables_update, use it; print_jobs_update (no client
--     writes it any more) is dropped. Realtime follows the same policies.
--     Writes from the till (sold out, pause QR) need a session: pos_session_branch() is the
--     outlet of a POS device with an open session at an open outlet (a staff login: its home
--     branch during the transition); branch_menu_status_write and dining_tables_update allow
--     that outlet or one the caller manages. pos_caller_branch() is a device's outlet for a device.
-- T4  Audit: device_id on orders, payments, refunds, pos_cash_moves and
--     pos_shifts.opened_device_id are filled by default from pos_current_device();
--     bills.closed_device_id, order_items.voided_device_id and pos_shifts.closed_device_id
--     are set by the RPCs that close, void or close a shift.
-- T5  The offline queue: place_counter_order takes p_staff_id (who queued the order); on a
--     device the order is placed by that person when they have signed in on this tablet before
--     and may still work at the outlet, otherwise by the session's staff member. A staff login's
--     p_staff_id is ignored.
-- T6  pos_unpair_this_device(): a manager of the outlet, signed in on the tablet, unpairs
--     it from the POS app. It and pos_unpair_device share pos_revoke_device().
-- Re-run hazards: re-running an older file that defines any function re-created here
-- (checkout-fn, bill-actions-fn, checkout-fixes, catalogs-fn, shifts-fn, hardening,
-- ordering-fn, outlets, devices) puts back its auth.uid() actor — re-run this file after it.
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_ctx()') is null or to_regprocedure('pos_set_print_tablet(uuid)') is null then
    raise exception 'STOP: run migration-2026-10-29-pos-devices.sql first (pos_ctx is missing)';
  end if;
end $$;

-- ── T4. The device behind the current call, without writing (defaults, policies) ──
create or replace function pos_current_device() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select d.id from pos_devices d where d.id = auth.uid() and d.revoked_at is null
$$;
revoke all on function pos_current_device() from public, anon, authenticated;

alter table orders         add column if not exists device_id        uuid references pos_devices(id) on delete set null;
alter table payments       add column if not exists device_id        uuid references pos_devices(id) on delete set null;
alter table refunds        add column if not exists device_id        uuid references pos_devices(id) on delete set null;
alter table pos_cash_moves add column if not exists device_id        uuid references pos_devices(id) on delete set null;
alter table pos_shifts     add column if not exists opened_device_id uuid references pos_devices(id) on delete set null;
alter table pos_shifts     add column if not exists closed_device_id uuid references pos_devices(id) on delete set null;
alter table bills          add column if not exists closed_device_id uuid references pos_devices(id) on delete set null;
alter table order_items    add column if not exists voided_device_id uuid references pos_devices(id) on delete set null;
alter table orders         alter column device_id        set default pos_current_device();
alter table payments       alter column device_id        set default pos_current_device();
alter table refunds        alter column device_id        set default pos_current_device();
alter table pos_cash_moves alter column device_id        set default pos_current_device();
alter table pos_shifts     alter column opened_device_id set default pos_current_device();

-- ── T1. The device context, with the C1 transition for staff logins ──────────
-- Same as migration-2026-10-29-pos-devices.sql except a caller with no pos_devices row: a
-- live staff member at their home branch (device_id null), with pos_my_branch()'s messages.
create or replace function pos_ctx(out device_id uuid, out branch_id uuid, out staff_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dev    pos_devices;
  v_ses    pos_staff_sessions;
  v_branch uuid;
  v_live   boolean;
begin
  select * into v_dev from pos_devices d where d.id = auth.uid();
  if not found then
    -- TRANSITION (removed in Sub-plan C3): a staff login runs the till at its home branch
    if auth.uid() is null then raise exception 'Sign in required'; end if;
    select s.branch_id, (s.is_active and s.status = 'active') into v_branch, v_live from staff s where s.id = auth.uid();
    if not coalesce(v_live, false) then raise exception 'Your account is not active'; end if;
    if v_branch is null then raise exception 'Your account has no branch — ask a manager to set it in Team'; end if;
    device_id := null;
    branch_id := v_branch;
    staff_id := auth.uid();
    return;
  end if;
  if v_dev.kind <> 'pos' or v_dev.revoked_at is not null then raise exception 'device_unpaired'; end if;
  if not pos_outlet_open(v_dev.branch_id) then raise exception 'outlet_closed'; end if;
  select * into v_ses from pos_staff_sessions s where s.device_id = v_dev.id and s.ended_at is null;
  if not found then raise exception 'no_session'; end if;
  if not pos_staff_may_work(v_ses.staff_id, v_dev.branch_id) then raise exception 'access_changed'; end if;
  -- stamped at most every 30 s: every till call passes here. A read-only transaction (PostgREST
  -- runs STABLE RPCs read-only) skips the stamps instead of failing the call.
  if not current_setting('transaction_read_only')::boolean then
    update pos_devices set last_seen_at = now()
     where id = v_dev.id and (last_seen_at is null or last_seen_at < now() - interval '30 seconds');
    update pos_staff_sessions set last_active_at = now()
     where id = v_ses.id and last_active_at < now() - interval '30 seconds';
  end if;
  device_id := v_dev.id;
  branch_id := v_dev.branch_id;
  staff_id := v_ses.staff_id;
end $$;
revoke all on function pos_ctx() from public, anon, authenticated;

-- The outlet of every front-of-house call: the 26 RPCs that call this follow pos_ctx().
create or replace function pos_my_branch() returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return (select c.branch_id from pos_ctx() c);
end $$;
revoke all on function pos_my_branch() from public, anon, authenticated;

-- Who acts: the session's staff member on a device (a staff login during the transition).
create or replace function pos_actor() returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return (select c.staff_id from pos_ctx() c);
end $$;
revoke all on function pos_actor() from public, anon, authenticated;

-- ── T2. Printing ─────────────────────────────────────────────────────────────
-- A print agent, or the outlet's printing tablet (locked or not), prints for its outlet.
create or replace function pos_print_branch() returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dev pos_devices;
begin
  select * into v_dev from pos_devices d where d.id = auth.uid();
  if not found then
    return pos_my_branch();                       -- TRANSITION (removed in C3): a staff login prints for its home branch
  end if;
  if v_dev.revoked_at is not null then raise exception 'device_unpaired'; end if;
  if not (v_dev.kind = 'print_agent' or (v_dev.kind = 'pos' and v_dev.prints)) then raise exception 'not_printing_tablet'; end if;
  if not current_setting('transaction_read_only')::boolean then              -- as in pos_ctx
    update pos_devices set last_seen_at = now()
     where id = v_dev.id and (last_seen_at is null or last_seen_at < now() - interval '30 seconds');
  end if;
  return v_dev.branch_id;
end $$;
revoke all on function pos_print_branch() from public, anon, authenticated;

-- ── T3. Reads ────────────────────────────────────────────────────────────────
-- A device reads its own outlet (nothing once revoked); a staff login the outlets in its scope.
create or replace function pos_readable_branches() returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select d.branch_id from pos_devices d where d.id = auth.uid() and d.revoked_at is null
  union
  select x.id from staff_outlet_scope(auth.uid()) as x(id)
   where not exists (select 1 from pos_devices d where d.id = auth.uid())
$$;
revoke all on function pos_readable_branches() from public, anon;
grant execute on function pos_readable_branches() to authenticated;

-- The outlet of a till write made directly on a table (sold out, pause QR): a POS device with an
-- open session of someone who may still work there, at an open outlet. Non-writing (used by RLS).
create or replace function pos_session_branch() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select case when exists (select 1 from pos_devices d where d.id = auth.uid())
              then (select d.branch_id from pos_devices d
                     where d.id = auth.uid() and d.kind = 'pos' and d.revoked_at is null and pos_outlet_open(d.branch_id)
                       and exists (select 1 from pos_staff_sessions s
                                    where s.device_id = d.id and s.ended_at is null and pos_staff_may_work(s.staff_id, d.branch_id)))
              -- TRANSITION (removed in Sub-plan C3): a staff login writes at its home branch
              else (select s.branch_id from staff s where s.id = auth.uid() and s.is_active and s.status = 'active') end
$$;
revoke all on function pos_session_branch() from public, anon;
grant execute on function pos_session_branch() to authenticated;

-- Sold-out writes (branch_menu_status_write, before this file): a device's outlet, else the staff member's home branch.
create or replace function pos_caller_branch() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select case when exists (select 1 from pos_devices d where d.id = auth.uid())
              then (select d.branch_id from pos_devices d where d.id = auth.uid() and d.revoked_at is null)
              else (select s.branch_id from staff s where s.id = auth.uid() and s.is_active and s.status = 'active') end
$$;
revoke all on function pos_caller_branch() from public, anon;
grant execute on function pos_caller_branch() to authenticated;

do $$
declare t text;
begin
  foreach t in array array['bills', 'orders', 'payments', 'refunds', 'print_jobs', 'dining_tables', 'print_routes',
                           'branch_menu_status', 'bill_counters', 'branch_pos_settings', 'service_charge_rules',
                           'payment_methods', 'reason_templates'] loop
    execute format('drop policy if exists pos_read on %I', t);
    execute format('create policy pos_read on %I for select to authenticated using (branch_id in (select pos_readable_branches()))', t);
  end loop;
end $$;
drop policy if exists pos_read on order_items;
create policy pos_read on order_items for select to authenticated
  using (exists (select 1 from bills b where b.id = order_items.bill_id and b.branch_id in (select pos_readable_branches())));
drop policy if exists dining_tables_update on dining_tables;
create policy dining_tables_update on dining_tables for update to authenticated
  using (branch_id = pos_session_branch() or pos_manages_outlet(branch_id))
  with check (branch_id = pos_session_branch() or pos_manages_outlet(branch_id));
drop policy if exists branch_menu_status_write on branch_menu_status;
create policy branch_menu_status_write on branch_menu_status for all to authenticated
  using (branch_id = pos_session_branch() or pos_manages_outlet(branch_id))
  with check (branch_id = pos_session_branch() or pos_manages_outlet(branch_id));
drop policy if exists print_jobs_update on print_jobs;

-- ── T6. Unpairing, shared ────────────────────────────────────────────────────
-- Revoke, end the open session, ban the auth user (a real date: Auth cannot read 'infinity').
create or replace function pos_revoke_device(p_device_id uuid, p_by uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update pos_devices set revoked_at = now(), revoked_by = p_by, prints = false where id = p_device_id and revoked_at is null;
  update pos_staff_sessions set ended_at = now(), end_reason = 'unpaired' where device_id = p_device_id and ended_at is null;
  update auth.users set banned_until = now() + interval '100 years' where id = p_device_id;
end $$;
revoke all on function pos_revoke_device(uuid, uuid) from public, anon, authenticated;

-- Same as migration-2026-10-29-pos-devices.sql except the shared revoke.
create or replace function pos_unpair_device(p_device_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dev pos_devices;
begin
  select * into v_dev from pos_devices d where d.id = p_device_id for update;
  if not found then raise exception 'Device not found'; end if;
  if not pos_manages_outlet(v_dev.branch_id) then raise exception 'This device is not at one of your outlets'; end if;
  if v_dev.revoked_at is not null then return; end if;
  perform pos_revoke_device(v_dev.id, auth.uid());
end $$;
revoke all on function pos_unpair_device(uuid) from public, anon;
grant execute on function pos_unpair_device(uuid) to authenticated;

-- POS app → Unpair this device: the signed-in staff member manages this outlet.
create or replace function pos_unpair_this_device() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ctx record;
begin
  select * into v_ctx from pos_ctx();
  if v_ctx.device_id is null then raise exception 'device_unpaired'; end if;    -- a staff login has no device
  perform 1 from pos_devices d where d.id = v_ctx.device_id for update;
  if not (staff_has_cap(v_ctx.staff_id, 'access_settings') and v_ctx.branch_id in (select staff_outlet_scope(v_ctx.staff_id))) then
    raise exception 'Only a manager of this outlet can unpair this device';
  end if;
  perform pos_revoke_device(v_ctx.device_id, v_ctx.staff_id);
end $$;
revoke all on function pos_unpair_this_device() from public, anon;
grant execute on function pos_unpair_this_device() to authenticated;

-- ── T5. The offline queue keeps who took the order ───────────────────────────
drop function if exists place_counter_order(uuid, text, integer, jsonb, uuid, uuid);
drop function if exists place_counter_order(uuid, text, integer, jsonb, uuid);         -- checkout-fn's, if it was re-run
create or replace function place_counter_order(p_table_id uuid, p_order_type text, p_pax integer, p_items jsonb,
                                               p_client_order_id uuid, p_catalog_id uuid default null,
                                               p_staff_id uuid default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ctx record;
  v_by  uuid;
begin
  select * into v_ctx from pos_ctx();
  -- an order sent from this tablet's offline queue is placed by whoever queued it: someone who has
  -- signed in on this tablet and may still work here; anyone else, or a staff login, is ignored
  v_by := case when p_staff_id is not null and v_ctx.device_id is not null
                    and exists (select 1 from pos_staff_sessions s where s.device_id = v_ctx.device_id and s.staff_id = p_staff_id)
                    and pos_staff_may_work(p_staff_id, v_ctx.branch_id) then p_staff_id
               else v_ctx.staff_id end;
  return pos_insert_order(v_ctx.branch_id, p_table_id, p_order_type, p_pax, 'counter', v_by, p_items,
                          p_client_order_id, p_catalog_id);
end $$;
revoke all on function place_counter_order(uuid, text, integer, jsonb, uuid, uuid, uuid) from public, anon;
grant execute on function place_counter_order(uuid, text, integer, jsonb, uuid, uuid, uuid) to authenticated;

-- ── T1 / T2 / T4. Re-created from their live text (2026-10-29, identical on dev and the
-- replay), with only the marked replacements: auth.uid() → pos_actor() (the actor),
-- the closing / voiding device, and pos_my_branch() → pos_print_branch() for printing.

-- checkout_bill: re-created (see the header)
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
            pos_actor(), v_n, v_shift);                                          -- 4a: v_shift
  end loop;

  update bills
     set status = 'paid', closed_at = now(), closed_by = pos_actor(), closed_device_id = pos_current_device(), checkout_id = p_checkout_id,
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
end $function$;

-- close_shift: re-created (see the header)
CREATE OR REPLACE FUNCTION close_shift(p_shift_id uuid, p_counted_sen integer, p_reason text, p_approver_id uuid, p_pin text, p_expected_sen integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
         closed_by = pos_actor(), closed_device_id = pos_current_device(), closed_at = clock_timestamp()   -- not now(): after any wait for the lock
   where id = v_shift.id;
  v_report  := pos_shift_report(v_shift.id);
  v_printed := pos_queue_zreport(v_branch, v_report, false);
  update pos_shifts set report = v_report, report_printed = v_printed where id = v_shift.id;
  return jsonb_build_object('ok', true, 'shiftId', v_shift.id, 'report', v_report, 'printed', v_printed);
end $function$;

-- merge_bills: re-created (see the header)
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

-- open_shift: re-created (see the header)
CREATE OR REPLACE FUNCTION open_shift(p_float_sen integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
      insert into pos_shifts(branch_id, opened_by, opening_float_sen) values (v_branch, pos_actor(), p_float_sen);
      return pos_current_shift();
    exception when unique_violation then                                  -- another iPad opened it a moment ago
      select * into v_open from pos_shifts where branch_id = v_branch and status = 'open';
    end;
  end if;
  raise exception 'A shift is already open — opened by % at %',
    coalesce((select name from staff where id = v_open.opened_by), 'someone'),
    to_char(v_open.opened_at at time zone 'Asia/Kuala_Lumpur', 'HH24:MI');
end $function$;

-- record_cash_move: re-created (see the header)
CREATE OR REPLACE FUNCTION record_cash_move(p_id uuid, p_kind text, p_amount_sen integer, p_reason text, p_approver_id uuid, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  values (p_id, v_shift, v_branch, p_kind, p_amount_sen, v_reason, pos_actor(),
          case when p_kind = 'pay_out' then p_approver_id end)
  on conflict (id) do nothing;
  if not found then                                                       -- the same id won meanwhile
    return record_cash_move(p_id, p_kind, p_amount_sen, p_reason, p_approver_id, p_pin);
  end if;
  return jsonb_build_object('ok', true, 'id', p_id, 'kind', p_kind, 'amountSen', p_amount_sen);
end $function$;

-- refund_bill: re-created (see the header)
CREATE OR REPLACE FUNCTION refund_bill(p_refund_id uuid, p_bill_id uuid, p_amount_sen integer, p_method_id uuid, p_reason text, p_approver_id uuid, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  values (p_refund_id, v_bill.id, v_branch, p_amount_sen, p_method_id, v_method_name, v_reason, p_approver_id, pos_actor(),
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
end $function$;

-- void_bill: re-created (see the header)
CREATE OR REPLACE FUNCTION void_bill(p_bill_id uuid, p_reason text, p_approver_id uuid, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch uuid := pos_my_branch();
  v_bill   bills;
  v_reason text;
  v_err    text;
  v_ids    uuid[];
begin
  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  if v_bill.status = 'voided' then return jsonb_build_object('ok', true); end if;      -- a retry
  if v_bill.status = 'paid' then raise exception 'This bill is paid — refund it instead'; end if;
  if v_bill.status <> 'open' then raise exception 'This bill was merged into another bill'; end if;
  select coalesce(array_agg(id), '{}') into v_ids from order_items where bill_id = v_bill.id and voided_at is null;
  if cardinality(v_ids) > 0 then
    v_reason := pos_check_reason(v_branch, 'void_bill', p_reason);
    v_err := pos_check_approver(v_branch, p_approver_id, p_pin);
    if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
    update order_items
       set voided_at = now(), voided_by = pos_actor(), voided_device_id = pos_current_device(), void_reason = v_reason, void_approved_by = p_approver_id
     where id = any (v_ids);
  else
    v_reason := nullif(trim(left(p_reason, 200)), '');
  end if;
  update bills
     set status = 'voided', closed_at = now(), closed_by = pos_actor(), closed_device_id = pos_current_device(), void_reason = v_reason,
         void_approved_by = case when cardinality(v_ids) > 0 then p_approver_id end
   where id = v_bill.id;
  perform pos_queue_void_tickets(v_ids);
  return jsonb_build_object('ok', true);
end $function$;

-- void_order_item: re-created (see the header)
CREATE OR REPLACE FUNCTION void_order_item(p_item_id uuid, p_reason text, p_approver_id uuid, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch uuid := pos_my_branch();
  v_item   order_items;
  v_bill   bills;
  v_reason text;
  v_err    text;
begin
  select * into v_item from order_items where id = p_item_id;
  if not found then raise exception 'Item not found'; end if;
  select * into v_bill from bills where id = v_item.bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Item not found'; end if;
  select * into v_item from order_items where id = p_item_id;            -- again, under the bill lock
  if v_item.bill_id <> v_bill.id then raise exception 'The bill just changed — please try again'; end if;
  if v_item.voided_at is not null then return jsonb_build_object('ok', true); end if;   -- a retry
  if v_bill.status <> 'open' then
    raise exception 'Only items on an open bill can be voided — refund a paid bill instead';
  end if;
  v_reason := pos_check_reason(v_branch, 'void_item', p_reason);
  v_err := pos_check_approver(v_branch, p_approver_id, p_pin);
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  update order_items
     set voided_at = now(), voided_by = pos_actor(), voided_device_id = pos_current_device(), void_reason = v_reason, void_approved_by = p_approver_id
   where id = p_item_id;
  update bills set updated_at = now() where id = v_bill.id;   -- H3: a bills event, so other iPads hear of it at once
  perform pos_queue_void_tickets(array[p_item_id]);
  return jsonb_build_object('ok', true);
end $function$;

-- pos_pin_attempt: re-created (see the header)
CREATE OR REPLACE FUNCTION pos_pin_attempt(p_staff_id uuid, p_pin text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_caller uuid := case when exists (select 1 from pos_devices d where d.id = auth.uid()) then pos_actor() else auth.uid() end;   -- a device: the session's staff member; Craft OS (My PIN): the login
  v_hash   text;
  v_try    pos_pin_attempts;
  v_n      integer;
begin
  if v_caller is null then raise exception 'Sign in required'; end if;
  select pin_hash into v_hash from staff_pos_pins where staff_id = p_staff_id;
  if not found then
    return 'No POS PIN is set for this person yet — they set one under My PIN';
  end if;
  insert into pos_pin_attempts(approver_id, caller_id) values (p_staff_id, v_caller)
  on conflict (approver_id, caller_id) do nothing;
  select * into v_try from pos_pin_attempts where approver_id = p_staff_id and caller_id = v_caller for update;
  if v_try.locked_until is not null and v_try.locked_until > now() then
    return 'Too many wrong PINs — try again after ' || to_char(v_try.locked_until at time zone 'Asia/Kuala_Lumpur', 'HH24:MI');
  end if;
  if p_pin is not null and p_pin ~ '^\d{4,6}$' and v_hash = extensions.crypt(p_pin, v_hash) then
    update pos_pin_attempts set failed_attempts = 0, locked_until = null, updated_at = now()
     where approver_id = p_staff_id and caller_id = v_caller;
    return null;
  end if;
  v_n := case when v_try.updated_at < now() - interval '1 day' then 0 else v_try.failed_attempts end + 1;
  if v_n >= 5 then
    update pos_pin_attempts set failed_attempts = 0, locked_until = now() + interval '10 minutes', updated_at = now()
     where approver_id = p_staff_id and caller_id = v_caller;
    return 'Wrong PIN — locked for 10 minutes after 5 wrong tries';
  end if;
  update pos_pin_attempts set failed_attempts = v_n, locked_until = null, updated_at = now()
   where approver_id = p_staff_id and caller_id = v_caller;
  return format('Wrong PIN — %s %s left', 5 - v_n, case when 5 - v_n = 1 then 'try' else 'tries' end);
end $function$;

-- pos_shift_list: re-created (see the header)
CREATE OR REPLACE FUNCTION pos_shift_list()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch uuid := pos_my_branch();
begin
  if not staff_has_cap(pos_actor(), 'pos_supervise') then raise exception 'Only a supervisor can see past shifts'; end if;
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
end $function$;

-- pos_shift_zreport: re-created (see the header)
CREATE OR REPLACE FUNCTION pos_shift_zreport(p_shift_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch uuid := pos_my_branch();
  v_report jsonb;
begin
  if not staff_has_cap(pos_actor(), 'pos_supervise') then raise exception 'Only a supervisor can see past shifts'; end if;
  select s.report into v_report from pos_shifts s
   where s.id = p_shift_id and s.branch_id = v_branch and s.status = 'closed';
  if v_report is null then raise exception 'Shift not found'; end if;
  return v_report;
end $function$;

-- reprint_zreport: re-created (see the header)
CREATE OR REPLACE FUNCTION reprint_zreport(p_shift_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch uuid := pos_my_branch();
  v_report jsonb;
begin
  if not staff_has_cap(pos_actor(), 'pos_supervise') then raise exception 'Only a supervisor can reprint a Z report'; end if;
  select s.report into v_report from pos_shifts s
   where s.id = p_shift_id and s.branch_id = v_branch and s.status = 'closed';
  if v_report is null then raise exception 'Shift not found'; end if;
  if not pos_queue_zreport(v_branch, v_report, true) then
    raise exception 'No receipt printer is set — choose one in POS settings';
  end if;
end $function$;

-- claim_print_job: re-created (see the header)
CREATE OR REPLACE FUNCTION claim_print_job(p_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch uuid := pos_print_branch();
begin
  update print_jobs set status = 'printing', attempts = attempts + 1, claimed_at = now()
   where id = p_id and status = 'pending' and branch_id = v_branch;
  return found;
end $function$;

-- finish_print_job: re-created (see the header)
CREATE OR REPLACE FUNCTION finish_print_job(p_id uuid, p_ok boolean, p_error text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch uuid := pos_print_branch();
begin
  update print_jobs
     set status     = case when p_ok then 'printed' else 'failed' end,
         printed_at = case when p_ok then now() else null end,
         last_error = case when p_ok then null else p_error end
   where id = p_id and status = 'printing' and branch_id = v_branch;
end $function$;

-- requeue_print_job: re-created (see the header)
CREATE OR REPLACE FUNCTION requeue_print_job(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch uuid := pos_print_branch();
begin
  update print_jobs set status = 'pending'
   where id = p_id and branch_id = v_branch
     and (status = 'failed' or (status = 'printing' and claimed_at < now() - interval '2 minutes'));
end $function$;

-- insert_test_print: re-created (see the header)
CREATE OR REPLACE FUNCTION insert_test_print(p_route text, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_branch uuid; v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if p_branch_id is null then                                                                -- O7
    v_branch := pos_print_branch();                                        -- the printing tablet or agent (a staff login: home)
  elsif pos_manages_outlet(p_branch_id) then
    v_branch := p_branch_id;
  else
    raise exception 'This outlet is not one of yours';
  end if;
  if not exists (select 1 from print_routes where branch_id = v_branch and name = p_route) then
    raise exception 'No printer is set for route %', p_route;
  end if;
  insert into print_jobs(branch_id, route, kind, payload)
  values (v_branch, p_route, 'ticket', jsonb_build_object(
    'kind', 'ticket', 'route', p_route, 'tableLabel', 'TEST', 'orderNo', 'TEST01', 'source', 'test',
    'placedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'lines', jsonb_build_array(jsonb_build_object('qty', 1, 'name', 'Test print — ' || p_route, 'note', null, 'mods', '[]'::jsonb))))
  returning id into v_id;
  return v_id;
end $function$;

notify pgrst, 'reload schema';
select 'pos device till applied' as result;
