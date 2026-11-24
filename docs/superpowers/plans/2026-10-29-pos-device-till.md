# POS · The till on device sessions (Sub-plan C1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every front-of-house RPC onto the device context. On an activated tablet the till runs for the tablet's outlet and acts as the signed-in staff member, and the device is recorded on orders, payments, refunds, voids, cash moves and shifts. Printing is limited to the printing tablet and print agents, reads are scoped to the caller's outlets, and a manager can unpair a tablet from the tablet itself. A transition keeps today's Craft OS `/pos` (staff email logins) working until the POS app replaces it.

**Architecture:**
- One idempotent migration, `supabase/migration-2026-10-29-pos-device-till.sql` (sections `T1`–`T6`), with its rolled-back self-check.
- `pos_my_branch()` now returns the outlet from `pos_ctx()`, so the 26 RPCs that call it follow without being re-created.
- The new `pos_actor()` replaces `auth.uid()` as the actor in the nine RPCs that record one, and in `pos_pin_attempt`. Those ten, plus the three print RPCs and `insert_test_print`, are re-created from their **live** text, which is identical on dev and on the scratch replay (md5 of all 70 POS functions, checked 2026-10-29). Only counted, marked replacements are made.
- The audit `device_id` columns default to `pos_current_device()`, so inserts need no change.
- The read policies use `pos_readable_branches()`.
- No client code changes in C1.

**Tech Stack:** Supabase Postgres (plpgsql `security definer`, RLS), Vitest (the pg-safeupdate scan). The gates are `npx tsc -b` and `npx vitest run`.

**Spec:** `docs/superpowers/specs/2026-10-29-pos-devices-outlets-design.md` §2 (offline queue, approvals) and §4 (server checks, read access, audit), plus the Amendments. This plan builds on Sub-plan A (`b5936f7`) and Sub-plan B (`356fc83`), both live on dev.

## Where this sits (Part C split in three)

The spec's step 3 ("separate app") and the `pos_ctx` swap from step 2 must reach the till together: a tablet can only take orders once the RPCs accept a device session. To keep every step testable on dev without breaking the current `/pos`, Part C is split in three:

- **C1 — this plan: the server.**
  - Every front-of-house RPC runs on `pos_ctx()`.
  - Printing is limited to the printing tablet and print agents.
  - Reads are scoped to the caller's outlets, the device is recorded for audit, and the offline queue's `staffId` is accepted.
  - Unpair-this-device is added.
  - **Transition:** `pos_ctx()` still accepts a staff login at its home branch, with `pos_my_branch()`'s old messages. Today's `/pos` and today's print agent (which also signs in with a staff email) keep working, and every older verify script keeps passing as staff logins.
- **C2 — the POS app** (its own plan, written after C1 is live on dev):
  - Build and hosting:
    - the `pos/` Vite entry, its own Supabase client and storage key;
    - the manifest and service worker, with updates applied on the lock screen;
    - the `craft-pos` Vercel project.
  - Screens and session:
    - the first screen picks what the device is for (POS only for now);
    - activation: request, show the code, poll, sign in as the device; "unknown after approval" asks HQ to activate again;
    - the lock screen (roster, closed-outlet message), the PIN keypad and its error messages;
    - Lock, with the offline confirmation;
    - auto-lock using the roster's `idleLockMinutes`, paused while offline.
  - Till behaviour:
    - `access_changed` → `pos_end_session('access_changed')`;
    - the print host and cash drawer run only when `device.prints`;
    - "Unpair this device" (`pos_unpair_this_device`);
    - "Exit POS" and "My PIN" are removed;
    - the offline queue stores `staffId` and sends it as `p_staff_id`;
    - the coded errors are mapped to the spec's messages.
- **C3 — the switch-over:**
  - remove the staff-login transition from `pos_ctx()` and `pos_print_branch()`;
  - the Craft OS `/pos` shows "The POS has moved to its own app";
  - move the older verify scripts' till calls onto a device + session fixture.

  It runs after C2 is checked on real tablets.
- **D — print agent pairing.** It runs before C3: once C3 removes the transition, the staff-email print agent stops printing.

## Resolutions (decided while planning, 2026-10-29)

- **Redefine `pos_my_branch()`, don't re-create 26 RPCs.**
  - It is now `(select branch_id from pos_ctx())`, and it is volatile because `pos_ctx()` stamps last-seen.
  - Every RPC that already calls it, STABLE ones included, gets the device rules unchanged. It was checked on the replay that a STABLE function may call it: the stamps run in a read-write transaction and are skipped in a read-only one (Sub-plan B's guard).
- **`pos_actor()`** is `(select staff_id from pos_ctx())`. The approval lockout's caller (`pos_pin_attempts.caller_id`) is therefore the session's staff member, as the spec says ("the caller being the session's staff member").
- **The transition is in one place:** the "no `pos_devices` row" branch of `pos_ctx()` and `pos_print_branch()`, each marked `TRANSITION (removed in Sub-plan C3)`.
  - A device is never treated as a staff login: a revoked or print-agent device raises `device_unpaired`.
  - The staff path keeps `pos_my_branch()`'s exact messages ("Sign in required", "Your account is not active", "Your account has no branch — ask a manager to set it in Team"), so the older verifies still match.
- **Printing** (`pos_print_branch()`):
  - A print agent, or the outlet's printing tablet (`prints`), prints for its outlet without a staff session (a locked printing tablet still prints).
  - Any other POS tablet gets `not_printing_tablet`.
  - `claim_print_job`, `finish_print_job`, `requeue_print_job` and `insert_test_print`'s own-outlet path (`p_branch_id` null) use it. The back-office path (`p_branch_id` given, `pos_manages_outlet`) is unchanged.
  - Sub-plan B's verify is updated: a non-printing tablet now gets `not_printing_tablet`, and the printing tablet prints while locked.
- **Reads** (`pos_readable_branches()`):
  - A device reads its own outlet, and an unpaired one reads nothing. A staff login reads `staff_outlet_scope`: home plus extra outlets, or everything for `all_branches`.
  - The `pos_read` policies of the 13 branch tables (`bills`, `orders`, `payments`, `refunds`, `print_jobs`, `dining_tables`, `print_routes`, `branch_menu_status`, `bill_counters`, `branch_pos_settings`, `service_charge_rules`, `payment_methods`, `reason_templates`) use it. So does `order_items`, through its bill, and `dining_tables_update` (the POS pauses QR).
  - `print_jobs_update` is dropped. The client only reads `print_jobs`, and the print RPCs are `security definer`.
  - The menu tables stay company-wide. `pos_shifts` / `pos_cash_moves` have no client policy, and stay that way.
  - Realtime follows the same `select` policies, so a tablet hears only its own outlet.
- **`pos_caller_branch()`** (sold-out writes, `branch_menu_status_write`) is the device's outlet for a device (nothing once revoked), and the staff member's home branch otherwise. It is a non-writing lookup that is safe in RLS.
- **Audit:**
  - `orders.device_id`, `payments.device_id`, `refunds.device_id`, `pos_cash_moves.device_id` and `pos_shifts.opened_device_id` default to `pos_current_device()`. The device is the one making the call; the default is null for a staff login or a QR customer.
  - `bills.closed_device_id` (checkout, merge, void bill), `order_items.voided_device_id` (void item, void bill) and `pos_shifts.closed_device_id` are set by those RPCs.
  - All of them are `references pos_devices on delete set null`. Devices are never deleted: unpair revokes.
- **The offline queue** (`place_counter_order(…, p_catalog_id default null, p_staff_id default null)`):
  - An order sent from the queue is placed by `p_staff_id` when that person may still work at the outlet, and otherwise by the session's staff member (spec §2).
  - The old six-argument function is dropped; calls with five or six arguments still resolve through the defaults.
  - The ordering and catalogs verify scripts' grant lists name the new signature.
- **Unpairing from the tablet** (`pos_unpair_this_device()`):
  - The session's staff member must hold `access_settings` and have the outlet in their scope, otherwise "Only a manager of this outlet can unpair this device".
  - A staff login gets `device_unpaired`.
  - It and `pos_unpair_device` share `pos_revoke_device()`: revoke, end the session as `unpaired`, ban with a real date.
- **Re-created from live text, not from the migration files.** The canonical text of these functions is spread over six older files. `pg_get_functiondef` on the replay (identical to dev) is the source, and the generator asserts each replacement's count. The file therefore uses `CREATE OR REPLACE FUNCTION name(…) … AS $function$ … $function$`, as Postgres prints it, with `SET search_path TO 'public', 'pg_temp'`, which is the same setting.

## Global Constraints

- **Dev database first.**
  - SQL runs on `craft-os-dev` (`egznnbjmicebbhwasloy`) through the Management API, and only by the controller.
  - Prod (`yfsoesxzurzjdwstszru`) is a later step: after the POS chain, Sub-plan A and Sub-plan B, and only with C2 and C3, since prod has no POS yet.
- Steps marked **(controller; the implementer does not touch the database)** are the controller's. Implementers run only `npx tsc -b`, `npx vitest run` and `git`.
- **Functions:**
  - Every new or re-created function pins `search_path` to `public, pg_temp` and revokes execute from `public, anon`.
  - `pos_readable_branches`, `pos_caller_branch`, `pos_unpair_this_device` and `place_counter_order` are granted to `authenticated`.
  - The internal ones (`pos_ctx`, `pos_my_branch`, `pos_actor`, `pos_print_branch`, `pos_current_device`, `pos_revoke_device`) are revoked from `authenticated` too. Re-created functions keep their grants (`create or replace`).
- **pg-safeupdate:** every DELETE or UPDATE inside a function has a WHERE, and `sqlSafeUpdate.test.ts` scans the new file. Its new test also asserts that none of the ten actor functions still contains `auth.uid()`.
- **Migrations are idempotent**, end with `notify pgrst, 'reload schema';` before the final `select`, and STOP unless Sub-plan B is applied.
- **Verify fixtures.** Staff are created as the dev owner `76cbcf9f-905e-450d-9f5e-1c9e72a9373d`. Devices act through `pg_temp.act(device id)`. A side-effect call goes on its own line before a condition reads its effect. Comparisons use `is distinct from`.
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work in `/Users/USER/Desktop/Craft_OS/.claude/worktrees/pos-demo`, branch `feature/pos-demo`. Never use a bare `git stash`. Every replacement quotes its old text; if one does not match exactly once, stop and report.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migration-2026-10-29-pos-device-till.sql` | T1–T6 (Task 1) |
| `supabase/migration-2026-10-29-pos-device-till-verify.sql` | Self-check, rolled back (Task 1) |
| `supabase/migration-2026-10-23-pos-ordering-verify.sql`, `-24-pos-catalogs-verify.sql`, `-29-pos-devices-verify.sql` | Regression scripts follow the new `place_counter_order` signature and the printing rule (Task 1) |
| `src/features/pos/sqlSafeUpdate.test.ts` | Scans the new file; no `auth.uid()` actor left (Task 1) |

**Test counts.** These were checked on a scratch copy at `356fc83` by applying this document:
- Baseline: 131 files / 1075 tests.
- After Task 1: 131 / 1077.
- `npx tsc -b` is silent.

**SQL checks.** The SQL was replayed on a scratch PostgreSQL 18 with the POS chain, A and B (function text identical to dev):
- The migration applies twice.
- The new verify and all eleven older POS verify scripts print `VERIFY OK`, three of them after Task 1's edits.
- The new verify fails for each of ten deliberate faults:
  - `checkout_bill` keeping `auth.uid()`;
  - no printing-tablet check;
  - reads not scoped;
  - an open `order_items` policy;
  - the queue ignoring `p_staff_id`;
  - unpair-this-device without the manager check;
  - the approval lockout counting `auth.uid()`;
  - a revoked device treated like a staff login;
  - no voiding device on `void_bill`;
  - the same on `void_order_item`.

---

### Task 1: The device-till migration, its verify, the regression updates — and applying it on craft-os-dev (implementer + controller)

**Model tier:** cheap (the plan carries every line; the long middle of the migration is the live function text). The controller runs Step 6.

**Files:**
- Create: `supabase/migration-2026-10-29-pos-device-till.sql`, `supabase/migration-2026-10-29-pos-device-till-verify.sql`
- Modify: `supabase/migration-2026-10-23-pos-ordering-verify.sql`, `supabase/migration-2026-10-24-pos-catalogs-verify.sql`, `supabase/migration-2026-10-29-pos-devices-verify.sql`, `src/features/pos/sqlSafeUpdate.test.ts`

**Interfaces:**
- Consumes (Sub-plan B, live): `pos_ctx()`, `pos_devices`, `pos_staff_sessions`, `pos_manages_outlet`, `staff_outlet_scope`, `pos_staff_may_work`, `pos_outlet_open`.
- Produces (for C2):
  - Every front-of-house RPC accepts a device with an open session. Errors: `device_unpaired`, `outlet_closed`, `no_session`, `access_changed`.
  - The print RPCs need no session and raise `not_printing_tablet` for a non-printing tablet.
  - `place_counter_order(p_table_id, p_order_type, p_pax, p_items, p_client_order_id, p_catalog_id default null, p_staff_id default null)`.
  - `pos_unpair_this_device()`.
  - Reads are scoped to the device's outlet.

- [ ] **Step 1: Name the new file in the pg-safeupdate scan (the failing test)**

Replacement 1 in `src/features/pos/sqlSafeUpdate.test.ts` — replace:

```ts
      'migration-2026-10-29-pos-devices.sql',
    ]))
