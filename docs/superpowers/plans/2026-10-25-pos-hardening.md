# POS · Pre-pilot hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the review findings that can cost money, lose a report line or print in the wrong shop before the on-site simulated run and the pilot. (1) The **checkout sheet follows its bill**: on every bills event, order and 15 s sweep it re-reads the bill; paid, voided or merged on another iPad → it locks with a red note ("This bill was paid on another iPad — do not charge the card terminal." / "This bill was voided on another iPad." / "This bill was merged into <bill no> on another iPad.") and only **Close** works; still open with another total → it reloads the totals and says "The bill changed on another iPad — check the total.". (2) After "Not sure the payment went through" the lines **lock**; **Try again** resends the same lines under the same `checkout_id`, **Check bill** shows the paid result (paid by this sheet) or unlocks the lines with a new id (still open); the server refuses a replayed `checkout_id` with other payments ("This payment was already recorded with other amounts — check Today's bills"). (3) An **item void touches its bill** (`bills.updated_at`), so other iPads hear of it at once. (4) A takeaway merged into a table **keeps its packaging fee**, the fee's SST and its own service-charge rule (`order_items.order_type`, set from the bill by a trigger). (5) A Z report lists the **voids since the last close** of the branch. (6) Wrong PINs count per **(approver, caller)**: five wrong tries lock that caller out of that approver for 10 minutes ("Too many wrong PINs — try again after HH:MM"). (7) The print agent prints **one branch** (`BRANCH_ID`), and the print-job RPCs act only on the caller's branch. (8) A **simulated run sheet** with real Demo products and figures computed by the POS's own rules.

**Architecture:** One migration, `supabase/migration-2026-10-25-pos-hardening.sql` (schema + functions, idempotent; lines marked `H1`–`H7` after the design's sections). New: `bills.updated_at`, `order_items.order_type` + trigger `order_items_order_type`, table `pos_pin_attempts` (RLS on, no policy, no privilege), `pos_checkout_state` (what the sheet re-reads) and the internal `pos_checkout_same_payments`. Re-created from their live text with only the marked lines changed: `pos_compute_bill`, `pos_bill_totals` (checkout-fn), `checkout_bill`, `pos_shift_report` (shifts-fn), `void_order_item`, `set_my_pos_pin` (bill-actions-fn); rewritten: `pos_pin_attempt` (bill-actions-fn) and `claim_print_job` / `finish_print_job` / `requeue_print_job` (ordering-fn, now `security definer`). `merge_bills` and `pos_insert_order` are **not** re-created. On the client: the TypeScript mirror `bill.ts` takes a line's own `orderType` (shared vectors gain a merge vector); the pure rules of the sheet live in `checkout/follow.ts` (lock / reload from the re-read bill) and `checkout/paySession.ts` (the unsure-reply state machine), both with Vitest tests, and "no reply" is decided by one shared `looksOffline` (`checkout/rpcResult.ts`, also used by the shift sheets); `CheckoutSheet.tsx` is rewritten on top of them (totals panel split into `CheckoutTotals.tsx`); `PosPage` passes its `refreshKey`. The agent's branch rules live in `tools/print-agent/branch.ts` (tested). The run sheet is written by `tools/run-sheet/figures.ts` from a read-only facts query the controller runs on dev.

**Tech Stack:** React 19 + Vite 6 + TypeScript + Tailwind, Supabase (Postgres RLS, plpgsql `security definer` RPCs, Realtime), Vitest, Node 22 `--experimental-strip-types` for the tools. No ESLint config in the repo; the gates are `npx tsc -b` and `npx vitest run`.

**Spec:** `docs/superpowers/specs/2026-10-25-pos-hardening-design.md` (commit `0c0ddb3`, approved by the owner). Its owner decisions are final and bind this plan, with the resolutions below. Builds on Sub-plans 1–3, menu catalogs M1–M3 and shifts 4a (head `0c0ddb3`).

## Resolutions (decided while planning, 2026-10-25)

Open choices settled the Feedme way, as the owner asked:

- **The sheet re-reads through one new RPC**, `pos_checkout_state(p_bill_id, p_checkout_ids)` → `{ status, billNo, mergedIntoBillNo, totals (open only), result (only when one of p_checkout_ids paid the bill) }`. `p_checkout_ids` is every checkout id the sheet has used (`checkoutIds(session)`: the current one and the ones Check bill replaced — a first attempt that timed out can still commit after Check bill found the bill open). "This sheet has just paid it" therefore means *paid by one of this sheet's own checkout ids*: the sheet then shows its paid result instead of locking, never "paid on another iPad" (a lost reply is recovered the same way). **Check bill** uses the same call. The re-read runs on `PosPage`'s existing `refreshKey`, which every bills event, every order insert and every 15 s sweep bumps — so an order added on another iPad also reaches the sheet at once. No re-read while a Pay or Check bill is on its way.
- **Lock / reload rule** (`followBill`): paid with one of this sheet's ids → show the result; paid otherwise → lock (paid note); voided → lock; merged → lock with the bill it went into; open with a total other than the one on screen → reload + the "bill changed" note; payment lines already entered stay, and the existing sum check refuses **Pay** until they match.
- **Unsure state machine** (`paySession.ts`): `editing → paying → (refused → editing, same id) | (no reply → unsure)`; `unsure → Try again (paying, same id) | Check bill (checking)`; Check bill → open: `editing` with a **new** id (the old one is kept in `earlierIds`), message "The bill is still open — the payment was not recorded. Check the lines and press Pay."; paid by this sheet → the result; closed elsewhere → the lock; no answer → `unsure` again with "Could not check the bill: …". The no-reply message becomes "Not sure the payment went through (no reply). Press Try again — it will not be charged twice — or Check bill.".
- **"No reply" is one shared classifier**, `looksOffline(message)` in `src/features/pos/checkout/rpcResult.ts`: `/load failed|fetch|network|timeout|abort|signal/i`. postgrest-js reports a network failure as `"${name}: ${message}"`, and WebKit — every pilot iPad — says "TypeError: Load failed", which the old pattern missed (Chrome: "Failed to fetch", Firefox: "NetworkError…"). The checkout sheet and the shift sheets (`shift.ts` `moveRefusal`, `CloseShiftSheet.tsx`) use it; the copy in `shift.ts` goes. (`offline/orderQueue.ts` decides by error code, not by words, and is unchanged.)
- **Replay comparison** (`pos_checkout_same_payments`): same number of payments and, line by line in `line_no` order, the same method (compared case-insensitively), amount and cash received; the reference is not compared (the spec names method, amount, tendered). Both replay paths of `checkout_bill` (before and after the bill lock) check it.
- **A takeaway line matches no table-limited service-charge rule** (on its own bill it had no table), so a merged bill totals what the two bills would have totalled apart, before the whole-bill rounding — **except up to 1 sen per service-charge or SST rate the two bills share**: each rate's amount is rounded once on the whole bill (two lines with an SST base of RM 10.10 at 6% are 0.61 + 0.61 apart, 1.21 together). On an unmerged bill nothing changes (the 22 vectors are untouched).
- **Backfill of `order_items.order_type`:** an item with a packaging fee is `takeaway` (pos_insert_order snapshots the fee on takeaway bills only — so takeaways merged before this migration get their fee back), every other item takes its bill's type. This goes beyond the spec's "backfilled from their bill" in the owner's favour (decision 1): **an open bill that was merged before the migration gains its packaging fee (and the fee's SST) when the migration runs** — on dev now, and on prod at rollout (a read-only pre-check is under Open points).
- **"The previous closed shift"** = the latest closed shift of the same branch opened before this one. Voids count from just **after** its close (that instant belongs to the shift before) to this shift's close; with none, from this shift's open, as today. Reports frozen before this change keep their old window.
- **Heading:** house style — every section title of the Z report prints in capitals — so the section prints **"VOIDS SINCE THE LAST CLOSE"**. This is the rendering of the spec string "Voids since the last close", not a different heading. Summary lines "Void bills" / "Total void" are unchanged. A reprint (`reprint_zreport`) of a shift closed **before** the migration shows the new heading over that report's old "during the shift" window (the frozen report carries no window marker) — accepted: only the few dev and pre-pilot shifts are affected.
- **PINs:** the lock message is "Too many wrong PINs — try again after HH:MM" (Malaysia time); the fifth wrong try still answers "Wrong PIN — locked for 10 minutes after 5 wrong tries". A pair's counter resets on a right PIN or after a day without a try. A new PIN (`set_my_pos_pin`) deletes every `pos_pin_attempts` row of that approver — every caller starts afresh, as the old reset of `failed_attempts` / `locked_until` did. The count is per **login** (`auth.uid()`), not per iPad, so the run sheet asks for one login per cashier. `clear_pos_pin` is unchanged.
- **Print agent:** besides filtering by `BRANCH_ID`, it checks at start that its login is staff of that branch and stops with a message otherwise (otherwise every job would be skipped silently). `tools/print-agent/README.md` is new (the spec mentions one; none existed). The `print_jobs_update` RLS policy (direct table updates of lifecycle columns by any staff) is outside the spec and stays; it is listed under Open points.
- **Run sheet figures** are computed by a committed script (`tools/run-sheet/figures.ts`, using `computeBill` from `bill.ts`) from a committed read-only query (`tools/run-sheet/facts.sql`) that the **controller** runs on craft-os-dev; the implementer never touches the database. The generator was checked while planning against a full SQL simulation of the run on a scratch database: every bill total, the expected cash and the Z report summary, sales, payments, sources and product lines matched the server.

## Global Constraints

- **Dev database first.** The SQL here is applied on `craft-os-dev` (ref `egznnbjmicebbhwasloy`) by the controller from the owner's Chrome tab on the dashboard SQL editor; prod (`yfsoesxzurzjdwstszru`) is a later step the owner decides. On prod the migration runs **after the shifts files** and **right before** the first main deploy that carries Tasks 2, 4 and 5: the client then reads `order_items.order_type` and calls `pos_checkout_state`, which exist only once it is applied. Before it runs on prod, the read-only pre-check under Open points (open table bills holding a merged takeaway, whose totals the backfill raises). Seeds never run on prod; the verify scripts and the run-sheet facts query are dev-only.
- Every step that reads or writes the dev database is marked **(controller, … ; the implementer does not touch the database)**; implementers run only local commands (`grep`, `diff`, `node`, `npx tsc -b`, `npx vitest run`) and commit.
- All UI copy, field names and error messages in English (`english-product-copy` rule); code comments may be Chinese or English, matching the surrounding file. The exact strings are the spec's: "This bill was paid on another iPad — do not charge the card terminal.", "This bill was voided on another iPad.", "This bill was merged into <bill no> on another iPad.", "The bill changed on another iPad — check the total.", "This payment was already recorded with other amounts — check Today's bills", "Too many wrong PINs — try again after HH:MM", "Voids since the last close".
- **Money is integer sen.** Sub-plan 3's money rules and the 22 vectors in `src/features/pos/checkout/billVectors.json` do not change; one merge vector is added, and the SQL verify's copy of the vectors stays byte-for-byte the same as the JSON (`bill.test.ts` checks it).
- **The server is the truth.** `follow.ts` and `paySession.ts` decide only what the sheet shows and locks; the server refuses on its own (a replay with other payments, a sum that does not match, a bill already paid).
- **Every new or re-created function** pins `set search_path = public, pg_temp`, revokes execute from `public, anon` and grants `authenticated` only where staff call it; the internal ones (`pos_checkout_same_payments`, `pos_shift_report`, `pos_pin_attempt`, the trigger function `order_items_order_type`) are revoked from `authenticated` too. Live staff only: `pos_my_branch()` (`is_active and status = 'active'`, with a branch) for every call.
- **pg-safeupdate:** Supabase's API role refuses a DELETE or UPDATE without WHERE even inside a function (the SQL editor does not, so the verify script cannot catch it). Every DELETE / UPDATE in the new files has a WHERE; `src/features/pos/sqlSafeUpdate.test.ts` scans every `migration-*-pos-*.sql` and Task 1 names the new file and its write functions.
- **No unpaged reads that can pass 1,000 rows.** Every new read is an RPC returning one JSON value.
- **Migrations are idempotent** (`add column if not exists`, `create table if not exists`, guarded constraints, `drop trigger if exists` + `create trigger`, `create or replace function`), and end with `notify pgrst, 'reload schema';` before the final `select`.
- **STOP guard:** the migration stops without the shifts schema and functions (`pos_shifts`, `close_shift`, `pos_shift_report`).
- **Re-run hazards.** Re-running `migration-2026-10-24-pos-shifts-fn.sql` brings back `checkout_bill` and `pos_shift_report` without the hardening lines; re-running `migration-2026-10-24-pos-bill-actions-fn.sql` brings back `void_order_item`, `pos_pin_attempt`, `set_my_pos_pin`; re-running `migration-2026-10-24-pos-checkout-fixes.sql` needs shifts-fn re-run, which in turn needs this migration re-run. `checkout-fn` and `ordering-fn` cannot be re-run after M1 (their STOP guards). Task 1 says so in each header; the hardening verify's A section fails until the hardening file is re-run. Re-running the hardening file is harmless.
- **Staff fixtures in the verify script** are created after `request.jwt.claims` is set to the dev owner `76cbcf9f-905e-450d-9f5e-1c9e72a9373d`, inserted as `staff` and promoted by the owner (the staff authority guard). A function called for its side effect is called **on its own line** before a condition checks the effect: PostgreSQL may run a condition's subqueries before the call.
- **UI lessons from M1/M2, applied to every new or rewritten component:** each action shows its outcome next to the control that made it; every write button is disabled while it runs and a ref refuses a second tap in the same render; a load that fails locks the writes; every load keyed by a selection drops a stale reply (a sequence ref); every input has a visible label or an `aria-label`; no `.ts` / `.tsx` file this plan creates or rewrites passes ~250 lines (the SQL files are longer, as in Sub-plans 1–3).
- `tsconfig` has `noUnusedLocals` / `noUnusedParameters`: remove an import the moment it is no longer used.
- Every commit ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work in the worktree `/Users/USER/Desktop/Craft_OS/.claude/worktrees/pos-demo`, branch `feature/pos-demo`. Several sessions share the stash stack: never use a bare `git stash`. Every replacement below quotes its old text — if one does not match, another session changed the file since `0c0ddb3`: read it and apply the same change to what is there.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migration-2026-10-25-pos-hardening.sql` | Schema (H3, H4, H6) and every hardening function (Task 1) |
| `supabase/migration-2026-10-24-pos-shifts-fn.sql`, `-bill-actions-fn.sql`, `-checkout-fixes.sql`, `-checkout-fn.sql`, `migration-2026-10-23-pos-ordering-fn.sql` | Header comments only: which functions are canonical in the hardening file (Task 1) |
| `src/features/pos/sqlSafeUpdate.test.ts` | Names the new file and its write functions in the pg-safeupdate scan (Task 1) |
| `src/features/pos/print/zreport.ts` (+test) | Section heading "VOIDS SINCE THE LAST CLOSE" (Task 1) |
| `src/features/pos/checkout/bill.ts` (+test), `billVectors.json`, `supabase/migration-2026-10-24-pos-checkout-verify.sql` (vectors only) | A line's own order type; the merge vector (Task 2) |
| `src/features/pos/order/posApi.ts`, `BillPanel.tsx` | The bill panel's preview reads each item's order type (Task 2) |
| `supabase/migration-2026-10-25-pos-hardening-verify.sql` | Self-check, rolled back (Task 3) |
| `supabase/migration-2026-10-24-pos-checkout-verify.sql`, `-shifts-verify.sql` | Regression scripts follow the replay rule and `pos_pin_attempts` (Task 3) |
| `src/features/pos/checkout/follow.ts` (+test), `paySession.ts` (+test), `checkoutApi.ts` | Pure lock / reload rule and unsure state machine; `fetchCheckoutState` (Task 4) |
| `src/features/pos/checkout/rpcResult.ts` (+test), `src/features/pos/shift/shift.ts`, `CloseShiftSheet.tsx` | The one shared `looksOffline` (knows Safari's "Load failed"); the shift copy goes (Task 4) |
| `src/features/pos/checkout/CheckoutSheet.tsx`, `CheckoutTotals.tsx`, `src/features/pos/order/PosPage.tsx` | The sheet follows its bill and locks after an unsure reply (Task 5) |
| `tools/print-agent/branch.ts` (+test), `agent.ts`, `.env.example`, `README.md` | One branch per agent (Task 6) |
| `tools/run-sheet/facts.sql`, `facts.ts`, `figures.ts`, `facts.example.json`; `docs/pos/2026-10-25-simulated-run-sheet.md` | The run sheet and how it is regenerated (Task 7) |

`merge_bills`, `pos_insert_order`, `void_bill`, `move_bill`, `refund_bill`, `close_shift`, the browser print host (`PrintHostPanel.tsx`, already branch-scoped) and every RLS policy do not change.

**Test counts** (checked while planning on a scratch copy of the worktree at `0c0ddb3`, by replaying this document task by task, and again after the review fixes): baseline 100 files / 877 tests. After Task 1: 100 / 879. Task 2: 100 / 881. Task 3: 100 / 881. Task 4: 102 / 897. Task 5: 102 / 897. Task 6: 103 / 902. Task 7: 103 / 902. `npx tsc -b` prints nothing after every task. The SQL (Tasks 1 and 3) was replayed on a scratch PostgreSQL 18 with Supabase stand-ins: the hardening verify and all seven regression verify scripts print `VERIFY OK`, and the hardening verify fails for each of eight deliberate faults (no branch filter or an inclusive start in the void window, no branch filter in `claim_print_job`, no replay check, a case-sensitive method compare, a PIN counter per approver only, a table-limited rule matching takeaway lines, no bill touch on a void).

---

### Task 1: The hardening migration (SQL), the re-run notes, the pg-safeupdate scan and the Z report heading — and applying it on craft-os-dev (implementer + controller)

**Model tier:** cheap (the plan carries every line); the controller runs Step 9.

**Files:**
- Create: `supabase/migration-2026-10-25-pos-hardening.sql`
- Modify: `src/features/pos/sqlSafeUpdate.test.ts`; `src/features/pos/print/zreport.ts`, `src/features/pos/print/zreport.test.ts`; header comments only in `supabase/migration-2026-10-24-pos-shifts-fn.sql`, `supabase/migration-2026-10-24-pos-bill-actions-fn.sql`, `supabase/migration-2026-10-24-pos-checkout-fixes.sql`, `supabase/migration-2026-10-24-pos-checkout-fn.sql`, `supabase/migration-2026-10-23-pos-ordering-fn.sql`

**Interfaces:**
- Consumes: `pos_my_branch()`, `pos_checkout_result(uuid)`, `pos_queue_receipt` (checkout-fn); `pos_check_reason`, `pos_check_approver`, `pos_queue_void_tickets` (bill-actions-fn); `pos_shift_expected_cash` (shifts-fn); tables `bills`, `orders`, `order_items`, `payments`, `refunds`, `print_jobs`, `pos_shifts`, `pos_cash_moves`, `staff_pos_pins`, `staff`, `branch_pos_settings`, `service_charge_rules`, `payment_methods`.
- Produces (later tasks call these exact names and shapes; JSON keys camelCase):
  - `bills.updated_at timestamptz not null default now()`; `void_order_item` sets it on every void.
  - `order_items.order_type text not null check in ('dine_in','takeaway')`, set from the bill on insert; read by `fetchBillItems` (Task 2).
  - `pos_compute_bill(jsonb)`: input lines may carry `orderType`; `pos_bill_totals(uuid)` passes `orderType` per line.
  - `pos_checkout_state(p_bill_id uuid, p_checkout_ids uuid[]) returns jsonb` → `{ status: 'open'|'paid'|'voided'|'merged', billNo: string, mergedIntoBillNo: string|null, totals: BillTotals|null, result: CheckoutResult|null }`; `result` is set when one of `p_checkout_ids` paid the bill (Task 4 parses it).
  - `checkout_bill(uuid, jsonb, uuid)`: a replay with other payments raises `This payment was already recorded with other amounts — check Today's bills`.
  - `pos_pin_attempts(approver_id, caller_id, failed_attempts, locked_until, updated_at)`; `pos_pin_attempt` answers `Too many wrong PINs — try again after HH:MM` for a locked pair (Task 3 checks it).
  - `claim_print_job(uuid) returns boolean`, `finish_print_job(uuid, boolean, text)`, `requeue_print_job(uuid)`: security definer, caller's branch only (Task 6 relies on it).
  - The Z report section title `VOIDS SINCE THE LAST CLOSE`.

- [ ] **Step 1: Make the pg-safeupdate scan name the new file.** In `src/features/pos/sqlSafeUpdate.test.ts` make exactly these replacements (each old text occurs once, in this order):

1. Replace:

```ts
      'migration-2026-10-24-pos-shifts-fn.sql',
    ]))
```

   with:

```ts
      'migration-2026-10-24-pos-shifts-fn.sql',
      'migration-2026-10-25-pos-hardening.sql',
    ]))
```

2. Replace:

```ts
      'checkout_bill', 'refund_bill',
    ]))
  })
})
```

   with:

```ts
      'checkout_bill', 'refund_bill',
    ]))
  })

  it('scans every write function of the pre-pilot hardening', () => {
    const sql = readFileSync(new URL('migration-2026-10-25-pos-hardening.sql', SUPABASE), 'utf8')
    const names = functionBodies(sql).map((b) => b.name)
    expect(names).toEqual(expect.arrayContaining([
      'order_items_order_type', 'checkout_bill', 'void_order_item', 'pos_pin_attempt', 'set_my_pos_pin',
      'claim_print_job', 'finish_print_job', 'requeue_print_job',
    ]))
  })
})
```

