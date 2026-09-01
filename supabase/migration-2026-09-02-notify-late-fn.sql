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
  v_settings  notification_settings%rowtype;
  v_staff     staff%rowtype;
  v_shift     text;
  v_reason    text;
  v_orphan    boolean;
  v_count     int := 0;
  v_rows      int;
begin
  -- A staff member may only announce their own lateness; managers may do it for anyone.
  if auth.uid() is not null and auth.uid() <> p_staff_id then
    if not exists (
      select 1 from staff where id = auth.uid()
        and (system_role in ('manager','admin','owner') or rank = 'manager')
    ) then
      raise exception 'notify_late: not allowed';
    end if;
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

  v_orphan := v_staff.supervisor_id is null;

  -- The staff member themselves.
  if v_settings.notify_staff then
    insert into notifications (recipient_id, event_type, title, body, link, subject_staff_id, subject_date)
    values (p_staff_id, 'attendance_late', 'You were marked late today',
      'Clocked in ' || p_late_minutes || ' min late for the ' || coalesce(v_shift, 'scheduled') ||
      ' shift. Reason recorded: ' || v_reason || '.',
      '/hr/attendance', p_staff_id, p_date)
    on conflict (recipient_id, event_type, subject_staff_id, subject_date)
      do update set title = excluded.title, body = excluded.body, created_at = now(), read_at = null;
    get diagnostics v_rows = row_count;
    v_count := v_count + v_rows;
  end if;

  -- The supervisor, or — when none is assigned — the branch manager tier, told why.
  if v_settings.notify_supervisor then
    insert into notifications (recipient_id, event_type, title, body, link, subject_staff_id, subject_date)
    select r.id, 'attendance_late', 'Late arrival — ' || v_staff.name,
      'Clocked in ' || p_late_minutes || ' min late for the ' || coalesce(v_shift, 'scheduled') ||
      ' shift. Reason: ' || v_reason || '.' ||
      case when v_orphan then ' No supervisor is assigned to this staff member.' else '' end,
      case when v_orphan then '/staff/' || p_staff_id else '/hr/attendance' end,
      p_staff_id, p_date
    from (
      select v_staff.supervisor_id as id where not v_orphan
      union
      select s.id from staff s
      where v_orphan and s.status = 'active'
        and (s.system_role in ('manager','admin','owner') or s.rank = 'manager')
        and (s.branch_id is not distinct from v_staff.branch_id)
    ) r
    where r.id is not null and r.id <> p_staff_id
    on conflict (recipient_id, event_type, subject_staff_id, subject_date)
      do update set title = excluded.title, body = excluded.body, created_at = now(), read_at = null;
    get diagnostics v_rows = row_count;
    v_count := v_count + v_rows;
  end if;

  return v_count;
end $$;

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