```

with:

```ts
      'migration-2026-10-29-pos-devices.sql',
      'migration-2026-10-29-pos-device-till.sql',
    ]))
```

Replacement 2 in `src/features/pos/sqlSafeUpdate.test.ts` — replace:

```ts
    const verify = readFileSync(new URL('migration-2026-10-29-pos-devices-verify.sql', SUPABASE), 'utf8')
    expect(verify).toMatch(/^begin;$/m)
    expect(verify).toMatch(/raise notice 'VERIFY OK';\s*end \$\$;\s*select 'VERIFY OK' as result;\s*rollback;\s*$/)
  })
})
```

with:

```ts
    const verify = readFileSync(new URL('migration-2026-10-29-pos-devices-verify.sql', SUPABASE), 'utf8')
    expect(verify).toMatch(/^begin;$/m)
    expect(verify).toMatch(/raise notice 'VERIFY OK';\s*end \$\$;\s*select 'VERIFY OK' as result;\s*rollback;\s*$/)
  })

  it('scans the device-till migration: every re-created RPC, no auth.uid() actor left, a rolled-back verify', () => {
    const sql = readFileSync(new URL('migration-2026-10-29-pos-device-till.sql', SUPABASE), 'utf8')
    const names = functionBodies(sql).map((b) => b.name.replace(/^public\./, ''))
    expect(names).toEqual(expect.arrayContaining([
      'pos_ctx', 'pos_my_branch', 'pos_actor', 'pos_print_branch', 'pos_revoke_device', 'pos_unpair_device', 'pos_unpair_this_device',
      'place_counter_order', 'checkout_bill', 'close_shift', 'merge_bills', 'open_shift', 'record_cash_move', 'refund_bill',
      'void_bill', 'void_order_item', 'pos_pin_attempt', 'claim_print_job', 'finish_print_job', 'requeue_print_job', 'insert_test_print',
    ]))
    for (const { name, body } of functionBodies(sql)) {
      if (/(checkout_bill|close_shift|merge_bills|open_shift|record_cash_move|refund_bill|void_bill|void_order_item|pos_pin_attempt|place_counter_order)$/i.test(name)) {
        expect(body, name).not.toMatch(/auth\.uid\(\)/)
      }
    }
    expect(sql).toMatch(/raise exception 'STOP: run migration-2026-10-29-pos-devices\.sql first/)
    expect(sql).toMatch(/notify pgrst, 'reload schema';\s*select '[^']+' as result;\s*$/)
    const verify = readFileSync(new URL('migration-2026-10-29-pos-device-till-verify.sql', SUPABASE), 'utf8')
    expect(verify).toMatch(/^begin;$/m)
    expect(verify).toMatch(/raise notice 'VERIFY OK';\s*end \$\$;\s*select 'VERIFY OK' as result;\s*rollback;\s*$/)
  })
})
```


Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts`
Expected: FAIL. The file list misses `migration-2026-10-29-pos-device-till.sql`, and the new scan test cannot read it (ENOENT).

- [ ] **Step 2: Write the migration**

Create `supabase/migration-2026-10-29-pos-device-till.sql`:

