-- ============================================================================
-- Verification script for the late-reason / notification feature (2026-09-02)
--
-- Run this AFTER applying, in order:
--   1. migration-2026-09-02-late-reason-notifications.sql
--   2. migration-2026-09-02-notify-late-fn.sql
--   3. migration-2026-07-09-auto-absent.sql   (re-run — v2 fixes a stale guard)
--
-- WHY THIS EXISTS: none of this can be covered by the test suite. vitest cannot
-- exercise RLS or a Postgres trigger, so "443 tests green" says nothing about
-- whether the guards actually refuse anything. Only a real session can tell you.
--
-- CRITICAL: every guard early-returns when auth.uid() is null. The SQL editor
-- runs as a superuser-ish role with no JWT, so running these statements plainly
-- proves NOTHING — they would all pass. Each section below impersonates a real
-- staff member with `set local request.jwt.claims`, which only works inside a
-- transaction.
--
-- SAFE: every section is BEGIN ... ROLLBACK. Nothing below is persisted, even
-- the statements that are supposed to succeed. Run one section at a time and
-- read the output before moving on.
-- ============================================================================


-- ─── STEP 0 · Fill these in ────────────────────────────────────────────────
-- Pick a PLAIN staff member (rank trainee/junior/senior AND system_role 'staff')
-- who has a late attendance row you can experiment on.

select id, name, rank, system_role, branch_id, supervisor_id
from staff
where status = 'active' and rank in ('trainee','junior','senior')
  and (system_role is null or system_role = 'staff')
order by name;

-- And a late row belonging to them:
-- select id, staff_id, date, status, late_minutes, late_excused, clock_in
-- from attendance where staff_id = '<STAFF_UUID>' and status = 'late' order by date desc limit 5;

-- Note the class the previous review round broke, so you can test it too:
select count(*) as system_role_elevated_but_low_rank
from staff
where status = 'active'
  and system_role in ('hr','supervisor','manager','admin','owner')
  and rank not in ('supervisor','manager');


-- ─── STEP 1 · The live policy text, from the catalog not the files ─────────
-- schema.sql is stale for policies. This is the only authoritative source.

select polname,
       case polcmd when 'r' then 'SELECT' when 'a' then 'INSERT'
                   when 'w' then 'UPDATE' when 'd' then 'DELETE' else 'ALL' end as cmd,
       pg_get_expr(polqual, polrelid)      as using_expr,
       pg_get_expr(polwithcheck, polrelid) as with_check_expr
from pg_policy
where polrelid in ('attendance'::regclass, 'monthly_reviews'::regclass, 'staff'::regclass)
order by polrelid::regclass::text, polname;

-- Expect: NO DELETE policy on attendance or monthly_reviews. The guards have no
-- DELETE arm and rely on that absence. If one exists, stop and report it.

select tgname, tgenabled from pg_trigger
where tgrelid in ('attendance'::regclass, 'staff'::regclass,
                  'monthly_reviews'::regclass, 'notifications'::regclass)
  and not tgisinternal
order by tgrelid::regclass::text, tgname;
-- Expect exactly these 6:
--   attendance_guard_late_update_trg          (BEFORE UPDATE on attendance)
--   attendance_guard_self_insert_trg          (BEFORE INSERT on attendance)
--   staff_guard_supervisor_update_trg         (BEFORE UPDATE on staff)
--   staff_guard_authority_update_trg          (BEFORE UPDATE on staff)
--   monthly_reviews_guard_subject_update_trg  (BEFORE UPDATE on monthly_reviews)
--   notifications_guard_recipient_update_trg  (BEFORE UPDATE on notifications)
-- A missing one means that guard did not install. Do not proceed past this.


-- ─── STEP 2 · Columns present in prod but unknown to the migration ─────────
-- The INSERT guard compares non-whitelisted columns against a hand-listed set of
-- defaults. A prod column with a non-null default that the list does not know
-- would break EVERY self clock-in. This is the highest-value check here.

select column_name, column_default, is_nullable
from information_schema.columns
where table_name = 'attendance'
order by ordinal_position;


-- ─── STEP 3 · The attacks. Each must RAISE. ────────────────────────────────
-- Replace <STAFF_UUID> and <THEIR_LATE_ROW_ID> throughout.

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"<STAFF_UUID>"}';

  -- A · move the row out of the review month
  update attendance set date = '2020-01-01' where id = '<THEIR_LATE_ROW_ID>';
rollback;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"<STAFF_UUID>"}';

  -- B · null the clock-in to manufacture a fresh "clock-in transition"
  update attendance set clock_in = null where id = '<THEIR_LATE_ROW_ID>';
