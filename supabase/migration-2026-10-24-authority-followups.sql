-- 2026-10-24 — Authority follow-ups from the staff-private-fields spec
-- (docs/superpowers/specs/2026-10-24-authority-followups-design.md)
--
-- 1. staff.status on OTHER people's rows. staff_update RLS lets supervisor
--    and hr update any staff row, and staff_guard_authority_update() (2026-10-23)
--    left status alone on other rows — so a supervisor could mark the owner
--    `resigned`, which locks them out of the app (App.tsx) and provision-staff.
--    THE RULE (decided 2026-10-24):
--      * changing another person's status needs manager-tier
--        (current_rank() = 'manager' or current_system_role() in
--        ('manager','admin','owner'));
--      * an owner's status can be changed only by the owner.
--    Writers checked (2026-10-24): StaffProfile handleSetStatus() — UI is
--    rank 'manager' only → allowed; ProbationReview eliminate writes is_active,
--    not status; provision-staff and SQL jobs run with auth.uid() null or only
--    read status → unaffected.
--
-- 2. registration_requests. registration_requests_manage was `for all`, so the
--    reviewer set could edit any request's email / phone / status /
--    reviewed_at, reset decided requests to pending, and delete them. Now:
--      * select  — same reviewer set as before;
--      * update  — only pending rows, and only into status 'rejected' with
--                  reviewed_by = the caller and phone cleared (the Directory
--                  reject flow); approve runs through provision-staff's
--                  service role and is not affected;
--      * delete  — no policy, so no client deletes;
--      * insert  — anon/authenticated may only insert a clean pending row;
--      * a BEFORE UPDATE trigger keeps the applicant's details unchanged on
--        client updates and stamps reviewed_at with the server clock.
--
-- 3. auth_user_id_by_email(). provision-staff approve looked an existing login
--    up with listUsers page 1 (1000 users). This looks it up directly in
--    auth.users. Executable by service_role only: it turns an email into a
--    user id.
--
-- Deploy order: this file, then the provision-staff function that calls
-- auth_user_id_by_email (the old function does not need it).
--
-- This REPLACES staff_guard_authority_update() from
-- migration-2026-10-23-staff-authority-guard.sql (same trigger). If that
-- file is ever re-run, re-run this one after it.
--
-- Requires migration-2026-07-06-rbac.sql (current_system_role(),
-- current_is_owner()) and migration-2026-10-23-staff-authority-guard.sql.
-- Idempotent.

begin;

-- ── 1. staff authority guard ──────────────────────────────────────────────
create or replace function staff_guard_authority_update()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_low      constant text[] := array['trainee','junior','senior'];
  v_mgr_tier boolean;
  v_owner    boolean;
begin
  if tg_op = 'UPDATE'
     and new.rank is not distinct from old.rank
     and new.system_role is not distinct from old.system_role
     and new.status is not distinct from old.status then
    return new;
  end if;

  if auth.uid() is null then
    return new;
  end if;

  -- Read before the row changes (BEFORE trigger), so these describe the
  -- caller as they were going into this statement.
  v_mgr_tier := coalesce(current_rank() = 'manager', false)
             or coalesce(current_system_role() in ('manager','admin','owner'), false);
  v_owner    := coalesce(current_is_owner(), false);

  if tg_op = 'INSERT' then
    if new.system_role is distinct from 'staff' and not v_owner then
      raise exception 'Only the owner can create staff with a system role other than staff.'
        using errcode = '42501';
    end if;
    if not v_mgr_tier and not coalesce(new.rank = any(v_low), false) then
      raise exception 'Only a manager can create staff at supervisor rank or above.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- UPDATE
  if old.id = auth.uid() and not v_mgr_tier then
    raise exception 'Only a manager can change your own rank, system role, or status.'
      using errcode = '42501';
  end if;

  if new.system_role is distinct from old.system_role and not v_owner then
    raise exception 'Only the owner can change a staff member''s system role.'
      using errcode = '42501';
  end if;

  if new.rank is distinct from old.rank and not v_mgr_tier
     and not (coalesce(old.rank = any(v_low), false) and coalesce(new.rank = any(v_low), false)) then
    raise exception 'Only a manager can change a rank to or from supervisor or manager.'
      using errcode = '42501';
  end if;

  if new.status is distinct from old.status and old.id <> auth.uid() then
    if not v_mgr_tier then
      raise exception 'Only a manager can change another staff member''s status.'
        using errcode = '42501';
    end if;
    if old.system_role = 'owner' and not v_owner then
      raise exception 'Only the owner can change the owner''s status.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists staff_guard_authority_update_trg on staff;
