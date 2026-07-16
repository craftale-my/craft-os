-- ============================================================================
-- Auto-mark ABSENT for missed scheduled shifts (2026-07-09)
-- Run BY HAND in the Supabase SQL editor. Idempotent — safe to re-run.
-- Prereq: pg_cron already enabled (it is — the 'leave-daily' job uses it).
--
-- A staff member who was scheduled but never clocked in gets an attendance
-- row auto-created after the shift ends:
--   status        = 'absent'  (or 'on_leave' if an approved leave covers the day)
--   marked_by     = 'system'  (manual marks store the acting staff id instead)
--   scheduled_shift_id links back to the missed shift for appeals/tracing.
-- Existing attendance rows are never touched (late stays late).
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
  v_rank    text;
  v_now_myt timestamp;   -- MYT wall-clock; shifts are stored as MYT date + time
  v_count   int;
begin
  -- Callable by cron (no auth context) or supervisors/managers only
  -- (same guard pattern as process_leave_accruals).
  if auth.uid() is not null then
    select rank into v_rank from staff where id = auth.uid();
    if v_rank is null or v_rank not in ('supervisor','manager') then
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
