-- ============================================================================
-- Craft OS — Security hardening (brief §4.4 defects 7 and 8, §8 step 3) (2026-10-27)
--
-- Defect 8 — "no 'live staff' check": has_procurement_cap / can_access_branch
--   looked only at system_role / rank / branch_id, so a resigned supervisor
--   kept procurement read/write access. Following pos-demo's helpers, a staff
--   member counts only when `s.is_active and s.status = 'active'`
--   (staff.status CHECK allows 'active' | 'resigned'). Every procurement RLS
--   policy, the receiving-photos storage policy, next_po_number,
--   submit_receiving and close_po_short go through these two helpers, so
--   non-live staff lose all procurement access.
--   Capability semantics are unchanged ("explicit true only widens"); the
--   override question stays open (brief §11, item 1).
--
-- Defect 7 — SECURITY DEFINER functions without `set search_path`: every such
--   function in schema public gets `search_path = public, pg_temp` via ALTER
--   FUNCTION (no body change). Functions that already pin a search_path are
--   left alone (auth_user_id_by_email keeps its stricter search_path = '').
--   submit_receiving is aligned from `public` to `public, pg_temp`.
--   Each ALTER is skipped when the function does not exist in the target
--   database (several are from other modules/branches).
--
-- Prerequisites: all procurement migrations up to
--   migration-2026-10-27-overdelivery-close-short.sql.
-- Re-runnable until migration-2026-10-29-owner-decisions.sql has run; after that it STOPS.
-- ============================================================================

-- Stop if a later file already replaced what this one defines.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'wastage_logs_reason_check'
              and pg_get_constraintdef(oid) like '%staff_meal%') then
    raise exception 'STOP: migration-2026-10-27-security-hardening.sql is superseded by migration-2026-10-29-owner-decisions.sql (has_procurement_cap). Re-run that file instead.';
  end if;
end $$;

-- 1. Live-staff check in the procurement helpers ------------------------------
create or replace function has_procurement_cap(p_cap text)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select
      -- Explicit true in the owner's capability matrix
      coalesce((
        select (srp.permissions ->> p_cap)::boolean
        from system_role_permissions srp
        where srp.system_role = s.system_role
      ), false)
      or
      -- Built-in defaults
      case p_cap
        when 'manage_procurement' then
          s.system_role in ('owner','admin','manager') or s.rank = 'manager'
        when 'use_procurement' then
          s.system_role in ('owner','admin','manager','supervisor')
          or s.rank in ('manager','supervisor')
        else false
      end
    from staff s
    where s.id = auth.uid()
      and s.is_active
      and s.status = 'active'   -- live staff only (resigned staff lose access)
  ), false)
$$;

create or replace function can_access_branch(p_branch_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select
      (s.system_role in ('owner','admin','manager','hr') or s.rank = 'manager')
      or (s.branch_id is not null and s.branch_id = p_branch_id)
    from staff s
    where s.id = auth.uid()
      and s.is_active
      and s.status = 'active'   -- live staff only
  ), false)
$$;

-- 2. Pin search_path on every SECURITY DEFINER function in public -------------
do $$
declare
  v_sig text;
  v_fn  regprocedure;
begin
  foreach v_sig in array array[
    -- procurement (brief defect 7)
    'public.current_branch_id()',
    'public.next_po_number()',
    'public.submit_receiving(uuid,text,text,text,jsonb)',
    -- other modules
    'public.award_xp_on_approval()',
    'public.award_xp_on_skill_pass()',
    'public.can_review_staff(uuid)',
    'public.current_is_owner()',
    'public.current_rank()',
    'public.current_system_role()',
    'public.has_task_cap(text)',
    'public.initialize_staff_skills(uuid)',
    'public.mark_absent_for_missed_shifts()',
    'public.open_promotion_request_when_complete()',
    'public.process_leave_accruals()',
    'public.upsert_tag(text,text,uuid)'
  ] loop
    v_fn := to_regprocedure(v_sig);
    if v_fn is not null then
      execute format('alter function %s set search_path = public, pg_temp', v_fn);
    else
      raise notice 'skipped (not in this database): %', v_sig;
    end if;
  end loop;
end $$;
