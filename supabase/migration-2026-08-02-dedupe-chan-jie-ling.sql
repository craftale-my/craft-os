-- ============================================================================
-- Remove the duplicate Chan Jie Ling registration + backfill her job title
-- (2026-08-02, v1)
--
-- She registered twice on 2026-07-28, 39 seconds apart:
--
--   KEEP    7b854bf2-eb02-44fd-ab2e-2654b729aa1e  07:17:53
--           Complete: avatar, IC, address, contact, branch, employment type.
--           onboarding_completed = true, status = 'active'.
--           Holds the real clock-ins (07-28 present, 07-30 present), the
--           monthly review and the probation review.
--
--   DELETE  2a8f8009-23c0-4026-9d3f-443c0338a86c  07:18:32
--           Empty shell: every personal field null, onboarding_completed =
--           false, status = 'resigned' (but is_active was still true, which is
--           why it kept surfacing). Carries 3 attendance rows — all
--           auto-generated 'absent' with no clock times, on days the kept
--           record shows her present — and 6 scheduled_shifts that duplicate
--           days the kept record already covers.
--
-- The shell was inflating her absence count on days she actually worked.
--
-- staff_id foreign keys are ON DELETE CASCADE, so deleting the staff row takes
-- its attendance and scheduled_shifts with it; attendance_breaks cascades from
-- attendance in turn. Non-cascading columns (reviewer_id, approved_by,
-- recorded_by, …) would raise a foreign-key error rather than delete silently —
-- if statement 3 errors, stop and report it instead of forcing it through.
--
-- She is also the fifth staff member left without a job title by the
-- case-sensitive auto-assignment bug, so statements 4 and 5 finish that fix.
--
-- Run after migration-2026-08-02-service-crew-backfill.sql. Not idempotent:
-- statement 3 is a one-time delete.
-- ============================================================================

-- 1. Snapshot the row and everything that cascades from it.
create table if not exists backup_2026_08_02_dup_staff as
  select * from staff where id = '2a8f8009-23c0-4026-9d3f-443c0338a86c';
create table if not exists backup_2026_08_02_dup_attendance as
  select * from attendance where staff_id = '2a8f8009-23c0-4026-9d3f-443c0338a86c';
create table if not exists backup_2026_08_02_dup_shifts as
  select * from scheduled_shifts where staff_id = '2a8f8009-23c0-4026-9d3f-443c0338a86c';

-- 2. Pre-flight: run this on its own first and eyeball it. Expect 1 / 3 / 6,
--    and every attendance row 'absent' with null clock times.
select 'staff' as what, count(*) from staff
  where id = '2a8f8009-23c0-4026-9d3f-443c0338a86c'
union all
select 'attendance (all should be absent, no clock times)', count(*) from attendance
  where staff_id = '2a8f8009-23c0-4026-9d3f-443c0338a86c'
union all
select 'attendance with a real clock-in — MUST BE 0', count(*) from attendance
  where staff_id = '2a8f8009-23c0-4026-9d3f-443c0338a86c' and clock_in is not null
union all
select 'scheduled_shifts', count(*) from scheduled_shifts
  where staff_id = '2a8f8009-23c0-4026-9d3f-443c0338a86c';

-- 3. Delete. Cascades to attendance, scheduled_shifts, attendance_breaks.
delete from staff where id = '2a8f8009-23c0-4026-9d3f-443c0338a86c';

-- 4. The kept record never got a job title — same auto-assignment bug.
update staff s
set job_title_id = (select r.id from roles r where r.name = 'Service Crew' and r.is_active limit 1)
where s.id = '7b854bf2-eb02-44fd-ab2e-2654b729aa1e'
  and s.job_title_id is null;

-- 5. Build her career-path skill checklist (expect 6, matching the other four).
select initialize_staff_skills('7b854bf2-eb02-44fd-ab2e-2654b729aa1e') as skills_added;

-- ── Verification (read-only) ────────────────────────────────────────────────

-- Exactly one Chan Jie Ling, with a job title.
select s.name, s.status, s.is_active, d.name as department, r.name as job_title,
       (select count(*) from skill_assessments a where a.staff_id = s.id) as skills
from staff s
left join departments d on d.slug = s.department
left join roles r on r.id = s.job_title_id
where s.name ilike '%chan%jie%ling%';

-- Her attendance, now free of the phantom absences.
select date, status, clock_in, clock_out
from attendance
where staff_id = '7b854bf2-eb02-44fd-ab2e-2654b729aa1e'
order by date;

-- No duplicate names left anywhere.
select lower(btrim(name)) as name, count(*)
from staff group by 1 having count(*) > 1;

-- ── After running ───────────────────────────────────────────────────────────
--
-- staff.id mirrors auth.users.id, and deleting a staff row does NOT delete the
-- auth user. Check Authentication → Users for an orphan with id
-- 2a8f8009-23c0-4026-9d3f-443c0338a86c and remove it there if present.

-- ── Rollback (uncomment; restores the row and its cascaded children) ────────

-- insert into staff select * from backup_2026_08_02_dup_staff;
-- insert into attendance select * from backup_2026_08_02_dup_attendance;
-- insert into scheduled_shifts select * from backup_2026_08_02_dup_shifts;

-- Once verified and lived with for a while:
-- drop table backup_2026_08_02_dup_staff, backup_2026_08_02_dup_attendance,
--            backup_2026_08_02_dup_shifts;