- [ ] **Step 2: Run it to verify it fails.** Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts` — Expected: FAIL, `Tests  2 failed | 23 passed (25)` (`reads the POS function migrations` misses the file; the new test cannot read it: `ENOENT`).

- [ ] **Step 3: Say in the five older files' headers which functions are canonical in the hardening file** (comments only; the function bodies Step 5 compares do not move). Make exactly these replacements (each old text occurs once):

`supabase/migration-2026-10-24-pos-shifts-fn.sql`:

1. Replace:

```sql
-- this file afterwards (the shifts verify's A section fails until then).
```

   with:

```sql
-- this file afterwards (the shifts verify's A section fails until then).
-- Pre-pilot hardening: checkout_bill and pos_shift_report are canonical in
-- migration-2026-10-25-pos-hardening.sql now — after re-running THIS file, re-run that one too.
```

`supabase/migration-2026-10-24-pos-bill-actions-fn.sql`:

1. Replace:

```sql
-- migration-2026-10-24-pos-shifts-fn.sql re-create it — re-run both after this file.
```

   with:

```sql
-- migration-2026-10-24-pos-shifts-fn.sql re-create it — re-run both after this file.
-- void_order_item, pos_pin_attempt and set_my_pos_pin are old bodies too: they are canonical in
-- migration-2026-10-25-pos-hardening.sql — re-run it last (after shifts-fn).
```

`supabase/migration-2026-10-24-pos-checkout-fixes.sql`:

1. Replace:

```sql
-- re-run migration-2026-10-24-pos-shifts-fn.sql too.
```

   with:

```sql
-- re-run migration-2026-10-24-pos-shifts-fn.sql too, and then
-- migration-2026-10-25-pos-hardening.sql (shifts-fn brings back an old checkout_bill).
```

`supabase/migration-2026-10-24-pos-checkout-fn.sql`:

1. Replace:

```sql
-- payment and on the bill).
```

   with:

```sql
-- payment and on the bill). pos_compute_bill and pos_bill_totals are canonical in
-- migration-2026-10-25-pos-hardening.sql (a line's own order type decides its packaging fee).
```

`supabase/migration-2026-10-23-pos-ordering-fn.sql`:

1. Replace:

```sql
-- Every price on an order is computed here from the menu; clients send ids only.
```

   with:

```sql
-- Every price on an order is computed here from the menu; clients send ids only.
-- claim_print_job, finish_print_job and requeue_print_job are canonical in
-- migration-2026-10-25-pos-hardening.sql (security definer, the caller's branch only).
```

- [ ] **Step 4: Write the migration.** Create `supabase/migration-2026-10-25-pos-hardening.sql`:

```sql
-- ============================================================================
-- Craft OS — POS pre-pilot hardening (2026-10-25): schema and functions.
-- Run on craft-os-dev after every earlier POS migration (shifts 4a included).
-- Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-25-pos-hardening.md
-- Design: docs/superpowers/specs/2026-10-25-pos-hardening-design.md
-- Lines marked H1–H7 are the changes, numbered as the design's sections.
--
-- New: bills.updated_at (H3); order_items.order_type and the trigger that sets it from
-- the bill (H4); pos_pin_attempts, wrong PINs per approver and caller (H6);
-- pos_checkout_state, what the checkout sheet re-reads (H1); the internal
-- pos_checkout_same_payments (H2).
-- Canonical from here on, each re-created from its live text with only the marked lines
-- changed: pos_compute_bill and pos_bill_totals (from migration-2026-10-24-pos-checkout-fn.sql),
-- checkout_bill and pos_shift_report (from migration-2026-10-24-pos-shifts-fn.sql),
-- void_order_item and set_my_pos_pin (from migration-2026-10-24-pos-bill-actions-fn.sql);
-- pos_pin_attempt (bill-actions-fn) and claim_print_job, finish_print_job, requeue_print_job
-- (migration-2026-10-23-pos-ordering-fn.sql) are rewritten. Re-running shifts-fn,
-- bill-actions-fn or checkout-fixes brings an old body back — re-run this file afterwards
-- (the hardening verify's A section fails until then).
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regclass('public.pos_shifts') is null
     or to_regprocedure('close_shift(uuid,integer,text,uuid,text,integer)') is null
     or to_regprocedure('pos_shift_report(uuid)') is null then
    raise exception 'STOP: run migration-2026-10-24-pos-shifts.sql and migration-2026-10-24-pos-shifts-fn.sql first (the shift functions are missing)';
  end if;
end $$;

-- ── H3. Bills: a touch column, so an item void is a bills event ─────────────
alter table bills add column if not exists updated_at timestamptz not null default now();

-- ── H4. Every item keeps the order type it was ordered under ────────────────
-- Set from the bill on insert (pos_insert_order is not re-created); merge_bills moves
-- items to another bill and leaves it unchanged, so a takeaway merged into a table
-- keeps its packaging fee, the fee's SST and its service-charge rule.
alter table order_items add column if not exists order_type text;

create or replace function order_items_order_type() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  select b.order_type into new.order_type from bills b where b.id = new.bill_id;
  return new;
end $$;
revoke all on function order_items_order_type() from public, anon, authenticated;
drop trigger if exists order_items_order_type on order_items;
create trigger order_items_order_type before insert on order_items
  for each row execute function order_items_order_type();

-- existing rows: their bill's type; an item with a packaging fee was ordered on a takeaway
-- bill (pos_insert_order snapshots the fee on takeaway bills only), even if merged since —
-- so an OPEN bill merged before this migration gains that fee (and its SST) right here
update order_items oi
   set order_type = case when oi.takeaway_fee_sen > 0 then 'takeaway' else b.order_type end
  from bills b
 where b.id = oi.bill_id and oi.order_type is null;
alter table order_items alter column order_type set not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'order_items_order_type_check') then
    alter table order_items add constraint order_items_order_type_check check (order_type in ('dine_in', 'takeaway'));
  end if;
end $$;

-- ── H6. Wrong PINs count per approver and caller ────────────────────────────
-- Five wrong tries by one caller lock that caller out of that approver for 10 minutes;
-- the approver and every other caller are unaffected. staff_pos_pins.failed_attempts and
-- locked_until are no longer read or written. RLS on, no policy, no privilege: only
-- pos_pin_attempt (security definer) reads and writes it.
create table if not exists pos_pin_attempts (
  approver_id      uuid not null references staff(id) on delete cascade,
  caller_id        uuid not null references staff(id) on delete cascade,
  failed_attempts  integer not null default 0,
  locked_until     timestamptz,
  updated_at       timestamptz not null default now(),        -- stamped on every try: a day idle forgets the count
  primary key (approver_id, caller_id)
);
alter table pos_pin_attempts enable row level security;
revoke all on pos_pin_attempts from public, anon, authenticated;

-- ── H4. Totals: a line's own order type decides its packaging fee, the fee's SST
--    and its service-charge rule (the bill's when a line has none). Mirrored by
--    computeBill (src/features/pos/checkout/bill.ts); both pass billVectors.json ─
-- input lines may carry orderType ('dine_in' | 'takeaway'); a takeaway line matches no
-- table-limited rule (on its own bill it had no table), so a merged bill totals what the
-- two bills would have totalled apart, before the whole-bill rounding — except up to 1 sen
-- per service-charge or SST rate the two bills share (each rate is rounded on the whole bill).
create or replace function pos_compute_bill(p_input jsonb) returns jsonb
language sql immutable security invoker set search_path = public, pg_temp as $$
  with lines as (
    select (x.l->>'productId') as product_id,
           (x.l->>'unitPriceSen')::bigint * (x.l->>'qty')::bigint as amount,
           (x.l->>'sstRateBp')::integer as sst_bp,
           coalesce((x.l->>'takeawayFeeSen')::bigint, 0) * (x.l->>'qty')::bigint as fee,
           coalesce(x.l->>'orderType', p_input->>'orderType') as order_type          -- H4: the line's own order type
      from jsonb_array_elements(coalesce(p_input->'lines', '[]'::jsonb)) as x(l)
     where not coalesce((x.l->>'voided')::boolean, false)
  ),
  rated as (
    select ln.*,
           (select (rr.rule->>'rateBp')::integer
              from jsonb_array_elements(coalesce(p_input->'rules', '[]'::jsonb)) with ordinality as rr(rule, ord)
             where (rr.rule->'orderTypes') ? ln.order_type                                   -- H4
               and (jsonb_typeof(rr.rule->'tableIds') is distinct from 'array'
                    or (ln.order_type = 'dine_in'                                              -- H4: a takeaway line has no table
                        and p_input->>'tableId' is not null and (rr.rule->'tableIds') ? (p_input->>'tableId')))
               and (jsonb_typeof(rr.rule->'productIds') is distinct from 'array'
                    or (ln.product_id is not null and (rr.rule->'productIds') ? ln.product_id))
             order by rr.ord
             limit 1) as sc_bp
      from lines ln
  ),
  sc as (
    select sc_bp as rate_bp, sum(amount) as base, round(sum(amount) * sc_bp / 10000.0) as amt
      from rated where sc_bp > 0 group by sc_bp
  ),
  taxed as (
    select sst_bp, amount + case when order_type = 'takeaway' then fee else 0 end as base_part   -- H4
      from lines
  ),
  sst as (
    select sst_bp as rate_bp, sum(base_part) as base, round(sum(base_part) * sst_bp / 10000.0) as amt
      from taxed
     where sst_bp > 0 and coalesce((p_input->>'sstRegistered')::boolean, true)
     group by sst_bp
  ),
  t as (
    select coalesce((select sum(amount) from lines), 0) as subtotal,
           coalesce((select sum(amt) from sc), 0) as sc_total,
           coalesce((select sum(amt) from sst), 0) as sst_total,
           coalesce((select sum(fee) from lines where order_type = 'takeaway'), 0) as fee_total             -- H4
  ),
  b as (
    select t.*, t.subtotal + t.sc_total + t.sst_total + t.fee_total as before_rounding from t
  ),
  m as (
    -- remainder normalised to 0..4 so a negative amount rounds like roundingDeltaSen (bill.ts)
    select b.*, ((b.before_rounding % 5) + 5) % 5 as r5 from b
  ),
  fin as (
    select m.*,
           case when coalesce(p_input->>'cashRounding', 'nearest_5_sen') <> 'nearest_5_sen' then 0
                when m.r5 in (1, 2) then -m.r5         -- …1, …2 → down
                when m.r5 in (3, 4) then 5 - m.r5      -- …3, …4 → up
                else 0 end as rounding
      from m
  )
  select jsonb_build_object(
    'subtotalSen', fin.subtotal, 'serviceChargeSen', fin.sc_total, 'sstSen', fin.sst_total,
    'takeawayFeeSen', fin.fee_total, 'beforeRoundingSen', fin.before_rounding, 'roundingSen', fin.rounding,
    'totalSen', fin.before_rounding + fin.rounding,
    'sstGroups', coalesce((select jsonb_agg(jsonb_build_object('rateBp', rate_bp, 'baseSen', base, 'amountSen', amt) order by rate_bp) from sst), '[]'::jsonb),
    'serviceChargeGroups', coalesce((select jsonb_agg(jsonb_build_object('rateBp', rate_bp, 'baseSen', base, 'amountSen', amt) order by rate_bp) from sc), '[]'::jsonb))
  from fin
$$;
revoke all on function pos_compute_bill(jsonb) from public, anon;
grant execute on function pos_compute_bill(jsonb) to authenticated;

create or replace function pos_bill_totals(p_bill_id uuid) returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select pos_compute_bill(jsonb_build_object(
    'orderType', b.order_type,
    'tableId', b.table_id,
    'sstRegistered', coalesce(s.sst_registered, true),
    'cashRounding', coalesce(s.cash_rounding, 'nearest_5_sen'),
    'rules', coalesce((
      select jsonb_agg(jsonb_build_object('rateBp', r.rate_bp, 'orderTypes', to_jsonb(r.order_types),
                                          'tableIds', to_jsonb(r.table_ids), 'productIds', to_jsonb(r.product_ids))
                       order by r.sort_order, r.created_at, r.id)
        from service_charge_rules r where r.branch_id = b.branch_id and r.is_active), '[]'::jsonb),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object('productId', oi.product_id, 'unitPriceSen', oi.unit_price_sen, 'qty', oi.qty,
                                          'sstRateBp', oi.sst_rate_bp, 'takeawayFeeSen', oi.takeaway_fee_sen,
                                          'voided', oi.voided_at is not null,
                                          'orderType', oi.order_type) order by oi.id)                -- H4
        from order_items oi where oi.bill_id = b.id), '[]'::jsonb)))
  from bills b
  left join branch_pos_settings s on s.branch_id = b.branch_id
  where b.id = p_bill_id
$$;
revoke all on function pos_bill_totals(uuid) from public, anon;
grant execute on function pos_bill_totals(uuid) to authenticated;

-- ── H1. What the checkout sheet re-reads on every bill event and sweep ──────
-- p_checkout_ids: every checkout id the sheet has used — a first attempt that timed out can
-- still commit after Check bill gave the sheet a new id, and it is still the sheet's own payment.
-- { status: 'open'|'paid'|'voided'|'merged', billNo, mergedIntoBillNo: text|null,
--   totals: pos_bill_totals (open bills only, else null),
--   result: the checkout result when one of p_checkout_ids paid this bill (else null) }
create or replace function pos_checkout_state(p_bill_id uuid, p_checkout_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_bill   bills;
begin
  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch;
  if not found then raise exception 'Bill not found'; end if;
  return jsonb_build_object(
    'status', v_bill.status,
    'billNo', v_bill.bill_no,
    'mergedIntoBillNo', (select m.bill_no from bills m where m.id = v_bill.merged_into),
    'totals', case when v_bill.status = 'open' then pos_bill_totals(v_bill.id) end,
    'result', case when v_bill.status = 'paid' and v_bill.checkout_id = any(coalesce(p_checkout_ids, '{}'::uuid[]))
                   then pos_checkout_result(v_bill.id) end);
end $$;
revoke all on function pos_checkout_state(uuid, uuid[]) from public, anon;
grant execute on function pos_checkout_state(uuid, uuid[]) to authenticated;

-- ── H2. A replayed checkout id must carry the very same payments ────────────
-- Same count, and line by line (line_no order) the same method, amount and cash received.
-- Internal.
create or replace function pos_checkout_same_payments(p_bill_id uuid, p_payments jsonb) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  with given as (
    select case when jsonb_typeof(p_payments) = 'array' then p_payments else null end as arr
  )
  select given.arr is not null
     and jsonb_array_length(given.arr) = (select count(*) from payments p where p.bill_id = p_bill_id)
     and not exists (
       select 1
         from jsonb_array_elements(coalesce(given.arr, '[]'::jsonb)) with ordinality as x(v, n)
         left join payments p on p.bill_id = p_bill_id and p.line_no = x.n
        where p.id is null
           or lower(x.v->>'methodId') is distinct from p.method_id::text
           or (case when jsonb_typeof(x.v->'amountSen') = 'number' then (x.v->>'amountSen')::numeric end)
                is distinct from p.amount_sen::numeric
           or (case when jsonb_typeof(x.v->'tenderedSen') = 'number' then (x.v->>'tenderedSen')::numeric end)
                is distinct from p.tendered_sen::numeric)
  from given
$$;
revoke all on function pos_checkout_same_payments(uuid, jsonb) from public, anon, authenticated;

-- ── Checkout, re-created: the live text of migration-2026-10-24-pos-shifts-fn.sql with
--    only the lines marked H2 added (a replay with other payments is refused) ─
-- p_payments: [{ methodId: uuid, amountSen: int > 0, tenderedSen: int|null (cash only), reference: text|null }]
create or replace function checkout_bill(p_bill_id uuid, p_payments jsonb, p_checkout_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
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
            auth.uid(), v_n, v_shift);                                          -- 4a: v_shift
  end loop;

  update bills
     set status = 'paid', closed_at = now(), closed_by = auth.uid(), checkout_id = p_checkout_id,
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
end $$;
revoke all on function checkout_bill(uuid, jsonb, uuid) from public, anon;
grant execute on function checkout_bill(uuid, jsonb, uuid) to authenticated;

-- ── Void one item, re-created: the live text of migration-2026-10-24-pos-bill-actions-fn.sql
--    with only the H3 line added ─
create or replace function void_order_item(p_item_id uuid, p_reason text, p_approver_id uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
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
     set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason, void_approved_by = p_approver_id
   where id = p_item_id;
  update bills set updated_at = now() where id = v_bill.id;   -- H3: a bills event, so other iPads hear of it at once
  perform pos_queue_void_tickets(array[p_item_id]);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function void_order_item(uuid, text, uuid, text) from public, anon;
grant execute on function void_order_item(uuid, text, uuid, text) to authenticated;

-- ── The Z report, re-created: the live text of migration-2026-10-24-pos-shifts-fn.sql with
--    only the H5 lines changed. Voids are listed from the close of the branch's previous
--    shift (made while no shift was open too) to this shift's close; that close itself
--    belongs to the previous shift. With no previous shift: from this shift's open.
--    Exactly ZReport in src/features/pos/print/zreport.ts. Internal. ─
create or replace function pos_shift_report(p_shift_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with s as (
    select sh.*, coalesce(sh.closed_at, now()) as until,
           -- H5: the close of the branch's shift before this one (null when there is none)
           (select max(p.closed_at) from pos_shifts p
             where p.branch_id = sh.branch_id and p.status = 'closed' and p.opened_at < sh.opened_at) as prev_close
      from pos_shifts sh where sh.id = p_shift_id
  ),
  sb as (                                                                -- the shift's bills
    select b.* from bills b where b.shift_id = p_shift_id
  ),
  t as (
    select count(*)::integer as bill_count, coalesce(sum(sb.pax), 0)::integer as pax,
           coalesce(sum(sb.subtotal_sen), 0)::integer as gross, coalesce(sum(sb.takeaway_fee_sen), 0)::integer as fee,
           coalesce(sum(sb.service_charge_sen), 0)::integer as sc, coalesce(sum(sb.sst_sen), 0)::integer as sst,
           coalesce(sum(sb.rounding_sen), 0)::integer as rounding, coalesce(sum(sb.total_sen), 0)::integer as nett
      from sb
  ),
  vi as (                                                                -- items voided since the last close
    select oi.*, b.bill_no from order_items oi join bills b on b.id = oi.bill_id, s
     where b.branch_id = s.branch_id and oi.voided_at <= s.until
       and (oi.voided_at > s.prev_close or (s.prev_close is null and oi.voided_at >= s.opened_at))   -- H5
  ),
  vb as (                                                                -- bills voided since the last close
    select b.* from bills b, s
     where b.branch_id = s.branch_id and b.status = 'voided' and b.closed_at <= s.until
       and (b.closed_at > s.prev_close or (s.prev_close is null and b.closed_at >= s.opened_at))     -- H5
  ),
  rf as (select r.* from refunds r where r.shift_id = p_shift_id),
  mv as (select m.* from pos_cash_moves m where m.shift_id = p_shift_id),
  pm as (
    select p.method_id, min(p.method_name) as name, min(p.kind) as kind, count(*)::integer as n, sum(p.amount_sen)::integer as amt
      from payments p where p.shift_id = p_shift_id group by p.method_id
  ),
  rm as (
    select r.method_id, min(r.method_name) as name, min(coalesce(r.kind, 'other')) as kind, count(*)::integer as n,
           sum(r.amount_sen)::integer as amt
      from rf r group by r.method_id
  )
  select jsonb_build_object(
    'branch', (select coalesce(nullif(trim(br.receipt_title), ''), br.name) from branches br where br.id = s.branch_id),
    'openedAt', to_char(s.opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'openedBy', (select st.name from staff st where st.id = s.opened_by),
    'closedAt', to_char(s.until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'closedBy', (select st.name from staff st where st.id = s.closed_by),
    'summary', jsonb_build_object(
      'billCount', t.bill_count, 'pax', t.pax, 'nettSen', t.nett,
      'avgPerBillSen', case when t.bill_count > 0 then round(t.nett::numeric / t.bill_count)::integer else 0 end,
      'avgPerPaxSen', case when t.pax > 0 then round(t.nett::numeric / t.pax)::integer else 0 end,
      'voidBillCount', (select count(*)::integer from vb),
      'voidSen', (select coalesce(sum(vi.unit_price_sen * vi.qty), 0)::integer from vi),
      'refundSen', (select coalesce(sum(rf.amount_sen), 0)::integer from rf)),
    'sales', jsonb_build_object(
      'grossSen', t.gross, 'takeawayFeeSen', t.fee, 'serviceChargeSen', t.sc, 'sstSen', t.sst,
      'roundingSen', t.rounding, 'nettSen', t.nett),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', coalesce(pm.name, rm.name), 'kind', coalesce(pm.kind, rm.kind),
               'count', coalesce(pm.n, 0), 'amountSen', coalesce(pm.amt, 0),
               'refundCount', coalesce(rm.n, 0), 'refundSen', coalesce(rm.amt, 0),
               'netSen', coalesce(pm.amt, 0) - coalesce(rm.amt, 0))
             order by coalesce(pm.name, rm.name))
        from pm full join rm on rm.method_id = pm.method_id), '[]'::jsonb),
    'orderTypes', (
      select jsonb_agg(jsonb_build_object(
               'orderType', x.ot,
               'bills', (select count(*)::integer from sb where sb.order_type = x.ot),
               'nettSen', (select coalesce(sum(sb.total_sen), 0)::integer from sb where sb.order_type = x.ot))
             order by x.ord)
        from (values ('dine_in', 1), ('takeaway', 2)) as x(ot, ord)),
    'sources', (
      select jsonb_agg(jsonb_build_object(
               'source', x.src,
               'orders', (select count(*)::integer from orders o where o.bill_id in (select sb.id from sb) and o.source = x.src),
               'itemSen', (select coalesce(sum(oi.unit_price_sen * oi.qty), 0)::integer
                             from order_items oi join orders o on o.id = oi.order_id
                            where o.bill_id in (select sb.id from sb) and o.source = x.src and oi.voided_at is null))
             order by x.ord)
        from (values ('counter', 1), ('qr', 2)) as x(src, ord)),
    'cash', jsonb_build_object(
      'openingFloatSen', s.opening_float_sen,
      'cashSalesSen', coalesce((select sum(p.amount_sen) from payments p where p.shift_id = s.id and p.kind = 'cash'), 0)::integer,
      'cashRefundSen', coalesce((select sum(rf.amount_sen) from rf where rf.kind = 'cash'), 0)::integer,
      'moves', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'kind', mv.kind, 'amountSen', mv.amount_sen, 'reason', mv.reason,
                 'by', (select st.name from staff st where st.id = mv.created_by),
                 'approvedBy', (select st.name from staff st where st.id = mv.approved_by),
                 'at', to_char(mv.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
               order by mv.created_at, mv.id)
          from mv), '[]'::jsonb),
      'payInSen', coalesce((select sum(mv.amount_sen) from mv where mv.kind = 'pay_in'), 0)::integer,
      'payOutSen', coalesce((select sum(mv.amount_sen) from mv where mv.kind = 'pay_out'), 0)::integer,
      'expectedSen', coalesce(s.expected_cash_sen, pos_shift_expected_cash(s.id)),
      'firstCountSen', s.first_count_sen,
      'firstVarianceSen', s.first_variance_sen,
      'countedSen', s.counted_cash_sen,
      'varianceSen', s.variance_sen,
      'varianceReason', s.variance_reason,
      'varianceApprovedBy', (select st.name from staff st where st.id = s.variance_approved_by)),
    'voids', jsonb_build_object(
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'at', to_char(vi.voided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                 'billNo', vi.bill_no, 'name', vi.name_snapshot, 'qty', vi.qty,
                 'valueSen', vi.unit_price_sen * vi.qty, 'reason', vi.void_reason,
                 'by', (select st.name from staff st where st.id = vi.voided_by),
                 'approvedBy', (select st.name from staff st where st.id = vi.void_approved_by))
               order by vi.voided_at, vi.id)
          from vi), '[]'::jsonb),
      'bills', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'at', to_char(vb.closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                 'billNo', vb.bill_no, 'reason', vb.void_reason,
                 'by', (select st.name from staff st where st.id = vb.closed_by),
                 'approvedBy', (select st.name from staff st where st.id = vb.void_approved_by))
               order by vb.closed_at, vb.id)
          from vb), '[]'::jsonb)),
    'refunds', coalesce((
      select jsonb_agg(jsonb_build_object(
               'at', to_char(rf.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'billNo', (select b.bill_no from bills b where b.id = rf.bill_id),
               'amountSen', rf.amount_sen, 'method', rf.method_name, 'reason', rf.reason,
               'approvedBy', (select st.name from staff st where st.id = rf.approved_by))
             order by rf.created_at, rf.id)
        from rf), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object('name', x.name, 'qty', x.qty, 'valueSen', x.value)
                       order by x.qty desc, x.value desc, x.name)
        from (select oi.name_snapshot as name, sum(oi.qty)::integer as qty, sum(oi.unit_price_sen * oi.qty)::integer as value
                from order_items oi
               where oi.bill_id in (select sb.id from sb) and oi.voided_at is null
               group by oi.name_snapshot) x), '[]'::jsonb))
  from s, t
$$;
revoke all on function pos_shift_report(uuid) from public, anon, authenticated;

