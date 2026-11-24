# POS Print Agent Pairing (D) and the Device Switch-over (C3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The print agent pairs like a tablet and prints for the outlet it was approved for; then staff email logins lose the till (front-of-house runs only on activated devices) and Craft OS `/pos` points to the POS app.

**Architecture:** D: one small SQL file adds `pos_agent_whoami()` (a print agent cannot read `pos_devices`, which has no privileges for `authenticated`); `tools/print-agent` gets a pure `pairing.ts` (words, `.device.json` shape, poll steps, the pair loop and the agent start with injected side effects), a Node `activationClient.ts` for the Edge Function, a `deviceFile.ts` (0600, git-ignored), the `pair.ts` command, and `agent.ts` signs in from `.device.json` and takes its outlet from `pos_agent_whoami()`. C3: a second SQL file re-creates `pos_ctx`, `pos_print_branch` and `pos_session_branch` from their live text with the TRANSITION lines replaced (`-- X1` … `-- X3`), so every front-of-house RPC refuses a staff login with `device_unpaired`; its STOP guard refuses to run before the D file. Craft OS `/pos` becomes the notice page (with My PIN, the only place staff set their PIN).

**Tech Stack:** Supabase Postgres (plpgsql), Supabase Edge Function `pos-device-activation` (unchanged), Node 22 print agent (type stripping, `node --env-file`), React 19 + TypeScript + Vite, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-22-pos-agent-pairing-switchover-design.md` (owner approved 2026-11-22; binding). Parent: `docs/superpowers/specs/2026-10-29-pos-devices-outlets-design.md` (§2, §4, Amendments).

## Spec conflicts

Places where the code makes a spec point impossible or wrong as written. Each is resolved as stated; nothing else departs from the spec. Small ones — the controller may settle them.

1. **§2 "It finds its outlet from its own `pos_devices` row".** A device cannot read that row: `pos_devices` has RLS on and every privilege revoked from `authenticated` (migration-2026-10-29-pos-devices.sql D1, "functions only"), and `pos_whoami()` goes through `pos_ctx()`, which refuses a print agent (`kind <> 'pos'` → `device_unpaired`). **Resolution (the D server gap):** a new RPC `pos_agent_whoami()` → `{ deviceId, deviceName, outletId, outletName }` for an active print-agent device, `device_unpaired` for anything else; it also stamps `last_seen_at` (the agent calls it at start and every 60 s, so Devices shows the agent as seen). It ships in its own file `migration-2026-11-22-pos-agent-pairing.sql`, so agents can pair before the C3 SQL runs.
2. **§2 "the `.env` holds only `SUPABASE_URL` and `SUPABASE_ANON_KEY` now".** The agent still reads two printing settings from `.env`: `TICKET_COLS` (48 on the ZyWell ZY301) and `MAX_AGE_MIN`. **Resolution:** `.env` holds no login and no `BRANCH_ID`; `TICKET_COLS` and `MAX_AGE_MIN` stay as optional printing settings, marked optional in `.env.example`.
3. **§3 "Craft OS `/pos` shows The POS has moved to its own app".** `/pos` today also carries **My PIN** (the till's staff panel, `PosPage` → `PosTill myPin`) — the only place in Craft OS where staff set their POS PIN, which the POS app's sign-in needs ("Set a PIN in Craft OS first"). Replacing the till with a bare notice would leave nobody able to set a PIN. **Resolution:** the notice page keeps a `My PIN` button (the existing `MyPinDialog`); the nav entry stays `Register` → `/pos`; the POS Settings Approvers text that says "on the POS" now says where: `Each sets a PIN in Craft OS under POS → Register → My PIN.` (and the clear confirm likewise).
4. **§3 C3 must-do "move the older verify scripts' till calls onto a device + session fixture"** (device-till plan, Open points). Each verify script runs right after its own migration in the rollout chain (readiness §4), before C3; moving their till calls onto devices would make them fail at that point (the device path did not exist before C1), and the pre-C1 files (menu … outlets) run on a database with no `pos_devices`. **Resolution:** left as they are, with the reason in the C3 file header and readiness §4: after the C3 SQL, the verifies that run the till as a staff login no longer pass — the pre-device ones (`menu`, `ordering`, `catalogs`, `checkout`, `menu-editor`, `shifts`, `slots-photos`, `hardening`, `frontend`, `outlets`), `menu-picks` (all staff logins), `device-till`'s "C1 transition" block and `qr-table-cart` L2/L3. The C3 verify takes over the staff-login checks (refused) and re-checks the device path; the device-fixture verifies (`pos-app`, `discounts`, `split-bill`, `bill-parts`, `reports`, `receipt-numbers`, `feedme-habits`, `agent-pairing`) keep passing and are re-run after C3 (Task 6).

## Spec notes (readings taken where the spec is silent)

1. **The refusal a staff login gets** is `device_unpaired` from every front-of-house RPC (all go through `pos_ctx()` / `pos_my_branch()` / `pos_actor()`) and from the three print RPCs (`pos_print_branch()`); no login at all gets the same (it was `Sign in required` through the transition). The POS app already maps `device_unpaired` (`src/features/pos/deviceErrors.ts`); Craft OS no longer calls those RPCs.
2. **What stays for staff logins (checked function by function, newest definitions):** `save_receipt_settings`, `save_shift_settings`, `save_branch_catalogs`, `save_lock_settings`, `save_outlet`, `set_staff_outlet`, `my_outlets`, `pos_outlet_approvers`, `clear_pos_pin` (all `pos_manages_outlet` / `has_menu_cap` / `auth.uid()`), `set_my_pos_pin` (its `pos_pin_attempt` uses `auth.uid()` for a login with no device row), `insert_test_print(route, branch)` (the back-office path, `pos_manages_outlet`; only its no-outlet path uses `pos_print_branch`), the Devices RPCs, the reports (`pos_report_*`, outlet scope), the menu editor and slots RPCs (`has_menu_cap`), and the reads (`pos_readable_branches()` = `staff_outlet_scope` for a login). PosSettingsPage's own table writes pass `pos_manages_outlet` in `dining_tables_insert` / `dining_tables_update`. None of these change. `pos_caller_branch()` has no TRANSITION line and no live policy uses it; left as it is.
3. **What stops for staff logins:** the 39 front-of-house RPCs on `pos_ctx` (listed under "Where the live code is"), incl. `pos_approvers` (only the till's ApprovalDialog calls it) and the till's direct writes (`branch_menu_status_write`, `dining_tables_update` through `pos_session_branch()`, which is null for a login). No back-office screen calls any of them once `/pos` is the notice.
4. **Pair command details:** an existing `.device.json` prints `Already paired. Delete .device.json to pair again.` and exits 1 (nothing done); the name is the first argument, else the host name without `.local`, cut to 40 characters (the function's limit); a network failure while polling prints the error and keeps polling; an approval as POS (not Print agent) is not saved: `HQ approved this request as a POS tablet. Ask HQ to unpair it in Devices, then pair again and approve it as Print agent.` and exit 1; a spent request (`unknown`): `This request is no longer valid. Run the pair command again.`; rejected / expired use the parent spec's words `This request was rejected.` / `This request expired.` A failed save after approval prints `Could not save .device.json (<reason>). Ask HQ to unpair "<name>" in Devices and pair again.` — the password is never printed.
5. **Agent start and unpairing:** a sign-in that fails for want of a reply (`retryableSignIn` of `src/pos/activation.ts`) is not an unpairing: `Could not reach Supabase to sign in: <message>` and exit 1; any other refused sign-in (banned, wrong credentials) and a `device_unpaired` from `pos_agent_whoami`, `claim_print_job` or `finish_print_job`, and an Auth `SIGNED_OUT` (the refresh token of a banned device fails) print `This print agent was unpaired — run the pair command again.` and exit 1.
6. **The `/pos` fallback** when `VITE_POS_APP_URL` is unset or not an `http(s)` address: `Ask HQ for the POS app address.` (no link).
7. **C1 minor "read scope of agent devices covers all outlet bills (consider for D)"** — left: a print agent account lives on a computer at its own outlet, reads only that outlet (RLS), and narrowing it would split eight read policies by device kind. Recorded in progress.md.
8. **C1 minor "`pos_approvers` calls volatile `pos_my_branch` per staff row"** — left: one call per approval dialog over ~30 staff rows, and `pos_ctx` stamps at most every 30 s; re-creating it changes no behaviour C3 needs (it now refuses a staff login through `pos_my_branch()`).

## Where the live code is (newest definition wins)

| Function / object | Live in | This plan |
|---|---|---|
| `pos_ctx()` | migration-2026-10-29-pos-device-till.sql lines 82–120 (the 10-29 devices file's version at 363 is older) | re-created, X1 |
| `pos_print_branch()` | migration-2026-10-29-pos-device-till.sql lines 139–157 (devices file 390 older) | re-created, X2 |
| `pos_session_branch()` | migration-2026-10-29-pos-device-till.sql lines 172–184 | re-created, X3 |
| `pos_my_branch()`, `pos_actor()` | migration-2026-10-29-pos-device-till.sql lines 122–136 | untouched (follow `pos_ctx`) |
| `pos_readable_branches()`, `pos_caller_branch()`, `pos_current_device()` | migration-2026-10-29-pos-device-till.sql lines 160–193, 59–62 | untouched |
| `claim_print_job`, `requeue_print_job` | migration-2026-11-22-pos-receipt-numbers.sql lines 935–966 | untouched (call `pos_print_branch`) |
| `finish_print_job`, `insert_test_print(text, uuid)` | migration-2026-10-29-pos-device-till.sql lines 883–942 | untouched |
| `pos_pin_attempt` | migration-2026-10-29-pos-device-till.sql line 765 | untouched (a login: `auth.uid()`) |
| `set_my_pos_pin` | migration-2026-10-25-pos-hardening.sql line 582 | untouched |
| `pos_whoami()` | migration-2026-10-30-pos-app.sql line 20 | untouched |
| `pos_activation_request/poll/finish/unclaim`, `pos_decide_device_request`, `pos_devices_list`, `pos_unpair_device` (device-till 230), `pos_revoke_device` (device-till 220) | migration-2026-10-29-pos-devices.sql / device-till | untouched (a request with platform `agent` is approved as kind `print_agent` by DevicesPage's default, `src/features/pos/devices/DevicesPage.tsx:143`) |
| Read policies `pos_read` on `print_routes`, `print_jobs` (and the other branch tables) | migration-2026-10-29-pos-device-till.sql lines 195–208 | untouched: a print-agent device reads its own outlet; Realtime follows |
| `pos_devices` privileges | migration-2026-10-29-pos-devices.sql lines 104–110 (RLS on, all revoked) | untouched; `pos_agent_whoami()` is new (Spec conflict 1) |
| Front-of-house RPCs on the context (refuse a staff login after C3) | `checkout_bill`, `merge_bills`, `move_bill`, `void_bill`, `void_order_item`, `set_item_discount`, `set_bill_discount`, `pos_checkout_state`, `pos_open_bill_summaries`, `pos_part_quote` (11-17 bill-parts); `checkout_items`, `move_items`, `pos_split_totals` (11-16 split-bill); `clear_item_discount`, `clear_bill_discount` (10-30 discounts); `pay_bill_part`, `refund_bill`, `record_cash_move`, `pos_open_drawer`, `pos_pay_and_close` (11-22 receipt-numbers); `place_counter_order`, `open_table`, `pos_set_bill_pax`, `set_items_served` (11-22 feedme-habits); `pos_clear_qr_cart` (11-22 qr-table-cart); `pos_menu_picks` (11-17 menu-picks); `close_shift`, `open_shift`, `pos_shift_list`, `pos_shift_zreport`, `reprint_zreport`, `pos_unpair_this_device` (10-29 device-till); `pos_approvers` (10-29 outlets); `pos_whoami` (10-30 pos-app); `pos_current_shift` (10-24 shifts-fn); `pos_menu_rows` (10-24 menu-editor-fn); `pos_menu_windows` (10-24 slots-photos-fn); `pos_refundable_methods` (10-24 checkout-fixes); `reprint_receipt` (10-24 checkout-fn) | untouched: they follow `pos_ctx` |
| Print agent | `tools/print-agent/agent.ts` (signs in with `AGENT_EMAIL` / `AGENT_PASSWORD`, checks `staff.branch_id` = `BRANCH_ID`), `branch.ts` (`branchIdFrom`, `loginBranchProblem`, `branchFilter`, `isAgentJob`, `staleMinutes`), `README.md`, `.env.example` | Tasks 2–3 |
| POS app activation client | `src/pos/activation.ts` (pure: `Pending`, `PollReply`, `POLL_MS`, `retryableSignIn`; no imports, Node-safe), `src/pos/sessionApi.ts` lines 73–101 (reads `import.meta.env`: browser / Vite only) | the agent imports `activation.ts`; `activationClient.ts` mirrors `sessionApi`'s two calls |
| Craft OS `/pos` | `src/App.tsx` line 255 (no AppLayout), `src/features/pos/order/PosPage.tsx` (the till + My PIN), `src/shared/lib/nav.ts` (`pos-register` → `/pos`) | Task 5 |
| POS app error codes | `src/features/pos/deviceErrors.ts` (`device_unpaired`, `outlet_closed`, `no_session`, `access_changed`), `src/pos/posSupabase.ts` (`not_printing_tablet`) | untouched |
| Tests | `vitest.config.ts` (node env; `tools/**/*.test.ts` included, `.claude/worktrees/**` excluded), `src/features/pos/sqlSafeUpdate.test.ts` (one `it` per newer migration) | Tasks 1–5 |

## Global Constraints

- Work only in the worktree `/Users/USER/Desktop/Craft_OS/.claude/worktrees/pos-demo` (branch `feature/pos-demo`); always `cd` there first; never `cd` to `/Users/USER/Desktop/Craft_OS`; never touch `main`. Other sessions commit to this branch: before each task run `git log --oneline -3` and `git status`; touch only the files your task lists; **never run bare `git stash`** (the stash stack is shared); `git add` exact paths only.
- English copy. Every label, message and printed word in English; the spec's strings verbatim: `node --env-file=tools/print-agent/.env tools/print-agent/pair.ts [name]`, `Pairing code: ABC-123 — approve it in Craft OS → Devices (kind: Print agent).`, `Paired. Start the agent with: …`, `Already paired. Delete .device.json to pair again.`, `Not paired. Run: node --env-file=tools/print-agent/.env tools/print-agent/pair.ts`, `This print agent was unpaired — run the pair command again.`, `The POS has moved to its own app.`, `Activate a tablet: open the address on it and approve it in Devices.`; the parent spec's `This request expired.` / `This request was rejected.`; this plan's own words exactly as written in its tasks.
- SQL functions: `security definer set search_path = public, pg_temp`; explicit grants like their neighbours — a device / staff RPC: `revoke all on function f(args) from public, anon;` + `grant execute on function f(args) to authenticated;`; an internal function: `revoke all on function f(args) from public, anon, authenticated;` and no grant. A re-created function keeps its live text except the lines marked with this plan's markers (`-- D1` for D; `-- X1` … `-- X3` for C3 — `-- S1`… is taken by split-bill). Every DELETE / UPDATE has a WHERE (pg-safeupdate). Each migration ends with `notify pgrst, 'reload schema';` and one result row.
- Node agent files (`tools/print-agent/*.ts`, and what they import: `src/features/pos/print/{doc,logo,escpos,printJob,ticket,receipt,zreport,printHost,stale}.ts`, `src/features/pos/guard.ts`, `src/pos/activation.ts`) use explicit `.ts` import extensions, `import { type X }` for types, no enums, no parameter properties; they run with plain `node` (type stripping, Node 22). `tools/` is not in `tsc -b`: a parse check runs them with no env (Task 3).
- Secrets never logged or committed: the device password and the anon key are never printed; `tools/print-agent/.device.json` is git-ignored and written with mode 0600; `tools/print-agent/.env` stays git-ignored and is never shown in output.
- Component tests mock every module that reaches Supabase (`../checkout/MyPinDialog` imports `./checkoutApi`, …): vitest loads `.env.local`, and an unmocked import builds a real client.
- Commands: tests `npx vitest run <files>`; type check `npx tsc -b`; builds `npm run build` and `npm run build:pos`.
- Implementers never run SQL anywhere and never call the real activation function (no `pair.ts` or `agent.ts` run with a real `.env`). SQL tasks end with the migration + verify file written and `src/features/pos/sqlSafeUpdate.test.ts` passing; the controller runs them on craft-os-dev in Task 6.
- Every commit message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push (Task 6 pushes).

The contract between tasks (function, key, file and TypeScript names) is in `.superpowers/sdd/c3d-constraints.md` and in each task's **Interfaces** block.

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `supabase/migration-2026-11-22-pos-agent-pairing.sql` | 1 | Create. D1 `pos_agent_whoami()` |
| `supabase/migration-2026-11-22-pos-agent-pairing-verify.sql` | 1 | Create. Rolled back; P1 whoami, P2 reads, P3 claims |
| `src/features/pos/sqlSafeUpdate.test.ts` | 1, 4 | Modify. One `it` per new migration |
| `tools/print-agent/pairing.ts` (+ `pairing.test.ts`) | 2 | Create. Pure: words, `DeviceFile`, `parseDeviceFile`, `agentName`, `afterAgentPoll`, `runPair`, `parseWhoami`, `isUnpairedError`, `startAgent` |
| `tools/print-agent/activationClient.ts` (+ test) | 2 | Create. The Edge Function's request / poll from Node, platform `agent` |
| `tools/print-agent/deviceFile.ts` (+ test) | 2 | Create. `DEVICE_PATH`, `hasDeviceFile`, `readDeviceFile`, `writeDeviceFile` (0600, never overwrites) |
| `.gitignore` | 2 | Modify. `tools/print-agent/.device.json` |
| `tools/print-agent/pair.ts` | 3 | Create. The pair command |
| `tools/print-agent/agent.ts` | 3 | Modify. Start from `.device.json` + `pos_agent_whoami`; unpaired stops; heartbeat |
| `tools/print-agent/branch.ts` (+ test) | 3 | Modify. Drop `branchIdFrom`, `loginBranchProblem` |
| `tools/print-agent/README.md`, `tools/print-agent/.env.example` | 3 | Rewrite for pairing |
| `supabase/migration-2026-11-22-pos-switchover.sql` | 4 | Create. X1 `pos_ctx`, X2 `pos_print_branch`, X3 `pos_session_branch` |
| `supabase/migration-2026-11-22-pos-switchover-verify.sql` | 4 | Create. Rolled back; X1 staff refused, X2 device allowed, X3 agents, X4 back office |
| `src/features/pos/order/posAppUrl.ts` (+ test) | 5 | Create. `posAppUrl(raw)` |
| `src/features/pos/order/PosPage.tsx` (+ `PosPage.test.tsx`) | 5 | Rewrite. The notice + My PIN |
| `src/App.tsx` | 5 | Modify. `/pos` inside `AppLayout` |
| `src/features/pos/checkout/CheckoutSettings.tsx` | 5 | Modify. Where staff set a PIN |
| `.env.example` | 5 | Modify. `VITE_POS_APP_URL` |
| `docs/pos/2026-10-29-feedme-replacement-readiness.md`, `.claude/launch.json` | 6 | Modify. W1 Part C, W6 Part D, §4 chain; a `pos-app-dev` launch entry |

---

### Task 1: SQL — `pos_agent_whoami()`, the print agent's own outlet (D1)

**Files:**
- Create: `supabase/migration-2026-11-22-pos-agent-pairing.sql`
- Create: `supabase/migration-2026-11-22-pos-agent-pairing-verify.sql`
- Modify: `src/features/pos/sqlSafeUpdate.test.ts` (a new `it` at the end of `describe('pg-safeupdate guard: POS migrations', …)`)

**Interfaces:**
- Consumes (live): `pos_devices` (id = the device's auth user; `kind`, `branch_id`, `name`, `revoked_at`, `last_seen_at`), `branches.name`, `pos_print_branch()`, `claim_print_job(uuid)`, `finish_print_job(uuid, boolean, text)`, `insert_test_print(text, uuid)`, `pos_readable_branches()` (the `pos_read` policies), `pos_whoami()` (for the STOP guard), `set_my_pos_pin`.
- Produces (Tasks 3, 4 and 6 rely on these):
  - `pos_agent_whoami() returns jsonb` — `{ "deviceId", "deviceName", "outletId", "outletName" }` for the caller's active `print_agent` device; raises `device_unpaired` for a POS tablet, a revoked device, a staff login or no login. Granted to `authenticated` only.
  - Result row `pos agent pairing applied`; verify `VERIFY OK`.

- [ ] **Step 1: Write the failing test**

In `src/features/pos/sqlSafeUpdate.test.ts`, add this `it` as the last test inside `describe('pg-safeupdate guard: POS migrations', () => { … })` — right after the `it('scans the W7 migration: …')` block, before the `})` that closes the describe:

```ts
  it('scans the D migration: pos_agent_whoami for print agents only, granted like its neighbours, a STOP guard', () => {
    const sql = readFileSync(new URL('migration-2026-11-22-pos-agent-pairing.sql', SUPABASE), 'utf8')
    const bodies = functionBodies(sql)
    expect(bodies.map((b) => b.name)).toEqual(['pos_agent_whoami'])
    const body = bodies[0].body
    expect(body).toContain("v_dev.kind <> ''")                       // strings are emptied: kind <> 'print_agent'
    expect(body).toContain('v_dev.revoked_at is not null')
    expect(body).toContain("current_setting('')::boolean")           // no stamp in a read-only call
    expect(sql).toContain('revoke all on function pos_agent_whoami() from public, anon;')
    expect(sql).toContain('grant execute on function pos_agent_whoami() to authenticated;')
    expect(sql).toMatch(/raise exception 'STOP: run migration-2026-10-30-pos-app\.sql first/)
    expect(sql).toMatch(/notify pgrst, 'reload schema';\s*select 'pos agent pairing applied' as result;\s*$/)
    const verify = readFileSync(new URL('migration-2026-11-22-pos-agent-pairing-verify.sql', SUPABASE), 'utf8')
    expect(verify).toMatch(/^begin;$/m)
    expect(verify).toMatch(/select 'VERIFY OK' as result;\s*rollback;\s*$/)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts`
Expected: FAIL in `scans the D migration: …` — `ENOENT … migration-2026-11-22-pos-agent-pairing.sql`.

- [ ] **Step 3: Write the migration**

Create `supabase/migration-2026-11-22-pos-agent-pairing.sql` with exactly:

```sql
-- ============================================================================
-- Craft OS — POS print agent pairing, D (2026-11-22). Run on craft-os-dev after
-- migration-2026-10-30-pos-app.sql (any time after; before migration-2026-11-22-pos-switchover.sql).
-- Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-11-22-pos-agent-pairing-switchover.md
-- Design: docs/superpowers/specs/2026-11-22-pos-agent-pairing-switchover-design.md (§2)
--
-- D1  The print agent pairs like a tablet (Edge Function pos-device-activation, platform 'agent',
--     approved in Craft OS → Devices as kind Print agent) and then needs its outlet. pos_devices is
--     closed to every client (migration-2026-10-29-pos-devices.sql D1) and pos_whoami() is for POS
--     tablets with a session, so pos_agent_whoami() tells an active print-agent device its outlet and
--     name, and stamps last_seen_at (the agent calls it at start and every minute). Anything else —
--     a POS tablet, a revoked device, a staff login, no login — gets device_unpaired.
--     Printing itself needs nothing new: pos_print_branch() already lets a print agent claim,
--     finish and requeue its outlet's jobs, and the pos_read policies let it read its outlet's
--     print_routes and print_jobs (Realtime included).
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_whoami()') is null or to_regprocedure('pos_print_branch()') is null then
    raise exception 'STOP: run migration-2026-10-30-pos-app.sql first (pos_whoami is missing)';
  end if;
end $$;

-- ── D1. The print agent's own device and outlet ──────────────────────────────
create or replace function pos_agent_whoami() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dev pos_devices;
begin
  select * into v_dev from pos_devices d where d.id = auth.uid();
  if not found or v_dev.kind <> 'print_agent' or v_dev.revoked_at is not null then
    raise exception 'device_unpaired';
  end if;
  -- as in pos_ctx: stamped at most every 30 s, skipped in a read-only transaction
  if not current_setting('transaction_read_only')::boolean then
    update pos_devices set last_seen_at = now()
     where id = v_dev.id and (last_seen_at is null or last_seen_at < now() - interval '30 seconds');
  end if;
  return jsonb_build_object(
    'deviceId', v_dev.id, 'deviceName', v_dev.name,
    'outletId', v_dev.branch_id, 'outletName', (select b.name from branches b where b.id = v_dev.branch_id));
end $$;
revoke all on function pos_agent_whoami() from public, anon;
grant execute on function pos_agent_whoami() to authenticated;

notify pgrst, 'reload schema';
select 'pos agent pairing applied' as result;
```

- [ ] **Step 4: Write the verify**

Create `supabase/migration-2026-11-22-pos-agent-pairing-verify.sql` with exactly:

```sql
-- Self-check for the print agent pairing (D). Run on craft-os-dev after
-- migration-2026-11-22-pos-agent-pairing.sql. Everything is rolled back. Success = a result row "VERIFY OK".
-- Sections (one DO block each, ids in the temp table fixture): FIXTURE; P1 pos_agent_whoami; P2 what a print
-- agent reads (RLS); P3 what it claims and finishes.
-- Outlets VERIFY D A and VERIFY D B, a Bar route of kind agent on each and one test job each (queued from the
-- back office by the dev owner login); print agents on A and on B, a revoked agent on A, a POS tablet on A.
begin;

create function pg_temp.expect_error(p_sql text, p_message text, p_label text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm is distinct from p_message then
      raise exception 'FAIL %: got "%" (expected "%")', p_label, sqlerrm, p_message;
    end if;
    return;
  end;
  raise exception 'FAIL %: no error (expected "%")', p_label, p_message;
end $$;
create function pg_temp.act(p_user uuid) returns void
language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
create temp table fixture (k text primary key, v uuid);
create function pg_temp.put(p_k text, p_v uuid) returns void
language sql as $$ insert into pg_temp.fixture(k, v) values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.id(p_k text) returns uuid
language sql as $$ select v from pg_temp.fixture where k = p_k $$;

-- ── FIXTURE ──
do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_ag_a  uuid := 'eeeeeeee-0000-0000-0000-0000000d0a01';
  v_ag_b  uuid := 'eeeeeeee-0000-0000-0000-0000000d0b01';
  v_ag_r  uuid := 'eeeeeeee-0000-0000-0000-0000000d0a02';
  v_pos   uuid := 'eeeeeeee-0000-0000-0000-0000000d0a03';
  v_a uuid; v_b uuid;
begin
  -- the role defaults decide (owner: every outlet and access_settings)
  update system_role_permissions set permissions = permissions - 'pos_login' - 'all_branches' - 'access_settings' - 'pos_supervise'
   where true;
  insert into branches(name, address) values ('VERIFY D A', 'a') returning id into v_a;
  insert into branches(name, address) values ('VERIFY D B', 'b') returning id into v_b;
  insert into print_routes(branch_id, name, kind, address) values
    (v_a, 'Bar', 'agent', '127.0.0.1:9100'), (v_b, 'Bar', 'agent', '127.0.0.1:9100');
  insert into auth.users (id) values (v_ag_a), (v_ag_b), (v_ag_r), (v_pos);
  insert into pos_devices(id, branch_id, kind, name, platform, prints, approved_by) values
    (v_ag_a, v_a, 'print_agent', 'D Agent A', 'agent', false, v_owner),
    (v_ag_b, v_b, 'print_agent', 'D Agent B', 'agent', false, v_owner),
    (v_ag_r, v_a, 'print_agent', 'D Agent gone', 'agent', false, v_owner),
    (v_pos,  v_a, 'pos', 'D Counter', 'ipad', false, v_owner);
  update pos_devices set revoked_at = now(), revoked_by = v_owner where id = v_ag_r;
  perform pg_temp.put('a', v_a); perform pg_temp.put('b', v_b); perform pg_temp.put('owner', v_owner);
  perform pg_temp.put('ag_a', v_ag_a); perform pg_temp.put('ag_b', v_ag_b); perform pg_temp.put('ag_r', v_ag_r);
  perform pg_temp.put('pos', v_pos);
  perform pg_temp.act(v_owner);
  perform pg_temp.put('job_a', insert_test_print('Bar', v_a));
  perform pg_temp.put('job_b', insert_test_print('Bar', v_b));
end $$;

-- ── P1. pos_agent_whoami: an active print agent learns its outlet; nobody else gets an answer ──
do $$
declare
  v_who jsonb;
  r     record;
begin
  if has_function_privilege('anon', 'pos_agent_whoami()', 'execute') then raise exception 'FAIL P1 anon may call it'; end if;
  if not has_function_privilege('authenticated', 'pos_agent_whoami()', 'execute') then raise exception 'FAIL P1 authenticated may not'; end if;
  perform pg_temp.act(pg_temp.id('ag_a'));
  v_who := pos_agent_whoami();
  if (v_who->>'outletId')::uuid is distinct from pg_temp.id('a') or v_who->>'outletName' is distinct from 'VERIFY D A'
     or v_who->>'deviceName' is distinct from 'D Agent A' or (v_who->>'deviceId')::uuid is distinct from pg_temp.id('ag_a') then
    raise exception 'FAIL P1 agent A: %', v_who;
  end if;
  if (select last_seen_at from pos_devices where id = pg_temp.id('ag_a')) is null then raise exception 'FAIL P1 not stamped'; end if;
  for r in select * from (values ('ag_r', 'a revoked agent'), ('pos', 'a POS tablet'), ('owner', 'a staff login')) x(k, label) loop
    perform pg_temp.act(pg_temp.id(r.k));
    perform pg_temp.expect_error('select pos_agent_whoami()', 'device_unpaired', 'P1 ' || r.label);
  end loop;
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.expect_error('select pos_agent_whoami()', 'device_unpaired', 'P1 no login');
end $$;

-- ── P2. What a print agent reads: its outlet's routes and jobs, nothing of another outlet, never pos_devices ──
do $$
declare
  v_a     uuid := pg_temp.id('a');
  v_b     uuid := pg_temp.id('b');
  v_job_a uuid := pg_temp.id('job_a');
  v_job_b uuid := pg_temp.id('job_b');
  v_ag_a  uuid := pg_temp.id('ag_a');
  v_ag_r  uuid := pg_temp.id('ag_r');
  n_routes integer; n_jobs integer; n_jobs_a integer; v_err text;
begin
  perform pg_temp.act(v_ag_a);
  set local role authenticated;
  select count(*) into n_routes from print_routes where branch_id in (v_a, v_b);
  select count(*) into n_jobs from print_jobs where id in (v_job_a, v_job_b);
  select count(*) into n_jobs_a from print_jobs where id = v_job_a;
  begin
    perform 1 from pos_devices where id = v_ag_a;
    v_err := 'no error';
  exception when others then v_err := sqlerrm;
  end;
  reset role;
  if n_routes <> 1 then raise exception 'FAIL P2 agent A reads % routes of A and B (expected 1)', n_routes; end if;
  if n_jobs <> 1 or n_jobs_a <> 1 then raise exception 'FAIL P2 agent A reads % jobs of A and B, % of A (expected 1, 1)', n_jobs, n_jobs_a; end if;
  if v_err is distinct from 'permission denied for table pos_devices' then raise exception 'FAIL P2 pos_devices read: %', v_err; end if;
  -- a revoked agent reads nothing
  perform pg_temp.act(v_ag_r);
  set local role authenticated;
  select count(*) into n_jobs from print_jobs where id in (v_job_a, v_job_b);
  reset role;
  if n_jobs <> 0 then raise exception 'FAIL P2 a revoked agent reads % jobs', n_jobs; end if;
end $$;

-- ── P3. Claims: own outlet only; finish; a revoked agent is refused ──
do $$
declare
  v_job_a uuid := pg_temp.id('job_a');
  v_job_b uuid := pg_temp.id('job_b');
begin
  perform pg_temp.act(pg_temp.id('ag_a'));
  if claim_print_job(v_job_b) then raise exception 'FAIL P3 agent A claimed outlet B''s job'; end if;
  if (select status from print_jobs where id = v_job_b) is distinct from 'pending' then raise exception 'FAIL P3 B''s job changed'; end if;
  if not claim_print_job(v_job_a) then raise exception 'FAIL P3 agent A could not claim its job'; end if;
  perform finish_print_job(v_job_a, true, null);
  if (select status from print_jobs where id = v_job_a) is distinct from 'printed' then raise exception 'FAIL P3 finish'; end if;
  perform pg_temp.act(pg_temp.id('ag_b'));
  if not claim_print_job(v_job_b) then raise exception 'FAIL P3 agent B could not claim its job'; end if;
  perform pg_temp.act(pg_temp.id('ag_r'));
  perform pg_temp.expect_error(format('select claim_print_job(%L)', v_job_b), 'device_unpaired', 'P3 a revoked agent');
end $$;

select 'VERIFY OK' as result;
rollback;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts`
Expected: PASS (the new `it` and the per-file `every DELETE / UPDATE inside a function has a WHERE` test for the new file).

- [ ] **Step 6: Commit**

```bash
git add supabase/migration-2026-11-22-pos-agent-pairing.sql supabase/migration-2026-11-22-pos-agent-pairing-verify.sql src/features/pos/sqlSafeUpdate.test.ts
git commit -m "$(cat <<'EOF'
feat(pos): D1 pos_agent_whoami — a paired print agent learns its outlet

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The agent's pairing module, activation client and device file (pure, tested)

**Files:**
- Create: `tools/print-agent/pairing.ts`, `tools/print-agent/pairing.test.ts`
- Create: `tools/print-agent/activationClient.ts`, `tools/print-agent/activationClient.test.ts`
- Create: `tools/print-agent/deviceFile.ts`, `tools/print-agent/deviceFile.test.ts`
- Modify: `.gitignore` (one line after `.env.*.local`)

**Interfaces:**
- Consumes: `src/pos/activation.ts` — `POLL_MS` (5000), `retryableSignIn(e: unknown): boolean`, `type Pending = { code; secret; expiresAt; name: string | null }`, `type PollReply = { status: 'pending' | 'rejected' | 'expired' | 'unknown' } | { status: 'approved'; deviceId; email; password; branchId; kind; name }`. The Edge Function `pos-device-activation` (`supabase/functions/pos-device-activation/index.ts`): `POST {SUPABASE_URL}/functions/v1/pos-device-activation`, headers `apikey` + `Authorization: Bearer <anon>`; `{ action: 'request', name, platform: 'agent' }` → 200 `{ code, secret, expiresAt }` or 429 / 503 / 400 / 500 `{ error }`; `{ action: 'poll', code, secret }` → 200 `{ status }` (once `approved` with the credentials) or 500 `{ error }`.
- Produces (Task 3 relies on these, names exact):
  - `pairing.ts`: constants `PAIR_COMMAND`, `AGENT_COMMAND`, `ALREADY_PAIRED`, `PAIRED`, `NOT_PAIRED`, `UNPAIRED`, `WAITING`, `ENDED` (`rejected`, `expired`, `unknown`, `wrong_kind`); `pairingCodeLine(code: string): string`; `interface DeviceFile { email: string; password: string; deviceId: string; pairedAt: string }`; `parseDeviceFile(text: string): DeviceFile | null`; `agentName(arg: string | undefined, host: string): string | null`; `type PollStep`; `afterAgentPoll(reply: PollReply, now: Date): PollStep`; `interface PairDeps`; `runPair(name: string | null, deps: PairDeps): Promise<number>` (the exit code); `interface AgentWhoami { deviceId: string; deviceName: string; outletId: string; outletName: string }`; `parseWhoami(data: unknown): AgentWhoami`; `isUnpairedError(e: unknown): boolean`; `messageOf(e: unknown): string`; `interface StartDeps`; `type AgentStart = { ok: true; who: AgentWhoami } | { ok: false; message: string }`; `startAgent(deps: StartDeps): Promise<AgentStart>`.
  - `activationClient.ts`: `interface ActivationClient { request(name: string | null): Promise<Pending>; poll(p: Pending): Promise<PollReply> }`; `activationClient(supabaseUrl: string, anonKey: string, fetchFn?: typeof fetch): ActivationClient`.
  - `deviceFile.ts`: `DEVICE_PATH` (absolute path of `tools/print-agent/.device.json`); `hasDeviceFile(path?: string): boolean`; `readDeviceFile(path?: string): DeviceFile | null` (throws on a broken file); `writeDeviceFile(file: DeviceFile, path?: string): void` (mode 0600, refuses to overwrite).

- [ ] **Step 1: Write the failing tests**

Create `tools/print-agent/pairing.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import type { Pending, PollReply } from '../../src/pos/activation.ts'
import {
  afterAgentPoll, agentName, ALREADY_PAIRED, ENDED, isUnpairedError, messageOf, NOT_PAIRED, PAIRED, pairingCodeLine,
  parseDeviceFile, parseWhoami, runPair, startAgent, UNPAIRED, WAITING, type DeviceFile, type PairDeps, type StartDeps,
} from './pairing.ts'

const NOW = new Date('2026-11-22T10:00:00.000Z')
const pending: Pending = { code: 'ABC-123', secret: 's3cret', expiresAt: '2026-11-23T10:00:00Z', name: 'Office Mac' }
const approved = (kind: string): PollReply => ({
  status: 'approved', deviceId: 'dev-1', email: 'device-1@devices.invalid', password: 'pw-secret', branchId: 'b-1', kind, name: 'Office Mac',
})
const file: DeviceFile = { email: 'device-1@devices.invalid', password: 'pw-secret', deviceId: 'dev-1', pairedAt: NOW.toISOString() }
const who = { deviceId: 'dev-1', deviceName: 'Office Mac', outletId: 'b-1', outletName: 'Demo' }

describe('the words (spec §2)', () => {
  it('prints the code, the commands and the outcomes exactly', () => {
    expect(pairingCodeLine('ABC-123')).toBe('Pairing code: ABC-123 — approve it in Craft OS → Devices (kind: Print agent).')
    expect(PAIRED).toBe('Paired. Start the agent with: node --env-file=tools/print-agent/.env tools/print-agent/agent.ts')
    expect(ALREADY_PAIRED).toBe('Already paired. Delete .device.json to pair again.')
    expect(NOT_PAIRED).toBe('Not paired. Run: node --env-file=tools/print-agent/.env tools/print-agent/pair.ts')
    expect(UNPAIRED).toBe('This print agent was unpaired — run the pair command again.')
    expect(ENDED.rejected).toBe('This request was rejected.')
    expect(ENDED.expired).toBe('This request expired.')
  })
})

describe('parseDeviceFile', () => {
  it('reads the four fields', () => {
    expect(parseDeviceFile(JSON.stringify(file))).toEqual(file)
  })
  it('refuses anything else', () => {
    expect(parseDeviceFile('not json')).toBeNull()
    expect(parseDeviceFile('null')).toBeNull()
    expect(parseDeviceFile(JSON.stringify({ ...file, password: '' }))).toBeNull()
    expect(parseDeviceFile(JSON.stringify({ email: 'e', password: 'p', deviceId: 'd' }))).toBeNull()
  })
})

describe('agentName', () => {
  it('takes the argument, else the host name without .local, at most 40 characters', () => {
    expect(agentName('  Cheras bar  ', 'host.local')).toBe('Cheras bar')
    expect(agentName(undefined, 'Craftales-MacBook-Air.local')).toBe('Craftales-MacBook-Air')
    expect(agentName('', 'office')).toBe('office')
    expect(agentName(undefined, 'x'.repeat(50))).toBe('x'.repeat(40))
    expect(agentName(undefined, '  ')).toBeNull()
  })
})

describe('afterAgentPoll', () => {
  it('waits while pending', () => {
    expect(afterAgentPoll({ status: 'pending' }, NOW)).toEqual({ kind: 'wait' })
  })
  it('keeps the credentials of a print agent, with the time', () => {
    expect(afterAgentPoll(approved('print_agent'), NOW)).toEqual({ kind: 'paired', file, name: 'Office Mac' })
  })
  it('does not keep a device approved as a POS tablet', () => {
    expect(afterAgentPoll(approved('pos'), NOW)).toEqual({ kind: 'stop', message: ENDED.wrong_kind })
  })
  it.each(['rejected', 'expired', 'unknown'] as const)('stops when %s', (status) => {
    expect(afterAgentPoll({ status }, NOW)).toEqual({ kind: 'stop', message: ENDED[status] })
  })
})

function pairDeps(replies: (PollReply | Error)[], over: Partial<PairDeps> = {}) {
  const lines: string[] = []
  const saved: DeviceFile[] = []
  const deps: PairDeps = {
    paired: () => false,
    request: vi.fn(async () => pending),
    poll: vi.fn(async () => {
      const r = replies.shift()
      if (!r) throw new Error('no more replies')
      if (r instanceof Error) throw r
      return r
    }),
    save: (f) => { saved.push(f) },
    log: (l) => { lines.push(l) },
    sleep: vi.fn(async () => undefined),
    now: () => NOW,
    ...over,
  }
  return { deps, lines, saved }
}

describe('runPair', () => {
  it('requests with the name, shows the code, polls every 5 s and saves on approval', async () => {
    const { deps, lines, saved } = pairDeps([{ status: 'pending' }, approved('print_agent')])
    expect(await runPair('Office Mac', deps)).toBe(0)
    expect(deps.request).toHaveBeenCalledWith('Office Mac')
    expect(deps.poll).toHaveBeenCalledTimes(2)
    expect(deps.sleep).toHaveBeenCalledWith(5000)
    expect(saved).toEqual([file])
    expect(lines).toEqual([pairingCodeLine('ABC-123'), WAITING, PAIRED])
    expect(lines.join('\n')).not.toContain('pw-secret')
  })
  it.each([['rejected', ENDED.rejected], ['expired', ENDED.expired]] as const)('says so and exits 1 when %s', async (status, message) => {
    const { deps, lines, saved } = pairDeps([{ status }])
    expect(await runPair(null, deps)).toBe(1)
    expect(saved).toEqual([])
    expect(lines.at(-1)).toBe(message)
  })
  it('refuses when already paired, without a request', async () => {
    const { deps, lines } = pairDeps([], { paired: () => true })
    expect(await runPair(null, deps)).toBe(1)
    expect(deps.request).not.toHaveBeenCalled()
    expect(lines).toEqual([ALREADY_PAIRED])
  })
  it('exits 1 with the function words when the request is refused', async () => {
    const { deps, lines } = pairDeps([], { request: async () => { throw new Error('Too many activation requests from this network. Try again in an hour.') } })
    expect(await runPair(null, deps)).toBe(1)
    expect(lines).toEqual(['Too many activation requests from this network. Try again in an hour.'])
  })
  it('keeps polling after a network failure', async () => {
    const { deps, lines, saved } = pairDeps([new TypeError('fetch failed'), approved('print_agent')])
    expect(await runPair(null, deps)).toBe(0)
    expect(lines).toContain('fetch failed Trying again.')
    expect(saved).toEqual([file])
  })
  it('says how to recover when the file cannot be saved, never printing the password', async () => {
    const { deps, lines } = pairDeps([approved('print_agent')], { save: () => { throw new Error('EEXIST: file already exists') } })
    expect(await runPair(null, deps)).toBe(1)
    expect(lines.at(-1)).toBe('Could not save .device.json (EEXIST: file already exists). Ask HQ to unpair "Office Mac" in Devices and pair again.')
    expect(lines.join('\n')).not.toContain('pw-secret')
  })
})

describe('parseWhoami and the error helpers', () => {
  it('reads pos_agent_whoami', () => {
    expect(parseWhoami(who)).toEqual(who)
    expect(() => parseWhoami({ deviceId: 'd' })).toThrow('pos_agent_whoami returned an unexpected reply')
  })
  it('knows device_unpaired from PostgREST and from an Error', () => {
    expect(isUnpairedError({ message: 'device_unpaired', code: 'P0001' })).toBe(true)
    expect(isUnpairedError(new Error('device_unpaired'))).toBe(true)
    expect(isUnpairedError({ message: 'Bill not found' })).toBe(false)
    expect(isUnpairedError(null)).toBe(false)
  })
  it('messageOf reads an Error, a PostgREST error or anything', () => {
    expect(messageOf(new Error('a'))).toBe('a')
    expect(messageOf({ message: 'b' })).toBe('b')
    expect(messageOf('c')).toBe('c')
  })
})

describe('startAgent', () => {
  const start = (over: Partial<StartDeps>) => startAgent({
    readDevice: () => file,
    signIn: async () => null,
    whoami: async () => who,
    ...over,
  })
  it('signs in with the file and returns the outlet', async () => {
    const signIn = vi.fn(async () => null)
    expect(await start({ signIn })).toEqual({ ok: true, who })
    expect(signIn).toHaveBeenCalledWith('device-1@devices.invalid', 'pw-secret')
  })
  it('without .device.json: Not paired', async () => {
    expect(await start({ readDevice: () => null })).toEqual({ ok: false, message: NOT_PAIRED })
  })
  it('a broken .device.json says what is wrong', async () => {
    expect(await start({ readDevice: () => { throw new Error('broken') } })).toEqual({ ok: false, message: 'broken' })
  })
  it('a refused sign-in (banned, wrong password) means unpaired', async () => {
    const banned = Object.assign(new Error('User is banned'), { name: 'AuthApiError' })
    expect(await start({ signIn: async () => banned })).toEqual({ ok: false, message: UNPAIRED })
  })
  it('a sign-in with no reply is not an unpairing', async () => {
    const offline = Object.assign(new Error('fetch failed'), { name: 'AuthRetryableFetchError' })
    expect(await start({ signIn: async () => offline })).toEqual({ ok: false, message: 'Could not reach Supabase to sign in: fetch failed' })
    expect(await start({ signIn: async () => { throw new TypeError('fetch failed') } }))
      .toEqual({ ok: false, message: 'Could not reach Supabase to sign in: fetch failed' })
  })
  it('device_unpaired from pos_agent_whoami means unpaired; another error is reported', async () => {
    expect(await start({ whoami: async () => { throw { message: 'device_unpaired' } } })).toEqual({ ok: false, message: UNPAIRED })
    expect(await start({ whoami: async () => { throw { message: 'Could not find the function public.pos_agent_whoami' } } }))
      .toEqual({ ok: false, message: "Could not read this print agent's outlet: Could not find the function public.pos_agent_whoami" })
  })
})
```

Note: the recovery line names the device as HQ approved it (the reply's `name`), which is how Devices lists it.

Create `tools/print-agent/activationClient.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { activationClient } from './activationClient.ts'

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('activationClient — the Edge Function from Node, platform agent', () => {
  it('requests with the anon key and platform agent', async () => {
    const fetchFn = vi.fn(async () => reply(200, { code: 'ABC-123', secret: 's', expiresAt: '2026-11-23T10:00:00Z' }))
    const client = activationClient('https://dev.supabase.co/', 'anon-key', fetchFn as unknown as typeof fetch)
    expect(await client.request('Office Mac')).toEqual({ code: 'ABC-123', secret: 's', expiresAt: '2026-11-23T10:00:00Z', name: 'Office Mac' })
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://dev.supabase.co/functions/v1/pos-device-activation')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', apikey: 'anon-key', Authorization: 'Bearer anon-key' })
    expect(JSON.parse(init.body as string)).toEqual({ action: 'request', name: 'Office Mac', platform: 'agent' })
  })
  it('throws the function words when a request is refused', async () => {
    const client = activationClient('https://dev.supabase.co', 'k', (async () => reply(429, { error: 'Too many activation requests from this network. Try again in an hour.' })) as unknown as typeof fetch)
    await expect(client.request(null)).rejects.toThrow('Too many activation requests from this network. Try again in an hour.')
    const bare = activationClient('https://dev.supabase.co', 'k', (async () => new Response('oops', { status: 502 })) as unknown as typeof fetch)
    await expect(bare.request(null)).rejects.toThrow('Could not start the activation. Try again.')
  })
  it('polls with the code and secret', async () => {
    const fetchFn = vi.fn(async () => reply(200, { status: 'pending' }))
    const client = activationClient('https://dev.supabase.co', 'k', fetchFn as unknown as typeof fetch)
    expect(await client.poll({ code: 'ABC-123', secret: 's', expiresAt: 'x', name: null })).toEqual({ status: 'pending' })
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ action: 'poll', code: 'ABC-123', secret: 's' })
  })
  it('throws when a poll fails', async () => {
    const client = activationClient('https://dev.supabase.co', 'k', (async () => reply(500, { error: 'Could not check the activation. Try again.' })) as unknown as typeof fetch)
    await expect(client.poll({ code: 'A', secret: 's', expiresAt: 'x', name: null })).rejects.toThrow('Could not check the activation. Try again.')
  })
})
```

Create `tools/print-agent/deviceFile.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEVICE_PATH, hasDeviceFile, readDeviceFile, writeDeviceFile } from './deviceFile.ts'

const file = { email: 'device-1@devices.invalid', password: 'pw', deviceId: 'dev-1', pairedAt: '2026-11-22T10:00:00.000Z' }
let dir = ''
const tmp = () => { dir = mkdtempSync(join(tmpdir(), 'print-agent-')); return join(dir, '.device.json') }
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = '' })

describe('the device file', () => {
  it('lives next to the agent and is git-ignored', () => {
    expect(DEVICE_PATH.endsWith('/tools/print-agent/.device.json')).toBe(true)
    const ignore = readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8').split('\n')
    expect(ignore).toContain('tools/print-agent/.device.json')
  })
  it('is written with mode 0600 and read back', () => {
    const path = tmp()
    expect(hasDeviceFile(path)).toBe(false)
    expect(readDeviceFile(path)).toBeNull()
    writeDeviceFile(file, path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(hasDeviceFile(path)).toBe(true)
    expect(readDeviceFile(path)).toEqual(file)
  })
  it('never overwrites a pairing', () => {
    const path = tmp()
    writeDeviceFile(file, path)
    expect(() => writeDeviceFile({ ...file, deviceId: 'dev-2' }, path)).toThrow(/EEXIST/)
    expect(readDeviceFile(path)?.deviceId).toBe('dev-1')
  })
  it('a broken file says what to do', () => {
    const path = tmp()
    writeFileSync(path, '{"email":')
    expect(() => readDeviceFile(path)).toThrow(`${path} is not a print agent pairing. Delete it and pair again.`)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tools/print-agent/pairing.test.ts tools/print-agent/activationClient.test.ts tools/print-agent/deviceFile.test.ts`
Expected: FAIL — `Failed to resolve import "./pairing.ts"` (and the same for the other two).

- [ ] **Step 3: Write `tools/print-agent/pairing.ts`**

```ts
// The print agent pairs like a tablet (spec 2026-11-22 §2): the words it prints, the .device.json
// shape, what a poll reply means, the pair loop and the agent's start. Every side effect (network,
// file, clock, console) is passed in, so Vitest runs all of it. Node runs this file as is (type
// stripping): explicit .ts imports, no enums, no parameter properties.
import { POLL_MS, retryableSignIn, type Pending, type PollReply } from '../../src/pos/activation.ts'

export const PAIR_COMMAND = 'node --env-file=tools/print-agent/.env tools/print-agent/pair.ts'
export const AGENT_COMMAND = 'node --env-file=tools/print-agent/.env tools/print-agent/agent.ts'

export const ALREADY_PAIRED = 'Already paired. Delete .device.json to pair again.'
export const PAIRED = `Paired. Start the agent with: ${AGENT_COMMAND}`
export const NOT_PAIRED = `Not paired. Run: ${PAIR_COMMAND}`
export const UNPAIRED = 'This print agent was unpaired — run the pair command again.'
export const WAITING = 'Waiting for approval…'
export const ENDED = {
  rejected: 'This request was rejected.',
  expired: 'This request expired.',
  unknown: 'This request is no longer valid. Run the pair command again.',
  wrong_kind: 'HQ approved this request as a POS tablet. Ask HQ to unpair it in Devices, then pair again and approve it as Print agent.',
}

export const pairingCodeLine = (code: string): string =>
  `Pairing code: ${code} — approve it in Craft OS → Devices (kind: Print agent).`

/** tools/print-agent/.device.json — the device account, written once by the pair command. */
export interface DeviceFile { email: string; password: string; deviceId: string; pairedAt: string }

