-- 2026-10-23 — Org Chart: a narrow read of the reporting tree, plus a guard
-- against reporting loops.
--
-- get_org_chart(): every active staff member can open the Org Chart, so it
-- needs every live person's name, rank, title, branch and supervisor. It
-- returns ONLY those columns, never IC number, phone, address or date of
-- birth, so the chart keeps working if staff_select is later narrowed to self
-- or same-branch, and so the page never pulls sensitive columns into the
-- browser.
--
-- Liveness rule (matches notify_late): a person is live when
-- status = 'active' and is_active. A probation elimination sets
-- is_active = false and leaves status = 'active', so both must be checked.
-- Only callers who are themselves live staff get rows; resigned or eliminated
-- logins, and any future non-staff accounts, get none.
--
-- staff_guard_supervisor_loop: staff_supervisor_not_self_check already stops
-- A → A. This also stops A → B → A (and longer loops), which would make a
-- chain that never reaches the owner. Only fires when supervisor_id actually
-- changes, so a profile save that resends an unchanged value never trips on
-- old data.
--
-- Idempotent: safe to re-run.

begin;

create or replace function get_org_chart()
returns table (
  id uuid,
  name text,
  nickname text,
  avatar text,
  rank text,
  system_role text,
  job_title text,
  branch text,
  department text,
  supervisor_id uuid
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.id, s.name::text, s.nickname::text, s.avatar::text, s.rank::text,
         s.system_role::text, r.name::text, s.branch::text, s.department::text,
         s.supervisor_id
  from staff s
  left join roles r on r.id = s.job_title_id
  where s.status = 'active' and s.is_active
    and exists (select 1 from staff me where me.id = auth.uid() and me.status = 'active' and me.is_active)
  order by s.name;
$$;

revoke all on function get_org_chart() from public, anon;
grant execute on function get_org_chart() to authenticated;

create or replace function staff_guard_supervisor_loop()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cur uuid := new.supervisor_id;
  v_steps int := 0;
begin
  if new.supervisor_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.supervisor_id is not distinct from old.supervisor_id then
    return new;
  end if;
  -- Serialises concurrent supervisor changes so two simultaneous saves (A→B, B→A) can't both pass the loop check.
  perform pg_advisory_xact_lock(hashtext('staff.supervisor_id'));
  -- Walk up from the new supervisor; reaching this row means a loop. Bounded
  -- so a loop already present in old data cannot hang the write.
  while v_cur is not null and v_steps < 100 loop
    if v_cur = new.id then
      raise exception 'Supervisor would create a reporting loop';
    end if;
    select s.supervisor_id into v_cur from staff s where s.id = v_cur;
    v_steps := v_steps + 1;
  end loop;
  return new;
end
$$;

drop trigger if exists staff_guard_supervisor_loop on staff;
create trigger staff_guard_supervisor_loop
  before insert or update of supervisor_id on staff
  for each row execute function staff_guard_supervisor_loop();

commit;

-- VERIFY 1 — the function's result has no sensitive columns, and anon cannot
-- call it (expect anon_can = false, auth_can = true):
--   select pg_get_function_result('get_org_chart()'::regprocedure) as result,
--          has_function_privilege('anon', 'get_org_chart()', 'execute') as anon_can,
--          has_function_privilege('authenticated', 'get_org_chart()', 'execute') as auth_can;
--
-- VERIFY 2 — the trigger allows a legal chain and rejects a 2-step loop, a
-- 3-step loop and a self-reference. Self-contained: it creates three [TEST]
-- staff (with placeholder auth.users rows, which cannot sign in) and the final
-- raise rolls the whole block back, so nothing is left behind and it works on
-- a database with fewer than two staff. Read the result from the error
-- message; expect:
--   VERIFY_DONE chain=ok | two_step=Supervisor would create a reporting loop |
--   three_step=Supervisor would create a reporting loop | self=Supervisor would ...
--   do $v$
--   declare a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid();
--           two_step text := '(no error)'; three_step text := '(no error)';
--           self_ref text := '(no error)'; ok_chain text := 'ok';
--   begin
--     insert into auth.users (id, instance_id, aud, role, email) values
--       (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'verify-a@test.invalid'),
--       (b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'verify-b@test.invalid'),
--       (c, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'verify-c@test.invalid');
--     insert into staff (id, name) values (a, '[TEST] A'), (b, '[TEST] B'), (c, '[TEST] C');
--     begin
--       update staff set supervisor_id = a where id = b;   -- c -> b -> a is legal
--       update staff set supervisor_id = b where id = c;
--     exception when others then ok_chain := sqlerrm; end;
--     begin update staff set supervisor_id = b where id = a;   -- a -> b -> a
--     exception when others then two_step := sqlerrm; end;
--     begin update staff set supervisor_id = c where id = a;   -- a -> c -> b -> a
--     exception when others then three_step := sqlerrm; end;
--     begin update staff set supervisor_id = a where id = a;   -- a -> a
--     exception when others then self_ref := sqlerrm; end;
--     raise exception 'VERIFY_DONE chain=% | two_step=% | three_step=% | self=%',
--       ok_chain, two_step, three_step, self_ref;
--   end $v$;
--
-- VERIFY 3 — get_org_chart() returns exactly the live staff when called by an
-- active staff member (expect fn_rows = live_rows). Impersonates the first live
-- staff member inside a transaction that is rolled back, so nothing changes.
-- Note: live_rows is read under the authenticated role, so it relies on
-- staff_select still being using (true); if that policy has been narrowed, run
-- the live_rows count separately as the postgres role.
--   begin;
--   select set_config('request.jwt.claims', json_build_object('sub', (select id from staff where status='active' and is_active limit 1), 'role','authenticated')::text, true);
--   set local role authenticated;
--   select (select count(*) from get_org_chart()) as fn_rows,
--          (select count(*) from staff where status='active' and is_active) as live_rows;
--   rollback;
