-- supabase/migration-2026-10-29-cs-role.sql
-- ============================================================================
-- Customer Service access (2026-10-29)
--
-- staff.cs_role decides who can open the Craft Marketing inbox from Craft OS,
-- and at what level. NULL = no access. Craft Marketing's API reads this column
-- with the service key (auth.uid() is null there) when it issues a sign-in
-- ticket and on every token refresh, so clearing it signs the person out of
-- the inbox within 15 minutes. It also treats status = 'resigned' or
-- is_active = false as "no access" regardless of cs_role.
--
-- THE RULE, enforced by staff_guard_cs_role() (checked in this order):
--   1. A deactivated row (status = 'resigned' or is_active = false) always has
--      cs_role = NULL. The trigger clears it for whoever made the change, and
--      nobody can keep or grant access on a deactivated row.
--   2. Otherwise only an owner or admin may set or change cs_role. Without
--      this, anyone could grant themselves access: staff_update's RLS lets
--      every user update their own row.
--   3. The service key / SQL editor (auth.uid() is null) is let through.
--
-- WHY RULE 1. is_active is not trigger-guarded (staff can set their own
-- is_active = true through the own-row staff_update policy), and HR,
-- supervisors and managers can un-resign colleagues. If cs_role survived
-- deactivation, any of them could silently restore inbox access that only an
-- owner or admin should grant.
--
-- CONSEQUENCE: reactivating someone does NOT restore inbox access. After
-- un-resigning or re-activating, an owner or admin must grant cs_role again.
--
-- Spec: Craft_CSS docs/superpowers/specs/2026-10-29-craft-os-sso-design.md
-- Requires migration-2026-07-06-rbac.sql (current_system_role()).
-- Idempotent: safe to run more than once. Rows already deactivated are not
-- backfilled; the trigger clears cs_role the next time such a row is touched
-- (nothing grants cs_role before this migration runs, so there is nothing to
-- backfill on a first run).
-- ============================================================================

begin;

alter table staff add column if not exists cs_role text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'staff'::regclass and conname = 'staff_cs_role_check'
  ) then
    alter table staff add constraint staff_cs_role_check
      check (cs_role in ('agent','supervisor','admin'));
  end if;
end $$;

create or replace function staff_guard_cs_role()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- (a) Deactivated rows carry no inbox access. Runs before the permission
  -- checks on purpose: anyone allowed to resign or deactivate a person also
  -- drops their access, and no one can set cs_role on such a row.
  if new.status = 'resigned' or new.is_active = false then
    new.cs_role := null;
    return new;
  end if;

  -- (b) cs_role not being changed: nothing to guard.
  if tg_op = 'UPDATE' and new.cs_role is not distinct from old.cs_role then
    return new;
  end if;

  -- (c) New row without access.
  if tg_op = 'INSERT' and new.cs_role is null then
    return new;
  end if;

  -- (d) Service key / SQL editor: no signed-in user to check.
  if auth.uid() is null then
    return new;
  end if;

  -- (e) Only an owner or admin may grant or change access.
  if coalesce(current_system_role(), '') not in ('owner','admin') then
    raise exception 'Only an owner or admin can change Customer Service access.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists staff_guard_cs_role_trg on staff;
create trigger staff_guard_cs_role_trg
  before insert or update of cs_role, status, is_active on staff
  for each row execute function staff_guard_cs_role();

commit;

-- Sanity (expect two rows: INSERT and UPDATE, both BEFORE):
select event_manipulation, action_timing
from information_schema.triggers
where event_object_table = 'staff' and trigger_name = 'staff_guard_cs_role_trg'
order by event_manipulation;
