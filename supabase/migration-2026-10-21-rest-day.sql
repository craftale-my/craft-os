-- ============================================================================
-- Weekly rest day on the schedule (2026-10-21)
--
-- A scheduled_shifts row may now hold leave_type = 'rest_day': the staff
-- member's weekly rest day. It is NOT leave — the app writes no attendance row
-- for it, and mark_absent_for_missed_shifts() skips it because it joins
-- shift_types (rest-day rows have no shift_type_id).
--
-- One rest day per staff member per Mon–Sun week, enforced by a partial unique
-- index (date_trunc('week', …) starts the week on Monday, matching the app).
--
-- Idempotent: safe to run more than once.
-- ============================================================================

-- 1. Widen the leave_type check. Its original name was auto-generated, so drop
--    every check on scheduled_shifts that tests leave_type alone (leaving the
--    shift-or-leave XOR constraint untouched) and re-add one with a fixed name.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'scheduled_shifts'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%leave_type%'
      and pg_get_constraintdef(oid) not like '%shift_type_id%'
  loop
    execute format('alter table scheduled_shifts drop constraint %I', c.conname);
  end loop;
end $$;

alter table scheduled_shifts add constraint scheduled_shifts_leave_type_check
  check (leave_type in ('medical','emergency','unpaid','maternity','public_holiday','rest_day'));

-- 2. At most one rest day per staff member per week.
create unique index if not exists scheduled_shifts_one_rest_day_per_week
  on scheduled_shifts (staff_id, (date_trunc('week', date::timestamp)))
  where leave_type = 'rest_day';
