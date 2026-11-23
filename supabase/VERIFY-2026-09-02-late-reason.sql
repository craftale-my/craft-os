-- ============================================================================
-- Verification for the late-reason / notification feature (2026-09-02)
--
-- HOW TO USE: run ONE section at a time. Each section is self-contained — it
-- finds its own test subjects in your data, so there is nothing to fill in.
-- Every section rolls back; nothing here is persisted, not even the statements
-- that are supposed to succeed.
--
-- Run only AFTER applying, in this order:
--   1. migration-2026-09-02-late-reason-notifications.sql
--   2. migration-2026-09-02-notify-late-fn.sql
--   3. migration-2026-07-09-auto-absent.sql   (RE-RUN — v2 fixes a stale guard)
--
-- WHY THIS EXISTS: no test in the suite can reach RLS or a Postgres trigger.
-- "481 tests green" says nothing about whether the guards refuse anything.
--
-- WHY IT IMPERSONATES: every guard returns early when auth.uid() is null, and
-- the SQL editor has no JWT. Run these statements as yourself and they ALL
-- succeed — which looks like proof and is the opposite of it. Each section
-- below sets request.jwt.claims to a real staff member first.
--
-- WHAT THIS PROVES, EXACTLY: the guards are TRIGGERS, and a trigger fires for
-- every role, so setting the claim is enough to exercise them. It deliberately
-- does NOT switch to the `authenticated` role: you cannot switch back, and the
-- attacks below all target the staff member's OWN rows, which RLS permits
-- anyway — the trigger is the thing actually stopping them. RLS itself is not
-- under test here; Section 1 prints the live policies so you can read them.
--
-- Each section prints a table: 'pass' means the guard behaved correctly,
-- 'FAIL' means it did not, 'SKIP' means your data has no subject to test with
-- (which is not a pass — find or create one).
-- ============================================================================


-- ─── SECTION 1 · Did the migrations actually land? ─────────────────────────
-- Run this first. If anything here is missing, stop; nothing below is meaningful.

select 'triggers' as check, count(*) as found, 6 as expected,
       case when count(*) = 6 then 'pass' else 'FAIL' end as verdict
from pg_trigger
where not tgisinternal
  and tgname in ('attendance_guard_late_update_trg','attendance_guard_self_insert_trg',
                 'staff_guard_supervisor_update_trg','staff_guard_authority_update_trg',
                 'monthly_reviews_guard_subject_update_trg','notifications_guard_recipient_update_trg')
union all
select 'attendance late_* columns', count(*), 5,
       case when count(*) = 5 then 'pass' else 'FAIL' end
from information_schema.columns
where table_name = 'attendance'
  and column_name in ('late_reason_code','late_reason','late_excused','late_excused_by','late_excused_at')
union all
select 'staff.supervisor_id', count(*), 1,
       case when count(*) = 1 then 'pass' else 'FAIL' end
from information_schema.columns where table_name = 'staff' and column_name = 'supervisor_id'
union all
select 'notifications table', count(*), 1,
       case when count(*) = 1 then 'pass' else 'FAIL' end
from information_schema.tables where table_name = 'notifications'
union all
select 'functions (notify_late, excuse_lateness)', count(*), 2,
       case when count(*) = 2 then 'pass' else 'FAIL' end
from pg_proc where proname in ('notify_late','excuse_lateness')
union all
select 'auto-absent guard is v2 (system_role aware)', count(*), 1,
       case when count(*) = 1 then 'pass' else 'FAIL — re-run migration-2026-07-09-auto-absent.sql' end
from pg_proc where proname = 'mark_absent_for_missed_shifts'
  and prosrc like '%current_system_role%'
union all
-- The guards have no DELETE arm and rely on no self-DELETE policy existing.
select 'no DELETE policy on attendance / monthly_reviews', count(*), 0,
       case when count(*) = 0 then 'pass' else 'FAIL' end
from pg_policy where polcmd = 'd'
  and polrelid in ('attendance'::regclass, 'monthly_reviews'::regclass);


-- The live policy text, from the catalog — schema.sql is stale for policies.
select polrelid::regclass::text as tbl, polname,
       case polcmd when 'r' then 'SELECT' when 'a' then 'INSERT'
                   when 'w' then 'UPDATE' when 'd' then 'DELETE' else 'ALL' end as cmd,
       pg_get_expr(polqual, polrelid) as using_expr
from pg_policy
where polrelid in ('attendance'::regclass, 'monthly_reviews'::regclass, 'staff'::regclass)
order by 1, 2;


-- ─── SECTION 2 · Every column a staff member could still reach ─────────────
-- The INSERT guard compares non-whitelisted columns against a hand-listed set
-- of defaults. A production column the list does not know about breaks EVERY
-- self clock-in. Eyeball this against v_defaults in the migration.

