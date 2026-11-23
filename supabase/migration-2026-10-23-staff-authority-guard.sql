-- 2026-10-23 — Close the staff rank / system_role escalation paths
--
-- WHY. supervisor and hr hold manage_staff, and the staff RLS policies
-- (migration-2026-07-08-rls-system-role.sql:227-233) are row-scoped only:
--   staff_insert  with check (current_rank() = 'manager'
--                  or current_system_role() in ('hr','supervisor','manager','admin','owner'))
--   staff_update  using (id = auth.uid() or current_rank() in ('supervisor','manager')
--                  or current_system_role() in ('hr','supervisor','manager','admin','owner'))
-- staff_guard_authority_update() (migration-2026-09-02-late-reason-
-- notifications.sql, v12) only guarded the caller's OWN row
-- (`if old.id <> auth.uid() then return new`). So a supervisor could:
--   (a) call provision-staff `create` with rank 'manager' (fixed in the
--       Edge Function, but this trigger is the real boundary);
--   (b) `update staff set system_role = 'admin' where id = <a friend>` or
--       promote anyone to rank 'manager' — and the friend then passes every
--       manager-tier check in the app, including reading staff_private;
--   (c) insert a staff row directly with any rank / system_role.
-- staff_private's reader rule (can_read_staff_private) is only as strong as
-- staff.rank / staff.system_role, so this closes those paths before the
-- private-fields split ships.
--
-- THE RULE (decided 2026-10-23, D1):
--   manager-tier = current_rank() = 'manager'
--                  or current_system_role() in ('manager','admin','owner')
--   * system_role: only the owner (current_is_owner()) may change it on any
--     row, or insert a row with anything other than 'staff'. Matches the
--     app's manage_system_roles capability, which is owner-only
--     (src/shared/types/index.ts; Settings → System Roles is rendered only
--     `isOwner`, src/features/settings/Settings.tsx:732/759).
--   * rank: manager-tier may set any rank. Everyone else may only move a rank
--     within ('trainee','junior','senior') — old AND new both in that set —
--     and may only insert rows whose rank is in that set.
--   * status: other people's rows unchanged (governed by staff_update RLS as
--     before; not an escalation vector). The caller's OWN row keeps the v12
--     protection: a non-manager-tier caller may not change their own rank,
--     system_role or status (same message as before).
--   * auth.uid() is null (service role — provision-staff, SQL editor, cron,
--     migrations) is allowed through, as before. staff has no anonymous
--     access path, so RLS fails closed for anon before this trigger runs.
--
-- Legitimate writers checked against this rule (2026-10-23):
--   Settings → System Roles assignRole()  system_role   owner only (UI) → allowed
--   StaffProfile save()                   rank          isManager = rank 'manager' → allowed
--   StaffProfile handleSetStatus()        status        rank 'manager', others' rows → allowed
--   provision-staff create / approve      rank, system_role  service role → allowed
--   ProbationReview hire / eliminate      onboarding_completed / is_active only → not guarded
--   Reviews promotion approval            job_title_id only → not guarded
--   award_xp_* triggers                   xp / level only → not guarded
--   migration backfills (rbac 78-87)      auth.uid() null → allowed
--
-- BOOTSTRAP: unchanged from v12. The owner can still demote themselves; the
-- way back is an operator update with auth.uid() null (SQL editor).
--
-- This REPLACES staff_guard_authority_update() and its trigger from the
-- 2026-09-02 file; it does not add a second guard. If that older file is ever
-- re-run, it restores the old own-row-only version — re-run this file after it.
--
-- Independent of the staff_private migrations. Requires
-- migration-2026-07-06-rbac.sql (current_system_role(), current_is_owner()).
-- Idempotent: create or replace + drop trigger if exists / create trigger.

begin;

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

  return new;
end;
$$;

drop trigger if exists staff_guard_authority_update_trg on staff;
create trigger staff_guard_authority_update_trg
  before insert or update on staff
  for each row execute function staff_guard_authority_update();

commit;

-- Sanity (expect two rows: INSERT and UPDATE, both BEFORE):
select event_manipulation, action_timing
from information_schema.triggers
where event_object_table = 'staff' and trigger_name = 'staff_guard_authority_update_trg'
order by event_manipulation;