```sql
-- ============================================================================
-- Craft OS — POS till on device sessions (2026-10-29): Sub-plan C1 of devices, PIN login
-- and outlets. Run on craft-os-dev after migration-2026-10-29-pos-devices.sql.
-- Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-29-pos-device-till.md
-- Design: docs/superpowers/specs/2026-10-29-pos-devices-outlets-design.md (§2 offline queue, §4)
--
-- T1  Every front-of-house RPC now runs on the device context. pos_my_branch() returns the
--     outlet from pos_ctx(), so the 26 RPCs that call it follow without being re-created;
--     the new pos_actor() is the session's staff member, and the nine RPCs that recorded
--     auth.uid() as the actor (checkout_bill, close_shift, merge_bills, open_shift,
--     place_counter_order, record_cash_move, refund_bill, void_bill, void_order_item) and
--     pos_pin_attempt (the approval lockout's caller) are re-created from their live text
--     with auth.uid() → pos_actor().
--     TRANSITION (removed in Sub-plan C3): pos_ctx() still accepts a staff login at its home
--     branch, with pos_my_branch()'s old messages, so the Craft OS /pos keeps working until
--     the POS app replaces it. A device is never treated as a staff login.
-- T2  Printing: pos_print_branch() refuses a POS tablet that is not the outlet's printing
--     tablet (not_printing_tablet); claim_print_job, finish_print_job, requeue_print_job and
--     insert_test_print's own-outlet path use it (no staff session needed). TRANSITION: a
--     staff login (today's print agent) still prints for its home branch.
-- T3  Reads: pos_readable_branches() — a device reads its own outlet, a staff login the
--     outlets of staff_outlet_scope. The open read policies (pos_read) of the branch tables
--     and order_items, and dining_tables_update, use it; print_jobs_update (no client
--     writes it any more) is dropped. Realtime follows the same policies.
--     pos_caller_branch() (sold-out writes) is a device's outlet for a device.
-- T4  Audit: device_id on orders, payments, refunds, pos_cash_moves and
--     pos_shifts.opened_device_id are filled by default from pos_current_device();
--     bills.closed_device_id, order_items.voided_device_id and pos_shifts.closed_device_id
--     are set by the RPCs that close, void or close a shift.
-- T5  The offline queue: place_counter_order takes p_staff_id (who queued the order); the
--     order is placed by that person when they may still work at the outlet, otherwise by
--     the session's staff member.
-- T6  pos_unpair_this_device(): a manager of the outlet, signed in on the tablet, unpairs
--     it from the POS app. It and pos_unpair_device share pos_revoke_device().
-- Re-run hazards: re-running an older file that defines any function re-created here
-- (checkout-fn, bill-actions-fn, checkout-fixes, catalogs-fn, shifts-fn, hardening,
-- ordering-fn, outlets, devices) puts back its auth.uid() actor — re-run this file after it.
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_ctx()') is null or to_regprocedure('pos_set_print_tablet(uuid)') is null then
    raise exception 'STOP: run migration-2026-10-29-pos-devices.sql first (pos_ctx is missing)';
  end if;
end $$;

-- ── T4. The device behind the current call, without writing (defaults, policies) ──
create or replace function pos_current_device() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select d.id from pos_devices d where d.id = auth.uid() and d.revoked_at is null
$$;
revoke all on function pos_current_device() from public, anon, authenticated;

alter table orders         add column if not exists device_id        uuid references pos_devices(id) on delete set null;
alter table payments       add column if not exists device_id        uuid references pos_devices(id) on delete set null;
alter table refunds        add column if not exists device_id        uuid references pos_devices(id) on delete set null;
alter table pos_cash_moves add column if not exists device_id        uuid references pos_devices(id) on delete set null;
alter table pos_shifts     add column if not exists opened_device_id uuid references pos_devices(id) on delete set null;
alter table pos_shifts     add column if not exists closed_device_id uuid references pos_devices(id) on delete set null;
alter table bills          add column if not exists closed_device_id uuid references pos_devices(id) on delete set null;
alter table order_items    add column if not exists voided_device_id uuid references pos_devices(id) on delete set null;
alter table orders         alter column device_id        set default pos_current_device();
alter table payments       alter column device_id        set default pos_current_device();
alter table refunds        alter column device_id        set default pos_current_device();
alter table pos_cash_moves alter column device_id        set default pos_current_device();
alter table pos_shifts     alter column opened_device_id set default pos_current_device();

-- ── T1. The device context, with the C1 transition for staff logins ──────────
-- Same as migration-2026-10-29-pos-devices.sql except a caller with no pos_devices row: a
-- live staff member at their home branch (device_id null), with pos_my_branch()'s messages.
create or replace function pos_ctx(out device_id uuid, out branch_id uuid, out staff_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dev    pos_devices;
  v_ses    pos_staff_sessions;
  v_branch uuid;
  v_live   boolean;
begin
  select * into v_dev from pos_devices d where d.id = auth.uid();
  if not found then
    -- TRANSITION (removed in Sub-plan C3): a staff login runs the till at its home branch
    if auth.uid() is null then raise exception 'Sign in required'; end if;
    select s.branch_id, (s.is_active and s.status = 'active') into v_branch, v_live from staff s where s.id = auth.uid();
    if not coalesce(v_live, false) then raise exception 'Your account is not active'; end if;
    if v_branch is null then raise exception 'Your account has no branch — ask a manager to set it in Team'; end if;
    device_id := null;
    branch_id := v_branch;
    staff_id := auth.uid();
    return;
  end if;
  if v_dev.kind <> 'pos' or v_dev.revoked_at is not null then raise exception 'device_unpaired'; end if;
  if not pos_outlet_open(v_dev.branch_id) then raise exception 'outlet_closed'; end if;
  select * into v_ses from pos_staff_sessions s where s.device_id = v_dev.id and s.ended_at is null;
  if not found then raise exception 'no_session'; end if;
  if not pos_staff_may_work(v_ses.staff_id, v_dev.branch_id) then raise exception 'access_changed'; end if;
  -- stamped at most every 30 s: every till call passes here. A read-only transaction (PostgREST
  -- runs STABLE RPCs read-only) skips the stamps instead of failing the call.
  if not current_setting('transaction_read_only')::boolean then
    update pos_devices set last_seen_at = now()
     where id = v_dev.id and (last_seen_at is null or last_seen_at < now() - interval '30 seconds');
    update pos_staff_sessions set last_active_at = now()
     where id = v_ses.id and last_active_at < now() - interval '30 seconds';
  end if;
  device_id := v_dev.id;
  branch_id := v_dev.branch_id;
  staff_id := v_ses.staff_id;
end $$;
revoke all on function pos_ctx() from public, anon, authenticated;

-- The outlet of every front-of-house call: the 26 RPCs that call this follow pos_ctx().
create or replace function pos_my_branch() returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return (select c.branch_id from pos_ctx() c);
end $$;
revoke all on function pos_my_branch() from public, anon, authenticated;

-- Who acts: the session's staff member on a device (a staff login during the transition).
create or replace function pos_actor() returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return (select c.staff_id from pos_ctx() c);
end $$;
revoke all on function pos_actor() from public, anon, authenticated;

-- ── T2. Printing ─────────────────────────────────────────────────────────────
-- A print agent, or the outlet's printing tablet (locked or not), prints for its outlet.
create or replace function pos_print_branch() returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dev pos_devices;
begin
  select * into v_dev from pos_devices d where d.id = auth.uid();
  if not found then
    return pos_my_branch();                       -- TRANSITION (removed in C3): a staff login prints for its home branch
  end if;
  if v_dev.revoked_at is not null then raise exception 'device_unpaired'; end if;
  if v_dev.kind = 'pos' and not v_dev.prints then raise exception 'not_printing_tablet'; end if;
  if not current_setting('transaction_read_only')::boolean then              -- as in pos_ctx
    update pos_devices set last_seen_at = now()
     where id = v_dev.id and (last_seen_at is null or last_seen_at < now() - interval '30 seconds');
  end if;
  return v_dev.branch_id;
end $$;
revoke all on function pos_print_branch() from public, anon, authenticated;

-- ── T3. Reads ────────────────────────────────────────────────────────────────
-- A device reads its own outlet (nothing once revoked); a staff login the outlets in its scope.
create or replace function pos_readable_branches() returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select d.branch_id from pos_devices d where d.id = auth.uid() and d.revoked_at is null
  union
  select x.id from staff_outlet_scope(auth.uid()) as x(id)
   where not exists (select 1 from pos_devices d where d.id = auth.uid())
$$;
revoke all on function pos_readable_branches() from public, anon;
grant execute on function pos_readable_branches() to authenticated;

-- Sold-out writes (branch_menu_status_write): a device's outlet, else the staff member's home branch.
create or replace function pos_caller_branch() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select case when exists (select 1 from pos_devices d where d.id = auth.uid())
              then (select d.branch_id from pos_devices d where d.id = auth.uid() and d.revoked_at is null)
              else (select s.branch_id from staff s where s.id = auth.uid() and s.is_active and s.status = 'active') end
$$;
revoke all on function pos_caller_branch() from public, anon;
grant execute on function pos_caller_branch() to authenticated;

do $$
declare t text;
begin
  foreach t in array array['bills', 'orders', 'payments', 'refunds', 'print_jobs', 'dining_tables', 'print_routes',
                           'branch_menu_status', 'bill_counters', 'branch_pos_settings', 'service_charge_rules',
                           'payment_methods', 'reason_templates'] loop
    execute format('drop policy if exists pos_read on %I', t);
    execute format('create policy pos_read on %I for select to authenticated using (branch_id in (select pos_readable_branches()))', t);
  end loop;
end $$;
drop policy if exists pos_read on order_items;
create policy pos_read on order_items for select to authenticated
  using (exists (select 1 from bills b where b.id = order_items.bill_id and b.branch_id in (select pos_readable_branches())));
drop policy if exists dining_tables_update on dining_tables;
create policy dining_tables_update on dining_tables for update to authenticated
  using (branch_id in (select pos_readable_branches())) with check (branch_id in (select pos_readable_branches()));
drop policy if exists print_jobs_update on print_jobs;

-- ── T6. Unpairing, shared ────────────────────────────────────────────────────
-- Revoke, end the open session, ban the auth user (a real date: Auth cannot read 'infinity').
create or replace function pos_revoke_device(p_device_id uuid, p_by uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update pos_devices set revoked_at = now(), revoked_by = p_by, prints = false where id = p_device_id and revoked_at is null;
  update pos_staff_sessions set ended_at = now(), end_reason = 'unpaired' where device_id = p_device_id and ended_at is null;
  update auth.users set banned_until = now() + interval '100 years' where id = p_device_id;
end $$;
revoke all on function pos_revoke_device(uuid, uuid) from public, anon, authenticated;

-- Same as migration-2026-10-29-pos-devices.sql except the shared revoke.
create or replace function pos_unpair_device(p_device_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dev pos_devices;
begin
  select * into v_dev from pos_devices d where d.id = p_device_id for update;
  if not found then raise exception 'Device not found'; end if;
  if not pos_manages_outlet(v_dev.branch_id) then raise exception 'This device is not at one of your outlets'; end if;
  if v_dev.revoked_at is not null then return; end if;
  perform pos_revoke_device(v_dev.id, auth.uid());
end $$;
revoke all on function pos_unpair_device(uuid) from public, anon;
grant execute on function pos_unpair_device(uuid) to authenticated;

-- POS app → Unpair this device: the signed-in staff member manages this outlet.
create or replace function pos_unpair_this_device() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ctx record;
begin
  select * into v_ctx from pos_ctx();
  if v_ctx.device_id is null then raise exception 'device_unpaired'; end if;    -- a staff login has no device
  perform 1 from pos_devices d where d.id = v_ctx.device_id for update;
  if not (staff_has_cap(v_ctx.staff_id, 'access_settings') and v_ctx.branch_id in (select staff_outlet_scope(v_ctx.staff_id))) then
    raise exception 'Only a manager of this outlet can unpair this device';
  end if;
  perform pos_revoke_device(v_ctx.device_id, v_ctx.staff_id);
end $$;
revoke all on function pos_unpair_this_device() from public, anon;
grant execute on function pos_unpair_this_device() to authenticated;

-- ── T5. The offline queue keeps who took the order ───────────────────────────
drop function if exists place_counter_order(uuid, text, integer, jsonb, uuid, uuid);
create or replace function place_counter_order(p_table_id uuid, p_order_type text, p_pax integer, p_items jsonb,
                                               p_client_order_id uuid, p_catalog_id uuid default null,
                                               p_staff_id uuid default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ctx record;
  v_by  uuid;
begin
  select * into v_ctx from pos_ctx();
  -- an order sent from the offline queue is placed by whoever queued it, if they may still work here
  v_by := case when p_staff_id is not null and pos_staff_may_work(p_staff_id, v_ctx.branch_id) then p_staff_id
               else v_ctx.staff_id end;
  return pos_insert_order(v_ctx.branch_id, p_table_id, p_order_type, p_pax, 'counter', v_by, p_items,
                          p_client_order_id, p_catalog_id);
end $$;
revoke all on function place_counter_order(uuid, text, integer, jsonb, uuid, uuid, uuid) from public, anon;
grant execute on function place_counter_order(uuid, text, integer, jsonb, uuid, uuid, uuid) to authenticated;

-- ── T1 / T2 / T4. Re-created from their live text (2026-10-29, identical on dev and the
-- replay), with only the marked replacements: auth.uid() → pos_actor() (the actor),
-- the closing / voiding device, and pos_my_branch() → pos_print_branch() for printing.

-- checkout_bill: re-created (see the header)
CREATE OR REPLACE FUNCTION checkout_bill(p_bill_id uuid, p_payments jsonb, p_checkout_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch    uuid := pos_my_branch();
  v_bill      bills;
  v_totals    jsonb;
  v_total     integer;
  v_sum       integer := 0;
  v_p         jsonb;
  v_m         payment_methods;
  v_amount    integer;
  v_tendered  integer;
  v_n         integer := 0;
  v_queued    boolean;
  v_shift     uuid;                                                -- 4a
begin
  if p_checkout_id is null then raise exception 'Checkout id is missing'; end if;
  -- a resend of a checkout that already went through gets the first answer —
  -- but only for the same bill of the caller's branch
  select * into v_bill from bills where checkout_id = p_checkout_id;
  if found then
    if v_bill.id <> p_bill_id or v_bill.branch_id <> v_branch then
      raise exception 'This checkout id belongs to another bill';
    end if;
    -- H2: the first result is replayed only for the very same payments
    if not pos_checkout_same_payments(v_bill.id, p_payments) then
      raise exception 'This payment was already recorded with other amounts — check Today''s bills';
    end if;
    return pos_checkout_result(v_bill.id);
  end if;

  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  if v_bill.checkout_id is not distinct from p_checkout_id then  -- won by the same checkout while we waited
    if not pos_checkout_same_payments(v_bill.id, p_payments) then                                   -- H2
      raise exception 'This payment was already recorded with other amounts — check Today''s bills';  -- H2
    end if;                                                                                          -- H2
    return pos_checkout_result(v_bill.id);
  end if;
  -- 4a: money moves only inside the branch's open shift. FOR SHARE lets checkouts run
  -- side by side, while close_shift (FOR UPDATE) waits for one in flight and then counts it.
  select id into v_shift from pos_shifts where branch_id = v_branch and status = 'open' for share;
  if not found then raise exception 'Open the shift first'; end if;
  if v_bill.status <> 'open' then
    raise exception 'This bill is already %', case v_bill.status when 'paid' then 'paid'
                                                                 when 'voided' then 'voided'
                                                                 else 'merged into another bill' end;
  end if;
  if not exists (select 1 from order_items where bill_id = v_bill.id and voided_at is null) then
    raise exception 'This bill has no items to pay for';
  end if;
  if p_payments is null or jsonb_typeof(p_payments) <> 'array' then raise exception 'Invalid payments'; end if;
  if jsonb_array_length(p_payments) > 10 then raise exception 'Too many payments on one bill'; end if;

  v_totals := pos_bill_totals(v_bill.id);
  v_total  := (v_totals->>'totalSen')::integer;

  -- validate every payment before writing anything
  for v_p in select * from jsonb_array_elements(p_payments) loop
    if jsonb_typeof(v_p) <> 'object' or jsonb_typeof(v_p->'methodId') is distinct from 'string'
       or (v_p->>'methodId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Invalid payment';
    end if;
    if jsonb_typeof(v_p->'amountSen') is distinct from 'number'
       or (v_p->'amountSen')::numeric <> trunc((v_p->'amountSen')::numeric)
       or (v_p->'amountSen')::numeric <= 0 or (v_p->'amountSen')::numeric > 10000000 then
      raise exception 'Invalid payment amount';
    end if;
    select * into v_m from payment_methods
     where id = (v_p->>'methodId')::uuid and branch_id = v_branch and is_active;
    if not found then raise exception 'Payment method is not available at this branch'; end if;
    if jsonb_typeof(v_p->'tenderedSen') = 'number' then
      if (v_p->'tenderedSen')::numeric <> trunc((v_p->'tenderedSen')::numeric)
         or (v_p->'tenderedSen')::numeric > 10000000 then
        raise exception 'Invalid cash received';
      end if;
      if v_m.kind <> 'cash' then raise exception 'Only cash can be tendered above the amount'; end if;
      if (v_p->'tenderedSen')::numeric < (v_p->'amountSen')::numeric then
        raise exception 'Cash received is less than the amount';
      end if;
    elsif v_p->'tenderedSen' is not null and jsonb_typeof(v_p->'tenderedSen') <> 'null' then
      raise exception 'Invalid cash received';
    end if;
    if v_m.needs_reference
       and nullif(trim(case when jsonb_typeof(v_p->'reference') = 'string' then v_p->>'reference' end), '') is null then
      raise exception 'Enter the reference for %', v_m.name;
    end if;
    v_sum := v_sum + (v_p->'amountSen')::numeric::integer;
  end loop;
  if v_sum <> v_total then
    raise exception 'Payments (RM %) do not match the total (RM %)',
      to_char(v_sum / 100.0, 'FM999999990.00'), to_char(v_total / 100.0, 'FM999999990.00');
  end if;

  for v_p in select * from jsonb_array_elements(p_payments) loop
    v_n := v_n + 1;
    select * into v_m from payment_methods where id = (v_p->>'methodId')::uuid;
    v_amount   := (v_p->'amountSen')::numeric::integer;
    v_tendered := case when v_m.kind = 'cash' and jsonb_typeof(v_p->'tenderedSen') = 'number'
                       then (v_p->'tenderedSen')::numeric::integer end;
    insert into payments(bill_id, branch_id, method_id, method_name, kind, amount_sen, tendered_sen,
                         change_sen, reference, taken_by, line_no, shift_id)            -- 4a: shift_id
    values (v_bill.id, v_branch, v_m.id, v_m.name, v_m.kind, v_amount, v_tendered,
            coalesce(v_tendered - v_amount, 0),
            nullif(trim(left(case when jsonb_typeof(v_p->'reference') = 'string' then v_p->>'reference' end, 60)), ''),
            pos_actor(), v_n, v_shift);                                          -- 4a: v_shift
  end loop;

  update bills
     set status = 'paid', closed_at = now(), closed_by = pos_actor(), closed_device_id = pos_current_device(), checkout_id = p_checkout_id,
         shift_id = v_shift,                                                     -- 4a: the bill's shift
         totals = v_totals,
         subtotal_sen       = (v_totals->>'subtotalSen')::integer,
         service_charge_sen = (v_totals->>'serviceChargeSen')::integer,
         sst_sen            = (v_totals->>'sstSen')::integer,
         takeaway_fee_sen   = (v_totals->>'takeawayFeeSen')::integer,
         rounding_sen       = (v_totals->>'roundingSen')::integer,
         total_sen          = v_total
   where id = v_bill.id;
  v_queued := pos_queue_receipt(v_bill.id, false);
  update bills set receipt_queued = v_queued where id = v_bill.id;
  return pos_checkout_result(v_bill.id);
end $function$;

-- close_shift: re-created (see the header)
CREATE OR REPLACE FUNCTION close_shift(p_shift_id uuid, p_counted_sen integer, p_reason text, p_approver_id uuid, p_pin text, p_expected_sen integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch   uuid := pos_my_branch();
  v_shift    pos_shifts;
  v_expected integer;
  v_var      integer;
  v_limit    integer;
  v_above    boolean;
  v_reason   text;
  v_err      text;
  v_report   jsonb;
  v_printed  boolean;
begin
  if p_counted_sen is null or p_counted_sen < 0 or p_counted_sen > 10000000 then
    raise exception 'Enter the counted cash (RM 0.00 to RM 100000.00)';
  end if;
  -- FOR UPDATE: waits for a checkout or refund in flight (they hold the shift FOR SHARE)
  select * into v_shift from pos_shifts where id = p_shift_id and branch_id = v_branch for update;
  if not found then raise exception 'Shift not found'; end if;
  if v_shift.status = 'closed' then
    if v_shift.counted_cash_sen = p_counted_sen and v_shift.report is not null then
      return jsonb_build_object('ok', true, 'shiftId', v_shift.id, 'report', v_shift.report,
                                'printed', coalesce(v_shift.report_printed, false));
    end if;
    raise exception 'This shift is already closed';
  end if;
  v_expected := pos_shift_expected_cash(v_shift.id);
  v_var      := p_counted_sen - v_expected;
  -- the first count and its variance against the expected cash at that moment, stored together, never replaced
  if v_shift.first_count_sen is null then
    update pos_shifts set first_count_sen = p_counted_sen, first_variance_sen = v_var where id = v_shift.id;
  end if;
  v_limit    := coalesce((select s.cash_variance_limit_sen from branch_pos_settings s where s.branch_id = v_branch), 500);
  -- v_shift was read before the first count was stored: on the first call this is this count's variance.
  -- The first count is judged by its own variance, not against the expected cash now: a pay in recorded
  -- after the figure was shown cannot bring it within the limit. (A shift counted before
  -- first_variance_sen existed falls back to the old rule.)
  v_above    := abs(v_var) > v_limit
                or abs(coalesce(v_shift.first_variance_sen, v_shift.first_count_sen - v_expected, v_var)) > v_limit;
  if v_above then
    if p_approver_id is null or p_expected_sen is distinct from v_expected then
      return jsonb_build_object('ok', false, 'needsApproval', true,
                                'expectedSen', v_expected, 'varianceSen', v_var, 'limitSen', v_limit);
    end if;
    v_reason := nullif(trim(p_reason), '');
    if v_reason is null then raise exception 'Enter a reason for the difference'; end if;
    if length(v_reason) > 200 then raise exception 'Reason is too long'; end if;
    v_err := pos_check_approver(v_branch, p_approver_id, p_pin);
    if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  end if;
  update pos_shifts
     set status = 'closed', counted_cash_sen = p_counted_sen, expected_cash_sen = v_expected, variance_sen = v_var,
         variance_reason = case when v_above then v_reason end,
         variance_approved_by = case when v_above then p_approver_id end,
         closed_by = pos_actor(), closed_device_id = pos_current_device(), closed_at = clock_timestamp()   -- not now(): after any wait for the lock
   where id = v_shift.id;
  v_report  := pos_shift_report(v_shift.id);
  v_printed := pos_queue_zreport(v_branch, v_report, false);
  update pos_shifts set report = v_report, report_printed = v_printed where id = v_shift.id;
  return jsonb_build_object('ok', true, 'shiftId', v_shift.id, 'report', v_report, 'printed', v_printed);
end $function$;

-- merge_bills: re-created (see the header)
CREATE OR REPLACE FUNCTION merge_bills(p_from_bill uuid, p_into_bill uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch uuid := pos_my_branch();
  v_from   bills;
  v_into   bills;
begin
  if p_from_bill is null or p_into_bill is null or p_from_bill = p_into_bill then
    raise exception 'Choose two different bills';
  end if;
  -- lock both in one fixed order, so two iPads merging the same pair cannot deadlock
  perform 1 from bills where id in (p_from_bill, p_into_bill) order by id for update;
  select * into v_from from bills where id = p_from_bill and branch_id = v_branch;
  select * into v_into from bills where id = p_into_bill and branch_id = v_branch;
  if v_from.id is null or v_into.id is null then raise exception 'Bill not found'; end if;
  if v_from.status <> 'open' or v_into.status <> 'open' then raise exception 'Only open bills can be merged'; end if;
  if v_from.order_type = 'dine_in' and v_into.order_type = 'takeaway' then
    raise exception 'Merge the takeaway bill into the table''s bill, not the other way round';
  end if;
  update orders set bill_id = v_into.id where bill_id = v_from.id;
  update order_items set bill_id = v_into.id where bill_id = v_from.id;
  update bills
     set pax = case when v_into.pax is null and v_from.pax is null then null
                    else least(99, coalesce(v_into.pax, 0) + coalesce(v_from.pax, 0)) end
   where id = v_into.id;
  update bills
     set status = 'merged', merged_into = v_into.id, closed_at = now(), closed_by = pos_actor(), closed_device_id = pos_current_device()
   where id = v_from.id;
end $function$;

-- open_shift: re-created (see the header)
CREATE OR REPLACE FUNCTION open_shift(p_float_sen integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch uuid := pos_my_branch();
  v_open   pos_shifts;
begin
  if p_float_sen is null or p_float_sen < 0 or p_float_sen > 10000000 then
    raise exception 'Enter the opening float (RM 0.00 to RM 100000.00)';
  end if;
  select * into v_open from pos_shifts where branch_id = v_branch and status = 'open';
  if not found then
    begin
      insert into pos_shifts(branch_id, opened_by, opening_float_sen) values (v_branch, pos_actor(), p_float_sen);
      return pos_current_shift();
    exception when unique_violation then                                  -- another iPad opened it a moment ago
      select * into v_open from pos_shifts where branch_id = v_branch and status = 'open';
    end;
  end if;
  raise exception 'A shift is already open — opened by % at %',
    coalesce((select name from staff where id = v_open.opened_by), 'someone'),
    to_char(v_open.opened_at at time zone 'Asia/Kuala_Lumpur', 'HH24:MI');
end $function$;

-- record_cash_move: re-created (see the header)
CREATE OR REPLACE FUNCTION record_cash_move(p_id uuid, p_kind text, p_amount_sen integer, p_reason text, p_approver_id uuid, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch   uuid := pos_my_branch();
  v_existing pos_cash_moves;
  v_shift    uuid;
  v_reason   text := nullif(trim(p_reason), '');
  v_err      text;
begin
  if p_id is null then raise exception 'Cash move id is missing'; end if;
  select * into v_existing from pos_cash_moves where id = p_id;
  if found then
    if v_existing.branch_id <> v_branch then raise exception 'This cash move id belongs to another branch'; end if;
    if v_existing.kind is distinct from p_kind or v_existing.amount_sen is distinct from p_amount_sen then
      return jsonb_build_object('ok', false, 'error',
        format('This was already recorded as %s RM %s — close and reopen to record another',
               case v_existing.kind when 'pay_in' then 'Pay in' else 'Pay out' end,
               to_char(v_existing.amount_sen / 100.0, 'FM999999990.00')));
    end if;
    return jsonb_build_object('ok', true, 'id', v_existing.id, 'kind', v_existing.kind, 'amountSen', v_existing.amount_sen);
  end if;
  if p_kind is null or p_kind not in ('pay_in', 'pay_out') then raise exception 'Choose Pay in or Pay out'; end if;
  if p_amount_sen is null or p_amount_sen <= 0 or p_amount_sen > 10000000 then
    raise exception 'Enter the amount (RM 0.01 to RM 100000.00)';
  end if;
  if v_reason is null then raise exception 'Enter a reason'; end if;
  if length(v_reason) > 200 then raise exception 'Reason is too long'; end if;
  select id into v_shift from pos_shifts where branch_id = v_branch and status = 'open' for share;
  if not found then raise exception 'Open the shift first'; end if;
  if p_kind = 'pay_out' then
    v_err := pos_check_approver(v_branch, p_approver_id, p_pin);
    if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  end if;
  insert into pos_cash_moves(id, shift_id, branch_id, kind, amount_sen, reason, created_by, approved_by)
  values (p_id, v_shift, v_branch, p_kind, p_amount_sen, v_reason, pos_actor(),
          case when p_kind = 'pay_out' then p_approver_id end)
  on conflict (id) do nothing;
  if not found then                                                       -- the same id won meanwhile
    return record_cash_move(p_id, p_kind, p_amount_sen, p_reason, p_approver_id, p_pin);
  end if;
  return jsonb_build_object('ok', true, 'id', p_id, 'kind', p_kind, 'amountSen', p_amount_sen);
end $function$;

-- refund_bill: re-created (see the header)
CREATE OR REPLACE FUNCTION refund_bill(p_refund_id uuid, p_bill_id uuid, p_amount_sen integer, p_method_id uuid, p_reason text, p_approver_id uuid, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch      uuid := pos_my_branch();
  v_bill        bills;
  v_existing    refunds;
  v_method_name text;
  v_paid        integer;
  v_back        integer;
  v_reason      text;
  v_err         text;
  v_route       text;
  v_kind        text;                                              -- 4a
  v_shift       uuid;                                              -- 4a
begin
  if p_refund_id is null then raise exception 'Refund id is missing'; end if;
  -- a resend of a refund that already went through gets the same reply as the first time
  select * into v_existing from refunds where id = p_refund_id;
  if found then
    if v_existing.branch_id <> v_branch then
      raise exception 'This refund id belongs to another bill';
    end if;
    if v_existing.bill_id <> p_bill_id or v_existing.amount_sen is distinct from p_amount_sen
       or v_existing.method_id is distinct from p_method_id then
      return jsonb_build_object('ok', false, 'error',
        format('This refund was already recorded as RM %s by %s — close and reopen to refund more',
               to_char(v_existing.amount_sen / 100.0, 'FM999999990.00'), v_existing.method_name));
    end if;
    return jsonb_build_object('ok', true, 'amountSen', v_existing.amount_sen,
                              'refundedSen', (select refunded_sen from bills where id = p_bill_id),
                              'slipQueued', v_existing.slip_queued);
  end if;
  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  select * into v_existing from refunds where id = p_refund_id;        -- the same refund won while we waited
  if found then
    if v_existing.bill_id <> p_bill_id or v_existing.amount_sen is distinct from p_amount_sen
       or v_existing.method_id is distinct from p_method_id then
      return jsonb_build_object('ok', false, 'error',
        format('This refund was already recorded as RM %s by %s — close and reopen to refund more',
               to_char(v_existing.amount_sen / 100.0, 'FM999999990.00'), v_existing.method_name));
    end if;
    return jsonb_build_object('ok', true, 'amountSen', v_existing.amount_sen, 'refundedSen', v_bill.refunded_sen,
                              'slipQueued', v_existing.slip_queued);
  end if;
  -- 4a: a refund belongs to the shift open NOW (a refund of an old bill too); FOR SHARE as in checkout_bill
  select id into v_shift from pos_shifts where branch_id = v_branch and status = 'open' for share;
  if not found then raise exception 'Open the shift first'; end if;
  if v_bill.status <> 'paid' then raise exception 'Only a paid bill can be refunded'; end if;
  if p_amount_sen is null or p_amount_sen <= 0 then raise exception 'Invalid refund amount'; end if;
  if p_amount_sen > v_bill.total_sen - v_bill.refunded_sen then
    raise exception 'Refund is more than what is left on this bill (RM %)',
      to_char((v_bill.total_sen - v_bill.refunded_sen) / 100.0, 'FM999999990.00');
  end if;
  -- the original route: a method this bill was paid with, up to what it has left
  -- (the bill row is locked above, so two refunds of one bill cannot both pass)
  select p.method_name, p.kind into v_method_name, v_kind                 -- 4a: the kind too
    from payments p where p.bill_id = v_bill.id and p.method_id = p_method_id
   order by p.line_no limit 1;
  if not found then
    raise exception 'Refunds go back the way the bill was paid — choose one of its payment methods';
  end if;
  select coalesce(sum(p.amount_sen), 0)::integer into v_paid
    from payments p where p.bill_id = v_bill.id and p.method_id = p_method_id;
  select coalesce(sum(r.amount_sen), 0)::integer into v_back
    from refunds r where r.bill_id = v_bill.id and r.method_id = p_method_id;
  if p_amount_sen > v_paid - v_back then
    raise exception 'Refund is more than was paid by % on this bill (RM % left)',
      v_method_name, to_char(greatest(v_paid - v_back, 0) / 100.0, 'FM999999990.00');
  end if;
  v_reason := pos_check_reason(v_branch, 'refund', p_reason);
  v_err := pos_check_approver(v_branch, p_approver_id, p_pin);
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  insert into refunds(id, bill_id, branch_id, amount_sen, method_id, method_name, reason, approved_by, created_by,
                      shift_id, kind)                                                   -- 4a
  values (p_refund_id, v_bill.id, v_branch, p_amount_sen, p_method_id, v_method_name, v_reason, p_approver_id, pos_actor(),
          v_shift, v_kind);                                                             -- 4a
  update bills set refunded_sen = refunded_sen + p_amount_sen where id = v_bill.id;
  select s.receipt_route into v_route from branch_pos_settings s where s.branch_id = v_branch;
  if v_route is not null then
    insert into print_jobs(branch_id, route, kind, payload)
    values (v_branch, v_route, 'receipt', pos_refund_slip_payload(p_refund_id));
    update refunds set slip_queued = true where id = p_refund_id;
  end if;
  return jsonb_build_object('ok', true, 'amountSen', p_amount_sen, 'refundedSen', v_bill.refunded_sen + p_amount_sen,
                            'slipQueued', v_route is not null);
end $function$;

-- void_bill: re-created (see the header)
CREATE OR REPLACE FUNCTION void_bill(p_bill_id uuid, p_reason text, p_approver_id uuid, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch uuid := pos_my_branch();
  v_bill   bills;
  v_reason text;
  v_err    text;
  v_ids    uuid[];
begin
  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  if v_bill.status = 'voided' then return jsonb_build_object('ok', true); end if;      -- a retry
  if v_bill.status = 'paid' then raise exception 'This bill is paid — refund it instead'; end if;
  if v_bill.status <> 'open' then raise exception 'This bill was merged into another bill'; end if;
  select coalesce(array_agg(id), '{}') into v_ids from order_items where bill_id = v_bill.id and voided_at is null;
  if cardinality(v_ids) > 0 then
    v_reason := pos_check_reason(v_branch, 'void_bill', p_reason);
    v_err := pos_check_approver(v_branch, p_approver_id, p_pin);
    if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
    update order_items
       set voided_at = now(), voided_by = pos_actor(), voided_device_id = pos_current_device(), void_reason = v_reason, void_approved_by = p_approver_id
     where id = any (v_ids);
  else
    v_reason := nullif(trim(left(p_reason, 200)), '');
  end if;
  update bills
     set status = 'voided', closed_at = now(), closed_by = pos_actor(), closed_device_id = pos_current_device(), void_reason = v_reason,
         void_approved_by = case when cardinality(v_ids) > 0 then p_approver_id end
   where id = v_bill.id;
  perform pos_queue_void_tickets(v_ids);
  return jsonb_build_object('ok', true);
end $function$;

-- void_order_item: re-created (see the header)
CREATE OR REPLACE FUNCTION void_order_item(p_item_id uuid, p_reason text, p_approver_id uuid, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch uuid := pos_my_branch();
  v_item   order_items;
  v_bill   bills;
  v_reason text;
  v_err    text;
begin
  select * into v_item from order_items where id = p_item_id;
  if not found then raise exception 'Item not found'; end if;
  select * into v_bill from bills where id = v_item.bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Item not found'; end if;
  select * into v_item from order_items where id = p_item_id;            -- again, under the bill lock
  if v_item.bill_id <> v_bill.id then raise exception 'The bill just changed — please try again'; end if;
  if v_item.voided_at is not null then return jsonb_build_object('ok', true); end if;   -- a retry
  if v_bill.status <> 'open' then
    raise exception 'Only items on an open bill can be voided — refund a paid bill instead';
  end if;
  v_reason := pos_check_reason(v_branch, 'void_item', p_reason);
  v_err := pos_check_approver(v_branch, p_approver_id, p_pin);
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  update order_items
     set voided_at = now(), voided_by = pos_actor(), voided_device_id = pos_current_device(), void_reason = v_reason, void_approved_by = p_approver_id
   where id = p_item_id;
  update bills set updated_at = now() where id = v_bill.id;   -- H3: a bills event, so other iPads hear of it at once
  perform pos_queue_void_tickets(array[p_item_id]);
  return jsonb_build_object('ok', true);
end $function$;

-- pos_pin_attempt: re-created (see the header)
CREATE OR REPLACE FUNCTION pos_pin_attempt(p_staff_id uuid, p_pin text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_caller uuid := pos_actor();
  v_hash   text;
  v_try    pos_pin_attempts;
  v_n      integer;
begin
  if v_caller is null then raise exception 'Sign in required'; end if;
  select pin_hash into v_hash from staff_pos_pins where staff_id = p_staff_id;
  if not found then
    return 'No POS PIN is set for this person yet — they set one under My PIN';
  end if;
  insert into pos_pin_attempts(approver_id, caller_id) values (p_staff_id, v_caller)
  on conflict (approver_id, caller_id) do nothing;
  select * into v_try from pos_pin_attempts where approver_id = p_staff_id and caller_id = v_caller for update;
  if v_try.locked_until is not null and v_try.locked_until > now() then
    return 'Too many wrong PINs — try again after ' || to_char(v_try.locked_until at time zone 'Asia/Kuala_Lumpur', 'HH24:MI');
  end if;
  if p_pin is not null and p_pin ~ '^\d{4,6}$' and v_hash = extensions.crypt(p_pin, v_hash) then
    update pos_pin_attempts set failed_attempts = 0, locked_until = null, updated_at = now()
     where approver_id = p_staff_id and caller_id = v_caller;
    return null;
  end if;
  v_n := case when v_try.updated_at < now() - interval '1 day' then 0 else v_try.failed_attempts end + 1;
  if v_n >= 5 then
    update pos_pin_attempts set failed_attempts = 0, locked_until = now() + interval '10 minutes', updated_at = now()
     where approver_id = p_staff_id and caller_id = v_caller;
    return 'Wrong PIN — locked for 10 minutes after 5 wrong tries';
  end if;
  update pos_pin_attempts set failed_attempts = v_n, locked_until = null, updated_at = now()
   where approver_id = p_staff_id and caller_id = v_caller;
  return format('Wrong PIN — %s %s left', 5 - v_n, case when 5 - v_n = 1 then 'try' else 'tries' end);
end $function$;

-- claim_print_job: re-created (see the header)
CREATE OR REPLACE FUNCTION claim_print_job(p_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch uuid := pos_print_branch();
begin
  update print_jobs set status = 'printing', attempts = attempts + 1, claimed_at = now()
   where id = p_id and status = 'pending' and branch_id = v_branch;
  return found;
end $function$;

-- finish_print_job: re-created (see the header)
CREATE OR REPLACE FUNCTION finish_print_job(p_id uuid, p_ok boolean, p_error text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch uuid := pos_print_branch();
begin
  update print_jobs
     set status     = case when p_ok then 'printed' else 'failed' end,
         printed_at = case when p_ok then now() else null end,
         last_error = case when p_ok then null else p_error end
   where id = p_id and status = 'printing' and branch_id = v_branch;
end $function$;

-- requeue_print_job: re-created (see the header)
CREATE OR REPLACE FUNCTION requeue_print_job(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch uuid := pos_print_branch();
begin
  update print_jobs set status = 'pending'
   where id = p_id and branch_id = v_branch
     and (status = 'failed' or (status = 'printing' and claimed_at < now() - interval '2 minutes'));
end $function$;

-- insert_test_print: re-created (see the header)
CREATE OR REPLACE FUNCTION insert_test_print(p_route text, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_branch uuid; v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if p_branch_id is null then                                                                -- O7
    v_branch := pos_print_branch();                                        -- the printing tablet or agent (a staff login: home)
  elsif pos_manages_outlet(p_branch_id) then
    v_branch := p_branch_id;
  else
    raise exception 'This outlet is not one of yours';
  end if;
  if not exists (select 1 from print_routes where branch_id = v_branch and name = p_route) then
    raise exception 'No printer is set for route %', p_route;
  end if;
  insert into print_jobs(branch_id, route, kind, payload)
  values (v_branch, p_route, 'ticket', jsonb_build_object(
    'kind', 'ticket', 'route', p_route, 'tableLabel', 'TEST', 'orderNo', 'TEST01', 'source', 'test',
    'placedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'lines', jsonb_build_array(jsonb_build_object('qty', 1, 'name', 'Test print — ' || p_route, 'note', null, 'mods', '[]'::jsonb))))
  returning id into v_id;
  return v_id;
end $function$;

notify pgrst, 'reload schema';
select 'pos device till applied' as result;
```