create trigger staff_guard_authority_update_trg
  before insert or update on staff
  for each row execute function staff_guard_authority_update();

-- ── 2. registration_requests ──────────────────────────────────────────────
drop policy if exists "registration_requests_manage" on registration_requests;

drop policy if exists "registration_requests_select" on registration_requests;
create policy "registration_requests_select" on registration_requests for select
  using ((current_rank() in ('supervisor','manager') or current_system_role() in ('hr','supervisor','manager','admin','owner')));

drop policy if exists "registration_requests_reject" on registration_requests;
create policy "registration_requests_reject" on registration_requests for update
  using ((current_rank() in ('supervisor','manager') or current_system_role() in ('hr','supervisor','manager','admin','owner'))
         and status = 'pending')
  with check ((current_rank() in ('supervisor','manager') or current_system_role() in ('hr','supervisor','manager','admin','owner'))
              and status = 'rejected'
              and reviewed_by = auth.uid()
              and phone is null);

drop policy if exists "registration_requests_insert" on registration_requests;
create policy "registration_requests_insert" on registration_requests for insert
  to anon, authenticated
  with check (status = 'pending'
              and reviewed_by is null
              and reviewed_at is null
              and rejection_reason is null);

create or replace function registration_requests_guard_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Service role (provision-staff claim / release / approve, SQL editor).
  if auth.uid() is null then
    return new;
  end if;

  if new.id              is distinct from old.id
     or new.full_name       is distinct from old.full_name
     or new.email           is distinct from old.email
     or new.branch          is distinct from old.branch
     or new.department      is distinct from old.department
     or new.employment_type is distinct from old.employment_type
     or new.created_at      is distinct from old.created_at then
    raise exception 'Only the reviewer decision can be changed on a registration request.'
      using errcode = '42501';
  end if;

  new.reviewed_at := now();
  return new;
end;
$$;

drop trigger if exists registration_requests_guard_update_trg on registration_requests;
create trigger registration_requests_guard_update_trg
  before update on registration_requests
  for each row execute function registration_requests_guard_update();

-- ── 3. auth_user_id_by_email ──────────────────────────────────────────────
create or replace function auth_user_id_by_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id
  from auth.users u
  where lower(u.email) = lower(trim(p_email))
  order by u.is_sso_user, u.created_at
  limit 1
$$;

revoke all on function auth_user_id_by_email(text) from public, anon, authenticated;
grant execute on function auth_user_id_by_email(text) to service_role;

commit;

-- Sanity (expect: 0 manage policies; 3 policies select/update/insert;
-- both triggers present; authenticated cannot execute the lookup):
select
  (select count(*) from pg_policies where tablename = 'registration_requests'
     and policyname = 'registration_requests_manage')                          as manage_policies,
  (select string_agg(policyname || ':' || cmd, ', ' order by policyname)
     from pg_policies where tablename = 'registration_requests')                as reg_policies,
  (select count(*) from information_schema.triggers
     where trigger_name in ('staff_guard_authority_update_trg',
                            'registration_requests_guard_update_trg'))          as trigger_events,
  has_function_privilege('authenticated', 'auth_user_id_by_email(text)', 'execute') as authenticated_can_lookup,
  has_function_privilege('service_role',  'auth_user_id_by_email(text)', 'execute') as service_can_lookup;
