-- 2026-10-23 — Phase 2 of the staff private-fields split.
--
-- Run ONLY after:
--   1. migration-2026-10-23-staff-private.sql ran on this database,
--   2. the new frontend and provision-staff are deployed,
--   3. migration-2026-10-23-staff-private.sql was re-run (catch-up backfill),
--   4. the LOSS CHECK below returned 0.
--
-- Irreversible: drops five staff columns. Their data lives in staff_private
-- and staff_manager_notes by now.

-- ── LOSS CHECK (run alone first; must return lost = 0) ───────────────────────
-- A value is "lost" if staff still holds it but the new table has nothing.
-- A different non-null value in the new table is fine: it is a newer edit.
--
-- select count(*) as lost
-- from staff s
-- left join staff_private p        on p.staff_id = s.id
-- left join staff_manager_notes n  on n.staff_id = s.id
-- where p.staff_id is null
--    or (s.ic_number      is not null and p.ic_number      is null)
--    or (s.date_of_birth  is not null and p.date_of_birth  is null)
--    or (s.contact_number is not null and p.contact_number is null)
--    or (s.address        is not null and p.address        is null)
--    or (s.manager_notes  is not null and n.notes          is null);

begin;
alter table staff
  drop column if exists ic_number,
  drop column if exists address,
  drop column if exists date_of_birth,
  drop column if exists contact_number,
  drop column if exists manager_notes;
commit;
