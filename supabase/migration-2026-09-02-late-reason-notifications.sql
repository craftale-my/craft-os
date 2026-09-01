-- ============================================================================
-- Late reason + notifications, schema only (2026-09-02, v2). Idempotent.
--
-- v2 addresses review findings against v1 (never executed against any
-- database, so amended in place rather than layered with a second file):
--   1. Dropped the attendance_update_excuse UPDATE policy. RLS is row-scoped,
--      not column-scoped: the policy would have let callers rewrite any column.
--      Replaced with the excuse_lateness() security definer function below,
--      which authorises the caller itself (by staff.rank or by being named as
--      someone's supervisor_id) and can write only the three excuse columns.
--      Note: the pre-existing attendance_manage policy (schema.sql:505-506)
--      remains unchanged and grants any rank-supervisor/manager blanket write
--      access to any column independently; tightening that is out of scope
--      because DailyRoster's status editing depends on it.
--   2. notifications_update_own_read's comment claimed only read_at was
--      user-writable, but the policy let the recipient rewrite title/body/
--      link/event_type/subject columns too. Added a BEFORE UPDATE trigger
--      that enforces exactly that instead of just documenting it.
--   3. Switched attendance_late_reason_code_check from the exception-swallow
--      idiom to this repo's drop-if-exists-then-add pattern for named
--      constraints (see staff_department_check, scheduled_shifts_shift_or_leave
--      in schema.sql) — the swallow form silently keeps the first definition
--      forever if this file is ever edited and re-run.
-- ============================================================================

alter table staff add column if not exists supervisor_id uuid references staff(id) on delete set null;

alter table attendance add column if not exists late_reason_code text;
alter table attendance add column if not exists late_reason      text;
alter table attendance add column if not exists late_excused     boolean not null default false;
alter table attendance add column if not exists late_excused_by  uuid references staff(id);
alter table attendance add column if not exists late_excused_at  timestamptz;

alter table attendance drop constraint if exists attendance_late_reason_code_check;
alter table attendance add constraint attendance_late_reason_code_check
  check (late_reason_code is null or late_reason_code in
    ('traffic','transport','medical','work_errand','personal','other'));

create table if not exists notifications (
  id               uuid primary key default gen_random_uuid(),
  recipient_id     uuid not null references staff(id) on delete cascade,
  event_type       text not null,
  title            text not null,
  body             text,
  link             text,
  subject_staff_id uuid references staff(id) on delete cascade,
  subject_date     date,
  read_at          timestamptz,
  created_at       timestamptz not null default now(),
  unique (recipient_id, event_type, subject_staff_id, subject_date)
);

create index if not exists notifications_inbox_idx
  on notifications (recipient_id, read_at, created_at desc);

alter table notifications enable row level security;

drop policy if exists "notifications_select_own" on notifications;
create policy "notifications_select_own" on notifications for select
  using (recipient_id = auth.uid());

-- Only read_at is user-writable; the row itself is written by notify_late().
-- RLS is row-scoped (recipient_id = auth.uid()), not column-scoped, so the
-- policy alone can't stop the recipient rewriting title/body/link/event_type/
-- subject_staff_id/subject_date too — that's enforced below by a BEFORE
-- UPDATE trigger, not by this policy's using/with check.
drop policy if exists "notifications_update_own_read" on notifications;
create policy "notifications_update_own_read" on notifications for update
  using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());

-- Enforces the comment above: any update that changes a column other than
-- read_at is rejected. Diffing to_jsonb(new)/to_jsonb(old) with read_at
-- stripped (rather than enumerating the other columns) means a column added
-- to notifications later is guarded automatically, with nothing here to
-- remember to update.
create or replace function notifications_guard_recipient_update()
returns trigger
language plpgsql
as $$
begin
  if (to_jsonb(new) - 'read_at') is distinct from (to_jsonb(old) - 'read_at') then
    raise exception 'Only read_at can be updated on notifications.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists notifications_guard_recipient_update_trg on notifications;
