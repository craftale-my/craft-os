-- ============================================================================
-- Normalise roles.department to canonical slugs + split Management out of Other
-- (2026-08-02, v1)
--
-- Two problems, one migration:
--
-- 1. roles.department has always been free text (the Settings modal used a
--    plain input), so live rows hold "Barista" and "barista", "Bakery" and
--    "bakery". That splits one department into several groups in the Job Titles
--    table, and it silently breaks new-hire job-title auto-assignment in
--    Dashboard.tsx, which matches roles.department against staff.department
--    with a case-sensitive `=`.
--
-- 2. The catch-all department (slug 'other') had been renamed to display
--    "Management" and is being used as the real management department — three
--    staff sit under it. This gives Management its own row, hands 'other' back
--    its generic name, and moves those staff across.
--
-- Idempotent. Statements 3 and 4 are one-time backfills: they are safe to
-- re-run immediately, but do not re-run after anyone has been newly filed
-- under 'other' on purpose.
-- ============================================================================

-- 0. Snapshot the three tables this touches, before touching them. Kept as
--    real tables so a rollback is a plain update-from-join, not a file restore.
create table if not exists backup_2026_08_02_roles       as select * from roles;
create table if not exists backup_2026_08_02_departments as select * from departments;
create table if not exists backup_2026_08_02_staff       as select * from staff;

-- 1. A real Management department.
insert into departments (name, slug, status)
select 'Management', 'management', 'active'
where not exists (select 1 from departments where slug = 'management');

-- 2. 'other' goes back to being the generic catch-all.
update departments
set name = 'Other'
where slug = 'other' and name is distinct from 'Other';

-- 3. Move the management staff off the repurposed catch-all.
update staff
set department = 'management'
where department = 'other';

-- 4. Fold roles.department to the canonical slug form ("Barista" → "barista",
--    "Management" → "management", which statement 1 just made real).
update roles
set department = nullif(lower(trim(department)), '')
where department is not null
  and department is distinct from nullif(lower(trim(department)), '');

-- ── Verification (read-only; run in the Supabase SQL editor after the above) ─

-- Every distinct department value now on roles, and whether it resolves to a
-- real department row. Anything reported as 'ORPHAN' still needs a decision —
-- it renders in its own trailing group in the Job Titles table, not lost.
select r.department,
       count(*) as job_titles,
       case when d.slug is null then 'ORPHAN' else d.name end as resolves_to
from roles r
left join departments d on d.slug = r.department
group by r.department, d.slug, d.name
order by (d.slug is null), r.department;

-- Same check for staff. Note 'service crew' is expected to report ORPHAN here:
-- four staff carry that legacy slug and the departments table has no row for
-- it. Pre-existing, unrelated to this migration, left alone deliberately.
select s.department,
       count(*) as staff,
       case when d.slug is null then 'ORPHAN' else d.name end as resolves_to
from staff s
left join departments d on d.slug = s.department
group by s.department, d.slug, d.name
order by (d.slug is null), s.department;

-- ── Rollback (uncomment and run only if this needs undoing) ──────────────────

-- update roles r       set department = b.department
--   from backup_2026_08_02_roles b       where b.id = r.id;
-- update staff s       set department = b.department
--   from backup_2026_08_02_staff b       where b.id = s.id;
-- update departments d set name = b.name
--   from backup_2026_08_02_departments b where b.id = d.id;
-- delete from departments where slug = 'management';

-- Once the result has been verified and lived with for a while:
-- drop table backup_2026_08_02_roles, backup_2026_08_02_departments, backup_2026_08_02_staff;