- [ ] **Step 3: Write the self-check**

Create `supabase/migration-2026-10-29-pos-device-till-verify.sql`:

```sql
-- Self-check for the POS till on device sessions. Run on craft-os-dev after
-- migration-2026-10-29-pos-device-till.sql. Everything is rolled back. Success = a result row
-- "VERIFY OK". Sections follow the migration: A schema and grants; T1 the till on a device
-- session (actor = the session's staff member, the device recorded); T5 the offline queue;
-- T2 printing; T3 reads; T6 unpairing from the tablet; the C1 transition for staff logins.
-- The other POS verify scripts keep passing as staff logins through the transition.
begin;

-- expect_error(sql, message, label): runs sql and insists it raises exactly message.
create function pg_temp.expect_error(p_sql text, p_message text, p_label text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FAIL %: no error (expected "%")', p_label, p_message using errcode = 'assert_failure';
exception when raise_exception then
  if sqlerrm is distinct from p_message then
    raise exception 'FAIL %: got "%" (expected "%")', p_label, sqlerrm, p_message;
  end if;
end $$;

-- act(user id): the next calls run as this signed-in user (staff or device)
create function pg_temp.act(p_user uuid) returns void
language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_cash  uuid := 'eeeeeeee-0000-0000-0000-000000000091';   -- cashier of VERIFY T A
  v_sup   uuid := 'eeeeeeee-0000-0000-0000-000000000092';   -- supervisor of VERIFY T A
  v_mgr   uuid := 'eeeeeeee-0000-0000-0000-000000000093';   -- manager of VERIFY T A (branch-only)
  v_far   uuid := 'eeeeeeee-0000-0000-0000-000000000094';   -- cashier of VERIFY T B
  v_dev1  uuid := 'eeeeeeee-0000-0000-0000-0000000000e1';   -- the printing tablet of A
  v_dev2  uuid := 'eeeeeeee-0000-0000-0000-0000000000e2';   -- another tablet of A
  v_devb  uuid := 'eeeeeeee-0000-0000-0000-0000000000e3';   -- a tablet of B
  v_agent uuid := 'eeeeeeee-0000-0000-0000-0000000000e4';   -- the print agent of A
  v_a uuid; v_b uuid; v_ta uuid; v_ta2 uuid; v_tb uuid;
  v_cat uuid; v_catalog uuid; v_plate uuid; v_plate_v uuid; v_card uuid;
  v_bill uuid; v_bill2 uuid; v_billb uuid; v_order uuid; v_item uuid; v_shift uuid; v_job_a uuid; v_job_b uuid; v_job_t uuid;
  v_res jsonb; v_items jsonb; n integer; r record; v_ok boolean;
begin
  -- ── A. schema and grants ──────────────────────────────────────────────────
  for r in select t, c from (values ('orders', 'device_id'), ('payments', 'device_id'), ('refunds', 'device_id'),
                                    ('pos_cash_moves', 'device_id'), ('pos_shifts', 'opened_device_id'), ('pos_shifts', 'closed_device_id'),
                                    ('bills', 'closed_device_id'), ('order_items', 'voided_device_id')) as x(t, c) loop
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = r.t and column_name = r.c) then
      raise exception 'FAIL T4 schema: %.% is missing', r.t, r.c;
    end if;
  end loop;
  for r in select f from unnest(array['pos_current_device()', 'pos_actor()', 'pos_my_branch()', 'pos_ctx()', 'pos_print_branch()',
                                      'pos_revoke_device(uuid,uuid)']) as f loop
    if has_function_privilege('authenticated', r.f, 'execute') or has_function_privilege('anon', r.f, 'execute') then
      raise exception 'FAIL grants: % is internal but callable', r.f;
    end if;
  end loop;
  for r in select f from unnest(array['pos_unpair_this_device()', 'pos_readable_branches()',
                                      'place_counter_order(uuid,text,integer,jsonb,uuid,uuid,uuid)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') then raise exception 'FAIL grants: anon can call %', r.f; end if;
    if not has_function_privilege('authenticated', r.f, 'execute') then raise exception 'FAIL grants: clients cannot call %', r.f; end if;
  end loop;
  if to_regprocedure('place_counter_order(uuid,text,integer,jsonb,uuid,uuid)') is not null then
    raise exception 'FAIL T5: the old place_counter_order is still there';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and policyname in ('pos_read', 'dining_tables_update')
              and (qual = 'true' or with_check = 'true')) or exists (select 1 from pg_policies where policyname = 'print_jobs_update') then
    raise exception 'FAIL T3: an open read or update policy is left';
  end if;
  for r in select p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'public' and p.proname in ('checkout_bill', 'close_shift', 'merge_bills', 'open_shift', 'record_cash_move',
                                                         'refund_bill', 'void_bill', 'void_order_item', 'pos_pin_attempt', 'place_counter_order')
              and pg_get_functiondef(p.oid) like '%auth.uid()%' loop
    raise exception 'FAIL T1: % still records auth.uid() — re-run migration-2026-10-29-pos-device-till.sql', r.proname;
  end loop;

  -- ── B. fixture: outlets A and B, a product, a card method, staff with PINs, four devices ──
  update system_role_permissions set permissions = permissions - 'pos_login' - 'all_branches' - 'access_settings' - 'pos_supervise'
   where true;                                                                         -- code defaults
  update system_role_permissions set permissions = permissions || '{"all_branches": false}' where system_role = 'manager';
  insert into branches(name, address) values ('VERIFY T A', 'a') returning id into v_a;
  insert into branches(name, address) values ('VERIFY T B', 'b') returning id into v_b;
  insert into dining_tables(branch_id, label, sort_order) values (v_a, 'TA1', 1) returning id into v_ta;
  insert into dining_tables(branch_id, label, sort_order) values (v_a, 'TA2', 2) returning id into v_ta2;
  insert into dining_tables(branch_id, label, sort_order) values (v_b, 'TB1', 1) returning id into v_tb;
  insert into menu_categories(name, sort_order) values ('VERIFY T FOOD', 900) returning id into v_cat;
  insert into menu_products(name, category_id, sst_rate_bp) values ('Verify T Plate', v_cat, 0) returning id into v_plate;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_plate, '', 'Regular', 1000) returning id into v_plate_v;
  insert into menu_catalogs(name, sort_order) values ('VERIFY T CATALOG', 900) returning id into v_catalog;
  insert into catalog_products(catalog_id, product_id, availability) values (v_catalog, v_plate, 'all');
  insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (v_catalog, v_plate_v, 1000);
  insert into branch_catalogs(branch_id, role, catalog_id) values
    (v_a, 'dine_in', v_catalog), (v_a, 'takeaway', v_catalog), (v_a, 'qr', v_catalog),
    (v_b, 'dine_in', v_catalog), (v_b, 'takeaway', v_catalog), (v_b, 'qr', v_catalog);
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_a, 'T Card', 'card', 1) returning id into v_card;
  v_items := jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_v));
  update staff set branch_id = v_a where id = v_owner;
  perform pg_temp.act(v_owner);
  insert into auth.users (id) values (v_cash), (v_sup), (v_mgr), (v_far), (v_dev1), (v_dev2), (v_devb), (v_agent);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_cash, 'Verify T Cashier',    'trainee', true, current_date, 'staff', v_a),
    (v_sup,  'Verify T Supervisor', 'trainee', true, current_date, 'staff', v_a),
    (v_mgr,  'Verify T Manager',    'trainee', true, current_date, 'staff', v_a),
    (v_far,  'Verify T Far',        'trainee', true, current_date, 'staff', v_b);
  update staff set system_role = 'supervisor' where id = v_sup;
  update staff set system_role = 'manager' where id = v_mgr;
  for r in select * from (values (v_cash, '1111'), (v_sup, '2222'), (v_mgr, '3333'), (v_far, '4444')) as x(id, pin) loop
    perform pg_temp.act(r.id);
    if not coalesce((set_my_pos_pin(r.pin, null)->>'ok')::boolean, false) then raise exception 'FAIL fixture: PIN of %', r.id; end if;
  end loop;
  insert into pos_devices(id, branch_id, kind, name, platform, prints, approved_by) values
    (v_dev1, v_a, 'pos', 'T Counter', 'ipad', true, v_owner),
    (v_dev2, v_a, 'pos', 'T Floor', 'ipad', false, v_owner),
    (v_devb, v_b, 'pos', 'T B Counter', 'android', true, v_owner),
    (v_agent, v_a, 'print_agent', 'T Mac', 'agent', false, v_owner);

  -- ── T1. the till on a device session ──────────────────────────────────────
  perform pg_temp.act(v_dev1);
  perform pg_temp.expect_error(format('select open_table(%L, 2)', v_ta), 'no_session', 'T1 no session yet');
  v_res := pos_start_session(v_cash, '1111');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: cashier sign-in: %', v_res; end if;
  v_bill := open_table(v_ta, 2);
  if (select branch_id from bills where id = v_bill) is distinct from v_a then raise exception 'FAIL T1: the bill is not at the device''s outlet'; end if;
  v_order := place_counter_order(v_ta, 'dine_in', 2, v_items, gen_random_uuid());
  if (select placed_by from orders where id = v_order) is distinct from v_cash
     or (select device_id from orders where id = v_order) is distinct from v_dev1 then
    raise exception 'FAIL T1: the order (placed by the session''s staff member, on this device)';
  end if;
  v_res := open_shift(10000);
  v_shift := (v_res->'shift'->>'id')::uuid;
  if (select opened_by from pos_shifts where id = v_shift) is distinct from v_cash
     or (select opened_device_id from pos_shifts where id = v_shift) is distinct from v_dev1 then
    raise exception 'FAIL T1: the shift opening: %', v_res;
  end if;
  v_res := pos_current_shift();                                                       -- a STABLE RPC on a device
  if (v_res->'shift'->>'id')::uuid is distinct from v_shift then raise exception 'FAIL T1: pos_current_shift on a device: %', v_res; end if;
  v_res := record_cash_move(gen_random_uuid(), 'pay_in', 500, 'Change top-up', null, null);
  if not coalesce((v_res->>'ok')::boolean, false)
     or not exists (select 1 from pos_cash_moves where shift_id = v_shift and created_by = v_cash and device_id = v_dev1) then
    raise exception 'FAIL T1: the cash move: %', v_res;
  end if;
  v_res := checkout_bill(v_bill, jsonb_build_array(jsonb_build_object('methodId', v_card, 'amountSen', (pos_bill_totals(v_bill)->>'totalSen')::int)),
                         gen_random_uuid());
  if (v_res->>'billId')::uuid is distinct from v_bill then raise exception 'FAIL T1 checkout: %', v_res; end if;
  if (select closed_by from bills where id = v_bill) is distinct from v_cash
     or (select closed_device_id from bills where id = v_bill) is distinct from v_dev1
     or not exists (select 1 from payments where bill_id = v_bill and taken_by = v_cash and device_id = v_dev1) then
    raise exception 'FAIL T1: the checkout (closed by, closing device, payment device)';
  end if;
  -- a void approved by the supervisor; a wrong approver PIN counts against the session's staff member
  v_bill2 := open_table(v_ta2, 1);
  v_order := place_counter_order(v_ta2, 'dine_in', 1, v_items, gen_random_uuid());
  select id into v_item from order_items where order_id = v_order;
  v_res := void_order_item(v_item, 'Wrong item keyed', v_sup, '0000');
  if coalesce((v_res->>'ok')::boolean, true) then raise exception 'FAIL fixture: a wrong approver PIN passed: %', v_res; end if;
  if not exists (select 1 from pos_pin_attempts where approver_id = v_sup and caller_id = v_cash) then
    raise exception 'FAIL T1: the approval lockout does not count against the session''s staff member';
  end if;
  v_res := void_order_item(v_item, 'Wrong item keyed', v_sup, '2222');
  if not coalesce((v_res->>'ok')::boolean, false)
     or (select voided_by from order_items where id = v_item) is distinct from v_cash
     or (select voided_device_id from order_items where id = v_item) is distinct from v_dev1
     or (select void_approved_by from order_items where id = v_item) is distinct from v_sup then
    raise exception 'FAIL T1: the void (by the session''s staff member, on this device, approved by the supervisor): %', v_res;
  end if;
  v_order := place_counter_order(v_ta2, 'dine_in', 1, v_items, gen_random_uuid());     -- a live item, then void the whole bill
  v_res := void_bill(v_bill2, 'Customer left', v_sup, '2222');
  if not coalesce((v_res->>'ok')::boolean, false)
     or (select status || '|' || closed_by || '|' || closed_device_id from bills where id = v_bill2)
          is distinct from 'voided|' || v_cash || '|' || v_dev1
     or (select voided_device_id from order_items where order_id = v_order) is distinct from v_dev1 then
    raise exception 'FAIL T1: voiding the bill (by the session''s staff member, on this device): %', v_res;
  end if;
  v_res := close_shift(v_shift, 10500, null, null, null, null);
  if (select status from pos_shifts where id = v_shift) is distinct from 'closed'
     or (select closed_by from pos_shifts where id = v_shift) is distinct from v_cash
     or (select closed_device_id from pos_shifts where id = v_shift) is distinct from v_dev1 then
    raise exception 'FAIL T1: closing the shift: %', v_res;
  end if;
  -- another outlet's tablet cannot touch this outlet's bill
  perform pg_temp.act(v_devb);
  v_res := pos_start_session(v_far, '4444');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: far sign-in: %', v_res; end if;
  v_billb := open_table(v_tb, 2);
  v_ok := false;
  begin
    perform open_table(v_ta2, 2);
  exception when raise_exception then v_ok := true;
  end;
  if not v_ok then raise exception 'FAIL T1: a tablet of B opened a table of A'; end if;

  -- ── T5. the offline queue ─────────────────────────────────────────────────
  perform pg_temp.act(v_dev1);
  v_order := place_counter_order(null, 'takeaway', null, v_items, gen_random_uuid(), null, v_sup);    -- queued by the supervisor
  if (select placed_by from orders where id = v_order) is distinct from v_sup then raise exception 'FAIL T5: the queued order keeps who took it'; end if;
  v_order := place_counter_order(null, 'takeaway', null, v_items, gen_random_uuid(), null, v_far);    -- may not work here any more
  if (select placed_by from orders where id = v_order) is distinct from v_cash then raise exception 'FAIL T5: a queued order by someone not allowed here'; end if;

  -- ── T2. printing ──────────────────────────────────────────────────────────
  insert into print_jobs(branch_id, route, kind, payload) values (v_a, 'Bar', 'ticket', '{}'::jsonb) returning id into v_job_a;
  insert into print_jobs(branch_id, route, kind, payload) values (v_b, 'Bar', 'ticket', '{}'::jsonb) returning id into v_job_b;
  perform pg_temp.act(v_dev2);
  perform pg_temp.expect_error(format('select claim_print_job(%L)', v_job_a), 'not_printing_tablet', 'T2 a tablet that does not print');
  perform pg_temp.act(v_dev1);
  perform pos_end_session('locked');                                                  -- the printing tablet prints while locked
  if not claim_print_job(v_job_a) then raise exception 'FAIL T2: the printing tablet claims its outlet''s job'; end if;
  if claim_print_job(v_job_b) then raise exception 'FAIL T2: the printing tablet claimed another outlet''s job'; end if;
  perform finish_print_job(v_job_a, false, 'Paper out');                             -- finish and requeue run on the device too
  perform requeue_print_job(v_job_a);
  if (select status from print_jobs where id = v_job_a) is distinct from 'pending' then raise exception 'FAIL T2: finish + requeue on the printing tablet'; end if;
  perform pg_temp.act(v_agent);
  if not claim_print_job(v_job_a) then raise exception 'FAIL T2: the print agent claims its outlet''s job'; end if;
  insert into print_routes(branch_id, name, kind, address) values (v_a, 'Bar', 'agent', '127.0.0.1:9100');
  perform pg_temp.act(v_dev1);
  v_job_t := insert_test_print('Bar');
  if (select branch_id from print_jobs where id = v_job_t) is distinct from v_a then
    raise exception 'FAIL T2: a test print from the printing tablet';
  end if;
  perform pg_temp.act(v_dev2);
  perform pg_temp.expect_error('select insert_test_print(''Bar'')', 'not_printing_tablet', 'T2 a test print from a tablet that does not print');

  -- ── T3. reads ─────────────────────────────────────────────────────────────
  perform pg_temp.act(v_dev1);
  if pos_caller_branch() is distinct from v_a then raise exception 'FAIL T3: pos_caller_branch of a device'; end if;
  set local role authenticated;
  select count(*) into n from bills where id in (v_bill, v_bill2, v_billb);
  if n is distinct from 2 then raise exception 'FAIL T3: a tablet of A reads % of A''s 2 bills (and none of B''s)', n; end if;
  select count(*) into n from order_items where bill_id = v_billb;
  if n is distinct from 0 then raise exception 'FAIL T3: a tablet of A reads B''s order items'; end if;
  select count(*) into n from print_jobs where id = v_job_b;
  if n is distinct from 0 then raise exception 'FAIL T3: a tablet of A reads B''s print jobs'; end if;
  reset role;
  perform pg_temp.act(v_devb);
  set local role authenticated;
  select count(*) into n from bills where id in (v_bill, v_bill2, v_billb);
  reset role;
  if n is distinct from 1 then raise exception 'FAIL T3: a tablet of B reads % bills (expected only its own)', n; end if;
  perform pg_temp.act(v_far);                                                         -- a staff login: its scope
  set local role authenticated;
  select count(*) into n from bills where id in (v_bill, v_bill2, v_billb);
  reset role;
  if n is distinct from 1 then raise exception 'FAIL T3: staff of B read % bills (expected 1)', n; end if;
  perform pg_temp.act(v_owner);                                                       -- HQ: every outlet
  set local role authenticated;
  select count(*) into n from bills where id in (v_bill, v_bill2, v_billb);
  reset role;
  if n is distinct from 3 then raise exception 'FAIL T3: HQ reads % of 3 bills', n; end if;

  -- ── T6. unpairing from the tablet ─────────────────────────────────────────
  perform pg_temp.act(v_dev2);
  v_res := pos_start_session(v_cash, '1111');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: sign-in on the second tablet'; end if;
  perform pg_temp.expect_error('select pos_unpair_this_device()', 'Only a manager of this outlet can unpair this device', 'T6 a cashier');
  v_res := pos_start_session(v_mgr, '3333');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: manager sign-in: %', v_res; end if;
  perform pos_unpair_this_device();
  if (select revoked_by from pos_devices where id = v_dev2) is distinct from v_mgr
     or coalesce((select not isfinite(banned_until) or banned_until < now() + interval '99 years' from auth.users where id = v_dev2), true)
     or exists (select 1 from pos_staff_sessions where device_id = v_dev2 and ended_at is null) then
    raise exception 'FAIL T6: unpairing from the tablet (revoked by the manager, banned, session ended)';
  end if;
  perform pg_temp.expect_error(format('select open_table(%L, 2)', v_ta2), 'device_unpaired', 'T6 the unpaired tablet');
  set local role authenticated;
  select count(*) into n from bills where branch_id = v_a;
  reset role;
  if n is distinct from 0 then raise exception 'FAIL T3: an unpaired tablet still reads its outlet'; end if;

  -- ── the C1 transition: a staff login still runs the till at its home branch ──
  perform pg_temp.act(v_cash);
  perform pg_temp.expect_error('select pos_unpair_this_device()', 'device_unpaired', 'T6 a staff login');
  v_bill2 := open_table(v_ta2, 3);
  if (select branch_id from bills where id = v_bill2) is distinct from v_a then raise exception 'FAIL transition: a staff login''s table'; end if;
  v_order := place_counter_order(v_ta2, 'dine_in', 3, v_items, gen_random_uuid());
  if (select placed_by from orders where id = v_order) is distinct from v_cash
     or (select device_id from orders where id = v_order) is not null then
    raise exception 'FAIL transition: a staff login''s order (by them, no device)';
  end if;

  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;
rollback;
```


