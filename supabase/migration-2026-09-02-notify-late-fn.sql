-- ============================================================================
-- notify_late() fan-out + supervisor_id backfill (2026-09-02). Idempotent.
--
-- Consumes migration-2026-09-02-late-reason-notifications.sql: the
-- notifications table + its unique (recipient_id, event_type,
-- subject_staff_id, subject_date) constraint, the notification_settings row
-- for 'attendance_late', and staff.supervisor_id (added there, still unset
-- for everyone). notify_late() is the RPC the app calls once a late clock-in
-- has a reason attached; it writes one notification to the staff member and
-- one to their supervisor (or, when none is assigned, to the branch's
-- manager tier), then returns a jsonb summary — { enabled, staff, supervisor }
-- — so the caller can tell apart "the supervisor was told", "only the staff
-- member's own copy was written" and "an admin has this event switched off".
-- See finding 10 below for the exact contract.
--
-- Two deliberate departures from a straight transcription of the task brief:
--
--   1. GET DIAGNOSTICS fix. The brief's body does
--        v_count := v_count + 1;                      -- staff branch
--        ...
--        get diagnostics v_count = row_count;          -- supervisor branch
--      `get diagnostics ... = row_count` ASSIGNS the row count of the most
--      recently executed statement — it does not add to v_count. So the
--      supervisor branch silently overwrote whatever the staff branch had
--      counted, and the staff notification dropped out of the return value
--      even though the row was written. A smoke test comparing the return
--      value against `select count(*) from notifications where ...` would
--      look wrong (off by one) even when the function worked correctly.
--      Fixed by reading each branch's row count into its own variable
--      (v_rows) and accumulating into v_count, for both branches — not just
--      the one the brief happened to get to second. This also copes
--      correctly with the supervisor branch inserting more than one row
--      (the branch-manager-tier fallback below can match several managers).
--
--   2. Backfill: only a currently active staff member can be written in as
--      a supervisor. See the comment above each UPDATE below for why, and
--      why leaving the row unfilled (rather than pointing it at someone who
--      can no longer act on it) is the safer failure mode given notify_late()
--      treats supervisor_id is null as its trigger for the branch-manager
--      fallback.
--
-- set search_path = public, pg_temp pins the resolution path for a security
-- definer function — same reasoning as excuse_lateness() in the migration
-- this one consumes: without it, a caller able to create objects earlier in
-- an unpinned search_path could shadow staff/notifications/etc. and run
-- arbitrary code with this function's elevated privileges.
--
-- Review fixes (against the version at commit a048365, never executed
-- against any database, so amended in place rather than layered with a new
-- migration):
--   1. ON CONFLICT DO UPDATE went through notifications' BEFORE UPDATE
--      guard trigger (added in the sibling migration), which raises unless
--      read_at is the only column changed — so the second call to
--      notify_late() for the same (recipient_id, event_type,
--      subject_staff_id, subject_date) raised and rolled back everything the
--      call had already inserted. Replaced with an explicit DELETE of the
--      matching rows followed by a plain INSERT (ON CONFLICT DO NOTHING kept
--      as a concurrency belt). DELETE/INSERT never fire a BEFORE UPDATE
--      trigger, so the guard keeps protecting the recipient-facing UPDATE
--      path unconditionally — no session-flag exemption needed. See the
--      comment above the staff-notification block below for what this means
--      for the recipient.
--   2. The auth guard failed OPEN: `if auth.uid() is not null and ...`
--      skipped the check entirely for a null auth.uid(), i.e. an
--      unauthenticated/anon caller — and Postgres grants EXECUTE on new
--      functions to PUBLIC by default, with nothing in this repo revoking
--      it. Restructured to fail CLOSED (null auth.uid() is rejected
--      outright), and added explicit REVOKE/GRANT statements below so PUBLIC
--      access is also closed at the privilege level, not just at runtime.
--   3. A self-referential staff.supervisor_id (= id) made v_orphan false, so
--      the manager-fallback arm never activated, and the only other arm (the
--      staff member's own id) was then filtered out by `r.id <> p_staff_id`
--      — nobody got notified, silently. v_orphan now also treats
--      supervisor_id = id as orphan; see the sibling migration for the
--      CHECK constraint that stops the row existing going forward.
--   4. The manager-fallback arm matched `s.branch_id is not distinct from
--      v_staff.branch_id`, so two managers/staff who both happen to have a
--      null branch_id matched each other regardless of actual branch.
--      Replaced with the same branch_id-preferred / branch-text-fallback
--      logic can_review_staff() already uses (migration-2026-07-10-
--      supervisor-review-scope.sql), instead of inventing a third rule.
--   5. The staff-facing title was hardcoded "today", which is wrong once
--      p_date isn't the current date. Now conditional on p_date.
--
-- Further review fixes (this session, against the version above; still
-- never executed against any database, so amended in place):
--   6. (I2) p_late_minutes, p_reason_code, p_reason and p_date were taken on
--      faith from the caller and interpolated straight into the notification
--      a supervisor reads. A staff member could re-call this RPC with a
--      false p_late_minutes (e.g. 1, after actually being 45 minutes late)
--      and — because the fan-out is delete-then-insert (finding 1 above) —
--      overwrite the real notification with a fabricated one; an unbounded
--      p_reason and an unchecked p_reason_code made it worse; an
--      unconstrained p_date let the same trick loop over arbitrary dates.
--      Fixed by reading status, late_minutes, late_reason_code and
--      late_reason from the attendance row for (p_staff_id, p_date) instead
--      of the parameters, and returning zero-counts without writing anything
--      if that row doesn't exist or its status isn't 'late'.
--      CORRECTION (finding 12 below): this note used to claim that the
--      row-existence check was ALSO the p_date bound. It is not. A staff
--      member can create their own 'late' attendance rows on arbitrary dates
--      — attendance_self_clock (schema.sql:507-508) is
--      `for insert to authenticated with check (staff_id = auth.uid())`, with
--      no constraint on `date` or `status` — and then call this RPC once per
--      row. The row-existence check only ties the notification's CONTENT to a
--      real row; it bounds nothing. An explicit p_date window does that, and
--      is added in finding 12. p_late_minutes/p_reason_code/p_reason are
--      kept as parameters, unused: dropping them would change this
--      function's signature, and the caller (supabase.rpc('notify_late',
--      {...}) in src/features/hr/HrAttendance.tsx) passes arguments by name
--      — a signature change needs a src/ edit this fix must not make.
--   7. (I5) notify_manager was never read: the branch-manager fallback arm
--      was gated on notify_supervisor alone, so turning "Manager" on in
--      Settings did nothing, and turning "Supervisor" off silently disabled
--      the manager fallback too. The two are now independent gates: the
--      assigned-supervisor arm fires on notify_supervisor and not v_orphan;
--      the manager-fallback arm fires on notify_manager and v_orphan. See
--      the comment above that block for the two edge cases this decides.
--   8. (M1) The reason label was synthesised with
--      initcap(replace(code, '_', ' ')) — 'work_errand' became "Work Errand"
--      (wrong sentence case), 'traffic'/'transport' became "Traffic"/
--      "Transport" instead of "Traffic jam"/"Transport breakdown" — which
--      disagreed with src/shared/lib/lateReason.ts's labels for the same
--      codes, so the roster chip and this notification described the same
--      event differently. Replaced with an explicit mapping of the six codes
--      to those exact six labels.
--   9. (M3) `select ... into v_shift` had no order by / limit. scheduled_
--      shifts already carries a unique(staff_id, date) constraint
--      (schema.sql) so two rows can't currently exist for one lookup — this
--      is belt-and-braces determinism, not a fix for an observed collision.
--
-- Final review pass (still never executed against any database, so still
-- amended in place):
--  10. Return type changed from `int` to `jsonb`, with exactly three keys:
--        { "enabled": true, "staff": 1, "supervisor": 2 }
--      A bare count could not distinguish the three outcomes the caller has
--      to tell apart: "the supervisor tier was notified", "only the staff
--      member's own row was written" and "an admin has turned this event
--      off". All three came back as a number the caller could only compare
--      against 0, and 1 was ambiguous between the second and third. The
--      client (src/features/hr/HrAttendance.tsx) consequently showed "Your
--      supervisor could not be notified." for a disabled event, which is
--      simply untrue — nothing failed; the feature is off. Now:
--        enabled    — false when the event is disabled OR the settings row is
--                     missing entirely (both counts 0 in that case); true
--                     otherwise, including when the counts are 0 for another
--                     reason (no such staff member, no 'late' attendance row
--                     for the date, p_date outside the window in finding 12).
--        staff      — rows written for the staff member themselves.
--        supervisor — rows written for the supervisor tier, INCLUDING the
--                     branch-manager fallback. One number, not two, because
--                     the two arms are alternatives (v_orphan decides which
--                     one runs) and the caller's question is "did anyone
--                     above this person hear about it".
--      Changing the return type means CREATE OR REPLACE cannot be used
--      (Postgres refuses to change a function's return type in place), so
--      the function is dropped first — see the DROP below, and the note above
--      the REVOKE/GRANT block, which a DROP makes load-bearing on every run.
--  11. The 'attendance_late' notification_settings seed had notify_manager
--      false, which — once finding 7 made notify_manager an independent gate
--      — left the orphan fallback OFF on shipped defaults, so a staff member
--      with no supervisor reached nobody while this function still returned 1
--      (their own row) and the client reported success. Fixed in the sibling
--      migration (migration-2026-09-02-late-reason-notifications.sql), where
--      that seed lives; see the comment above it.
--  12. p_date is now explicitly bounded to a recent window (not in the
--      future, not more than 7 days before today in Asia/Kuala_Lumpur).
--      Finding 6's claim that the row-existence check bounded p_date was
--      wrong: attendance_self_clock (schema.sql:507-508) lets a staff member
--      INSERT their own attendance rows with any `date` and any `status`,
--      including 'late', so they could manufacture a row per date and call
--      this RPC on each — delete-then-insert fan-out and all. Seven days is
--      the window this schema already treats as "recent" for attendance:
--      mark_absent_for_missed_shifts() (migration-2026-07-09-auto-absent.sql)
--      uses exactly the same 7-day lookback. It comfortably covers the real
--      cases — same-day filing, a night shift whose attendance day is
--      yesterday (resolveAttendanceDate in src/features/hr/HrAttendance.tsx),
--      and a reason filed after a weekend — while making a mass back-dated
--      spray impossible. Out-of-window returns enabled/0/0 rather than
--      raising, matching how every other "nothing to do" case here behaves,
--      because the client treats this call as fire-and-forget after the
--      clock-in has already been saved.
--  13. Attendance/notification counts are now accumulated into two separate
--      variables (v_staff_rows, v_supervisor_rows) rather than one v_count,
--      to feed the two keys in finding 10. The GET DIAGNOSTICS discipline
--      from finding 1 is unchanged: each statement's row_count is read into
--      its own variable immediately after that statement and added, never
--      assigned across branches.
-- ============================================================================

-- Finding 10: the return type changes from int to jsonb, and Postgres will
-- not let CREATE OR REPLACE change a function's return type in place ("cannot
-- change return type of existing function"). DROP IF EXISTS names the full
-- argument list so it targets exactly this overload and nothing else, and is
-- a no-op on a database that has never seen the function — so this file stays
-- safe to run twice, and safe to run for the first time.
drop function if exists notify_late(uuid, date, int, text, text);

create or replace function notify_late(
  p_staff_id     uuid,
  p_date         date,
  p_late_minutes int,
  p_reason_code  text,
  p_reason       text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings        notification_settings%rowtype;
  v_staff           staff%rowtype;
  v_shift           text;
  v_reason          text;
  v_staff_title     text;
  v_orphan          boolean;
  v_recipient_ids   uuid[];
  -- Finding 13: two counters, not one — they feed the two count keys of the
  -- jsonb contract. v_rows stays the scratch variable that GET DIAGNOSTICS
  -- writes into immediately after each statement (finding 1).
  v_staff_rows      int := 0;
  v_supervisor_rows int := 0;
  v_rows            int;
  v_att_status      text;
  v_att_minutes     int;
  v_att_reason_code text;
  v_att_reason      text;
  -- Today in the branch's own timezone. Used both for the p_date window
  -- (finding 12) and for the staff-facing title's "today" wording (finding 5),
  -- so the two can never disagree about which day "today" is.
  v_today_myt       date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  -- How far back a late reason may be filed. See finding 12: same 7-day
  -- lookback mark_absent_for_missed_shifts() already uses for attendance.
  v_max_backdate_days constant int := 7;
begin
  -- A staff member may only announce their own lateness; managers may do it
  -- for anyone. Fails CLOSED: a null auth.uid() — an unauthenticated or
  -- anon-role call — is rejected up front rather than silently skipping the
  -- check. (Finding 2: Postgres grants EXECUTE on new functions to PUBLIC by
  -- default; the REVOKE/GRANT statements after this function close that off
  -- too, so this check isn't the only thing standing between an anonymous
  -- caller and this function.)
  if auth.uid() is null or (
    auth.uid() <> p_staff_id and not exists (
      select 1 from staff where id = auth.uid()
        and (system_role in ('manager','admin','owner') or rank = 'manager')
    )
  ) then
    raise exception 'notify_late: not allowed' using errcode = '42501';
  end if;

  -- Finding 10: "the admin turned this off" and "the settings row is missing"
  -- are the only two cases that report enabled = false. They are grouped
  -- together deliberately: from the caller's side both mean "this feature is
  -- not switched on", and neither is a failure the staff member can act on.
  select * into v_settings from notification_settings where event_type = 'attendance_late';
  if v_settings.event_type is null or not v_settings.enabled then
    return jsonb_build_object('enabled', false, 'staff', 0, 'supervisor', 0);
  end if;

  -- Finding 12: the p_date window. attendance_self_clock (schema.sql:507-508)
  -- lets a staff member INSERT their own attendance rows on any date with any
  -- status, so without this a caller could manufacture a 'late' row per date
  -- and call this RPC on each, spraying notifications across the supervisor's
  -- inbox. The row-existence check further down does NOT bound this (see the
  -- correction to finding 6 in the header). Future dates are refused outright;
  -- the past is capped at v_max_backdate_days. Returns enabled/0/0 rather than
  -- raising, like every other "nothing to do" branch here — the client calls
  -- this after the clock-in has already been written and must never have the
  -- clock-in undone by a notification problem.
  if p_date > v_today_myt or p_date < v_today_myt - v_max_backdate_days then
    return jsonb_build_object('enabled', true, 'staff', 0, 'supervisor', 0);
  end if;

  select * into v_staff from staff where id = p_staff_id;
  if v_staff.id is null then
    return jsonb_build_object('enabled', true, 'staff', 0, 'supervisor', 0);
  end if;

  -- Finding 6 (I2): the attendance row for (p_staff_id, p_date) is the only
  -- source of truth for what actually happened — not the parameters above,
  -- which the caller controls. This check ties the notification's CONTENT to
  -- a real row; it does NOT bound p_date (an earlier draft of this comment
  -- claimed it did — see the correction to finding 6 in the header, and the
  -- explicit window check further up, which is what actually bounds it).
  -- p_late_minutes/p_reason_code/p_reason are kept as parameters, unused: the
  -- caller passes arguments by name, and this file's return-type change
  -- (finding 10) is already a coordinated src/ change — narrowing the
  -- argument list too would be a second, unrelated break.
  select a.status, a.late_minutes, a.late_reason_code, a.late_reason
    into v_att_status, v_att_minutes, v_att_reason_code, v_att_reason
    from attendance a
    where a.staff_id = p_staff_id and a.date = p_date;

  -- `is distinct from`, not `<>`: attendance.status carries no NOT NULL
  -- constraint (its CHECK doesn't fire on NULL — Postgres CHECKs pass on
  -- NULL by design), so a null status must still read as "not late" rather
  -- than falling through `<>` (which itself evaluates to NULL, and an IF
  -- treats NULL as not-true — i.e. as if this guard hadn't matched at all).
  if not found or v_att_status is distinct from 'late' then
    return jsonb_build_object('enabled', true, 'staff', 0, 'supervisor', 0);
  end if;

  -- Finding 9 (M3): scheduled_shifts already carries a unique(staff_id,
  -- date) constraint (schema.sql), so this order by/limit is belt-and-
  -- braces determinism rather than a fix for an observed collision.
  select to_char(st.start_time, 'HH12:MIam') into v_shift
  from scheduled_shifts ss join shift_types st on st.id = ss.shift_type_id
  where ss.staff_id = p_staff_id and ss.date = p_date
  order by ss.created_at desc
  limit 1;

  -- Finding 8 (M1): explicit mapping, not initcap(replace(code, '_', ' ')).
  -- THIS IS THE OTHER HALF OF A PAIR — src/shared/lib/lateReason.ts
  -- (LATE_REASON_LABELS) owns the same six codes' labels for the roster
  -- chip. If either list changes, update the other to match.
  v_reason := coalesce(
    case v_att_reason_code
      when 'traffic'     then 'Traffic jam'
      when 'transport'   then 'Transport breakdown'
      when 'medical'     then 'Medical'
      when 'work_errand' then 'Work errand'
      when 'personal'    then 'Personal emergency'
      when 'other'       then 'Other'
    end,
    'Not given')
    || coalesce(' — "' || nullif(btrim(v_att_reason), '') || '"', '');

  -- Finding 3: a self-referential supervisor_id is data corruption the
  -- sibling migration's CHECK constraint now prevents going forward, but is
  -- treated exactly like a null one here too, so the manager fallback fires
  -- (and the "No supervisor is assigned" sentence shows) instead of nobody
  -- being notified.
  v_orphan := v_staff.supervisor_id is null or v_staff.supervisor_id = v_staff.id;

  -- Finding 5: p_date need not be today (a late reason can be filed for an
  -- earlier date), so the staff-facing title has to say so.
  v_staff_title := 'You were marked late ' || case
    when p_date = v_today_myt then 'today'
    else 'on ' || to_char(p_date, 'FMDD Mon YYYY')
  end;

  -- The staff member themselves.
  --
  -- Finding 1 / re-notification behaviour: refreshing an existing
  -- notification is DELETE-then-INSERT, not ON CONFLICT DO UPDATE, because
  -- notifications' BEFORE UPDATE guard trigger (notifications_guard_
  -- recipient_update_trg, sibling migration) raises unless read_at is the
  -- only column that changed, and ON CONFLICT DO UPDATE runs through that
  -- same UPDATE path. DELETE/INSERT never fire a BEFORE UPDATE trigger, so
  -- the guard stays intact with no exemption needed. ON CONFLICT DO NOTHING
  -- is kept as a concurrency belt for a second session racing the same
  -- insert. Net effect for the recipient: re-notifying for the same (staff,
  -- date) always comes back unread (read_at reset to null, even if they'd
  -- already read the stale row) under a new notification id. That's the
  -- intended behaviour, not an accepted side effect — a refreshed body (a
  -- corrected reason, updated minutes-late) is new information the recipient
  -- has not seen, so it should reappear as unread. Nothing in this repo
  -- reads or persists a notification's id across calls (the app and RLS key
  -- off recipient_id/event_type/subject_staff_id/subject_date), so the id
  -- changing is unobservable to callers.
  if v_settings.notify_staff then
    delete from notifications
     where recipient_id = p_staff_id and event_type = 'attendance_late'
       and subject_staff_id = p_staff_id and subject_date = p_date;

    insert into notifications (recipient_id, event_type, title, body, link, subject_staff_id, subject_date)
    values (p_staff_id, 'attendance_late', v_staff_title,
      'Clocked in ' || v_att_minutes || ' min late for the ' || coalesce(v_shift, 'scheduled') ||
      ' shift. Reason recorded: ' || v_reason || '.',
      '/hr/attendance', p_staff_id, p_date)
    on conflict (recipient_id, event_type, subject_staff_id, subject_date) do nothing;
    get diagnostics v_rows = row_count;
    v_staff_rows := v_staff_rows + v_rows;
  end if;

  -- The supervisor, or — when none is assigned (including a self-referential
  -- supervisor_id, see v_orphan above) — the branch manager tier, told why.
  --
  -- Finding 7 (I5): notify_supervisor and notify_manager are now two
  -- independent gates instead of one — previously the whole block (both the
  -- assigned-supervisor arm and the orphan/manager-fallback arm) was gated
  -- on notify_supervisor alone, so notify_manager was never read at all.
  -- Now: the assigned-supervisor arm fires on notify_supervisor and not
  -- v_orphan; the manager-fallback arm fires on notify_manager and v_orphan.
  -- Decided behaviour at the two edges:
  --   * notify_supervisor on, notify_manager off: a real supervisor still
  --     gets notified; an orphaned staff member's lateness notifies nobody
  --     in this tier — read as "don't loop managers into cases with no
  --     supervisor", a legitimate choice on its own.
  --   * notify_supervisor off, notify_manager on: an assigned supervisor is
  --     never notified (the toggle is honoured); an orphaned staff member's
  --     lateness still reaches the branch manager tier — otherwise turning
  --     "Supervisor" off would silently strand every orphan case with no
  --     recipient at all, defeating the point of a manager fallback that is
  --     supposed to be independently controlled.
  -- The inner UNION below already returns the supervisor row only `where
  -- not v_orphan` and the manager-tier rows only `where v_orphan`, so gating
  -- the whole block on this OR condition is sufficient — whichever half of
  -- the union is live is already the half the matching toggle allows.
  --
  -- Finding 4: branch match mirrors can_review_staff() (migration-2026-07-10-
  -- supervisor-review-scope.sql) — prefer branch_id when both sides have
  -- one, falling back to the legacy text `branch` column only when at least
  -- one side's branch_id is null. `is not distinct from` would otherwise
  -- match a manager with a null branch_id to a staff member with a null
  -- branch_id regardless of which branch either is actually at.
  --
  -- The recipient set is computed once into an array and reused for both the
  -- DELETE and the INSERT (see the staff-notification comment above for why
  -- this is DELETE-then-INSERT rather than ON CONFLICT DO UPDATE) so the two
  -- statements can't drift out of sync with each other.
  if (v_settings.notify_supervisor and not v_orphan) or (v_settings.notify_manager and v_orphan) then
    select array_agg(r.id) into v_recipient_ids
    from (
      select v_staff.supervisor_id as id where not v_orphan
      union
      select s.id from staff s
      where v_orphan and s.status = 'active'
        and (s.system_role in ('manager','admin','owner') or s.rank = 'manager')
        and (
          (s.branch_id is not null and v_staff.branch_id is not null and s.branch_id = v_staff.branch_id)
          or (
            (s.branch_id is null or v_staff.branch_id is null)
            and s.branch is not null and s.branch = v_staff.branch
          )
        )
    ) r
    where r.id is not null and r.id <> p_staff_id;

    if v_recipient_ids is not null then
      delete from notifications
       where event_type = 'attendance_late'
         and subject_staff_id = p_staff_id and subject_date = p_date
         and recipient_id = any(v_recipient_ids);

      insert into notifications (recipient_id, event_type, title, body, link, subject_staff_id, subject_date)
      select rid, 'attendance_late', 'Late arrival — ' || v_staff.name,
        'Clocked in ' || v_att_minutes || ' min late for the ' || coalesce(v_shift, 'scheduled') ||
        ' shift. Reason: ' || v_reason || '.' ||
        case when v_orphan then ' No supervisor is assigned to this staff member.' else '' end,
        case when v_orphan then '/staff/' || p_staff_id else '/hr/attendance' end,
        p_staff_id, p_date
      from unnest(v_recipient_ids) as rid
      on conflict (recipient_id, event_type, subject_staff_id, subject_date) do nothing;
      get diagnostics v_rows = row_count;
      v_supervisor_rows := v_supervisor_rows + v_rows;
    end if;
  end if;

  -- Finding 10: exactly these three keys, in this shape. The TypeScript caller
  -- (src/features/hr/HrAttendance.tsx) reads them by name — do not rename,
  -- nest or add to them without changing that caller in the same commit.
  -- 'supervisor' deliberately covers BOTH arms above (assigned supervisor and
  -- branch-manager fallback): they are alternatives, never both, and the
  -- caller's question is whether anyone above this staff member heard.
  return jsonb_build_object(
    'enabled',    true,
    'staff',      v_staff_rows,
    'supervisor', v_supervisor_rows
  );
end $$;

-- Finding 2: EXECUTE on new functions is granted to PUBLIC by default, which
-- includes the anon role — nothing in this repo revoked that for notify_late.
-- notify_late is called via supabase.rpc() by any authenticated staff member
-- reporting their own lateness, so 'authenticated' is the only role it needs.
-- Both REVOKE and GRANT are idempotent — safe to re-run.
--
-- Finding 10 made these LOAD-BEARING ON EVERY RUN, not just the first. CREATE
-- OR REPLACE FUNCTION does not reset a function's privileges, but the DROP
-- FUNCTION above does: the recreated function starts again with Postgres's
-- default PUBLIC EXECUTE grant. These three lines are what take it away, so
-- they must stay immediately after the definition and must not be moved into
-- a "first run only" branch.
revoke execute on function notify_late(uuid, date, int, text, text) from public;
revoke execute on function notify_late(uuid, date, int, text, text) from anon;
grant  execute on function notify_late(uuid, date, int, text, text) to authenticated;

-- ── supervisor_id backfill ──────────────────────────────────────────────────
-- Two passes, in priority order: (1) the most recent performance-review
-- reviewer, (2) failing that, the branch's person-in-charge. Both passes are
-- guarded by `supervisor_id is null`, so a staff member who already has a
-- value (set by either pass, or by hand) is never touched again — re-running
-- this file is a no-op for anyone already covered.
--
-- Both passes also require the candidate to be a currently active staff
-- member (status = 'active' and is_active). Neither monthly_reviews.reviewer_id
-- nor branches.pic_staff_id is maintained when the person they point to
-- resigns or is deactivated — there is no trigger anywhere in this schema
-- that clears or updates them — so without this guard the backfill could
-- write a departed reviewer or former branch PIC straight into supervisor_id.
-- That matters specifically because of how notify_late() decides whether to
-- fall back to the branch-manager tier: it checks `supervisor_id is null`,
-- not "is this supervisor someone who can still see a notification". A
-- departed person's row is not deleted (resignation ≠ deletion, per
-- schema.sql's "resigned staff keep all historical data" note), so the FK
-- would happily accept them, RLS would let the insert through, and the
-- notification would land on an account nobody is reading and that — per
-- schema.sql's own comment on the resignation status — is blocked from
-- logging in anyway. The real supervisor-tier alert would then simply never
-- reach anyone, silently, which is worse than the orphan case notify_late()
-- already handles on purpose (an explicit "No supervisor is assigned" note
-- routed to the branch's active managers). Leaving supervisor_id null when
-- the only candidate is inactive preserves that intended fallback instead of
-- defeating it.
--
-- This does not change the backfill's priority order or its two sources —
-- only which rows within each source are eligible to be written.

-- Pass 1: most recent monthly_reviews.reviewer_id who is still active.
-- Filtering staff on activity status INSIDE the "most recent" lookup (rather
-- than computing the single most-recent reviewer and discarding the result
-- if they turn out to be inactive) lets an older but still-active reviewer
-- win when the most recent one has since left, instead of giving up on
-- review history for that staff member entirely.
update staff s set supervisor_id = r.reviewer_id
from (
  select distinct on (mr.staff_id) mr.staff_id, mr.reviewer_id
  from monthly_reviews mr
  join staff rv on rv.id = mr.reviewer_id and rv.status = 'active' and rv.is_active
  where mr.reviewer_id is not null
  order by mr.staff_id, mr.year desc, mr.month desc
) r
where r.staff_id = s.id and s.supervisor_id is null and r.reviewer_id <> s.id;

-- Pass 2: branch person-in-charge, only if still active.
update staff s set supervisor_id = b.pic_staff_id
from branches b
where b.id = s.branch_id and s.supervisor_id is null
  and b.pic_staff_id is not null and b.pic_staff_id <> s.id
  and exists (
    select 1 from staff pic
    where pic.id = b.pic_staff_id and pic.status = 'active' and pic.is_active
  );

-- notify_late is called directly via supabase.rpc(); PostgREST needs a
-- schema cache reload to see it before Supabase's own event trigger gets to it.
notify pgrst, 'reload schema';
