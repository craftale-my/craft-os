-- ============================================================================
-- Retire the 'service crew' department orphan
-- (2026-08-02, v1)
--
-- Four trainees carry department = 'service crew', a slug from the old
-- hardcoded list that the departments table has no row for. All four also have
-- job_title_id = null: their department matched no job title, so the
-- rank + department auto-assignment in Dashboard.tsx never fired for them.
--
-- "Service Crew" is a job title under Front House (rank trainee, department
-- barista), so this moves them there and assigns it — what onboarding would
-- have done — then builds the skill checklist that normally follows.
--
-- Run after migration-2026-08-02-department-normalise.sql. Idempotent.
-- ============================================================================

-- 1. Remember who they are before the department value they are found by
--    disappears. Doubles as the rollback source.
create table if not exists backup_2026_08_02_service_crew as
  select id, name, department, job_title_id from staff where department = 'service crew';

-- 2. Move to Front House and assign the Service Crew title. `coalesce` leaves
--    an existing job title alone; the department moves either way, so a missing
--    Service Crew role degrades to a partial fix rather than a silent no-op.
update staff s
set department   = 'barista',
    job_title_id = coalesce(
      s.job_title_id,
      (select r.id from roles r where r.name = 'Service Crew' and r.is_active limit 1)
    )
where s.department = 'service crew';

-- 3. Build their career-path skill checklists. Idempotent: inserts are
--    on-conflict-do-nothing. A return of -1 means no job title was assigned,
--    -2 means no active career path starts from that title; both are no-ops.
select b.name, initialize_staff_skills(b.id) as skills_added
from backup_2026_08_02_service_crew b
order by b.name;

-- ── Verification (read-only) ────────────────────────────────────────────────

-- 'service crew' should be gone. 'NULL' remains for Chan Jie Ling, who is
-- mid-onboarding with no branch or department yet — deliberately untouched.
select s.department,
       count(*) as staff,
       case when d.slug is null then 'ORPHAN' else d.name end as resolves_to
from staff s
left join departments d on d.slug = s.department
group by s.department, d.slug, d.name
order by (d.slug is null), s.department;

-- The four should now show department "Front House" and title "Service Crew".
select s.name, s.rank, s.branch, d.name as department, r.name as job_title
from backup_2026_08_02_service_crew b
join staff s on s.id = b.id
left join departments d on d.slug = s.department
left join roles r on r.id = s.job_title_id
order by s.name;

-- ── Rollback (uncomment and run only if this needs undoing) ──────────────────

-- update staff s set department = b.department, job_title_id = b.job_title_id
--   from backup_2026_08_02_service_crew b where b.id = s.id;

-- Once verified and lived with for a while:
-- drop table backup_2026_08_02_service_crew;
