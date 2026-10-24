-- ============================================================================
-- Craft OS — POS Phase 1 · Approvals, voids, move, merge, refunds, open table
-- (2026-10-24). Run after migration-2026-10-24-pos-checkout.sql and -fn.sql. Idempotent.
--
-- A wrong approver PIN must leave its mark (5 wrong = locked 10 minutes), so the
-- protected functions do NOT raise on a wrong PIN — a raise would roll the
-- counter back. They answer {"ok": false, "error": "..."} instead, and
-- {"ok": true, ...} when done. Every other refusal is a raised exception.
-- refund_bill here is an old body: migration-2026-10-24-pos-checkout-fixes.sql and then
-- migration-2026-10-24-pos-shifts-fn.sql re-create it — re-run both after this file.
-- ============================================================================

-- ── Who may approve at the caller's branch ─────────────────────────────────
create or replace function pos_approvers() returns table (staff_id uuid, name text, has_pin boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.id, s.name, exists (select 1 from staff_pos_pins p where p.staff_id = s.id)
    from staff s
   where s.is_active and s.status = 'active' and s.branch_id = pos_my_branch() and staff_has_cap(s.id, 'pos_supervise')
   order by s.name
$$;
revoke all on function pos_approvers() from public, anon;
grant execute on function pos_approvers() to authenticated;

-- ── One PIN attempt: null = right; otherwise the words to show ──────────────
-- Wrong tries older than a day are forgotten (updated_at is stamped on every failure).
create or replace function pos_pin_attempt(p_staff_id uuid, p_pin text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pin staff_pos_pins;
  v_n   integer;
begin
  select * into v_pin from staff_pos_pins where staff_id = p_staff_id for update;
  if not found then
    return 'No POS PIN is set for this person yet — they set one under My PIN';
  end if;
  if v_pin.locked_until is not null and v_pin.locked_until > now() then
    return 'Too many wrong PINs — locked until ' || to_char(v_pin.locked_until at time zone 'Asia/Kuala_Lumpur', 'HH24:MI');
  end if;
  if p_pin is not null and p_pin ~ '^\d{4,6}$' and v_pin.pin_hash = extensions.crypt(p_pin, v_pin.pin_hash) then
    update staff_pos_pins set failed_attempts = 0, locked_until = null where staff_id = p_staff_id;
    return null;
  end if;
  v_n := case when v_pin.updated_at < now() - interval '1 day' then 0 else v_pin.failed_attempts end + 1;
  if v_n >= 5 then
    update staff_pos_pins set failed_attempts = 0, locked_until = now() + interval '10 minutes', updated_at = now()
     where staff_id = p_staff_id;
    return 'Wrong PIN — locked for 10 minutes after 5 wrong tries';
  end if;
  update staff_pos_pins set failed_attempts = v_n, updated_at = now() where staff_id = p_staff_id;
  return format('Wrong PIN — %s %s left', 5 - v_n, case when 5 - v_n = 1 then 'try' else 'tries' end);
end $$;
revoke all on function pos_pin_attempt(uuid, text) from public, anon, authenticated;

-- ── My PIN: 4–6 digits; changing an existing PIN needs the current one ─────
create or replace function set_my_pos_pin(p_new_pin text, p_current_pin text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_err text;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if not exists (select 1 from staff where id = auth.uid() and is_active and status = 'active') then
    raise exception 'Your account is not active';
  end if;
  if p_new_pin is null or p_new_pin !~ '^\d{4,6}$' then raise exception 'The PIN must be 4 to 6 digits'; end if;
  if exists (select 1 from staff_pos_pins where staff_id = auth.uid()) then
    v_err := pos_pin_attempt(auth.uid(), p_current_pin);
    if v_err is not null then return jsonb_build_object('ok', false, 'error', 'Current PIN: ' || v_err); end if;
  end if;
  insert into staff_pos_pins(staff_id, pin_hash)
  values (auth.uid(), extensions.crypt(p_new_pin, extensions.gen_salt('bf')))
  on conflict (staff_id) do update
     set pin_hash = excluded.pin_hash, failed_attempts = 0, locked_until = null, updated_at = now();
  return jsonb_build_object('ok', true);
end $$;
revoke all on function set_my_pos_pin(text, text) from public, anon;
grant execute on function set_my_pos_pin(text, text) to authenticated;

-- a forgotten PIN: a settings holder of the same branch clears it and the person sets a new one
create or replace function clear_pos_pin(p_staff_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not has_menu_cap('access_settings') then raise exception 'Only a manager can clear a PIN'; end if;
  if not exists (select 1 from staff where id = p_staff_id and branch_id = pos_my_branch()) then
    raise exception 'This person is not staff of your branch';
  end if;
  delete from staff_pos_pins where staff_id = p_staff_id;
end $$;
revoke all on function clear_pos_pin(uuid) from public, anon;
grant execute on function clear_pos_pin(uuid) to authenticated;

-- ── Approver check, inside every protected RPC: raise for a wrong person,
--    return the PIN words (or null) so a wrong PIN still counts ─────────────
create or replace function pos_check_approver(p_branch_id uuid, p_approver_id uuid, p_pin text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_approver_id is null then raise exception 'Choose who approves'; end if;
  if not exists (select 1 from staff s where s.id = p_approver_id and s.is_active and s.status = 'active'
                   and s.branch_id = p_branch_id) then
    raise exception 'The approver is not active staff of this branch';
  end if;
  if not staff_has_cap(p_approver_id, 'pos_supervise') then
    raise exception 'This person cannot approve voids or refunds';
  end if;
  return pos_pin_attempt(p_approver_id, p_pin);
end $$;
revoke all on function pos_check_approver(uuid, uuid, text) from public, anon, authenticated;

-- ── Reason templates: same rule and words as reasonProblem (reasons.ts) ────
-- no template saved for the action = a reason is required, any wording
create or replace function pos_check_reason(p_branch_id uuid, p_action text, p_reason text) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_t      reason_templates;
  v_reason text := nullif(trim(p_reason), '');
begin
  select * into v_t from reason_templates where branch_id = p_branch_id and action = p_action;
  if not found then
    v_t.reasons := '{}'; v_t.compulsory := true; v_t.allow_other := true;
  end if;
  if v_reason is null then
    if v_t.compulsory then raise exception 'Choose a reason'; end if;
    return null;
  end if;
  if not v_t.allow_other and not (v_reason = any (v_t.reasons)) then
    raise exception 'Choose one of the listed reasons';
  end if;
  if length(v_reason) > 200 then raise exception 'Reason is too long'; end if;
  return v_reason;
end $$;
revoke all on function pos_check_reason(uuid, text, text) from public, anon, authenticated;

-- ── VOID tickets: one per order and route, so the kitchen stops those lines ─
-- Same routing as pos_insert_order's tickets; payload = TicketPayload with void: true.
create or replace function pos_queue_void_tickets(p_item_ids uuid[]) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into print_jobs(branch_id, order_id, route, kind, payload)
  select o.branch_id, o.id, l.route, 'ticket', jsonb_build_object(
           'kind', 'ticket', 'route', l.route, 'tableLabel', t.label, 'orderNo', o.order_no,
           'source', o.source,
           'placedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'void', true,
           'lines', jsonb_agg(jsonb_build_object('qty', l.qty, 'name', l.name, 'note', l.note, 'mods', l.mods)
                              order by l.kind_order, l.name))
    from (
      select oi.order_id, oi.print_route as route, 1 as kind_order, oi.name_snapshot as name, oi.qty, oi.note,
             coalesce((select jsonb_agg(m->>'name' order by ord)
                         from jsonb_array_elements(oi.modifiers_snapshot) with ordinality as x(m, ord)), '[]'::jsonb) as mods
        from order_items oi
       where oi.id = any (p_item_ids) and oi.print_route is not null
      union all
      select oi.order_id, m->>'route', 2, m->>'name', oi.qty, 'for ' || oi.name_snapshot, '[]'::jsonb
        from order_items oi cross join jsonb_array_elements(oi.modifiers_snapshot) m
       where oi.id = any (p_item_ids) and m->>'route' is not null
         and m->>'route' is distinct from oi.print_route
    ) l
    join orders o on o.id = l.order_id
    join bills b on b.id = o.bill_id
    left join dining_tables t on t.id = b.table_id
   group by o.id, o.branch_id, o.order_no, o.source, t.label, l.route
$$;
revoke all on function pos_queue_void_tickets(uuid[]) from public, anon, authenticated;

-- ── Void one item of an open bill (approver + reason) ──────────────────────
create or replace function void_order_item(p_item_id uuid, p_reason text, p_approver_id uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
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
     set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason, void_approved_by = p_approver_id
   where id = p_item_id;
  perform pos_queue_void_tickets(array[p_item_id]);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function void_order_item(uuid, text, uuid, text) from public, anon;
grant execute on function void_order_item(uuid, text, uuid, text) to authenticated;

-- ── Void a whole open bill. A bill with nothing left on it (opened by mistake,
--    or every item already voided with approval) closes without a second approval ─
create or replace function void_bill(p_bill_id uuid, p_reason text, p_approver_id uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
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
       set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason, void_approved_by = p_approver_id
     where id = any (v_ids);
  else
    v_reason := nullif(trim(left(p_reason, 200)), '');
  end if;
  update bills
     set status = 'voided', closed_at = now(), closed_by = auth.uid(), void_reason = v_reason,
         void_approved_by = case when cardinality(v_ids) > 0 then p_approver_id end
   where id = v_bill.id;
  perform pos_queue_void_tickets(v_ids);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function void_bill(uuid, text, uuid, text) from public, anon;
grant execute on function void_bill(uuid, text, uuid, text) to authenticated;

-- ── Move an open dine-in bill to an empty table (any staff, no reprint) ────
create or replace function move_bill(p_bill_id uuid, p_table_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_bill   bills;
  v_label  text;
begin
  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  if v_bill.status <> 'open' then raise exception 'Only an open bill can move'; end if;
  if v_bill.order_type <> 'dine_in' then raise exception 'Only a dine-in bill can move to another table'; end if;
  if v_bill.table_id = p_table_id then return; end if;
  select label into v_label from dining_tables where id = p_table_id and branch_id = v_branch and is_active;
  if not found then raise exception 'Invalid table'; end if;
  if exists (select 1 from bills where table_id = p_table_id and status = 'open') then
    raise exception 'Table % already has an open bill — merge instead', v_label;
  end if;
  begin
    update bills set table_id = p_table_id where id = v_bill.id;
  exception when unique_violation then
    raise exception 'Table % already has an open bill — merge instead', v_label;
  end;
end $$;
revoke all on function move_bill(uuid, uuid) from public, anon;
grant execute on function move_bill(uuid, uuid) to authenticated;

-- ── Merge: every order and item of p_from_bill moves to p_into_bill ────────
create or replace function merge_bills(p_from_bill uuid, p_into_bill uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
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
     set status = 'merged', merged_into = v_into.id, closed_at = now(), closed_by = auth.uid()
   where id = v_from.id;
end $$;
revoke all on function merge_bills(uuid, uuid) from public, anon;
grant execute on function merge_bills(uuid, uuid) to authenticated;

-- ── Refund slip payload: exactly RefundSlipPayload (src/features/pos/print/receipt.ts) ─
create or replace function pos_refund_slip_payload(p_refund_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'kind', 'refund',
    'route', s.receipt_route,
    'title', coalesce(nullif(trim(br.receipt_title), ''), br.name),
    'billNo', b.bill_no,
    'refundedAt', to_char(rf.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'amountSen', rf.amount_sen,
    'methodName', rf.method_name,
    'reason', rf.reason,
    'refundedBy', (select st.name from staff st where st.id = rf.created_by),
    'approvedBy', (select st.name from staff st where st.id = rf.approved_by))
  from refunds rf
  join bills b on b.id = rf.bill_id
  join branches br on br.id = b.branch_id
  left join branch_pos_settings s on s.branch_id = b.branch_id
  where rf.id = p_refund_id
$$;
revoke all on function pos_refund_slip_payload(uuid) from public, anon, authenticated;

-- ── Refund on a paid bill (approver + reason), idempotent on p_refund_id ───
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
    if v_existing.bill_id <> p_bill_id or v_existing.branch_id <> v_branch then
      raise exception 'This refund id belongs to another bill';
    end if;
    return jsonb_build_object('ok', true, 'refundedSen', (select refunded_sen from bills where id = p_bill_id),
                              'slipQueued', v_existing.slip_queued);
  end if;
  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  select * into v_existing from refunds where id = p_refund_id;        -- the same refund won while we waited
  if found then
    return jsonb_build_object('ok', true, 'refundedSen', v_bill.refunded_sen, 'slipQueued', v_existing.slip_queued);
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
  return jsonb_build_object('ok', true, 'refundedSen', v_bill.refunded_sen + p_amount_sen, 'slipQueued', v_route is not null);
end $$;
revoke all on function refund_bill(uuid, uuid, integer, uuid, text, uuid, text) from public, anon;
grant execute on function refund_bill(uuid, uuid, integer, uuid, text, uuid, text) to authenticated;

-- ── Open a table before anything is ordered (needed when qr_requires_open_bill is on) ─
create or replace function open_table(p_table_id uuid, p_pax integer) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch  uuid := pos_my_branch();
  v_bill_id uuid;
begin
  if p_pax is not null and (p_pax < 1 or p_pax > 99) then raise exception 'Invalid number of guests'; end if;
  if not exists (select 1 from dining_tables where id = p_table_id and branch_id = v_branch and is_active) then
    raise exception 'Invalid table';
  end if;
  select id into v_bill_id from bills where table_id = p_table_id and status = 'open';
  if v_bill_id is null then
    insert into bills(branch_id, bill_no, table_id, order_type, pax)
    values (v_branch, pos_next_bill_no(v_branch), p_table_id, 'dine_in', p_pax)
    on conflict (table_id) where status = 'open' and table_id is not null do nothing
    returning id into v_bill_id;
    if v_bill_id is null then                       -- lost the race: the table was just opened
      select id into v_bill_id from bills where table_id = p_table_id and status = 'open';
    end if;
  elsif p_pax is not null then
    update bills set pax = p_pax where id = v_bill_id and pax is null;
  end if;
  return v_bill_id;
end $$;
revoke all on function open_table(uuid, integer) from public, anon;
grant execute on function open_table(uuid, integer) to authenticated;

select 'bill action functions applied' as result;