export function parseDeviceFile(text: string): DeviceFile | null {
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  for (const k of ['email', 'password', 'deviceId', 'pairedAt']) {
    if (typeof o[k] !== 'string' || o[k] === '') return null
  }
  return { email: o.email as string, password: o.password as string, deviceId: o.deviceId as string, pairedAt: o.pairedAt as string }
}

/** The name HQ sees in Devices: the argument, else this computer's host name; the function keeps 40 characters. */
export function agentName(arg: string | undefined, host: string): string | null {
  const name = (arg?.trim() || host.trim().replace(/\.local$/i, '')).slice(0, 40).trim()
  return name || null
}

export type PollStep = { kind: 'wait' } | { kind: 'paired'; file: DeviceFile; name: string } | { kind: 'stop'; message: string }

/** What a poll reply means for the agent. A device approved as a POS tablet is not kept. */
export function afterAgentPoll(reply: PollReply, now: Date): PollStep {
  switch (reply.status) {
    case 'pending': return { kind: 'wait' }
    case 'approved':
      if (reply.kind !== 'print_agent') return { kind: 'stop', message: ENDED.wrong_kind }
      return {
        kind: 'paired', name: reply.name,
        file: { email: reply.email, password: reply.password, deviceId: reply.deviceId, pairedAt: now.toISOString() },
      }
    default: return { kind: 'stop', message: ENDED[reply.status] }
  }
}