- [ ] **Step 4: Bring three regression scripts up to date**

**`supabase/migration-2026-10-23-pos-ordering-verify.sql`:**

Replacement 1 in `supabase/migration-2026-10-23-pos-ordering-verify.sql` — replace:

```sql
'place_counter_order(uuid,text,integer,jsonb,uuid,uuid)','claim_print_job(uuid)',
```

with:

```sql
'place_counter_order(uuid,text,integer,jsonb,uuid,uuid,uuid)','claim_print_job(uuid)',
```

**`supabase/migration-2026-10-24-pos-catalogs-verify.sql`:**

Replacement 1 in `supabase/migration-2026-10-24-pos-catalogs-verify.sql` — replace:

```sql
'place_counter_order(uuid,text,integer,jsonb,uuid,uuid)', 'save_branch_catalogs(uuid,jsonb)',
```

with:

```sql
'place_counter_order(uuid,text,integer,jsonb,uuid,uuid,uuid)', 'save_branch_catalogs(uuid,jsonb)',
```

**`supabase/migration-2026-10-29-pos-devices-verify.sql`:**

Replacement 1 in `supabase/migration-2026-10-29-pos-devices-verify.sql` — replace:

```sql
  perform pg_temp.act(v_dev2);
  if pos_print_branch() is distinct from v_a then raise exception 'FAIL D4: a locked tablet still prints'; end if;
```