rollback;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"<STAFF_UUID>"}';

  -- C · excuse yourself
  update attendance set late_excused = true where id = '<THEIR_LATE_ROW_ID>';
rollback;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"<STAFF_UUID>"}';

  -- D · rewrite the reason after a supervisor read it
  update attendance set late_reason = 'something else' where id = '<THEIR_LATE_ROW_ID>';
rollback;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"<STAFF_UUID>"}';

  -- E · forge the GPS evidence
  update attendance set clock_in_distance_m = 0 where id = '<THEIR_LATE_ROW_ID>';
rollback;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"<STAFF_UUID>"}';

  -- F · pre-insert a "present" row for a future day, so lateness never happens
  insert into attendance (staff_id, date, status, clock_in, late_minutes)
  values ('<STAFF_UUID>', current_date + 1, 'present', now(), 0);
rollback;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"<STAFF_UUID>"}';

  -- G · promote yourself (this one succeeded before 2026-09-02)
  update staff set system_role = 'admin' where id = '<STAFF_UUID>';
rollback;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"<RESIGNED_STAFF_UUID>"}';

  -- G2 · un-resign yourself. Note "resigned" is a UI lockout only — no RLS
  -- policy reads staff.status — so before 2026-09-02 this restored full access.
  update staff set status = 'active' where id = '<RESIGNED_STAFF_UUID>';
rollback;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"<STAFF_UUID>"}';

  -- H · deny your own review so no supervisor ever scores it
  update monthly_reviews set status = 'completed'
  where staff_id = '<STAFF_UUID>' and status = 'pending';
rollback;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"<STAFF_UUID>"}';

  -- I · zero your own late count directly
  update monthly_reviews set late_count = 0 where staff_id = '<STAFF_UUID>';
rollback;


-- ─── STEP 4 · The legitimate flows. Each must SUCCEED. ─────────────────────
-- A guard that blocks real work is as broken as one that blocks nothing.

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"<STAFF_UUID>"}';

  -- Clock in on a day with no row at all
  insert into attendance (staff_id, date, clock_in, status, late_minutes,
                          late_reason_code, late_reason)
  values ('<STAFF_UUID>', current_date, now(), 'late', 12, 'traffic', 'Jam on the highway');

  -- Then clock out
  update attendance set clock_out = now()
  where staff_id = '<STAFF_UUID>' and date = current_date;

  select status, late_minutes, late_reason_code from attendance
  where staff_id = '<STAFF_UUID>' and date = current_date;
rollback;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"<STAFF_UUID>"}';

  -- Submit your own self-evaluation (pending -> self_done must be allowed)
  update monthly_reviews set status = 'self_done'
  where staff_id = '<STAFF_UUID>' and status = 'pending';
rollback;

-- Mark-all-present as a system_role-elevated, LOW-RANK account.
-- This is the exact case an earlier fix broke, and it fails SILENTLY in the UI
-- because that call site checks nothing. Verify by row count, not by clicking.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"<HR_ROLE_LOW_RANK_STAFF_UUID>"}';

  insert into attendance (staff_id, date, status, recorded_by, marked_by)
  select id, current_date, 'present', '<HR_ROLE_LOW_RANK_STAFF_UUID>', '<HR_ROLE_LOW_RANK_STAFF_UUID>'
  from staff where status = 'active' and branch_id = (
    select branch_id from staff where id = '<HR_ROLE_LOW_RANK_STAFF_UUID>')
  on conflict (staff_id, date) do update
    set status = excluded.status, recorded_by = excluded.recorded_by;

  select count(*) as rows_written from attendance where date = current_date;
rollback;


-- ─── STEP 5 · notify_late tells the truth ──────────────────────────────────
-- It must report the attendance row, not what the caller claims.

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"<STAFF_UUID>"}';

  -- Deliberately lie in the parameters: say 1 minute for a 45-minute row.
  select notify_late('<STAFF_UUID>', current_date, 1, 'personal', 'nothing happened');

  select recipient_id, title, body from notifications
  where subject_staff_id = '<STAFF_UUID>' and subject_date = current_date;
  -- The body must reflect the ROW, not the parameters above.
rollback;

begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"<STAFF_UUID>"}';

  -- A date with no late row must write nothing and report nothing.
  select notify_late('<STAFF_UUID>', current_date - 30, 30, 'traffic', 'x');
rollback;


-- ─── STEP 6 · Idempotency ──────────────────────────────────────────────────
-- Re-run BOTH 2026-09-02 migration files start to finish, a second time.
-- Every statement must succeed. Any error means something is not re-runnable,
-- which matters because these files are pasted by hand.