/** An Error's message, a PostgREST error's message, or the value as text. */
export function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message
  return String(e)
}

export interface PairDeps {
  paired: () => boolean
  request: (name: string | null) => Promise<Pending>
  poll: (p: Pending) => Promise<PollReply>
  save: (file: DeviceFile) => void
  log: (line: string) => void
  sleep: (ms: number) => Promise<void>
  now: () => Date
}

/** The pair command. Resolves to the process exit code. The password is never logged. */
export async function runPair(name: string | null, deps: PairDeps): Promise<number> {
  if (deps.paired()) { deps.log(ALREADY_PAIRED); return 1 }
  let pending: Pending
  try { pending = await deps.request(name) } catch (e) { deps.log(messageOf(e)); return 1 }
  deps.log(pairingCodeLine(pending.code))
  deps.log(WAITING)
  for (;;) {
    await deps.sleep(POLL_MS)
    let reply: PollReply
    try { reply = await deps.poll(pending) } catch (e) { deps.log(`${messageOf(e)} Trying again.`); continue }
    const step = afterAgentPoll(reply, deps.now())
    if (step.kind === 'wait') continue
    if (step.kind === 'stop') { deps.log(step.message); return 1 }
    try { deps.save(step.file) } catch (e) {
      // the approved reply comes once: the device exists but this computer could not keep its sign-in
      deps.log(`Could not save .device.json (${messageOf(e)}). Ask HQ to unpair "${step.name}" in Devices and pair again.`)
      return 1
    }
    deps.log(PAIRED)
    return 0
  }
}