select column_name, data_type, column_default, is_nullable
from information_schema.columns
where table_name = 'attendance' order by ordinal_position;


-- ─── SECTION 3 · The attacks. Every row must say 'pass'. ───────────────────
-- Picks a plain staff member (low rank, no elevated system_role) who has a
-- late row, impersonates them, and tries everything they might try.

begin;

create temp table verify_out(seq int, check_name text, verdict text, detail text) on commit drop;

do $$
declare
  v_staff uuid;
  v_row   uuid;
  v_rev   uuid;
  v_free  date;
begin
  select a.staff_id, a.id into v_staff, v_row
  from attendance a
  join staff s on s.id = a.staff_id
  where a.status = 'late'
    and s.status = 'active'
    and s.rank in ('trainee','junior','senior')
    and coalesce(s.system_role, 'staff') = 'staff'
  order by a.date desc
  limit 1;

  if v_staff is null then
    insert into verify_out values (0, 'SETUP', 'SKIP',
      'No active plain-staff member with a late attendance row. '
      'Mark someone late for a past day first, or this section proves nothing.');
    return;
  end if;

  insert into verify_out values (0, 'SETUP', 'pass',
    'impersonating staff ' || v_staff || ', attendance row ' || v_row);

  perform set_config('request.jwt.claims', json_build_object('sub', v_staff)::text, true);
  -- Prove the impersonation took. If auth.uid() does not read this claim, every
  -- guard below returns early and every attack reports 'pass' — a full screen of
  -- green proving nothing. Refuse to run rather than lie.
  if auth.uid() is distinct from v_staff then
    raise exception 'VERIFY ABORTED: auth.uid() returned % but should be %. '
                    'The impersonation did not take, so nothing below would be '
                    'meaningful. Check how auth.uid() is defined in this project.',
                    coalesce(auth.uid()::text, 'null'), v_staff;
  end if;

  -- A · move the row out of the review month
  begin
    update attendance set date = '2020-01-01' where id = v_row;
    insert into verify_out values (1, 'A · rewrite own attendance date', 'FAIL', 'ALLOWED — the late day can be moved out of the review month');
  exception when others then
    insert into verify_out values (1, 'A · rewrite own attendance date', 'pass', sqlerrm);
  end;

  -- B · null the clock-in to manufacture a fresh "clock-in transition"
  begin
    update attendance set clock_in = null where id = v_row;
    insert into verify_out values (2, 'B · null own clock_in', 'FAIL', 'ALLOWED — the clock-in carve-out can be forged');
  exception when others then
    insert into verify_out values (2, 'B · null own clock_in', 'pass', sqlerrm);
  end;

  -- C · excuse yourself
  begin
    -- Write all three excuse columns, not just the flag: the picked row may
    -- already be excused, and a no-op write never reaches the guard — it would
    -- report the guard as broken when it was simply never asked.
    update attendance
       set late_excused = true, late_excused_by = v_staff, late_excused_at = now()
     where id = v_row;
    insert into verify_out values (3, 'C · excuse own lateness', 'FAIL', 'ALLOWED — the 10-point deduction can be self-removed');
  exception when others then
    insert into verify_out values (3, 'C · excuse own lateness', 'pass', sqlerrm);
  end;

  -- D · rewrite the reason after a supervisor read it
  begin
    update attendance set late_reason = 'rewritten after the fact' where id = v_row;
    insert into verify_out values (4, 'D · rewrite own late reason', 'FAIL', 'ALLOWED — a recorded reason is not append-only');
  exception when others then
    insert into verify_out values (4, 'D · rewrite own late reason', 'pass', sqlerrm);
  end;

  -- E · forge the GPS evidence
  begin
    -- Same no-op trap: the row's distance may already be 0. Always write a
    -- value that differs, while still forging toward "compliant".
    update attendance
       set clock_in_distance_m = case when coalesce(clock_in_distance_m, -1) = 0 then 1 else 0 end
     where id = v_row;
    insert into verify_out values (5, 'E · forge own clock-in distance', 'FAIL', 'ALLOWED — the GPS evidence can be rewritten');
  exception when others then
    insert into verify_out values (5, 'E · forge own clock-in distance', 'pass', sqlerrm);
  end;

  -- F · pre-insert a "present" row so lateness never happens.
  -- Pick a date with no row: a unique-violation would otherwise look like the
  -- guard blocking the insert, which is a false pass.
  select d::date into v_free
  from generate_series(current_date + 1, current_date + 30, interval '1 day') d
  where not exists (select 1 from attendance a where a.staff_id = v_staff and a.date = d::date)
  limit 1;
  if v_free is null then
    insert into verify_out values (6, 'F · pre-insert a future present row', 'SKIP', 'no free date in the next 30 days');
  else
    begin
      insert into attendance (staff_id, date, status, clock_in, late_minutes)
      values (v_staff, v_free, 'present', now(), 0);
      insert into verify_out values (6, 'F · pre-insert a future present row', 'FAIL', 'ALLOWED — lateness can be avoided at source (' || v_free || ')');
    exception when others then
      insert into verify_out values (6, 'F · pre-insert a future present row', 'pass', sqlerrm);
    end;
  end if;

  -- G · promote yourself
  begin
    update staff set system_role = 'admin' where id = v_staff;
    insert into verify_out values (7, 'G · promote self to admin', 'FAIL', 'ALLOWED — every guard above is void');
  exception when others then
    insert into verify_out values (7, 'G · promote self to admin', 'pass', sqlerrm);
  end;

  -- H · rewrite your own staff status. The subject is active, so we write a
  -- DIFFERENT value — writing 'active' would be a no-op the guard skips, and
  -- would read as ALLOWED. The dangerous direction (a resigned account setting
  -- itself back to active) is the same code path and the same guard.
  begin
    update staff set status = 'resigned' where id = v_staff;
    insert into verify_out values (8, 'H · rewrite own staff status', 'FAIL', 'ALLOWED — a resigned account could restore itself the same way');
  exception when others then
    insert into verify_out values (8, 'H · rewrite own staff status', 'pass', sqlerrm);
  end;

  -- I · deny your own review so no supervisor ever scores it
  select id into v_rev from monthly_reviews where staff_id = v_staff and status = 'pending' limit 1;
  if v_rev is null then
    insert into verify_out values (9, 'I · self-complete own review', 'SKIP', 'no pending monthly_review for this staff member');
  else
    begin
      update monthly_reviews set status = 'completed' where id = v_rev;
      insert into verify_out values (9, 'I · self-complete own review', 'FAIL', 'ALLOWED — score freezes at 100, no supervisor ever sees it');
    exception when others then
      insert into verify_out values (9, 'I · self-complete own review', 'pass', sqlerrm);
    end;
  end if;

  -- J · zero your own late count directly. Guarded by an existence check: with
  -- no review row the update touches nothing, raises nothing, and would read as
  -- ALLOWED without any attack having happened.
  if not exists (select 1 from monthly_reviews where staff_id = v_staff and late_count is distinct from 0) then
    insert into verify_out values (10, 'J · zero own late_count', 'SKIP', 'no monthly_review with a non-zero late_count for this staff member');
  else
    begin
      update monthly_reviews set late_count = 0 where staff_id = v_staff and late_count is distinct from 0;
      insert into verify_out values (10, 'J · zero own late_count', 'FAIL', 'ALLOWED — attendance_score restored without touching attendance');
    exception when others then
      insert into verify_out values (10, 'J · zero own late_count', 'pass', sqlerrm);
    end;
  end if;
