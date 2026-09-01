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
-- manager tier), then returns how many rows it wrote so the caller can
-- confirm the fan-out actually happened.
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
-- ============================================================================

create or replace function notify_late(
  p_staff_id     uuid,
  p_date         date,
  p_late_minutes int,
  p_reason_code  text,
  p_reason       text
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings      notification_settings%rowtype;
  v_staff         staff%rowtype;
  v_shift         text;
  v_reason        text;
  v_staff_title   text;
  v_orphan        boolean;
  v_recipient_ids uuid[];
  v_count         int := 0;
  v_rows          int;
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

  select * into v_settings from notification_settings where event_type = 'attendance_late';
  if v_settings.event_type is null or not v_settings.enabled then return 0; end if;

  select * into v_staff from staff where id = p_staff_id;
  if v_staff.id is null then return 0; end if;

  select to_char(st.start_time, 'HH12:MIam') into v_shift
  from scheduled_shifts ss join shift_types st on st.id = ss.shift_type_id
  where ss.staff_id = p_staff_id and ss.date = p_date;

  v_reason := coalesce(
    nullif(initcap(replace(p_reason_code, '_', ' ')), ''), 'Not given')
    || coalesce(' — "' || nullif(btrim(p_reason), '') || '"', '');

  -- Finding 3: a self-referential supervisor_id is data corruption the
  -- sibling migration's CHECK constraint now prevents going forward, but is
  -- treated exactly like a null one here too, so the manager fallback fires
  -- (and the "No supervisor is assigned" sentence shows) instead of nobody
  -- being notified.
  v_orphan := v_staff.supervisor_id is null or v_staff.supervisor_id = v_staff.id;

  -- Finding 5: p_date need not be today (a late reason can be filed for an
  -- earlier date), so the staff-facing title has to say so.
  v_staff_title := 'You were marked late ' || case
    when p_date = (now() at time zone 'Asia/Kuala_Lumpur')::date then 'today'
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
      'Clocked in ' || p_late_minutes || ' min late for the ' || coalesce(v_shift, 'scheduled') ||
      ' shift. Reason recorded: ' || v_reason || '.',
      '/hr/attendance', p_staff_id, p_date)
    on conflict (recipient_id, event_type, subject_staff_id, subject_date) do nothing;
    get diagnostics v_rows = row_count;
    v_count := v_count + v_rows;
  end if;

  -- The supervisor, or — when none is assigned (including a self-referential
  -- supervisor_id, see v_orphan above) — the branch manager tier, told why.
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
  if v_settings.notify_supervisor then
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
        'Clocked in ' || p_late_minutes || ' min late for the ' || coalesce(v_shift, 'scheduled') ||
        ' shift. Reason: ' || v_reason || '.' ||
        case when v_orphan then ' No supervisor is assigned to this staff member.' else '' end,
        case when v_orphan then '/staff/' || p_staff_id else '/hr/attendance' end,
        p_staff_id, p_date
      from unnest(v_recipient_ids) as rid
      on conflict (recipient_id, event_type, subject_staff_id, subject_date) do nothing;
      get diagnostics v_rows = row_count;
      v_count := v_count + v_rows;
    end if;
  end if;

  return v_count;
end $$;

-- Finding 2: EXECUTE on new functions is granted to PUBLIC by default, which
-- includes the anon role — nothing in this repo revoked that for notify_late.
-- notify_late is called via supabase.rpc() by any authenticated staff member
-- reporting their own lateness, so 'authenticated' is the only role it needs.
-- Both REVOKE and GRANT are idempotent — safe to re-run — and CREATE OR
-- REPLACE FUNCTION above does not reset a function's privileges, so this only
-- has to take effect once; it's restated here for anyone re-running this file.
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
