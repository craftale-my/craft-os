-- supabase/migration-2026-10-29-cs-role.sql
-- ============================================================================
-- Customer Service access (2026-10-29)
--
-- staff.cs_role decides who can open the Craft Marketing inbox from Craft OS,
-- and at what level. NULL = no access. Craft Marketing's API reads this column
-- with the service key when it issues a sign-in ticket and on every token
-- refresh, so clearing it signs the person out of the inbox within 15 minutes.
--
-- Only an owner or admin may set or change it. Without the trigger, anyone
-- could grant themselves access: staff_update's RLS lets every user update
-- their own row.
--
-- Spec: Craft_CSS docs/superpowers/specs/2026-10-29-craft-os-sso-design.md
-- Idempotent: safe to run more than once.
-- ============================================================================

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
as $$
begin
  if tg_op = 'UPDATE' and new.cs_role is not distinct from old.cs_role then
    return new;
  end if;
  if tg_op = 'INSERT' and new.cs_role is null then
    return new;
  end if;

  -- Service key / SQL editor: no signed-in user to check.
  if auth.uid() is null then
    return new;
  end if;

  if coalesce(current_system_role(), '') not in ('owner','admin') then
    raise exception 'Only an owner or admin can change Customer Service access.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists staff_guard_cs_role_trg on staff;
create trigger staff_guard_cs_role_trg
  before insert or update of cs_role on staff
  for each row execute function staff_guard_cs_role();