with:

```sql
  perform pg_temp.act(v_dev5);                                                          -- the printing tablet, no session
  if pos_print_branch() is distinct from v_a then raise exception 'FAIL D4: a locked printing tablet still prints'; end if;
  perform pg_temp.act(v_dev2);                                                          -- since migration-2026-10-29-pos-device-till.sql
  perform pg_temp.expect_error('select pos_print_branch()', 'not_printing_tablet', 'D4 a tablet that is not the printing tablet');
```


- [ ] **Step 5: Run the tests and commit**

Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts && npx vitest run && npx tsc -b`
Expected: all pass; 131 files / 1077 tests; tsc silent.

```bash
git add supabase/migration-2026-10-29-pos-device-till.sql supabase/migration-2026-10-29-pos-device-till-verify.sql \
  supabase/migration-2026-10-23-pos-ordering-verify.sql supabase/migration-2026-10-24-pos-catalogs-verify.sql \
  supabase/migration-2026-10-29-pos-devices-verify.sql src/features/pos/sqlSafeUpdate.test.ts
git commit -m "feat(pos): the till runs on device sessions — pos_ctx outlet and actor, printing tablet only, scoped reads, device audit, offline staffId, unpair from the tablet (SQL)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Apply on dev and verify (controller; the implementer does not touch the database)**

