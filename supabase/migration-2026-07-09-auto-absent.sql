-- ============================================================================
-- Auto-mark ABSENT for missed scheduled shifts (2026-07-09, v2)
-- Run BY HAND in the Supabase SQL editor. Idempotent — safe to re-run.
-- Prereq: pg_cron already enabled (it is — the 'leave-daily' job uses it).
--
-- A staff member who was scheduled but never clocked in gets an attendance
-- row auto-created after the shift ends:
--   status        = 'absent'  (or 'on_leave' if an approved leave covers the day)
--   marked_by     = 'system'  (manual marks store the acting staff id instead)
--   scheduled_shift_id links back to the missed shift for appeals/tracing.
-- Existing attendance rows are never touched (late stays late).
--
-- v2 (2026-09-02) fixes the same stale-rank bug the attendance trigger review
-- just cost a round on: the guard below checked `rank in ('supervisor',
-- 'manager')` only. That is not the boundary that actually governs this
-- table. `grep -n "attendance_manage" supabase/schema.sql
-- supabase/migration-*.sql` and take the LAST definition — it is
-- migration-2026-07-08-rls-system-role.sql:37-39:
--   create policy "attendance_manage" on attendance for all to authenticated
--     using ((current_rank() in ('supervisor','manager')
--             or current_system_role() in ('hr','supervisor','manager','admin','owner')));
-- so an account with system_role in ('hr','supervisor','manager','admin',
-- 'owner') but a trainee/junior/senior RANK — precisely the class
-- migration-2026-07-08-rls-system-role.sql exists to serve — has full RLS
-- write access to `attendance` and was refused by this RPC alone. DailyRoster
-- .load() (src/features/hr/HrAttendance.tsx) calls it as
-- `supabase.rpc('mark_absent_for_missed_shifts').then(() => {}, () => {})`,
-- which swallows both the success and the error, so for exactly those
-- accounts the sweep silently never ran when they opened the roster — no
-- error shown, no absences ever marked, indistinguishable from everything
-- being fine. v2 replaces the hand-rolled `select rank into v_rank ...` check
-- with calls to current_rank()/current_system_role() — the same two
-- functions attendance_manage's own USING clause calls, and the same pattern
-- migration-2026-09-02-late-reason-notifications.sql's attendance_guard_
-- late_update() now uses for its own broad test — so this guard cannot drift
-- from the policy again without the policy itself being edited. Each half is
-- wrapped in coalesce(..., false) for the same reason as that trigger: both
-- functions return NULL for a caller current_rank()/current_system_role()
-- can't resolve, and `null or null` is NULL, not false — so without the
-- coalesce an unresolvable caller would fail OPEN instead of closed.
--
-- THIS FILE HAS ALREADY BEEN RUN IN PRODUCTION (v1). v2 changes only the
-- guard inside mark_absent_for_missed_shifts() via `create or replace
-- function`, which is idempotent and safe to run again — see the re-run
-- safety check at the end of this comment block. It DOES need to be re-run
-- for the fix to take effect; the version live in prod today still has the
-- stale rank-only guard.
--
-- RE-RUN SAFETY, CHECKED STATEMENT BY STATEMENT (v2). Every statement in this
-- file is idempotent on a database that already has v1 applied:
--   1) `alter table attendance add column if not exists ...` (x2) — no-op if
--      the columns already exist, which they do in prod.
--   2) `create or replace function mark_absent_for_missed_shifts()` — replaces
--      the function body in place; does not reset the EXECUTE grant below.
--   3) `grant execute on function ... to authenticated` — granting an
--      already-held privilege is a no-op, not an error.
--   4) `select cron.schedule('absent-hourly', '10 * * * *', ...)` — pg_cron's
--      cron.schedule() upserts by job name (since pg_cron 1.4: a second call
--      with the same name updates that job's schedule/command in place rather
--      than creating a duplicate), which is what the original header's
--      "re-running replaces the same-named job" already relied on. v2 does
--      not change the schedule or the command text, only the function body
--      the command calls, so this statement is a no-op in substance either way.
-- No column, constraint, index, or seed data is added or changed. Re-running
-- the whole file end to end on an up-to-date-except-for-the-guard database is
-- safe and idempotent.
-- ============================================================================

-- 1) Columns ------------------------------------------------------------------
alter table attendance add column if not exists scheduled_shift_id uuid references scheduled_shifts(id);
-- 'system' for auto-marks, or the acting staff member's uuid (as text) for
-- manual marks — kept as text so both fit one audit field.
alter table attendance add column if not exists marked_by text;

-- 2) Engine --------------------------------------------------------------------
create or replace function mark_absent_for_missed_shifts()
returns int language plpgsql security definer as $$
declare
  v_now_myt timestamp;   -- MYT wall-clock; shifts are stored as MYT date + time
  v_count   int;
begin
  -- Callable by cron (no auth context) or anyone attendance_manage would let
  -- write this table — v2: mirrors that policy's LIVE USING clause (grepped;
  -- see the v2 note above), via the same two functions the policy itself
  -- calls, instead of a hand-rolled rank-only lookup that had drifted from it.
  -- coalesce(..., false) on each half so an unresolvable caller fails CLOSED,
  -- not open — see the v2 note for why the bare `or` would otherwise misfire.
  if auth.uid() is not null then
    if not (
      coalesce(current_rank() in ('supervisor','manager'), false)
      or coalesce(current_system_role() in ('hr','supervisor','manager','admin','owner'), false)
    ) then
      raise exception 'mark_absent_for_missed_shifts: not allowed';
    end if;
  end if;

  v_now_myt := now() at time zone 'Asia/Kuala_Lumpur';

  with ended_shifts as (
    select ss.id as shift_id, ss.staff_id, ss.date
    from scheduled_shifts ss
    join shift_types st on st.id = ss.shift_type_id
    join staff s on s.id = ss.staff_id
    where ss.status in ('scheduled','confirmed')
      and s.status = 'active'          -- skip resigned
      and s.is_active                  -- skip eliminated probation hires
      and ss.date >= (v_now_myt::date - 7)   -- lookback window: 7 days
      and ss.date <= v_now_myt::date
      -- Shift has ENDED in MYT. Overnight shifts (end <= start, e.g. 22:00–06:00)
      -- end on the NEXT day.
      and (ss.date + st.end_time
           + case when st.end_time <= st.start_time then interval '1 day'
                  else interval '0 hours' end) < v_now_myt
      -- No attendance row of any kind for that day (late/present/leave untouched).
      and not exists (
        select 1 from attendance a
        where a.staff_id = ss.staff_id and a.date = ss.date
      )
  )
  insert into attendance (staff_id, date, status, scheduled_shift_id, marked_by, notes)
  select
    e.staff_id,
    e.date,
    -- Approved leave covering the day → on_leave, never absent (belt-and-braces:
    -- the leave-approval flow normally writes these rows already).
    case when exists (
      select 1 from leave_requests lr
      where lr.staff_id = e.staff_id
        and lr.status = 'approved'
        and lr.start_date <= e.date
        and lr.end_date   >= e.date
    ) then 'on_leave' else 'absent' end,
    e.shift_id,
    'system',
    'Auto-marked: no clock-in for scheduled shift'
  from ended_shifts e
  on conflict (staff_id, date) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function mark_absent_for_missed_shifts() to authenticated;

-- 3) Schedule: hourly at :10 (re-running replaces the same-named job) ----------
select cron.schedule('absent-hourly', '10 * * * *', $$select mark_absent_for_missed_shifts()$$);
