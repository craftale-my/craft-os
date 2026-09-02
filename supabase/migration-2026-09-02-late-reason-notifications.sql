-- ============================================================================
-- Late reason + notifications, schema only (2026-09-02, v11). Idempotent.
--
-- v2 addresses review findings against v1 (never executed against any
-- database, so amended in place rather than layered with a second file):
--   1. Dropped the attendance_update_excuse UPDATE policy. RLS is row-scoped,
--      not column-scoped: the policy would have let callers rewrite any column.
--      Replaced with the excuse_lateness() security definer function below,
--      which authorises the caller itself (by staff.rank or by being named as
--      someone's supervisor_id) and can write only the three excuse columns.
--      Note: the pre-existing attendance_manage policy remains unchanged
--      and grants blanket write access to any column independently;
--      tightening that is out of scope because DailyRoster's status editing
--      depends on it.
--      CORRECTION (v9): this note, and every note below it up to v8, cited
--      that policy as schema.sql:505-506, `current_rank() in ('supervisor',
--      'manager')`. That text is STALE. The live policy is
--      migration-2026-07-08-rls-system-role.sql:37-39 and also allows
--      `current_system_role() in ('hr','supervisor','manager','admin',
--      'owner')`. See the v9 note at the end of this changelog before
--      relying on any policy quoted anywhere in this file.
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
--   CORRECTION (v11): the quote above — `using (id = auth.uid() or
--   current_rank() in ('supervisor','manager'))` — is STALE, cited from
--   schema.sql, and is this branch's fourth instance of the same citation
--   error (see the v9 note further down, PROJECT_NOTES.md section 4, and the
--   header rule above this changelog). The live policy is
--   migration-2026-07-08-rls-system-role.sql:232-233:
--     create policy "staff_update" on staff for update
--       using (id = auth.uid() or (current_rank() in ('supervisor','manager')
--               or current_system_role() in ('hr','supervisor','manager',
--               'admin','owner')));
--   No functional consequence: staff_guard_supervisor_update()'s own
--   authority test (below) is independent of this quote — it re-derives
--   manager-tier itself rather than reading it off the policy — and the extra
--   system_role disjunct the live policy grants does not change what that
--   trigger permits. Fixing the quote and the citation only.
--
-- v5 addresses a review finding (C1) against attendance itself: RLS is
-- row-scoped everywhere on this table, both for attendance_self_update
-- (schema.sql:509-510, `staff_id = auth.uid()`) and for attendance_manage
-- (migration-2026-07-08-rls-system-role.sql:37-39 — this note originally
-- cited the stale schema.sql text; see the v9 correction — any row in any
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
-- covered by attendance_manage (live text: migration-2026-07-08-rls-system-
-- role.sql:37-39; this note originally cited schema.sql:505-506, which is
-- stale — see the v9 correction). The staff member's OWN
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
-- than the policy that actually governs this table, attendance_manage.
-- v7 quoted that policy from schema.sql:505-506 as
--   create policy "attendance_manage" on attendance for all to authenticated
--     using (current_rank() in ('supervisor','manager'));
-- CORRECTION (v9): that quote is STALE and the whole of v7's widening was
-- therefore too narrow. The live policy is migration-2026-07-08-rls-system-
-- role.sql:37-39:
--   create policy "attendance_manage" on attendance for all to authenticated
--     using ((current_rank() in ('supervisor','manager')
--             or current_system_role() in ('hr','supervisor','manager','admin','owner')));
-- v9 fixes the consequence; see the v9 note at the end of this changelog.
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
-- attendance_manage's own boundary — v7 wrote that boundary as `rank in
-- ('supervisor','manager')`, named v_attendance_manage_authority below —
-- instead of reusing the narrower excuse_lateness() test. This is
-- deliberate, not an oversight: this trigger's job is to stop an ORDINARY
-- staff member — someone whose only route to this table is
-- attendance_self_update — from rewriting the verdict on their own
-- attendance. Someone attendance_manage lets through already has
-- unrestricted write over EVERYONE's attendance; guarding only their own row
-- would not make the system any safer, and it breaks the markAllPresent
-- workflow above. Whether attendance_manage itself should grant that much
-- power is a separate, pre-existing question — deliberately out of this
-- feature's scope, and already flagged for the owner in the v1 note above.
-- CORRECTION (v9): v7's rendering of that boundary as `rank in
-- ('supervisor','manager')` was copied from the stale schema.sql text and so
-- was still narrower than the policy. v9 replaces it — see below.
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
-- the attendance_manage-matching authority test (a caller attendance_manage
-- lets through already has unrestricted write over everyone's attendance, so
-- guarding their own row adds no safety and would silently abort
-- markAllPresent's bulk upsert — see the v7 note above, and the v9 note for
-- the correction to how that test was WRITTEN); and the separate, narrower
-- excuse_lateness()-matching test for the late_excused* columns, still
-- enforced for EVERY caller including managers, because that is what keeps
-- the set of people who can excuse a given person's lateness pinned to
-- excuse_lateness()'s own definition. [Reworded in v9: an earlier draft said
-- this is "what makes excuse_lateness() the only route to an excuse". It is
-- not — it gates WHO, not HOW. See the v9 note.]
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
--
-- ─────────────────────────────────────────────────────────────────────────
-- v9. READ THIS BEFORE QUOTING ANY POLICY IN THIS FILE.
--
--   THE MISTAKE THIS VERSION EXISTS TO UNDO. v6, v7 and v8 were all written
--   against `supabase/schema.sql`, and schema.sql IS STALE FOR RLS POLICIES.
--   Later migrations `drop policy` and recreate policies that still stand in
--   their ORIGINAL form in schema.sql, which was never updated. The guard
--   below mirrored attendance_manage as schema.sql:505-506 shows it —
--   `current_rank() in ('supervisor','manager')` — and said so in three
--   separate comments. That text was superseded on 2026-07-08. The live
--   policy is migration-2026-07-08-rls-system-role.sql:37-39:
--     create policy "attendance_manage" on attendance for all to authenticated
--       using ((current_rank() in ('supervisor','manager')
--               or current_system_role() in ('hr','supervisor','manager','admin','owner')));
--
--   THE RULE FOR ANYONE EDITING THIS FILE NEXT. Before relying on any policy,
--   run
--     grep -n "<policy_name>" supabase/schema.sql supabase/migration-*.sql
--   and take the LAST definition, not the one in schema.sql. Do it for every
--   policy you cite, every time. PROJECT_NOTES.md section 4 carries the same
--   warning. Three review rounds were spent on the shape of this guard; two
--   of them were lost to this one assumption.
--
--   (C1) THE EXEMPTION UNDER-PERMITTED, AND FAILED SILENTLY. Because the
--   broad test read `rank in ('supervisor','manager')` only, an account with
--   system_role in ('hr','supervisor','manager','admin','owner') whose RANK
--   is trainee/junior/senior failed it. That combination is not hypothetical:
--   it is the exact class migration-2026-07-08-rls-system-role.sql was
--   written to serve — see its header, "every manager button while the DB
--   silently filtered writes to 0 rows". Such an account passes RLS on EVERY
--   row of attendance (attendance_manage's second disjunct) and was then
--   refused by this trigger on ONE row: their own.
--
--   And that one row is always in the blast radius. DailyRoster.markAllPresent
--   (src/features/hr/HrAttendance.tsx) upserts every visible row in a SINGLE
--   statement, and visibleStaff is filtered only by branch/department — it
--   never excludes the acting user. A trigger exception on any row aborts the
--   whole statement, and that call site destructures nothing from the result
--   (`await supabase.from('attendance').upsert(rows, ...)`, no error check),
--   so the entire team's mark-all-present failed with no error shown, every
--   single day, for exactly the accounts the RBAC migration exists for.
--
--   Fixed by expressing the broad test as a call to the SAME two functions
--   attendance_manage's USING clause itself calls — current_rank() and
--   current_system_role() — rather than as a hand-rolled `select ... from
--   staff` that has now drifted twice. The trigger's expression is character-
--   for-character the policy's expression; it cannot drift again without the
--   policy being edited.
--
--   TWO CLAIMS FROM v7/v8 THAT WERE FALSE AND ARE NOW CORRECTED IN PLACE:
--     * "does RLS already let this caller write ANY row on this table
--       unconditionally — and that answer is attendance_manage's RANK test,
--       no narrower." It is not the rank test. It is the rank test OR the
--       system_role test.
--     * the inference that an account failing the trigger's broad test is one
--       RLS "already refuses every other row on the table". It does not. An
--       hr/admin/owner/manager/supervisor system_role with a junior rank has
--       FULL TABLE WRITE through attendance_manage and was refused by nothing
--       except this trigger, on its own row alone — which is precisely why
--       the failure was invisible rather than merely restrictive.
--
--   (C2) THE GUARD HAD NO INSERT ARM. attendance_self_clock (schema.sql:507-
--   508 — grepped; no later migration replaces it) is
--     create policy "attendance_self_clock" on attendance for insert to
--       authenticated with check (staff_id = auth.uid());
--   column-blind, with no constraint on date, status, late_excused, notes,
--   marked_by or recorded_by, and the trigger was `before update` only. So a
--   staff member could INSERT a finished row for any date that had none yet:
--     insert into attendance (staff_id, date, status, clock_in, late_minutes)
--     values (auth.uid(), '<tomorrow>', 'present', '<tomorrow 09:00>', 0);
--   Nothing ever corrected it. canClockIn is `!today?.clock_in`, so the next
--   day the app writes no clock-in at all; mark_absent_for_missed_shifts()
--   (migration-2026-07-09-auto-absent.sql) is `on conflict (staff_id, date)
--   do nothing`, so it skips the day; and the roster then reads "present".
--   Cheaper than every path the v8 whitelist closed, and it went round it
--   entirely. Closed by attendance_guard_self_insert() below — the same
--   whitelist idiom, on a `before insert` trigger.
--
--   (I1) THE CLOCK-IN CARVE-OUT STILL ERASED A HAND-MARKED LATE DAY. The
--   carve-out was one-way from the ROW'S CURRENT STATE, not one-way per day.
--   DailyRoster.setStatus(id, 'late', mins) writes status/late_minutes and
--   never touches clock_in, so a row legitimately sits at status = 'late'
--   with clock_in IS NULL — the real-world case of someone marked late
--   BECAUSE they never clocked in. Its owner then runs one statement setting
--   clock_in, status = 'present', late_minutes = 0: the transition
--   `old.clock_in is null and new.clock_in is not null` is genuine, every
--   column touched is inside the carve-out's set, and the manager's mark is
--   erased. Fixed by also requiring `old.status is distinct from 'late'`.
--   See the function's own comment for why that test was chosen over the
--   alternative (`old.recorded_by is not null`), which this codebase cannot
--   use.
--
--   (I2) CLOCK-OUT IS NOW ONE-WAY, SYMMETRIC WITH CLOCK-IN. The clock-out
--   group was permanently writable, so
--     update attendance set clock_out = <earlier>, clock_out_distance_m = 0
--   worked on any past row of the owner's, forever, rewriting the time and
--   GPS evidence long after the fact. The app only ever writes those columns
--   on the transition itself: handleClockDone's update is reachable only when
--   canClockOut (`!!today?.clock_in && !today?.clock_out`), which is exactly
--   `old.clock_out is null and new.clock_out is not null`. They are now
--   writable only on that transition.
--
--   (I4) THE SCORE WAS WRITABLE ONE TABLE OVER, so everything above was
--   capped by it. reviews_update_self on monthly_reviews (schema.sql:245-246
--   — grepped; migration-2026-07-08 and migration-2026-07-10 replace
--   reviews_select/reviews_insert/reviews_update_sup but NOT this one) is
--     create policy "reviews_update_self" on monthly_reviews for update
--       using (staff_id = auth.uid());
--   row-scoped and column-blind. late_count lives on that table and
--   attendance_score is `generated always as (greatest(0, 100 - late_count *
--   10))`, so
--     update monthly_reviews set late_count = 0 where staff_id = auth.uid();
--   restored a perfect attendance score without touching `attendance` at all.
--   Closed by monthly_reviews_guard_subject_update() below, in the same
--   whitelist shape. Its guarded/unguarded column lists and the call site
--   justifying each are in the comment above that function.
--
--   (MINOR) ONE RATIONALE CORRECTED. v8 said check 2 is "what makes
--   excuse_lateness() the only route to an excuse". It is not. It gates WHO,
--   not HOW: a caller who passes the narrow test — a manager-tier account, or
--   the target's named supervisor — can still write
--     update attendance set late_excused = true, late_excused_by = <anyone>,
--            late_excused_at = <any time> where id = <row>;
--   directly through attendance_manage and forge exactly the provenance
--   excuse_lateness() would have stamped. What check 2 actually buys is that
--   the SET OF PEOPLE who can excuse a given person's lateness is pinned to
--   excuse_lateness()'s own per-target definition, and cannot be widened by
--   going around the RPC. Making the provenance itself unforgeable would need
--   late_excused_by/late_excused_at pinned to auth.uid()/now() for every
--   caller, which is a deliberate non-goal here: it would break any future
--   back-dated correction by a manager, and no such correction path exists to
--   test against today.
--
--   IDEMPOTENCY. Unchanged in v9 and re-checked statement by statement: every
--   statement this file adds or edits is `create or replace function`, or
--   `drop trigger if exists` immediately followed by `create trigger`. v9
--   adds no column, constraint, index, grant or seed. Re-running the whole
--   file is a no-op on an up-to-date database.
-- ─────────────────────────────────────────────────────────────────────────
-- ─────────────────────────────────────────────────────────────────────────
-- v10. (I1) ITSELF OVER-CORRECTED. STOP ERASING THE VERDICT, NOT THE CLOCK-IN.
--
--   THE BUG. (I1) closed the erasure by refusing the WHOLE clock-in
--   transition outright whenever old.status = 'late':
--     if old.clock_in is null and new.clock_in is not null
--        and old.status = 'late' then
--       raise exception '... Ask a manager to correct the day instead.';
--   canClockIn (src/features/hr/HrAttendance.tsx) is `!today?.clock_in`,
--   which is STILL true on a row a manager marked late by hand — setStatus
--   writes status/late_minutes and never touches clock_in — so the app kept
--   offering the clock-in button on exactly the row this raise refuses. The
--   realistic sequence: someone forgets to clock in, a manager marks them
--   late by hand, they remember and try to clock in — take the selfie, wait
--   for GPS — and hit a raw database error. They cannot clock in AT ALL that
--   day; a manager has to intervene just to unblock the button, on top of
--   whatever correction the day needed anyway. The goal was only ever to stop
--   the verdict being erased, not to stop the clock-in.
--
--   THE FIX. The rule changes from "may they write this column" to "may they
--   make the record LESS SEVERE". The clock-in evidence group (clock_in,
--   clock_in_photo_url, clock_in_lat, clock_in_lng, clock_in_distance_m) and
--   the late reason columns are now unconditionally writable on the genuine
--   clock-in transition (old.clock_in is null and new.clock_in is not null)
--   regardless of old.status — nothing about recording that a clock-in
--   happened erases anything by itself. status/late_minutes are handled
--   separately: if the caller's proposed new.status would erase a verdict
--   already standing on the row, NEW.status/NEW.late_minutes are silently
--   reset back to OLD before the whitelist diff runs, instead of raising — so
--   the clock-in columns above still go through in the same statement. The
--   row ends up clocked in with the ORIGINAL status still standing, waiting
--   for a manager to correct it, instead of not clocked in at all.
--
--   THE MATRIX, WORKED THROUGH AGAINST EVERY STATE THIS TABLE ACTUALLY
--   REACHES WITH clock_in IS NULL (grepped against src/, not assumed —
--   writeClockIn, src/features/hr/HrAttendance.tsx, is the only place that
--   writes status/late_minutes on this transition, and it only ever proposes
--   'present' or 'late', computed from calcLateness against the real
--   clock-in time):
--
--     old.status IS NULL (no row exists yet)
--       Not reachable here — a nonexistent row is an INSERT, handled by
--       attendance_guard_self_insert() below, not this UPDATE trigger. Listed
--       for completeness only. (Also treated as permissive — same as
--       'present' below — if a row somehow has an explicit NULL status; the
--       column defaults to 'present' and nothing in src/ writes NULL.)
--
--     old.status = 'present' (DailyRoster.markAllPresent — every visible row,
--     recorded_by stamped with the manager's id, clock_in left untouched)
--       ALLOWED to become 'present' OR 'late', whichever writeClockIn's own
--       lateness computation produces. 'present' is not a verdict against the
--       staff member — it is the lenient default a bulk mark stamps before
--       anyone has actually clocked in — so nothing is erased by replacing it
--       with the real outcome, even when that outcome is worse ('late').
--       recorded_by being non-null here is exactly why it cannot be used as
--       the "hand-marked" test (see (I1)'s own note above) — this is the one
--       non-null-recorded_by state that must stay freely upgradeable.
--
--     old.status = 'late' (DailyRoster.setStatus — a manager's deliberate
--     hand mark; writes status/late_minutes, never clock_in)
--       ALLOWED only if the transition's proposed new.status is ALSO 'late'
--       — the one value writeClockIn can produce that does not erase the
--       mark. late_minutes moves freely to whatever writeClockIn computes
--       from the real clock-in time (more accurate than the manager's typed
--       number, and late_count/attendance_score are driven by status, not by
--       the minute count — see countLateDays(), src/features/team/
--       Reviews.tsx — so a smaller real number does not soften the day's
--       scoring). If writeClockIn's own computation says the real arrival was
--       on time, new.status = 'present' is REFUSED — status/late_minutes are
--       reset to OLD, and the clock-in evidence is recorded on top of the
--       untouched 'late' verdict. That is the exact erasure (I1) exists to
--       close, and it is now closed without also closing the clock-in button.
--
--     old.status = 'absent' (mark_absent_for_missed_shifts(), migration-2026-
--     07-09-auto-absent.sql — an hourly sweep, marked_by = 'system', for a
--     scheduled shift whose end time has already passed with no attendance
--     row of any kind yet)
--       ALWAYS REFUSED — status/late_minutes reset to OLD ('absent' stands).
--       'absent' is the most severe status this table carries, and
--       writeClockIn can only ever propose 'present' or 'late', both less
--       severe — there is no value it could send that would not be an
--       erasure. This is a SYSTEM mark, not a manager's, but the brief for
--       this fix is explicit that both are protected ("erase something a
--       manager OR THE SYSTEM already recorded"), and the practical reason
--       matches: the resolveAttendanceDate/attDate the self-clock-in UI
--       operates on can still be the SAME calendar day the hourly sweep just
--       marked absent (the sweep fires once the shift's end time passes, not
--       once the calendar day rolls over), so this state is genuinely
--       reachable by a real same-day clock-in attempt, not just by a stale
--       row from a week ago. The staff member still gets clocked in — the
--       evidence group is unconditionally writable — but 'absent' needs a
--       manager's eyes, same as a hand-marked 'late' does.
--
--     old.status = 'on_leave' (leave approval, or Schedule's leave sync;
--     mark_absent_for_missed_shifts() also writes it, belt-and-braces, when
--     an approved leave already covers the missed-shift day)
--       ALWAYS REFUSED, same mechanism. on_leave is not a point on the
--       present/late/absent severity scale at all — it is a sanctioned
--       category HR/the leave workflow already approved for this day — and
--       letting a bare clock-in silently convert it to 'present'/'late' would
--       let the client overwrite an HR leave record with no leave-specific
--       authority check at all. Left for a manager to resolve, same as above.
--
--     old.status = 'half_day' / 'public_holiday' (reachable only via a
--     manager's own setStatus/direct write — 'public_holiday' is not even in
--     DailyRoster's STATUS_OPTIONS, but the CHECK constraint allows it, and
--     nothing stops a future UI path from setting either) and any future
--     status value this enum ever grows
--       Generalises the same way, without needing its own line: the code
--       below accepts a proposed new.status only when it exactly reaffirms
--       old.status, OR when old.status is the 'present' baseline (or an
--       unreached NULL, coalesced to 'present') and new.status is 'present'
--       or 'late' — the only two values writeClockIn ever sends. 'present'
--       is never treated as licence to accept an ARBITRARY new.status, only
--       those two. Every other combination is refused and reset to OLD, so a
--       new status value this enum grows in future is protected the day it
--       starts being written, with nothing here to update.
--
--   WHY A SILENT RESET, NOT A FRIENDLIER RAISE. A BEFORE UPDATE trigger
--   returns exactly one NEW row — it cannot accept the clock-in columns and
--   reject status/late_minutes from the same incoming row by raising, since a
--   raise aborts the whole statement, columns and all. Resetting NEW back to
--   OLD for just those two columns, then letting the (now-consistent) rest of
--   the row through the whitelist, is the only way to get both outcomes from
--   one UPDATE. This file stays inside supabase/, so no user-facing message
--   can be added here to explain the silent clamp to the person clocking in;
--   that is a UI-layer follow-up, out of scope for a supabase/-only fix, and
--   today nothing in DailyRoster/HrAttendance surfaces a status mismatch
--   after a successful clock-in write.
--
--   WHAT DIDN'T CHANGE. v_clock_in_transition itself is simpler now — just
--   `old.clock_in is null and new.clock_in is not null`, with no old.status
--   condition folded in, because the transition is never refused any more,
--   only the two columns inside it are conditionally reset. Check 1 (append-
--   only late reason), check 2 (the excuse columns, narrow test) and the
--   clock-OUT group (I2) are untouched. v_attendance_manage_authority is
--   unchanged and still gates the whole block — a caller attendance_manage
--   authorises never reaches any of this, exactly as before.
--
--   ALSO IN v10, NOT ABOUT THIS FUNCTION: migration-2026-07-09-auto-absent.sql
--   had the identical stale-boundary bug — mark_absent_for_missed_shifts()
--   guarded itself with `rank in ('supervisor','manager')` alone — fixed
--   there in that file's own v2 to the same broad test used here. Fixing it
--   there left a stale quote of the OLD guard sitting in THIS file, in
--   attendance_guard_self_insert()'s NOT AFFECTED note below (it used to cite
--   "`rank in ('supervisor','manager')`" as that RPC's guard) — corrected in
--   place in the same pass, specifically so this file does not become the
--   next place a future edit copies a superseded boundary from.
--
--   IDEMPOTENCY. v10 edits only attendance_guard_late_update() via `create or
--   replace function`, plus the comment correction just above (no executable
--   change) — no column, constraint, index, grant, trigger definition or seed
--   changes. This file has never been executed against any database (every
--   version from v1 has been amended in place before first deployment — see
--   the v2 note near the top of this changelog). Re-running the whole file
--   remains a no-op on an up-to-date database.
-- ─────────────────────────────────────────────────────────────────────────
-- ─────────────────────────────────────────────────────────────────────────
-- v11. A SUBJECT COULD DENY THEIR OWN REVIEW AND FREEZE THE SCORE AT 100.
-- PLUS TWO MINOR FIXES AND FOUR STALE-OR-OVERSTATED CLAIMS, CORRECTED IN PLACE.
--
--   (C1) THE BUG. monthly_reviews_guard_subject_update()'s whitelist
--   (v_writable_keys, added in v9 for finding I4) includes `status` with no
--   constraint on what it may become — SelfEvalForm.submit needs to move it
--   from 'pending' to 'self_done', so it had to be writable, but nothing
--   stopped it moving anywhere else. The comment above that function dismissed
--   this ("it does not move a score") on the grounds that calcFinalScore
--   (src/shared/types/index.ts) returns null unless all four sup_* ratings are
--   present, and those, along with late_count, are guarded by that same
--   whitelist. That reasoning checks calcFinalScore, not attendance_score —
--   the column this table actually generates:
--     attendance_score int generated always as (greatest(0, 100 - late_count * 10))
--   late_count defaults to 0, and this trigger's whitelist never constrained
--   `status` becoming 'completed' outright. Grepped against every caller of
--   the two supervisor-side review forms, not assumed:
--     src/features/team/Reviews.tsx:610 —
--       reviews.filter(r => r.status === 'self_done' && canReviewStaff(...))
--       is the ONLY feed for SupervisorReviewCard.
--     src/features/staff/StaffProfile.tsx:476 —
--       if (review.status === 'self_done' && isSupervisor)
--       is the ONLY feed for SupervisorReviewForm.
--   Both are gated on status = 'self_done' and nothing else. So
--     update monthly_reviews set status = 'completed' where id = <own row>
--       and staff_id = auth.uid();
--   run by the review's own subject removes the row from both entry points
--   permanently — late_count is never written by anyone else, attendance_score
--   generates a perfect 100 from the untouched default, and StaffProfile even
--   reports "All reviews completed for this month!". The same lever also
--   reverts a completed review back to 'pending' and reopens self-evaluation
--   after a supervisor already scored it — nothing constrained the REVERSE
--   direction either.
--
--   THE FIX. Constrain the transition instead of leaving `status` open.
--   old.status = 'pending' -> new.status = 'self_done' is the one and only
--   self-initiated status change this table's real callers ever perform —
--   SelfEvalForm.submit itself is reachable only when review.status ===
--   'pending' (StaffProfile.tsx:460). A same-value write (new.status not
--   distinct from old.status) is also let through, so an idempotent retry of
--   an already-applied self-evaluation does not raise. Every other
--   self-initiated change to `status` — completed, reverted, jumped straight
--   to self_done from anywhere but pending, or anything this enum grows in
--   future — is refused. The check runs in
--   monthly_reviews_guard_subject_update() before the general whitelist diff,
--   using the same errcode as the rest of this file's guards.
--
--   THE PARAGRAPH THAT REASONED THIS AWAY IS REWRITTEN IN PLACE, not merely
--   annotated, because the old text was wrong about which score `status`
--   reaches and would mislead the next reader who trusted it. See the comment
--   above monthly_reviews_guard_subject_update() below for the corrected text.
--
--   (M1) NULL SLIPPED THROUGH THE ERASURE CLAMP IN attendance_guard_late_
--   update(). v_status_write_erases_verdict's test — `new.status in
--   ('present', 'late')` — is NULL, not false, when new.status is NULL, so
--   `not (... and NULL)` is NULL, and plpgsql's IF treats NULL as not-true —
--   so the clamp would silently NOT fire for a NULL new.status on a clock-in
--   transition from the 'present' baseline, contradicting this function's own
--   comment ("Every other combination is refused and reset to OLD").
--   writeClockIn (the only caller of this transition) never sends a NULL
--   status, so this was not reachable in practice — but the comment should be
--   true regardless of what today's one caller happens to send. Fixed with an
--   explicit `new.status is not null` test folded into the same expression.
--
--   (M2) THE INSERT-ARM DEFAULTS MAP IS AN ENUMERATIVE LIST INSIDE A
--   DELIBERATELY SUBTRACTIVE DESIGN. attendance_guard_self_insert()'s
--   v_defaults names break_late, break_overrun_minutes and late_excused by
--   hand — the three non-whitelisted columns whose DEFAULT is a non-null
--   literal at the time this was written. That is a deliberate, bounded
--   exception to the "guarded automatically" design the rest of that function
--   documents: a nullable column added later is guarded with nothing to
--   update, but a NON-NULL-default column is not, and needs v_defaults updated
--   by hand or every self clock-in starts raising. Nothing connected that fact
--   to the one place a future column actually gets added — the `alter table
--   attendance add column` block near the top of this file. A `-- KEEP IN
--   SYNC WITH v_defaults` marker is added there now, naming the function, so
--   the two are found together.
--
--   FOUR STALE OR OVERSTATED CLAIMS, CORRECTED IN PLACE:
--     * the v4 note's quote of staff_update, cited to schema.sql — STALE, and
--       this branch's fourth citation error of this exact kind. Corrected with
--       the LIVE text from migration-2026-07-08-rls-system-role.sql:232-233.
--       No functional consequence: staff_guard_supervisor_update()'s own
--       authority test is independent of this quote and was already correct.
--     * the "clock_in must be set" bullet under attendance_guard_self_insert's
--       THE RULE, which read as though requiring clock_in stops pre-emption of
--       the auto-absent job. It stops the BARE status row variant only — a
--       fabricated clock_in for today, or any of the last 7 days, still
--       inserts, still pre-empts mark_absent_for_missed_shifts()'s `on
--       conflict do nothing`, and nothing here authenticates clock_in against
--       a real clocking event. The worked example immediately above it, which
--       used a future date, is annotated so it no longer reads as though the
--       date-window fix alone closed the case.
--     * the C1 paragraph above monthly_reviews_guard_subject_update() — see
--       (C1) above; rewritten in place.
--     * the "Every other combination is refused and reset to OLD" claim in
--       attendance_guard_late_update()'s own comment — see (M1) above; the
--       comment text is unchanged (it is now true) and the CODE was fixed to
--       match it, rather than the reverse.
--
--   IDEMPOTENCY. v11 edits monthly_reviews_guard_subject_update() and
--   attendance_guard_late_update() via `create or replace function` only, and
--   adds one comment line above the `alter table attendance add column`
--   block. No column, constraint, index, grant, trigger definition or seed
--   changes, and no new statement of any kind that could behave differently
--   on a second run. This file has still never been executed against any
--   database (every version from v1 has been amended in place before first
--   deployment — see the v2 note near the top of this changelog). Re-running
--   the whole file remains a no-op on an up-to-date database.
-- ─────────────────────────────────────────────────────────────────────────
-- ─────────────────────────────────────────────────────────────────────────
-- v12. CLOSES A PRE-EXISTING, APP-WIDE PRIVILEGE-ESCALATION HOLE. This is NOT
-- a bug this feature introduced — it predates this branch entirely — but it
-- is fixed here because every authority check this branch has added is void
-- without it: the broad manager-tier test the attendance guards use, the
-- monthly_reviews subject guard's exemption, excuse_lateness() itself, and
-- staff_guard_supervisor_update() above ALL authorise their caller by reading
-- staff.rank / staff.system_role off that caller's own row. staff_update's
-- live RLS policy is row-scoped, not column-scoped
-- (migration-2026-07-08-rls-system-role.sql:232-233 — grepped, not assumed;
-- see the v9 rule above about citing this file's policies):
--   create policy "staff_update" on staff for update
--     using (id = auth.uid() or (current_rank() in ('supervisor','manager')
--             or current_system_role() in ('hr','supervisor','manager',
--             'admin','owner')));
-- `id = auth.uid()` alone satisfies that USING clause regardless of which
-- columns the UPDATE touches, so any authenticated staff member can run
--   update staff set system_role = 'admin' where id = auth.uid();
-- and, from that moment on, pass every one of the authority tests listed
-- above. Nothing on `staff` has ever guarded rank or system_role the way
-- staff_guard_supervisor_update guards supervisor_id — until now.
--
-- THE FIX: a new trigger, staff_guard_authority_update() (below, right after
-- staff_guard_supervisor_update), in the same shape — a caller who is not
-- manager-tier may not change rank, system_role, or status on their OWN row.
-- Someone else's row is untouched (already gated by staff_update's RLS at
-- manager-tier); a manager-tier caller changing their OWN row is untouched
-- (they already hold that authority); auth.uid() is null (migrations / SQL
-- editor) is allowed through unconditionally, for the same reason
-- staff_guard_supervisor_update's null branch is safe: staff has no anonymous
-- access path, so RLS already fails closed before this trigger would see such
-- an UPDATE from anon. Full reasoning, the STATUS inclusion (and why
-- is_active is deliberately NOT guarded), and the bootstrap analysis are in
-- the comment directly above the function.
--
-- IDEMPOTENCY. v12 adds one function (`create or replace function`) and one
-- trigger via this file's existing drop-if-exists-then-create idiom
-- (staff_guard_supervisor_update_trg's own pattern, immediately above). No
-- other statement changes. Re-running the whole file remains a no-op on an
-- up-to-date database — this file has still never been executed against any
-- database (see the v2 note near the top of this changelog).
-- ─────────────────────────────────────────────────────────────────────────
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

-- ── staff_guard_authority_update (v12) ──────────────────────────────────────
-- Closes a PRE-EXISTING, APP-WIDE privilege-escalation hole — not something
-- this branch introduced. See the v12 changelog entry above for the full
-- picture; summary: staff_update's live RLS policy (migration-2026-07-08-rls-
-- system-role.sql:232-233, quoted above and in the changelog) is row-scoped
-- only —
--   using (id = auth.uid() or (current_rank() in ('supervisor','manager')
--           or current_system_role() in ('hr','supervisor','manager','admin',
--           'owner')))
-- — so `id = auth.uid()` alone lets any authenticated staff member run
--   update staff set system_role = 'admin' where id = auth.uid();
-- and pass every authority test this branch relies on from that point on
-- (they all read staff.rank / staff.system_role off the caller's own row).
-- staff_guard_supervisor_update above already guards supervisor_id on this
-- same table for the same class of reason; this trigger is its sibling for
-- rank, system_role, and status.
--
-- THE RULE: a caller who is not manager-tier may not change rank,
-- system_role, or status on their OWN row.
--   * Someone else's row (old.id <> auth.uid()) is untouched by this trigger.
--     An owner or admin editing ANOTHER person's role in Settings' System
--     Roles tab (src/features/settings/Settings.tsx, assignRole/814 — gated
--     `isOwner` client-side, and by staff_update's RLS server-side) is
--     changing a row that is not their own: the self-rule below never fires,
--     and that write stays governed by staff_update's RLS exactly as before.
--   * A manager-tier caller changing their OWN rank/system_role/status is
--     allowed — they already hold that authority. Concretely,
--     Settings.tsx's SystemRolesTab lists every active staff member,
--     including the signed-in owner, in the same assignRole() picker with no
--     self-exclusion, so an owner reassigning their OWN system_role through
--     that exact UI must keep working, and does: old.system_role = 'owner'
--     satisfies the check below before the change is even evaluated.
--     (StaffProfile.tsx's rank editor is narrower than this trigger requires
--     — its payload only ever includes `rank` `if (isManager && !isSelf)`,
--     src/features/staff/StaffProfile.tsx:1224 — so today's app never
--     exercises a manager's own-row rank change; this trigger permits it
--     anyway, matching the RULE stated above rather than today's UI's
--     narrower habits.)
--   * auth.uid() is null in the migration/SQL-editor context — including this
--     file's own future re-runs, and the one-off `update staff set
--     system_role = ...` backfills in migration-2026-07-06-rbac.sql:78-87 —
--     and is allowed through unconditionally, same reasoning as
--     staff_guard_supervisor_update above: staff has no anonymous access
--     path, so RLS already fails closed before this trigger would ever see
--     such an UPDATE from anon.
--
-- The authority check is the exact manager-tier test staff_guard_supervisor_
-- update and excuse_lateness() already use ("system_role in ('manager',
-- 'admin','owner') or rank = 'manager'") — deliberately, not reinvented — so
-- the set of people who can promote/demote/reinstate a staff member and the
-- set excuse_lateness() lets act as a supervisor cannot silently drift apart.
-- Because the rule only ever fires on the caller's own row (old.id =
-- auth.uid()), OLD already IS the caller's row at the moment of the UPDATE,
-- so the caller's current rank/system_role can be read straight off OLD
-- instead of re-querying staff for `me` the way staff_guard_supervisor_update
-- has to (that trigger's authority check applies to every row, not just the
-- caller's own, so it cannot assume OLD is the caller).
--
-- STATUS is guarded alongside rank/system_role because it is evidence-backed
-- as just as authority-bearing: `status = 'resigned'` is the ONLY thing that
-- blocks a resigned staff member from using the app —
--   src/App.tsx:80 — if (user && staff?.status === 'resigned') return
--   <DeactivatedScreen />
-- — and that is a client-side check only, evaluated AFTER Supabase Auth has
-- already issued the session; nothing revokes the underlying auth.users
-- account or its ability to call the database directly. Before this trigger,
-- nothing stopped a resigned staff member from running
--   update staff set status = 'active' where id = auth.uid();
-- to reactivate themselves — the same class of hole as the system_role
-- example above, just aimed at a different column.
--
-- is_active was also considered and is DELIBERATELY NOT guarded here: it is
-- set false on probation elimination (src/features/reviews/
-- ProbationReview.tsx:505) but gates no login, route, or RLS check anywhere
-- in this codebase — App.tsx checks only `status`, never `is_active`. Grepped
-- across schema.sql and every migration, its only readers are eligibility
-- filters inside automated jobs and notification routing: leave accrual
-- (migration-2026-07-08-leave-accrual.sql:109 / migration-2026-07-08-rls-
-- system-role.sql:276, `status = 'active' and is_active`), auto-absent
-- marking (migration-2026-07-09-auto-absent.sql:106, "skip eliminated
-- probation hires"), and notify_late()'s reviewer/PIC fallback
-- (migration-2026-09-02-notify-late-fn.sql:521/534). None of those is an
-- access-control gate, so treating is_active as authority-bearing here would
-- be guessing at a meaning the code does not give it, not enforcing one that
-- exists. If a future change makes is_active gate access the way `status`
-- does today, it should be added to this trigger's column list at that time.
--
-- BOOTSTRAP: this trigger does NOT stop a manager-tier caller — including the
-- last owner — from demoting themselves below manager-tier in one statement.
-- The check reads OLD (the caller's rank/system_role going INTO the change),
-- so a self-demotion from owner to staff still passes it. If that happens,
-- nobody remains who can pass this trigger's manager-tier check through the
-- app, and the only way back is the auth.uid() is null branch above: an
-- operator running `update staff set system_role = 'owner' where id =
-- '<id>';` directly against the database (migration file or SQL editor),
-- bypassing auth.uid() entirely. That IS the intended escape hatch — the same
-- one staff_guard_supervisor_update already relies on for its own recovery —
-- not a gap this trigger introduces: the pre-existing staff_update RLS policy
-- has always allowed a manager-tier self-demotion with no recovery path of
-- its own either, so this trigger leaves that pre-existing exposure exactly
-- as reachable as before, neither wider nor narrower.
create or replace function staff_guard_authority_update()
returns trigger
language plpgsql
as $$
begin
  if new.rank is not distinct from old.rank
     and new.system_role is not distinct from old.system_role
     and new.status is not distinct from old.status then
    return new;
  end if;

  if auth.uid() is null then
    return new;
  end if;

  if old.id <> auth.uid() then
    return new;
  end if;

  if not (old.system_role in ('manager','admin','owner') or old.rank = 'manager') then
    raise exception 'Only a manager can change your own rank, system role, or status.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists staff_guard_authority_update_trg on staff;
create trigger staff_guard_authority_update_trg
  before update on staff
  for each row execute function staff_guard_authority_update();

-- KEEP IN SYNC WITH v_defaults IN attendance_guard_self_insert() (below, v11
-- M2): that function's INSERT whitelist treats every non-whitelisted column
-- as required to be at its column default, and can only tell "default" from
-- "value" for a NULL-default column by checking for NULL. A column added here
-- (or to `attendance` by any future migration) with a non-null DEFAULT must
-- be added to v_defaults too, or every self clock-in starts raising the day
-- that column exists — a nullable column needs no such update.
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
-- A WHITELIST over a row-wide UPDATE policy (v8), with v9's corrections to
-- the authority test and to two of the three exits, and v10's correction to
-- HOW the clock-in exit protects a standing verdict. v5-v7 grew this as a
-- BLACKLIST — it named the columns it protected and left everything else to
-- attendance_self_update — and a blacklist cannot work here. See the v8 note
-- in this file's header changelog for the two paths that defeated it (moving
-- `date` out of the review month; nulling `clock_in` to manufacture the
-- clock-in carve-out) and for why the shape, not the coverage, was the bug.
-- See the v9 note for the three things v8 still got wrong: a broad test
-- copied from a STALE policy quote, a clock-in carve-out that erased a
-- hand-marked late day, and a clock-out group that was writable forever. See
-- the v10 note for why v9's own fix for the carve-out over-corrected — it
-- blocked the clock-in itself, not just the erasure — and the full matrix of
-- what a self clock-in may and may not do to status/late_minutes now.
--
-- WHY A TRIGGER AT ALL. RLS on `attendance` is row-scoped, never
-- column-scoped. attendance_self_update (schema.sql:509-510 — grepped
-- against every migration; nothing replaces it) is
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
--     break_start, break_end, break_minutes, break_late,
--     break_overrun_minutes                             (the break group)
--
--   AND, ONLY on the genuine clock-IN transition — old.clock_in is null and
--   new.clock_in is not null, which can only be reached once because
--   `clock_in` is itself outside the whitelist and so cannot be nulled back:
--     clock_in, clock_in_photo_url, clock_in_lat, clock_in_lng,
--     clock_in_distance_m                               (the clock-in group)
--     status, late_minutes, late_reason_code, late_reason
--   The clock-in group and the reason columns are writable UNCONDITIONALLY on
--   this transition, for any old.status — recording that a clock-in happened
--   never erases anything by itself. status/late_minutes are narrower: NEW is
--   silently reset back to OLD for those two columns specifically, before
--   this whitelist check runs, whenever the caller's proposed new.status
--   would make the record LESS severe than what a manager or the system
--   already recorded — see (v10, I1) below for the full matrix. That reset
--   happens earlier in the function, so by the time this whitelist runs,
--   status/late_minutes always hold a value it is willing to accept; nothing
--   about the check below changed to make this true.
--
--   AND, ONLY on the genuine clock-OUT transition — old.clock_out is null
--   and new.clock_out is not null, one-way for the same reason:
--     clock_out, clock_out_photo_url, clock_out_lat, clock_out_lng,
--     clock_out_distance_m                              (the clock-out group)
--
-- Anything else that differs raises. The diff is taken with
-- to_jsonb(new)/to_jsonb(old) minus the writable keys — the same idiom
-- notifications_guard_recipient_update() uses above, deliberately, so the two
-- guards on this migration read the same way.
--
-- WHY THE CLOCK-IN TRANSITION ALSO GUARDS old.status (v9, finding I1; fix
-- reworked in v10 — see the v10 header note for why and how). DailyRoster.
-- setStatus(id, 'late', mins) (src/features/hr/HrAttendance.tsx) writes
-- status and late_minutes and never writes clock_in, so a row legitimately
-- sits at status = 'late' with clock_in IS NULL — the ordinary case of
-- someone marked late BECAUSE they never clocked in. Its owner could then run
-- ONE statement setting clock_in, status = 'present', late_minutes = 0: the
-- clock-in transition is genuine, and without a guard the manager's mark
-- would be erased by a single legitimate-looking clock-in. [v9 closed this by
-- REFUSING the whole transition outright whenever old.status = 'late' — which
-- over-corrected: canClockIn is still `!today?.clock_in` on that exact row,
-- so the app kept offering the clock-in button on a row the trigger then
-- raised on, leaving the staff member unable to clock in at all that day.
-- SUPERSEDED by v10, which resets status/late_minutes back to OLD instead of
-- refusing the transition, so the clock-in itself always succeeds.]
--
--   WHY old.status AND NOT old.recorded_by. The other candidate fix —
--   refusing the transition when old.recorded_by is not null, i.e. on any
--   hand-marked row — cannot be used in THIS codebase. Both manager bulk
--   paths stamp it: markAllPresent maps `recorded_by: managerId ?? null` onto
--   every visible row, and setStatus does the same. So a row created by
--   markAllPresent carries a non-null recorded_by, and gating on it would
--   refuse the ordinary next-morning clock-in onto exactly the rows the
--   roster creates every day. old.status has no such collision: markAllPresent
--   writes 'present', mark_absent_for_missed_shifts() writes 'absent' or
--   'on_leave', HrLeave.approve() and Schedule's leave assignment write
--   'on_leave' — none of them 'late'. Only a deliberate hand-mark of LATENESS
--   produces old.status = 'late', and that is the one mark a clock-in must
--   not be able to clear.
--
--   The consequence, stated plainly because it is a behaviour change: once a
--   manager has marked you late for a day you never clocked into, clocking in
--   no longer clears that mark — the row ends up clocked in (evidence and
--   all) but still shows 'late', and a manager has to correct it if that's
--   wrong. [v9 said instead that you could "no longer clock in on that row
--   yourself" — that was the bug v10 fixes; you can always clock in, only the
--   status write is constrained.] That status staying put is the intended
--   trade — the alternative is that the mark is self-erasable by design.
--
-- WHY THE CLOCK-OUT GROUP IS NO LONGER "ALWAYS" (v9, finding I2). It used to
-- be permanently writable, so
--   update attendance set clock_out = <earlier>, clock_out_distance_m = 0
--     where id = <own row>;
-- rewrote the time and GPS evidence on ANY past row of the owner's, forever —
-- the exact asymmetry the clock-in group did not have. Confirmed against the
-- real code before narrowing it: `clock_out`, `clock_out_photo_url`,
-- `clock_out_lat`, `clock_out_lng` and `clock_out_distance_m` are written in
-- exactly one place in src/, handleClockDone's `else` branch (src/features/hr/
-- HrAttendance.tsx), reachable only behind canClockOut = `!!today?.clock_in &&
-- !today?.clock_out` — i.e. precisely `old.clock_out is null and
-- new.clock_out is not null`. DailyRoster.setStatus and markAllPresent do not
-- write them; HrLeave.approve() and Schedule's leave sync write only
-- staff_id/date/status/recorded_by; the break flow writes the separate
-- attendance_breaks table. So making them transition-only takes nothing away
-- from any real path.
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
--      EVERY caller, managers included.
--
--      WHAT THIS CHECK ACTUALLY BUYS, STATED CORRECTLY (v9). Up to v8 this
--      comment said check 2 is "what makes excuse_lateness() the only route
--      to an excuse". That was wrong, and worth correcting rather than
--      quietly deleting, because the wrong version overstates the guarantee.
--      This check gates WHO, not HOW. A caller who passes it — a manager-tier
--      account, or the target's named supervisor — can still write
--        update attendance set late_excused = true,
--               late_excused_by = <someone else>, late_excused_at = <any time>
--          where id = <row>;
--      straight through attendance_manage and forge exactly the provenance
--      excuse_lateness() would have stamped. The direct UPDATE is NOT closed
--      by this check and never was. What IS closed is the set of people:
--      whoever can excuse a given person's lateness is pinned to
--      excuse_lateness()'s own per-target definition and cannot be widened by
--      going around the RPC — which is why this check must not be folded into
--      the whitelist, where the broad test would widen it. Making the
--      provenance itself unforgeable would mean pinning late_excused_by and
--      late_excused_at to auth.uid()/now() for every caller; that is a
--      deliberate non-goal here, because it would foreclose any back-dated
--      correction by a manager and no such path exists to test against today.
--
--      auth.uid() reads the request.jwt.claims session GUC, and SECURITY
--      DEFINER changes only the executing role, not session GUCs, so
--      excuse_lateness()'s own UPDATE reaches this check and passes it exactly
--      when that function's own guard already passed.
--
--   3. The whitelist, gated on v_attendance_manage_authority — the BROAD
--      test, which must be attendance_manage's own USING clause and nothing
--      narrower.
--
--      THE LIVE POLICY, GREPPED (v9). schema.sql is STALE for RLS policies.
--      `grep -n "attendance_manage" supabase/schema.sql supabase/migration-*.sql`
--      returns schema.sql:505-506 AND migration-2026-07-08-rls-system-role.sql
--      :37-39; the LAST definition wins, and it is
--        create policy "attendance_manage" on attendance for all to authenticated
--          using ((current_rank() in ('supervisor','manager')
--                  or current_system_role() in ('hr','supervisor','manager','admin','owner')));
--      v7 and v8 mirrored the schema.sql text instead and so recognised rank
--      alone. That under-permitted a whole class of account this app
--      deliberately created — system_role hr/supervisor/manager/admin/owner
--      with a trainee/junior/senior RANK — which passes RLS on every row of
--      this table and was refused by this trigger on one: its own. Because
--      markAllPresent upserts every visible row INCLUDING the acting user's
--      in one statement, and checks no outcome, the whole team's mark-all-
--      present failed silently every day for those accounts. See the v9 note
--      in the header.
--
--      The test below therefore CALLS current_rank() and current_system_role()
--      — the same two functions the policy's own USING clause calls — instead
--      of hand-rolling `select ... from staff me`, which is what drifted
--      twice. The expression is the policy's expression, character for
--      character, and cannot drift again unless the policy itself is edited.
--      Each half is wrapped in coalesce(..., false) because both functions
--      return NULL for an unknown caller: `null in (...)` is NULL, `not NULL`
--      is NULL, and plpgsql's IF treats NULL as not-true — so without the
--      coalesce an unknown caller would skip the RAISE and the guard would
--      fail OPEN. (The v7/v8 `select exists (...)` form was never NULL, which
--      is why this hazard is new and worth naming.)
--
--      Do NOT merge check 3's test into check 2's or vice versa. They answer
--      different questions. Check 2 asks "would excuse_lateness() let THIS
--      caller excuse THIS staff member" — a per-target question that
--      intentionally excludes a plain rank = 'supervisor' account unless they
--      are named as that person's supervisor_id. Check 3 asks "does RLS
--      already let this caller write ANY row on this table unconditionally" —
--      and the answer to that is attendance_manage's rank test OR its
--      system_role test, no narrower. Using the narrow test in check 3 would
--      re-break the markAllPresent bug v7 fixed and v9 finished fixing; using
--      the broad test in check 2 would widen who can excuse a specific
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
-- future re-runs, any script-driven backfill, migration-2026-09-02-rejudge-
-- boundary-late.sql's notes rewrite) — allowed through unconditionally, same
-- reasoning as staff_guard_supervisor_update above: every attendance RLS
-- policy is `to authenticated`, so a null auth.uid() here cannot be an
-- anonymous PostgREST caller slipping through; it can only be a
-- migration/service-role context, which bypasses RLS (and this trigger's
-- purpose, if not its execution) regardless.
--
-- NOT AFFECTED. mark_absent_for_missed_shifts() (migration-2026-07-09-auto-
-- absent.sql) is `insert into attendance ... on conflict (staff_id, date) do
-- nothing`, and a BEFORE UPDATE trigger never fires for either arm of that —
-- DO NOTHING performs no UPDATE at all. (Its INSERT arm meets the new
-- BEFORE INSERT guard below instead; see that function's own NOT AFFECTED
-- note for why it passes.) The staff member's own break writes go to the
-- separate `attendance_breaks` table, which this trigger is not on; the break
-- group is whitelisted here for the legacy columns of the same name on
-- `attendance` itself (schema.sql:737-741), which nothing in src/ currently
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
  -- BROAD test — check 3. Mirrors attendance_manage's LIVE USING clause
  -- (migration-2026-07-08-rls-system-role.sql:37-39) by calling the same two
  -- functions that clause calls. See the function comment above for why this
  -- one must stay broader than the narrow test, and why it is written as a
  -- call rather than a hand-rolled staff lookup.
  v_attendance_manage_authority boolean;
  -- The one legitimate self-write of the clock-in group, status, late_minutes
  -- and the late reason. Unreachable twice over (v10 note: STILL true — clock_in
  -- is outside the whitelist, so a caller who fails the broad test cannot null
  -- it back to set this up a second time; what changed in v10 is that a row
  -- already hand-marked 'late' is no longer excluded from the TRANSITION
  -- itself, only from writing a status/late_minutes that would erase the
  -- mark — see the clamp just above the whitelist build below).
  v_clock_in_transition         boolean;
  -- v10 (I1, reworked): whether the clock-in transition's proposed
  -- new.status would ERASE a verdict old.status already carries. True only
  -- for a genuine change away from a status that is not the 'present'
  -- baseline, OR a change FROM 'present' to something writeClockIn could
  -- never itself produce ('present'/'late' are the only two values it ever
  -- sends — see the matrix in this file's v10 header note). When true,
  -- status/late_minutes are reset to OLD instead of accepted.
  v_status_write_erases_verdict boolean;
  -- The mirror-image one-way exit for the clock-out group (v9, I2).
  v_clock_out_transition        boolean;
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
    -- attendance_manage's live USING clause, character for character, via the
    -- same two functions it calls. coalesce on each half so an unknown caller
    -- fails CLOSED — see the function comment.
    v_attendance_manage_authority :=
      coalesce(current_rank() in ('supervisor','manager'), false)
      or coalesce(current_system_role() in ('hr','supervisor','manager','admin','owner'), false);

    if not v_attendance_manage_authority then
      -- The genuine clock-in transition. v10: no old.status condition here —
      -- the transition itself is never refused; only status/late_minutes are
      -- conditionally protected, immediately below.
      v_clock_in_transition := old.clock_in is null and new.clock_in is not null;
      v_clock_out_transition := old.clock_out is null and new.clock_out is not null;

      -- v10 (I1, reworked): on a genuine clock-in, status/late_minutes may
      -- only move to a value that does NOT erase a verdict a manager or the
      -- system already recorded. Two shapes are safe:
      --   (a) new.status is not actually changing (old.status reaffirmed —
      --       covers 'late' staying 'late', 'absent' staying 'absent', etc,
      --       with late_minutes still free to move to the real computed
      --       number), or
      --   (b) old.status is the 'present' baseline (markAllPresent's lenient
      --       default, or an unreached NULL — coalesced the same way) AND
      --       new.status is one of the only two values writeClockIn
      --       (src/features/hr/HrAttendance.tsx) can ever actually send,
      --       'present' or 'late'. Deliberately NOT "any new.status" —
      --       'present' carries no verdict to erase, but that is not licence
      --       to accept an arbitrary forged status either.
      -- Anything else silently resets status/late_minutes to OLD here, BEFORE
      -- the whitelist below is built, so the clock-in evidence group and the
      -- reason columns still go through in the same statement — the row ends
      -- up clocked in with the pre-existing verdict left standing for a
      -- manager to correct, never refused outright. See the matrix in this
      -- file's v10 header note for every old.status worked through by name.
      -- (v11, M1) `new.status is not null` is explicit here, not implied.
      -- Without it, `new.status in ('present','late')` is NULL (not false)
      -- whenever new.status is NULL, which makes the whole `not (...)`
      -- expression NULL, and plpgsql's IF treats NULL as not-true — so the
      -- erasure clamp below would silently NOT fire for a NULL new.status on
      -- a clock-in transition from the 'present' baseline, contradicting this
      -- function's own comment ("Every other combination is refused and reset
      -- to OLD"). writeClockIn (the only caller of this transition) never
      -- sends a NULL status, so this was not reachable in practice — but the
      -- comment should be true regardless of what today's one caller happens
      -- to send.
      v_status_write_erases_verdict :=
        v_clock_in_transition
        and new.status is distinct from old.status
        and not (
          coalesce(old.status, 'present') = 'present'
          and new.status is not null
          and new.status in ('present', 'late')
        );

      if v_status_write_erases_verdict then
        new.status       := coalesce(old.status, 'present');
        new.late_minutes := old.late_minutes;
      end if;

      -- Always writable: the legacy break columns only (schema.sql:737-741).
      v_writable_keys := array[
        'break_start', 'break_end', 'break_minutes', 'break_late',
        'break_overrun_minutes'
      ];

      -- Writable only while actually clocking in — unconditionally on
      -- old.status, v10. writeClockIn (src/features/hr/HrAttendance.tsx) sets
      -- exactly these in the same upsert that first sets clock_in, on both
      -- the punctual and the late path. status/late_minutes are included here
      -- unconditionally too: by this point they already equal either
      -- writeClockIn's proposed value (when that didn't erase anything) or
      -- OLD's own value (clamped above when it would have) — either way NEW
      -- now holds something this whitelist is willing to accept, so there is
      -- nothing left for this line to gate.
      if v_clock_in_transition then
        v_writable_keys := v_writable_keys || array[
          'clock_in', 'clock_in_photo_url', 'clock_in_lat', 'clock_in_lng',
          'clock_in_distance_m',
          'status', 'late_minutes', 'late_reason_code', 'late_reason'
        ];
      end if;

      -- Writable only while actually clocking out (v9, I2). handleClockDone's
      -- else branch (src/features/hr/HrAttendance.tsx) sets exactly these,
      -- and only when canClockOut — which is this same transition.
      if v_clock_out_transition then
        v_writable_keys := v_writable_keys || array[
          'clock_out', 'clock_out_photo_url', 'clock_out_lat', 'clock_out_lng',
          'clock_out_distance_m'
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
          'On your own attendance row you may only change the break columns — the clock-in columns, status, late_minutes and the late reason only as part of an actual clock-in, and the clock-out columns only as part of an actual clock-out. Everything else (date, notes, provenance, and the photo/GPS evidence) is fixed once recorded.'
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

-- ── attendance_guard_self_insert ────────────────────────────────────────────
-- The INSERT arm the guard above was missing entirely until v9 (finding C2).
-- Everything above is `before update`, and the UPDATE side was hardened three
-- times over — but the cheapest attack on this table was never an UPDATE.
--
-- THE HOLE. attendance_self_clock is the INSERT policy. Grepped:
--   grep -n "attendance_self_clock" supabase/schema.sql supabase/migration-*.sql
-- returns schema.sql:507-508 and nothing later, so that IS the live text:
--   create policy "attendance_self_clock" on attendance for insert to
--     authenticated with check (staff_id = auth.uid());
-- Column-blind, exactly like the UPDATE policy: no constraint on `date`, on
-- `status`, on `late_excused`, on `notes`, on `marked_by` or `recorded_by`.
-- So a staff member could simply write the finished row for any date that had
-- none yet:
--   insert into attendance (staff_id, date, status, clock_in, late_minutes)
--   values (auth.uid(), '<tomorrow>', 'present', '<tomorrow 09:00>', 0);
-- and nothing ever corrected it. The next day canClockIn (`!today?.clock_in`,
-- src/features/hr/HrAttendance.tsx) is false, so the app writes no clock-in;
-- mark_absent_for_missed_shifts() is `on conflict (staff_id, date) do
-- nothing`, so the auto-absent job skips a day that already has a row; and
-- the roster reads "present". No UPDATE, so no trigger, so no whitelist.
--
-- NOTE (v11): the worked example above uses a FUTURE date only because that
-- was the simplest illustration of "any date that had none yet" pre-fix. Do
-- not read the date-window rule below as having closed this example: swap
-- '<tomorrow>' for today (or any of the last 7 days) and the identical
-- statement — clock_in and all — still inserts and still pre-empts the
-- auto-absent job. See the CORRECTION under "clock_in must be set" below for
-- what the fixes actually do and do not stop.
--
-- THE RULE. Same shape as the UPDATE guard, deliberately, so the two read
-- alike. When auth.uid() is not null, the row being inserted is the caller's
-- own (new.staff_id = auth.uid()) and the caller does NOT satisfy
-- v_attendance_manage_authority, then:
--
--   * `date` must fall in a recent window: not in the future, and not more
--     than 7 days before today in Asia/Kuala_Lumpur. This is the SAME window
--     notify_late() already uses for p_date (migration-2026-09-02-notify-late-
--     fn.sql, finding 12: `p_date > v_today_myt or p_date < v_today_myt -
--     v_max_backdate_days`, v_max_backdate_days = 7), which in turn matches
--     mark_absent_for_missed_shifts()'s own 7-day lookback (migration-2026-07-
--     09-auto-absent.sql). Chosen to match rather than reinvented: the two
--     windows bound the same staff-controlled surface — a self-created
--     attendance row and a notification about one — and they should not be
--     able to disagree. It comfortably covers every real case: same-day
--     clock-in, a night shift whose attendance day is yesterday
--     (resolveAttendanceDate, src/shared/lib/attendance.ts, returns today or
--     yesterday and nothing else), and a Monday clock-in after a weekend.
--
--   * `clock_in` must be set. The only self-insert path in the whole app is
--     writeClockIn, which always sets it. Requiring it stops a staff member
--     creating a BARE status row — 'present' or 'on_leave' with no clock-in at
--     all — purely to pre-empt the auto-absent job on a day they did not work.
--
--     CORRECTION (v11): an earlier draft stopped there, which reads as though
--     requiring clock_in stops pre-emption of the auto-absent job outright. It
--     does not — nothing here (or anywhere in this file) authenticates
--     clock_in against a real clocking event, so
--       insert into attendance (staff_id, date, status, clock_in)
--       values (auth.uid(), '<today, or up to 7 days back>', 'present', now());
--     still inserts: `clock_in` is set, and `date` sits inside the window
--     below. mark_absent_for_missed_shifts()'s `on conflict (staff_id, date)
--     do nothing` still skips that day, exactly as it would for a genuine
--     clock-in, for a shift the staff member may never have worked. What this
--     rule actually closes is narrower than "pre-emption": a status row with
--     NO clock-in evidence whatsoever (this bullet), and — separately, via the
--     date-window rule above — one dated outside the last 7 days. Closing the
--     fabricated-clock_in variant would mean authenticating clock_in itself
--     (GPS/photo verification against a real event); that is out of scope for
--     a column-whitelist trigger and is not attempted here.
--
--   * only these columns may carry a value at all:
--       staff_id, date
--       clock_in, clock_in_photo_url, clock_in_lat, clock_in_lng,
--       clock_in_distance_m                              (the clock-in group)
--       status, late_minutes
--       late_reason_code, late_reason                    (the reason columns)
--     Everything else must still be at its column default. In particular
--     late_excused is NOT writable on insert and is rejected if set to
--     anything but its `false` default — the whole late_excused* group stays
--     reachable only through excuse_lateness() and check 2 of the UPDATE
--     guard. So are notes, marked_by, recorded_by, scheduled_shift_id and the
--     entire clock-out group.
--
-- HOW "AT ITS DEFAULT" IS CHECKED WITHOUT NAMING THE COLUMNS. There is no OLD
-- row to diff against on INSERT, so the whitelist is applied to NEW alone:
-- strip the writable keys, strip the two server-assigned keys, and require
-- everything that remains to be JSON null — except the handful of columns
-- whose declared DEFAULT is a non-null literal, which are compared against
-- that literal instead. Only three such columns exist outside the whitelist
-- (break_late false, break_overrun_minutes 0, late_excused false), and they
-- are listed in v_defaults. A column added to this table LATER is therefore
-- guarded the day it is added, exactly like the UPDATE whitelist: if it is
-- nullable it must be null, and if it carries a non-null default it will not
-- match v_defaults and every self-insert will raise LOUDLY until someone
-- decides which side of the whitelist it belongs on. That failure direction
-- is deliberate — a new column defaults to guarded, never to writable — and
-- writeClockIn checks its outcome (`.select()` + writeOutcome), so it would
-- surface immediately rather than silently.
--
-- WHY id AND created_at ARE STRIPPED RATHER THAN CHECKED. A BEFORE INSERT
-- trigger cannot tell a client-supplied value from the column default: both
-- are already sitting in NEW by the time this runs (id defaults to
-- gen_random_uuid(), created_at to now()). Comparing them is impossible, so
-- they are handled the only honest way — created_at is overwritten with now()
-- here, making the client's value irrelevant rather than trusted, and `id` is
-- left alone because a client-chosen primary key grants nothing: it cannot
-- collide with an existing row without failing the PK, and every policy, this
-- trigger and the UPDATE guard all key on staff_id/date, never on id.
--
-- NOT AFFECTED.
--   * writeClockIn (src/features/hr/HrAttendance.tsx) sends exactly staff_id,
--     date, clock_in, status, late_minutes, clock_in_photo_url, clock_in_lat,
--     clock_in_lng, clock_in_distance_m, plus late_reason_code/late_reason on
--     the late path — every one of them whitelisted — for attDate, which is
--     today or yesterday. It passes.
--   * That call is an UPSERT, and Postgres fires BEFORE INSERT triggers for
--     the proposed row BEFORE detecting the conflict, so this function also
--     runs on the re-clock-in-onto-an-existing-row case. It passes there for
--     the same reason, and the UPDATE guard then handles the conflict arm.
--   * markAllPresent, DailyRoster.setStatus, HrLeave.approve() and Schedule's
--     leave sync all insert rows carrying recorded_by/marked_by, and rows for
--     dates outside the window — but every one of them is a manager path, and
--     the broad test exempts it. Rows they create for OTHER people never reach
--     the guarded branch at all (new.staff_id <> auth.uid()); the acting
--     manager's OWN row, which markAllPresent always includes, is exempted by
--     the broad test — the same C1 fix as in the UPDATE guard.
--   * mark_absent_for_missed_shifts() inserts rows with marked_by = 'system',
--     scheduled_shift_id and notes set, up to 7 days back. From pg_cron
--     auth.uid() is null and this returns immediately. Called from the app it
--     is reachable only by whoever passes its own guard (migration-2026-07-09-
--     auto-absent.sql, v2: `current_rank() in ('supervisor','manager') or
--     current_system_role() in ('hr','supervisor','manager','admin','owner')`
--     — grepped as the LIVE text, not assumed; that file's own v1 checked rank
--     alone, which is exactly the stale-boundary mistake this note used to
--     repeat before v2 fixed it there too) — which is now the SAME boundary as
--     the broad test here, not merely a subset of it, so every caller that
--     gets past that guard is still exempt from this one, including for a row
--     it creates about the caller.
--   * This file's own re-runs and any SQL-editor backfill have a null
--     auth.uid() and return at the first line, same as the UPDATE guard.
create or replace function attendance_guard_self_insert()
returns trigger
language plpgsql
as $$
declare
  -- The same BROAD test as the UPDATE guard, written the same way and for the
  -- same reason: it is attendance_manage's live USING clause
  -- (migration-2026-07-08-rls-system-role.sql:37-39) expressed through the
  -- two functions that clause itself calls, with coalesce on each half so an
  -- unknown caller fails CLOSED.
  v_attendance_manage_authority boolean;
  v_today_myt         date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  -- Matches notify_late()'s p_date window exactly (sibling migration,
  -- finding 12) and mark_absent_for_missed_shifts()'s lookback.
  v_max_backdate_days constant int := 7;
  v_writable_keys     text[] := array[
    'staff_id', 'date',
    'clock_in', 'clock_in_photo_url', 'clock_in_lat', 'clock_in_lng',
    'clock_in_distance_m',
    'status', 'late_minutes',
    'late_reason_code', 'late_reason'
  ];
  -- Assigned by the server before this trigger can see them; see the comment
  -- above for why they are stripped rather than compared.
  v_server_keys       text[] := array['id', 'created_at'];
  -- Every non-whitelisted column whose declared DEFAULT is a non-null literal.
  v_defaults          jsonb  := jsonb_build_object(
                                 'break_late', false,
                                 'break_overrun_minutes', 0,
                                 'late_excused', false
                               );
  v_residue           jsonb;
begin
  if auth.uid() is null then
    return new;
  end if;

  -- Someone else's row. attendance_self_clock cannot produce this, but
  -- attendance_manage can, and that path is deliberately untouched here.
  if new.staff_id is distinct from auth.uid() then
    return new;
  end if;

  v_attendance_manage_authority :=
    coalesce(current_rank() in ('supervisor','manager'), false)
    or coalesce(current_system_role() in ('hr','supervisor','manager','admin','owner'), false);

  if v_attendance_manage_authority then
    return new;
  end if;

  -- Provenance, not payload: overwrite rather than trust, since a BEFORE
  -- INSERT trigger cannot tell a supplied value from the column default.
  new.created_at := now();

  if new.date is null
     or new.date > v_today_myt
     or new.date < v_today_myt - v_max_backdate_days then
    raise exception
      'You can only create an attendance row for today or the previous % days.',
      v_max_backdate_days
      using errcode = '42501';
  end if;

  if new.clock_in is null then
    raise exception
      'An attendance row you create for yourself must record a clock-in.'
      using errcode = '42501';
  end if;

  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
    into v_residue
    from jsonb_each((to_jsonb(new) - v_writable_keys) - v_server_keys) e
   where jsonb_typeof(e.value) <> 'null'
     and e.value is distinct from (v_defaults -> e.key);

  if v_residue <> '{}'::jsonb then
    raise exception
      'On an attendance row you create for yourself you may only set the date, the clock-in columns, status, late_minutes and the late reason. Not allowed here: %.',
      (select string_agg(k, ', ' order by k) from jsonb_object_keys(v_residue) k)
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists attendance_guard_self_insert_trg on attendance;
create trigger attendance_guard_self_insert_trg
  before insert on attendance
  for each row execute function attendance_guard_self_insert();

-- ── monthly_reviews_guard_subject_update ────────────────────────────────────
-- Everything the two attendance guards above protect is capped by this one
-- policy, one table over (v9, finding I4).
--
-- THE HOLE. Grepped:
--   grep -n "reviews_update_self" supabase/schema.sql supabase/migration-*.sql
-- returns schema.sql:245-246 and nothing else. Unlike reviews_select,
-- reviews_insert and reviews_update_sup — all three of which were replaced,
-- first by migration-2026-07-08-rls-system-role.sql and then by
-- migration-2026-07-10-supervisor-review-scope.sql — this policy was never
-- touched, so the schema.sql text IS the live text here:
--   create policy "reviews_update_self" on monthly_reviews for update
--     using (staff_id = auth.uid());
-- Row-scoped and column-blind, the same shape as attendance_self_update. And
-- `late_count` lives on THIS table, with
--   attendance_score int generated always as (greatest(0, 100 - late_count * 10)) stored
-- so the entire attendance score is one column-blind UPDATE away:
--   update monthly_reviews set late_count = 0 where staff_id = auth.uid();
-- restores a perfect score without touching `attendance` at all — no clock-in
-- forged, no date moved, no trigger on attendance even consulted.
--
-- THE RULE, and the evidence behind it. Established by reading every
-- monthly_reviews write path in src/ rather than by reasoning about what a
-- staff member "should" write:
--
--   WRITABLE by the subject — SelfEvalForm.submit (src/features/staff/
--   StaffProfile.tsx) is the ONE call site where the acting user is the
--   review's own subject, and it sends exactly:
--     self_attitude, self_efficiency, self_coffee_skill, self_service,
--     self_comments, self_submitted_at, status
--   Those seven are the whitelist, and nothing else is on it.
--
--   GUARDED — everything else, which is what the whitelist shape buys, but
--   named here because the point of the finding is which columns these are:
--     late_count            SupervisorReviewCard.handleSubmit (src/features/
--                           team/Reviews.tsx) and SupervisorReviewForm.submit
--                           (StaffProfile.tsx) — both supervisor-side, both
--                           seeding it from countLateDays(). This is the
--                           finding itself.
--     sup_attitude, sup_efficiency, sup_coffee_skill, sup_service,
--     sup_comments, sup_submitted_at
--                           the same two supervisor-side call sites, in the
--                           same statement. No subject-side path writes them.
--     reviewer_id           likewise: written only in those two statements,
--                           alongside the sup_* fields. Guarded on the same
--                           evidence — a subject who could set it could name
--                           someone else as the author of their own review,
--                           which is the monthly_reviews equivalent of the
--                           marked_by/recorded_by forgery the attendance
--                           whitelist closes.
--     staff_id, month, year, id, created_at
--                           written only by MonthlyReviews.handleStartReviews
--                           (Reviews.tsx), which INSERTs (upsert with
--                           ignoreDuplicates, i.e. ON CONFLICT DO NOTHING) and
--                           is manager-gated. No update path writes them.
--
--   NOT WRITABLE BY ANYONE, and therefore not a decision this trigger makes:
--     attendance_score      a stored generated column. Postgres rejects a
--                           direct write to it outright, so it needs no guard
--                           — but it MUST be stripped from the diff below.
--                           Stored generated columns are computed AFTER
--                           BEFORE-row triggers, so NEW.attendance_score is
--                           null in here while OLD.attendance_score holds the
--                           real value; leaving it in would make every single
--                           subject self-evaluation look like a change and
--                           raise. It is the one name in v_ignored_keys.
--
--   `status` — WRITABLE, BUT ONLY FOR ONE TRANSITION (v11, C1; this paragraph
--   is a rewrite in place, not a note appended alongside — the previous
--   version reasoned this away incorrectly and should not be trusted). The
--   subject sets it to 'self_done' at the end of their self-evaluation
--   (SelfEvalForm.submit, src/features/staff/StaffProfile.tsx:517-525), so it
--   has to be on the whitelist above — but the whitelist only decides WHICH
--   columns may change, not what they may become. The previous version of
--   this comment argued that leaving the VALUE unconstrained was safe because
--   "it does not move a score": calcFinalScore (src/shared/types/index.ts)
--   does return null unless all four sup_* ratings are present, and those,
--   along with late_count, are guarded elsewhere in this function. That is
--   true and answers the wrong question — it is about calcFinalScore, not
--   about attendance_score, the column this table actually generates:
--     attendance_score int generated always as (greatest(0, 100 - late_count * 10))
--   late_count defaults to 0, and is written ONLY by the two supervisor-side
--   forms, both fed exclusively by status = 'self_done' — grepped against
--   every caller, not assumed:
--     src/features/team/Reviews.tsx:610 —
--       reviews.filter(r => r.status === 'self_done' && canReviewStaff(...))
--       is the ONLY feed for SupervisorReviewCard.
--     src/features/staff/StaffProfile.tsx:476 —
--       if (review.status === 'self_done' && isSupervisor)
--       is the ONLY feed for SupervisorReviewForm.
--   So a subject running
--     update monthly_reviews set status = 'completed' where id = <own row>;
--   removes their own row from both supervisor entry points for good:
--   late_count is never written by anyone, attendance_score generates a
--   perfect 100 from the untouched default, and the page reports the review
--   complete ("All reviews completed for this month!"). The same open door
--   reverts a completed review back to 'pending' and reopens self-evaluation
--   after it was already scored — nothing constrained the reverse direction
--   either.
--
--   FIXED below: the trigger permits exactly old.status = 'pending' ->
--   new.status = 'self_done' (the one transition SelfEvalForm.submit
--   performs — it is reachable only when review.status === 'pending',
--   StaffProfile.tsx:460), plus a same-value write so a retry of an
--   already-applied submission does not raise. Every other self-initiated
--   change to this column is refused. This is the one place in this table
--   that DOES need something like a state machine, and it now has the minimal
--   one the real call sites require — nothing more elaborate than that.
--
-- THE EXEMPTION mirrors reviews_update_sup, this table's own manager-side
-- policy. Grepped: schema.sql:247-248, then migration-2026-07-08-rls-system-
-- role.sql:153-155, then migration-2026-07-10-supervisor-review-scope.sql:
-- 39-41 — the LAST wins and it is `using (can_review_staff(staff_id))`. So
-- the exemption calls can_review_staff() itself, for the same anti-drift
-- reason the attendance guards call current_rank()/current_system_role():
-- the trigger's expression IS the policy's expression. can_review_staff() is
-- unconditionally true for manager-tier, so a manager editing their own
-- review row is exempt — consistent with the attendance guards, where a
-- caller who already holds unconditional write over everyone's rows gains
-- nothing from being guarded on their own. It returns false, never null
-- (its own body coalesces), so no coalesce is needed here.
--
-- auth.uid() is null for migrations and the SQL editor — allowed through
-- unconditionally, same reasoning as the two guards above: every policy on
-- this table requires auth.uid(), so a null one cannot be an anonymous
-- caller.
create or replace function monthly_reviews_guard_subject_update()
returns trigger
language plpgsql
as $$
declare
  -- The subject's own seven columns — SelfEvalForm.submit's exact payload.
  v_writable_keys text[] := array[
    'self_attitude', 'self_efficiency', 'self_coffee_skill', 'self_service',
    'self_comments', 'self_submitted_at', 'status'
  ];
  -- Stored generated column: null in NEW inside a BEFORE-row trigger, so it
  -- must be stripped from BOTH sides or every subject update would raise.
  -- It is unwritable at the SQL level anyway. See the comment above.
  v_ignored_keys  text[] := array['attendance_score'];
begin
  if auth.uid() is null then
    return new;
  end if;

  -- Not the caller's own review — read on OLD and NEW both, same reasoning as
  -- the attendance guard's ownership test.
  if old.staff_id is distinct from auth.uid()
     and new.staff_id is distinct from auth.uid() then
    return new;
  end if;

  -- reviews_update_sup's live USING clause, via the function it calls.
  if can_review_staff(old.staff_id) or can_review_staff(new.staff_id) then
    return new;
  end if;

  -- (v11, C1) `status` sits in v_writable_keys below because
  -- SelfEvalForm.submit must be able to write it, but the whitelist alone
  -- does not constrain what it may become. Permit exactly the transition the
  -- real caller performs — pending -> self_done — plus a same-value write so
  -- an idempotent retry of an already-applied submission does not raise.
  -- Every other self-initiated change, including 'completed' (which would
  -- freeze attendance_score at a perfect 100 with late_count never written —
  -- see the comment above this function) and any reversion, is refused.
  -- status is `not null default 'pending'` (schema.sql:227-228), so neither
  -- side is ever NULL here.
  if new.status is distinct from old.status
     and not (old.status = 'pending' and new.status = 'self_done') then
    raise exception
      'A monthly review''s status can only move from pending to self_done, and only by submitting a self-evaluation.'
      using errcode = '42501';
  end if;

  if ((to_jsonb(new) - v_writable_keys) - v_ignored_keys)
     is distinct from
     ((to_jsonb(old) - v_writable_keys) - v_ignored_keys) then
    raise exception
      'On your own monthly review you may only fill in your self-evaluation and its status. late_count, the supervisor''s ratings and comments, and reviewer_id are not yours to change.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists monthly_reviews_guard_subject_update_trg on monthly_reviews;
create trigger monthly_reviews_guard_subject_update_trg
  before update on monthly_reviews
  for each row execute function monthly_reviews_guard_subject_update();

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