Through the Management API on `egznnbjmicebbhwasloy`:
1. `migration-2026-10-29-pos-device-till.sql` → `pos device till applied`.
2. `migration-2026-10-29-pos-device-till-verify.sql` → `VERIFY OK`.
3. All eleven older POS verify scripts → each `VERIFY OK`: menu, ordering, catalogs, menu editor, slots and photos, checkout, shifts, hardening, front end, outlets, devices.

If one fails, stop and report.

---

### Task 2: Browser check of today's /pos on dev, and push (controller)

- [ ] **Step 1:** In the `pos-menu-dev` preview (port 5174, dev database), signed in as the dev owner (a staff login, running the till through the transition):
  1. `/pos` loads its tables, menu and bills.
  2. Open a table, send an order, and pay it by card.
  3. The bill shows in Transaction.
  4. The print host claims the tickets, as the staff login's home branch.
  5. `/pos/settings` and `/pos/devices` still load.
  6. The console shows no errors.
- [ ] **Step 2:** Read-only, on dev: the new order has `device_id` null (staff login) and `placed_by` = the owner.
- [ ] **Step 3:** `git push origin feature/pos-demo`.

## Open points (not in this plan)

- **C2, the POS app,** gets its own plan once C1 is live on dev. Its scope is listed under "Where this sits".
- **C3** removes the transition, adds the `/pos` notice, and moves the older verify scripts onto devices. It runs after C2 is checked on an iPad (Safari) and an Android tablet (Chrome), and after D.
- **From Sub-plan B's final review, for C2:**
  - a lost approved reply leaves a ghost device that may hold the printing role;
  - Supabase Auth's session settings must not log tablets out;
  - refresh after a long offline period.
- **Prod:**
  - The order is the POS chain → A → B → C1 → C2 → C3, with D before C3, all before the first prod deploy of the POS app.
  - Set Manager All Branches off on prod.
  - Deploy the activation function with `--no-verify-jwt`.
