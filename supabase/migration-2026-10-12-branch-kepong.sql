-- ============================================================================
-- Add the Kepong branch + its clock-in geofence (2026-10-12, v1)
--
-- Third outlet: B-G, 1, Jln Metro Perdana 1, Taman Usahawan Kepong,
-- 52100 Kuala Lumpur. Coordinates from Google Maps: 3.2173718, 101.6406565.
--
-- `branches.name` is 'Kepong', NOT the full 'Kepong (Taman Usahawan)' shown in
-- the app's dropdowns. ClockModal.tsx:102 takes the FIRST WORD of staff.branch
-- and matches it with `ilike '%word%'` against branches.name, so the short name
-- is what makes the geofence resolve — same as Cheras and Puchong.
--
-- Idempotent: safe to run more than once. Re-running inserts nothing and
-- overwrites nothing that is already set.
-- ============================================================================

-- 1. The branch row itself.
insert into branches (name, address, latitude, longitude, radius_meters)
select 'Kepong',
       'B-G, 1, Jln Metro Perdana 1, Taman Usahawan Kepong, 52100 Kuala Lumpur',
       3.2173718,
       101.6406565,
       100
where not exists (select 1 from branches where name ilike 'Kepong');

-- 2. If a Kepong row was already created by hand (via Settings -> Branches,
--    which until now had no geofence fields), fill only what is still empty.
--    coalesce, not assignment: never clobber a value someone has since tuned.
update branches
   set address       = coalesce(address, 'B-G, 1, Jln Metro Perdana 1, Taman Usahawan Kepong, 52100 Kuala Lumpur'),
       latitude      = coalesce(latitude, 3.2173718),
       longitude     = coalesce(longitude, 101.6406565),
       radius_meters = coalesce(radius_meters, 100)
 where name ilike 'Kepong';

-- 3. Backfill staff.branch_id from the free-text branch, same join as
--    migration-2026-07-06-rbac.sql:90. The front end never writes branch_id,
--    so anyone already set to Kepong has it null — and supervisor scoping
--    (HrAttendance.tsx:1192, Schedule.tsx:652, Directory.tsx:535) reads it.
update staff s
   set branch_id = b.id
  from branches b
 where s.branch_id is null
   and s.branch is not null
   and s.branch ilike '%' || b.name || '%';

-- == Verify ==================================================================
-- Expect exactly one Kepong row, 3.2173718 / 101.6406565 / 100, is_active true.
select name, address, latitude, longitude, radius_meters, is_active
  from branches
 order by name;

-- Expect every staff member whose branch text names a real branch to have a
-- branch_id. Rows here are staff on 'Other' or on a branch with no row.
select id, name, branch, branch_id
  from staff
 where branch_id is null and branch is not null
 order by branch, name;