create trigger notifications_guard_recipient_update_trg
  before update on notifications
  for each row execute function notifications_guard_recipient_update();

-- ── excuse_lateness ─────────────────────────────────────────────────────────
-- Replaces the row-scoped attendance_update_excuse UPDATE policy: Postgres
-- RLS cannot restrict which columns an UPDATE touches, so a USING-only policy
-- keyed on "am I this person's supervisor" let that supervisor rewrite
-- clock_in/clock_out/status/late_minutes/notes too — the columns payroll and
-- the monthly attendance score are computed from. This function authorises
-- the caller itself (mirroring how can_review_staff() reads auth.uid()) and
-- writes only late_excused/late_excused_by/late_excused_at; no other column
-- on the row is reachable through it. Called from the app as
-- supabase.rpc('excuse_lateness', { p_attendance_id }).
--
-- Authorisation — mirror this exact condition, word for word, in the UI gate
-- that shows/hides the "excuse lateness" action:
--   me.system_role in ('manager','admin','owner') or me.rank = 'manager'
--   or t.supervisor_id = me.id
-- (me = the caller's own staff row, t = the staff row that owns the
-- attendance record being excused.)
--
-- State behaviour:
--   * status <> 'late'   -> raises. There is nothing to excuse, and quietly
--     succeeding would let a stale click (e.g. the record's status changed
--     under the user, or they never saw an "Excuse" action) look like it did
--     something when it did not.
--   * already late_excused = true -> no-op, returns true. Excusing an
--     already-excused row reaches the same end state the caller asked for,
--     so a retry or double-click should look like success, not an error.
--     The original late_excused_by/late_excused_at is left standing rather
--     than being overwritten by whoever calls this second — the audit trail
--     should record who actually granted the excuse, not who last re-clicked
--     it.
--
-- set search_path = public, pg_temp pins the resolution path for a security
-- definer function: without it, a caller able to create objects earlier in
-- an unpinned search_path could shadow `attendance`/`staff` and run
-- arbitrary code with this function's (elevated) privileges.
create or replace function excuse_lateness(p_attendance_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status  text;
  v_excused boolean;
begin
  -- One query does both the lookup and the authorisation check: the WHERE
  -- clause only matches a row if the caller is allowed to see it excused, so
  -- "no such attendance record" and "not allowed to excuse it" are
  -- indistinguishable to the caller below (no id-enumeration via the error).
  select a.status, a.late_excused
    into v_status, v_excused
    from attendance a
    join staff t on t.id = a.staff_id
    where a.id = p_attendance_id
      and exists (
        select 1 from staff me
        where me.id = auth.uid()
          and (me.system_role in ('manager','admin','owner') or me.rank = 'manager'
               or t.supervisor_id = me.id)
      );

  if not found then
    raise exception 'Attendance record not found, or you are not authorised to excuse it.'
      using errcode = '42501';
  end if;

  if v_status <> 'late' then
    raise exception 'Only attendance records with status ''late'' can be excused.'
      using errcode = '22023';
  end if;

  if v_excused then
    return true;
  end if;

  update attendance
     set late_excused    = true,
         late_excused_by = auth.uid(),
         late_excused_at = now()
   where id = p_attendance_id
     and late_excused = false;

  return true;
end;
$$;

insert into notification_settings (event_type, label, notify_staff, notify_supervisor, notify_manager)
values ('attendance_late', 'Late Arrival', true, true, false)
on conflict (event_type) do nothing;

insert into system_rules (key, value, label, description) values
  ('late_reason_written_threshold', '15', 'Late reason: written explanation above (min)',
   'Lateness above this many minutes requires a typed explanation, not just a reason code')
on conflict (key) do nothing;

do $$ begin
  alter publication supabase_realtime add table notifications;
exception when duplicate_object then null; end $$;

-- excuse_lateness is called directly via supabase.rpc(); PostgREST needs a
-- schema cache reload to see it before Supabase's own event trigger gets to it.
notify pgrst, 'reload schema';