/** pos_agent_whoami() (migration-2026-11-22-pos-agent-pairing.sql). */
export interface AgentWhoami { deviceId: string; deviceName: string; outletId: string; outletName: string }

export function parseWhoami(data: unknown): AgentWhoami {
  const o = (data ?? {}) as Record<string, unknown>
  if (typeof o.deviceId !== 'string' || typeof o.outletId !== 'string') throw new Error('pos_agent_whoami returned an unexpected reply')
  return { deviceId: o.deviceId, deviceName: String(o.deviceName ?? ''), outletId: o.outletId, outletName: String(o.outletName ?? '') }
}

/** The server's word for a device that may no longer work (unpaired, or not a print agent). */
export const isUnpairedError = (e: unknown): boolean => !!e && messageOf(e) === 'device_unpaired'

export interface StartDeps {
  readDevice: () => DeviceFile | null
  /** null when signed in; Supabase's error otherwise (its name tells a network failure). */
  signIn: (email: string, password: string) => Promise<Error | null>
  whoami: () => Promise<AgentWhoami>
}

export type AgentStart = { ok: true; who: AgentWhoami } | { ok: false; message: string }

/** The agent's start: .device.json → sign in → its outlet. */
export async function startAgent(deps: StartDeps): Promise<AgentStart> {
  let file: DeviceFile | null
  try { file = deps.readDevice() } catch (e) { return { ok: false, message: messageOf(e) } }
  if (!file) return { ok: false, message: NOT_PAIRED }
  let signInError: Error | null
  try { signInError = await deps.signIn(file.email, file.password) } catch (e) {
    signInError = e instanceof Error ? e : new Error(String(e))
  }
  if (signInError) {
    return retryableSignIn(signInError)
      ? { ok: false, message: `Could not reach Supabase to sign in: ${signInError.message}` }
      : { ok: false, message: UNPAIRED }
  }
  try {
    return { ok: true, who: await deps.whoami() }
  } catch (e) {
    if (isUnpairedError(e)) return { ok: false, message: UNPAIRED }
    return { ok: false, message: `Could not read this print agent's outlet: ${messageOf(e)}` }
  }
}
```

- [ ] **Step 4: Write `tools/print-agent/activationClient.ts`**

```ts
// The Edge Function pos-device-activation, called from Node by the pair command. The POS app's
// twin (src/pos/sessionApi.ts) reads Vite's import.meta.env, so it cannot run here; the requests
// and replies are the same, with platform 'agent'.
import type { Pending, PollReply } from '../../src/pos/activation.ts'

export interface ActivationClient {
  request: (name: string | null) => Promise<Pending>
  poll: (p: Pending) => Promise<PollReply>
}

export function activationClient(supabaseUrl: string, anonKey: string, fetchFn: typeof fetch = fetch): ActivationClient {
  const endpoint = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/pos-device-activation`
  const call = async (body: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> => {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      body: JSON.stringify(body),
    })
    let json: Record<string, unknown> | null = null
    try { json = (await res.json()) as Record<string, unknown> } catch { /* not JSON */ }
    return { status: res.status, json }
  }
  return {
    request: async (name) => {
      const { status, json } = await call({ action: 'request', name, platform: 'agent' })
      if (status !== 200 || !json || typeof json.code !== 'string' || typeof json.secret !== 'string') {
        throw new Error(typeof json?.error === 'string' ? json.error : 'Could not start the activation. Try again.')
      }
      return { code: json.code, secret: json.secret, expiresAt: String(json.expiresAt), name }
    },
    poll: async (p) => {
      const { status, json } = await call({ action: 'poll', code: p.code, secret: p.secret })
      if (status !== 200 || !json || typeof json.status !== 'string') {
        throw new Error(typeof json?.error === 'string' ? json.error : 'Could not check the activation.')
      }
      return json as unknown as PollReply
    },
  }
}
```

- [ ] **Step 5: Write `tools/print-agent/deviceFile.ts`**

```ts
// tools/print-agent/.device.json: the print agent's device account (git-ignored, mode 0600).
// Written once by the pair command; deleting it is how the agent is paired again.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseDeviceFile, type DeviceFile } from './pairing.ts'

export const DEVICE_PATH = fileURLToPath(new URL('./.device.json', import.meta.url))

export function hasDeviceFile(path: string = DEVICE_PATH): boolean {
  return existsSync(path)
}

/** null when there is no file; throws when it is not a pairing. */
export function readDeviceFile(path: string = DEVICE_PATH): DeviceFile | null {
  if (!existsSync(path)) return null
  const file = parseDeviceFile(readFileSync(path, 'utf8'))
  if (!file) throw new Error(`${path} is not a print agent pairing. Delete it and pair again.`)
  return file
}

/** Owner-only (0600) and never over an existing pairing ('wx' fails with EEXIST). */
export function writeDeviceFile(file: DeviceFile, path: string = DEVICE_PATH): void {
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  chmodSync(path, 0o600)   // the umask cannot widen it, but an odd one could narrow the create mode
}
```

- [ ] **Step 6: Git-ignore the device file**

In `.gitignore`, replace:

```
.env.*.local
```

with:

```
.env.*.local
tools/print-agent/.device.json
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tools/print-agent/pairing.test.ts tools/print-agent/activationClient.test.ts tools/print-agent/deviceFile.test.ts`
Expected: PASS (3 files). Then `git check-ignore -v tools/print-agent/.device.json` prints `.gitignore:…:tools/print-agent/.device.json`.

- [ ] **Step 8: Commit**

```bash
git add tools/print-agent/pairing.ts tools/print-agent/pairing.test.ts tools/print-agent/activationClient.ts tools/print-agent/activationClient.test.ts tools/print-agent/deviceFile.ts tools/print-agent/deviceFile.test.ts .gitignore
git commit -m "$(cat <<'EOF'
feat(print-agent): D pairing module — request, poll, .device.json (0600), the agent's start

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The pair command and the agent on its device (pair.ts, agent.ts, branch.ts, README, .env.example)

**Files:**
- Create: `tools/print-agent/pair.ts`
- Modify: `tools/print-agent/agent.ts` (whole file below)
- Modify: `tools/print-agent/branch.ts`, `tools/print-agent/branch.test.ts`
- Rewrite: `tools/print-agent/README.md`, `tools/print-agent/.env.example`

**Interfaces:**
- Consumes: Task 2's `pairing.ts` (`agentName`, `runPair`, `startAgent`, `parseWhoami`, `isUnpairedError`, `UNPAIRED`, `messageOf`), `activationClient.ts` (`activationClient`), `deviceFile.ts` (`hasDeviceFile`, `readDeviceFile`, `writeDeviceFile`); Task 1's RPC `pos_agent_whoami()`; live `claim_print_job(p_id)`, `finish_print_job(p_id, p_ok, p_error)`, `print_routes`, `print_jobs`; `src/features/pos/guard.ts` `assertDevDatabase`; the existing print path (`renderJobDoc`, `encodeEscPosDoc`, `processJob`, `sendRaw`, `checkPrinter`, `interpretStatus`, `PAPER_STATUS`, `queryStatus`).
- Produces: `node --env-file=tools/print-agent/.env tools/print-agent/pair.ts [name]`; `node --env-file=tools/print-agent/.env tools/print-agent/agent.ts` (no `BRANCH_ID`, `AGENT_EMAIL`, `AGENT_PASSWORD`); `branch.ts` keeps `branchFilter`, `isAgentJob`, `staleMinutes`, `DRAWER_MAX_AGE_MIN` and drops `branchIdFrom`, `loginBranchProblem`.

- [ ] **Step 1: Trim the branch tests to what stays**

In `tools/print-agent/branch.test.ts`, replace the import line:

```ts
import { branchFilter, branchIdFrom, DRAWER_MAX_AGE_MIN, isAgentJob, loginBranchProblem, staleMinutes } from './branch.ts'
```

with:

```ts
import { branchFilter, DRAWER_MAX_AGE_MIN, isAgentJob, staleMinutes } from './branch.ts'
```

Delete the whole block `describe('branchIdFrom — the agent refuses to start without its branch', () => { … })` (from that line to its closing `})`, the two `it`s inside), and delete this `it` inside `describe('the branch filter', …)`:

```ts
  it('wants a login of the same branch', () => {
    expect(loginBranchProblem(DEMO.toUpperCase(), DEMO)).toBeNull()
    expect(loginBranchProblem(null, DEMO)).toMatch(/^AGENT_EMAIL has no branch/)
    expect(loginBranchProblem('another-branch', DEMO)).toMatch(/^AGENT_EMAIL is staff of another branch than BRANCH_ID/)
  })
```

- [ ] **Step 2: Rewrite `tools/print-agent/branch.ts`**

```ts
// The print agent prints for ONE outlet: the one its device was approved for (pos_agent_whoami),
// and every route, sweep and Realtime event is filtered by it. Pure, so Vitest can check it.

/** The Realtime filter for this branch's rows. */
export const branchFilter = (branchId: string): string => `branch_id=eq.${branchId}`

/** A job this agent prints: of its branch, on one of that branch's agent routes. */
export function isAgentJob(job: { branch_id?: string; route: string }, branchId: string, routes: ReadonlyMap<string, string>): boolean {
  return job.branch_id === branchId && routes.has(job.route)
}

// staleMinutes / DRAWER_MAX_AGE_MIN live in src so the iPad print host shares one definition.
export { DRAWER_MAX_AGE_MIN, staleMinutes } from '../../src/features/pos/print/stale.ts'
```

Run: `npx vitest run tools/print-agent/branch.test.ts`
Expected: PASS (the branch filter and staleMinutes tests).

- [ ] **Step 3: Create `tools/print-agent/pair.ts`**

```ts
// Pairs this computer's print agent like a tablet (spec 2026-11-22 §2): asks pos-device-activation
// for a code, shows it, polls every 5 s until HQ approves it in Craft OS → Devices (kind: Print agent),
// then keeps the device's sign-in in tools/print-agent/.device.json (git-ignored, 0600).
// Run:  node --env-file=tools/print-agent/.env tools/print-agent/pair.ts [name]
import { hostname } from 'node:os'
import { assertDevDatabase } from '../../src/features/pos/guard.ts'
import { activationClient } from './activationClient.ts'
import { hasDeviceFile, writeDeviceFile } from './deviceFile.ts'
import { agentName, runPair } from './pairing.ts'

