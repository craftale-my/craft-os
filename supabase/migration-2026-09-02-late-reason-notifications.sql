-- ============================================================================
-- Late reason + notifications, schema only (2026-09-02, v3). Idempotent.
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
-- (DailyRoster.setStatus, markAllPresent). See the trigger's own comment for
-- why late_excused/late_excused_by/late_excused_at are gated on
-- excuse_lateness()'s exact authority test, and why late_reason_code/
-- late_reason are instead made append-only rather than authority-gated.
--
-- v6 addresses a further review finding against v5 itself: v5 left status
-- and late_minutes ungated on the reasoning that DailyRoster.setStatus and
-- markAllPresent depend on writing them — but those are the MANAGER path,
-- covered by attendance_manage (schema.sql:505-506). The staff member's OWN
-- path is attendance_self_update (schema.sql:509-510), which is just as
-- row-scoped and column-blind, with no `with check` at all:
--   create policy "attendance_self_update" on attendance for update to
--     authenticated using (staff_id = auth.uid());
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
-- C1 (see v5 note above): closes the column-blindness of attendance_self_
-- update and attendance_manage for late_excused/late_excused_by/
-- late_excused_at and late_reason_code/late_reason, without touching either
-- policy. v6/v7 (see notes above) extend the same trigger to status/
-- late_minutes, but only for a caller acting on their OWN row — anyone
-- acting on someone else's row keeps exactly the freedom attendance_manage
-- already grants (DailyRoster.setStatus and markAllPresent are unaffected
-- for them). No other column is touched.
--
-- This function now enforces TWO deliberately different authority tests,
-- each named as its own variable below so neither reads as a copy of the
-- other by accident:
--   * v_excuse_lateness_authority — the NARROW test, copied verbatim from
--     excuse_lateness()'s own comment: manager-tier by system_role/rank, or
--     being the target's named supervisor_id. Guards late_excused/
--     late_excused_by/late_excused_at only.
--   * v_attendance_manage_authority — the BROAD test, copied verbatim from
--     attendance_manage's own USING clause (schema.sql:505-506): rank in
--     ('supervisor','manager'), full stop. Guards status/late_minutes only.
-- They differ because they answer different questions. The excuse columns
-- ask "would excuse_lateness() let this specific caller excuse THIS
-- specific staff member" — a per-target check that intentionally excludes a
-- plain rank = 'supervisor' account unless they are named as that person's
-- supervisor_id. The status/late_minutes columns ask "does RLS already let
-- this caller write ANY row on this table unconditionally" — and the answer
-- to that is attendance_manage's rank in ('supervisor','manager') test, no
-- narrower. Do not merge these into one shared check: doing so would either
-- re-break the markAllPresent bug v7 fixes (if the merged check used the
-- narrow test) or loosen who can excuse a specific person's lateness (if it
-- used the broad test).
--
-- late_excused / late_excused_by / late_excused_at: guarded by
-- v_excuse_lateness_authority, the identical authority test excuse_lateness()
-- applies against the row's staff_id, copied verbatim from that function's
-- own comment so the two definitions of "who may excuse this row" cannot
-- drift apart. auth.uid() reads the request.jwt.claims session GUC;
-- SECURITY DEFINER changes only the executing role, not session-level GUCs,
-- so auth.uid() still resolves to the real calling user inside
-- excuse_lateness() itself — meaning that function's own UPDATE reaches this
-- same check and passes it precisely when excuse_lateness()'s own guard
-- already passed. Nothing legitimate is newly blocked; nothing illegitimate
-- is newly allowed.
--
-- late_reason_code / late_reason: made append-only from the client instead
-- of authority-gated. The staff member writes their own reason exactly once,
-- bundled into the same upsert that records the late clock-in itself
-- (writeClockIn in src/features/hr/HrAttendance.tsx) — legitimate
-- self-service that must keep working whether it lands as an INSERT
-- (attendance_self_clock) or as an UPDATE via ON CONFLICT (attendance_self_
-- update, e.g. when markAllPresent or a manual status change already created
-- the day's row first). No flow in this app edits an already-recorded
-- reason, so rather than inventing an authority line for a flow that doesn't
-- exist, a change is rejected outright once the old value is non-null —
-- closing the specific rewrite-after-the-fact path the review flagged, for
-- any caller, not only the row's own staff member.
--
-- status / late_minutes (added in v6, widened in v7): guarded only when
-- new.staff_id = auth.uid() — the caller is acting on their OWN row.
-- attendance_self_update can never reach any other row, so that is also the
-- only case that needs guarding here; a caller changing someone else's row
-- already went through attendance_manage to get this far, and that policy is
-- untouched. v_attendance_manage_authority is attendance_manage's own
-- boundary (rank in ('supervisor','manager')), so a supervisor or manager
-- acting on their OWN row (their name can appear in DailyRoster's own roster
-- same as anyone else's) keeps exactly the same authority as one acting on
-- anyone else's — see the v7 changelog note above for why this must be the
-- broad test, not excuse_lateness()'s narrow one. The one carve-out for a
-- caller who fails that test is clocking in: old.clock_in is null and
-- new.clock_in is not null identifies that exact transition (writeClockIn in
-- src/features/hr/HrAttendance.tsx always sets clock_in in the same upsert
-- that sets status/late_minutes) and is let through unconditionally.
-- Everything else such a caller might try against their own status/
-- late_minutes — re-clocking in, or a raw supabase.from('attendance').update
-- ({ status: 'present' }) from the console — is rejected.
--
-- auth.uid() is null in the migration/SQL-editor context (this file's own
-- future re-runs, any script-driven backfill) — allowed through
-- unconditionally, same reasoning as staff_guard_supervisor_update above:
-- every attendance RLS policy is `to authenticated`, so a null auth.uid()
-- here cannot be an anonymous PostgREST caller slipping through; it can only
-- be a migration/service-role context, which bypasses RLS (and this
-- trigger's purpose, if not its execution) regardless.
create or replace function attendance_guard_late_update()
returns trigger
language plpgsql
as $$
declare
  -- NARROW test: mirrors excuse_lateness()'s own authorisation check
  -- (system_role/rank manager-tier, or being the target's named
  -- supervisor_id), word for word. Guards late_excused/late_excused_by/
  -- late_excused_at only — see the function comment above for why.
  v_excuse_lateness_authority boolean;
  -- BROAD test: mirrors attendance_manage's own USING clause
  -- (schema.sql:505-506, `current_rank() in ('supervisor','manager')`), word
  -- for word. Guards status/late_minutes only — see the function comment
  -- above, and the v7 changelog note, for why this one must stay broader
  -- than v_excuse_lateness_authority rather than reusing it.
  v_attendance_manage_authority boolean;
begin
  if auth.uid() is null then
    return new;
  end if;

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

  -- v6/v7: status/late_minutes, but only when the caller is acting on their
  -- OWN row (new.staff_id = auth.uid()) — attendance_self_update can never
  -- reach any other row, so this is the only case that needs guarding here;
  -- someone else's row is reached only via attendance_manage, untouched
  -- below. The clock-in transition is always allowed (writeClockIn
  -- legitimately sets both columns there); everything else on the caller's
  -- own row requires v_attendance_manage_authority — the BROAD test, not
  -- v_excuse_lateness_authority — so a rank = 'supervisor' caller (who
  -- already has unrestricted write over every row via attendance_manage) is
  -- not tripped by this trigger on their own row. See the v7 changelog note
  -- above: that mismatch is exactly what let a supervisor's own row abort
  -- markAllPresent's whole-team upsert.
  if new.staff_id = auth.uid()
     and (new.status is distinct from old.status
          or new.late_minutes is distinct from old.late_minutes)
     and not (old.clock_in is null and new.clock_in is not null)
  then
    select exists (
      select 1 from staff me
      where me.id = auth.uid()
        and me.rank in ('supervisor','manager')
    ) into v_attendance_manage_authority;

    if not v_attendance_manage_authority then
      raise exception
        'status/late_minutes on your own attendance row can only be changed by clocking in, or by someone attendance_manage already trusts with blanket attendance write (rank supervisor or manager).'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists attendance_guard_late_update_trg on attendance;
create trigger attendance_guard_late_update_trg
  before update on attendance
  for each row execute function attendance_guard_late_update();

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
