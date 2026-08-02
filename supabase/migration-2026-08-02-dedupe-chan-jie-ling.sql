-- ============================================================================
-- Remove the duplicate Chan Jie Ling registration + backfill her job title
-- (2026-08-02, v2)
--
-- v1 assumed every staff_id foreign key was ON DELETE CASCADE and deleted only
-- the staff row. They are not uniform: scheduled_shifts.staff_id cascades
-- (schema.sql:684) but attendance.staff_id does not (schema.sql:488), so the
-- delete failed with 23503 and the batch rolled back. v2 does not rely on
-- cascade at all — every child row is deleted explicitly, in dependency order.
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
-- She is also the fifth staff member left without a job title by the
-- case-sensitive auto-assignment bug, so steps 5 and 6 finish that fix.
--
-- Run the steps in order, checking the output of each before the next.
-- ============================================================================


-- ── Step 1. Diagnostic: what actually points at staff, and does it cascade? ──
-- Run this ALONE first. It is read-only. It is also the answer to why v1 failed
-- and the check that step 4 deletes everything it needs to.

select tc.table_name,
       kcu.column_name,
       rc.delete_rule
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on kcu.constraint_name = tc.constraint_name
 and kcu.constraint_schema = tc.constraint_schema
join information_schema.referential_constraints rc
  on rc.constraint_name = tc.constraint_name
 and rc.constraint_schema = tc.constraint_schema
join information_schema.constraint_column_usage ccu
  on ccu.constraint_name = tc.constraint_name
 and ccu.constraint_schema = tc.constraint_schema
where tc.constraint_type = 'FOREIGN KEY'
  and ccu.table_name = 'staff'
  and tc.table_schema = 'public'
order by rc.delete_rule, tc.table_name;


-- ── Step 2. Snapshot, before anything is removed ─────────────────────────────

create table if not exists backup_2026_08_02_dup_staff as
  select * from staff where id = '2a8f8009-23c0-4026-9d3f-443c0338a86c';
create table if not exists backup_2026_08_02_dup_attendance as
  select * from attendance where staff_id = '2a8f8009-23c0-4026-9d3f-443c0338a86c';
create table if not exists backup_2026_08_02_dup_shifts as
  select * from scheduled_shifts where staff_id = '2a8f8009-23c0-4026-9d3f-443c0338a86c';
create table if not exists backup_2026_08_02_dup_breaks as
  select b.* from attendance_breaks b
  join attendance a on a.id = b.attendance_id
  where a.staff_id = '2a8f8009-23c0-4026-9d3f-443c0338a86c';

-- Confirm the snapshot took (expect 1 / 3 / 6 / 0-or-more).
select 'staff' as t, count(*) from backup_2026_08_02_dup_staff
union all select 'attendance', count(*) from backup_2026_08_02_dup_attendance
union all select 'shifts',     count(*) from backup_2026_08_02_dup_shifts
union all select 'breaks',     count(*) from backup_2026_08_02_dup_breaks;


-- ── Step 3. Pre-flight ───────────────────────────────────────────────────────
-- The third row MUST be 0. If it is not, the shell holds a real clock-in and
-- this whole plan is wrong — stop and re-check before deleting anything.

select 'attendance rows on the shell' as check, count(*) as n from attendance
  where staff_id = '2a8f8009-23c0-4026-9d3f-443c0338a86c'
union all
select 'scheduled shifts on the shell', count(*) from scheduled_shifts
  where staff_id = '2a8f8009-23c0-4026-9d3f-443c0338a86c'
union all
select 'shell rows with a real clock-in — MUST BE 0', count(*) from attendance
  where staff_id = '2a8f8009-23c0-4026-9d3f-443c0338a86c' and clock_in is not null;


-- ── Step 4. Delete, children first ───────────────────────────────────────────
-- No reliance on cascade. If the last statement still raises 23503, the error
-- names the table that is still holding a reference — report it rather than
-- forcing it through; something is referencing her that we have not accounted
-- for, and step 1's output will say which column it is.

delete from attendance_breaks
where attendance_id in (
  select id from attendance where staff_id = '2a8f8009-23c0-4026-9d3f-443c0338a86c'
);

delete from attendance
where staff_id = '2a8f8009-23c0-4026-9d3f-443c0338a86c';

delete from scheduled_shifts
where staff_id = '2a8f8009-23c0-4026-9d3f-443c0338a86c';

delete from staff
where id = '2a8f8009-23c0-4026-9d3f-443c0338a86c';


-- ── Step 5. The kept record never got a job title — same auto-assign bug ─────

update staff s
set job_title_id = (select r.id from roles r where r.name = 'Service Crew' and r.is_active limit 1)
where s.id = '7b854bf2-eb02-44fd-ab2e-2654b729aa1e'
  and s.job_title_id is null;


-- ── Step 6. Build her skill checklist (expect 6, like the other four) ────────

select initialize_staff_skills('7b854bf2-eb02-44fd-ab2e-2654b729aa1e') as skills_added;


-- ── Step 7. Verification (read-only) ────────────────────────────────────────

-- Exactly one Chan Jie Ling, with a job title and 6 skills.
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


-- ── Rollback (uncomment; parents before children) ───────────────────────────

-- insert into staff            select * from backup_2026_08_02_dup_staff;
-- insert into attendance       select * from backup_2026_08_02_dup_attendance;
-- insert into scheduled_shifts select * from backup_2026_08_02_dup_shifts;
-- insert into attendance_breaks select * from backup_2026_08_02_dup_breaks;

-- Once verified and lived with for a while:
-- drop table backup_2026_08_02_dup_staff, backup_2026_08_02_dup_attendance,
--            backup_2026_08_02_dup_shifts, backup_2026_08_02_dup_breaks;
