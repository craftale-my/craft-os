-- 2026-10-29 — Keep staff.branch_id in step with the text staff.branch
--
-- Why: every screen that sets a staff member's branch (Directory "Add New
-- Staff", registration approval, StaffProfile edit, Onboarding) wrote only the
-- text label ("Cheras (Taman Connaught)"). branch_id stayed null, so everything
-- that scopes by branch_id — can_access_branch() (procurement), supervisor
-- views in HrAttendance / Schedule / Directory, can_review_staff, notify_late —
-- treated those staff as branchless. A one-off backfill fixed 55 active staff
-- on prod on 2026-10-29; this stops the drift coming back.
--
-- The front end and provision-staff now send branch_id themselves. This file
-- is the safety net for any writer that does not (old clients, SQL editor,
-- future screens).
--
-- 1. branch_id_for_label(label) — the label → branches.id lookup. There is no
--    alias table, so it is driven by branches.name: the label matches a branch
--    when the label, or the part before " (", equals the branch name
--    (case-insensitive). "Cheras (Taman Connaught)" → Cheras, "Cheras" →
--    Cheras, "Other" / null / unknown → null. Active branches win over
--    inactive ones with the same name. src/shared/lib/branches.ts
--    (branchIdForLabel) and provision-staff mirror this rule.
--
-- 2. BEFORE INSERT OR UPDATE trigger on staff:
--      * INSERT with branch_id null          → fill it from the label;
--      * UPDATE that changes the label but leaves branch_id as it was
--                                            → re-resolve from the new label
--                                              (can become null for "Other");
--      * any other write where branch_id is null and the label resolves
--                                            → fill it.
--    A writer that sets branch_id explicitly always wins.
--
-- Deploy order: this file first, then the front end / provision-staff (they
-- work without it too — this only adds the net).

create or replace function branch_id_for_label(p_label text)
returns uuid
language sql
stable
set search_path = public
as $$
  select b.id
    from branches b
   where p_label is not null
     and btrim(p_label) <> ''
     and lower(btrim(b.name)) = lower(btrim(split_part(p_label, ' (', 1)))
   order by b.is_active desc, b.created_at
   limit 1
$$;

create or replace function staff_sync_branch_id()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and new.branch is distinct from old.branch
     and new.branch_id is not distinct from old.branch_id then
    new.branch_id := branch_id_for_label(new.branch);
  elsif new.branch_id is null and new.branch is not null then
    new.branch_id := branch_id_for_label(new.branch);
  end if;
  return new;
end;
$$;

drop trigger if exists staff_sync_branch_id_trg on staff;
create trigger staff_sync_branch_id_trg
  before insert or update of branch, branch_id on staff
  for each row execute function staff_sync_branch_id();

-- Catch anyone the 2026-10-29 backfill missed (inactive staff, rows written
-- since). Same rule as the trigger; never overwrites a set branch_id.
update staff
   set branch_id = branch_id_for_label(branch)
 where branch_id is null
   and branch_id_for_label(branch) is not null;
