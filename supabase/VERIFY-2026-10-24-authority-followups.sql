-- VERIFY — go/no-go gate for migration-2026-10-24-authority-followups.sql
--   (staff.status guard, registration_requests RLS + guard, auth_user_id_by_email)
--
-- Run as postgres (SQL Editor or Management API) AFTER the migration.
-- Read-only in effect: every probe runs inside a sub-block that always ends
-- in an exception, so Postgres rolls it back (rows it set up, the write it
-- tried, and the role it switched to). Nothing is left behind.
--
-- Result: one row per persona, a `pass` column per row, and `all_pass` on
-- every row. GO only if all_pass = true.
--
-- Personas (picked from live staff rows, active):
--   trainee       rank trainee, system_role staff            — missing = FAIL
--   supervisor    system_role supervisor, rank <> manager    — missing = FAIL
--   hr            system_role hr, rank <> manager            — missing = SKIPPED
--   rank-manager  rank manager, system_role staff/supervisor — missing = SKIPPED
--   admin         system_role admin                          — missing = SKIPPED
--   owner         system_role owner                          — missing = FAIL
--   anon          role anon, no user
--   service       role service_role, no user (provision-staff)
-- "reviewer"     = supervisor, hr, rank-manager, admin, owner (may read and
--                  reject registration requests).
-- "manager-tier" = rank-manager, admin, owner.
--
-- Columns and what passes:
--   st_other     set another (non-owner) person's status to resigned
--                  manager-tier: allowed   supervisor/hr: guard   trainee: rls-0-rows
--   st_owner     set the owner's status to resigned
--                  owner (own row): allowed   trainee: rls-0-rows   else guard
--   st_self      set their own status to resigned
--                  manager-tier: allowed   else guard
--   rr_reject    reject a pending request the way Directory does, sending
--                reviewed_at = 2000-01-01
--                  reviewer: allowed (= landed AND reviewed_at was stamped by
--                  the server; `unstamped` fails)   else rls-0-rows
--   rr_email     the same reject, but also changing the email
--                  reviewer: guard   else rls-0-rows
--   rr_reopen    set a rejected request back to pending
--                  rls-0-rows for everyone
--   rr_other_rev reject a pending request with reviewed_by = someone else
--                  reviewer: denied   else rls-0-rows
--   rr_phone     reject a pending request but keep its phone
--                  reviewer: denied   else rls-0-rows
--   rr_delete    delete a pending request
--                  rls-0-rows for everyone
--   lookup       auth_user_id_by_email(<owner's email>) returns the owner's id
--                  service: allowed   else denied
--   anon / service rows only:
--   a_clean      insert a clean pending request            anon: allowed
--   a_decided    insert a request with status approved      anon: denied
--   a_stamped    insert a pending request with reviewed_at  anon: denied
--   s_claim      claim a pending request (reviewed_by / reviewed_at = a
--                given time) as provision-staff does
--                  service: allowed (= reviewed_at kept as given, not stamped)
--   s_approve    mark it approved and clear the phone       service: allowed
-- Outcome words: allowed = the write landed (and its check passed);
-- guard = raised 42501 by a guard trigger ("Only …" message);
-- denied = raised 42501 by RLS or a missing privilege;
-- rls-0-rows = RLS hid the target row (statement matched 0 rows);
-- no-target = nothing to probe against (FAIL); error:… = unexpected (FAIL);
-- n/a = column does not apply to this persona.

drop table if exists _af_verify;
create temp table _af_verify (
  ord int, persona text, status text, uid uuid,
  st_other text, st_owner text, st_self text,
  rr_reject text, rr_email text, rr_reopen text, rr_other_rev text, rr_phone text, rr_delete text,
  lookup text,
  a_clean text, a_decided text, a_stamped text,
  s_claim text, s_approve text,
  pass boolean
);

-- One probe: as postgres run p_setup, switch to p_role, run p_sql; if it
-- touched rows, run p_check as postgres (its text result is the outcome).
-- Always rolls back.
create or replace function pg_temp.vprobe(p_role text, p_setup text, p_sql text, p_check text default null)
returns text
language plpgsql
as $f$
declare
  v_rows int;
  v_out  text;
begin
  begin
    execute 'reset role';
    if p_setup is not null then execute p_setup; end if;
    execute format('set local role %I', p_role);
    execute p_sql;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      v_out := 'rls-0-rows';
    else
      execute 'reset role';
      if p_check is null then v_out := 'allowed'; else execute p_check into v_out; end if;
    end if;
    raise exception using errcode = 'P0001', message = 'rollback-probe';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'rollback-probe' then v_out := 'error:' || sqlerrm; end if;
    when insufficient_privilege then
      v_out := case when sqlerrm like 'Only %' then 'guard' else 'denied' end;
    when others then
      v_out := 'error:' || sqlstate || ' ' || sqlerrm;
  end;
  return v_out;
end;
$f$;

do $$
declare
  p          record;
  v_owner    uuid;
  v_oemail   text;
  v_target   uuid;
  v_other    uuid;
  v_req      uuid;
  v_role     text;
  v_new      text;   -- setup: insert one pending request with id v_req
  v_new_rej  text;   -- setup: insert one rejected request with id v_req
  v_reject   text;   -- the Directory reject, minus the WHERE
  r          _af_verify%rowtype;
  v_reviewer boolean;
begin
  select id into v_owner from staff where system_role = 'owner' order by id limit 1;
  select email into v_oemail from auth.users where id = v_owner;

  for p in
    select * from (values
      (1, 'trainee',
          (select id from staff where rank = 'trainee' and system_role = 'staff'
             and status = 'active' order by id limit 1),
          true,  false, false, false),
      (2, 'supervisor',
          (select id from staff where system_role = 'supervisor' and rank <> 'manager'
             and status = 'active' order by id limit 1),
          true,  true,  false, false),
      (3, 'hr',
          (select id from staff where system_role = 'hr' and rank <> 'manager'
             and status = 'active' order by id limit 1),
          false, true,  false, false),
      (4, 'rank-manager',
          (select id from staff where rank = 'manager' and system_role in ('staff','supervisor')
             and status = 'active' order by id limit 1),
          false, true,  true,  false),
      (5, 'admin',
          (select id from staff where system_role = 'admin'
             and status = 'active' order by id limit 1),
          false, true,  true,  false),
      (6, 'owner', v_owner,
          true,  true,  true,  true),
      (7, 'anon',    null::uuid, true, false, false, false),
      (8, 'service', null::uuid, true, false, false, false)
    ) as t(ord, persona, uid, required, reviewer, mgr_tier, is_owner)
  loop
    r := null;
    r.ord := p.ord; r.persona := p.persona; r.uid := p.uid;

    if p.ord <= 6 and p.uid is null then
      r.status := case when p.required then 'MISSING' else 'SKIPPED' end;
      r.pass   := not p.required;
      insert into _af_verify select r.*;
      continue;
    end if;
    r.status := 'ok';

    v_role := case p.persona when 'anon' then 'anon'
                             when 'service' then 'service_role'
                             else 'authenticated' end;
    perform set_config('request.jwt.claims',
      case when p.uid is null then json_build_object('role', v_role)
           else json_build_object('sub', p.uid, 'role', 'authenticated') end::text, true);

    -- Targets, as postgres.
    select id into v_target from staff
     where status = 'active' and system_role is distinct from 'owner'
       and id is distinct from p.uid
     order by (rank = 'trainee') desc, id limit 1;
    select id into v_other from staff where id is distinct from p.uid order by id limit 1;

    v_req := gen_random_uuid();
    v_new := format(
      'insert into registration_requests (id, full_name, email, phone, status)
       values (%L, %L, %L, %L, %L)',
      v_req, '[VERIFY probe]', 'verify-' || v_req || '@test.invalid', '0000000000', 'pending');
    v_new_rej := replace(v_new, '''pending'')', '''rejected'')');
    v_reject := format(
      'update registration_requests set status = %L, reviewed_by = %L,
              reviewed_at = %L, rejection_reason = %L, phone = null',
      'rejected', p.uid, '2000-01-01T00:00:00Z', '[VERIFY probe]');

    if p.ord <= 6 then
      -- ── staff.status ──────────────────────────────────────────────────────
      r.st_other := case when v_target is null then 'no-target' else pg_temp.vprobe(v_role, null,
        format('update staff set status = %L where id = %L', 'resigned', v_target)) end;
      r.st_owner := pg_temp.vprobe(v_role, null,
        format('update staff set status = %L where id = %L', 'resigned', v_owner));
      r.st_self  := pg_temp.vprobe(v_role, null,
        format('update staff set status = %L where id = %L', 'resigned', p.uid));

      -- ── registration_requests ─────────────────────────────────────────────
      r.rr_reject := pg_temp.vprobe(v_role, v_new,
        v_reject || format(' where id = %L and status = %L', v_req, 'pending'),
        format('select case when reviewed_at > %L then %L else %L end
                  from registration_requests where id = %L',
               '2001-01-01', 'allowed', 'unstamped', v_req));
      r.rr_email := pg_temp.vprobe(v_role, v_new,
        replace(v_reject, 'phone = null', 'phone = null, email = ''verify-changed@test.invalid''')
          || format(' where id = %L', v_req));
      r.rr_reopen := pg_temp.vprobe(v_role, v_new_rej,
        format('update registration_requests set status = %L where id = %L', 'pending', v_req));
      r.rr_other_rev := case when v_other is null then 'no-target' else pg_temp.vprobe(v_role, v_new,
        replace(v_reject, format('reviewed_by = %L', p.uid), format('reviewed_by = %L', v_other))
          || format(' where id = %L', v_req)) end;
      r.rr_phone := pg_temp.vprobe(v_role, v_new,
        replace(v_reject, ', phone = null', '') || format(' where id = %L', v_req));
      r.rr_delete := pg_temp.vprobe(v_role, v_new,
        format('delete from registration_requests where id = %L', v_req));
    end if;

    -- ── auth_user_id_by_email ───────────────────────────────────────────────
    r.lookup := case when v_oemail is null then 'no-target' else pg_temp.vprobe(v_role, null,
      format('select 1 from (select public.auth_user_id_by_email(%L) as id) x where x.id = %L',
             upper(v_oemail), v_owner)) end;

    if p.persona = 'anon' then
      r.a_clean := pg_temp.vprobe(v_role, null,
        format('insert into registration_requests (full_name, email, phone) values (%L, %L, %L)',
               '[VERIFY probe]', 'verify-' || gen_random_uuid() || '@test.invalid', '0000000000'));
      r.a_decided := pg_temp.vprobe(v_role, null,
        format('insert into registration_requests (full_name, email, status) values (%L, %L, %L)',
               '[VERIFY probe]', 'verify-' || gen_random_uuid() || '@test.invalid', 'approved'));
      r.a_stamped := pg_temp.vprobe(v_role, null,
        format('insert into registration_requests (full_name, email, reviewed_at) values (%L, %L, %L)',
               '[VERIFY probe]', 'verify-' || gen_random_uuid() || '@test.invalid', '2100-01-01T00:00:00Z'));
    end if;

    if p.persona = 'service' then
      r.s_claim := pg_temp.vprobe(v_role, v_new,
        format('update registration_requests set reviewed_by = %L, reviewed_at = %L
                 where id = %L and status = %L', v_owner, '2000-01-01T00:00:00Z', v_req, 'pending'),
        format('select case when reviewed_at = %L::timestamptz then %L else %L end
                  from registration_requests where id = %L',
               '2000-01-01T00:00:00Z', 'allowed', 'stamped', v_req));
      r.s_approve := pg_temp.vprobe(v_role, v_new,
        format('update registration_requests set status = %L, phone = null where id = %L',
               'approved', v_req));
    end if;

    -- ── Expectations ────────────────────────────────────────────────────────
    v_reviewer := p.reviewer;
    if p.ord <= 6 then
      r.pass :=
            r.st_other = case when p.mgr_tier then 'allowed'
                              when v_reviewer then 'guard' else 'rls-0-rows' end
        and r.st_owner = case when p.is_owner then 'allowed'
                              when p.persona = 'trainee' then 'rls-0-rows' else 'guard' end
        and r.st_self  = case when p.mgr_tier then 'allowed' else 'guard' end
        and r.rr_reject    = case when v_reviewer then 'allowed' else 'rls-0-rows' end
        and r.rr_email     = case when v_reviewer then 'guard'   else 'rls-0-rows' end
        and r.rr_reopen    = 'rls-0-rows'
        and r.rr_other_rev = case when v_reviewer then 'denied'  else 'rls-0-rows' end
        and r.rr_phone     = case when v_reviewer then 'denied'  else 'rls-0-rows' end
        and r.rr_delete    = 'rls-0-rows'
        and r.lookup       = 'denied';
    elsif p.persona = 'anon' then
      r.pass := r.lookup = 'denied' and r.a_clean = 'allowed'
            and r.a_decided = 'denied' and r.a_stamped = 'denied';
    else
      r.pass := r.lookup = 'allowed' and r.s_claim = 'allowed' and r.s_approve = 'allowed';
    end if;
    r.pass := coalesce(r.pass, false);

    insert into _af_verify select r.*;
  end loop;

  perform set_config('request.jwt.claims', null, true);
end;
$$;

select v.*, bool_and(v.pass) over () as all_pass
from _af_verify v
order by v.ord;