function env(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Missing ${key} in tools/print-agent/.env`)
  return value
}

const url = env('SUPABASE_URL')
assertDevDatabase(url)
const client = activationClient(url, env('SUPABASE_ANON_KEY'))
const code = await runPair(agentName(process.argv[2], hostname()), {
  paired: () => hasDeviceFile(),
  request: (name) => client.request(name),
  poll: (p) => client.poll(p),
  save: (file) => writeDeviceFile(file),
  log: (line) => console.log(line),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
})
process.exit(code)
```

- [ ] **Step 4: Rewrite `tools/print-agent/agent.ts`**

Replace the whole file with (everything from `// Cheap LAN printers` to the end of `handleInTurn`, the sweep and the channel is the live text; the marked changes are the header, the start, the `stopUnpaired` calls and the heartbeat):

```ts
// Craft POS print agent — prints print_jobs for routes of kind 'agent' of the outlet its device was
// approved for. Sends raw ESC/POS bytes to the printer on TCP 9100.
// Pair once:  node --env-file=tools/print-agent/.env tools/print-agent/pair.ts
// Run:        node --env-file=tools/print-agent/.env tools/print-agent/agent.ts
import { createClient } from '@supabase/supabase-js'
import { renderJobDoc } from '../../src/features/pos/print/printJob.ts'
import { encodeEscPosDoc } from '../../src/features/pos/print/escpos.ts'
import { processJob, type PrintHostDeps, type PrintJob } from '../../src/features/pos/print/printHost.ts'
import { assertDevDatabase } from '../../src/features/pos/guard.ts'
import { sendRaw } from './sendRaw.ts'
import { checkPrinter, interpretStatus, PAPER_STATUS, queryStatus } from './printerStatus.ts'
import { branchFilter, isAgentJob, staleMinutes } from './branch.ts'
import { readDeviceFile } from './deviceFile.ts'
import { isUnpairedError, messageOf, parseWhoami, startAgent, UNPAIRED } from './pairing.ts'

function env(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Missing ${key} in tools/print-agent/.env`)
  return value
}

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

type AgentJob = PrintJob & { branch_id?: string; created_at?: string; attempts?: number }

/** The device was unpaired in Craft OS (or its sign-in no longer works): stop, so nobody thinks it prints. */
function stopUnpaired(): never {
  console.error(UNPAIRED)
  process.exit(1)
}

