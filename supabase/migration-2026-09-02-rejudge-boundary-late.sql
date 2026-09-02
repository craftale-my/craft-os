-- ============================================================================
-- Re-judge boundary lateness under the whole-minute rule (2026-09-02)
--
-- The late rule changed: the scheduled start MINUTE is on time (a 09:30 shift is
-- late from 09:31). Rows written BEFORE that change, under the old "any second
-- past start is late" rule, still carry a late verdict they would not get today.
-- Each one costs the staff member a late day and 10 points of attendance_score
-- (schema.sql:209, counted by Reviews.tsx:389).
--
-- SCOPE — deliberately narrow. Only rows where ALL of:
--   (a) status = 'late' and clock_in is not null;
--   (b) the clock-in falls INSIDE the scheduled start minute (1-59 s past it),
--       so the new rule says "on time";
--   (c) late_minutes = 1 — exactly what the old ceil() rule would have written.
--       A manager who hand-sets a status types their own number (the UI seeds 5),
--       so this condition leaves manual overrides untouched.
--
-- NOT IN SCOPE: rows whose late_minutes is one higher than the new rule would
-- give (09:31:20 recorded as 2 rather than 1). That number is cosmetic —
-- late_count and attendance_score count DAYS, not minutes — so rewriting them
-- would touch far more rows for zero scoring effect and more risk.
--
-- Baseline matches calcLateness(): MYT wall clock vs scheduled date + start_time.
--
-- HOW TO RUN: step 1 first, read the output, then 2, then 3. Step 2 makes this
-- reversible; do not skip it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- STEP 1 — DRY RUN. Changes nothing. Read this before going further.
-- ---------------------------------------------------------------------------
with base as (
  select a.id, a.staff_id, a.date, a.status, a.late_minutes,
         (a.clock_in at time zone 'Asia/Kuala_Lumpur') as clock_in_myt,
         (ss.date + st.start_time)                     as start_myt
  from attendance a
  join scheduled_shifts ss on ss.staff_id = a.staff_id and ss.date = a.date
  join shift_types     st on st.id = ss.shift_type_id
  where a.status = 'late' and a.clock_in is not null
)
select s.name, b.date, b.start_myt::time as shift_start,
       b.clock_in_myt::time as clocked_in, b.late_minutes
from base b join staff s on s.id = b.staff_id
where b.clock_in_myt > b.start_myt
  and date_trunc('minute', b.clock_in_myt) = date_trunc('minute', b.start_myt)
  and b.late_minutes = 1
order by b.date desc, s.name;

-- ---------------------------------------------------------------------------
-- STEP 2 — BACKUP. Makes step 3 reversible.
-- ---------------------------------------------------------------------------
create table if not exists attendance_late_rejudge_backup_20260902 as
with base as (
  select a.id, a.status, a.late_minutes, a.notes,
         (a.clock_in at time zone 'Asia/Kuala_Lumpur') as clock_in_myt,
         (ss.date + st.start_time)                     as start_myt
  from attendance a
  join scheduled_shifts ss on ss.staff_id = a.staff_id and ss.date = a.date
  join shift_types     st on st.id = ss.shift_type_id
  where a.status = 'late' and a.clock_in is not null
)
select id, status, late_minutes, notes from base
where clock_in_myt > start_myt
  and date_trunc('minute', clock_in_myt) = date_trunc('minute', start_myt)
  and late_minutes = 1;

-- ---------------------------------------------------------------------------
-- STEP 3 — APPLY. Clears the verdict and leaves a trace in notes.
-- ---------------------------------------------------------------------------
update attendance a
set status       = 'present',
    late_minutes = 0,
    notes        = coalesce(a.notes || ' | ', '')
                   || 'Late verdict cleared 2026-09-02: whole-minute rule'
where a.id in (select id from attendance_late_rejudge_backup_20260902);

-- ---------------------------------------------------------------------------
-- ROLLBACK (only if needed)
-- ---------------------------------------------------------------------------
-- update attendance a
-- set status = b.status, late_minutes = b.late_minutes, notes = b.notes
-- from attendance_late_rejudge_backup_20260902 b
-- where b.id = a.id;
