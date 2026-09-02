-- ============================================================================
-- Late reason + notifications, schema only (2026-09-02, v8). Idempotent.
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
--
-- v3 addresses further review findings, this time against notify_late()
-- (migration-2026-09-02-notify-late-fn.sql) but touching this file too:
--   4. A self-referential staff.supervisor_id (supervisor_id = id) made
--      notify_late()'s orphan-fallback check pass right by: v_orphan tested
--      `is null`, so a self-reference wasn't caught there, and the id got
--      filtered out downstream as "yourself" — nobody was ever notified, with
--      no error. notify_late() now also treats supervisor_id = id as orphan
--      (belt-and-braces), and a CHECK constraint here stops the row existing
--      in the first place. Added with the drop-if-exists-then-add idiom from
--      finding 3 above. No backfill needed: this column is added fresh by
--      this same file (see the ADD COLUMN below) and is null for every row
--      until the backfill in migration-2026-09-02-notify-late-fn.sql runs,
--      and that backfill already excludes self-reference explicitly
--      (`r.reviewer_id <> s.id`, `b.pic_staff_id <> s.id`) — so no existing
--      row can violate this constraint at the moment it is added.
--   5. excuse_lateness(), like notify_late(), had no explicit privilege
--      statement — it relied on the runtime auth.uid() check alone to keep
--      out callers Postgres's default PUBLIC-EXECUTE grant would otherwise
--      let call it. Added explicit REVOKE/GRANT below, right after its
--      definition.
--
-- v4 addresses a review finding against excuse_lateness() itself: it
-- authorises a caller who is named as the target's supervisor_id
-- (`t.supervisor_id = me.id`), but the pre-existing staff_update RLS policy
-- (schema.sql) is row-scoped, not column-scoped — `using (id = auth.uid() or
-- current_rank() in ('supervisor','manager'))` lets ANY authenticated staff
-- member update their OWN row, including supervisor_id, since id = auth.uid()
-- satisfies the USING clause regardless of which columns the UPDATE touches.
-- So any staff member could run
--   supabase.from('staff').update({ supervisor_id: '<friend>' }).eq('id', auth.uid())
-- and then have that friend excuse every one of their own late arrivals — a
-- self-dealing path this feature opened. Fixed with a BEFORE UPDATE trigger
-- on staff (below) that blocks a change to supervisor_id unless the caller is
-- manager-tier, using the exact same authority test excuse_lateness() itself
-- uses, so the two cannot drift apart.
--
-- v5 addresses a review finding (C1) against attendance itself: RLS is
-- row-scoped everywhere on this table, both for attendance_self_update
-- (schema.sql, `staff_id = auth.uid()`) and for attendance_manage
-- (schema.sql, `current_rank() in ('supervisor','manager')`, any row in any
-- branch) — neither can stop an UPDATE that reaches only
-- late_excused/late_excused_by/late_excused_at, or only late_reason_code/
-- late_reason. A staff member could run
--   supabase.from('attendance').update({ late_excused: true }).eq('id', ownRow)
-- from the browser console and erase their own late_excused = false
-- deduction (late_count/attendance_score are generated from it) — bypassing
-- excuse_lateness()'s authority check entirely — or rewrite late_reason_code/
-- late_reason after a supervisor has already read them. Fixed with a BEFORE
-- UPDATE trigger on attendance (below) that guards those five columns
-- specifically, without touching attendance_manage or attendance_self_update
-- themselves — status and late_minutes must stay freely updatable
-- (DailyRoster.setStatus, markAllPresent). [SUPERSEDED by v6/v7, which gate
-- status/late_minutes on the caller's own row, and then wholly by v8, which
-- replaces this blacklist with a whitelist — no column is "freely updatable"
-- on a staff member's own row any more.] See the trigger's own comment for
-- why late_excused/late_excused_by/late_excused_at are gated on
-- excuse_lateness()'s exact authority test, and why late_reason_code/
-- late_reason are instead made append-only rather than authority-gated.
--
-- v6 addresses a further review finding against v5 itself: v5 left status
-- and late_minutes ungated on the reasoning that DailyRoster.setStatus and
-- markAllPresent depend on writing them — but those are the MANAGER path,
-- covered by attendance_manage (schema.sql:505-506). The staff member's OWN
-- path is attendance_self_update (schema.sql:509-510), which is just as
-- row-scoped and column-blind:
--   create policy "attendance_self_update" on attendance for update to
--     authenticated using (staff_id = auth.uid());
-- CORRECTION (v8): an earlier draft of this note read that policy as having
-- "no `with check` at all", and inferred from that that staff_id itself was
-- re-targetable. That inference was wrong. Postgres reuses an UPDATE policy's
-- USING expression as its WITH CHECK when WITH CHECK is omitted, so the NEW
-- row must satisfy `staff_id = auth.uid()` too — staff_id IS pinned by this
-- policy, and a staff member cannot move their row onto someone else. What
-- the policy genuinely does not pin is every OTHER column on the row: the
-- holes the v5/v6/v7 blacklist left open were above all `date` (move a late
-- day out of the review month and countLateDays never counts it) and
-- `clock_in` on its own (null it, then re-set it, and the clock-in carve-out
-- below can be manufactured at will) — plus notes, marked_by, recorded_by,
-- scheduled_shift_id and the whole GPS/photo evidence group. See v8 below.
-- So the row's own owner could run
--   supabase.from('attendance').update({ status: 'present' }).eq('id', myRow)
-- from the browser console. countLateDays() counts status = 'late' and
-- late_excused = false rows, so flipping status reaches the exact same
-- outcome the v5 late_excused guard was built to prevent — the late day and
-- its ten-point deduction both disappear — by a shorter route that bypasses
-- v5's guard entirely (it never looks at status). Fixed by extending
-- attendance_guard_late_update() (not a second trigger) to also reject a
-- change to status/late_minutes when the caller is acting on their OWN row
-- and is not manager-tier — reusing the exact manager-tier expression
-- already used twice in this file (the late_excused branch below, and
-- staff_guard_supervisor_update() above) so the three cannot drift apart.
-- The one legitimate self-write is clocking in: writeClockIn (src/features/
-- hr/HrAttendance.tsx) sets status and late_minutes in the same upsert that
-- first sets clock_in, identified by `old.clock_in is null and new.clock_in
-- is not null` and let through regardless of caller. A caller acting on
-- someone ELSE's row is untouched — attendance_self_update never lets a
-- caller reach a row that isn't their own, so that case can only be reached
-- via attendance_manage, which is left exactly as permissive as before.
--
-- v7 addresses a review finding against v6 itself: v6's status/late_minutes
-- exemption reused excuse_lateness()'s authority test — `system_role in
-- ('manager','admin','owner') or rank = 'manager'` — but that is NARROWER
-- than the policy that actually governs this table, attendance_manage
-- (schema.sql:505-506):
--   create policy "attendance_manage" on attendance for all to authenticated
--     using (current_rank() in ('supervisor','manager'));
-- A rank = 'supervisor' account passes attendance_manage's USING clause on
-- every row in the table, including their own, but v6's narrower test
-- recognised only system_role admin/owner/manager or rank = 'manager' — so
-- that same supervisor failed the trigger's exemption specifically on their
-- OWN row. Because markAllPresent (DailyRoster, src/features/hr/
-- HrAttendance.tsx) upserts every visible row in a single statement, and
-- visibleStaff is filtered only by branch/department (it does not exclude
-- the caller), a trigger exception on the supervisor's own row aborted the
-- whole team's write, not just theirs. And markAllPresent writes without
-- checking its outcome (`await supabase.from('attendance').upsert(rows, ...)`
-- with no error check — a known pre-existing gap in DailyRoster), so the
-- abort was silent: the supervisor would see no error and believe the team
-- was marked present when nothing was written at all.
--
-- Fixed by widening the status/late_minutes exemption to mirror
-- attendance_manage's own boundary — `rank in ('supervisor','manager')`,
-- named v_attendance_manage_authority below — instead of reusing the
-- narrower excuse_lateness() test. This is deliberate, not an oversight:
-- this trigger's job is to stop an ORDINARY staff member — someone whose
-- only route to this table is attendance_self_update — from rewriting the
-- verdict on their own attendance. Someone with rank in
-- ('supervisor','manager') already has unrestricted write over EVERYONE's
-- attendance through attendance_manage; guarding only their own row would
-- not make the system any safer, and it breaks the markAllPresent workflow
-- above. Whether attendance_manage itself should grant that much power is a
-- separate, pre-existing question — deliberately out of this feature's
-- scope, and already flagged for the owner in the v1 note above.
--
-- late_excused/late_excused_by/late_excused_at keep the narrower,
-- excuse_lateness()-matching test unchanged (named v_excuse_lateness_
-- authority below): no bulk-write path touches those columns, and the
-- narrow test is the point there — see that block's own comment. The
-- function below now names both expressions explicitly and comments each
-- with the boundary it mirrors, specifically so a future edit doesn't
-- "tidy" them into one shared check — they encode two different boundaries
-- on purpose, not the same boundary written twice.
--
-- v8 replaces the whole shape of attendance_guard_late_update(). v5-v7 grew
-- it as a BLACKLIST: it named the columns it protected (late_excused*,
-- late_reason*, status, late_minutes) and left every other column on the row
-- to attendance_self_update, which is row-scoped, not column-scoped. Since
-- `authenticated` also holds the default table-wide UPDATE grant, the row's
-- owner still owned every column the trigger did not name. Two of them
-- defeated the guard outright:
--
--   * PATH A — one statement, no guarded column touched at all. Reviews.tsx's
--     countLateDays() scopes its count with `.gte('date', start).lte('date',
--     end)`. So
--       update attendance set date = '2020-01-01' where id = <own row>;
--     moves the late day clean out of the review month and takes the ten-point
--     attendance_score deduction with it. The v5-v7 trigger never looked at
--     `date`, so this never even reached a check.
--
--   * PATH B — two statements, manufacturing the v6/v7 clock-in carve-out.
--     `clock_in` was unguarded, so the carve-out `old.clock_in is null and
--     new.clock_in is not null` could simply be created on demand:
--       update attendance set clock_in = null where id = <own row>;
--         -- changes no blacklisted column, so v7 allows it
--       update attendance set clock_in = now(), status = 'present',
--              late_minutes = 0 where id = <own row>;
--         -- now matches the carve-out, so v7 skips the status/late_minutes
--         -- check entirely
--     The legitimate clock-in exit is exactly what made the forgery legal.
--
--   Other columns the blacklist left reachable and worth protecting on their
--   own account: clock_in_distance_m (the GPS evidence — settable to 0 after
--   clocking in from home), clock_in_photo_url and the rest of the photo/lat/
--   lng group, marked_by and recorded_by (forging provenance), notes (where
--   migration-2026-09-02-rejudge-boundary-late.sql writes its audit trail),
--   clock_out and scheduled_shift_id.
--
-- A blacklist over a row-wide UPDATE policy is structurally wrong, not merely
-- incomplete: every column added to `attendance` from now on would default to
-- unguarded, and each one would have to be noticed and named here. v8 inverts
-- it into a WHITELIST, using the same to_jsonb(new)/to_jsonb(old) diff idiom
-- notifications_guard_recipient_update() already uses in this file, so the two
-- guards read the same way. The rule and its rationale are stated in full
-- above the function itself; what it buys is that `date`, `staff_id`,
-- `clock_in` on its own, notes, marked_by, recorded_by, scheduled_shift_id
-- and every column added to this table in future are guarded without ever
-- being named.
--
-- Deliberately kept unchanged from v7: the auth.uid() is null allow-branch;
-- the attendance_manage-matching authority test (a rank in ('supervisor',
-- 'manager') caller already has unrestricted write over everyone's attendance
-- through attendance_manage, so guarding their own row adds no safety and
-- would silently abort markAllPresent's bulk upsert — see the v7 note above);
-- and the separate, narrower excuse_lateness()-matching test for the
-- late_excused* columns, still enforced for EVERY caller including managers,
-- because that is what makes excuse_lateness() the only route to an excuse.
-- The append-only rule on late_reason_code/late_reason is also kept for every
-- caller, for the same reason: the whitelist below only ever constrains a
-- non-manager acting on their own row, so without it a supervisor could still
-- rewrite a reason a manager had already read.
--
-- v8 also adds attendance_late_reason_length_check (500 chars). late_reason
-- is free text typed by the staff member and is concatenated straight into
-- the body of the notification their supervisor reads (notify_late(), sibling
-- migration); it had no length limit at any layer — not in the textarea, not
-- in PostgREST, not in the column type.
-- ============================================================================

alter table staff add column if not exists supervisor_id uuid references staff(id) on delete set null;

-- A supervisor can't supervise themselves — see v3 note #4 above. Idempotent
-- drop-then-add, matching this repo's convention for named CHECK constraints
-- (staff_department_check, scheduled_shifts_shift_or_leave in schema.sql).
alter table staff drop constraint if exists staff_supervisor_not_self_check;
alter table staff add constraint staff_supervisor_not_self_check
  check (supervisor_id is null or supervisor_id <> id);

-- ── staff_guard_supervisor_update ──────────────────────────────────────────
-- v4 finding (see note above): staff_update's RLS policy (schema.sql) is
-- row-scoped (`id = auth.uid() or current_rank() in ('supervisor','manager')`)
-- so it can't stop a staff member changing their OWN row's supervisor_id to
-- point at a friend, who could then use excuse_lateness()'s
-- `t.supervisor_id = me.id` authorisation to forgive that staff member's own
-- lateness. This trigger closes that specific column, without turning into a
-- second, broader gate: every other column on staff stays exactly as
-- updatable as staff_update already allows.
--
-- The authority check is copied verbatim from excuse_lateness()'s own
-- authorisation comment ("me.system_role in ('manager','admin','owner') or
-- me.rank = 'manager'") — deliberately, not independently reinvented — so the
-- set of people who can move a supervisor_id and the set of people
-- excuse_lateness() lets act as a supervisor share the same definition and
-- cannot silently drift apart.
--
-- auth.uid() is null in the migration/SQL-editor context, including this
-- file's own future re-runs and any script-driven backfill — that context is
-- allowed through unconditionally. This is safe: unlike an RPC such as
-- notify_late() (where a null auth.uid() means an anonymous PostgREST caller
-- that must be rejected explicitly), the staff table has no anonymous access
-- path at all — staff_update's own USING clause requires either
-- `id = auth.uid()` or a current_rank() lookup keyed on auth.uid(), and both
-- evaluate to null (not true) for the anon role, so RLS already fails closed
-- before this trigger would ever see such an UPDATE.
create or replace function staff_guard_supervisor_update()
returns trigger
language plpgsql
as $$
begin
  if new.supervisor_id is not distinct from old.supervisor_id then
    return new;
  end if;

  if auth.uid() is null then
    return new;
  end if;

  if not exists (
    select 1 from staff me
    where me.id = auth.uid()
      and (me.system_role in ('manager','admin','owner') or me.rank = 'manager')
  ) then
    raise exception 'Only a manager can change a staff member''s supervisor.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists staff_guard_supervisor_update_trg on staff;
create trigger staff_guard_supervisor_update_trg
  before update on staff
  for each row execute function staff_guard_supervisor_update();

alter table attendance add column if not exists late_reason_code text;
alter table attendance add column if not exists late_reason      text;
alter table attendance add column if not exists late_excused     boolean not null default false;
alter table attendance add column if not exists late_excused_by  uuid references staff(id);
alter table attendance add column if not exists late_excused_at  timestamptz;

alter table attendance drop constraint if exists attendance_late_reason_code_check;
alter table attendance add constraint attendance_late_reason_code_check
  check (late_reason_code is null or late_reason_code in
    ('traffic','transport','medical','work_errand','personal','other'));

-- v8: late_reason is the only free-text field in this feature, it is typed by
-- the staff member, and notify_late() concatenates it verbatim into the body
-- of the notification their supervisor reads. Nothing bounded it at any layer
-- — `text` is unbounded, the textarea has no maxLength, and PostgREST passes
-- whatever arrives. 500 characters is generous for "why I was late" (several
-- sentences) while keeping a notification body readable in the inbox list and
-- keeping a single row from being used to bloat the notifications table.
-- Same drop-then-add idiom as the code check above, so re-running this file
-- after an edit replaces the constraint rather than silently keeping the first
-- definition forever. No backfill concern: late_reason is added by this same
-- file (above) and is null for every existing row at the moment this runs.
alter table attendance drop constraint if exists attendance_late_reason_length_check;
alter table attendance add constraint attendance_late_reason_length_check
  check (late_reason is null or char_length(late_reason) <= 500);

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

-- excuse_lateness is called via supabase.rpc() by a caller the function's own
-- auth.uid() check authorises (rank/system_role or being the target's
-- supervisor). Postgres grants EXECUTE on new functions to PUBLIC by default;
-- REVOKE here closes that off explicitly rather than relying on the runtime
-- check alone to keep unauthenticated/anon callers out. REVOKE and GRANT are
-- both idempotent — safe to re-run, and CREATE OR REPLACE FUNCTION above does
-- not reset a function's privileges, so this only has to take effect once.
revoke execute on function excuse_lateness(uuid) from public;
revoke execute on function excuse_lateness(uuid) from anon;
grant  execute on function excuse_lateness(uuid) to authenticated;

-- ── attendance_guard_late_update ────────────────────────────────────────────
-- A WHITELIST over a row-wide UPDATE policy (v8). v5-v7 grew this as a
-- BLACKLIST — it named the columns it protected and left everything else to
-- attendance_self_update — and a blacklist cannot work here. See the v8 note
-- in this file's header changelog for the two paths that defeated it (moving
-- `date` out of the review month; nulling `clock_in` to manufacture the
-- clock-in carve-out) and for why the shape, not the coverage, was the bug.
--
-- WHY A TRIGGER AT ALL. RLS on `attendance` is row-scoped, never
-- column-scoped. attendance_self_update (schema.sql:509-510) is
--   create policy "attendance_self_update" on attendance for update to
--     authenticated using (staff_id = auth.uid());
-- Postgres reuses that USING expression as the policy's WITH CHECK, since no
-- WITH CHECK is given — so staff_id itself IS pinned and a staff member
-- cannot re-target their row onto someone else. Every OTHER column is
-- unpinned, and `authenticated` also holds the default table-wide UPDATE
-- grant, so the row's owner can set any of them to any value straight from
-- the browser console. No policy can narrow that. Only a trigger can.
--
-- THE RULE. When all three of these hold —
--   (a) auth.uid() is not null (see the last paragraph for why null is let
--       through),
--   (b) the row belongs to the caller — checked on OLD *and* NEW, see below,
--   (c) the caller does NOT satisfy v_attendance_manage_authority
-- — then the only columns that caller may change are:
--
--   ALWAYS
--     clock_out, clock_out_photo_url, clock_out_lat, clock_out_lng,
--     clock_out_distance_m                              (the clock-out group)
--     break_start, break_end, break_minutes, break_late,
--     break_overrun_minutes                             (the break group)
--
--   AND, ONLY on the genuine clock-in transition — old.clock_in is null and
--   new.clock_in is not null, which can now only be reached once because
--   `clock_in` is itself outside the whitelist and so cannot be nulled back:
--     clock_in, clock_in_photo_url, clock_in_lat, clock_in_lng,
--     clock_in_distance_m                               (the clock-in group)
--     status, late_minutes, late_reason_code, late_reason
--
-- Anything else that differs raises. The diff is taken with
-- to_jsonb(new)/to_jsonb(old) minus the writable keys — the same idiom
-- notifications_guard_recipient_update() uses above, deliberately, so the two
-- guards on this migration read the same way.
--
-- WHAT THIS BUYS WITHOUT NAMING IT. `date` (Path A: countLateDays() in
-- src/features/team/Reviews.tsx counts with `.gte('date', start).lte('date',
-- end)`, so moving the day moves the ten-point deduction with it), `staff_id`,
-- `clock_in` on its own (Path B), `notes` (where migration-2026-09-02-rejudge-
-- boundary-late.sql writes its audit trail), `marked_by` and `recorded_by`
-- (provenance), `scheduled_shift_id`, `created_at`, `id` — and every column
-- added to this table in future, which is the real point: a new column is
-- guarded the day it is added, with nothing here to remember to update.
--
-- THE THREE CHECKS, AND WHY THEY ARE NOT ONE. This function enforces three
-- deliberately different rules, in this order:
--
--   1. late_reason_code / late_reason are APPEND-ONLY, for every caller.
--      Kept from v5 unchanged. The whitelist below only ever constrains a
--      non-manager acting on their own row, so without this a supervisor or
--      manager could still rewrite a reason after it had been read. The staff
--      member writes their own reason exactly once, in the same upsert that
--      records the late clock-in (writeClockIn, src/features/hr/
--      HrAttendance.tsx); no flow in this app edits an already-recorded
--      reason, so a change is rejected outright once the old value is
--      non-null.
--
--   2. late_excused / late_excused_by / late_excused_at are gated on
--      v_excuse_lateness_authority — the NARROW test, copied verbatim from
--      excuse_lateness()'s own authorisation comment (manager-tier by
--      system_role/rank, or being the target's named supervisor_id) — for
--      EVERY caller, managers included. This is what makes excuse_lateness()
--      the only route to an excuse, so it must not be folded into the
--      whitelist. auth.uid() reads the request.jwt.claims session GUC, and
--      SECURITY DEFINER changes only the executing role, not session GUCs, so
--      excuse_lateness()'s own UPDATE reaches this check and passes it exactly
--      when that function's own guard already passed.
--
--   3. The whitelist, gated on v_attendance_manage_authority — the BROAD test,
--      copied verbatim from attendance_manage's own USING clause
--      (schema.sql:505-506, `current_rank() in ('supervisor','manager')`).
--      Do NOT merge check 3's test into check 2's or vice versa. They answer
--      different questions. Check 2 asks "would excuse_lateness() let THIS
--      caller excuse THIS staff member" — a per-target question that
--      intentionally excludes a plain rank = 'supervisor' account unless they
--      are named as that person's supervisor_id. Check 3 asks "does RLS
--      already let this caller write ANY row on this table unconditionally" —
--      and that answer is attendance_manage's rank test, no narrower. Using
--      the narrow test in check 3 would re-break the markAllPresent bug v7
--      fixed: DailyRoster upserts every visible row (including the acting
--      supervisor's own) in one statement and does not check the outcome, so
--      an exception on their own row silently aborts the whole team's write.
--      Using the broad test in check 2 would widen who can excuse a specific
--      person's lateness. Both expressions are named as their own variable
--      below so neither reads as a copy of the other by accident.
--
-- WHY THE EXCUSE COLUMNS ARE ALSO IN THE WRITABLE SET IN CHECK 3. They are
-- appended to v_writable_keys unconditionally, which is NOT a hole: check 2
-- runs first and has already raised for any caller not authorised to touch
-- them, so the only callers that reach check 3 with those columns changed are
-- ones check 2 authorised. Leaving them in the diff instead would double-gate
-- them with the BROAD test and break the one real case where the two tests
-- disagree — a system_role in ('manager','admin','owner') account whose rank
-- is not 'supervisor'/'manager' calling excuse_lateness() on their OWN row:
-- authorised by check 2, refused by check 3, for no security gain.
--
-- WHY THE OWNERSHIP TEST READS BOTH OLD AND NEW. `old.staff_id = auth.uid()
-- or new.staff_id = auth.uid()`, not new alone. attendance_self_update's
-- inherited WITH CHECK already stops the row being re-targeted, so new alone
-- is sufficient today — but the whole point of v8 is not to depend on a
-- policy staying exactly as it is. Reading OLD too means that if that policy
-- ever gains an explicit `with check (true)`, a caller still cannot hand
-- their own row away by changing staff_id in the same statement that would
-- otherwise take it outside this branch.
--
-- auth.uid() is null in the migration/SQL-editor context (this file's own
-- future re-runs, any script-driven backfill) — allowed through
-- unconditionally, same reasoning as staff_guard_supervisor_update above:
-- every attendance RLS policy is `to authenticated`, so a null auth.uid()
-- here cannot be an anonymous PostgREST caller slipping through; it can only
-- be a migration/service-role context, which bypasses RLS (and this trigger's
-- purpose, if not its execution) regardless.
--
-- NOT AFFECTED. mark_absent_for_missed_shifts() (migration-2026-07-09-auto-
-- absent.sql) is `insert into attendance ... on conflict (staff_id, date) do
-- nothing`, and a BEFORE UPDATE trigger never fires for either arm of that —
-- DO NOTHING performs no UPDATE at all. The staff member's own break writes
-- go to the separate `attendance_breaks` table, which this trigger is not on;
-- the break group is whitelisted here for the legacy columns of the same name
-- on `attendance` itself (schema.sql:737-741), which nothing in src/ currently
-- writes.
create or replace function attendance_guard_late_update()
returns trigger
language plpgsql
as $$
declare
  -- NARROW test — check 2. Mirrors excuse_lateness()'s own authorisation
  -- check (manager-tier by system_role/rank, or being the target's named
  -- supervisor_id), word for word. Guards the three excuse columns only.
  v_excuse_lateness_authority   boolean;
  -- BROAD test — check 3. Mirrors attendance_manage's own USING clause
  -- (schema.sql:505-506, `current_rank() in ('supervisor','manager')`), word
  -- for word. Gates the whitelist only. See the function comment above for
  -- why this one must stay broader rather than reusing the narrow test.
  v_attendance_manage_authority boolean;
  -- The one legitimate self-write of the clock-in group, status, late_minutes
  -- and the late reason. Unreachable twice: clock_in is outside the whitelist,
  -- so a caller who fails the broad test cannot null it back to set this up.
  v_clock_in_transition         boolean;
  -- The whitelist itself, as jsonb keys, built per-statement.
  v_writable_keys               text[];
begin
  if auth.uid() is null then
    return new;
  end if;

  -- Check 1 — append-only late reason, every caller.
  if old.late_reason_code is not null
     and new.late_reason_code is distinct from old.late_reason_code then
    raise exception 'late_reason_code cannot be changed once recorded.'
      using errcode = '42501';
  end if;

  if old.late_reason is not null
     and new.late_reason is distinct from old.late_reason then
    raise exception 'late_reason cannot be changed once recorded.'
      using errcode = '42501';
  end if;

  -- Check 2 — the excuse columns, every caller, narrow test.
  if new.late_excused is distinct from old.late_excused
     or new.late_excused_by is distinct from old.late_excused_by
     or new.late_excused_at is distinct from old.late_excused_at
  then
    select exists (
      select 1 from staff me
      where me.id = auth.uid()
        and (
          me.system_role in ('manager','admin','owner') or me.rank = 'manager'
          or exists (select 1 from staff t where t.id = new.staff_id and t.supervisor_id = me.id)
        )
    ) into v_excuse_lateness_authority;

    if not v_excuse_lateness_authority then
      raise exception
        'late_excused/late_excused_by/late_excused_at can only be changed by someone excuse_lateness() would authorise for this staff member.'
        using errcode = '42501';
    end if;
  end if;

  -- Check 3 — the whitelist, on the caller's own row, broad test.
  if old.staff_id = auth.uid() or new.staff_id = auth.uid() then
    select exists (
      select 1 from staff me
      where me.id = auth.uid()
        and me.rank in ('supervisor','manager')
    ) into v_attendance_manage_authority;

    if not v_attendance_manage_authority then
      v_clock_in_transition := old.clock_in is null and new.clock_in is not null;

      -- Always writable: clocking out, and the legacy break columns.
      v_writable_keys := array[
        'clock_out', 'clock_out_photo_url', 'clock_out_lat', 'clock_out_lng',
        'clock_out_distance_m',
        'break_start', 'break_end', 'break_minutes', 'break_late',
        'break_overrun_minutes'
      ];

      -- Writable only while actually clocking in. writeClockIn (src/features/
      -- hr/HrAttendance.tsx) sets exactly these in the same upsert that first
      -- sets clock_in, on both the punctual and the late path.
      if v_clock_in_transition then
        v_writable_keys := v_writable_keys || array[
          'clock_in', 'clock_in_photo_url', 'clock_in_lat', 'clock_in_lng',
          'clock_in_distance_m',
          'status', 'late_minutes', 'late_reason_code', 'late_reason'
        ];
      end if;

      -- Already fully decided by check 2 above, which raises for anyone not
      -- authorised — see the function comment for why excluding them here
      -- would double-gate them with the broad test instead. Nothing reaches
      -- this line with those columns changed unless check 2 allowed it.
      v_writable_keys := v_writable_keys || array[
        'late_excused', 'late_excused_by', 'late_excused_at'
      ];

      if (to_jsonb(new) - v_writable_keys) is distinct from (to_jsonb(old) - v_writable_keys) then
        raise exception
          'On your own attendance row you may only change the clock-out and break columns — and the clock-in columns, status, late_minutes and the late reason only as part of an actual clock-in. Everything else (date, notes, provenance, and the clock-in photo/GPS evidence) is fixed once recorded.'
          using errcode = '42501';
      end if;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists attendance_guard_late_update_trg on attendance;
create trigger attendance_guard_late_update_trg
  before update on attendance
  for each row execute function attendance_guard_late_update();

-- notify_manager defaults to TRUE for this event, unlike most rows in
-- notification_settings (schema.sql:437-445, where it is off for everything
-- except level_up/review_due/probation_due/registration_request/
-- onboarding_completed).
--
-- v8: it was seeded false, and that was a real regression rather than a
-- preference. notify_late() (sibling migration) originally gated its whole
-- supervisor-tier block on notify_supervisor alone, so the branch-manager
-- fallback for a staff member with no supervisor rode along on that same
-- toggle. Finding 7 correctly made notify_manager an independent gate — but
-- with this seed at false, and `on conflict do nothing` meaning the seed IS
-- the shipped default, the orphan arm was then off out of the box. A staff
-- member with no supervisor_id reached NOBODY: notify_late() still returned 1
-- (their own row), so the client read it as success and said nothing. Before
-- finding 7 they at least reached the branch managers.
--
-- True is the only default that keeps the fallback doing its job: the whole
-- point of the orphan arm is that lateness with no assigned supervisor must
-- still reach a human. An admin who genuinely does not want managers looped
-- in can turn it off in Settings — and `on conflict (event_type) do nothing`
-- means re-running this file never overrides that choice.
insert into notification_settings (event_type, label, notify_staff, notify_supervisor, notify_manager)
values ('attendance_late', 'Late Arrival', true, true, true)
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