end $$;

select seq, check_name, verdict, left(detail, 110) as detail from verify_out order by seq;

rollback;


-- ─── SECTION 4 · The legitimate flows. Every row must say 'pass'. ──────────
-- A guard that blocks real work is as broken as one that blocks nothing.

begin;

create temp table verify_out(seq int, check_name text, verdict text, detail text) on commit drop;

do $$
declare
  v_staff uuid;
  v_hr    uuid;
  v_n     int;
begin
  select s.id into v_staff from staff s
  where s.status = 'active' and s.rank in ('trainee','junior','senior')
    and coalesce(s.system_role, 'staff') = 'staff'
    and not exists (select 1 from attendance a where a.staff_id = s.id and a.date = current_date)
  limit 1;

  if v_staff is null then
    insert into verify_out values (0, 'SETUP', 'SKIP', 'every plain staff member already has a row for today');
    return;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_staff)::text, true);
  -- Prove the impersonation took. If auth.uid() does not read this claim, every
  -- guard below returns early and every attack reports 'pass' — a full screen of
  -- green proving nothing. Refuse to run rather than lie.
  if auth.uid() is distinct from v_staff then
    raise exception 'VERIFY ABORTED: auth.uid() returned % but should be %. '
                    'The impersonation did not take, so nothing below would be '
                    'meaningful. Check how auth.uid() is defined in this project.',
                    coalesce(auth.uid()::text, 'null'), v_staff;
  end if;

  -- Clock in late, with a reason
  begin
    insert into attendance (staff_id, date, clock_in, status, late_minutes, late_reason_code, late_reason)
    values (v_staff, current_date, now(), 'late', 12, 'traffic', 'Jam on the highway');
    insert into verify_out values (1, 'clock in late, with a reason', 'pass', 'accepted');
  exception when others then
    insert into verify_out values (1, 'clock in late, with a reason', 'FAIL', 'BLOCKED: ' || sqlerrm);
  end;

  -- Then clock out
  begin
    update attendance set clock_out = now() where staff_id = v_staff and date = current_date;
    insert into verify_out values (2, 'clock out', 'pass', 'accepted');
  exception when others then
    insert into verify_out values (2, 'clock out', 'FAIL', 'BLOCKED: ' || sqlerrm);
  end;

  -- Submit your own self-evaluation: pending -> self_done must be allowed
  if exists (select 1 from monthly_reviews where staff_id = v_staff and status = 'pending') then
    begin
      update monthly_reviews set status = 'self_done' where staff_id = v_staff and status = 'pending';
      insert into verify_out values (3, 'submit own self-evaluation', 'pass', 'accepted');
    exception when others then
      insert into verify_out values (3, 'submit own self-evaluation', 'FAIL', 'BLOCKED: ' || sqlerrm);
    end;
  else
    insert into verify_out values (3, 'submit own self-evaluation', 'SKIP', 'no pending review for this staff member');
  end if;

  -- Mark-all-present as a system_role-elevated LOW-RANK account.
  -- This is the case an earlier fix broke, and it fails SILENTLY in the UI.
  select id into v_hr from staff
  where status = 'active'
    and system_role in ('hr','supervisor','manager','admin','owner')
    and rank not in ('supervisor','manager')
  limit 1;

  if v_hr is null then
    insert into verify_out values (4, 'mark-all-present as elevated low-rank', 'SKIP',
      'no staff member has an elevated system_role with a low rank — nothing to test');
  else
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr)::text, true);
    if auth.uid() is distinct from v_hr then
      raise exception 'VERIFY ABORTED: impersonation of the elevated account did not take';
    end if;
      begin
      insert into attendance (staff_id, date, status, recorded_by, marked_by)
      select s.id, current_date, 'present', v_hr, v_hr
      from staff s where s.status = 'active'
        and s.branch_id is not distinct from (select branch_id from staff where id = v_hr)
      on conflict (staff_id, date) do update set status = excluded.status, recorded_by = excluded.recorded_by;
      get diagnostics v_n = row_count;
      insert into verify_out values (4, 'mark-all-present as elevated low-rank', 'pass', v_n || ' rows written');
    exception when others then
      insert into verify_out values (4, 'mark-all-present as elevated low-rank', 'FAIL',
        'the whole batch aborted (silent in the UI): ' || sqlerrm);
    end;
  end if;