-- ── H6. One PIN attempt by the signed-in caller: null = right; otherwise the words to show.
--    The count is per (approver, caller); a day without a try forgets it ─
create or replace function pos_pin_attempt(p_staff_id uuid, p_pin text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller uuid := auth.uid();
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
end $$;
revoke all on function pos_pin_attempt(uuid, text) from public, anon, authenticated;

-- ── My PIN, re-created: the live text of migration-2026-10-24-pos-bill-actions-fn.sql with
--    only the H6 lines changed (the caller is the approver: the same pos_pin_attempts row;
--    a new PIN clears every caller's wrong tries and lock against this approver) ─
create or replace function set_my_pos_pin(p_new_pin text, p_current_pin text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_err text;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if not exists (select 1 from staff where id = auth.uid() and is_active and status = 'active') then
    raise exception 'Your account is not active';
  end if;
  if p_new_pin is null or p_new_pin !~ '^\d{4,6}$' then raise exception 'The PIN must be 4 to 6 digits'; end if;
  if exists (select 1 from staff_pos_pins where staff_id = auth.uid()) then
    v_err := pos_pin_attempt(auth.uid(), p_current_pin);
    if v_err is not null then return jsonb_build_object('ok', false, 'error', 'Current PIN: ' || v_err); end if;
  end if;
  insert into staff_pos_pins(staff_id, pin_hash)
  values (auth.uid(), extensions.crypt(p_new_pin, extensions.gen_salt('bf')))
  on conflict (staff_id) do update
     set pin_hash = excluded.pin_hash, updated_at = now();          -- H6: wrong tries live in pos_pin_attempts
  -- H6: a new PIN starts every (approver, caller) pair afresh, as the old reset of
  -- wrong-try counter and lock did (a cashier locked out of the old PIN is free again)
  delete from pos_pin_attempts where approver_id = auth.uid();
  return jsonb_build_object('ok', true);
end $$;
revoke all on function set_my_pos_pin(text, text) from public, anon;
grant execute on function set_my_pos_pin(text, text) to authenticated;

-- ── H7. Print jobs: security definer, and only jobs of the caller's branch ──
-- Another branch's job id is a no-op (false / nothing), like a job another host already
-- claimed. The print agent's login must be staff of the branch it prints for.
create or replace function claim_print_job(p_id uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
begin
  update print_jobs set status = 'printing', attempts = attempts + 1, claimed_at = now()
   where id = p_id and status = 'pending' and branch_id = v_branch;
  return found;
end $$;

create or replace function finish_print_job(p_id uuid, p_ok boolean, p_error text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
begin
  update print_jobs
     set status     = case when p_ok then 'printed' else 'failed' end,
         printed_at = case when p_ok then now() else null end,
         last_error = case when p_ok then null else p_error end
   where id = p_id and status = 'printing' and branch_id = v_branch;
end $$;

-- failed jobs, and jobs a host claimed but never finished (crashed mid-print)
create or replace function requeue_print_job(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
begin
  update print_jobs set status = 'pending'
   where id = p_id and branch_id = v_branch
     and (status = 'failed' or (status = 'printing' and claimed_at < now() - interval '2 minutes'));
end $$;
revoke all on function claim_print_job(uuid), finish_print_job(uuid, boolean, text), requeue_print_job(uuid) from public, anon;
grant execute on function claim_print_job(uuid), finish_print_job(uuid, boolean, text), requeue_print_job(uuid) to authenticated;

-- PostgREST picks up the new functions now, not at its next poll
notify pgrst, 'reload schema';

select 'pos hardening applied' as result;
```

- [ ] **Step 5: Check the re-created functions against their live text.** Save this as `.superpowers/sdd/fndiff.sh` (git-ignored) and run `bash .superpowers/sdd/fndiff.sh`:

```bash
H=supabase/migration-2026-10-25-pos-hardening.sql
fn() { sed -n "/^create or replace function $1(/,/^$2 [a-z ]*on function $1(/p" "$3"; }
for x in "pos_compute_bill grant supabase/migration-2026-10-24-pos-checkout-fn.sql" \
         "pos_bill_totals grant supabase/migration-2026-10-24-pos-checkout-fn.sql" \
         "checkout_bill grant supabase/migration-2026-10-24-pos-shifts-fn.sql" \
         "void_order_item grant supabase/migration-2026-10-24-pos-bill-actions-fn.sql" \
         "pos_shift_report revoke supabase/migration-2026-10-24-pos-shifts-fn.sql" \
         "set_my_pos_pin grant supabase/migration-2026-10-24-pos-bill-actions-fn.sql"; do
  set -- $x; echo "== $1"; diff <(fn $1 $2 $3) <(fn $1 $2 $H)
done
```

Expected: exactly the `H` lines (and, in `pos_shift_report`, the two CTE comments "items / bills voided since the last close"), nothing else —

```diff
== pos_compute_bill
7c7,8
<            coalesce((x.l->>'takeawayFeeSen')::bigint, 0) * (x.l->>'qty')::bigint as fee
---
>            coalesce((x.l->>'takeawayFeeSen')::bigint, 0) * (x.l->>'qty')::bigint as fee,
>            coalesce(x.l->>'orderType', p_input->>'orderType') as order_type          -- H4: the line's own order type
15c16
<              where (rr.rule->'orderTypes') ? (p_input->>'orderType')
---
>              where (rr.rule->'orderTypes') ? ln.order_type                                   -- H4
17c18,19
<                     or (p_input->>'tableId' is not null and (rr.rule->'tableIds') ? (p_input->>'tableId')))
---
>                     or (ln.order_type = 'dine_in'                                              -- H4: a takeaway line has no table
>                         and p_input->>'tableId' is not null and (rr.rule->'tableIds') ? (p_input->>'tableId')))
29c31
<     select sst_bp, amount + case when p_input->>'orderType' = 'takeaway' then fee else 0 end as base_part
---
>     select sst_bp, amount + case when order_type = 'takeaway' then fee else 0 end as base_part   -- H4
42c44
<            case when p_input->>'orderType' = 'takeaway' then coalesce((select sum(fee) from lines), 0) else 0 end as fee_total
---
>            coalesce((select sum(fee) from lines where order_type = 'takeaway'), 0) as fee_total             -- H4
== pos_bill_totals
16c16,17
<                                           'voided', oi.voided_at is not null) order by oi.id)
---
>                                           'voided', oi.voided_at is not null,
>                                           'orderType', oi.order_type) order by oi.id)                -- H4
== checkout_bill
24a25,28
>     -- H2: the first result is replayed only for the very same payments
>     if not pos_checkout_same_payments(v_bill.id, p_payments) then
>       raise exception 'This payment was already recorded with other amounts — check Today''s bills';
>     end if;
30a35,37
>     if not pos_checkout_same_payments(v_bill.id, p_payments) then                                   -- H2
>       raise exception 'This payment was already recorded with other amounts — check Today''s bills';  -- H2
>     end if;                                                                                          -- H2
== void_order_item
25a26
>   update bills set updated_at = now() where id = v_bill.id;   -- H3: a bills event, so other iPads hear of it at once
== pos_shift_report
4c4,8
<     select sh.*, coalesce(sh.closed_at, now()) as until from pos_shifts sh where sh.id = p_shift_id
---
>     select sh.*, coalesce(sh.closed_at, now()) as until,
>            -- H5: the close of the branch's shift before this one (null when there is none)
>            (select max(p.closed_at) from pos_shifts p
>              where p.branch_id = sh.branch_id and p.status = 'closed' and p.opened_at < sh.opened_at) as prev_close
>       from pos_shifts sh where sh.id = p_shift_id
16c20
<   vi as (                                                                -- items voided during the shift
---
>   vi as (                                                                -- items voided since the last close
18c22,23
<      where b.branch_id = s.branch_id and oi.voided_at >= s.opened_at and oi.voided_at <= s.until
---
>      where b.branch_id = s.branch_id and oi.voided_at <= s.until
>        and (oi.voided_at > s.prev_close or (s.prev_close is null and oi.voided_at >= s.opened_at))   -- H5
20c25
<   vb as (                                                                -- bills voided during the shift
---
>   vb as (                                                                -- bills voided since the last close
22c27,28
<      where b.branch_id = s.branch_id and b.status = 'voided' and b.closed_at >= s.opened_at and b.closed_at <= s.until
---
>      where b.branch_id = s.branch_id and b.status = 'voided' and b.closed_at <= s.until
>        and (b.closed_at > s.prev_close or (s.prev_close is null and b.closed_at >= s.opened_at))     -- H5
== set_my_pos_pin
17c17,20
<      set pin_hash = excluded.pin_hash, failed_attempts = 0, locked_until = null, updated_at = now();
---
>      set pin_hash = excluded.pin_hash, updated_at = now();          -- H6: wrong tries live in pos_pin_attempts
>   -- H6: a new PIN starts every (approver, caller) pair afresh, as the old reset of
>   -- wrong-try counter and lock did (a cashier locked out of the old PIN is free again)
>   delete from pos_pin_attempts where approver_id = auth.uid();
```

If any other line differs, the older file changed since this plan was written: take its current text for the function and add the same `H` lines again.

- [ ] **Step 6: The Z report heading.** The spec's "Voids since the last close", in capitals like every Z section title (Resolutions). A reprint of a shift closed before the migration shows it too, over that report's old window — accepted. In `src/features/pos/print/zreport.ts` make exactly this replacement (the old text occurs once):

1. Replace:

```ts
    ...section('VOIDS', r.voids.items.length
```

   with:

```ts
    ...section('VOIDS SINCE THE LAST CLOSE', r.voids.items.length
```

In `src/features/pos/print/zreport.test.ts` make exactly this replacement (the old text occurs once):

1. Replace:

```ts
      '------------------------------------------------',
      'VOIDS',
```

   with:

```ts
      '------------------------------------------------',
      'VOIDS SINCE THE LAST CLOSE',
```

- [ ] **Step 7: Run the scan and the gates.** Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts` — Expected: PASS, 26 tests. If a statement is listed, add its WHERE — never silence the scan. Run: `grep -c "set search_path = public, pg_temp" supabase/migration-2026-10-25-pos-hardening.sql` — Expected: `13` (every function, the trigger function included). Run: `grep -c "create or replace function" supabase/migration-2026-10-25-pos-hardening.sql` — Expected: `13`. Run: `grep -c "notify pgrst, 'reload schema'" supabase/migration-2026-10-25-pos-hardening.sql` — Expected: `1`. Run: `npx vitest run` — Expected: 100 files, 879 tests pass. Run: `npx tsc -b` — Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add supabase/migration-2026-10-25-pos-hardening.sql src/features/pos/sqlSafeUpdate.test.ts src/features/pos/print/zreport.ts src/features/pos/print/zreport.test.ts supabase/migration-2026-10-24-pos-shifts-fn.sql supabase/migration-2026-10-24-pos-bill-actions-fn.sql supabase/migration-2026-10-24-pos-checkout-fixes.sql supabase/migration-2026-10-24-pos-checkout-fn.sql supabase/migration-2026-10-23-pos-ordering-fn.sql
git commit -m "feat(pos): pre-pilot hardening — checkout state, replay check, item voids touch the bill, merged takeaways keep their fee, voids since the last close, PINs per caller, print jobs per branch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 9 (controller, craft-os-dev — dashboard SQL editor in the owner's Chrome tab; the implementer does not touch the database):** apply the migration now, before Task 2's client reads `order_items.order_type` (the worktree is shared by live sessions: a dev server on this branch would otherwise fail the bill panel's item load). Confirm the top bar reads **craft-os-dev** (`egznnbjmicebbhwasloy`) — never the prod project. Load `supabase/migration-2026-10-25-pos-hardening.sql` with `window.monaco.editor.getModels()[0].setValue(...)` and run it with `cmd+Return` → result `pos hardening applied`. Run it a second time → the same (idempotent). The verify and the regression scripts run in Task 3 Step 5. If the SQL is fixed later, re-run this step before Task 3 Step 5.

---

### Task 2: Totals follow each line's order type — `bill.ts`, the merge vector, the bill panel

**Model tier:** cheap.

**Files:**
- Modify: `src/features/pos/checkout/bill.ts`, `src/features/pos/checkout/bill.test.ts`, `src/features/pos/checkout/billVectors.json`, `supabase/migration-2026-10-24-pos-checkout-verify.sql` (the vectors copy and their count only), `src/features/pos/order/posApi.ts`, `src/features/pos/order/BillPanel.tsx`

**Interfaces:**
- Consumes: `pos_compute_bill` with per-line `orderType` (Task 1) — the SQL verify (Task 3, controller) runs the same 23 vectors against it.
- Produces: `BillLineInput.orderType?: BillOrderType` (absent = the bill's); `BillItemRow.order_type: OrderType`.

- [ ] **Step 1: Write the failing tests and the vector.** In `src/features/pos/checkout/bill.test.ts` make exactly these replacements (each old text occurs once, in this order):

1. Replace:

```ts
import { computeBill, formatRate, roundingDeltaSen, type BillInput, type BillTotals } from './bill'
```

   with:

```ts
import { computeBill, formatRate, roundingDeltaSen, type BillInput, type BillOrderType, type BillTotals } from './bill'
```

2. Replace:

```ts
    expect(all).toHaveLength(22)
```

   with:

```ts
    expect(all).toHaveLength(23)
```

3. Replace:

```ts
describe('roundingDeltaSen', () => {
```

   with:

```ts
// Apart and merged agree up to 1 sen per service-charge or SST rate both parts share (each rate is
// rounded on the whole bill); the merge vector's bases round without a remainder, so here they are equal.
describe('a merged bill totals what its bills would have totalled apart (owner, 2026-10-25)', () => {
  it('the merge vector equals its dine-in and its takeaway part, before the whole-bill rounding', () => {
    const merged = all.find((v) => v.name.startsWith('merge:'))!.input
    const part = (orderType: BillOrderType): BillInput => ({
      ...merged,
      orderType,
      tableId: orderType === 'dine_in' ? merged.tableId : null,
      lines: merged.lines.filter((l) => (l.orderType ?? merged.orderType) === orderType),
    })
    const a = computeBill(part('dine_in'))
    const b = computeBill(part('takeaway'))
    const m = computeBill(merged)
    expect(b.takeawayFeeSen).toBe(250)
    expect([m.subtotalSen, m.serviceChargeSen, m.sstSen, m.takeawayFeeSen, m.beforeRoundingSen]).toEqual([
      a.subtotalSen + b.subtotalSen, a.serviceChargeSen + b.serviceChargeSen, a.sstSen + b.sstSen,
      a.takeawayFeeSen + b.takeawayFeeSen, a.beforeRoundingSen + b.beforeRoundingSen,
    ])
  })
})

describe('roundingDeltaSen', () => {
```

In `src/features/pos/checkout/billVectors.json` add the merge vector as the last element — replace the end of the file (the old text occurs once: the end of the last vector, the closing bracket and the final newline):

1. Replace:

```json
"serviceChargeGroups": []}}
]
```

   with:

```json
"serviceChargeGroups": []}},
  {"name": "merge: a takeaway merged into table t-1 keeps its packaging fee, the fee's SST and its own service-charge rule", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in", "takeaway"], "tableIds": ["t-1"], "productIds": null}, {"rateBp": 500, "orderTypes": ["takeaway"], "tableIds": null, "productIds": null}], "lines": [{"productId": "p-a", "unitPriceSen": 1200, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}, {"productId": "p-b", "unitPriceSen": 1000, "qty": 2, "sstRateBp": 600, "takeawayFeeSen": 100, "voided": false, "orderType": "takeaway"}, {"productId": "p-c", "unitPriceSen": 500, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 50, "voided": false, "orderType": "takeaway"}]}, "expected": {"subtotalSen": 3700, "serviceChargeSen": 245, "sstSen": 204, "takeawayFeeSen": 250, "beforeRoundingSen": 4399, "roundingSen": 1, "totalSen": 4400, "sstGroups": [{"rateBp": 600, "baseSen": 3400, "amountSen": 204}], "serviceChargeGroups": [{"rateBp": 500, "baseSen": 2500, "amountSen": 125}, {"rateBp": 1000, "baseSen": 1200, "amountSen": 120}]}}
]
```

The SQL verify carries a byte-for-byte copy (`bill.test.ts` compares them). In `supabase/migration-2026-10-24-pos-checkout-verify.sql` make exactly these replacements (each old text occurs once):

1. Replace:

```sql
"serviceChargeGroups": []}}
]
$vectors$;
```

   with:

```sql
"serviceChargeGroups": []}},
  {"name": "merge: a takeaway merged into table t-1 keeps its packaging fee, the fee's SST and its own service-charge rule", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in", "takeaway"], "tableIds": ["t-1"], "productIds": null}, {"rateBp": 500, "orderTypes": ["takeaway"], "tableIds": null, "productIds": null}], "lines": [{"productId": "p-a", "unitPriceSen": 1200, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}, {"productId": "p-b", "unitPriceSen": 1000, "qty": 2, "sstRateBp": 600, "takeawayFeeSen": 100, "voided": false, "orderType": "takeaway"}, {"productId": "p-c", "unitPriceSen": 500, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 50, "voided": false, "orderType": "takeaway"}]}, "expected": {"subtotalSen": 3700, "serviceChargeSen": 245, "sstSen": 204, "takeawayFeeSen": 250, "beforeRoundingSen": 4399, "roundingSen": 1, "totalSen": 4400, "sstGroups": [{"rateBp": 600, "baseSen": 3400, "amountSen": 204}], "serviceChargeGroups": [{"rateBp": 500, "baseSen": 2500, "amountSen": 125}, {"rateBp": 1000, "baseSen": 1200, "amountSen": 120}]}}
]
$vectors$;
```

2. Replace:

```sql
  if jsonb_array_length(v_vectors) <> 22 then raise exception 'FAIL vectors: expected 22, got %', jsonb_array_length(v_vectors); end if;
```

   with:

```sql
  if jsonb_array_length(v_vectors) <> 23 then raise exception 'FAIL vectors: expected 23, got %', jsonb_array_length(v_vectors); end if;
```

- [ ] **Step 2: Run it to verify it fails.** Run: `npx vitest run src/features/pos/checkout/bill.test.ts` — Expected: FAIL, `Tests  2 failed | 26 passed (28)` (the merge vector and the apart test: `computeBill` still ignores a line's order type). `npx tsc -b` also reports `Property 'orderType' does not exist on type 'BillLineInput'` until Step 3.

- [ ] **Step 3: Teach `computeBill` a line's own order type.** In `src/features/pos/checkout/bill.ts` make exactly these replacements (each old text occurs once, in this order):

1. Replace:

```ts
/** Bill totals — the TypeScript mirror of the SQL function pos_compute_bill
 *  (supabase/migration-2026-10-24-pos-checkout-fn.sql). Both take the same
```

   with:

```ts
/** Bill totals — the TypeScript mirror of the SQL function pos_compute_bill
 *  (supabase/migration-2026-10-25-pos-hardening.sql). Both take the same
```

2. Replace:

```ts
  takeawayFeeSen: number // snapshotted on the order item; counted only on takeaway bills, taxed at the line's SST rate
  voided: boolean
}
```

   with:

```ts
  takeawayFeeSen: number // snapshotted on the order item; counted only on takeaway lines, taxed at the line's SST rate
  voided: boolean
  /** The order type the item was ordered under (order_items.order_type): a takeaway merged into
   *  a table's bill keeps 'takeaway' (owner, 2026-10-25). Absent = the bill's order type. */
  orderType?: BillOrderType
}
```

3. Replace:

```ts
function ruleFor(input: BillInput, line: BillLineInput): ServiceChargeRuleInput | undefined {
  return input.rules.find(
    (r) =>
      r.orderTypes.includes(input.orderType) &&
      (r.tableIds === null || (input.tableId !== null && r.tableIds.includes(input.tableId))) &&
```

   with:

```ts
const lineType = (input: BillInput, line: BillLineInput): BillOrderType => line.orderType ?? input.orderType

/** A takeaway line matches no table-limited rule: on its own bill it had no table. */
function ruleFor(input: BillInput, line: BillLineInput): ServiceChargeRuleInput | undefined {
  const type = lineType(input, line)
  return input.rules.find(
    (r) =>
      r.orderTypes.includes(type) &&
      (r.tableIds === null || (type === 'dine_in' && input.tableId !== null && r.tableIds.includes(input.tableId))) &&
```

4. Replace:

```ts
  // SST base per rate: the line amount plus, on a takeaway bill, its packaging fee (owner, 2026-10-24)
  const takeaway = input.orderType === 'takeaway'
  const fee = (l: BillLineInput) => (takeaway ? l.takeawayFeeSen * l.qty : 0)
```

   with:

```ts
  // SST base per rate: the line amount plus, on a takeaway line, its packaging fee (owner, 2026-10-24;
  // a takeaway merged into a table keeps its fee — owner, 2026-10-25)
  const fee = (l: BillLineInput) => (lineType(input, l) === 'takeaway' ? l.takeawayFeeSen * l.qty : 0)
```

- [ ] **Step 4: The bill panel's preview reads each item's order type.** In `src/features/pos/order/posApi.ts` make exactly these replacements (each old text occurs once):

1. Replace:

```ts
  takeaway_fee_sen: number
  qty: number
```

   with:

```ts
  takeaway_fee_sen: number
  order_type: OrderType           // the order type it was ordered under (a merged takeaway keeps 'takeaway')
  qty: number
```

2. Replace:

```ts
    .select('id, order_id, product_id, name_snapshot, unit_price_sen, sst_rate_bp, takeaway_fee_sen, qty, note, modifiers_snapshot, voided_at, ' +
```

   with:

```ts
    .select('id, order_id, product_id, name_snapshot, unit_price_sen, sst_rate_bp, takeaway_fee_sen, order_type, qty, note, modifiers_snapshot, voided_at, ' +
```

In `src/features/pos/order/BillPanel.tsx` make exactly this replacement (the old text occurs once):

1. Replace:

```tsx
                              takeawayFeeSen: i.takeaway_fee_sen, voided: i.voided_at !== null })),
```

   with:

```tsx
                              takeawayFeeSen: i.takeaway_fee_sen, voided: i.voided_at !== null, orderType: i.order_type })),
```

- [ ] **Step 5: Run the tests and the gates.** Run: `npx vitest run src/features/pos/checkout/bill.test.ts` — Expected: PASS, 28 tests. Run: `npx vitest run` — Expected: 100 files, 881 tests pass. Run: `npx tsc -b` — Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/features/pos/checkout/bill.ts src/features/pos/checkout/bill.test.ts src/features/pos/checkout/billVectors.json supabase/migration-2026-10-24-pos-checkout-verify.sql src/features/pos/order/posApi.ts src/features/pos/order/BillPanel.tsx
git commit -m "feat(pos-checkout): a merged takeaway keeps its packaging fee — totals follow each line's order type, with a merge vector

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The hardening verify, the regression scripts — and running them on craft-os-dev (implementer + controller)

**Model tier:** cheap for Steps 1–4 (the plan carries every line); the controller runs Step 5.

**Files:**
- Create: `supabase/migration-2026-10-25-pos-hardening-verify.sql`
- Modify: `supabase/migration-2026-10-24-pos-checkout-verify.sql` (header, the replay check, the PIN checks), `supabase/migration-2026-10-24-pos-shifts-verify.sql` (header, one PIN check)

**Interfaces:**
- Consumes: everything Task 1 produces (applied on craft-os-dev in Task 1 Step 9); Task 2's 23 vectors in the checkout verify.
- Produces: `VERIFY OK` from the hardening verify and from the seven regression scripts on craft-os-dev.

- [ ] **Step 1: Write the verify script.** Create `supabase/migration-2026-10-25-pos-hardening-verify.sql`:

```sql
-- Self-check for the POS pre-pilot hardening. Run on craft-os-dev after
-- migration-2026-10-25-pos-hardening.sql. Everything is rolled back. Success = a
-- result row "VERIFY OK". Sections follow the design: H1 the checkout state, H2 a replay
-- with other payments, H3 an item void touches its bill, H4 a merged takeaway keeps its
-- fee, H5 voids between shifts, H6 wrong PINs per approver and caller, H7 print jobs
-- stay in their branch. Inside one transaction now() does not move: the script sets
-- shift and void times by hand where the order of events matters.
begin;

-- expect_error(sql, message, label): runs sql and insists it raises exactly message.
create function pg_temp.expect_error(p_sql text, p_message text, p_label text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FAIL %: no error (expected "%")', p_label, p_message;
exception when raise_exception then
  if sqlerrm is distinct from p_message then
    raise exception 'FAIL %: got "%" (expected "%")', p_label, sqlerrm, p_message;
  end if;
end $$;

-- act(staff id): the next calls run as this signed-in staff member
create function pg_temp.act(p_staff uuid) returns void
language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_staff, 'role', 'authenticated')::text, true);
$$;

do $$
declare
  v_owner   uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_sup     uuid := 'eeeeeeee-0000-0000-0000-000000000051';   -- supervisor of VERIFY H (approves)
  v_a       uuid := 'eeeeeeee-0000-0000-0000-000000000052';   -- cashier A of VERIFY H
  v_b       uuid := 'eeeeeeee-0000-0000-0000-000000000053';   -- cashier B of VERIFY H
  v_far     uuid := 'eeeeeeee-0000-0000-0000-000000000054';   -- supervisor of another branch
  v_branch uuid; v_branch2 uuid;
  v_t1 dining_tables; v_t2 dining_tables; v_t3 dining_tables; v_t4 dining_tables;
  v_cat uuid; v_catalog uuid; v_plate uuid; v_plate_v uuid; v_tea uuid; v_tea_v uuid;
  v_cash uuid; v_card uuid;
  b1 uuid; b2 uuid; b3 uuid; b4 uuid; b5 uuid; b6 uuid; b7 uuid;
  s1 uuid; s2 uuid; v_far_shift uuid; c1 timestamptz;
  v_checkout uuid := 'eeeeeeee-2222-0000-0000-000000000001';
  v_pay jsonb;
  v_a_tot jsonb; v_b_tot jsonb; v_res jsonb; v_res2 jsonb; v_rep1 jsonb; v_rep2 jsonb;
  v_item uuid; v_item2 uuid; v_job1 uuid; v_job2 uuid; v_id uuid; v_until timestamptz;
  n integer; r record; v_role text; v_priv text;
begin
  -- ── A. schema, grants, internal helpers, search_path, canonical bodies ──────
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bills'
                  and column_name = 'updated_at' and is_nullable = 'NO') then
    raise exception 'FAIL schema: bills.updated_at is missing';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'order_items'
                  and column_name = 'order_type' and is_nullable = 'NO')
     or not exists (select 1 from pg_constraint where conname = 'order_items_order_type_check')
     or not exists (select 1 from pg_trigger where tgname = 'order_items_order_type' and tgrelid = 'order_items'::regclass) then
    raise exception 'FAIL schema: order_items.order_type, its check or its trigger is missing';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'pos_pin_attempts')
     or not (select relrowsecurity from pg_class where relname = 'pos_pin_attempts' and relnamespace = 'public'::regnamespace) then
    raise exception 'FAIL rls: pos_pin_attempts must be read and written only through pos_pin_attempt';
  end if;
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if has_table_privilege(v_role, 'pos_pin_attempts', v_priv) then
        raise exception 'FAIL rls: % has % on pos_pin_attempts', v_role, v_priv;
      end if;
    end loop;
  end loop;
  for r in select f from unnest(array[
             'pos_compute_bill(jsonb)', 'pos_bill_totals(uuid)', 'pos_checkout_state(uuid,uuid[])', 'checkout_bill(uuid,jsonb,uuid)',
             'void_order_item(uuid,text,uuid,text)', 'set_my_pos_pin(text,text)', 'claim_print_job(uuid)',
             'finish_print_job(uuid,boolean,text)', 'requeue_print_job(uuid)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') then raise exception 'FAIL grants: anon can call %', r.f; end if;
    if not has_function_privilege('authenticated', r.f, 'execute') then raise exception 'FAIL grants: staff cannot call %', r.f; end if;
  end loop;
  for r in select f from unnest(array[
             'pos_checkout_same_payments(uuid,jsonb)', 'pos_shift_report(uuid)', 'pos_pin_attempt(uuid,text)',
             'order_items_order_type()']) as f loop
    if has_function_privilege('anon', r.f, 'execute') or has_function_privilege('authenticated', r.f, 'execute') then
      raise exception 'FAIL grants: % must be internal', r.f;
    end if;
  end loop;
  for r in select p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'public' and p.proname = any (array[
              'order_items_order_type','pos_compute_bill','pos_bill_totals','pos_checkout_state','pos_checkout_same_payments',
              'checkout_bill','void_order_item','pos_shift_report','pos_pin_attempt','set_my_pos_pin',
              'claim_print_job','finish_print_job','requeue_print_job'])
              and not coalesce(p.proconfig @> array['search_path=public, pg_temp'], false) loop
    raise exception 'FAIL search_path: % does not pin search_path = public, pg_temp', r.proname;
  end loop;
  if exists (select 1 from pg_proc where proname in ('claim_print_job', 'finish_print_job', 'requeue_print_job') and not prosecdef) then
    raise exception 'FAIL H7: the print job functions must be security definer';
  end if;
  for r in select x.f, count(p.oid) as n from unnest(array['pos_compute_bill','pos_bill_totals','checkout_bill','void_order_item',
              'pos_shift_report','pos_pin_attempt','set_my_pos_pin','claim_print_job','finish_print_job','requeue_print_job']) as x(f)
              left join pg_proc p on p.proname = x.f group by x.f loop
    if r.n <> 1 then raise exception 'FAIL: % has % definitions', r.f, r.n; end if;
  end loop;
  -- re-running shifts-fn, bill-actions-fn or checkout-fixes puts an old body back: re-run the hardening file
  if pg_get_functiondef('checkout_bill(uuid,jsonb,uuid)'::regprocedure) not like '%pos_checkout_same_payments%'
     or pg_get_functiondef('checkout_bill(uuid,jsonb,uuid)'::regprocedure) not like '%Open the shift first%'
     or pg_get_functiondef('pos_shift_report(uuid)'::regprocedure) not like '%prev_close%'
     or pg_get_functiondef('void_order_item(uuid,text,uuid,text)'::regprocedure) not like '%update bills set updated_at = now()%'
     or pg_get_functiondef('pos_pin_attempt(uuid,text)'::regprocedure) not like '%pos_pin_attempts%'
     or pg_get_functiondef('pos_pin_attempt(uuid,text)'::regprocedure) like '%update staff_pos_pins%'
     or pg_get_functiondef('set_my_pos_pin(text,text)'::regprocedure) like '%failed_attempts%'
     or pg_get_functiondef('pos_compute_bill(jsonb)'::regprocedure) not like '%orderType%ln.order_type%'
     or pg_get_functiondef('pos_bill_totals(uuid)'::regprocedure) not like '%oi.order_type%' then
    raise exception 'FAIL: an older body is back — re-run migration-2026-10-25-pos-hardening.sql';
  end if;

  -- ── B. fixture: two branches, two products with a packaging fee, two methods, staff ──
  update system_role_permissions set permissions = permissions - 'pos_supervise' - 'access_settings' where true;   -- code defaults
  insert into branches(name, address, receipt_title) values ('VERIFY H', 'verify', 'Verify H Cafe') returning id into v_branch;
  insert into branches(name, address) values ('VERIFY H FAR', 'far') returning id into v_branch2;
  insert into dining_tables(branch_id, label) values (v_branch, 'H1') returning * into v_t1;
  insert into dining_tables(branch_id, label) values (v_branch, 'H2') returning * into v_t2;
  insert into dining_tables(branch_id, label) values (v_branch, 'H3') returning * into v_t3;
  insert into dining_tables(branch_id, label) values (v_branch, 'H4') returning * into v_t4;
  insert into print_routes(branch_id, name, kind, address) values (v_branch, 'Bar', 'agent', '127.0.0.1:9100');
  insert into branch_pos_settings(branch_id, receipt_route) values (v_branch, 'Bar');
  -- 10% on dine-in at table H1 (and on takeaway at H1, which a takeaway never is), 5% on takeaway
  insert into service_charge_rules(branch_id, rate_bp, order_types, table_ids, sort_order)
  values (v_branch, 1000, array['dine_in', 'takeaway'], array[v_t1.id], 1);
  insert into service_charge_rules(branch_id, rate_bp, order_types, sort_order) values (v_branch, 500, array['takeaway'], 2);
  insert into menu_categories(name, sort_order) values ('VERIFY H FOOD', 900) returning id into v_cat;
  insert into menu_products(name, category_id, sst_rate_bp, takeaway_fee_sen) values ('Verify H Plate', v_cat, 600, 100) returning id into v_plate;
  insert into menu_products(name, category_id, sst_rate_bp, takeaway_fee_sen) values ('Verify H Tea', v_cat, 0, 50) returning id into v_tea;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_plate, '', 'Regular', 2000) returning id into v_plate_v;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_tea, '', 'Regular', 550) returning id into v_tea_v;
  insert into menu_catalogs(name, sort_order) values ('VERIFY H CATALOG', 900) returning id into v_catalog;
  insert into catalog_products(catalog_id, product_id, availability) values (v_catalog, v_plate, 'all'), (v_catalog, v_tea, 'all');
  insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (v_catalog, v_plate_v, 2000), (v_catalog, v_tea_v, 550);
  insert into branch_catalogs(branch_id, role, catalog_id) values
    (v_branch, 'dine_in', v_catalog), (v_branch, 'takeaway', v_catalog), (v_branch, 'qr', v_catalog);
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_branch, 'H Cash', 'cash', 1) returning id into v_cash;
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_branch, 'H Card', 'card', 2) returning id into v_card;
  update staff set branch_id = v_branch where id = v_owner;
  -- staff are inserted as 'staff' and promoted by the owner (the staff guard refuses anything else)
  perform pg_temp.act(v_owner);
  insert into auth.users (id) values (v_sup), (v_a), (v_b), (v_far);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_sup, 'Verify H Supervisor', 'trainee', true, current_date, 'staff', v_branch),
    (v_a,   'Verify H Cashier A',  'trainee', true, current_date, 'staff', v_branch),
    (v_b,   'Verify H Cashier B',  'trainee', true, current_date, 'staff', v_branch),
    (v_far, 'Verify H Far',        'trainee', true, current_date, 'staff', v_branch2);
  update staff set system_role = 'supervisor' where id in (v_sup, v_far);
  perform pg_temp.act(v_sup);
  if not (set_my_pos_pin('2468', null)->>'ok')::boolean then raise exception 'FAIL fixture: supervisor PIN'; end if;

  -- ── H4. a takeaway merged into a table keeps its fee, its SST and its service-charge rule ──
  perform pg_temp.act(v_a);
  v_id := place_counter_order(v_t1.id, 'dine_in', 2,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_v)), gen_random_uuid());
  b1 := (select bill_id from orders where id = v_id);
  v_id := place_counter_order(null, 'takeaway', null, jsonb_build_array(
    jsonb_build_object('productId', v_plate, 'variantId', v_plate_v, 'qty', 2),
    jsonb_build_object('productId', v_tea, 'variantId', v_tea_v)), gen_random_uuid());
  b2 := (select bill_id from orders where id = v_id);
  if (select string_agg(order_type, ',') from order_items where bill_id = b1) is distinct from 'dine_in'
     or (select string_agg(distinct order_type, ',') from order_items where bill_id = b2) is distinct from 'takeaway' then
    raise exception 'FAIL H4: order_items.order_type is not set from the bill';
  end if;
  -- apart: H1 = 20.00 + 10% 2.00 + SST 1.20 = 23.20; takeaway = 45.50 + 5% 2.28 (2.275 half up)
  --        + SST 6% of (40.00 + fee 2.00) 2.52 + fee 2.50 = 52.80
  v_a_tot := pos_bill_totals(b1);
  v_b_tot := pos_bill_totals(b2);
  if (v_a_tot->>'totalSen')::int is distinct from 2320 or (v_b_tot->>'totalSen')::int is distinct from 5280
     or (v_b_tot->>'takeawayFeeSen')::int is distinct from 250 then
    raise exception 'FAIL H4 apart: % %', v_a_tot, v_b_tot;
  end if;
  perform merge_bills(b2, b1);
  -- merged = apart before rounding, exactly here: every rate's base rounds without a remainder
  -- (in general up to 1 sen per service-charge or SST rate both bills share)
  if (select count(*) from order_items where bill_id = b1 and order_type = 'takeaway') is distinct from 2 then
    raise exception 'FAIL H4: merge changed the takeaway items'' order type';
  end if;
  v_res := pos_bill_totals(b1);
  if v_res is distinct from '{"subtotalSen": 6550, "serviceChargeSen": 428, "sstSen": 372, "takeawayFeeSen": 250,
        "beforeRoundingSen": 7600, "roundingSen": 0, "totalSen": 7600,
        "sstGroups": [{"rateBp": 600, "baseSen": 6200, "amountSen": 372}],
        "serviceChargeGroups": [{"rateBp": 500, "baseSen": 4550, "amountSen": 228}, {"rateBp": 1000, "baseSen": 2000, "amountSen": 200}]}'::jsonb
     or (v_res->>'beforeRoundingSen')::int is distinct from (v_a_tot->>'beforeRoundingSen')::int + (v_b_tot->>'beforeRoundingSen')::int then
    raise exception 'FAIL H4 merged totals: %', v_res;
  end if;
  -- an order added to the table after the merge is dine-in
  v_id := place_counter_order(v_t1.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_tea, 'variantId', v_tea_v)), gen_random_uuid());
  if (select order_type from order_items where order_id = v_id) is distinct from 'dine_in' then
    raise exception 'FAIL H4: a new order on the merged bill is not dine-in';
  end if;
  perform void_order_item((select id from order_items where order_id = v_id), 'Wrong item keyed', v_sup, '2468');
  if (pos_bill_totals(b1)->>'totalSen')::int is distinct from 7600 then raise exception 'FAIL H4: the voided tea still counts'; end if;

  -- ── H1. the checkout state: open (with totals), merged (with the bill it went into) ──
  v_id := place_counter_order(v_t2.id, 'dine_in', 1,
    jsonb_build_array(jsonb_build_object('productId', v_tea, 'variantId', v_tea_v)), gen_random_uuid());
  b3 := (select bill_id from orders where id = v_id);
  v_id := place_counter_order(null, 'takeaway', null,
    jsonb_build_array(jsonb_build_object('productId', v_tea, 'variantId', v_tea_v)), gen_random_uuid());
  b4 := (select bill_id from orders where id = v_id);
  set local role authenticated;
  v_res := pos_checkout_state(b3, null);
  reset role;
  if v_res is distinct from jsonb_build_object('status', 'open', 'billNo', (select bill_no from bills where id = b3),
       'mergedIntoBillNo', null, 'totals', pos_bill_totals(b3), 'result', null) then
    raise exception 'FAIL H1 open: %', v_res;
  end if;
  perform merge_bills(b4, b3);
  v_res := pos_checkout_state(b4, null);
  if v_res->>'status' is distinct from 'merged' or v_res->>'mergedIntoBillNo' is distinct from (select bill_no from bills where id = b3)
     or v_res->'totals' is distinct from 'null'::jsonb or v_res->'result' is distinct from 'null'::jsonb then
    raise exception 'FAIL H1 merged: %', v_res;
  end if;
  perform pg_temp.act(v_far);
  perform pg_temp.expect_error(format('select pos_checkout_state(%L, null)', b3), 'Bill not found', 'H1 another branch');
  perform pg_temp.act(v_a);

  -- ── H2. a replayed checkout id must carry the very same payments ─────────────
  s1 := (open_shift(10000)->'shift'->>'id')::uuid;
  update pos_shifts set opened_at = now() - interval '3 hours' where id = s1;   -- the shift began three hours ago
  v_pay := jsonb_build_array(jsonb_build_object('methodId', v_card, 'amountSen', 2000, 'reference', null),
                             jsonb_build_object('methodId', v_cash, 'amountSen', 5600, 'tenderedSen', 6000));
  v_res := checkout_bill(b1, v_pay, v_checkout);
  if (v_res->>'totalSen')::int is distinct from 7600 or (v_res->>'changeSen')::int is distinct from 400
     or (select takeaway_fee_sen from bills where id = b1) is distinct from 250 then
    raise exception 'FAIL H2 checkout: %', v_res;
  end if;
  -- the same payments again (the method id in capitals too): the first answer, nothing new
  v_res2 := checkout_bill(b1, jsonb_build_array(
    jsonb_build_object('methodId', upper(v_card::text), 'amountSen', 2000),
    jsonb_build_object('methodId', v_cash, 'amountSen', 5600, 'tenderedSen', 6000)), v_checkout);
  if v_res2 is distinct from v_res or (select count(*) from payments where bill_id = b1) is distinct from 2 then
    raise exception 'FAIL H2 replay: %', v_res2;
  end if;
  -- other amounts, other cash received, another order, fewer lines, none: refused, nothing written
  foreach v_pay in array array[
      jsonb_build_array(jsonb_build_object('methodId', v_card, 'amountSen', 2600), jsonb_build_object('methodId', v_cash, 'amountSen', 5000)),
      jsonb_build_array(jsonb_build_object('methodId', v_card, 'amountSen', 2000),
                        jsonb_build_object('methodId', v_cash, 'amountSen', 5600, 'tenderedSen', 10000)),
      jsonb_build_array(jsonb_build_object('methodId', v_cash, 'amountSen', 5600, 'tenderedSen', 6000),
                        jsonb_build_object('methodId', v_card, 'amountSen', 2000)),
      jsonb_build_array(jsonb_build_object('methodId', v_cash, 'amountSen', 7600)),
      '[]'::jsonb, '"x"'::jsonb] loop
    perform pg_temp.expect_error(format('select checkout_bill(%L, %L::jsonb, %L)', b1, v_pay, v_checkout),
      'This payment was already recorded with other amounts — check Today''s bills', 'H2 replay ' || v_pay::text);
  end loop;
  if (select count(*) from payments where bill_id = b1) is distinct from 2 then raise exception 'FAIL H2: a refused replay wrote payments'; end if;
  -- the sheet that paid gets its result back from the state — also when the paying id is an
  -- earlier one it sent (Check bill gave it a new id meanwhile); any other sheet does not
  if pos_checkout_state(b1, array[v_checkout]) is distinct from jsonb_build_object('status', 'paid', 'billNo', (select bill_no from bills where id = b1),
       'mergedIntoBillNo', null, 'totals', null, 'result', v_res)
     or pos_checkout_state(b1, array[v_checkout, gen_random_uuid()])->'result' is distinct from v_res
     or pos_checkout_state(b1, array[gen_random_uuid(), v_checkout])->'result' is distinct from v_res
     or pos_checkout_state(b1, array[gen_random_uuid()])->'result' is distinct from 'null'::jsonb
     or pos_checkout_state(b1, null)->'result' is distinct from 'null'::jsonb then
    raise exception 'FAIL H1 paid: %', pos_checkout_state(b1, array[v_checkout]);
  end if;

  -- ── H3. an item void touches its bill (a bills event for the other iPads) ───
  update bills set updated_at = now() - interval '1 hour' where id = b3;
  v_res := void_order_item((select id from order_items where bill_id = b3 and order_type = 'dine_in'), 'Wrong item keyed', v_sup, '0000');
  if (v_res->>'ok')::boolean or (select updated_at from bills where id = b3) is distinct from now() - interval '1 hour' then
    raise exception 'FAIL H3: a refused void touched the bill: %', v_res;
  end if;
  v_res := void_order_item((select id from order_items where bill_id = b3 and order_type = 'dine_in'), 'Wrong item keyed', v_sup, '2468');
  if not (v_res->>'ok')::boolean or (select updated_at from bills where id = b3) is distinct from now() then
    raise exception 'FAIL H3: the void did not touch the bill: %', v_res;
  end if;

  -- ── H5. voids between shifts go to the next shift, once ──────────────────────
  -- during shift 1: the tea on S1 (H4) and the dine-in tea on H2 (H3)
  v_res := close_shift(s1, pos_shift_expected_cash(s1), null, null, null, null);
  if not (v_res->>'ok')::boolean then raise exception 'FAIL H5 close 1: %', v_res; end if;
  v_rep1 := v_res->'report';
  c1 := (select closed_at from pos_shifts where id = s1);
  if jsonb_array_length(v_rep1->'voids'->'items') is distinct from 2 then raise exception 'FAIL H5 shift 1 voids: %', v_rep1->'voids'; end if;
  -- no shift open: voids are still allowed (ordering works without a shift)
  v_item := (select id from order_items where bill_id = b3 and order_type = 'takeaway');
  if not (void_order_item(v_item, 'Wrong item keyed', v_sup, '2468')->>'ok')::boolean then raise exception 'FAIL H5 void between shifts'; end if;
  update order_items set voided_at = c1 + interval '1 millisecond' where id = v_item;
  v_id := place_counter_order(v_t3.id, 'dine_in', 1,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_v)), gen_random_uuid());
  b5 := (select bill_id from orders where id = v_id);
  if not (void_bill(b5, 'Customer left', v_sup, '2468')->>'ok')::boolean then raise exception 'FAIL H5 bill void between shifts'; end if;
  -- H1: the checkout state of a voided bill — no totals, no result
  v_res := pos_checkout_state(b5, array[gen_random_uuid()]);
  if v_res is distinct from jsonb_build_object('status', 'voided', 'billNo', (select bill_no from bills where id = b5),
       'mergedIntoBillNo', null, 'totals', null, 'result', null) then
    raise exception 'FAIL H1 voided: %', v_res;
  end if;
  update order_items set voided_at = c1 + interval '2 milliseconds' where bill_id = b5;
  update bills set closed_at = c1 + interval '2 milliseconds' where id = b5;
  -- a void at the very moment of the close belongs to shift 1 (its report is frozen), never to shift 2
  v_id := place_counter_order(v_t4.id, 'dine_in', 1,
    jsonb_build_array(jsonb_build_object('productId', v_tea, 'variantId', v_tea_v)), gen_random_uuid());
  b6 := (select bill_id from orders where id = v_id);
  v_item2 := (select id from order_items where bill_id = b6);
  perform void_order_item(v_item2, 'Wrong item keyed', v_sup, '2468');
  update order_items set voided_at = c1 where id = v_item2;
  -- another branch closes a shift later: it does not move this branch's window
  perform pg_sleep(0.02);
  perform pg_temp.act(v_far);
  v_far_shift := (open_shift(0)->'shift'->>'id')::uuid;
  if not (close_shift(v_far_shift, 0, null, null, null, null)->>'ok')::boolean then raise exception 'FAIL H5 far close'; end if;
  perform pg_temp.act(v_b);
  s2 := (open_shift(10000)->'shift'->>'id')::uuid;
  update pos_shifts set opened_at = c1 + interval '3 milliseconds' where id = s2;
  perform pg_sleep(0.02);
  v_res := close_shift(s2, pos_shift_expected_cash(s2), null, null, null, null);
  if not (v_res->>'ok')::boolean then raise exception 'FAIL H5 close 2: %', v_res; end if;
  v_rep2 := v_res->'report';
  if (select string_agg((v->>'qty') || ' ' || (v->>'name') || ' ' || (v->>'valueSen'), ', ' order by v->>'at')
        from jsonb_array_elements(v_rep2->'voids'->'items') v) is distinct from '1 Verify H Tea 550, 1 Verify H Plate 2000'
     or jsonb_array_length(v_rep2->'voids'->'bills') is distinct from 1
     or v_rep2->'voids'->'bills'->0->>'billNo' is distinct from (select bill_no from bills where id = b5)
     or (v_rep2->'summary'->>'voidBillCount')::int is distinct from 1 or (v_rep2->'summary'->>'voidSen')::int is distinct from 2550 then
    raise exception 'FAIL H5 shift 2 voids: % %', v_rep2->'voids', v_rep2->'summary';
  end if;
  if (select report from pos_shifts where id = s1) is distinct from v_rep1 then raise exception 'FAIL H5: shift 1''s report changed'; end if;
  -- the first shift of a branch: voids from its own open (nothing before it)
  if pos_shift_report(v_far_shift)->'voids' is distinct from '{"items": [], "bills": []}'::jsonb then
    raise exception 'FAIL H5 far report: %', pos_shift_report(v_far_shift)->'voids';
  end if;

  -- ── H6. wrong PINs count per approver and caller ───────────────────────────
  perform pg_temp.act(v_a);
  v_id := place_counter_order(v_t3.id, 'dine_in', 1, jsonb_build_array(
    jsonb_build_object('productId', v_tea, 'variantId', v_tea_v), jsonb_build_object('productId', v_plate, 'variantId', v_plate_v)), gen_random_uuid());
  b7 := (select bill_id from orders where id = v_id);
  v_item := (select id from order_items where order_id = v_id and product_id = v_tea);
  v_item2 := (select id from order_items where order_id = v_id and product_id = v_plate);
  for n in 1..4 loop
    v_res := void_order_item(v_item, 'Wrong item keyed', v_sup, '0000');
    if v_res->>'error' is distinct from format('Wrong PIN — %s %s left', 5 - n, case when n = 4 then 'try' else 'tries' end) then
      raise exception 'FAIL H6 try %: %', n, v_res;
    end if;
  end loop;
  v_res := void_order_item(v_item, 'Wrong item keyed', v_sup, '0000');
  if v_res->>'error' is distinct from 'Wrong PIN — locked for 10 minutes after 5 wrong tries' then raise exception 'FAIL H6 lock: %', v_res; end if;
  v_until := (select locked_until from pos_pin_attempts where approver_id = v_sup and caller_id = v_a);
  v_res := void_order_item(v_item, 'Wrong item keyed', v_sup, '2468');
  if v_res->>'error' is distinct from 'Too many wrong PINs — try again after ' || to_char(v_until at time zone 'Asia/Kuala_Lumpur', 'HH24:MI')
     or v_until is distinct from now() + interval '10 minutes'
     or (select voided_at from order_items where id = v_item) is not null then
    raise exception 'FAIL H6 locked caller: %', v_res;
  end if;
  -- the approver's own row is not touched; caller B and the approver themself still approve
  if (select failed_attempts || ':' || coalesce(locked_until::text, '-') from staff_pos_pins where staff_id = v_sup) is distinct from '0:-' then
    raise exception 'FAIL H6: staff_pos_pins was written';
  end if;
  perform pg_temp.act(v_b);
  if not (void_order_item(v_item, 'Wrong item keyed', v_sup, '2468')->>'ok')::boolean then raise exception 'FAIL H6: caller B is locked out too'; end if;
  perform pg_temp.act(v_sup);
  if not (void_order_item(v_item2, 'Customer changed mind', v_sup, '2468')->>'ok')::boolean then raise exception 'FAIL H6: the approver is locked out'; end if;
  if (select failed_attempts from pos_pin_attempts where approver_id = v_sup and caller_id = v_b) is distinct from 0
     or (select locked_until from pos_pin_attempts where approver_id = v_sup and caller_id = v_a) is distinct from v_until then
    raise exception 'FAIL H6 rows: %', (select json_agg(p) from pos_pin_attempts p where p.approver_id = v_sup);
  end if;
  -- My PIN: the caller is the approver — the same table, the same rule
  v_res := set_my_pos_pin('1357', '0000');
  if (v_res->>'ok')::boolean or v_res->>'error' is distinct from 'Current PIN: Wrong PIN — 4 tries left'
     or (select failed_attempts from pos_pin_attempts where approver_id = v_sup and caller_id = v_sup) is distinct from 1 then
    raise exception 'FAIL H6 my PIN wrong: %', v_res;
  end if;
  v_res := set_my_pos_pin('1357', '2468');          -- called on its own: a condition's subqueries may run before it
  -- a new PIN starts every pair afresh: A's lock and every count against the approver are gone
  if not (v_res->>'ok')::boolean
     or exists (select 1 from pos_pin_attempts where approver_id = v_sup)
     or (select failed_attempts from staff_pos_pins where staff_id = v_sup) is distinct from 0 then
    raise exception 'FAIL H6 my PIN: % %', v_res, (select json_agg(p) from pos_pin_attempts p where p.approver_id = v_sup);
  end if;
  -- a day without a try forgets the count: 4 old failures + 1 new = "4 tries left", not a lock
  -- (the new PIN deleted A's row: insert it again)
  insert into pos_pin_attempts(approver_id, caller_id, failed_attempts, locked_until, updated_at)
  values (v_sup, v_a, 4, null, now() - interval '2 days')
  on conflict (approver_id, caller_id) do update
     set failed_attempts = excluded.failed_attempts, locked_until = excluded.locked_until, updated_at = excluded.updated_at;
  perform pg_temp.act(v_a);
  v_id := place_counter_order(v_t3.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_tea, 'variantId', v_tea_v)), gen_random_uuid());
  v_res := void_order_item((select id from order_items where order_id = v_id), 'Wrong item keyed', v_sup, '0000');
  if v_res->>'error' is distinct from 'Wrong PIN — 4 tries left' then raise exception 'FAIL H6 idle day: %', v_res; end if;

  -- ── H7. print jobs: only the caller's branch ───────────────────────────────
  insert into print_jobs(branch_id, route, kind, payload) values (v_branch, 'Bar', 'ticket', '{}'::jsonb) returning id into v_job1;
  insert into print_jobs(branch_id, route, kind, payload) values (v_branch2, 'Bar', 'ticket', '{}'::jsonb) returning id into v_job2;
  if claim_print_job(v_job2) or (select status || ':' || attempts from print_jobs where id = v_job2) is distinct from 'pending:0' then
    raise exception 'FAIL H7: claimed another branch''s job';
  end if;
  if not claim_print_job(v_job1) then raise exception 'FAIL H7: own job claim'; end if;
  if claim_print_job(v_job1) then raise exception 'FAIL H7: own job claimed twice'; end if;
  update print_jobs set status = 'printing' where id = v_job2;
  perform finish_print_job(v_job2, true, null);
  if (select status from print_jobs where id = v_job2) is distinct from 'printing' then raise exception 'FAIL H7: finished another branch''s job'; end if;
  perform finish_print_job(v_job1, false, 'Not sent: paper out');
  if (select status || ':' || last_error from print_jobs where id = v_job1) is distinct from 'failed:Not sent: paper out' then
    raise exception 'FAIL H7: own job finish';
  end if;
  update print_jobs set status = 'failed' where id = v_job2;
  perform requeue_print_job(v_job2);
  if (select status from print_jobs where id = v_job2) is distinct from 'failed' then raise exception 'FAIL H7: requeued another branch''s job'; end if;
  perform requeue_print_job(v_job1);
  if (select status from print_jobs where id = v_job1) is distinct from 'pending' then raise exception 'FAIL H7: own job requeue'; end if;
  -- ...while the far branch's own host still can
  perform pg_temp.act(v_far);
  perform requeue_print_job(v_job2);
  if (select status from print_jobs where id = v_job2) is distinct from 'pending' or not claim_print_job(v_job2) then
    raise exception 'FAIL H7: the far branch cannot handle its own job';
  end if;

  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;
rollback;
```

- [ ] **Step 2: Bring the two regression scripts up to the new rules** (a replay must carry the same payments; wrong PINs are counted in `pos_pin_attempts` per approver and caller). In `supabase/migration-2026-10-24-pos-checkout-verify.sql` make exactly these replacements (each old text occurs once):

1. Replace:

```sql
-- Self-check for the POS checkout migrations (Sub-plan 3). Run on craft-os-dev after
-- migration-2026-10-24-pos-checkout.sql, -checkout-fn.sql, -bill-actions-fn.sql and
-- -checkout-fixes.sql.
```

   with:

```sql
-- Self-check for the POS checkout migrations (Sub-plan 3). Run on craft-os-dev after
-- migration-2026-10-24-pos-checkout.sql, -checkout-fn.sql, -bill-actions-fn.sql and
-- -checkout-fixes.sql — and, since the pre-pilot hardening, after
-- migration-2026-10-25-pos-hardening.sql (the merge vector, a replay with the same
-- payments only, wrong PINs counted per approver and caller in pos_pin_attempts).
```

2. Replace:

```sql
  -- the same checkout again: the first answer, nothing new
  if checkout_bill(v_bill.id, '[]'::jsonb, v_checkout) <> v_res then raise exception 'FAIL checkout replay'; end if;
```

   with:

```sql
  -- the same checkout again: the first answer, nothing new — only with the very same payments (hardening)
  if checkout_bill(v_bill.id, jsonb_build_array(
       jsonb_build_object('methodId', v_tng, 'amountSen', 5000, 'reference', null),
       jsonb_build_object('methodId', v_cash, 'amountSen', 4280, 'tenderedSen', 5000)), v_checkout) <> v_res then
    raise exception 'FAIL checkout replay';
  end if;
  begin perform checkout_bill(v_bill.id, '[]'::jsonb, v_checkout); raise exception 'FAIL: replay with other payments accepted';
  exception when raise_exception then
    if sqlerrm <> 'This payment was already recorded with other amounts — check Today''s bills' then raise; end if;
  end;
```

3. Replace:

```sql
  if (select failed_attempts from staff_pos_pins where staff_id = v_sup) <> 0 then raise exception 'FAIL pin: counter not reset'; end if;
```

   with:

```sql
  -- a new PIN deletes every wrong-try row against this approver (hardening H6)
  if exists (select 1 from pos_pin_attempts where approver_id = v_sup) then
    raise exception 'FAIL pin: counter not reset';
  end if;
```

4. Replace:

```sql
  if (select failed_attempts from staff_pos_pins where staff_id = v_sup) <> 1 then raise exception 'FAIL: wrong PIN not counted'; end if;
```

   with:

```sql
  if (select failed_attempts from pos_pin_attempts where approver_id = v_sup and caller_id = v_staff) <> 1 then
    raise exception 'FAIL: wrong PIN not counted';
  end if;
```

5. Replace:

```sql
  -- lockout: 5 wrong PINs lock the approver for 10 minutes, even the right PIN
```

   with:

```sql
  -- lockout: 5 wrong PINs lock this caller out of the approver for 10 minutes, even the right PIN
```

6. Replace:

```sql
  if (v_res->>'ok')::boolean or v_res->>'error' not like 'Too many wrong PINs — locked until %' then raise exception 'FAIL locked: %', v_res; end if;
  update staff_pos_pins set locked_until = now() - interval '1 second' where staff_id = v_sup;
  -- wrong tries older than a day are forgotten: 4 old failures + 1 new = "4 tries left", not a lock
  update staff_pos_pins set failed_attempts = 4, updated_at = now() - interval '2 days' where staff_id = v_sup;
```

   with:

```sql
  if (v_res->>'ok')::boolean or v_res->>'error' not like 'Too many wrong PINs — try again after %' then raise exception 'FAIL locked: %', v_res; end if;
  update pos_pin_attempts set locked_until = now() - interval '1 second' where approver_id = v_sup and caller_id = v_staff;
  -- wrong tries older than a day are forgotten: 4 old failures + 1 new = "4 tries left", not a lock
  update pos_pin_attempts set failed_attempts = 4, updated_at = now() - interval '2 days' where approver_id = v_sup and caller_id = v_staff;
```

In `supabase/migration-2026-10-24-pos-shifts-verify.sql` make exactly these replacements (each old text occurs once):

1. Replace:

```sql
-- Self-check for POS Sub-plan 4a (shifts, Pay in / Pay out, the Z report). Run on
-- craft-os-dev after migration-2026-10-24-pos-shifts.sql and -shifts-fn.sql.
```

   with:

```sql
-- Self-check for POS Sub-plan 4a (shifts, Pay in / Pay out, the Z report). Run on
-- craft-os-dev after migration-2026-10-24-pos-shifts.sql and -shifts-fn.sql — and, since
-- the pre-pilot hardening, after migration-2026-10-25-pos-hardening.sql (wrong PINs are
-- counted in pos_pin_attempts).
```

2. Replace:

```sql
     or (select failed_attempts from staff_pos_pins where staff_id = v_sup) is distinct from 0 then
```

   with:

```sql
     or exists (select 1 from pos_pin_attempts where approver_id = v_sup and failed_attempts <> 0) then
```

- [ ] **Step 3: Local checks.** Run: `grep -c "VERIFY OK" supabase/migration-2026-10-25-pos-hardening-verify.sql` — Expected: `3` (header, notice, final select). Run: `grep -c "perform pg_temp.expect_error" supabase/migration-2026-10-25-pos-hardening-verify.sql` — Expected: `2` (H1 another branch, and the H2 loop over six refused replays). Run: `grep -n "insert into staff" -B3 supabase/migration-2026-10-25-pos-hardening-verify.sql | grep -c "act(v_owner)"` — Expected: `1` (the staff are inserted after the claims are set to the owner). Run: `grep -cE 'staff_pos_pins where staff_id = v_sup\) <> |update staff_pos_pins' supabase/migration-2026-10-24-pos-checkout-verify.sql` — Expected: `0`. Run: `npx vitest run` — Expected: 100 files, 881 tests pass (the scan ignores `-verify` files; `bill.test.ts` still finds the 23 vectors in the checkout verify).

- [ ] **Step 4: Commit**

```bash
git add supabase/migration-2026-10-25-pos-hardening-verify.sql supabase/migration-2026-10-24-pos-checkout-verify.sql supabase/migration-2026-10-24-pos-shifts-verify.sql
git commit -m "test(pos): hardening verify; checkout and shifts verify follow the replay rule and PINs per caller

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5 (controller, craft-os-dev — dashboard SQL editor in the owner's Chrome tab; the implementer does not touch the database):** the migration is already applied (Task 1 Step 9). Confirm the top bar reads **craft-os-dev** (`egznnbjmicebbhwasloy`) — never the prod project. Load each file with `window.monaco.editor.getModels()[0].setValue(...)` and run it with `cmd+Return`, in order:
  1. `supabase/migration-2026-10-25-pos-hardening-verify.sql` → `VERIFY OK`.
  2. The regression scripts, each → `VERIFY OK`: `migration-2026-10-24-pos-shifts-verify.sql`, `migration-2026-10-24-pos-checkout-verify.sql`, `migration-2026-10-23-pos-ordering-verify.sql`, `migration-2026-10-22-pos-menu-verify.sql`, `migration-2026-10-24-pos-catalogs-verify.sql`, `migration-2026-10-24-pos-menu-editor-verify.sql`, `migration-2026-10-24-pos-slots-photos-verify.sql`.
  3. Read-only spot checks of the backfill: `select order_type, count(*), sum((takeaway_fee_sen > 0)::int) from order_items group by 1` → no null row; every row with a fee is `takeaway`. And `select count(*) from order_items oi join bills b on b.id = oi.bill_id where oi.order_type = 'dine_in' and b.order_type = 'takeaway'` → `0` (no takeaway item labelled dine-in).

  A `FAIL …` row names the check; fix the SQL in the worktree (never edit the scripts to pass), re-apply the migration (Task 1 Step 9), re-run 1–2, and commit the fix with the task's files.

---

### Task 4: The pure rules — the sheet follows its bill; the unsure-reply state machine; one "no reply" classifier

**Model tier:** cheap.

**Files:**
- Create: `src/features/pos/checkout/follow.ts`, `src/features/pos/checkout/follow.test.ts`, `src/features/pos/checkout/paySession.ts`, `src/features/pos/checkout/paySession.test.ts`
- Modify: `src/features/pos/checkout/checkoutApi.ts`, `src/features/pos/checkout/rpcResult.ts`, `src/features/pos/checkout/rpcResult.test.ts`, `src/features/pos/shift/shift.ts`, `src/features/pos/shift/shift.test.ts`, `src/features/pos/shift/CloseShiftSheet.tsx`

**Interfaces:**
- Consumes: `pos_checkout_state` (Task 1); `BillTotals` (`bill.ts`); `CheckoutResult`, `parseCheckoutResult` (`rpcResult.ts`).
- Produces (Task 5 uses exactly these):
  - `follow.ts`: `type BillStatus = 'open'|'paid'|'voided'|'merged'`; `interface CheckoutState { status; billNo: string; mergedIntoBillNo: string|null; totals: BillTotals|null; result: CheckoutResult|null }`; `type FollowAction = {kind:'keep'} | {kind:'paidHere'; result} | {kind:'lock'; note: string} | {kind:'reload'; totals: BillTotals; note: string|null}`; `followBill(state: CheckoutState, shownTotalSen: number|null): FollowAction`; `parseCheckoutState(data: unknown): CheckoutState`; constants `PAID_ELSEWHERE`, `VOIDED_ELSEWHERE`, `BILL_CHANGED`, `mergedElsewhere(billNo)`.
  - `paySession.ts`: `type PayPhase = 'editing'|'paying'|'unsure'|'checking'`; `interface PaySession { phase; checkoutId: string; earlierIds: string[] }`; `type PayEvent = {type:'send'}|{type:'refused'}|{type:'noReply'}|{type:'check'}|{type:'checkedOpen'; newCheckoutId: string}|{type:'checkEnded'}`; `newPaySession(id)`, `nextPay(s, e)`, `linesLocked(s)`, `checkoutIds(s): string[]` (every id the sheet has used, oldest first); constants `UNSURE`, `CHECKED_OPEN`.
  - `checkoutApi.ts`: `fetchCheckoutState(billId: string, checkoutIds: string[]): Promise<CheckoutState>`.
  - `rpcResult.ts`: `looksOffline(message: string): boolean` — the one "no reply" classifier (the checkout sheet, `shift.ts` and `CloseShiftSheet.tsx` use it).

- [ ] **Step 1: Write the failing tests.** Create `src/features/pos/checkout/follow.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { BillTotals } from './bill'
import { BILL_CHANGED, PAID_ELSEWHERE, VOIDED_ELSEWHERE, followBill, parseCheckoutState, type CheckoutState } from './follow'

const totals = (totalSen: number): BillTotals => ({
  subtotalSen: totalSen, serviceChargeSen: 0, sstSen: 0, takeawayFeeSen: 0, beforeRoundingSen: totalSen,
  roundingSen: 0, totalSen, sstGroups: [], serviceChargeGroups: [],
})
const result = { billId: 'b-1', billNo: '261025-001', totalSen: 7600, changeSen: 400, receiptQueued: true }
const state = (s: Partial<CheckoutState>): CheckoutState => ({
  status: 'open', billNo: '261025-001', mergedIntoBillNo: null, totals: null, result: null, ...s,
})

describe('followBill — the checkout sheet follows its bill', () => {
  it('shows the result when this sheet paid the bill (its reply was lost or came later)', () => {
    expect(followBill(state({ status: 'paid', result }), 7600)).toEqual({ kind: 'paidHere', result })
  })
  it('locks when another iPad paid, voided or merged the bill', () => {
    expect(followBill(state({ status: 'paid' }), 7600)).toEqual({ kind: 'lock', note: PAID_ELSEWHERE })
    expect(PAID_ELSEWHERE).toBe('This bill was paid on another iPad — do not charge the card terminal.')
    expect(followBill(state({ status: 'voided' }), 7600)).toEqual({ kind: 'lock', note: VOIDED_ELSEWHERE })
    expect(VOIDED_ELSEWHERE).toBe('This bill was voided on another iPad.')
    expect(followBill(state({ status: 'merged', mergedIntoBillNo: '261025-007' }), 7600))
      .toEqual({ kind: 'lock', note: 'This bill was merged into 261025-007 on another iPad.' })
  })
  it('loads the totals the first time without a note', () => {
    expect(followBill(state({ totals: totals(7600) }), null)).toEqual({ kind: 'reload', totals: totals(7600), note: null })
  })
  it('reloads with a note when the total changed on another iPad', () => {
    expect(followBill(state({ totals: totals(5000) }), 7600)).toEqual({ kind: 'reload', totals: totals(5000), note: BILL_CHANGED })
    expect(BILL_CHANGED).toBe('The bill changed on another iPad — check the total.')
  })
  it('keeps everything when the total is the same', () => {
    expect(followBill(state({ totals: totals(7600) }), 7600)).toEqual({ kind: 'keep' })
  })
})

describe('parseCheckoutState', () => {
  it('reads the server answer', () => {
    const raw = { status: 'paid', billNo: '261025-001', mergedIntoBillNo: null, totals: null, result }
    expect(parseCheckoutState(raw)).toEqual(raw)
    const open = { status: 'open', billNo: '261025-002', mergedIntoBillNo: null, totals: totals(550), result: null }
    expect(parseCheckoutState(open)).toEqual(open)
  })
  it('refuses anything else', () => {
    for (const bad of [null, [], { status: 'gone', billNo: 'x', mergedIntoBillNo: null, totals: null, result: null },
      { status: 'open', billNo: 'x', totals: null, result: null },
      { status: 'paid', billNo: 'x', mergedIntoBillNo: null, totals: null, result: { billId: 'b' } }]) {
      expect(() => parseCheckoutState(bad)).toThrow('Unexpected reply from the server')
    }
  })
})
```

Create `src/features/pos/checkout/paySession.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CHECKED_OPEN, UNSURE, checkoutIds, linesLocked, newPaySession, nextPay, type PayEvent, type PaySession } from './paySession'

const run = (s: PaySession, ...events: PayEvent[]) => events.reduce(nextPay, s)
const start = newPaySession('id-1')

describe('nextPay — payment attempts of one checkout', () => {
  it('a refusal goes back to editing with the same id', () => {
    expect(run(start, { type: 'send' }, { type: 'refused' })).toEqual({ phase: 'editing', checkoutId: 'id-1', earlierIds: [] })
  })
  it('no reply locks the lines; Try again sends the same id', () => {
    const unsure = run(start, { type: 'send' }, { type: 'noReply' })
    expect(unsure).toEqual({ phase: 'unsure', checkoutId: 'id-1', earlierIds: [] })
    expect(linesLocked(unsure)).toBe(true)
    expect(run(unsure, { type: 'send' })).toEqual({ phase: 'paying', checkoutId: 'id-1', earlierIds: [] })
  })
  it('Check bill finding the bill open unlocks the lines with a new id', () => {
    const open = run(start, { type: 'send' }, { type: 'noReply' }, { type: 'check' }, { type: 'checkedOpen', newCheckoutId: 'id-2' })
    expect(open).toEqual({ phase: 'editing', checkoutId: 'id-2', earlierIds: ['id-1'] })
    expect(linesLocked(open)).toBe(false)
  })
  it('Check bill that does not find the bill open stays unsure, same id', () => {
    expect(run(start, { type: 'send' }, { type: 'noReply' }, { type: 'check' }, { type: 'checkEnded' }))
      .toEqual({ phase: 'unsure', checkoutId: 'id-1', earlierIds: [] })
  })
  it('keeps every id it used, so a late first payment still shows as paid by this sheet', () => {
    const twice = run(start,
      { type: 'send' }, { type: 'noReply' }, { type: 'check' }, { type: 'checkedOpen', newCheckoutId: 'id-2' },
      { type: 'send' }, { type: 'noReply' }, { type: 'check' }, { type: 'checkedOpen', newCheckoutId: 'id-3' })
    expect(checkoutIds(twice)).toEqual(['id-1', 'id-2', 'id-3'])
    expect(checkoutIds(start)).toEqual(['id-1'])
  })
  it('ignores events that do not fit (a double tap, a late reply)', () => {
    const paying = run(start, { type: 'send' })
    expect(run(paying, { type: 'send' })).toBe(paying)
    expect(run(start, { type: 'check' })).toBe(start)
    expect(run(start, { type: 'checkedOpen', newCheckoutId: 'id-9' })).toBe(start)
    expect(run(start, { type: 'noReply' })).toBe(start)
    expect(linesLocked(paying)).toBe(true)
    expect(linesLocked(start)).toBe(false)
  })
  it('says what happened in the words of the design', () => {
    expect(UNSURE.startsWith('Not sure the payment went through')).toBe(true)
    expect(CHECKED_OPEN).toBe('The bill is still open — the payment was not recorded. Check the lines and press Pay.')
  })
})
```

"No reply" is one shared classifier for every POS sheet. In `src/features/pos/checkout/rpcResult.test.ts` make exactly these replacements (each old text occurs once, in this order):

1. Replace:

```ts
import { parseCheckoutResult, parseRefundResult, unwrapAction } from './rpcResult'
```

   with:

```ts
import { looksOffline, parseCheckoutResult, parseRefundResult, unwrapAction } from './rpcResult'
```

2. Replace:

```ts
  it('refuses a reply without the recorded amount', () => {
    expect(() => parseRefundResult({ ok: true, refundedSen: 1300, slipQueued: true })).toThrow('Unexpected reply')
  })
})
```

   with:

```ts
  it('refuses a reply without the recorded amount', () => {
    expect(() => parseRefundResult({ ok: true, refundedSen: 1300, slipQueued: true })).toThrow('Unexpected reply')
  })
})

describe('looksOffline — a request with no reply, in every browser', () => {
  it('takes a dropped connection or a timeout for no reply (Safari, on every iPad, says "Load failed")', () => {
    for (const m of ['TypeError: Load failed', 'TypeError: Failed to fetch', 'NetworkError when attempting to fetch resource.',
      'TimeoutError: signal timed out', 'AbortError: The operation was aborted.']) {
      expect(looksOffline(m), m).toBe(true)
    }
  })
  it('never takes a refusal of the server for no reply', () => {
    for (const m of ['This bill is already paid', 'Payments (RM 1.00) do not match the total (RM 2.00)',
      "This payment was already recorded with other amounts — check Today's bills", 'Wrong PIN — 4 tries left']) {
      expect(looksOffline(m), m).toBe(false)
    }
  })
})
```

In `src/features/pos/shift/shift.test.ts` make exactly this replacement (the old text occurs once):

1. Replace:

```ts
    expect(moveRefusal('TypeError: Failed to fetch')).toBe('unsure')
```

   with:

```ts
    expect(moveRefusal('TypeError: Failed to fetch')).toBe('unsure')
    expect(moveRefusal('TypeError: Load failed')).toBe('unsure')     // Safari, on every iPad
```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run src/features/pos/checkout/follow.test.ts src/features/pos/checkout/paySession.test.ts src/features/pos/checkout/rpcResult.test.ts src/features/pos/shift/shift.test.ts` — Expected: FAIL — `Failed to load url ./follow` and `Failed to load url ./paySession`; in `rpcResult.test.ts` the two `looksOffline` tests fail (`looksOffline is not a function`); in `shift.test.ts` the `moveRefusal` test fails (`expected 'nothing' to be 'unsure'`: the old pattern misses "Load failed").

- [ ] **Step 3: Write the rules.** Create `src/features/pos/checkout/follow.ts`:

```ts
/** The checkout sheet follows its bill (pre-pilot hardening §1): what the sheet does with
 *  pos_checkout_state, re-read on every bills event and every 15 s sweep. Pure. */
import type { BillTotals } from './bill'
import { parseCheckoutResult, type CheckoutResult } from './rpcResult'

export type BillStatus = 'open' | 'paid' | 'voided' | 'merged'

/** pos_checkout_state's answer. */
export interface CheckoutState {
  status: BillStatus
  billNo: string
  mergedIntoBillNo: string | null
  totals: BillTotals | null       // open bills only
  result: CheckoutResult | null   // when one of THIS sheet's checkout ids paid the bill
}

export type FollowAction =
  | { kind: 'keep' }
  | { kind: 'paidHere'; result: CheckoutResult }
  | { kind: 'lock'; note: string }
  | { kind: 'reload'; totals: BillTotals; note: string | null }

export const PAID_ELSEWHERE = 'This bill was paid on another iPad — do not charge the card terminal.'
export const VOIDED_ELSEWHERE = 'This bill was voided on another iPad.'
export const mergedElsewhere = (billNo: string | null) => `This bill was merged into ${billNo ?? 'another bill'} on another iPad.`
export const BILL_CHANGED = 'The bill changed on another iPad — check the total.'

/** shownTotalSen: the total on screen now (null before the first load). */
export function followBill(state: CheckoutState, shownTotalSen: number | null): FollowAction {
  switch (state.status) {
    case 'paid':
      return state.result ? { kind: 'paidHere', result: state.result } : { kind: 'lock', note: PAID_ELSEWHERE }
    case 'voided':
      return { kind: 'lock', note: VOIDED_ELSEWHERE }
    case 'merged':
      return { kind: 'lock', note: mergedElsewhere(state.mergedIntoBillNo) }
    case 'open':
      if (!state.totals) return { kind: 'keep' }
      if (shownTotalSen === null) return { kind: 'reload', totals: state.totals, note: null }
      if (state.totals.totalSen !== shownTotalSen) return { kind: 'reload', totals: state.totals, note: BILL_CHANGED }
      return { kind: 'keep' }
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const STATUSES: readonly string[] = ['open', 'paid', 'voided', 'merged']

/** Throws "Unexpected reply from the server" for anything that is not pos_checkout_state's shape. */
export function parseCheckoutState(data: unknown): CheckoutState {
  if (!isObj(data) || typeof data.status !== 'string' || !STATUSES.includes(data.status) || typeof data.billNo !== 'string'
      || (data.mergedIntoBillNo !== null && typeof data.mergedIntoBillNo !== 'string')
      || (data.totals !== null && !(isObj(data.totals) && typeof data.totals.totalSen === 'number'))) {
    throw new Error('Unexpected reply from the server')
  }
  return {
    status: data.status as BillStatus,
    billNo: data.billNo,
    mergedIntoBillNo: data.mergedIntoBillNo as string | null,
    totals: data.totals as BillTotals | null,
    result: data.result === null ? null : parseCheckoutResult(data.result),
  }
}
```

Create `src/features/pos/checkout/paySession.ts`:

```ts
/** One checkout's payment attempts (pre-pilot hardening §2). Pure.
 *  editing  — lines editable; Pay sends them with checkoutId
 *  paying   — a Pay or Try again is on its way
 *  unsure   — no reply: lines locked; Try again (same lines, same id) or Check bill
 *  checking — Check bill is re-reading the bill
 *  An unsure send may still land on the server, so its id is kept until Check bill finds
 *  the bill open; only then are the lines unlocked with a NEW id — and the old one moves to
 *  earlierIds, because that first attempt can still commit later: the bill is re-read with
 *  every id (checkoutIds), so the sheet shows its own paid result, never "paid on another
 *  iPad". A refusal recorded nothing under the id, so editing goes on with the same one (a
 *  late first attempt that lands meanwhile makes the server refuse other lines under it). */
export type PayPhase = 'editing' | 'paying' | 'unsure' | 'checking'

export interface PaySession {
  phase: PayPhase
  checkoutId: string
  earlierIds: string[]   // ids Check bill replaced, oldest first
}

export type PayEvent =
  | { type: 'send' }                               // Pay (editing) or Try again (unsure)
  | { type: 'refused' }                            // the server answered no
  | { type: 'noReply' }                            // timeout or dropped connection
  | { type: 'check' }                              // Check bill
  | { type: 'checkedOpen'; newCheckoutId: string } // the bill is still open: unlock with a new id
  | { type: 'checkEnded' }                         // Check bill did not find it open (no answer, paid or closed)

export const newPaySession = (checkoutId: string): PaySession => ({ phase: 'editing', checkoutId, earlierIds: [] })

/** An event that does not fit the phase changes nothing (a double tap, a late reply). */
export function nextPay(s: PaySession, e: PayEvent): PaySession {
  switch (e.type) {
    case 'send':
      return s.phase === 'editing' || s.phase === 'unsure' ? { ...s, phase: 'paying' } : s
    case 'refused':
      return s.phase === 'paying' ? { ...s, phase: 'editing' } : s
    case 'noReply':
      return s.phase === 'paying' ? { ...s, phase: 'unsure' } : s
    case 'check':
      return s.phase === 'unsure' ? { ...s, phase: 'checking' } : s
    case 'checkedOpen':
      return s.phase === 'checking' ? { phase: 'editing', checkoutId: e.newCheckoutId, earlierIds: [...s.earlierIds, s.checkoutId] } : s
    case 'checkEnded':
      return s.phase === 'checking' ? { ...s, phase: 'unsure' } : s
  }
}

/** Method buttons, amounts and remove buttons are locked in every phase but editing. */
export const linesLocked = (s: PaySession): boolean => s.phase !== 'editing'

/** Every checkout id this sheet has used, oldest first: pos_checkout_state shows the paid
 *  result when any of them paid the bill. */
export const checkoutIds = (s: PaySession): string[] => [...s.earlierIds, s.checkoutId]

export const UNSURE = 'Not sure the payment went through (no reply). Press Try again — it will not be charged twice — or Check bill.'
export const CHECKED_OPEN = 'The bill is still open — the payment was not recorded. Check the lines and press Pay.'
```

The one "no reply" classifier. In `src/features/pos/checkout/rpcResult.ts` make exactly this replacement (the old text occurs once):

1. Replace:

```ts
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
```

   with:

```ts
/** A request that got no reply, as postgrest-js reports the browser's network failure
 *  ("${name}: ${message}"): Chrome "TypeError: Failed to fetch", Firefox "TypeError: NetworkError
 *  when attempting to fetch resource.", Safari — every iPad — "TypeError: Load failed", or a
 *  timeout / abort. The request may still have landed, so the sheet keeps its id and a resend is
 *  safe. The one classifier of the POS sheets (checkout, close shift, pay in / pay out); every
 *  refusal of the server has other words. */
export const looksOffline = (m: string) => /load failed|fetch|network|timeout|abort|signal/i.test(m)

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
```

The shift sheets drop their copy. In `src/features/pos/shift/shift.ts` make exactly these replacements (each old text occurs once, in this order):

1. Replace:

```ts
import { parseRinggit } from '../checkout/tender'
```

   with:

```ts
import { looksOffline } from '../checkout/rpcResult'   // the one "no reply" classifier (knows Safari's "Load failed")
import { parseRinggit } from '../checkout/tender'
```

2. Replace:

```ts
/** What happened after a request with no reply: the id makes a resend safe. */
export const looksOffline = (m: string) => /fetch|network|timeout|abort|signal/i.test(m)

/** After a refused pay in / pay out, what is recorded under its id: 'unsure' (no reply — keep the
```

   with:

```ts
/** After a refused pay in / pay out, what is recorded under its id: 'unsure' (no reply — keep the
```

In `src/features/pos/shift/CloseShiftSheet.tsx` make exactly this replacement (the old text occurs once):

1. Replace:

```tsx
import { closeShift } from './shiftApi'
import ZReportView from './ZReportView'
import {
  approvalNote, closeShiftError, countProblem, looksOffline, openBillsWarning, printedNote, varianceLabel,
```

   with:

```tsx
import { looksOffline } from '../checkout/rpcResult'
import { closeShift } from './shiftApi'
import ZReportView from './ZReportView'
import {
  approvalNote, closeShiftError, countProblem, openBillsWarning, printedNote, varianceLabel,
```

Run: `grep -rl "fetch|network" src | sort` — Expected: `src/features/pos/checkout/CheckoutSheet.tsx` and `src/features/pos/checkout/rpcResult.ts` (the sheet's own copy goes when Task 5 rewrites it).

- [ ] **Step 4: The RPC wrapper.** In `src/features/pos/checkout/checkoutApi.ts` make exactly these replacements (each old text occurs once, in this order):

1. Replace:

```ts
import { parseCheckoutResult, parseRefundResult, unwrapAction, type CheckoutResult, type RefundResult } from './rpcResult'
```

   with:

```ts
import { parseCheckoutResult, parseRefundResult, unwrapAction, type CheckoutResult, type RefundResult } from './rpcResult'
import { parseCheckoutState, type CheckoutState } from './follow'
```

2. Replace:

```ts
/** A timeout or dropped connection throws — the sheet then offers Pay again with the
```

   with:

```ts
/** The bill as the checkout sheet follows it (pos_checkout_state): its status, the totals
 *  while it is open, and the checkout result when one of checkoutIds (every id the sheet
 *  has used — paySession's checkoutIds) paid it. */
export async function fetchCheckoutState(billId: string, checkoutIds: string[]): Promise<CheckoutState> {
  const { data, error } = await supabase.rpc('pos_checkout_state', { p_bill_id: billId, p_checkout_ids: checkoutIds })
  if (error) fail(error)
  return parseCheckoutState(data)
}

/** A timeout or dropped connection throws — the sheet then offers Pay again with the
```

- [ ] **Step 5: Run the tests and the gates.** Run: `npx vitest run src/features/pos/checkout/follow.test.ts src/features/pos/checkout/paySession.test.ts src/features/pos/checkout/rpcResult.test.ts src/features/pos/shift/shift.test.ts` — Expected: PASS, 4 files, 40 tests. Run: `npx vitest run` — Expected: 102 files, 897 tests pass. Run: `npx tsc -b` — Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/features/pos/checkout/follow.ts src/features/pos/checkout/follow.test.ts src/features/pos/checkout/paySession.ts src/features/pos/checkout/paySession.test.ts src/features/pos/checkout/checkoutApi.ts src/features/pos/checkout/rpcResult.ts src/features/pos/checkout/rpcResult.test.ts src/features/pos/shift/shift.ts src/features/pos/shift/shift.test.ts src/features/pos/shift/CloseShiftSheet.tsx
git commit -m "feat(pos-checkout): rules for a checkout that follows its bill and locks after an unsure reply; one no-reply classifier that knows Safari's Load failed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The checkout sheet follows its bill and locks after an unsure reply

**Model tier:** cheap (complete files); the controller runs Step 6.

**Files:**
- Create: `src/features/pos/checkout/CheckoutTotals.tsx`
- Rewrite: `src/features/pos/checkout/CheckoutSheet.tsx`
- Modify: `src/features/pos/order/PosPage.tsx`

**Interfaces:**
- Consumes: Task 4's `followBill`, `FollowAction`, `nextPay`, `newPaySession`, `linesLocked`, `checkoutIds`, `UNSURE`, `CHECKED_OPEN`, `fetchCheckoutState`, `looksOffline`; `PosPage`'s `refreshKey` (bumped by every bills event, order and sweep).
- Produces: `CheckoutSheet` props `{ branchId, bill, title, refreshKey: number, onClose, onPaid }`.

- [ ] **Step 1: Split the totals panel out.** Create `src/features/pos/checkout/CheckoutTotals.tsx`:

```tsx
import { formatSen } from '../order/cart'
import { formatRate, type BillTotals } from './bill'

/** The server's totals of the bill being paid (pos_checkout_state), as the checkout sheet shows them. */
export default function CheckoutTotals({ totals }: { totals: BillTotals | null }) {
  if (!totals) return <p className="text-brown-muted">Loading totals…</p>
  return (
    <div className="space-y-1">
      <div className="flex justify-between"><span>Subtotal</span><span>{formatSen(totals.subtotalSen)}</span></div>
      {totals.serviceChargeGroups.map((g) => (
        <div key={`sc${g.rateBp}`} className="flex justify-between"><span>Service charge ({formatRate(g.rateBp)})</span><span>{formatSen(g.amountSen)}</span></div>
      ))}
      {totals.sstGroups.map((g) => (
        <div key={`sst${g.rateBp}`} className="flex justify-between"><span>SST ({formatRate(g.rateBp)})</span><span>{formatSen(g.amountSen)}</span></div>
      ))}
      {totals.takeawayFeeSen > 0 && <div className="flex justify-between"><span>Takeaway packaging</span><span>{formatSen(totals.takeawayFeeSen)}</span></div>}
      <div className="flex justify-between"><span>Rounding</span><span>{formatSen(totals.roundingSen)}</span></div>
      <div className="flex justify-between border-t border-border pt-2 text-lg font-semibold"><span>Total</span><span>{formatSen(totals.totalSen)}</span></div>
    </div>
  )
}
```

- [ ] **Step 2: Rewrite the sheet.** Replace the whole content of `src/features/pos/checkout/CheckoutSheet.tsx` with:

```tsx
import { useEffect, useRef, useState } from 'react'
import { formatSen } from '../order/cart'
import type { OpenBillRow } from '../order/posApi'
import type { BillTotals } from './bill'
import { checkoutBill, fetchCheckoutState, fetchPaymentMethods, type CheckoutResult } from './checkoutApi'
import CheckoutTotals from './CheckoutTotals'
import { followBill, type FollowAction } from './follow'
import { CHECKED_OPEN, UNSURE, checkoutIds, linesLocked, newPaySession, nextPay, type PayEvent, type PaySession } from './paySession'
import { looksOffline } from './rpcResult'
import {
  changeSen, lineProblem, parseRinggit, payProblem, quickTenders, remainingSen, toPayments,
  type TenderLine, type TenderMethod,
} from './tender'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export default function CheckoutSheet({ branchId, bill, title, refreshKey, onClose, onPaid }: {
  branchId: string
  bill: OpenBillRow
  title: string                 // "Table T3" or "Takeaway 261024-004"
  refreshKey: number            // bumped on every bills event, order and 15 s sweep: re-read the bill
  onClose: () => void
  onPaid: () => void            // after the cashier closes the success screen
}) {
  const [totals, setTotals] = useState<BillTotals | null>(null)
  const [methods, setMethods] = useState<TenderMethod[]>([])
  const [lines, setLines] = useState<TenderLine[]>([])
  const [method, setMethod] = useState<TenderMethod | null>(null)
  const [amountText, setAmountText] = useState('')
  const [tenderedText, setTenderedText] = useState('')
  const [reference, setReference] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [changeNote, setChangeNote] = useState<string | null>(null)   // the bill changed on another iPad
  const [lockNote, setLockNote] = useState<string | null>(null)       // paid, voided or merged on another iPad
  const [result, setResult] = useState<CheckoutResult | null>(null)
  // one id per payment attempt: Pay again after a lost reply can never charge twice (paySession.ts)
  const [session, setSession] = useState<PaySession>(() => newPaySession(crypto.randomUUID()))
  const sessionRef = useRef(session)
  const totalsRef = useRef<BillTotals | null>(null)
  const loadFailed = useRef(false)       // the first read failed: its error shows until a read succeeds
  const readSeq = useRef(0)
  const keySeq = useRef(0)

  // the ref moves at once, so a second tap in the same render sees the new phase
  const step = (e: PayEvent): PaySession => {
    const s = nextPay(sessionRef.current, e)
    sessionRef.current = s
    setSession(s)
    return s
  }
  const apply = (a: FollowAction) => {
    if (a.kind === 'paidHere') setResult(a.result)
    else if (a.kind === 'lock') { setLockNote(a.note); setMethod(null) }
    else if (a.kind === 'reload') {
      totalsRef.current = a.totals
      setTotals(a.totals)
      if (a.note) setChangeNote(a.note)
    }
  }
  // Re-read the bill with every id this sheet used (its own late payment is never "elsewhere");
  // a reply older than the latest read is dropped. A failed read changes nothing — the next
  // event or sweep tries again (a failed first load shows its error until a read succeeds).
  const follow = async () => {
    const seq = ++readSeq.current
    try {
      const state = await fetchCheckoutState(bill.id, checkoutIds(sessionRef.current))
      if (seq !== readSeq.current) return
      apply(followBill(state, totalsRef.current?.totalSen ?? null))
      if (loadFailed.current) { loadFailed.current = false; setError(null) }
    } catch (e) {
      if (seq === readSeq.current && !totalsRef.current) { loadFailed.current = true; setError(msg(e)) }
    }
  }

  useEffect(() => {
    fetchPaymentMethods(branchId, true)
      .then((rows) => setMethods(rows.map((m) => ({ id: m.id, name: m.name, kind: m.kind, needsReference: m.needs_reference }))))
      .catch((e) => setError(msg(e)))
  }, [branchId])
  // the first load, then every bills event, order and sweep — never while a Pay or Check bill is out
  useEffect(() => {
    const phase = sessionRef.current.phase
    if (!result && !lockNote && phase !== 'paying' && phase !== 'checking') void follow()
  }, [bill.id, refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const total = totals?.totalSen ?? 0
  const left = remainingSen(total, lines)
  const locked = linesLocked(session) || lockNote !== null
  const busy = session.phase === 'paying' || session.phase === 'checking'

  const pick = (m: TenderMethod) => {
    setMethod(m); setError(null); setTenderedText(''); setReference('')
    setAmountText((Math.max(0, left) / 100).toFixed(2))
  }

  const add = (tenderedOverride?: number | null) => {
    if (!method || locked) return
    const amountSen = parseRinggit(amountText)
    if (amountSen === null) { setError('Enter the amount'); return }
    let tenderedSen: number | null = null
    if (method.kind === 'cash') {
      if (tenderedOverride !== undefined) tenderedSen = tenderedOverride
      else if (tenderedText.trim()) {
        tenderedSen = parseRinggit(tenderedText)
        if (tenderedSen === null) { setError('Enter the cash received'); return }
      }
    }
    const line = { method, amountSen, tenderedSen, reference: reference.trim() || null }
    const problem = lineProblem(line, left)
    if (problem) { setError(problem); return }
    setLines((ls) => [...ls, { ...line, key: String(++keySeq.current) }])
    setMethod(null); setAmountText(''); setTenderedText(''); setReference(''); setError(null)
  }

  // Pay (editing) and Try again (unsure): the same lines under the session's id
  const pay = async () => {
    const s = sessionRef.current
    if (!totals || lockNote || (s.phase !== 'editing' && s.phase !== 'unsure')) return
    if (s.phase === 'editing') {
      const problem = payProblem(total, lines)
      if (problem) { setError(problem); return }
    }
    step({ type: 'send' }); setError(null); setChangeNote(null)
    try {
      setResult(await checkoutBill(bill.id, toPayments(lines), s.checkoutId))
    } catch (e) {
      const m = msg(e)
      if (looksOffline(m)) { step({ type: 'noReply' }); setMethod(null); setError(UNSURE) }
      else { step({ type: 'refused' }); setError(m); void follow() }   // e.g. a QR order arrived meanwhile and the total changed
    }
  }

  // Check bill: paid by this sheet → its result; open → unlock with a new id; else lock
  const checkBill = async () => {
    if (sessionRef.current.phase !== 'unsure') return
    step({ type: 'check' }); setError(null)
    ++readSeq.current                                   // a re-read still on its way is dropped
    try {
      const a = followBill(await fetchCheckoutState(bill.id, checkoutIds(sessionRef.current)), totalsRef.current?.totalSen ?? null)
      apply(a)
      if (a.kind === 'keep' || a.kind === 'reload') { step({ type: 'checkedOpen', newCheckoutId: crypto.randomUUID() }); setError(CHECKED_OPEN) }
      else step({ type: 'checkEnded' })                 // paid here (the result shows) or closed elsewhere (the lock shows)
    } catch (e) {
      step({ type: 'checkEnded' }); setError(`Could not check the bill: ${msg(e)}`)
    }
  }

  if (result) {
    return (
      <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40">
        <div className="w-full max-w-md rounded-2xl bg-card p-6 text-center">
          <div className="text-sm text-brown-muted">Bill {result.billNo} paid · {formatSen(result.totalSen)}</div>
          <div className="mt-4 text-sm">Change</div>
          <div className="text-5xl font-semibold">{formatSen(result.changeSen)}</div>
          <p className="mt-4 text-sm text-brown-muted">
            {result.receiptQueued ? 'Receipt printing…' : 'No receipt printer is set — choose one in POS settings.'}
          </p>
          <button onClick={onPaid} className="mt-6 w-full rounded-xl bg-brown-btn py-3 text-white hover:bg-brown-btn-hover">Done</button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-30 grid grid-cols-[1fr_400px] bg-cream">
      <div className="flex flex-col overflow-hidden p-4">
        <div className="mb-3 flex items-center gap-3">
          <button onClick={onClose} disabled={busy} className="rounded-lg border border-border px-3 py-2">{lockNote ? 'Close' : '← Back'}</button>
          <div className="text-lg font-semibold">Checkout · {title} · Bill {bill.bill_no}</div>
        </div>
        {lockNote && <p role="alert" className="mb-3 rounded bg-red-50 p-3 font-semibold text-red-700">{lockNote}</p>}
        <div className="text-xs font-semibold uppercase text-brown-muted">Payment method</div>
        <div className="mt-1 grid grid-cols-3 gap-2">
          {methods.map((m) => (
            <button key={m.id} onClick={() => pick(m)} disabled={left <= 0 || busy || locked}
              className={`min-h-16 rounded-xl border p-3 text-left disabled:opacity-40 ${method?.id === m.id ? 'border-brown-btn bg-brown-btn text-white' : 'border-border bg-card'}`}>
              <div className="font-medium">{m.name}</div>
              <div className="text-xs opacity-75">{m.kind}</div>
            </button>
          ))}
          {methods.length === 0 && <p className="text-sm text-brown-muted">No payment methods — add them in POS settings.</p>}
        </div>
        {method && !locked && (
          <div className="mt-4 space-y-3 rounded-xl border border-border bg-card p-4">
            <label className="block text-sm">Amount (RM)
              <input inputMode="decimal" className="ml-2 w-32 rounded border border-border p-2" value={amountText} onChange={(e) => setAmountText(e.target.value)} />
            </label>
            {method.kind === 'cash' && (
              <>
                <label className="block text-sm">Cash received (RM)
                  <input inputMode="decimal" className="ml-2 w-32 rounded border border-border p-2" placeholder="exact" value={tenderedText} onChange={(e) => setTenderedText(e.target.value)} />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => add(null)} className="rounded-lg border border-border px-4 py-3">Exact</button>
                  {quickTenders(parseRinggit(amountText) ?? left).map((n) => (
                    <button key={n} onClick={() => add(n)} className="rounded-lg border border-border px-4 py-3">RM {n / 100}</button>
                  ))}
                </div>
              </>
            )}
            {method.needsReference && (
              <label className="block text-sm">Reference
                <input className="ml-2 w-48 rounded border border-border p-2" value={reference} onChange={(e) => setReference(e.target.value)} />
              </label>
            )}
            <button onClick={() => add()} className="rounded-lg bg-brown-btn px-4 py-2 text-white">Add {method.name}</button>
          </div>
        )}
        {error && <p role="alert" className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      </div>

      <div className="flex flex-col border-l border-border bg-card p-4 text-sm">
        <CheckoutTotals totals={totals} />
        {changeNote && <p role="status" className="mt-2 rounded bg-amber-50 p-2 text-amber-800">{changeNote}</p>}
        <div className="mt-4 flex-1 space-y-1 overflow-y-auto">
          {lines.map((l) => (
            <div key={l.key} className="flex items-center justify-between rounded bg-cream p-2">
              <span>{l.method.name}{l.reference ? ` · ${l.reference}` : ''}{l.tenderedSen !== null ? ` · received ${formatSen(l.tenderedSen)}` : ''}</span>
              <span className="flex items-center gap-2">{formatSen(l.amountSen)}
                <button disabled={locked} className="text-xs text-red-700 underline disabled:opacity-40" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>remove</button>
              </span>
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-between"><span>Left to pay</span><b>{formatSen(Math.max(0, left))}</b></div>
        <div className="flex justify-between"><span>Change</span><b>{formatSen(changeSen(lines))}</b></div>
        {lockNote ? (
          <button onClick={onClose} className="mt-3 w-full rounded-xl bg-brown-btn py-4 text-lg text-white hover:bg-brown-btn-hover">Close</button>
        ) : session.phase === 'unsure' || session.phase === 'checking' ? (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button disabled={busy} onClick={() => void pay()} className="rounded-xl bg-brown-btn py-4 text-lg text-white disabled:opacity-40">Try again</button>
            <button disabled={busy} onClick={() => void checkBill()} className="rounded-xl border border-border py-4 text-lg disabled:opacity-40">
              {session.phase === 'checking' ? 'Checking…' : 'Check bill'}
            </button>
          </div>
        ) : (
          <button disabled={busy || !totals || left !== 0} onClick={() => void pay()}
            className="mt-3 w-full rounded-xl bg-brown-btn py-4 text-lg text-white hover:bg-brown-btn-hover disabled:opacity-40">
            {busy ? 'Paying…' : `Pay ${formatSen(total)}`}
          </button>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Pass the refresh key.** In `src/features/pos/order/PosPage.tsx` make exactly this replacement (the old text occurs once):

1. Replace:

```tsx
        <CheckoutSheet branchId={branchId} bill={checkout}
```

   with:

```tsx
        <CheckoutSheet branchId={branchId} bill={checkout} refreshKey={refreshKey}
```

- [ ] **Step 4: Gates.** Run: `npx vitest run` — Expected: 102 files, 897 tests pass. Run: `npx tsc -b` — Expected: no output. Run: `wc -l src/features/pos/checkout/CheckoutSheet.tsx src/features/pos/checkout/CheckoutTotals.tsx` — Expected: `245` and `21`. Run: `grep -rl "fetch|network" src` — Expected: `src/features/pos/checkout/rpcResult.ts` only (one "no reply" pattern).

- [ ] **Step 5: Commit**

```bash
git add src/features/pos/checkout/CheckoutSheet.tsx src/features/pos/checkout/CheckoutTotals.tsx src/features/pos/order/PosPage.tsx
git commit -m "feat(pos-checkout): the checkout sheet follows its bill — locks when paid, voided or merged elsewhere, reloads a changed total, locks the lines after an unsure reply (Try again / Check bill)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6 (controller, craft-os-dev — browser on the dev server, launch entry `craft-os-dev`, two tabs A and B signed in as the dev test login with the Demo branch and a POS PIN; a shift open; the implementer does not touch the database):**
  1. A and B on `/pos`. B: table T1 → order one item → Send. A: T1 → **Checkout** (leave it open). B: T1 → Checkout → Cash → Pay. A within 2 s: red "This bill was paid on another iPad — do not charge the card terminal.", method buttons and **remove** disabled, only **Close** (header and right panel). Close.
  2. B: T2 → two items → Send. A: open T2's bill panel. B: void one item (approver + PIN). A's panel drops it within 2 s (no 15 s wait).
  3. A: T2 → Checkout (open). B: add an item to T2. A: totals reload with "The bill changed on another iPad — check the total."; a line already entered stays and **Pay** stays disabled until the lines match.
  4. B: Void bill T2 while A's checkout is open → A: "This bill was voided on another iPad.". A takeaway merged into T3 while A's checkout of the takeaway is open → "This bill was merged into <T3's bill no> on another iPad.".
  5. A: Takeaway → an item with a packaging fee → Send; T3 → Merge → the takeaway: T3's panel and checkout show "Takeaway packaging", and before rounding the merged bill equals the two bills apart, except up to 1 sen per service-charge or SST rate the two bills share (each rate is rounded on the whole bill).
  6. Unsure reply: A: a bill → Checkout → add a line → DevTools → Network → **Offline** → Pay → "Not sure the payment went through (no reply). Press Try again — it will not be charged twice — or Check bill.", method buttons, amounts and remove disabled, Try again / Check bill / Back shown. **No throttling** → Check bill → "The bill is still open — the payment was not recorded. Check the lines and press Pay." and the lines unlock → Pay → paid. Once more on another bill: Offline → Pay → No throttling → **Try again** → paid (the same checkout id: the lines never unlocked). Chrome reports the dropped request as "Failed to fetch"; Safari — every pilot iPad — as "Load failed", so the on-site run repeats this check once on an iPad (Safari, Wi-Fi off): run sheet step 15. If the iPad shows "TypeError: Load failed" instead of "Not sure the payment went through…", the lock does not work on Safari — stop and report.
  7. SQL (read-only): `select status, checkout_id is not null from bills where id = '<the bill of 6>'` → `paid|t`; `select count(*) from payments where bill_id = '<same>'` → the number of lines entered (nothing twice).

---

### Task 6: The print agent prints one branch

**Model tier:** cheap; the controller runs Step 7.

**Files:**
- Create: `tools/print-agent/branch.ts`, `tools/print-agent/branch.test.ts`, `tools/print-agent/README.md`
- Modify: `tools/print-agent/agent.ts`, `tools/print-agent/.env.example`

**Interfaces:**
- Consumes: `claim_print_job` / `finish_print_job` / `requeue_print_job`, branch-scoped (Task 1); `print_routes.branch_id`, `print_jobs.branch_id`, `staff.branch_id`.
- Produces: `branchIdFrom(env): string` (throws when missing / not a uuid), `branchFilter(branchId): string`, `isAgentJob(job, branchId, routes): boolean`, `loginBranchProblem(staffBranchId, branchId): string | null`.

- [ ] **Step 1: Write the failing test.** Create `tools/print-agent/branch.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { branchFilter, branchIdFrom, isAgentJob, loginBranchProblem } from './branch.ts'

const DEMO = '0b6c2f3e-1d2a-4c5b-9e8f-7a6b5c4d3e2f'
const routes = new Map([['Bar', '192.168.0.8:9100'], ['Kitchen', '192.168.0.8:9100']])

describe('branchIdFrom — the agent refuses to start without its branch', () => {
  it('reads BRANCH_ID, trimmed and lower-cased', () => {
    expect(branchIdFrom({ BRANCH_ID: ` ${DEMO.toUpperCase()} ` })).toBe(DEMO)
  })
  it('throws when it is missing or not a uuid', () => {
    expect(() => branchIdFrom({})).toThrow('Missing BRANCH_ID in tools/print-agent/.env')
    expect(() => branchIdFrom({ BRANCH_ID: '  ' })).toThrow('Missing BRANCH_ID in tools/print-agent/.env')
    expect(() => branchIdFrom({ BRANCH_ID: 'Demo' })).toThrow('BRANCH_ID "Demo" is not a branch id (a uuid from branches.id)')
  })
})

describe('the branch filter', () => {
  it('filters Realtime by branch', () => {
    expect(branchFilter(DEMO)).toBe(`branch_id=eq.${DEMO}`)
  })
  it('prints only its branch jobs on its agent routes', () => {
    expect(isAgentJob({ branch_id: DEMO, route: 'Bar' }, DEMO, routes)).toBe(true)
    expect(isAgentJob({ branch_id: 'another-branch', route: 'Bar' }, DEMO, routes)).toBe(false)
    expect(isAgentJob({ route: 'Bar' }, DEMO, routes)).toBe(false)
    expect(isAgentJob({ branch_id: DEMO, route: 'Cashier' }, DEMO, routes)).toBe(false)
  })
  it('wants a login of the same branch', () => {
    expect(loginBranchProblem(DEMO.toUpperCase(), DEMO)).toBeNull()
    expect(loginBranchProblem(null, DEMO)).toMatch(/^AGENT_EMAIL has no branch/)
    expect(loginBranchProblem('another-branch', DEMO)).toMatch(/^AGENT_EMAIL is staff of another branch than BRANCH_ID/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails.** Run: `npx vitest run tools/print-agent/branch.test.ts` — Expected: FAIL, `Failed to load url ./branch.ts`.

- [ ] **Step 3: Write the rules.** Create `tools/print-agent/branch.ts`:

```ts
// The print agent prints for ONE branch (pre-pilot hardening §7): BRANCH_ID in .env, and
// every route, sweep and Realtime event filtered by it. Pure, so Vitest can check it.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** BRANCH_ID from the environment, lower-cased. Missing or not a uuid → throws (the agent refuses to start). */
export function branchIdFrom(env: Record<string, string | undefined>): string {
  const value = env.BRANCH_ID?.trim()
  if (!value) {
    throw new Error('Missing BRANCH_ID in tools/print-agent/.env — the id of the branch this agent prints for (branches.id)')
  }
  if (!UUID.test(value)) throw new Error(`BRANCH_ID "${value}" is not a branch id (a uuid from branches.id)`)
  return value.toLowerCase()
}

/** The Realtime filter for this branch's rows. */
export const branchFilter = (branchId: string): string => `branch_id=eq.${branchId}`

/** A job this agent prints: of its branch, on one of that branch's agent routes. */
export function isAgentJob(job: { branch_id?: string; route: string }, branchId: string, routes: ReadonlyMap<string, string>): boolean {
  return job.branch_id === branchId && routes.has(job.route)
}

/** The agent's login must be staff of BRANCH_ID: the print RPCs skip every other branch's job. */
export function loginBranchProblem(staffBranchId: string | null, branchId: string): string | null {
  if (staffBranchId === null) return 'AGENT_EMAIL has no branch — set it in Team, or log the agent in as staff of BRANCH_ID'
  if (staffBranchId.toLowerCase() !== branchId) {
    return 'AGENT_EMAIL is staff of another branch than BRANCH_ID — the print RPCs would skip every job; log in as staff of BRANCH_ID'
  }
  return null
}
```

- [ ] **Step 4: Filter the agent by branch.** In `tools/print-agent/agent.ts` make exactly these replacements (each old text occurs once, in this order):

1. Replace:

```ts
// Craft POS print agent — prints print_jobs for routes of kind 'agent'
// Sends raw ESC/POS bytes to the printer on TCP 9100.
```

   with:

```ts
// Craft POS print agent — prints print_jobs for routes of kind 'agent' of ONE branch (BRANCH_ID)
// Sends raw ESC/POS bytes to the printer on TCP 9100.
```

2. Replace:

```ts
import { checkPrinter, interpretStatus, PAPER_STATUS, queryStatus } from './printerStatus.ts'
```

   with:

```ts
import { checkPrinter, interpretStatus, PAPER_STATUS, queryStatus } from './printerStatus.ts'
import { branchFilter, branchIdFrom, isAgentJob, loginBranchProblem } from './branch.ts'
```

3. Replace:

```ts
  assertDevDatabase(url)
```

   with:

```ts
  assertDevDatabase(url)
  const branchId = branchIdFrom(process.env)   // refuses to start without it
```

4. Replace:

```ts
  const { error: authError } = await supabase.auth.signInWithPassword({
    email: env('AGENT_EMAIL'),
    password: env('AGENT_PASSWORD'),
  })
  if (authError) throw authError
```

   with:

```ts
  const { data: signIn, error: authError } = await supabase.auth.signInWithPassword({
    email: env('AGENT_EMAIL'),
    password: env('AGENT_PASSWORD'),
  })
  if (authError) throw authError
  // the print RPCs act only on jobs of the login's own branch: it must be BRANCH_ID
  const userId = signIn.user?.id
  if (!userId) throw new Error('Sign-in returned no user')
  const { data: me, error: meError } = await supabase.from('staff').select('branch_id').eq('id', userId).maybeSingle()
  if (meError) throw meError
  const loginProblem = loginBranchProblem((me as { branch_id: string | null } | null)?.branch_id ?? null, branchId)
  if (loginProblem) throw new Error(loginProblem)
```

5. Replace:

```ts
    .select('name, address')
    .eq('kind', 'agent')
  if (routeError) throw routeError
```

   with:

```ts
    .select('name, address')
    .eq('kind', 'agent')
    .eq('branch_id', branchId)
  if (routeError) throw routeError
```

6. Replace:

```ts
  console.log('agent routes:', Object.fromEntries(addressOf))
```

   with:

```ts
  console.log('branch:', branchId, 'agent routes:', Object.fromEntries(addressOf))
```

7. Replace:

```ts
  const handle = async (job: PrintJob & { created_at?: string; attempts?: number }): Promise<void> => {
    if (!addressOf.has(job.route)) return
```

   with:

```ts
  const handle = async (job: PrintJob & { branch_id?: string; created_at?: string; attempts?: number }): Promise<void> => {
    if (!isAgentJob(job, branchId, addressOf)) return
```

8. Replace:

```ts
        .select('id, route, payload, status, created_at, attempts')
        .eq('status', 'pending')
```

   with:

```ts
        .select('id, branch_id, route, payload, status, created_at, attempts')
        .eq('branch_id', branchId)
        .eq('status', 'pending')
```

9. Replace:

```ts
      for (const job of (data ?? []) as (PrintJob & { created_at?: string; attempts?: number })[]) await handle(job)
```

   with:

```ts
      for (const job of (data ?? []) as (PrintJob & { branch_id?: string; created_at?: string; attempts?: number })[]) await handle(job)
```

10. Replace:

```ts
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'print_jobs' }, (p) => {
      void handle(p.new as PrintJob)
```

   with:

```ts
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'print_jobs', filter: branchFilter(branchId) }, (p) => {
      void handle(p.new as PrintJob & { branch_id?: string })
```

In `tools/print-agent/.env.example` make exactly this replacement (the old text occurs once):

1. Replace:

```bash
AGENT_EMAIL=<a staff login of the shop, e.g. the dev test login>
```

   with:

```bash
# The branch this agent prints for (branches.id). The agent refuses to start without it and
# prints only this branch's jobs on this branch's 'agent' routes.
BRANCH_ID=<branches.id of the shop, e.g. the Demo branch on dev>
# Must be staff of BRANCH_ID: the print RPCs act only on jobs of the login's own branch.
AGENT_EMAIL=<a staff login of THIS branch, e.g. the dev test login for Demo>
```

Create `tools/print-agent/README.md`:

````markdown
# Craft POS print agent

Prints the kitchen tickets, receipts and Z reports of **one branch** on LAN printers
(raw ESC/POS on TCP 9100). It replaces the iPad's print host when a branch has an
always-on computer next to its printers.

## Setup

1. Copy `.env.example` to `.env` (git-ignored) and fill it in. **Dev project only.**
2. `BRANCH_ID` is the branch this agent prints for (`branches.id`). The agent refuses to
   start without it, and prints only that branch's jobs on that branch's routes of kind
   `agent`.
3. `AGENT_EMAIL` / `AGENT_PASSWORD` must be a login of **staff of that same branch**.
   The print functions (`claim_print_job`, `finish_print_job`, `requeue_print_job`) act
   only on jobs of the caller's own branch, so a login of another branch would skip every
   job — the agent checks this at start and stops with a message.
4. Run from the repo root:

   ```bash
   node --env-file=tools/print-agent/.env tools/print-agent/agent.ts
   ```

Routes are read at start: restart the agent after changing a route in POS settings.
Tickets older than `MAX_AGE_MIN` minutes are left pending (the iPad shows them as
waiting) instead of printed on start. `TICKET_COLS` is the paper width in characters
(48 on the ZyWell ZY301).
````

- [ ] **Step 5: Tests and checks.** Run: `npx vitest run tools/print-agent/` — Expected: PASS, the existing printer-status tests and `branch.test.ts` (5 tests). Run: `node --experimental-strip-types --no-warnings -e "import('./tools/print-agent/branch.ts').then((m) => console.log(typeof m.branchIdFrom))"` — Expected: `function`. Run (no `--env-file`, so no real `.env` is read; nothing reaches the network): `BRANCH_ID= SUPABASE_URL=https://egznnbjmicebbhwasloy.supabase.co SUPABASE_ANON_KEY=x node --experimental-strip-types --no-warnings tools/print-agent/agent.ts 2>&1 | head -1` — Expected: `Error: Missing BRANCH_ID in tools/print-agent/.env — the id of the branch this agent prints for (branches.id)`. Run: `npx vitest run` — Expected: 103 files, 902 tests pass. Run: `npx tsc -b` — Expected: no output (the agent is outside `tsconfig`; Vitest and the node runs above check it).

- [ ] **Step 6: Commit**

```bash
git add tools/print-agent/branch.ts tools/print-agent/branch.test.ts tools/print-agent/README.md tools/print-agent/agent.ts tools/print-agent/.env.example
git commit -m "feat(pos-print): the print agent prints one branch — BRANCH_ID required, routes, sweep and Realtime filtered by it, login checked

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7 (controller, craft-os-dev + the shop laptop; the implementer does not touch the database or `.env`):** SQL (read-only): `select id from branches where name = 'Demo'`. Add `BRANCH_ID=<that id>` to `tools/print-agent/.env` (git-ignored, the owner's file; `AGENT_EMAIL` must be Demo staff). Start the agent: `node --env-file=tools/print-agent/.env tools/print-agent/agent.ts` → `branch: <id> agent routes: { Bar: …, Kitchen: … }` and `realtime: SUBSCRIBED`. POS settings → test print on Bar → it prints. Order one item at the counter → its ticket prints. With `BRANCH_ID` removed → the agent stops with the "Missing BRANCH_ID" error; put it back.

---

### Task 7: The simulated run sheet (implementer + controller)

**Model tier:** cheap (complete files); Step 5 depends on the controller's query result in Step 4.

**Files:**
- Create: `tools/run-sheet/facts.sql`, `tools/run-sheet/facts.ts`, `tools/run-sheet/figures.ts`, `tools/run-sheet/facts.example.json`, `docs/pos/2026-10-25-simulated-run-sheet.md` (generated in Step 5)

**Interfaces:**
- Consumes: `computeBill` and its types (`src/features/pos/checkout/bill.ts`, Task 2 — a line's own `orderType`); the Demo branch's facts on craft-os-dev (Step 4, controller).
- Produces: the run sheet, and the way to regenerate it when the menu changes.

The products, prices, rules and methods must be the real ones of the Demo branch on dev, which only the controller can read. So the implementer writes the query and the generator first (checked on a fixture that was matched against a full SQL simulation of the run while planning), the controller runs the query, and the implementer generates the sheet from its result. The generator picks: **P1** and **P5** = the first two 6% SST items without a packaging fee that are on the takeaway and QR menus; **P2** = the first item with a packaging fee on the takeaway menu; **P3** = the first 0% SST item; **P4** = the first set meal whose required groups each take one choice (the first available option is used). Products with time slots are left out (the run is after hours). If a bucket is empty, the generator stops with "The Demo menu has no …" — report it to the controller (BLOCKED) instead of editing figures by hand.

- [ ] **Step 1: Write the facts query.** Create `tools/run-sheet/facts.sql`:

```sql
-- Run-sheet facts of the Demo branch (read-only; craft-os-dev only). One JSON value: save the
-- "facts" cell as a file and pass it to tools/run-sheet/figures.ts.
with br as (select id from branches where name = 'Demo'),
cat as (select bc.role, bc.catalog_id from branch_catalogs bc, br where bc.branch_id = br.id and bc.role in ('dine_in', 'takeaway', 'qr')),
sold as (select s.product_id from branch_menu_status s, br where s.branch_id = br.id and s.is_sold_out),
prod as (
  select p.id, p.name, p.sst_rate_bp, p.takeaway_fee_sen, p.print_route,
         coalesce(mc.sort_order, 0) as cat_sort, p.sort_order,
         p.name || case when v.feedme_variant_key <> '' then ' (' || v.name || ')' else '' end as name_snapshot,
         (select cvp.price_sen from catalog_variant_prices cvp join cat on cat.catalog_id = cvp.catalog_id and cat.role = 'dine_in'
           where cvp.variant_id = v.id) as dine_in_sen,
         (select cvp.price_sen from catalog_variant_prices cvp join cat on cat.catalog_id = cvp.catalog_id and cat.role = 'takeaway'
           where cvp.variant_id = v.id) as takeaway_sen,
         (select cvp.price_sen from catalog_variant_prices cvp join cat on cat.catalog_id = cvp.catalog_id and cat.role = 'qr'
           where cvp.variant_id = v.id) as qr_sen,
         (select cp.availability from catalog_products cp join cat on cat.catalog_id = cp.catalog_id and cat.role = 'takeaway'
           where cp.product_id = p.id) as takeaway_avail,
         (select cp.availability from catalog_products cp join cat on cat.catalog_id = cp.catalog_id and cat.role = 'qr'
           where cp.product_id = p.id) as qr_avail,
         exists (select 1 from product_schedules ps where ps.product_id = p.id) as has_time_slots,
         (select coalesce(jsonb_agg(jsonb_build_object(
                   'group', g.name, 'minSelect', g.min_select,
                   'option', (select jsonb_build_object('name', o.name, 'deltaSen', coalesce(
                                       (select cop.price_delta_sen from catalog_option_prices cop
                                          join cat on cat.catalog_id = cop.catalog_id and cat.role = 'dine_in'
                                         where cop.option_id = o.id), o.price_delta_sen))
                                from modifier_options o
                               where o.group_id = g.id and o.availability = 'all'
                                 and (o.product_id is null or o.product_id not in (select product_id from sold))
                               order by o.sort_order, o.name limit 1))
                 order by pmg.sort_order, g.name), '[]'::jsonb)
            from product_modifier_groups pmg join modifier_groups g on g.id = pmg.group_id and g.is_active
           where pmg.product_id = p.id and g.min_select > 0) as required
    from menu_products p
    join menu_variants v on v.id = (select v2.id from menu_variants v2 where v2.product_id = p.id and v2.is_active
                                     order by v2.sort_order, v2.name limit 1)
    left join menu_categories mc on mc.id = p.category_id
   where p.is_active and not p.is_addon and p.id not in (select product_id from sold)
     and exists (select 1 from catalog_products cp join cat on cat.catalog_id = cp.catalog_id and cat.role = 'dine_in'
                  where cp.product_id = p.id and cp.availability = 'all')
),
bucketed as (
  select b.bucket, x.*, row_number() over (partition by b.bucket order by x.cat_sort, x.sort_order, x.name) as n
    from prod x
    cross join lateral (values
      (case when x.sst_rate_bp = 600 and x.takeaway_fee_sen = 0 and x.required = '[]'::jsonb and x.takeaway_avail = 'all'
             and x.qr_avail = 'all' and x.dine_in_sen > 0 and x.takeaway_sen > 0 and x.qr_sen > 0 then 'plain' end),
      (case when x.sst_rate_bp > 0 and x.takeaway_fee_sen > 0 and x.required = '[]'::jsonb and x.takeaway_avail = 'all'
             and x.dine_in_sen > 0 and x.takeaway_sen > 0 then 'fee' end),
      (case when x.sst_rate_bp = 0 and x.required = '[]'::jsonb and x.dine_in_sen > 0 then 'zero' end),
      (case when x.required <> '[]'::jsonb and x.dine_in_sen > 0
             and not exists (select 1 from jsonb_array_elements(x.required) r
                              where (r->>'minSelect')::int <> 1 or r->'option' is null or r->'option' = 'null'::jsonb) then 'set' end)
    ) as b(bucket)
   where b.bucket is not null and not x.has_time_slots
)
select jsonb_pretty(jsonb_build_object(
  'branchId', (select id from br),
  'settings', (select jsonb_build_object('sstRegistered', s.sst_registered, 'cashRounding', s.cash_rounding,
                                         'receiptRoute', s.receipt_route, 'cashVarianceLimitSen', s.cash_variance_limit_sen)
                 from branch_pos_settings s, br where s.branch_id = br.id),
  'rules', (select coalesce(jsonb_agg(jsonb_build_object('rateBp', r.rate_bp, 'orderTypes', to_jsonb(r.order_types),
                                                         'tableIds', to_jsonb(r.table_ids), 'productIds', to_jsonb(r.product_ids))
                                      order by r.sort_order, r.created_at, r.id), '[]'::jsonb)
              from service_charge_rules r, br where r.branch_id = br.id and r.is_active),
  'tables', (select jsonb_object_agg(t.label, t.id) from dining_tables t, br where t.branch_id = br.id and t.is_active),
  'methods', (select coalesce(jsonb_agg(jsonb_build_object('name', m.name, 'kind', m.kind) order by m.sort_order, m.name), '[]'::jsonb)
                from payment_methods m, br where m.branch_id = br.id and m.is_active),
  'openShift', (select exists (select 1 from pos_shifts s, br where s.branch_id = br.id and s.status = 'open')),
  'lastClose', (select max(s.closed_at) from pos_shifts s, br where s.branch_id = br.id and s.status = 'closed'),
  'openBills', (select count(*) from bills b, br where b.branch_id = br.id and b.status = 'open'),
  -- voids already made since the last close: the next Z report lists them too
  'earlierVoids', (select jsonb_build_object(
      'items', count(*), 'valueSen', coalesce(sum(oi.unit_price_sen * oi.qty), 0))
      from order_items oi join bills b on b.id = oi.bill_id, br
     where b.branch_id = br.id and oi.voided_at > (select max(s.closed_at) from pos_shifts s where s.branch_id = br.id and s.status = 'closed')),
  'earlierVoidBills', (select count(*) from bills b, br
     where b.branch_id = br.id and b.status = 'voided'
       and b.closed_at > (select max(s.closed_at) from pos_shifts s where s.branch_id = br.id and s.status = 'closed')),
  'candidates', (select coalesce(jsonb_object_agg(g.bucket, g.items), '{}'::jsonb) from (
      select bucket, jsonb_agg(jsonb_build_object(
               'name', name, 'nameSnapshot', name_snapshot, 'productId', id, 'sstRateBp', sst_rate_bp,
               'takeawayFeeSen', takeaway_fee_sen, 'printRoute', print_route, 'dineInSen', dine_in_sen,
               'takeawaySen', takeaway_sen, 'qrSen', qr_sen, 'required', required) order by n) as items
        from bucketed where n <= 3 group by bucket) g)
)) as facts;
```

- [ ] **Step 2: Write the generator.** Create `tools/run-sheet/facts.ts`:

```ts
// The Demo branch's facts (tools/run-sheet/facts.sql, saved as JSON) and the money helpers of
// figures.ts. Every price and total comes from the menu facts and bill.ts's computeBill.
import { readFileSync } from 'node:fs'
import { computeBill, type BillTotals, type CashRounding, type ServiceChargeRuleInput } from '../../src/features/pos/checkout/bill.ts'

export interface Product {
  name: string
  nameSnapshot: string
  productId: string
  sstRateBp: number
  takeawayFeeSen: number
  printRoute: string | null
  dineInSen: number
  takeawaySen: number | null
  qrSen: number | null
  required: { group: string; minSelect: number; option: { name: string; deltaSen: number } }[]
}
export interface Facts {
  branchId: string
  settings: { sstRegistered: boolean; cashRounding: CashRounding; receiptRoute: string | null; cashVarianceLimitSen: number } | null
  rules: ServiceChargeRuleInput[]
  tables: Record<string, string>
  methods: { name: string; kind: string }[]
  openShift: boolean
  lastClose: string | null
  openBills: number
  earlierVoids: { items: number; valueSen: number }
  earlierVoidBills: number
  candidates: Partial<Record<'plain' | 'fee' | 'zero' | 'set', Product[]>>
}
export type Where = 'dine_in' | 'takeaway' | 'qr'
export interface Item { p: Product; qty: number; where: Where; voided?: boolean }

export function readFacts(path: string): Facts {
  return JSON.parse(readFileSync(path, 'utf8')) as Facts
}

/** The i-th candidate of a bucket of facts.sql; none → stop: the controller chooses another product. */
export function pickProduct(facts: Facts, bucket: 'plain' | 'fee' | 'zero' | 'set', i: number, what: string): Product {
  const p = facts.candidates[bucket]?.[i]
  if (!p) throw new Error(`The Demo menu has no ${what} (bucket "${bucket}", #${i + 1}) — ask the controller to choose one`)
  return p
}

/** The first active payment method of one of these kinds. */
export function methodName(facts: Facts, kinds: string[], what: string): string {
  const m = facts.methods.find((x) => kinds.includes(x.kind))
  if (!m) throw new Error(`The Demo branch has no ${what} payment method`)
  return m.name
}

export const money = (sen: number) => `${sen < 0 ? '-' : ''}${(Math.abs(sen) / 100).toFixed(2)}`
export const rm = (sen: number) => `RM ${money(sen)}`
export const md = (s: string) => s.replace(/\|/g, '\\|')
export const optionDelta = (p: Product) => p.required.reduce((n, r) => n + r.option.deltaSen, 0)

/** One unit as the bill snapshots it: the catalog price of where it is ordered, plus its set choices. */
export function unitSen(i: Item): number {
  const base = i.where === 'takeaway' ? i.p.takeawaySen : i.where === 'qr' ? i.p.qrSen : i.p.dineInSen
  if (base === null) throw new Error(`${i.p.name} has no ${i.where} price`)
  return base + optionDelta(i.p)
}

export function branchSettings(facts: Facts) {
  return facts.settings ?? { sstRegistered: true, cashRounding: 'nearest_5_sen' as CashRounding, receiptRoute: null, cashVarianceLimitSen: 500 }
}

/** A bill of these items at this table (null = takeaway), totalled by the POS's own rules. */
export function billOf(facts: Facts, orderType: 'dine_in' | 'takeaway', table: string | null, items: Item[]): BillTotals {
  const tableId = table === null ? null : facts.tables[table]
  if (tableId === undefined) throw new Error(`The Demo branch has no table ${table}`)
  const settings = branchSettings(facts)
  return computeBill({
    orderType, tableId, sstRegistered: settings.sstRegistered, cashRounding: settings.cashRounding, rules: facts.rules,
    lines: items.map((i) => ({
      productId: i.p.productId, unitPriceSen: unitSen(i), qty: i.qty, sstRateBp: i.p.sstRateBp,
      takeawayFeeSen: i.where === 'takeaway' ? i.p.takeawayFeeSen : 0, voided: i.voided ?? false,
      orderType: i.where === 'takeaway' ? 'takeaway' as const : 'dine_in' as const,
    })),
  })
}
```

Create `tools/run-sheet/figures.ts`:

```ts
// Writes the simulated business run sheet (docs/pos/2026-10-25-simulated-run-sheet.md) from the
// Demo branch's facts — tools/run-sheet/facts.sql, run read-only on craft-os-dev and saved as JSON —
// with the totals rules of bill.ts, so every expected figure is the POS's own.
// Run: node --experimental-strip-types --no-warnings tools/run-sheet/figures.ts <facts.json> <out.md>
import { writeFileSync } from 'node:fs'
import type { BillTotals } from '../../src/features/pos/checkout/bill.ts'
import {
  billOf, branchSettings, md, methodName, money, optionDelta, pickProduct, readFacts, rm, unitSen,
  type Item, type Product,
} from './facts.ts'

const [factsPath, outPath] = process.argv.slice(2)
if (!factsPath || !outPath) throw new Error('Usage: figures.ts <facts.json> <out.md>')
const facts = readFacts(factsPath)
const pick = (bucket: 'plain' | 'fee' | 'zero' | 'set', i: number, what: string) => pickProduct(facts, bucket, i, what)
const P1 = pick('plain', 0, '6% SST item without a packaging fee, on the takeaway and QR menus')
const P5 = pick('plain', 1, 'second 6% SST item without a packaging fee, on the QR menu')
const P2 = pick('fee', 0, 'item with a packaging fee on the takeaway menu')
const P3 = pick('zero', 0, '0% SST item')
const P4 = pick('set', 0, 'set meal (one required choice per group)')
const method = (kinds: string[], what: string) => methodName(facts, kinds, what)
const CASH = method(['cash'], 'cash')
const CARD = method(['card'], 'card')
const QR = method(['duitnow', 'ewallet'], 'DuitNow / e-wallet')
const settings = branchSettings(facts)
const unit = unitSen
const bill = (orderType: 'dine_in' | 'takeaway', table: string | null, items: Item[]): BillTotals => billOf(facts, orderType, table, items)
const totalLine = (t: BillTotals) => [
  `subtotal ${rm(t.subtotalSen)}`,
  ...(t.serviceChargeSen ? [`service charge ${rm(t.serviceChargeSen)}`] : []),
  ...(t.sstSen ? [`SST ${rm(t.sstSen)}`] : []),
  ...(t.takeawayFeeSen ? [`takeaway packaging ${rm(t.takeawayFeeSen)}`] : []),
  `rounding ${rm(t.roundingSen)}`,
  `**total ${rm(t.totalSen)}**`,
].join(' · ')

// ── the bills of the run ────────────────────────────────────────────────────
const t1Counter: Item[] = [{ p: P1, qty: 2, where: 'dine_in' }, { p: P2, qty: 1, where: 'dine_in' }]
const t1Qr: Item[] = [{ p: P5, qty: 1, where: 'qr' }]
const t2Items: Item[] = [{ p: P4, qty: 1, where: 'dine_in' }, { p: P3, qty: 1, where: 'dine_in' }]
const t2AfterVoid: Item[] = [t2Items[0], { ...t2Items[1], voided: true }]
const taItems: Item[] = [{ p: P2, qty: 1, where: 'takeaway' }, { p: P1, qty: 1, where: 'takeaway' }]
const t6Items: Item[] = [{ p: P1, qty: 1, where: 'dine_in' }]
const withBetween = facts.lastClose !== null    // S1 lands in this Z report only when an earlier close exists

const T1a = bill('dine_in', 'T1', t1Counter)
const T1b = bill('dine_in', 'T1', [...t1Counter, ...t1Qr])
const T2a = bill('dine_in', 'T2', t2Items)
const T2b = bill('dine_in', 'T2', t2AfterVoid)
const T5 = bill('dine_in', 'T5', t2AfterVoid)
const TA = bill('takeaway', null, taItems)
const T1m = bill('dine_in', 'T1', [...t1Counter, ...t1Qr, ...taItems])
const T6 = bill('dine_in', 'T6', t6Items)
const T3 = bill('dine_in', 'T3', [{ p: P1, qty: 1, where: 'dine_in' }])
// merged vs apart before rounding: equal, except up to 1 sen per service-charge or SST rate both bills
// share (each rate is rounded once on the whole bill) — the sheet prints any difference
const apartSen = T1b.beforeRoundingSen + TA.beforeRoundingSen
const mergeGap = T1m.beforeRoundingSen - apartSen
const mergeNote = `Before rounding: T1 ${rm(T1b.beforeRoundingSen)} + takeaway ${rm(TA.beforeRoundingSen)} = ${rm(apartSen)}` + (mergeGap === 0
  ? `, the merged bill's own ${rm(T1m.beforeRoundingSen)}.`
  : `; the merged bill is ${rm(T1m.beforeRoundingSen)} — ${rm(Math.abs(mergeGap))} ${mergeGap > 0 ? 'more' : 'less'}, as expected: service charge and SST are rounded once per rate on the whole bill.`)

// ── payments, refund, cash ──────────────────────────────────────────────────
const t5Received = (Math.floor(T5.totalSen / 1000) + 1) * 1000      // the next RM 10 above: there is change
const t5Change = t5Received - T5.totalSen
const t1Card = Math.floor(T1m.totalSen / 2 / 100) * 100
const t1Cash = T1m.totalSen - t1Card
const t1Received = Math.ceil(t1Cash / 1000) * 1000
const t1Change = t1Received - t1Cash
const refund = Math.min(500, T5.totalSen)
const FLOAT = 20000, PAY_IN = 2000, PAY_OUT = 1500
const cashSales = t1Cash + T5.totalSen
const expectedCash = FLOAT + cashSales - refund + PAY_IN - PAY_OUT

// ── the Z report ────────────────────────────────────────────────────────────
const paid = [T1m, T5, T6]
const sum = (f: (t: BillTotals) => number) => paid.reduce((n, t) => n + f(t), 0)
const nett = sum((t) => t.totalSen)
const voidBills = 1 + (withBetween ? 1 : 0) + facts.earlierVoidBills
const voidSen = unit(t2Items[1]) + unit({ p: P1, qty: 1, where: 'dine_in' }) * (withBetween ? 2 : 1) + facts.earlierVoids.valueSen
const counterItems = [...t1Counter, ...taItems, t2Items[0], ...t6Items]
const value = (items: Item[]) => items.reduce((n, i) => n + unit(i) * i.qty, 0)
const products = new Map<string, { qty: number; value: number }>()
for (const i of [...counterItems, ...t1Qr]) {
  const row = products.get(i.p.nameSnapshot) ?? { qty: 0, value: 0 }
  products.set(i.p.nameSnapshot, { qty: row.qty + i.qty, value: row.value + unit(i) * i.qty })
}
const productLines = [...products.entries()]
  .sort((a, b) => b[1].qty - a[1].qty || b[1].value - a[1].value || a[0].localeCompare(b[0]))
  .map(([name, r]) => `${r.qty} ${name} · ${money(r.value)}`)
const payments = [
  { name: CASH, count: 2, amount: cashSales, refunds: 1, refund },
  { name: CARD, count: 1, amount: t1Card, refunds: 0, refund: 0 },
  { name: QR, count: 1, amount: T6.totalSen, refunds: 0, refund: 0 },
].sort((a, b) => a.name.localeCompare(b.name))
const opt = (p: Product) => p.required.map((r) => `${r.group}: ${r.option.name}`).join(', ')

const zLines = [
  ['SUMMARY', ''],
  ['Bills', '3'], ['Pax', '4'], ['Nett sales', money(nett)],
  ['Average per bill', money(Math.round(nett / 3))], ['Average per pax', money(Math.round(nett / 4))],
  ['Void bills', String(voidBills)], ['Total void', money(voidSen)], ['Total refund', money(refund)],
  ['SALES SUMMARY', ''],
  ['Gross sales', money(sum((t) => t.subtotalSen))], ['Takeaway fee', money(sum((t) => t.takeawayFeeSen))],
  ['Service charge', money(sum((t) => t.serviceChargeSen))], ['SST', money(sum((t) => t.sstSen))],
  ['Rounding', money(sum((t) => t.roundingSen))], ['Nett sales', money(nett)],
  ['PAYMENTS', ''],
  ...payments.flatMap((p) => [
    [`${p.name} (${p.count})`, money(p.amount)],
    ...(p.refunds ? [[`  Refunds (${p.refunds})`, money(-p.refund)]] : []),
    ['  Net', money(p.amount - p.refund)],
  ]),
  ['ORDER TYPE', ''], ['Dine-in (3)', money(nett)], ['Takeaway (0)', '0.00'],
  ['SOURCE', ''], ['Counter (4 orders)', money(value(counterItems))], ['QR (1 order)', money(value(t1Qr))],
  ['CASH DRAWER', ''],
  ['Opening float', money(FLOAT)], ['Cash sales', money(cashSales)], ['Cash refunds', money(-refund)],
  ['Pay in: Float top-up', money(PAY_IN)], ['Pay out: Ice', money(-PAY_OUT)],
  ['Expected cash', money(expectedCash)], ['Counted cash', money(expectedCash)], ['Variance', '0.00'],
  ['VOIDS SINCE THE LAST CLOSE', ''],
  ...(facts.earlierVoids.items || facts.earlierVoidBills
    ? [[`(before this run: ${facts.earlierVoids.items} item(s), ${facts.earlierVoidBills} bill(s))`, money(facts.earlierVoids.valueSen)]] : []),
  ...(withBetween ? [[`1 ${P1.nameSnapshot} (T9, step 1)`, money(unit({ p: P1, qty: 1, where: 'dine_in' }))], ['Bill (T9) voided, Test bill', '']] : []),
  [`1 ${P3.nameSnapshot} (T2, step 5)`, money(unit(t2Items[1]))],
  [`1 ${P1.nameSnapshot} (T3, step 11)`, money(unit({ p: P1, qty: 1, where: 'dine_in' }))],
  ['Bill (T3) voided, Customer left', ''],
  ['REFUNDS', ''], [`(T5's bill) ${CASH}, Quality complaint`, money(refund)],
  ['PRODUCT SALES', ''], ...productLines.map((l) => [l, '']),
]

type Step = [string, string, string, string]   // step, who, do, expect
const steps: Step[] = [
  ...(withBetween ? [[
    '1', 'A', `No shift open yet. Table **T9** → 1 × ${md(P1.nameSnapshot)} → Send. Tap the item → Void item, reason "Wrong item keyed", approver + PIN. Then **Void bill**, reason "Test bill" (approver + PIN if the dialog asks).`,
    `VOID ticket for ${md(P1.nameSnapshot)} on ${P1.printRoute ?? 'no printer'}. T9 is free again. Both voids appear in this shift's Z report (made since the last close).`,
  ] as Step] : []),
  ['2', 'A', `**Open shift**, opening float **RM ${money(FLOAT)}**.`, 'Top bar: "Shift open · since HH:MM".'],
  ['3', 'A + B together', `A: **T1**, pax 2 → 2 × ${md(P1.nameSnapshot)} + 1 × ${md(P2.nameSnapshot)} → Send. B at the same moment: **T2**, pax 1 → 1 × ${md(P4.nameSnapshot)} (${md(opt(P4))}) + 1 × ${md(P3.nameSnapshot)} → Send.`,
    `Tickets: ${md(P1.nameSnapshot)}, ${md(P2.nameSnapshot)} → ${P1.printRoute ?? '-'} / ${P2.printRoute ?? '-'}; ${md(P4.nameSnapshot)}, ${md(P3.nameSnapshot)} → ${P4.printRoute ?? '-'} / ${P3.printRoute ?? '-'}. T1: ${totalLine(T1a)}. T2: ${totalLine(T2a)}.`],
  ['4', 'Phone', `Open **T1**'s QR link → 1 × ${md(P5.nameSnapshot)} → Place order.`,
    `A: T1 marked new; ticket on ${P5.printRoute ?? '-'}. T1: ${totalLine(T1b)}.`],
  ['5', 'B (A watches T2)', `A opens T2's bill panel. B: T2 → tap ${md(P3.nameSnapshot)} → Void item, reason "Wrong item keyed", approver + PIN.`,
    `A's T2 panel drops the item within 2 s. VOID ticket on ${P3.printRoute ?? '-'}. T2: ${totalLine(T2b)}.`],
  ['6', 'B', '**Move table** T2 → **T5**.', `T2 free, T5 occupied. T5: ${totalLine(T5)}.`],
  ['7', 'A', `**Takeaway** → 1 × ${md(P2.nameSnapshot)} + 1 × ${md(P1.nameSnapshot)} → Send. Note its bill number.`,
    `Takeaway prices. Takeaway: ${totalLine(TA)}.`],
  ['8', 'A', "T1 → **Merge** → choose the takeaway bill.", `T1 keeps the takeaway's packaging fee: ${totalLine(T1m)}. (${mergeNote})`],
  ['9', 'A + B', `A: T5 → **Checkout** (leave the sheet open). B: T5 → Checkout → ${md(CASH)} → cash received **RM ${money(t5Received)}** → Pay.`,
    `B: change **${rm(t5Change)}**, receipt prints. A's sheet locks with the red note "This bill was paid on another iPad — do not charge the card terminal." — only **Close** works. A taps Close.`],
  ['10', 'A', `T1 → Checkout → ${md(CARD)} **RM ${money(t1Card)}** → Add; ${md(CASH)} **RM ${money(t1Cash)}**, cash received **RM ${money(t1Received)}** → Add → Pay ${rm(T1m.totalSen)}.`,
    `Change **${rm(t1Change)}**; the receipt lists both payments and the takeaway packaging.`],
  ['11', 'A', `**T3** → 1 × ${md(P1.nameSnapshot)} → Send. Then **Void bill**, reason "Customer left", approver + PIN.`,
    `VOID ticket on ${P1.printRoute ?? '-'}. T3 (${rm(T3.totalSen)}) is voided and free again.`],
  ['12', 'B', `**Today's bills** → T5's bill → **Refund** ${rm(refund)} to ${md(CASH)}, reason "Quality complaint", approver + PIN.`,
    'Refund slip prints; Today\'s bills shows the refund on T5\'s bill.'],
  ['13', 'A', `**Pay in** RM ${money(PAY_IN)}, reason "Float top-up". Then **Pay out** RM ${money(PAY_OUT)}, reason "Ice", approver + PIN.`,
    'Each sheet says it was recorded.'],
  ['14', 'A (offline spell)', `Turn A's Wi-Fi off. **T6**, pax 1 → 1 × ${md(P1.nameSnapshot)} → Send. Wi-Fi on.`,
    `While off: "1 order waiting to send". After: it sends by itself, ticket on ${P1.printRoute ?? '-'}. T6: ${totalLine(T6)}.`],
  ['15', 'A (unsure reply, on the iPad)', `On iPad A (Safari): T6 → Checkout → ${md(QR)} ${rm(T6.totalSen)} → Add. Wi-Fi off → **Pay**. Wi-Fi on → **Check bill** → **Pay**.`,
    'Off: "Not sure the payment went through…", method buttons, amounts and remove locked, only Try again / Check bill / Back. (Safari reports the dropped request as "Load failed": if the sheet shows "TypeError: Load failed" with the lines unlocked instead, the unsure-reply lock fails on the iPad — fail this step.) Check bill: "The bill is still open — the payment was not recorded. Check the lines and press Pay." Pay: paid, receipt prints.'],
  ['16', 'A', `**Close shift** → count the drawer: enter **RM ${money(expectedCash)}** → Close.`,
    'No open bills warned. Closes at once (variance 0.00). The Z report prints on the receipt printer and shows on screen — compare it with the next section.'],
]

const productRows = [
  ['P1', P1, 'counter, takeaway and the offline order'], ['P2', P2, 'with a packaging fee'], ['P3', P3, '0% SST'],
  ['P4', P4, `set meal — ${opt(P4)}`], ['P5', P5, 'the QR order'],
] as const
const out = `# Simulated business run — POS pre-pilot (Demo branch)

Date: 2026-10-25 · Project: **craft-os-dev** · Branch: Demo (\`${facts.branchId}\`)

The after-hours script the owner runs on site with two iPads, the ZyWell ZY301 and the print agent,
before the pilot. Every expected figure below was computed by \`tools/run-sheet/figures.ts\` from the
Demo menu on dev with the POS's own totals rules (\`src/features/pos/checkout/bill.ts\`). If a price,
a service-charge rule or a payment method changes, run the query at the end again and regenerate this
sheet. Bill numbers are not known in advance: bills are named by their table.

## Before you start

- iPad **A** (counter) and iPad **B** (floor) on \`/pos\`, signed in as staff of Demo. Someone with
  **Approve POS voids & refunds** and a POS PIN is the approver for every "approver + PIN" below.
- The print agent runs with \`BRANCH_ID=${facts.branchId}\` and a login of Demo staff; the ZY301 is on
  with paper. Receipts go to ${settings.receiptRoute ?? '— no receipt printer set (set one in POS settings first)'}.
- Close any open shift of Demo and pay or void every open bill **before** the facts are read (\`facts.sql\`).
  If you do it afterwards, run \`facts.sql\` again and regenerate this sheet: the expected Z report counts
  the voids since the last close. When the facts were read: shift open **${facts.openShift ? 'yes — close it, then regenerate' : 'no'}**,
  open bills **${facts.openBills}**${facts.openBills ? ' — clear them, then regenerate' : ''}.
- Wrong PINs are counted per **login**: five wrong tries lock that login out of the approver for 10 minutes
  on every iPad signed in with it. Give each cashier their own login on the pilot iPads.
- A phone with a camera for the QR order.
- Cash variance limit RM ${money(settings.cashVarianceLimitSen)}; SST registered: ${settings.sstRegistered ? 'yes' : 'no'};
  cash rounding: ${settings.cashRounding}.

| Code | Product (as on the bill) | Dine-in | Takeaway | QR | SST | Packaging fee | Printer | Used for |
|---|---|---|---|---|---|---|---|---|
${productRows.map(([c, p, why]) => `| ${c} | ${md(p.nameSnapshot)} | ${money(p.dineInSen + optionDelta(p))} | ${p.takeawaySen === null ? '-' : money(p.takeawaySen)} | ${p.qrSen === null ? '-' : money(p.qrSen)} | ${p.sstRateBp / 100}% | ${money(p.takeawayFeeSen)} | ${p.printRoute ?? '-'} | ${md(why)} |`).join('\n')}

Service-charge rules (first match wins): ${facts.rules.length === 0 ? 'none' : facts.rules.map((r) => `${r.rateBp / 100}% on ${r.orderTypes.join(' + ')}${r.tableIds ? ' at some tables' : ''}${r.productIds ? ' for some products' : ''}`).join('; ')}.
Payment methods used: ${md(CASH)} (cash), ${md(CARD)} (card), ${md(QR)} (QR).

## Steps

| Step | Who | Do | Expect |
|---|---|---|---|
${steps.map((s) => `| ${s.join(' | ')} |`).join('\n')}

## Expected Z report

The printed report has these lines (times and names are left out; a value is flush right on paper).
${withBetween ? '' : 'No shift of Demo was ever closed, so the voids of step 1 would not be listed: step 1 is left out.\n'}
| Line | Value |
|---|---|
${zLines.map(([l, v]) => (v === '' && l === l.toUpperCase() ? `| **${md(l)}** | |` : `| ${md(l)} | ${v} |`)).join('\n')}

## Results

| Step | Expected | Seen | Pass / fail |
|---|---|---|---|
${steps.map((s) => `| ${s[0]} | ${s[3]} | | |`).join('\n')}
| Z report | Every line of the section above | | |

## Regenerating this sheet

1. Close any open shift of Demo and clear its open bills first. Then run \`tools/run-sheet/facts.sql\` in
   the SQL editor of **craft-os-dev** (read-only) right before the run, and save its one \`facts\` cell as a
   JSON file. Make no other voids and close no shift on Demo after that — if you do, run it again and
   regenerate.
2. \`node --experimental-strip-types --no-warnings tools/run-sheet/figures.ts <facts.json> docs/pos/2026-10-25-simulated-run-sheet.md\`
`
writeFileSync(outPath, out)
console.log(`wrote ${outPath}: T1 ${rm(T1m.totalSen)}, T5 ${rm(T5.totalSen)}, T6 ${rm(T6.totalSen)}, expected cash ${rm(expectedCash)}`)
```

Create `tools/run-sheet/facts.example.json` (a made-up menu, for checking the generator without the database):

```json
{
  "rules": [
    {
      "rateBp": 1000,
      "tableIds": null,
      "orderTypes": [
        "dine_in"
      ],
      "productIds": null
    }
  ],
  "tables": {
    "T1": "1b3862da-918d-4392-bce9-c102591dc313",
    "T2": "a4895eb1-2a1d-447c-8767-e6eb79c2f6da",
    "T3": "a2ac38a5-cf20-4024-b067-21c5d45599e1",
    "T4": "a28dcc41-e7ce-4b28-b444-dac8ab6192b1",
    "T5": "7495c17a-536a-4bbe-bb31-fd5d6a86d9c1",
    "T6": "3ba10094-d28d-4fd5-abbd-2d69e1dc14fe",
    "T7": "fd00d3b0-f95d-4e14-bea5-27554feb6794",
    "T8": "4f5b1ff5-8b1b-4a97-83b7-fba5d6a8f0a4",
    "T9": "95c6f258-035d-4f11-a764-8db59ffe4731",
    "T10": "d1576817-0562-4efd-99a8-0ebbcf17ab50"
  },
  "methods": [
    {
      "kind": "cash",
      "name": "Cash"
    },
    {
      "kind": "card",
      "name": "Maybank Terminal"
    },
    {
      "kind": "duitnow",
      "name": "DuitNow QR"
    },
    {
      "kind": "ewallet",
      "name": "Touch 'n Go"
    }
  ],
  "branchId": "0b161497-5069-46a7-a2d9-bf13dfcb9845",
  "settings": {
    "cashRounding": "nearest_5_sen",
    "receiptRoute": "Bar",
    "sstRegistered": true,
    "cashVarianceLimitSen": 500
  },
  "lastClose": null,
  "openBills": 0,
  "openShift": false,
  "candidates": {
    "fee": [
      {
        "name": "Chicken Chop",
        "qrSen": 2290,
        "required": [],
        "dineInSen": 2290,
        "productId": "a2400bf8-3360-4a9a-9477-ac83a245be71",
        "sstRateBp": 600,
        "printRoute": "Kitchen",
        "takeawaySen": 2340,
        "nameSnapshot": "Chicken Chop",
        "takeawayFeeSen": 100
      }
    ],
    "set": [
      {
        "name": "Set Lunch A",
        "qrSen": 1890,
        "required": [
          {
            "group": "Set drink",
            "option": {
              "name": "Iced Lemon Tea",
              "deltaSen": 0
            },
            "minSelect": 1
          }
        ],
        "dineInSen": 1890,
        "productId": "f2a08d48-54c6-4aff-b42e-511217a55f42",
        "sstRateBp": 600,
        "printRoute": "Kitchen",
        "takeawaySen": 1940,
        "nameSnapshot": "Set Lunch A",
        "takeawayFeeSen": 0
      }
    ],
    "zero": [
      {
        "name": "Mineral Water",
        "qrSen": 350,
        "required": [],
        "dineInSen": 350,
        "productId": "bba3985e-e911-48f6-a202-8cbbaf74dc2b",
        "sstRateBp": 0,
        "printRoute": "Bar",
        "takeawaySen": 400,
        "nameSnapshot": "Mineral Water",
        "takeawayFeeSen": 0
      }
    ],
    "plain": [
      {
        "name": "Coffee Latte",
        "qrSen": 1200,
        "required": [],
        "dineInSen": 1200,
        "productId": "737dd75a-a398-4788-9675-f8560f64ea27",
        "sstRateBp": 600,
        "printRoute": "Bar",
        "takeawaySen": 1250,
        "nameSnapshot": "Coffee Latte (HOT)",
        "takeawayFeeSen": 0
      },
      {
        "name": "Teh Tarik",
        "qrSen": 690,
        "required": [],
        "dineInSen": 690,
        "productId": "593a08d7-d035-417c-97ad-f8793a7bae6c",
        "sstRateBp": 600,
        "printRoute": "Bar",
        "takeawaySen": 740,
        "nameSnapshot": "Teh Tarik",
        "takeawayFeeSen": 0
      }
    ]
  },
  "earlierVoids": {
    "items": 0,
    "valueSen": 0
  },
  "earlierVoidBills": 0
}
```

- [ ] **Step 3: Check the generator on the fixture, then commit the tools.** Run: `mkdir -p .superpowers/sdd && node --experimental-strip-types --no-warnings tools/run-sheet/figures.ts tools/run-sheet/facts.example.json .superpowers/sdd/run-sheet-example.md` — Expected: `wrote .superpowers/sdd/run-sheet-example.md: T1 RM 101.50, T5 RM 21.90, T6 RM 13.90, expected cash RM 273.40` (the figures a full SQL run of these steps on this menu produced while planning). Run: `grep -c "| Expected cash | 273.40 |" .superpowers/sdd/run-sheet-example.md` — Expected: `1`. Run: `grep -c "undefined\|NaN" .superpowers/sdd/run-sheet-example.md` — Expected: `0`. Run: `npx vitest run` — Expected: 103 files, 902 tests pass. Run: `npx tsc -b` — Expected: no output.

```bash
git add tools/run-sheet/facts.sql tools/run-sheet/facts.ts tools/run-sheet/figures.ts tools/run-sheet/facts.example.json
git commit -m "feat(pos): run-sheet generator — figures from the Demo menu facts with the POS's own totals rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4 (controller, craft-os-dev — dashboard SQL editor, read-only; the implementer does not touch the database):** confirm **craft-os-dev**. **Before** running the query, Demo must have no open shift and no open bill: ask the owner to close the shift and pay or void the open bills first (closing a shift moves "the last close", and voiding adds voids, both of which the expected Z report counts). Then load `tools/run-sheet/facts.sql` and run it. Copy the single `facts` cell into `.superpowers/sdd/run-sheet-facts.json` (git-ignored) in the worktree and hand it to the implementer. If `openShift` is true or `openBills` is not 0 anyway, or a shift is closed or a void made on Demo after the query ran, run the query again and regenerate the sheet (Step 5) — the sheet says so too.

- [ ] **Step 5: Generate the sheet and commit it.** Run: `mkdir -p docs/pos && node --experimental-strip-types --no-warnings tools/run-sheet/figures.ts .superpowers/sdd/run-sheet-facts.json docs/pos/2026-10-25-simulated-run-sheet.md` — Expected: `wrote docs/pos/2026-10-25-simulated-run-sheet.md: T1 RM …, T5 RM …, T6 RM …, expected cash RM …`. Read the sheet once: five products with real Demo names and prices, every step has an expectation, the Z report section and the results table are there; `grep -c "undefined\|NaN" docs/pos/2026-10-25-simulated-run-sheet.md` → `0`. Commit:

```bash
git add docs/pos/2026-10-25-simulated-run-sheet.md
git commit -m "docs(pos): simulated business run sheet for the pre-pilot run (Demo menu on dev)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Open points (not in this plan)

- `print_jobs_update` RLS policy: any signed-in staff member can still UPDATE the lifecycle columns of any branch's job directly (not through the RPCs). Outside the spec; a follow-up can drop the policy and the column grant now that every lifecycle change goes through the `security definer` RPCs.
- Prod rollout order (owner): shifts schema → shifts functions → this migration → deploy. The print agent stays dev-only (`assertDevDatabase`): it gets its `BRANCH_ID` on prod when the agent is cleared for prod — not in this plan.
- Prod pre-check before the migration (read-only; the backfill gives a takeaway merged into an **open** table bill its packaging fee and the fee's SST, so such a bill's total rises when the migration runs): `select count(*) from order_items oi join bills b on b.id = oi.bill_id where b.status = 'open' and b.order_type = 'dine_in' and oi.takeaway_fee_sen > 0` → `0`, or the owner settles those bills first (or tells the cashiers their totals will change).

## Self-review (done while planning)

- Spec coverage: §1 → Tasks 1 (`pos_checkout_state`), 4, 5; §2 → Tasks 1 (`checkout_bill`, `pos_checkout_same_payments`), 4, 5; §3 → Task 1 (`void_order_item`, `bills.updated_at`) and Task 5 Step 6.2; §4 → Tasks 1 (column, trigger, backfill, `pos_compute_bill`, `pos_bill_totals`), 2; §5 → Task 1 (`pos_shift_report`, heading); §6 → Task 1 (`pos_pin_attempts`, `pos_pin_attempt`, `set_my_pos_pin`); §7 → Tasks 1 (RPCs) and 6; §8 → Task 7; SQL rules → Task 1 (STOP guard, re-run notes, notify, grants); Testing → Task 3 (verify + regression), Tasks 2, 4, 6 (Vitest), Task 5 Step 6 (browser).
- Placeholders: none — every code step carries its full text; the run sheet's figures come from the controller's query by the committed generator (a data dependency, stated in Task 7).
- Names: `pos_checkout_state` (`p_checkout_ids uuid[]`), `CheckoutState`, `followBill`, `FollowAction`, `PaySession` (`earlierIds`), `nextPay`, `checkEnded`, `checkoutIds`, `fetchCheckoutState`, `looksOffline`, `branchIdFrom`, `isAgentJob`, `loginBranchProblem` are spelled the same in every task.
- After the review (`.superpowers/sdd/hardening-plan-review.md`): I1 (Safari's "Load failed" — one shared `looksOffline`), M1 (a new PIN clears the approver's wrong tries), M2 (merged = apart up to 1 sen per shared rate), M3 (`p_checkout_ids`), M4 (backfill note and prod pre-check), M5 (apply on dev at the end of Task 1), M6 (voided state; takeaway-labelled-dine-in check), M7 (facts after closing the shift), M8 (agent dev-only), M9 (heading capitals recorded), M10 (load error cleared, one login per cashier, `grep -cE`) are applied.