async function main(): Promise<void> {
  const url = env('SUPABASE_URL')
  assertDevDatabase(url)
  const supabase = createClient(url, env('SUPABASE_ANON_KEY'), { auth: { persistSession: false } })
  let maxAgeMin = 30
  if (process.env.MAX_AGE_MIN !== undefined) {
    const parsed = Number(process.env.MAX_AGE_MIN)
    if (Number.isFinite(parsed) && parsed > 0) maxAgeMin = parsed
    else console.warn(`Invalid MAX_AGE_MIN "${process.env.MAX_AGE_MIN}"; using 30.`)
  }
  let cols = 42
  if (process.env.TICKET_COLS !== undefined) {
    const parsed = Number(process.env.TICKET_COLS)
    if (Number.isInteger(parsed) && parsed > 0) cols = parsed
    else console.warn(`Invalid TICKET_COLS "${process.env.TICKET_COLS}"; using 42.`)
  }

  // the device account from the pair command, and the outlet it was approved for
  const whoami = async () => {
    const { data, error } = await supabase.rpc('pos_agent_whoami')
    if (error) throw error
    return parseWhoami(data)
  }
  const start = await startAgent({
    readDevice: () => readDeviceFile(),
    signIn: async (email, password) => (await supabase.auth.signInWithPassword({ email, password })).error,
    whoami,
  })
  if (!start.ok) {
    console.error(start.message)
    process.exit(1)
  }
  const branchId = start.who.outletId
  console.log(`Paired as "${start.who.deviceName}" — printing for ${start.who.outletName}.`)
  // a banned device's refresh token fails: Supabase signs it out
  supabase.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') stopUnpaired() })
  // every minute: Devices shows the agent as seen, and an unpairing stops it within a minute
  setInterval(() => {
    whoami().catch((e) => {
      if (isUnpairedError(e)) stopUnpaired()
      console.warn(`Could not check the pairing: ${messageOf(e)}`)
    })
  }, 60_000)

  const { data: routes, error: routeError } = await supabase
    .from('print_routes')
    .select('name, address')
    .eq('kind', 'agent')
    .eq('branch_id', branchId)
  if (routeError) throw routeError
  const addressOf = new Map<string, string>((routes ?? []).map((r: { name: string; address: string }) => [r.name, r.address]))
  console.log('agent routes:', Object.fromEntries(addressOf))
  console.log('Routes are read at startup; restart the agent after changing print_routes.')
  if (addressOf.size === 0) {
    console.warn("No route has kind 'agent', so there is nothing to print. Waiting; point a route at the agent and restart.")
  }

  // Cheap LAN printers accept one connection at a time: a second ticket sent while
  // the first is still open gets ECONNRESET (seen on the ZyWell ZY301, 2026-10-22,
  // when an order's Bar and Kitchen tickets went to the same printer 30 ms apart).
  // So sends to one address are queued; different printers still print in parallel.
  // The status queries share the queue: they are connections to the same printer.
  const printerQueues = new Map<string, Promise<void>>()
  const printChecked = async (address: string, bytes: Uint8Array): Promise<void> => {
    const before = await checkPrinter(address)
    for (const w of before.warnings) console.warn(`${address}: ${w}`)
    if (!before.ok) throw new Error(`Not sent: ${before.reason}`)
    await sendRaw(address, bytes)
    // A roll that runs out mid-ticket leaves a partial or blank ticket behind:
    // count it as failed so staff reprint it, rather than as printed.
    const after = interpretStatus(null, await queryStatus(address, PAPER_STATUS))
    if (!after.ok) throw new Error(`Paper ran out while printing — check the ticket and reprint (${after.reason})`)
  }
  const sendInTurn = (address: string, bytes: Uint8Array): Promise<void> => {
    const turn = (printerQueues.get(address) ?? Promise.resolve()).then(() => printChecked(address, bytes))
    printerQueues.set(address, turn.catch(() => undefined))
    return turn
  }

  // Never rejects: it is called from the sweep, a Realtime callback and an interval.
  const handle = async (job: AgentJob): Promise<void> => {
    if (!isAgentJob(job, branchId, addressOf)) return
    const id8 = job.id.slice(0, 8)
    // An old job never tried stays pending for staff to decide; a drawer kick is old after 2 minutes.
    const ageMin = staleMinutes(job, Date.now(), maxAgeMin)
    if (ageMin !== null) {
      const kind = job.payload?.kind
      console.log(`skipped old ${kind === 'drawer' ? 'drawer kick' : kind === 'receipt' ? 'receipt' : 'ticket'} ${job.route} ${id8} (${Math.round(ageMin)} min)`)
      return
    }
    // Per call, so a concurrent handler of the same job cannot mislabel the log.
    let printed = false
    const deps: PrintHostDeps = {
      claim: async (id) => {
        const { data, error } = await supabase.rpc('claim_print_job', { p_id: id })
        if (error) { if (isUnpairedError(error)) stopUnpaired(); throw error }
        return data === true
      },
      finish: async (id, ok, err) => {
        const { error } = await supabase.rpc('finish_print_job', { p_id: id, p_ok: ok, p_error: err })
        if (error) { if (isUnpairedError(error)) stopUnpaired(); throw error }
      },
      print: async (j) => {
        await sendInTurn(addressOf.get(j.route)!, encodeEscPosDoc(renderJobDoc(j.payload, cols)))
        printed = true
      },
    }
    try {
      const result = await processJob(job, deps)
      console.log(new Date().toISOString(), job.route, id8, result)
    } catch (e) {
      if (printed) console.error(`${job.route} ${id8} printed but could not record it: ${errMessage(e)}`)
      else console.error(`${job.route} ${id8} failed: ${errMessage(e)}`)
    }
  }

  // One job at a time per route, in the order they arrive: Realtime delivers a transaction's inserts in
  // insert order and the sweep reads created_at, then seq — so a drawer kick queued with its receipt
  // (same transaction, same created_at) opens the drawer before the receipt prints (W4 spec §5).
  // handle never rejects, so the chain never breaks.
  const routeTurns = new Map<string, Promise<void>>()
  const handleInTurn = (job: AgentJob): Promise<void> => {
    const turn = (routeTurns.get(job.route) ?? Promise.resolve()).then(() => handle(job))
    routeTurns.set(job.route, turn.catch(() => undefined))
    return turn
  }

  // Realtime can drop events while reconnecting; the sweep catches anything missed.
  let sweeping = false
  const sweep = async (): Promise<void> => {
    if (sweeping || addressOf.size === 0) return
    sweeping = true
    try {
      const { data, error } = await supabase
        .from('print_jobs')
        .select('id, branch_id, route, payload, status, created_at, attempts')
        .eq('branch_id', branchId)
        .eq('status', 'pending')
        .in('route', [...addressOf.keys()])
        .order('created_at')
        .order('seq')
      if (error) {
        console.error('sweep failed:', error.message)
        return
      }
      for (const job of (data ?? []) as AgentJob[]) await handleInTurn(job)
    } catch (e) {
      console.error('sweep failed:', errMessage(e))
    } finally {
      sweeping = false
    }
  }

  supabase
    .channel(`print-agent-${crypto.randomUUID()}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'print_jobs', filter: branchFilter(branchId) }, (p) => {
      void handleInTurn(p.new as AgentJob)
    })
    .subscribe((status) => {
      console.log('realtime:', status)
      if (status === 'SUBSCRIBED') void sweep()
    })
  setInterval(() => void sweep(), 10_000)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
```

- [ ] **Step 5: Rewrite `tools/print-agent/.env.example`**

```
# Copy to tools/print-agent/.env (git-ignored) and fill in. DEV project only.
# The agent signs in as its own device (tools/print-agent/.device.json, written by pair.ts):
# no staff login and no branch id here.
SUPABASE_URL=https://<dev-project-ref>.supabase.co
SUPABASE_ANON_KEY=<dev anon key>
# Optional printing settings
TICKET_COLS=48   # paper width in characters; 48 on the ZyWell ZY301
MAX_AGE_MIN=30   # tickets older than this many minutes are skipped (left pending) instead of printed on start
```

- [ ] **Step 6: Rewrite `tools/print-agent/README.md`**

````markdown
# Craft POS print agent

Prints the kitchen tickets, receipts and Z reports of **one outlet** on LAN printers
(raw ESC/POS on TCP 9100). It replaces the iPad's print host when an outlet has an
always-on computer next to its printers.

The agent is a **device**, like a POS tablet: it pairs once, HQ approves it in Craft OS
for one outlet, and from then on it prints that outlet's jobs on that outlet's routes of
kind `agent`. It needs no staff login.

## Setup

1. Copy `.env.example` to `.env` (git-ignored) and fill in `SUPABASE_URL` and
   `SUPABASE_ANON_KEY`. **Dev project only.** `TICKET_COLS` and `MAX_AGE_MIN` are optional.
2. Pair, from the repo root (the name is optional; the default is this computer's name):

   ```bash
   node --env-file=tools/print-agent/.env tools/print-agent/pair.ts "Cheras bar computer"
   ```

   It prints `Pairing code: ABC-123 — approve it in Craft OS → Devices (kind: Print agent).`
   HQ opens Craft OS → POS → Devices → Pending requests, checks the code, picks the outlet,
   keeps the kind **Print agent** and approves. The command then writes
   `tools/print-agent/.device.json` (git-ignored, readable only by you) and says
   `Paired. Start the agent with: …`. A rejected or expired request says so; run the command
   again for a new code.
3. Run:

   ```bash
   node --env-file=tools/print-agent/.env tools/print-agent/agent.ts
   ```

To pair again (another outlet, a new computer): unpair the old agent in Devices, delete
`tools/print-agent/.device.json`, run the pair command. When HQ unpairs the agent it stops
with `This print agent was unpaired — run the pair command again.` (within a minute).
Never copy `.device.json` to another computer or into chat: it is the agent's password.

Routes are read at start: restart the agent after changing a route in POS settings.

The agent prints with this repo's print code (`src/features/pos/print/`): after a POS update that changes
receipts, tickets or the drawer, pull the branch and restart the agent — and run that update's SQL first
(since W4 the agent reads `print_jobs.seq`, so a drawer kick goes out before its receipt). A drawer kick
older than 2 minutes is not sent: the server marks it failed ("Too late to open the drawer.") so the drawer
never opens with nobody at the till. Keep the agent computer's clock synced.
Tickets older than `MAX_AGE_MIN` minutes are left pending (the iPad shows them as
waiting) instead of printed on start. `TICKET_COLS` is the paper width in characters
(48 on the ZyWell ZY301).
````

- [ ] **Step 7: Run the agent tests and a parse check (no network: no env)**

Run: `npx vitest run tools/print-agent`
Expected: PASS (branch, printerStatus, pairing, activationClient, deviceFile).

Run: `env -u SUPABASE_URL -u SUPABASE_ANON_KEY node tools/print-agent/pair.ts; echo "exit $?"`
Expected: `Error: Missing SUPABASE_URL in tools/print-agent/.env` and `exit 1` (Node loaded every import with type stripping; nothing was requested).

Run: `env -u SUPABASE_URL -u SUPABASE_ANON_KEY node tools/print-agent/agent.ts; echo "exit $?"`
Expected: `Error: Missing SUPABASE_URL in tools/print-agent/.env` and `exit 1`.

Run: `grep -n "BRANCH_ID\|AGENT_EMAIL\|AGENT_PASSWORD" tools/print-agent/*.ts tools/print-agent/README.md tools/print-agent/.env.example`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add tools/print-agent/pair.ts tools/print-agent/agent.ts tools/print-agent/branch.ts tools/print-agent/branch.test.ts tools/print-agent/README.md tools/print-agent/.env.example
git commit -m "$(cat <<'EOF'
feat(print-agent): D pair command; the agent signs in as its device and prints for its outlet

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: SQL — the switch-over: staff logins lose the till (X1–X3)

**Files:**
- Create: `supabase/migration-2026-11-22-pos-switchover.sql`
- Create: `supabase/migration-2026-11-22-pos-switchover-verify.sql`
- Modify: `src/features/pos/sqlSafeUpdate.test.ts` (a new `it` after Task 1's)

**Interfaces:**
- Consumes (live): `pos_ctx()`, `pos_print_branch()`, `pos_session_branch()` (migration-2026-10-29-pos-device-till.sql lines 82–120, 139–157, 172–184); `pos_outlet_open`, `pos_staff_may_work`, `pos_staff_sessions`; Task 1's `pos_agent_whoami()` (STOP guard and verify); W7's `set_items_served(uuid[], boolean)` (STOP guard: this file is the last of the chain); front-of-house RPCs `open_table(uuid, integer, integer)`, `place_counter_order(uuid, text, integer, jsonb, uuid, uuid, uuid, integer)`, `checkout_bill(uuid, jsonb, uuid)`, `pos_open_bill_summaries(uuid)`, `claim_print_job(uuid)`, `finish_print_job(uuid, boolean, text)`, `insert_test_print(text, uuid)`; back office `save_receipt_settings(uuid, jsonb)`, `save_shift_settings(uuid, integer)`, `save_lock_settings(uuid, integer)`, `pos_report_sales(uuid[], date, date)`, `pos_outlet_approvers(uuid)`, `pos_devices_list()`, `pos_unpair_device(uuid)`, `set_my_pos_pin(text, text)`, `pos_start_session(uuid, text)`.
- Produces: after this file a caller with no `pos_devices` row (a staff login, or no login) gets `device_unpaired` from `pos_ctx()` (so from every RPC on `pos_my_branch()` / `pos_actor()`) and from `pos_print_branch()`; `pos_session_branch()` is null for it. Devices behave exactly as before. Result row `pos switchover applied`; verify `VERIFY OK`.

- [ ] **Step 1: Write the failing test**

In `src/features/pos/sqlSafeUpdate.test.ts`, add this `it` right after Task 1's `it('scans the D migration: …')`, before the `})` that closes the describe:

```ts
  it('scans the C3 migration: the transition gone from pos_ctx, pos_print_branch and pos_session_branch; grants kept; a STOP guard', () => {
    const sql = readFileSync(new URL('migration-2026-11-22-pos-switchover.sql', SUPABASE), 'utf8')
    const bodies = functionBodies(sql)
    expect(bodies.map((b) => b.name).sort()).toEqual(['pos_ctx', 'pos_print_branch', 'pos_session_branch'])
    const body = (n: string) => bodies.find((b) => b.name === n)?.body ?? ''
    // no staff-login path left (strings are emptied by the scanner)
    expect(body('pos_ctx')).not.toMatch(/\bfrom staff\b/)
    expect(body('pos_ctx')).toContain("if not found then raise exception ''; end if;")
    expect(body('pos_ctx')).toContain('pos_staff_may_work(v_ses.staff_id, v_dev.branch_id)')      // the device path is the live one
    expect(body('pos_print_branch')).not.toContain('pos_my_branch(')
    expect(body('pos_print_branch')).toContain("v_dev.kind = ''")
    expect(body('pos_session_branch')).not.toMatch(/\bfrom staff\b/)
    expect(body('pos_session_branch')).toContain('else null end')
    expect(sql).not.toMatch(/^\s*--.*TRANSITION \(removed/m)                                       // no live TRANSITION line copied over
    for (const f of ['pos_ctx', 'pos_print_branch']) {
      expect(sql).toContain(`revoke all on function ${f}() from public, anon, authenticated;`)
      expect(sql).not.toContain(`grant execute on function ${f}(`)
    }
    expect(sql).toContain('revoke all on function pos_session_branch() from public, anon;')
    expect(sql).toContain('grant execute on function pos_session_branch() to authenticated;')
    expect(sql).toMatch(/raise exception 'STOP: run migration-2026-11-22-pos-agent-pairing\.sql/)
    expect(sql).toMatch(/notify pgrst, 'reload schema';\s*select 'pos switchover applied' as result;\s*$/)
    const verify = readFileSync(new URL('migration-2026-11-22-pos-switchover-verify.sql', SUPABASE), 'utf8')
    expect(verify).toMatch(/^begin;$/m)
    expect(verify).toMatch(/select 'VERIFY OK' as result;\s*rollback;\s*$/)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts`
Expected: FAIL in `scans the C3 migration: …` — `ENOENT … migration-2026-11-22-pos-switchover.sql`.

- [ ] **Step 3: Write the migration**

Create `supabase/migration-2026-11-22-pos-switchover.sql` with exactly the text below. The three functions are copies of migration-2026-10-29-pos-device-till.sql lines 82–120, 139–157 and 172–184 with only the `-- X1` … `-- X3` lines changed (X1 also drops `v_branch` and `v_live`, which only the removed block used). Before writing, open those line ranges and check that every unmarked line below is identical to them.

```sql
-- ============================================================================
-- Craft OS — POS switch-over, C3 (2026-11-22). Run on craft-os-dev LAST in the POS chain: after
-- migration-2026-11-22-pos-feedme-habits.sql and migration-2026-11-22-pos-agent-pairing.sql, and only once
-- every print agent of the database is paired as a device (D) and printing — the server cannot tell
-- whether a staff-login agent still runs somewhere, and from here such an agent stops printing.
-- Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-11-22-pos-agent-pairing-switchover.md
-- Design: docs/superpowers/specs/2026-11-22-pos-agent-pairing-switchover-design.md (§3);
--         docs/superpowers/specs/2026-10-29-pos-devices-outlets-design.md §4 ("Staff email logins can no
--         longer call front-of-house RPCs")
--
-- X1  pos_ctx(): the C1 transition is gone. A caller with no pos_devices row — a staff email login, or no
--     login at all — gets device_unpaired, so every front-of-house RPC (all of them reach pos_ctx through
--     pos_my_branch() or pos_actor(), or call it) refuses it. A device is checked exactly as before.
-- X2  pos_print_branch(): a staff login no longer prints for its home branch (device_unpaired). The print
--     agent pairs as a device (D); the printing tablet prints as before. insert_test_print with an outlet
--     (POS Settings → Test print) keeps its back-office path (pos_manages_outlet).
-- X3  pos_session_branch(): null for a staff login, so the till's direct writes (sold out, pause QR) need a
--     device session or an outlet the caller manages (pos_manages_outlet), as the policies already allow.
-- The back office is unchanged: settings, menu editor, reports, Devices, outlets, staff outlets, PIN set /
-- clear and reads (pos_readable_branches = staff_outlet_scope) never used these three functions' staff paths.
-- Verify scripts: those that run the till as a staff login pass only before this file — the pre-device ones
-- (menu, ordering, catalogs, checkout, menu-editor, shifts, slots-photos, hardening, frontend, outlets),
-- menu-picks, device-till's "C1 transition" block and qr-table-cart L2 / L3. They stay as they are: each runs
-- right after its own file in the chain. After this file run migration-2026-11-22-pos-switchover-verify.sql and
-- the device-fixture verifies.
-- Re-run hazard: re-running migration-2026-10-29-pos-device-till.sql (or the older devices file) puts the
-- transition back — re-run this file after it.
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_agent_whoami()') is null then
    raise exception 'STOP: run migration-2026-11-22-pos-agent-pairing.sql first, and pair every print agent before this file (pos_agent_whoami is missing)';
  end if;
  if to_regprocedure('set_items_served(uuid[],boolean)') is null then
    raise exception 'STOP: run migration-2026-11-22-pos-feedme-habits.sql first (set_items_served is missing)';
  end if;
end $$;

-- ── X1. The device context: devices only ─────────────────────────────────────
create or replace function pos_ctx(out device_id uuid, out branch_id uuid, out staff_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dev    pos_devices;
  v_ses    pos_staff_sessions;
begin
  select * into v_dev from pos_devices d where d.id = auth.uid();
  if not found then raise exception 'device_unpaired'; end if;                -- X1: a staff login (or none) has no till
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

-- ── X2. Printing: devices only ───────────────────────────────────────────────
-- A print agent, or the outlet's printing tablet (locked or not), prints for its outlet.
create or replace function pos_print_branch() returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dev pos_devices;
begin
  select * into v_dev from pos_devices d where d.id = auth.uid();
  if not found then
    raise exception 'device_unpaired';            -- X2: a staff login no longer prints (the print agent pairs: D)
  end if;
  if v_dev.revoked_at is not null then raise exception 'device_unpaired'; end if;
  if not (v_dev.kind = 'print_agent' or (v_dev.kind = 'pos' and v_dev.prints)) then raise exception 'not_printing_tablet'; end if;
  if not current_setting('transaction_read_only')::boolean then              -- as in pos_ctx
    update pos_devices set last_seen_at = now()
     where id = v_dev.id and (last_seen_at is null or last_seen_at < now() - interval '30 seconds');
  end if;
  return v_dev.branch_id;
end $$;
revoke all on function pos_print_branch() from public, anon, authenticated;

-- ── X3. The till's direct writes: a device session only ──────────────────────
-- The outlet of a till write made directly on a table (sold out, pause QR): a POS device with an
-- open session of someone who may still work there, at an open outlet. Non-writing (used by RLS).
create or replace function pos_session_branch() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select case when exists (select 1 from pos_devices d where d.id = auth.uid())
              then (select d.branch_id from pos_devices d
                     where d.id = auth.uid() and d.kind = 'pos' and d.revoked_at is null and pos_outlet_open(d.branch_id)
                       and exists (select 1 from pos_staff_sessions s
                                    where s.device_id = d.id and s.ended_at is null and pos_staff_may_work(s.staff_id, d.branch_id)))
              else null end                                                   -- X3: a staff login has no till session
$$;
revoke all on function pos_session_branch() from public, anon;
grant execute on function pos_session_branch() to authenticated;

notify pgrst, 'reload schema';
select 'pos switchover applied' as result;
```

- [ ] **Step 4: Write the verify**

Create `supabase/migration-2026-11-22-pos-switchover-verify.sql` with exactly:

```sql
-- Self-check for the POS switch-over (C3). Run on craft-os-dev after migration-2026-11-22-pos-switchover.sql.
-- Everything is rolled back. Success = a result row "VERIFY OK".
-- Sections (one DO block each, ids in the temp table fixture): FIXTURE; X1 a staff login (cashier and HQ) and
-- no login are refused at the till and the printers; X2 a POS device with a session still runs the till;
-- X3 print agents claim their own outlet's jobs only; X4 the back office still works for a staff login.
-- Outlets VERIFY C3 A (tables C1, C2, a Bar route of kind agent, one product on a dine-in / takeaway catalog)
-- and VERIFY C3 B (a Bar route). A cashier of A with a PIN signed in on a POS tablet of A that does not print;
-- print agents on A and on B; one test job per outlet queued from the back office by the dev owner login.
begin;

create function pg_temp.expect_error(p_sql text, p_message text, p_label text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm is distinct from p_message then
      raise exception 'FAIL %: got "%" (expected "%")', p_label, sqlerrm, p_message;
    end if;
    return;
  end;
  raise exception 'FAIL %: no error (expected "%")', p_label, p_message;
end $$;
create function pg_temp.act(p_user uuid) returns void
language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
create temp table fixture (k text primary key, v uuid);
create function pg_temp.put(p_k text, p_v uuid) returns void
language sql as $$ insert into pg_temp.fixture(k, v) values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.id(p_k text) returns uuid
language sql as $$ select v from pg_temp.fixture where k = p_k $$;
create function pg_temp.items() returns jsonb
language sql as $$
  select jsonb_build_array(jsonb_build_object('productId', pg_temp.id('latte'), 'variantId', pg_temp.id('latte_v'), 'qty', 1))
$$;

-- ── FIXTURE ──
do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_cash  uuid := 'eeeeeeee-0000-0000-0000-0000000c3c01';
  v_pos   uuid := 'eeeeeeee-0000-0000-0000-0000000c3d01';
  v_ag_a  uuid := 'eeeeeeee-0000-0000-0000-0000000c3d02';
  v_ag_b  uuid := 'eeeeeeee-0000-0000-0000-0000000c3d03';
  v_a uuid; v_b uuid; v_t uuid; v_cat uuid; v_catalog uuid; v_p uuid; v_v uuid; v_res jsonb; i integer;
begin
  -- the role defaults decide (owner: every outlet and access_settings; staff: pos_login, no access_settings)
  update system_role_permissions set permissions = permissions - 'pos_login' - 'all_branches' - 'access_settings' - 'pos_supervise'
   where true;
  insert into branches(name, address) values ('VERIFY C3 A', 'a') returning id into v_a;
  insert into branches(name, address) values ('VERIFY C3 B', 'b') returning id into v_b;
  perform pg_temp.put('a', v_a); perform pg_temp.put('b', v_b);
  for i in 1..2 loop
    insert into dining_tables(branch_id, label, sort_order) values (v_a, 'C' || i, i) returning id into v_t;
    perform pg_temp.put('c' || i, v_t);
  end loop;
  insert into print_routes(branch_id, name, kind, address) values
    (v_a, 'Bar', 'agent', '127.0.0.1:9100'), (v_b, 'Bar', 'agent', '127.0.0.1:9100');
  insert into branch_pos_settings(branch_id, receipt_route) values (v_a, 'Bar');
  insert into menu_categories(name, sort_order) values ('VERIFY C3 DRINKS', 933) returning id into v_cat;
  insert into menu_catalogs(name, sort_order) values ('VERIFY C3 MENU', 933) returning id into v_catalog;
  insert into menu_products(name, category_id, sst_rate_bp, print_route) values ('Verify C3 Latte', v_cat, 600, 'Bar') returning id into v_p;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_p, '', 'Regular', 1000) returning id into v_v;
  insert into catalog_products(catalog_id, product_id, availability) values (v_catalog, v_p, 'all');
  insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (v_catalog, v_v, 1000);
  insert into branch_catalogs(branch_id, role, catalog_id) values (v_a, 'dine_in', v_catalog), (v_a, 'takeaway', v_catalog);
  perform pg_temp.put('latte', v_p); perform pg_temp.put('latte_v', v_v);
  insert into auth.users (id) values (v_cash), (v_pos), (v_ag_a), (v_ag_b);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_cash, 'Verify C3 Cashier', 'trainee', true, current_date, 'staff', v_a);
  perform pg_temp.act(v_cash);
  if not coalesce((set_my_pos_pin('1111', null)->>'ok')::boolean, false) then raise exception 'FAIL fixture: PIN of the cashier'; end if;
  insert into pos_devices(id, branch_id, kind, name, platform, prints, approved_by) values
    (v_pos,  v_a, 'pos', 'C3 Counter', 'ipad', false, v_owner),
    (v_ag_a, v_a, 'print_agent', 'C3 Agent A', 'agent', false, v_owner),
    (v_ag_b, v_b, 'print_agent', 'C3 Agent B', 'agent', false, v_owner);
  perform pg_temp.put('owner', v_owner); perform pg_temp.put('cashier', v_cash); perform pg_temp.put('pos', v_pos);
  perform pg_temp.put('ag_a', v_ag_a); perform pg_temp.put('ag_b', v_ag_b);
  perform pg_temp.act(v_pos);
  v_res := pos_start_session(v_cash, '1111');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: cashier sign-in: %', v_res; end if;
  -- one test job per outlet, from POS Settings → Test print (the back-office path)
  perform pg_temp.act(v_owner);
  perform pg_temp.put('job_a', insert_test_print('Bar', v_a));
  perform pg_temp.put('job_b', insert_test_print('Bar', v_b));
end $$;

-- ── X1. A staff email login — a cashier of A, or HQ — and no login: refused at the till and the printers ──
do $$
declare
  v_a     uuid := pg_temp.id('a');
  v_c1    uuid := pg_temp.id('c1');
  v_job_a uuid := pg_temp.id('job_a');
  v_items jsonb := pg_temp.items();
  n       integer;
  r       record;
begin
  for r in select * from (values ('cashier'), ('owner')) x(who) loop
    perform pg_temp.act(pg_temp.id(r.who));
    perform pg_temp.expect_error(format('select open_table(%L, 2)', v_c1), 'device_unpaired', 'X1 open_table, ' || r.who);
    perform pg_temp.expect_error(format('select place_counter_order(%L, %L, 2, %L::jsonb, gen_random_uuid())', v_c1, 'dine_in', v_items),
                                 'device_unpaired', 'X1 place_counter_order, ' || r.who);
    perform pg_temp.expect_error('select checkout_bill(gen_random_uuid(), ''[]''::jsonb, gen_random_uuid())', 'device_unpaired',
                                 'X1 checkout_bill, ' || r.who);
    perform pg_temp.expect_error(format('select count(*) from pos_open_bill_summaries(%L)', v_a), 'device_unpaired',
                                 'X1 pos_open_bill_summaries, ' || r.who);
    perform pg_temp.expect_error(format('select claim_print_job(%L)', v_job_a), 'device_unpaired', 'X1 claim_print_job, ' || r.who);
    perform pg_temp.expect_error(format('select finish_print_job(%L, true, null)', v_job_a), 'device_unpaired', 'X1 finish_print_job, ' || r.who);
    perform pg_temp.expect_error('select insert_test_print(''Bar'')', 'device_unpaired', 'X1 a test print with no outlet, ' || r.who);
    if pos_session_branch() is not null then raise exception 'FAIL X1 pos_session_branch of %: %', r.who, pos_session_branch(); end if;
  end loop;
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.expect_error(format('select open_table(%L, 2)', v_c1), 'device_unpaired', 'X1 open_table, no login');
  perform pg_temp.expect_error(format('select claim_print_job(%L)', v_job_a), 'device_unpaired', 'X1 claim_print_job, no login');
  if (select status from print_jobs where id = v_job_a) is distinct from 'pending' then raise exception 'FAIL X1 the job left pending'; end if;
  if exists (select 1 from bills where branch_id = v_a) then raise exception 'FAIL X1 a refused call opened a bill'; end if;
  -- a till write on a table: the cashier's home table, which they do not manage
  perform pg_temp.act(pg_temp.id('cashier'));
  set local role authenticated;
  update dining_tables set qr_paused = true where id = v_c1;
  get diagnostics n = row_count;
  reset role;
  if n <> 0 then raise exception 'FAIL X1 a staff login paused QR on its home table'; end if;
end $$;

-- ── X2. A POS tablet with a session still runs the till; locked, it gets no_session ──
do $$
declare
  v_a     uuid := pg_temp.id('a');
  v_bill  uuid;
  v_order uuid;
begin
  perform pg_temp.act(pg_temp.id('pos'));
  if pos_session_branch() is distinct from v_a then raise exception 'FAIL X2 pos_session_branch: %', pos_session_branch(); end if;
  v_bill := open_table(pg_temp.id('c1'), 2);
  if (select branch_id from bills where id = v_bill) is distinct from v_a then raise exception 'FAIL X2 open_table'; end if;
  perform pg_temp.put('bill', v_bill);
  v_order := place_counter_order(pg_temp.id('c2'), 'dine_in', 2, pg_temp.items(), gen_random_uuid());
  if (select placed_by from orders where id = v_order) is distinct from pg_temp.id('cashier')
     or (select device_id from orders where id = v_order) is distinct from pg_temp.id('pos') then
    raise exception 'FAIL X2 the order (placed by the cashier, on the tablet)';
  end if;
  perform pg_temp.expect_error(format('select claim_print_job(%L)', pg_temp.id('job_a')), 'not_printing_tablet', 'X2 a tablet that does not print');
  update pos_staff_sessions set ended_at = now(), end_reason = 'locked' where device_id = pg_temp.id('pos') and ended_at is null;
  perform pg_temp.expect_error(format('select count(*) from pos_open_bill_summaries(%L)', v_a), 'no_session', 'X2 a locked tablet');
end $$;

-- ── X3. Print agents: own outlet only, no staff session needed; whoami ──
do $$
declare
  v_job_a uuid := pg_temp.id('job_a');
  v_job_b uuid := pg_temp.id('job_b');
begin
  perform pg_temp.act(pg_temp.id('ag_a'));
  if (pos_agent_whoami()->>'outletId')::uuid is distinct from pg_temp.id('a') then raise exception 'FAIL X3 whoami of agent A'; end if;
  if claim_print_job(v_job_b) then raise exception 'FAIL X3 agent A claimed outlet B''s job'; end if;
  if not claim_print_job(v_job_a) then raise exception 'FAIL X3 agent A could not claim its job'; end if;
  perform finish_print_job(v_job_a, true, null);
  if (select status from print_jobs where id = v_job_a) is distinct from 'printed' then raise exception 'FAIL X3 finish'; end if;
  perform pg_temp.act(pg_temp.id('ag_b'));
  if not claim_print_job(v_job_b) then raise exception 'FAIL X3 agent B could not claim its job'; end if;
end $$;

-- ── X4. The back office for a staff login: settings, test print, reports, approvers, devices, reads, My PIN,
--    unpairing an agent (which then stops) ──
do $$
declare
  v_a     uuid := pg_temp.id('a');
  v_bill  uuid := pg_temp.id('bill');
  v_res   jsonb;
  n_routes integer; n_bills integer;
begin
  perform pg_temp.act(pg_temp.id('owner'));
  perform save_receipt_settings(v_a, '{"receiptTitle":"Verify C3"}');
  if (select receipt_title from branches where id = v_a) is distinct from 'Verify C3' then raise exception 'FAIL X4 save_receipt_settings'; end if;
  perform save_shift_settings(v_a, 5000);
  if (select cash_variance_limit_sen from branch_pos_settings where branch_id = v_a) is distinct from 5000 then raise exception 'FAIL X4 save_shift_settings'; end if;
  perform save_lock_settings(v_a, 15);
  if (select idle_lock_minutes from branch_pos_settings where branch_id = v_a) is distinct from 15 then raise exception 'FAIL X4 save_lock_settings'; end if;
  if insert_test_print('Bar', v_a) is null then raise exception 'FAIL X4 test print from POS Settings'; end if;
  if pos_report_sales(array[v_a], current_date, current_date) is null then raise exception 'FAIL X4 the sales report'; end if;
  perform count(*) from pos_outlet_approvers(v_a);
  if (select count(*) from pos_devices_list() l where l.id in (pg_temp.id('pos'), pg_temp.id('ag_a'), pg_temp.id('ag_b'))) <> 3 then
    raise exception 'FAIL X4 Devices lists the outlet devices';
  end if;
  set local role authenticated;
  select count(*) into n_routes from print_routes where branch_id = v_a;
  select count(*) into n_bills from bills where id = v_bill;
  reset role;
  if n_routes <> 1 or n_bills <> 1 then raise exception 'FAIL X4 HQ reads % routes and % bills of A (expected 1, 1)', n_routes, n_bills; end if;
  -- My PIN in Craft OS, for a staff login
  perform pg_temp.act(pg_temp.id('cashier'));
  v_res := set_my_pos_pin('2222', '1111');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL X4 My PIN: %', v_res; end if;
  -- Devices → Unpair: the agent is refused at once
  perform pg_temp.act(pg_temp.id('owner'));
  perform pos_unpair_device(pg_temp.id('ag_b'));
  perform pg_temp.act(pg_temp.id('ag_b'));
  perform pg_temp.expect_error('select pos_agent_whoami()', 'device_unpaired', 'X4 an unpaired agent asks who it is');
  perform pg_temp.expect_error(format('select claim_print_job(%L)', pg_temp.id('job_b')), 'device_unpaired', 'X4 an unpaired agent claims');
end $$;

select 'VERIFY OK' as result;
rollback;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migration-2026-11-22-pos-switchover.sql supabase/migration-2026-11-22-pos-switchover-verify.sql src/features/pos/sqlSafeUpdate.test.ts
git commit -m "$(cat <<'EOF'
feat(pos): C3 switch-over SQL — staff logins lose the till and the printers; devices only

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Craft OS `/pos` — the notice, with My PIN; where staff set a PIN

**Files:**
- Create: `src/features/pos/order/posAppUrl.ts`, `src/features/pos/order/posAppUrl.test.ts`
- Rewrite: `src/features/pos/order/PosPage.tsx`
- Create: `src/features/pos/order/PosPage.test.tsx`
- Modify: `src/App.tsx` (the `/pos` route, line 255)
- Modify: `src/features/pos/checkout/CheckoutSettings.tsx` (two strings in `ApproversSection`, lines 346 and 352)
- Modify: `.env.example`

**Interfaces:**
- Consumes: `MyPinDialog` (`src/features/pos/checkout/MyPinDialog.tsx`, `{ onClose: () => void }`; it calls `set_my_pos_pin`, unchanged by C3); `AppLayout` (`src/App.tsx` line 34); the env setting `VITE_POS_APP_URL` (dev `https://craft-pos-dev.vercel.app`; unset in tests).
- Produces: `posAppUrl(raw: string | undefined | null): string | null`; `PosPage({ appUrl }: { appUrl?: string | null })` — the default reads `import.meta.env.VITE_POS_APP_URL`. Nav is unchanged: `Register` → `/pos` (the notice), `Reports`, `Menu`, `POS Settings`, `Devices`.

- [ ] **Step 1: Write the failing tests**

Create `src/features/pos/order/posAppUrl.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { posAppUrl } from './posAppUrl'

describe('posAppUrl — the POS app address from VITE_POS_APP_URL', () => {
  it('keeps an http(s) address, trimmed, without a trailing slash', () => {
    expect(posAppUrl('https://craft-pos-dev.vercel.app')).toBe('https://craft-pos-dev.vercel.app')
    expect(posAppUrl('  https://craft-pos-dev.vercel.app/  ')).toBe('https://craft-pos-dev.vercel.app')
    expect(posAppUrl('http://localhost:5179')).toBe('http://localhost:5179')
  })
  it('is null when unset or not a web address', () => {
    expect(posAppUrl(undefined)).toBeNull()
    expect(posAppUrl(null)).toBeNull()
    expect(posAppUrl('')).toBeNull()
    expect(posAppUrl('craft-pos-dev.vercel.app')).toBeNull()
    expect(posAppUrl('javascript:alert(1)')).toBeNull()
  })
})
```

Create `src/features/pos/order/PosPage.test.tsx`:

```tsx
// @vitest-environment jsdom
// Craft OS /pos after C3: the till moved to the POS app; the page says where and keeps My PIN.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

// MyPinDialog reaches Supabase through checkoutApi
vi.mock('../checkout/MyPinDialog', () => ({ default: () => <div>My POS PIN dialog</div> }))

import PosPage from './PosPage'

afterEach(cleanup)

describe('PosPage — the POS has moved', () => {
  it('shows the notice, the address as a link and how to activate a tablet', () => {
    render(<PosPage appUrl="https://craft-pos-dev.vercel.app" />)
    expect(screen.getByRole('heading', { name: 'The POS has moved to its own app.' })).toBeTruthy()
    const link = screen.getByRole('link', { name: 'https://craft-pos-dev.vercel.app' })
    expect(link.getAttribute('href')).toBe('https://craft-pos-dev.vercel.app')
    expect(screen.getByText('Activate a tablet: open the address on it and approve it in Devices.')).toBeTruthy()
  })
  it('without an address: the fallback text, no link', () => {
    render(<PosPage appUrl={null} />)
    expect(screen.getByText('Ask HQ for the POS app address.')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })
  it('keeps My PIN', () => {
    render(<PosPage appUrl={null} />)
    expect(screen.getByText('Staff sign in on the tablet with their name and POS PIN.')).toBeTruthy()
    expect(screen.queryByText('My POS PIN dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'My PIN' }))
    expect(screen.getByText('My POS PIN dialog')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/pos/order/posAppUrl.test.ts src/features/pos/order/PosPage.test.tsx`
Expected: FAIL — `Failed to resolve import "./posAppUrl"`; PosPage's tests fail (it renders the till, which needs `useAuth`).

- [ ] **Step 3: Write `src/features/pos/order/posAppUrl.ts`**

```ts
/** The POS app's address for Craft OS /pos (VITE_POS_APP_URL; dev https://craft-pos-dev.vercel.app).
 *  Null when unset or not an http(s) address, so the page shows its fallback text instead of a link. */
export function posAppUrl(raw: string | undefined | null): string | null {
  const value = raw?.trim().replace(/\/+$/, '') ?? ''
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : null
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Rewrite `src/features/pos/order/PosPage.tsx`**

```tsx
// src/features/pos/order/PosPage.tsx
import { useState } from 'react'
import MyPinDialog from '../checkout/MyPinDialog'
import { posAppUrl } from './posAppUrl'

/** /pos in Craft OS since C3: front-of-house runs only on activated devices (the POS app), so this
 *  page points there. It keeps My PIN — the only place staff set the PIN they sign in with. */
export default function PosPage({ appUrl = posAppUrl(import.meta.env.VITE_POS_APP_URL as string | undefined) }: { appUrl?: string | null }) {
  const [pinOpen, setPinOpen] = useState(false)
  return (
    <div className="mx-auto max-w-xl space-y-4 p-6">
      <h1 className="text-xl font-semibold text-brown-dark">The POS has moved to its own app.</h1>
      {appUrl
        ? <p><a href={appUrl} target="_blank" rel="noreferrer" className="break-all font-medium text-brown-dark underline">{appUrl}</a></p>
        : <p className="text-sm text-brown-muted">Ask HQ for the POS app address.</p>}
      <p className="text-sm text-brown-dark">Activate a tablet: open the address on it and approve it in Devices.</p>
      <div className="space-y-2 border-t border-border pt-4">
        <p className="text-sm text-brown-muted">Staff sign in on the tablet with their name and POS PIN.</p>
        <button type="button" onClick={() => setPinOpen(true)} className="min-h-12 rounded-xl border border-border-mid px-4 text-brown-dark">My PIN</button>
      </div>
      {pinOpen && <MyPinDialog onClose={() => setPinOpen(false)} />}
    </div>
  )
}
```

- [ ] **Step 5: The route inside the Craft OS layout**

In `src/App.tsx`, replace:

```tsx
      <Route path="/pos" element={<ProtectedRoute><PosPage /></ProtectedRoute>} />
```

with:

```tsx
      <Route path="/pos" element={<ProtectedRoute><AppLayout><PosPage /></AppLayout></ProtectedRoute>} />
```

- [ ] **Step 6: Where staff set a PIN (POS Settings → Approvers)**

In `src/features/pos/checkout/CheckoutSettings.tsx`, replace:

```tsx
    if (!window.confirm(`Clear ${a.name}'s PIN? They set a new one under My PIN on the POS.`)) return
```

with:

```tsx
    if (!window.confirm(`Clear ${a.name}'s PIN? They set a new one in Craft OS under POS → Register → My PIN.`)) return
```

and replace:

```tsx
(Settings → System Roles). Each sets a PIN under My PIN on the POS.</p>
```

with:

```tsx
(Settings → System Roles). Each sets a PIN in Craft OS under POS → Register → My PIN.</p>
```

- [ ] **Step 7: Document the setting**

Replace the whole of `.env.example` with:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
# Craft OS /pos links here (dev: https://craft-pos-dev.vercel.app). Unset: /pos shows the notice without a link.
VITE_POS_APP_URL=
```

- [ ] **Step 8: Run the tests, the type check and both builds**

Run: `npx vitest run src/features/pos/order/posAppUrl.test.ts src/features/pos/order/PosPage.test.tsx src/shared/lib/nav.test.ts`
Expected: PASS (nav unchanged).

Run: `npx tsc -b`
Expected: exit 0.

Run: `npm run build` then `npm run build:pos`
Expected: both succeed.

- [ ] **Step 9: Commit**

```bash
git add src/features/pos/order/posAppUrl.ts src/features/pos/order/posAppUrl.test.ts src/features/pos/order/PosPage.tsx src/features/pos/order/PosPage.test.tsx src/App.tsx src/features/pos/checkout/CheckoutSettings.tsx .env.example
git commit -m "$(cat <<'EOF'
feat(pos): C3 Craft OS /pos says the POS has moved, with its address and My PIN

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Dev SQL, pairing this Mac's agent, the switch-over on dev, docs, push, redeploy (controller)

Run by the controller, not an implementer. A fix found here goes back to the task that owns the file, with its own commit, and this task starts again from the step that failed. **Order is the point of this task (changed after the final review): D SQL → pair every agent (and make sure every outlet's browser-printed routes have a POS-app tablet set to print) → the new Craft OS build with the /pos notice → the pre-C3 check → the C3 SQL last.**

**Files:**
- Modify: `docs/pos/2026-10-29-feedme-replacement-readiness.md` (§2 W1 Part C, W6 Part D; §4 the rollout chain)
- Modify: `.claude/launch.json` (a `pos-app-dev` entry)
- Local only, never committed: `tools/print-agent/.env` (remove three lines), `tools/print-agent/.device.json` (written by the pair command), `.env.local` (`VITE_POS_APP_URL`)

**Interfaces:**
- Consumes: everything above; the dev SQL route used for W3 / W4 / W7 (Supabase SQL editor in the owner's Chrome, project `egznnbjmicebbhwasloy` only; never `yfsoesxzurzjdwstszru`); the Craftale Vercel login `--global-config ~/.config/vercel-craftale` and the prebuilt-static recipe for craft-os-dev (`prj_Er3tKGFaRJTvrzaGuPUSHxm60H9B`) and craft-pos-dev (`prj_1GDCBcca0ty7VqyY4ENvS0ak2d2q`), team `team_9HUelE6yit458kQ3PvBU6lpi`.
- Produces: both migrations live on craft-os-dev with `VERIFY OK`; this Mac's agent paired as a device of the Demo outlet and printing; staff logins refused at the till on dev; the docs; the branch pushed; craft-os-dev and craft-pos-dev redeployed.

- [ ] **Step 1: Full test run, type check and both builds**

Run: `npx vitest run`, then `npx tsc -b`, then `npm run build`, then `npm run build:pos`
Expected: every test passes; `tsc -b` exits 0; both builds succeed.

- [ ] **Step 2: D SQL on craft-os-dev**

Check the editor URL holds `egznnbjmicebbhwasloy`; load `supabase/migration-2026-11-22-pos-agent-pairing.sql`, Run → one row `pos agent pairing applied`. Load `supabase/migration-2026-11-22-pos-agent-pairing-verify.sql`, Run → `VERIFY OK`. `ERROR: FAIL P…` → Task 1's files.

- [ ] **Step 3: Pair this Mac's agent against dev**

1. Stop any print agent still running from a staff login: `ps aux | grep "print-agent/agent.ts" | grep -v grep` → stop each (it is about to lose printing anyway).
2. In `tools/print-agent/.env` delete the lines that start with `BRANCH_ID=`, `AGENT_EMAIL=` and `AGENT_PASSWORD=` with `sed -i '' '/^BRANCH_ID=/d;/^AGENT_EMAIL=/d;/^AGENT_PASSWORD=/d' tools/print-agent/.env`, then check by key names only: `sed 's/=.*//' tools/print-agent/.env` → `SUPABASE_URL`, `SUPABASE_ANON_KEY` (and `TICKET_COLS`, `MAX_AGE_MIN` if set). Never print the values; `SUPABASE_URL` must hold `egznnbjmicebbhwasloy` (`grep -c egznnbjmicebbhwasloy tools/print-agent/.env` → 1).
3. Run in the background: `node --env-file=tools/print-agent/.env tools/print-agent/pair.ts "Office Mac agent"` → `Pairing code: XXX-XXX — approve it in Craft OS → Devices (kind: Print agent).`
4. Approve: the owner opens https://craft-os-dev.vercel.app → POS → Devices → Pending requests (or, with the owner's OK in chat, the controller does it in the owner's signed-in Chrome): the request with platform Computer, type the code, outlet **Demo**, kind **Print agent** (the default for a computer), name `Office Mac agent`, Approve.
5. Within 5 s the command prints `Paired. Start the agent with: node --env-file=tools/print-agent/.env tools/print-agent/agent.ts` and exits 0. Check: `stat -f %Lp tools/print-agent/.device.json` → `600`; `git check-ignore tools/print-agent/.device.json` → the path; `git status --short` shows no `.device.json`. Run the pair command once more → `Already paired. Delete .device.json to pair again.`, exit 1.

- [ ] **Step 4: Run the agent and see it claim**

Start in the background: `node --env-file=tools/print-agent/.env tools/print-agent/agent.ts`.
Expected log: `Paired as "Office Mac agent" — printing for Demo.`, `agent routes: { … }`, `realtime: SUBSCRIBED`. In craft-os-dev → POS Settings → outlet Demo → a route of kind agent → **Test print** → the agent logs the job as `printed` (on the office network, the ZyWell at `192.168.0.32:9100` prints `Test print — <route>`) or `failed: Not sent: …` off it — either proves the claim. Devices shows `Office Mac agent`, kind Print agent, last seen just now (the minute heartbeat).

- [ ] **Step 5: Craft OS build with the /pos notice (before the C3 SQL)**

The new Craft OS build does not depend on C3, so it goes out first: the old build's till still works until C3 runs, the new one only shows the notice.

1. Add to this worktree's `.claude/launch.json`, after the `craft-os-dev` entry: `{ "name": "pos-app-dev", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev:pos"], "port": 5179 }`. Add `VITE_POS_APP_URL=https://craft-pos-dev.vercel.app` to `.env.local` (git-ignored).
2. Start `craft-os-dev` from this worktree's launch.json (signed in as the dev owner): POS → Register → `The POS has moved to its own app.`, the link `https://craft-pos-dev.vercel.app`, `Activate a tablet: open the address on it and approve it in Devices.`, `My PIN` opens the PIN dialog (Cancel). POS Settings, Reports, Menu and Devices load; no console errors.
3. Deploy craft-os-dev with this build (the recipe of Step 11, from the current commit; craft-pos-dev is redeployed in Step 11 as before).

- [ ] **Step 6: Pre-C3 check — every route has something to print it**

Run on craft-os-dev (dev project only), read-only:

```sql
select r.branch_id, r.name, r.kind,
       case when r.kind = 'agent' then exists(select 1 from pos_devices d where d.branch_id = r.branch_id and d.kind = 'print_agent' and d.revoked_at is null)
            else exists(select 1 from pos_devices d where d.branch_id = r.branch_id and d.kind = 'pos' and d.prints and d.revoked_at is null) end as covered
  from print_routes r order by 1, 2;
```

Every row must show `covered = true` before Step 7: an `agent` route needs a paired print agent at its outlet, and every browser-printed route (`epson-epos`, `star-webprnt`) needs a POS app tablet set to print there. A `false` row: pair the agent or set a tablet to print, then run the query again.

- [ ] **Step 7: C3 SQL on craft-os-dev**

Only after Step 4 (the agent prints) and after Steps 5 and 6 (the Craft OS build with the notice is deployed, and the pre-C3 check shows every route covered). Load `supabase/migration-2026-11-22-pos-switchover.sql`, Run → `pos switchover applied`. Load `supabase/migration-2026-11-22-pos-switchover-verify.sql`, Run → `VERIFY OK` (`FAIL X…` → Task 4's files). Re-run the device-fixture verifies, each → `VERIFY OK`: `migration-2026-11-22-pos-agent-pairing-verify.sql`, `migration-2026-10-30-pos-app-verify.sql`, `migration-2026-10-30-pos-discounts-verify.sql`, `migration-2026-11-16-pos-split-bill-verify.sql`, `migration-2026-11-17-pos-bill-parts-verify.sql`, `migration-2026-11-18-pos-reports-verify.sql`, `migration-2026-11-22-pos-receipt-numbers-verify.sql`, `migration-2026-11-22-pos-feedme-habits-verify.sql`. A FAIL there that comes from a till call made as a staff login is a verify that belongs on the "pass only before C3" list (Spec conflict 4): record file and line in progress.md and add it to the list in the switchover header and readiness §4 (Task 4's file, own commit); any other FAIL is a defect — stop and report. Do not run the pre-C3 verifies.

The agent from Step 4 keeps printing (it is a device): Test print again → claimed.

- [ ] **Step 8: The POS app still sells, after C3**

1. Start `pos-app-dev` (http://localhost:5179; its requests go to `egznnbjmicebbhwasloy.supabase.co` — stop if `yfsoesxzurzjdwstszru`). If this origin is not activated yet, activate it (Devices, kind POS). The owner signs in with their name and PIN; on a table, send one item and pay it by cash; the Bar ticket job is claimed by the agent (its log). The bill shows in Transactions.
2. In craft-os-dev (the build deployed in Step 5): POS Settings → Test print still queues (the agent claims it); the notice is still shown at POS → Register.

- [ ] **Step 9: Docs — W1 Part C, W6 Part D and the rollout chain**

In `docs/pos/2026-10-29-feedme-replacement-readiness.md` §2, replace:

```
- [ ] **W1 POS app, Part C** — separate `craft-pos` app, tablets sign in as devices, staff name + PIN, the RPC
      swap to `pos_ctx`, scoped read policies (plan to write; Parts A and B are live on dev).
```

with:

```
- [x] **W1 POS app, Part C** — separate `craft-pos` app, tablets sign in as devices, staff name + PIN, the RPC
      swap to `pos_ctx`, scoped read policies (plan to write; Parts A and B are live on dev).
      C1 + C2 live on dev 2026-10-30; C3 switch-over on dev 2026-11-22 (plan
      docs/superpowers/plans/2026-11-22-pos-agent-pairing-switchover.md): staff email logins get device_unpaired
      from every till and print RPC; Craft OS /pos says "The POS has moved to its own app." with the address
      and keeps My PIN. Still for the owner: real iPad / Android add-to-home-screen and offline launch.
```

and replace:

```
- [ ] **W6 Print agent pairing, Part D** — the agent pairs like a device instead of an email/password login; one
      printing tablet per outlet also kicks the cash drawer.
```

with:

```
- [x] **W6 Print agent pairing, Part D** — the agent pairs like a device instead of an email/password login; one
      printing tablet per outlet also kicks the cash drawer.
      Built on dev 2026-11-22: `pair.ts` (code → approve in Devices as Print agent → tools/print-agent/.device.json,
      0600, git-ignored); the agent prints for its device's outlet (pos_agent_whoami) and stops when unpaired.
      This Mac's agent paired on dev. Still for the owner: pair the office computer's agent.
```

In §4, replace:

```
      QR table cart (`migration-2026-11-22-qr-table-cart.sql`, which re-creates `pos_insert_order` and
      `qr_table_state`; SQL before the front end) → Feedme habits (`migration-2026-11-22-pos-feedme-habits.sql`;
      SQL first, then the POS, Craft OS and QR builds, then restart the print agent)),
```

with:

```
      QR table cart (`migration-2026-11-22-qr-table-cart.sql`, which re-creates `pos_insert_order` and
      `qr_table_state`; SQL before the front end) → Feedme habits (`migration-2026-11-22-pos-feedme-habits.sql`;
      SQL first, then the POS, Craft OS and QR builds, then restart the print agent) → print agent pairing
      (`migration-2026-11-22-pos-agent-pairing.sql`; then pair every print agent with
      `tools/print-agent/pair.ts`, approve it in Devices as Print agent, restart it and see it print) → the
      switch-over (`migration-2026-11-22-pos-switchover.sql`, LAST: only once every agent prints as a device —
      from here a staff-login agent stops printing and staff logins lose the till). Order: D SQL → pair every
      agent, and every outlet's browser-printed routes need a POS-app tablet set to print → deploy the new Craft
      OS build (the /pos notice, `VITE_POS_APP_URL`; it does not depend on C3) → check that every print route is
      covered (the `print_routes` / `pos_devices` query of the plan's Task 6 Step 6, all `covered = true`) → the
      C3 SQL last)),
```

and replace:

```
- [ ] Create the `craft-pos` Vercel project; staff email logins lose front-of-house RPCs at the same time.
```

with:

```
- [ ] Create the `craft-pos` Vercel project; staff email logins lose front-of-house RPCs at the same time
      (the switch-over file, last: after every print agent is paired and the new Craft OS build is out). After the switch-over, the verifies that run
      the till as a staff login pass only before it and are not re-run: menu, ordering, catalogs, checkout,
      menu-editor, shifts, slots-photos, hardening, frontend, outlets, menu-picks, device-till's "C1
      transition" block, qr-table-cart L2 / L3. Re-running `migration-2026-10-29-pos-device-till.sql` puts the
      transition back: re-run the switch-over file after it.
```

- [ ] **Step 10: Commit and push**

```bash
git add docs/pos/2026-10-29-feedme-replacement-readiness.md .claude/launch.json
git commit -m "$(cat <<'EOF'
docs(pos): D + C3 live on dev — agent paired as a device, staff logins off the till; readiness, rollout chain

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
git push origin feature/pos-demo
```

- [ ] **Step 11: Redeploy craft-os-dev and craft-pos-dev (prebuilt static, Craftale login)**

For each project, from the pushed commit: `git archive <commit> | tar -x -C <scratch>`; copy `.env.local` (dev; for craft-os-dev it must hold `VITE_POS_APP_URL=https://craft-pos-dev.vercel.app`) and symlink `node_modules`; build (`npm run build` → `dist` for craft-os-dev, `npm run build:pos` → `dist-pos` for craft-pos-dev); grep the bundle: `egznnbjmicebbhwasloy` present, `yfsoesxzurzjdwstszru` absent, and for craft-os-dev `craft-pos-dev.vercel.app` present; copy the project's `vercel.json` in as before (root `vercel.json` into `dist`; the POS one with the SPA rewrite and SW headers into `dist-pos`); then from the output folder `VERCEL_ORG_ID=team_9HUelE6yit458kQ3PvBU6lpi VERCEL_PROJECT_ID=<project> vercel deploy --prod --yes --global-config ~/.config/vercel-craftale`. Check https://craft-os-dev.vercel.app/pos shows the notice with the link, and https://craft-pos-dev.vercel.app still opens the activation / lock screen.

Report: the test count, both builds, `pos agent pairing applied` / `pos switchover applied` and every `VERIFY OK` on dev, the pairing (device name, outlet, file mode 600), the agent's claims, the POS sale, the `/pos` notice, the push and both deploys. Prod is untouched (it runs with the POS chain, in the §4 order).

---

## Self-review

**Spec coverage**

| Spec | Task |
|---|---|
| §2 server side exists (`print_agent` kind, function request / poll, Devices approves platform `agent` as Print agent); no activation SQL change unless a gap | Kept as is; the gap (agent cannot read `pos_devices`) → `pos_agent_whoami` (Spec conflict 1), Task 1 |
| §2 pair command: request with platform `agent` and the name (default host name), code line, poll every 5 s, `.device.json` `{ email, password, deviceId, pairedAt }` 0600 git-ignored, `Paired. Start the agent with: …`; rejected / expired → say so, exit 1; existing file → `Already paired…` | Task 2 (`runPair`, `afterAgentPoll`, `activationClient`, `deviceFile`, `.gitignore`), Task 3 (`pair.ts`); Spec note 4 |
| §2 agent signs in from `.device.json`, outlet from its device (no `BRANCH_ID`); env login keys not read; no file → `Not paired. Run: …`, exit 1 | Task 2 (`startAgent`), Task 3 (`agent.ts`, `branch.ts`); Task 1 (`pos_agent_whoami`) |
| §2 unpaired / revoked → `This print agent was unpaired — run the pair command again.` exit 1 | Task 2 (`startAgent`, `isUnpairedError`), Task 3 (claim / finish, `SIGNED_OUT`, heartbeat); Spec note 5 |
| §2 agent reads routes and claims jobs of its own outlet only; every read allowed for a device account (RLS) | Checked ("Where the live code is"); Task 1 verify P2 / P3, Task 4 verify X3 |
| §2 README rewritten, `.env.example` reduced | Task 3 (Spec conflict 2) |
| §3 end the TRANSITION in `pos_ctx`, `pos_print_branch`, the write path; coded refusal | Task 4 (X1–X3; Spec note 1) |
| §3 back office keeps working; list what changes | Spec notes 2–3; Task 4 verify X4 |
| §3 Craft OS `/pos` notice, address from `VITE_POS_APP_URL` with fallback, activation line; nav keeps Reports, Menu, POS Settings, Devices; till entry → notice | Task 5 (Spec conflict 3: My PIN kept; Spec note 6) |
| §3 open must-dos listed, done or left with a reason | Spec conflict 4 (older verifies), Spec notes 7–8 (agent read scope, `pos_approvers`); the Plan B "for Part C" list was done in C1 / C2 (ghost device mapped by the app, `pos_unpair_this_device`, printing whitelist, STABLE lookups, coded errors, scoped reads, audit `on delete set null`; the Auth session settings stay a prod rollout check in progress.md's ROLLOUT CHECKLIST); C2 Task 2's "p_staff_id needs the device-till migration before this ships" is the §4 chain order |
| §3 rollout order D → Craft OS build → C3 SQL; in the readiness doc | Task 4 STOP guard (needs the D file), Task 6 Steps 2–7 order (build before C3, pre-C3 check), Step 9 §4 text |
| §4 unit tests: pair command cases, file 0600, agent start with / without file, unpaired, `/pos` notice | Tasks 2, 3, 5 |
| §4 SQL verify: staff login refused for `open_table`, `checkout_bill`, `claim_print_job`; POS device with a session allowed; print agent own outlet only; back office OK (settings, test print, reports) | Task 4 verify X1–X4 (plus Task 1's P1–P3) |
| §4 dev: pair this Mac, run it, claims; POS app on 5179 still sells; `/pos` notice | Task 6 Steps 3–8 |

**Placeholder scan:** every code step carries its full code; the copied SQL functions are written out in full with the source line ranges to check against; the only run-time values are the dev ids (the dev owner login, as in the W7 verify), the pairing code the command prints, and the Vercel ids from the deploy recipe.

**Type consistency:** `DeviceFile` (`email`, `password`, `deviceId`, `pairedAt`) is the same in `pairing.ts`, `deviceFile.ts` and the tests; `PollStep` `paired` carries `file` and `name`; `AgentWhoami` keys (`deviceId`, `deviceName`, `outletId`, `outletName`) match `pos_agent_whoami()`'s JSON and `parseWhoami`; `startAgent` returns `{ ok: true; who }`, which `agent.ts` reads as `start.who.outletId`; `activationClient(url, anonKey, fetchFn?)` returns `{ request, poll }` used by `pair.ts`; `posAppUrl(raw)` feeds `PosPage`'s `appUrl`; the SQL names (`pos_agent_whoami`, `-- X1`…`-- X3`, result rows `pos agent pairing applied` / `pos switchover applied`) match the `sqlSafeUpdate` tests and Task 6.