end $$;

select seq, check_name, verdict, left(detail, 110) as detail from verify_out order by seq;

rollback;


-- ─── SECTION 5 · notify_late reports the row, not what it is told ──────────

begin;

create temp table verify_out(seq int, check_name text, verdict text, detail text) on commit drop;

do $$
declare
  v_staff uuid;
  v_body  text;
  v_res   jsonb;
begin
  select a.staff_id into v_staff from attendance a
  join staff s on s.id = a.staff_id
  where a.status = 'late' and a.date >= current_date - 7
    and s.status = 'active' and coalesce(s.system_role,'staff') = 'staff'
  order by a.date desc limit 1;

  if v_staff is null then
    insert into verify_out values (0, 'SETUP', 'SKIP', 'no late row in the last 7 days for a plain staff member');
    return;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_staff)::text, true);
  -- Prove the impersonation took. If auth.uid() does not read this claim, every
  -- guard below returns early and every attack reports 'pass' — a full screen of
  -- green proving nothing. Refuse to run rather than lie.
  if auth.uid() is distinct from v_staff then
    raise exception 'VERIFY ABORTED: auth.uid() returned % but should be %. '
                    'The impersonation did not take, so nothing below would be '
                    'meaningful. Check how auth.uid() is defined in this project.',
                    coalesce(auth.uid()::text, 'null'), v_staff;
  end if;

  -- Lie in the parameters: claim 1 minute and a different reason.
  select notify_late(v_staff, (select max(date) from attendance where staff_id = v_staff and status = 'late'),
                     1, 'personal', 'nothing happened') into v_res;

  select body into v_body from notifications
  where subject_staff_id = v_staff order by created_at desc limit 1;

  insert into verify_out values (1, 'notify_late return shape', 
    case when v_res ? 'enabled' and v_res ? 'staff' and v_res ? 'supervisor' then 'pass' else 'FAIL' end,
    v_res::text);

  insert into verify_out values (2, 'notification body ignores the false 1-minute claim',
    case when v_body is null then 'SKIP'
         when v_body like '%1 min late%' then 'FAIL — it repeated the caller''s lie'
         else 'pass' end,
    coalesce(left(v_body, 100), 'no notification written'));
end $$;

select seq, check_name, verdict, left(detail, 110) as detail from verify_out order by seq;

rollback;


-- ─── SECTION 6 · Idempotency ───────────────────────────────────────────────
-- Re-run BOTH 2026-09-02 migration files start to finish, a second time.
-- Every statement must succeed. An error means something is not re-runnable,
-- which matters because these files are pasted by hand.
