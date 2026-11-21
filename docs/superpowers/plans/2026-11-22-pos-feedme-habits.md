# POS Smaller Feedme Habits (W7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Five habits the cashiers know from Feedme: a remark on QR items, a last-order time per outlet, a takeaway line inside a dine-in bill, adults / children in the pax, and marking lines served.

**Architecture:** One SQL migration (two tasks) with a rolled-back verify: two time columns with `pos_orders_open` / `pos_orders_closed_message`, refused in the QR add / send RPCs and in `pos_insert_order` for QR; a per-line `"takeaway": true` from the counter stored as `order_items.order_type = 'takeaway'` with its packaging fee, kept by the order-type trigger and marked on tickets and receipts; `bills.pax_children` set by the three pax paths and carried by both receipts; `served_at` / `served_by` with `set_items_served`. On the client, a pure `orderWindow.ts` mirrors the window for the QR banner and the POS pad banner; the QR item sheet gets a Remark field; the POS item sheet a Takeaway switch; the pax picker an "Of which children" stepper; the item actions menu Serve / Not served and the bill actions Mark all served.

**Tech Stack:** Supabase Postgres (plpgsql / sql functions, triggers), React 19 + TypeScript + Vite, Tailwind, Vitest + Testing Library (jsdom per file), Node print agent (type stripping).

**Spec:** `docs/superpowers/specs/2026-11-22-pos-feedme-habits-design.md` (owner approved 2026-11-22; binding).

## Spec conflicts

Places where the code makes a spec point impossible or wrong as written. Each is resolved as stated; nothing else departs from the spec. Small ones — the controller may settle them.

1. **§6 "Long-press a sent line → Serve".** The POS has no long-press anywhere: tapping a sent line opens its item actions menu (`ItemActionsOverlay`: Discount item, Void item). On the iPad a long press on that button also ends in the same click. **Resolution:** `Serve` / `Not served` is the first entry of that menu; no separate long-press handler (one gesture, one meaning).
2. **§3 "The QR add and send RPCs refuse".** A third anon RPC still places QR orders: `place_table_order` (live in migration-2026-10-24-pos-catalogs-fn.sql, granted to anon), which would order past the last-order time. **Resolution:** besides `qr_cart_put` and `qr_cart_send`, `pos_insert_order` refuses source `qr` outside the window with the same sentence (one H1 block), which covers `place_table_order` without re-creating it.
3. **§5 children "set" on a table with no bill yet.** The pax of an empty table goes with its first order (`place_counter_order` → `pos_insert_order`, which opens the bill); the spec names only the column. **Resolution:** `place_counter_order` gets an 8th argument `p_pax_children integer default null` and fills `pax_children` after `pos_insert_order` when it is empty (clamped to pax); `pos_set_bill_pax` and `open_table` get `p_children integer default null`. The old signatures are dropped first (PostgREST cannot choose between two candidates). `pos_insert_order` keeps its 9 arguments.
4. **§4 "The POS item sheet shows a switch `Takeaway`".** A product with one size and no add-ons never opens the sheet: a tap adds it straight to the cart. **Resolution:** unchanged one-tap add; tapping that draft line opens the sheet (as it does today to edit a draft), and the switch is there. No extra tap for the usual case.
5. **§5 "0 ≤ children ≤ pax", picker "0 … pax".** "0 children" and "none" read the same on the bill and the receipt (`3 pax`), and the picker comes before the pax tap so one tap still picks the pax. **Resolution:** the "Of which children" stepper reads `None`, 1 … 20 (− from 1 goes back to None) and sits above the pax grid; the chosen children are clamped to the pax tapped. The server and the table check accept 0 … pax as the spec says.

## Spec notes (readings taken where the spec is silent)

1. **The window's edges:** open from the `orders_open_at` minute (09:00:00) to the end of the `last_order_at` minute (21:30:59); 21:31 is closed. Equal times are refused on save: `Orders open at and Last order at must be different times.` (new copy; the spec has no rule for them).
2. **Whose clock:** the server's decides (`now()` in the RPCs). The POS pad mirrors it with the pad's server-offset clock (`usePadWindows().now`); the QR page with the phone's clock, re-evaluated every minute (`useMinuteClock`). A wrong phone clock only moves the banner: the server still refuses.
3. **What the QR page disables:** Add / Save in the item sheet and the Place order button; the menu stays browsable and Remove stays allowed. The banner sits above everything under the header.
4. **Bad time input on save** (not HH:MM) is refused with the existing `Invalid settings`; only the time inputs of the settings page send these keys.
5. **The QR remark length:** the field stops at 120 characters (`maxLength`); `qr_cart_put` keeps its live 200-character cap (unchanged text; `order_items.note` is shared with staff notes).
6. **TAKEAWAY on tickets** is on a takeaway line of a dine-in bill only — a takeaway bill's ticket already says `TAKEAWAY` in its header — and on void tickets too, so the kitchen knows which box to stop. A takeaway bill merged into a table (lines already `takeaway` since 2026-10-25) now reads ` (Takeaway)` on its lines, which is what they are.
7. **Children on screen and paper:** `paxChildrenNote` gives ` (1 child)` / ` (n children)`, nothing for none or 0. The bill header button reads `3 pax (1 child)`; the receipt row stays `Table pax` with the value `3 (1 child)`. A merge keeps the target bill's children (its pax only grows).
8. **`set_items_served` details:** a voided line is skipped (not counted, not refused) — a void on another till between the tap and the call is not an error; the call bumps `bills.updated_at` when it changed something, so the other iPads hear of it (as `pos_set_bill_pax` does). New server words: `Choose the items first.`, `The items must be on one bill.`; `Item not found` and `This bill is no longer open.` are already in use.
9. **`Mark all served`** shows in the bill actions while the bill has at least one live, unserved line; it sends exactly those lines.
10. **Children bounds on the server:** `Invalid number of children` for a value below 0 or above 99 (the pax rule's wording); a value above the pax is clamped, not refused (the spec's "clamped").

## Where the live code is (newest definition wins)

| Function / object | Live in | W7 |
|---|---|---|
| `branch_pos_settings` | migration-2026-10-24-pos-checkout.sql (+ W4 columns) | `orders_open_at`, `last_order_at` (H1) |
| `save_receipt_settings(uuid, jsonb)` | migration-2026-11-22-pos-receipt-numbers.sql lines 130–210 | re-created (H1) |
| `qr_menu(text)` | migration-2026-10-24-pos-slots-photos-fn.sql lines 648–710 | re-created (H1) |
| `qr_cart_put`, `qr_cart_send` | migration-2026-11-22-qr-table-cart.sql lines 177–246, 281–341 | re-created (H1) |
| `pos_insert_order` (9 args) | migration-2026-11-22-qr-table-cart.sql lines 344–596 | re-created (H1, H2) |
| `place_table_order` | migration-2026-10-24-pos-catalogs-fn.sql | untouched (refused through `pos_insert_order`) |
| `order_items_order_type()` (trigger fn; trigger from migration-2026-10-25-pos-hardening.sql) | migration-2026-11-16-pos-split-bill.sql lines 64–71 | re-created (H2) |
| `pos_bill_input`, `pos_bill_totals`, `pos_compute_bill` | migration-2026-11-16-pos-split-bill.sql / migration-2026-10-30-pos-discounts.sql | untouched: lines are priced by their own `orderType` (H4 of 10-25: service charge rules by type, the fee only on takeaway lines) |
| `pos_queue_void_tickets(uuid[])` | migration-2026-10-24-pos-bill-actions-fn.sql lines 135–162 | re-created (H2) |
| `pos_receipt_payload(uuid, boolean)`, `pos_part_receipt_payload(uuid)` | migration-2026-11-22-pos-receipt-numbers.sql lines 216–290, 295–372 | re-created (H2, H3) |
| `place_counter_order` (7 args) | migration-2026-10-29-pos-device-till.sql lines 265–284 | dropped; 8-arg version (H3) |
| `pos_set_bill_pax(uuid, integer)` | migration-2026-10-26-pos-frontend.sql lines 66–77 | dropped; 3-arg version (H3) |
| `open_table(uuid, integer)` | migration-2026-10-24-pos-bill-actions-fn.sql lines 370–395 | dropped; 3-arg version (H3) |
| `merge_bills` | migration-2026-10-30-pos-discounts.sql | untouched (sums pax; children stay ≤ pax) |
| `pos_ctx`, `pos_my_branch`, `pos_actor` | migration-2026-10-29-pos-device-till.sql lines 82–136 | used by `set_items_served` (H4) |
| `print_jobs_call_no`, `bills_call_no` (W4 triggers) | migration-2026-11-22-pos-receipt-numbers.sql | untouched |

POS RPCs find the outlet and the person through `pos_ctx()` (device session; during the transition a staff login at its home branch): `pos_my_branch()` = its `branch_id`, `pos_actor()` = its `staff_id`. `set_items_served` reads `pos_ctx()` once for both.

## Global Constraints

- Work only in the worktree `/Users/USER/Desktop/Craft_OS/.claude/worktrees/pos-demo` (branch `feature/pos-demo`); never `cd` to `/Users/USER/Desktop/Craft_OS`; never touch `main`. Other sessions commit to this branch: before each task run `git log --oneline -3` and `git status`; touch only the files your task lists; **never run bare `git stash`** (the stash stack is shared); `git add` exact paths only.
- Implementers never run SQL anywhere. SQL tasks end with the migration + verify file written and `src/features/pos/sqlSafeUpdate.test.ts` passing; the controller runs both on craft-os-dev in Task 8.
- English UI copy. Every label, message and printed word in English; the spec's strings verbatim: `Remark (optional)`, `Remark: …`, `Orders open at`, `Last order at`, `QR ordering stops outside these times. Staff can still order on the POS.`, `Set both times or neither.`, `Last orders were at 21:30. Ordering opens again at 09:00.`, `Past last order (21:30)`, `Takeaway`, ` (Takeaway)`, `TAKEAWAY`, `Of which children`, `3 pax (1 child)` / `(2 children)`, `Serve`, `Not served`, `Mark all served`, `✓`.
- Money is integer sen everywhere (SQL, JSON, TypeScript); ringgit only on screen via `formatSen` and on paper via `money`.
- Times are Malaysia time (`Asia/Kuala_Lumpur`, UTC+8, no daylight saving): `orders_open_at` / `last_order_at` are wall-clock `time`s there, "HH:MM" in JSON and TypeScript; the server's clock decides (`pos_orders_open`), the client mirrors it for display only (`src/features/pos/order/orderWindow.ts`).
- SQL functions: `security definer set search_path = public, pg_temp`; explicit grants like their neighbours — a staff RPC: `revoke all on function f(args) from public, anon;` + `grant execute on function f(args) to authenticated;`; a guest (QR) RPC: `revoke all on function f(args) from public;` + `grant execute on function f(args) to anon, authenticated;`; an internal function or trigger function: `revoke all on function f(args) from public, anon, authenticated;` and no grant. A re-created function keeps its live text except the lines marked with this plan's markers (`-- H1` … `-- H4`; a line that already carried a marker keeps it: `-- G, H2`). Every DELETE / UPDATE has a WHERE (pg-safeupdate). The migration ends with `notify pgrst, 'reload schema';` and one result row.
- Print files imported by the Node print agent (`src/features/pos/print/{doc,logo,escpos,printJob,ticket,receipt,zreport,printHost}.ts`, `tools/print-agent/*.ts`) use explicit `.ts` import extensions, no enums, no parameter properties (Node strips types, it does not compile).
- Old print payloads still print as before: the new payload fields (`TicketLine.takeaway`, `ReceiptPayload.paxChildren`) are optional in TypeScript and a payload without them renders exactly the old lines.
- Component tests mock every module that reaches Supabase (`./checkoutApi`, `../checkout/checkoutApi`, `./posApi`, `../qr/qrClient`, …): vitest loads `.env.local`, and an unmocked import builds a real client. The components this plan tests (`LineSheet`, `CartRow`, `ModifierSheet`, `PaxDialog`, `BillColumn`) import no such module; keep it that way.
- Commands: tests `npx vitest run <files>`; type check `npx tsc -b` (package.json has no separate typecheck script; `npm run build` = `tsc -b && vite build`); builds `npm run build` and `npm run build:pos`.
- Every commit message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push (Task 8 pushes).

The contract between tasks (column, function, key and TypeScript names) is in `.superpowers/sdd/w7-constraints.md` and in each task's **Interfaces** block.

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `supabase/migration-2026-11-22-pos-feedme-habits.sql` | 1–2 | Create. H1 last-order time, H2 takeaway line (1); H3 children, receipts, H4 Serve (2) |
| `supabase/migration-2026-11-22-pos-feedme-habits-verify.sql` | 1–2 | Create. Rolled back; FIXTURE, V1 window, V2 takeaway line (1); V3 children + receipts, V4 Serve (2) |
| `src/features/pos/sqlSafeUpdate.test.ts` | 1–2 | Modify. One `it` for the W7 migration (1), widened (2) |
| `src/features/pos/order/orderWindow.ts` (+ test) | 3 | Create. The window rule, the words, the settings check. Pure |
| `src/features/pos/order/cart.ts` | 3, 5 | Modify. `QrMenuJson` times (3); `OrderLine.takeaway` (5) |
| `src/features/pos/order/LineSheet.tsx` (+ test) | 3 | Modify. `Remark (optional)` field; `closed` |
| `src/qr/CartRow.tsx` (+ test) | 3 | Create. The cart line, moved out of QrApp, with `Remark: …` |
| `src/qr/QrApp.tsx` | 3 | Modify. Banner, Add / Place order off, CartRow import |
| `src/features/pos/checkout/checkoutApi.ts` | 4, 6, 7 | Modify. Times in settings (4); `setBillPax` / `openTable` children (6); `setItemsServed` (7) |
| `src/features/pos/checkout/settingsForm.ts` (+ test) | 4 | Modify. The window check |
| `src/features/pos/checkout/CheckoutSettings.tsx` | 4 | Modify. Two time fields and the help text |
| `src/features/pos/order/OrderScreen.tsx` | 4–7 | Modify. Banner (4); Takeaway switch (5); children (6); Serve (7) |
| `src/features/pos/order/modifiers.ts` (+ test), `ModifierSheet.tsx` (+ test) | 5 | Modify. `withTakeaway`, the switch |
| `src/features/pos/order/billView.ts` (+ test) | 5, 7 | Modify. ` (Takeaway)` and draft pricing (5); `served`, `unservedIds` (7) |
| `src/features/pos/print/ticket.ts` (+ test) | 5 | Modify. `TAKEAWAY` before the name |
| `src/features/pos/print/receipt.ts` (+ test) | 6 | Modify. `paxChildren`, `paxChildrenNote` |
| `src/features/pos/offline/orderQueue.ts` (+ test) | 6 | Modify. `paxChildren`, `p_pax_children` |
| `src/features/pos/order/posApi.ts` | 6, 7 | Modify. `pax_children` (6); `served_at` (7) |
| `src/features/pos/order/orderTarget.ts` (+ test) | 6 | Modify. `children`, `shownChildren` |
| `src/features/pos/shell/PaxDialog.tsx` (+ test) | 6 | Modify. The children stepper |
| `src/features/pos/order/BillColumn.tsx` (+ test) | 6, 7 | Modify. `3 pax (1 child)` (6); `✓` and muted served lines (7) |
| `src/features/pos/order/PosTill.tsx` | 6 | Modify. The empty table's pax picker |
| `src/features/pos/order/billActions.ts` (+ test), `ItemActionsOverlay.tsx`, `BillActionsOverlay.tsx` | 7 | Modify. Serve / Not served / Mark all served |
| `docs/pos/2026-10-29-feedme-replacement-readiness.md` | 8 | Modify. §2 W7 ticked, §4 rollout chain |

---

### Task 1: SQL — the last-order time and the takeaway line (H1, H2)

**Files:**
- Create: `supabase/migration-2026-11-22-pos-feedme-habits.sql`
- Create: `supabase/migration-2026-11-22-pos-feedme-habits-verify.sql`
- Modify: `src/features/pos/sqlSafeUpdate.test.ts` (a new `it` at the end of `describe('pg-safeupdate guard: POS migrations', …)`)

**Interfaces:**
- Consumes (live): `qr_cart_table`, `qr_cart_guest`, `qr_cart_lock`, `qr_cart_purge`, `qr_cart_version`, `qr_cart_labels`, `pos_order_catalog`, `menu_product_open`, `pos_next_bill_no`, `has_menu_cap`, `pos_manages_outlet`, `pos_bill_totals`, `place_counter_order` (7 args, until Task 2), `place_table_order`, `pos_start_session`, `set_my_pos_pin`.
- Produces (Task 2 and the client rely on these):
  - `branch_pos_settings.orders_open_at time`, `last_order_at time`; check `branch_pos_settings_order_window_check`.
  - `pos_orders_open(p_branch_id uuid, p_at timestamptz default now()) returns boolean`; `pos_orders_closed_message(p_branch_id uuid) returns text` — both internal.
  - `save_receipt_settings` keys `ordersOpenAt`, `lastOrderAt`; `qr_menu` keys `ordersOpenAt`, `lastOrderAt` ("HH:MM" or null).
  - Item JSON `"takeaway": true` → `order_items.order_type = 'takeaway'` + fee; ticket line `"takeaway": true` (new and void tickets).
  - Verify fixture keys (`pg_temp.id(k)`): `branch`, `w1`…`w5`, `latte`, `latte_v`, `cake`, `cake_v`, `owner`, `cashier`, `dev`, `D1` (the dine-in bill of V2: Latte + Latte takeaway on W1), `TA1` (its takeaway line), `T1` (a takeaway bill); helpers `pg_temp.expect_error`, `act`, `put`, `id`, `order_on`, `bill_of`.

- [ ] **Step 1: Write the failing test**

In `src/features/pos/sqlSafeUpdate.test.ts`, add this `it` as the last test inside `describe('pg-safeupdate guard: POS migrations', () => { … })` — right after the `it('scans the W4 migration: …')` block, before the `})` that closes the describe:

```ts
  it('scans the W7 migration: last-order time, takeaway lines, children and Serve; grants like their neighbours; a STOP guard', () => {
    const sql = readFileSync(new URL('migration-2026-11-22-pos-feedme-habits.sql', SUPABASE), 'utf8')
    const internal: [string, string][] = [
      ['pos_orders_open', 'uuid, timestamptz'], ['pos_orders_closed_message', 'uuid'], ['order_items_order_type', ''],
      ['pos_insert_order', 'uuid, uuid, text, integer, text, uuid, jsonb, uuid, uuid'], ['pos_queue_void_tickets', 'uuid[]'],
    ]
    const staff: [string, string][] = [['save_receipt_settings', 'uuid, jsonb']]
    const guests: [string, string][] = [
      ['qr_menu', 'text'], ['qr_cart_put', 'text, jsonb, jsonb, uuid'], ['qr_cart_send', 'text, integer, text, uuid[], uuid'],
    ]
    const bodies = functionBodies(sql)
    expect(bodies.map((b) => b.name).sort()).toEqual([...internal, ...staff, ...guests].map(([n]) => n).sort())
    for (const { name, body } of bodies) expect(body, name).not.toMatch(/auth\.uid\(\)/)
    for (const [f, args] of internal) {
      expect(sql).toContain(`revoke all on function ${f}(${args}) from public, anon, authenticated;`)
      expect(sql).not.toContain(`grant execute on function ${f}(`)
    }
    for (const [f, args] of staff) {
      expect(sql).toContain(`revoke all on function ${f}(${args}) from public, anon;`)
      expect(sql).toContain(`grant execute on function ${f}(${args}) to authenticated;`)
    }
    for (const [f, args] of guests) {
      expect(sql).toContain(`revoke all on function ${f}(${args}) from public;`)
      expect(sql).toContain(`grant execute on function ${f}(${args}) to anon, authenticated;`)
    }
    expect(sql).toMatch(/raise exception 'STOP: run migration-2026-11-22-pos-receipt-numbers\.sql and migration-2026-11-22-qr-table-cart\.sql first/)
    const body = (n: string) => bodies.find((b) => b.name === n)?.body ?? ''
    // the window refuses QR in the add and send RPCs, and in pos_insert_order (place_table_order goes through it)
    for (const f of ['qr_cart_put', 'qr_cart_send', 'pos_insert_order']) expect(body(f), f).toContain('pos_orders_open(')
    expect(body('pos_insert_order')).toContain('guest_label')                            // still the QR table cart's version
    expect(body('order_items_order_type')).toContain("if new.order_type = '' then return new; end if;")   // bodies have their strings emptied
    expect(sql).toMatch(/notify pgrst, 'reload schema';\s*select '[^']+' as result;\s*$/)
    const verify = readFileSync(new URL('migration-2026-11-22-pos-feedme-habits-verify.sql', SUPABASE), 'utf8')
    expect(verify).toMatch(/^begin;$/m)
    expect(verify).toMatch(/select 'VERIFY OK' as result;\s*rollback;\s*$/)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts`
Expected: FAIL in `scans the W7 migration: …` — `ENOENT … migration-2026-11-22-pos-feedme-habits.sql`.

- [ ] **Step 3: Write the migration header, the STOP guard and the H1 schema and helpers**

Create `supabase/migration-2026-11-22-pos-feedme-habits.sql` starting with exactly:

```sql
-- ============================================================================
-- Craft OS — POS smaller Feedme habits, W7 (2026-11-22). Run on craft-os-dev after
-- migration-2026-11-22-pos-receipt-numbers.sql and migration-2026-11-22-qr-table-cart.sql.
-- Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-11-22-pos-feedme-habits.md
-- Design: docs/superpowers/specs/2026-11-22-pos-feedme-habits-design.md
--
-- H1  Last-order time: branch_pos_settings.orders_open_at / last_order_at (Malaysia time; both or neither;
--     the window may cross midnight), saved by save_receipt_settings (ordersOpenAt, lastOrderAt);
--     pos_orders_open and pos_orders_closed_message; qr_menu carries the two times; qr_cart_put,
--     qr_cart_send and pos_insert_order (source 'qr' — which also covers place_table_order) refuse outside
--     the window with the sentence. The POS orders at any time.
-- H2  A takeaway line inside a dine-in bill: an item sent from the counter with "takeaway": true is stored
--     with order_type 'takeaway' and its product's packaging fee (pos_insert_order); order_items_order_type
--     keeps a line's own 'takeaway'; kitchen / bar tickets (new and void) mark it "takeaway": true; both
--     receipts name it "<name> (Takeaway)".
-- H3  Children in the pax: bills.pax_children (0 ≤ children ≤ pax); place_counter_order (p_pax_children),
--     pos_set_bill_pax and open_table (p_children) set it; both receipts carry paxChildren.
-- H4  Serve: order_items.served_at / served_by and set_items_served (no PIN; money unchanged; nothing prints).
-- Re-run hazards: re-running migration-2026-11-22-qr-table-cart.sql puts back pos_insert_order, qr_cart_put
-- and qr_cart_send without H1 / H2; migration-2026-10-24-pos-slots-photos-fn.sql qr_menu (and
-- pos_insert_order); migration-2026-11-22-pos-receipt-numbers.sql save_receipt_settings and both receipt
-- payloads; migration-2026-11-16-pos-split-bill.sql order_items_order_type;
-- migration-2026-10-24-pos-bill-actions-fn.sql pos_queue_void_tickets and a second open_table(uuid, integer);
-- migration-2026-10-26-pos-frontend.sql a second pos_set_bill_pax(uuid, integer);
-- migration-2026-10-29-pos-device-till.sql a second place_counter_order (seven arguments), which PostgREST
-- then cannot choose between — re-run this file after any of them.
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_open_drawer(uuid,text)') is null or to_regprocedure('qr_cart_send(text,integer,text,uuid[],uuid)') is null then
    raise exception 'STOP: run migration-2026-11-22-pos-receipt-numbers.sql and migration-2026-11-22-qr-table-cart.sql first (pos_open_drawer or qr_cart_send is missing)';
  end if;
end $$;

-- ── H1. Last-order time (spec §3) ───────────────────────────────────────────
alter table branch_pos_settings add column if not exists orders_open_at time;                    -- H1: Malaysia time
alter table branch_pos_settings add column if not exists last_order_at time;                     -- H1
alter table branch_pos_settings drop constraint if exists branch_pos_settings_order_window_check;
alter table branch_pos_settings add constraint branch_pos_settings_order_window_check
  check ((orders_open_at is null) = (last_order_at is null)
         and (orders_open_at is null or orders_open_at <> last_order_at));

-- Is ordering open at an outlet at p_at? No times (or no settings row) = always. The window runs from
-- the orders_open_at minute to the end of the last_order_at minute, Malaysia time, and crosses midnight
-- when it opens later than it closes (09:00–02:00). The client mirrors it (orderWindow.ts). Internal.
create or replace function pos_orders_open(p_branch_id uuid, p_at timestamptz default now()) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select case
           when s.orders_open_at is null or s.last_order_at is null then true
           when s.orders_open_at <= s.last_order_at then x.m between s.orders_open_at and s.last_order_at
           else x.m >= s.orders_open_at or x.m <= s.last_order_at
         end
    from (select date_trunc('minute', p_at at time zone 'Asia/Kuala_Lumpur')::time as m) x
    left join branch_pos_settings s on s.branch_id = p_branch_id
$$;
revoke all on function pos_orders_open(uuid, timestamptz) from public, anon, authenticated;

-- The sentence the QR page shows and the QR functions refuse with outside the window (spec §3):
-- "Last orders were at 21:30. Ordering opens again at 09:00." Null when the outlet has no window. Internal.
create or replace function pos_orders_closed_message(p_branch_id uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select 'Last orders were at ' || to_char(s.last_order_at, 'HH24:MI') || '. Ordering opens again at '
         || to_char(s.orders_open_at, 'HH24:MI') || '.'
    from branch_pos_settings s
   where s.branch_id = p_branch_id
$$;
revoke all on function pos_orders_closed_message(uuid) from public, anon, authenticated;
```

- [ ] **Step 4: Add save_receipt_settings (H1), copied from its live text**

Append to the migration this comment line:

```sql
-- save_receipt_settings: the live text of migration-2026-11-22-pos-receipt-numbers.sql (C2) with the lines
-- marked H1 added — ordersOpenAt / lastOrderAt: "HH:MM" or null, both or neither, not equal; either key
-- present saves both. A key that is absent leaves its column as it is.
```

Then copy lines 130–210 of `supabase/migration-2026-11-22-pos-receipt-numbers.sql` verbatim (from `create or replace function save_receipt_settings(p_branch_id uuid, p jsonb) returns void` to `grant execute on function save_receipt_settings(uuid, jsonb) to authenticated;`) and make exactly these three edits in the copy:

(a) After the line

```sql
  v_qr     text;                                                                             -- C2
```

insert:

```sql
  v_open   time;                                                                             -- H1
  v_last   time;                                                                             -- H1
```

(b) After the line

```sql
  if length(v_qr) > 300 then raise exception 'The QR text is too long (300 characters at most).'; end if; -- C2
```

insert:

```sql
  if p ? 'ordersOpenAt' or p ? 'lastOrderAt' then                                                        -- H1
    if (nullif(p->>'ordersOpenAt', '') is null) <> (nullif(p->>'lastOrderAt', '') is null) then          -- H1
      raise exception 'Set both times or neither.';                                                      -- H1
    end if;                                                                                              -- H1
    if nullif(p->>'ordersOpenAt', '') is not null then                                                   -- H1
      if p->>'ordersOpenAt' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'                                         -- H1
         or p->>'lastOrderAt' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then                                  -- H1
        raise exception 'Invalid settings';                                                              -- H1
      end if;                                                                                            -- H1
      v_open := (p->>'ordersOpenAt')::time;                                                              -- H1
      v_last := (p->>'lastOrderAt')::time;                                                               -- H1
      if v_open = v_last then                                                                            -- H1
        raise exception 'Orders open at and Last order at must be different times.';                    -- H1
      end if;                                                                                            -- H1
    end if;                                                                                              -- H1
  end if;                                                                                                -- H1
```

(c) After the line

```sql
                                       else receipt_hide_free_mods end,                                                         -- C2
```

insert:

```sql
         orders_open_at        = case when p ? 'ordersOpenAt' or p ? 'lastOrderAt' then v_open else orders_open_at end,      -- H1
         last_order_at         = case when p ? 'ordersOpenAt' or p ? 'lastOrderAt' then v_last else last_order_at end,       -- H1
```

- [ ] **Step 5: Add qr_menu, qr_cart_put and qr_cart_send (H1), copied from their live texts**

Append this comment line:

```sql
-- qr_menu: the live text of migration-2026-10-24-pos-slots-photos-fn.sql (M3) with the lines marked H1 added —
-- the outlet's two times, so the QR page can say when ordering stops.
```

Copy lines 648–710 of `supabase/migration-2026-10-24-pos-slots-photos-fn.sql` verbatim (from `create or replace function qr_menu(p_token text) returns jsonb` to `grant execute on function qr_menu(text) to anon, authenticated;`). In the copy, after the line

```sql
    'needsPax', not exists (select 1 from bills b where b.table_id = t.id and b.status = 'open' and b.pax is not null),
```

insert:

```sql
    'ordersOpenAt', (select to_char(s.orders_open_at, 'HH24:MI') from branch_pos_settings s where s.branch_id = t.branch_id),   -- H1
    'lastOrderAt', (select to_char(s.last_order_at, 'HH24:MI') from branch_pos_settings s where s.branch_id = t.branch_id),     -- H1
```

Append this comment line:

```sql
-- qr_cart_put and qr_cart_send: the live texts of migration-2026-11-22-qr-table-cart.sql with the lines marked
-- H1 added — outside the outlet's window a guest can neither add nor send (server time decides).
```

Copy lines 177–246 of `supabase/migration-2026-11-22-qr-table-cart.sql` verbatim (from `create or replace function qr_cart_put(p_token text, p_guest jsonb, p_line jsonb, p_line_id uuid) returns uuid` to `grant execute on function qr_cart_put(text, jsonb, jsonb, uuid) to anon, authenticated;`). In the copy, after the line

```sql
  v_table := qr_cart_table(p_token);
```

insert:

```sql
  if not pos_orders_open(v_table.branch_id) then                                         -- H1
    raise exception using message = pos_orders_closed_message(v_table.branch_id);        -- H1
  end if;                                                                                -- H1
```

Copy lines 281–341 of the same file verbatim (from `create or replace function qr_cart_send(p_token text, p_pax integer, p_version text, p_skip uuid[], p_client_order_id uuid)` to `grant execute on function qr_cart_send(text, integer, text, uuid[], uuid) to anon, authenticated;`). In the copy, after these three lines (they appear once in it):

```sql
  if v_table.qr_paused then
    raise exception 'Ordering is paused for this table. Please order at the counter.';
  end if;
```

insert:

```sql
  if not pos_orders_open(v_table.branch_id) then                                         -- H1
    raise exception using message = pos_orders_closed_message(v_table.branch_id);        -- H1
  end if;                                                                                -- H1
```

- [ ] **Step 6: Add the H2 trigger function and pos_insert_order (H1, H2)**

Append exactly:

```sql
-- ── H2. A takeaway line inside a dine-in bill (spec §4) ────────────────────
-- order_items_order_type: the live text of migration-2026-11-16-pos-split-bill.sql (S1) with the line marked
-- H2 added — a line inserted as 'takeaway' keeps it (a takeaway line on a dine-in bill); anything else takes
-- the bill's type, so a takeaway bill's lines stay takeaway. The trigger itself (migration-2026-10-25-pos-
-- hardening.sql) is unchanged.
create or replace function order_items_order_type() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.split_from_item is not null then return new; end if;                          -- S1
  if new.order_type = 'takeaway' then return new; end if;                              -- H2
  select b.order_type into new.order_type from bills b where b.id = new.bill_id;
  return new;
end $$;
revoke all on function order_items_order_type() from public, anon, authenticated;

-- pos_insert_order: the live text of migration-2026-11-22-qr-table-cart.sql (G) with the lines marked H1 / H2
-- changed — H1: a QR order outside the outlet's window is refused (qr_cart_send and place_table_order both
-- come here); H2: on a dine-in order from the counter, an item with "takeaway": true is a takeaway line —
-- order_type 'takeaway', its product's packaging fee, "takeaway": true on its ticket line.
```

Copy lines 344–596 of `supabase/migration-2026-11-22-qr-table-cart.sql` verbatim (from `create or replace function pos_insert_order(` to `revoke all on function pos_insert_order(uuid, uuid, text, integer, text, uuid, jsonb, uuid, uuid) from public, anon, authenticated;`) and make exactly these nine edits in the copy (each "find" text appears once in it):

(1) After

```sql
  v_unit       integer;                 -- M1
```

insert:

```sql
  v_ta         boolean;                 -- H2: a takeaway line on a dine-in order from the counter
```

(2) After

```sql
  if v_existing is not null then
    return v_existing;                         -- resend: already in
  end if;
```

insert:

```sql
  if p_source = 'qr' and not pos_orders_open(p_branch_id) then                           -- H1
    raise exception using message = pos_orders_closed_message(p_branch_id);             -- H1
  end if;                                                                                -- H1
```

(3) After

```sql
    select * into v_var  from menu_variants where id = (v_item->>'variantId')::uuid;
```

insert:

```sql
    v_ta := p_order_type = 'dine_in' and p_source <> 'qr' and coalesce(v_item->'takeaway' = 'true'::jsonb, false);   -- H2
```

(4) Replace

```sql
                            guest_id, guest_label, guest_avatar)                                    -- G
```

with

```sql
                            guest_id, guest_label, guest_avatar, order_type)                        -- G, H2
```

(5) Replace

```sql
            -- Sub-plan 3: the packaging fee is fixed when the item is ordered (takeaway bills only)
            case when p_order_type = 'takeaway' then v_prod.takeaway_fee_sen else 0 end,
```

with

```sql
            -- Sub-plan 3: the packaging fee is fixed when the item is ordered (takeaway bills and W7 takeaway lines)   -- H2
            case when p_order_type = 'takeaway' or v_ta then v_prod.takeaway_fee_sen else 0 end,                      -- H2
```

(6) Replace

```sql
            case when p_source = 'qr' and current_setting('craft.qr_cart_send', true) = 'on' and (v_item->>'guestAvatar') ~ '^a[1-8]$' then v_item->>'guestAvatar' end);  -- G
```

with

```sql
            case when p_source = 'qr' and current_setting('craft.qr_cart_send', true) = 'on' and (v_item->>'guestAvatar') ~ '^a[1-8]$' then v_item->>'guestAvatar' end,   -- G, H2
            case when v_ta then 'takeaway' end);                                                    -- H2: null = the bill's type (trigger)
```

(7) After

```sql
                              || case when l.guest is null then '{}'::jsonb else jsonb_build_object('guest', l.guest) end   -- G
```

insert:

```sql
                              || case when l.takeaway then jsonb_build_object('takeaway', true) else '{}'::jsonb end   -- H2
```

(8) Replace

```sql
             oi.guest_label as guest                                                             -- G
```

with

```sql
             oi.guest_label as guest,                                                            -- G, H2
             oi.order_type = 'takeaway' and p_order_type = 'dine_in' as takeaway                 -- H2
```

(9) Replace

```sql
      select m->>'route', 2, m->>'name', oi.qty, 'for ' || oi.name_snapshot, '[]'::jsonb, oi.guest_label   -- G
```

with

```sql
      select m->>'route', 2, m->>'name', oi.qty, 'for ' || oi.name_snapshot, '[]'::jsonb, oi.guest_label,   -- G, H2
             oi.order_type = 'takeaway' and p_order_type = 'dine_in'                                      -- H2
```

- [ ] **Step 7: Add pos_queue_void_tickets (H2) and the end of the file**

Append exactly:

```sql
-- pos_queue_void_tickets: the live text of migration-2026-10-24-pos-bill-actions-fn.sql with the lines marked
-- H2 changed — a voided takeaway line of a dine-in bill reads TAKEAWAY on the VOID ticket too.
create or replace function pos_queue_void_tickets(p_item_ids uuid[]) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into print_jobs(branch_id, order_id, route, kind, payload)
  select o.branch_id, o.id, l.route, 'ticket', jsonb_build_object(
           'kind', 'ticket', 'route', l.route, 'tableLabel', t.label, 'orderNo', o.order_no,
           'source', o.source,
           'placedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'void', true,
           'lines', jsonb_agg(jsonb_build_object('qty', l.qty, 'name', l.name, 'note', l.note, 'mods', l.mods)
                              || case when l.takeaway and b.order_type = 'dine_in'                                  -- H2
                                      then jsonb_build_object('takeaway', true) else '{}'::jsonb end                -- H2
                              order by l.kind_order, l.name))
    from (
      select oi.order_id, oi.print_route as route, 1 as kind_order, oi.name_snapshot as name, oi.qty, oi.note,
             coalesce((select jsonb_agg(m->>'name' order by ord)
                         from jsonb_array_elements(oi.modifiers_snapshot) with ordinality as x(m, ord)), '[]'::jsonb) as mods,   -- H2
             oi.order_type = 'takeaway' as takeaway                                                                 -- H2
        from order_items oi
       where oi.id = any (p_item_ids) and oi.print_route is not null
      union all
      select oi.order_id, m->>'route', 2, m->>'name', oi.qty, 'for ' || oi.name_snapshot, '[]'::jsonb,              -- H2
             oi.order_type = 'takeaway'                                                                             -- H2
        from order_items oi cross join jsonb_array_elements(oi.modifiers_snapshot) m
       where oi.id = any (p_item_ids) and m->>'route' is not null
         and m->>'route' is distinct from oi.print_route
    ) l
    join orders o on o.id = l.order_id
    join bills b on b.id = o.bill_id
    left join dining_tables t on t.id = b.table_id
   group by o.id, o.branch_id, o.order_no, o.source, t.label, l.route
$$;
revoke all on function pos_queue_void_tickets(uuid[]) from public, anon, authenticated;

-- PostgREST picks up the new and changed functions now, not at its next poll
notify pgrst, 'reload schema';
select 'pos feedme habits applied' as result;
```

- [ ] **Step 8: Self-check the migration by reading**

Check against the live texts, line by line, that nothing but the `-- H1` / `-- H2` lines differ:
- `save_receipt_settings` vs `supabase/migration-2026-11-22-pos-receipt-numbers.sql` lines 130–210.
- `qr_menu` vs `supabase/migration-2026-10-24-pos-slots-photos-fn.sql` lines 648–710.
- `qr_cart_put`, `qr_cart_send`, `pos_insert_order` vs `supabase/migration-2026-11-22-qr-table-cart.sql` lines 177–246, 281–341, 344–596.
- `order_items_order_type` vs `supabase/migration-2026-11-16-pos-split-bill.sql` lines 64–71; `pos_queue_void_tickets` vs `supabase/migration-2026-10-24-pos-bill-actions-fn.sql` lines 135–162.

Then confirm by reading: (a) in `pos_insert_order` the `insert into order_items(...)` names 16 columns and its `values (...)` gives 16 expressions; (b) both branches of the ticket `union all` and of the void-ticket `union all` give the same number of columns (8 and 9); (c) `pos_orders_open` returns one row also for an outlet with no settings row (the `left join` from the one-row `x`); (d) `raise exception using message = …` is only reached when a window exists, so the message is never null.

- [ ] **Step 9: Write the verify (helpers, FIXTURE, V1, V2, the end)**

Create `supabase/migration-2026-11-22-pos-feedme-habits-verify.sql` with exactly:

```sql
-- Self-check for the POS smaller Feedme habits (W7). Run on craft-os-dev after
-- migration-2026-11-22-pos-feedme-habits.sql. Everything is rolled back. Success = a result row "VERIFY OK".
-- Sections (one DO block each, ids in the temp table fixture): FIXTURE; V1 last-order time; V2 takeaway line;
-- V3 children and the receipts; V4 Serve.
-- Outlet VERIFY W7: tables W1–W5, a 10% dine-in service charge, receipt route Bar. Latte 10.00 (6%, packaging
-- 1.00) and Cake 8.00 (8%, packaging 0.50), both printed on Bar; one dine-in / takeaway / QR catalog. A cashier
-- with a PIN signed in on one tablet; the dev owner login for the settings.
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
-- one counter order: p_table null = takeaway; 'latte:2' orders 2 on one line, 'latte:1:ta' a takeaway line;
-- returns the order id
create function pg_temp.order_on(p_table text, p_pax integer, p_keys text[]) returns uuid
language sql as $$
  select place_counter_order(
           pg_temp.id(p_table), case when p_table is null then 'takeaway' else 'dine_in' end, p_pax,
           (select jsonb_agg(jsonb_build_object('productId', pg_temp.id(split_part(k, ':', 1)),
                                                'variantId', pg_temp.id(split_part(k, ':', 1) || '_v'),
                                                'qty', coalesce(nullif(split_part(k, ':', 2), ''), '1')::integer)
                             || case when split_part(k, ':', 3) = 'ta' then '{"takeaway": true}'::jsonb else '{}'::jsonb end
                             order by o)
              from unnest(p_keys) with ordinality as x(k, o)),
           gen_random_uuid())
$$;
create function pg_temp.bill_of(p_order uuid) returns uuid
language sql as $$ select bill_id from orders where id = p_order $$;

-- ── FIXTURE: outlet VERIFY W7, tables W1–W5, two products on the Bar route, a 10% dine-in service charge,
--    a cashier with a PIN signed in on one tablet ──
do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_cash  uuid := 'eeeeeeee-0000-0000-0000-0000000007c1';
  v_dev   uuid := 'eeeeeeee-0000-0000-0000-0000000007c3';
  v_a uuid; v_t uuid; v_cat uuid; v_catalog uuid; v_p uuid; v_v uuid; v_res jsonb; r record; i integer;
begin
  -- the role defaults decide (owner: every outlet and access_settings)
  update system_role_permissions set permissions = permissions - 'pos_login' - 'all_branches' - 'access_settings' - 'pos_supervise'
   where true;
  insert into branches(name, address) values ('VERIFY W7', 'w') returning id into v_a;
  perform pg_temp.put('branch', v_a);
  for i in 1..5 loop
    insert into dining_tables(branch_id, label, sort_order) values (v_a, 'W' || i, i) returning id into v_t;
    perform pg_temp.put('w' || i, v_t);
  end loop;
  insert into print_routes(branch_id, name, kind, address) values (v_a, 'Bar', 'agent', '127.0.0.1:9100');
  insert into branch_pos_settings(branch_id, receipt_route) values (v_a, 'Bar');
  insert into service_charge_rules(branch_id, rate_bp, order_types) values (v_a, 1000, array['dine_in']);
  insert into menu_categories(name, sort_order) values ('VERIFY W7 DRINKS', 917) returning id into v_cat;
  insert into menu_catalogs(name, sort_order) values ('VERIFY W7 MENU', 917) returning id into v_catalog;
  for r in select * from (values ('latte', 'Verify W7 Latte', 1000, 600, 100), ('cake', 'Verify W7 Cake', 800, 800, 50))
                    as x(k, name, sen, bp, fee) loop
    insert into menu_products(name, category_id, sst_rate_bp, print_route, takeaway_fee_sen)
    values (r.name, v_cat, r.bp, 'Bar', r.fee) returning id into v_p;
    insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_p, '', 'Regular', r.sen) returning id into v_v;
    insert into catalog_products(catalog_id, product_id, availability) values (v_catalog, v_p, 'all');
    insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (v_catalog, v_v, r.sen);
    perform pg_temp.put(r.k, v_p); perform pg_temp.put(r.k || '_v', v_v);
  end loop;
  insert into branch_catalogs(branch_id, role, catalog_id) values (v_a, 'dine_in', v_catalog), (v_a, 'takeaway', v_catalog), (v_a, 'qr', v_catalog);
  update staff set branch_id = v_a where id = v_owner;
  perform pg_temp.act(v_owner);
  insert into auth.users (id) values (v_cash), (v_dev);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_cash, 'Verify W7 Cashier', 'trainee', true, current_date, 'staff', v_a);
  perform pg_temp.act(v_cash);
  if not coalesce((set_my_pos_pin('1111', null)->>'ok')::boolean, false) then raise exception 'FAIL fixture: PIN of the cashier'; end if;
  insert into pos_devices(id, branch_id, kind, name, platform, prints, approved_by) values (v_dev, v_a, 'pos', 'W7 Counter', 'ipad', true, v_owner);
  perform pg_temp.put('owner', v_owner); perform pg_temp.put('cashier', v_cash); perform pg_temp.put('dev', v_dev);
  perform pg_temp.act(v_dev);
  v_res := pos_start_session(v_cash, '1111');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: cashier sign-in: %', v_res; end if;
end $$;

-- ── V1. Last-order time (spec §3): the rule (also across midnight), the sentence, qr_menu, the settings
--    checks, QR add / send / place_table_order refused outside, the POS orders outside, the remark lands ──
do $$
declare
  v_a     uuid := pg_temp.id('branch');
  v_tok   text := (select qr_token from dining_tables where id = pg_temp.id('w3'));
  v_line  jsonb := jsonb_build_object('productId', pg_temp.id('latte'), 'variantId', pg_temp.id('latte_v'), 'qty', 1,
                                      'note', 'less sweet', 'optionIds', '[]'::jsonb, 'takeaway', true);
  g       constant jsonb := '{"id":"aaaaaaaa-0000-4000-8000-0000000007a1","name":"Mei","avatar":"a2"}';
  v_now   time := date_trunc('minute', now() at time zone 'Asia/Kuala_Lumpur')::time;
  v_msg   text;
  v_s     branch_pos_settings;
  v_order uuid;
  v_bill  uuid;
  r       record;
begin
  -- no times: always open
  if not pos_orders_open(v_a, '2026-01-05 03:00+08') then raise exception 'FAIL V1 no window but closed'; end if;
  -- 09:00–21:30: the 09:00 minute to the end of the 21:30 minute
  update branch_pos_settings set orders_open_at = '09:00', last_order_at = '21:30' where branch_id = v_a;
  for r in select * from (values ('2026-01-05 08:59:59+08', false), ('2026-01-05 09:00+08', true),
                                 ('2026-01-05 21:30:59+08', true), ('2026-01-05 21:31+08', false)) as x(at, want) loop
    if pos_orders_open(v_a, r.at::timestamptz) is distinct from r.want then
      raise exception 'FAIL V1 09:00–21:30 at %: % (expected %)', r.at, pos_orders_open(v_a, r.at::timestamptz), r.want;
    end if;
  end loop;
  if pos_orders_closed_message(v_a) is distinct from 'Last orders were at 21:30. Ordering opens again at 09:00.' then
    raise exception 'FAIL V1 the sentence: %', pos_orders_closed_message(v_a);
  end if;
  -- 09:00–02:00 crosses midnight
  update branch_pos_settings set orders_open_at = '09:00', last_order_at = '02:00' where branch_id = v_a;
  for r in select * from (values ('2026-01-05 23:30+08', true), ('2026-01-06 01:59+08', true), ('2026-01-06 02:00:30+08', true),
                                 ('2026-01-06 02:01+08', false), ('2026-01-06 08:59+08', false), ('2026-01-06 09:00+08', true)) as x(at, want) loop
    if pos_orders_open(v_a, r.at::timestamptz) is distinct from r.want then
      raise exception 'FAIL V1 09:00–02:00 at %: % (expected %)', r.at, pos_orders_open(v_a, r.at::timestamptz), r.want;
    end if;
  end loop;
  if pos_orders_closed_message(v_a) is distinct from 'Last orders were at 02:00. Ordering opens again at 09:00.' then
    raise exception 'FAIL V1 the sentence across midnight: %', pos_orders_closed_message(v_a);
  end if;
  -- qr_menu tells the page
  if (qr_menu(v_tok)->>'ordersOpenAt') is distinct from '09:00' or (qr_menu(v_tok)->>'lastOrderAt') is distinct from '02:00' then
    raise exception 'FAIL V1 qr_menu: % / %', qr_menu(v_tok)->>'ordersOpenAt', qr_menu(v_tok)->>'lastOrderAt';
  end if;

  -- the settings: both or neither, not equal, HH:MM; absent keys keep; nulls clear; the table check
  perform pg_temp.act(pg_temp.id('owner'));
  perform pg_temp.expect_error(format('select save_receipt_settings(%L, %L::jsonb)', v_a,
    '{"receiptTitle":"Verify W7","ordersOpenAt":"09:00"}'), 'Set both times or neither.', 'V1 one key');
  perform pg_temp.expect_error(format('select save_receipt_settings(%L, %L::jsonb)', v_a,
    '{"receiptTitle":"Verify W7","ordersOpenAt":"09:00","lastOrderAt":null}'), 'Set both times or neither.', 'V1 one time');
  perform pg_temp.expect_error(format('select save_receipt_settings(%L, %L::jsonb)', v_a,
    '{"receiptTitle":"Verify W7","ordersOpenAt":"10:00","lastOrderAt":"10:00"}'),
    'Orders open at and Last order at must be different times.', 'V1 equal times');
  perform pg_temp.expect_error(format('select save_receipt_settings(%L, %L::jsonb)', v_a,
    '{"receiptTitle":"Verify W7","ordersOpenAt":"9am","lastOrderAt":"21:30"}'), 'Invalid settings', 'V1 not HH:MM');
  perform save_receipt_settings(v_a, '{"receiptTitle":"Verify W7","ordersOpenAt":"10:15","lastOrderAt":"22:45"}');
  select * into v_s from branch_pos_settings where branch_id = v_a;
  if v_s.orders_open_at is distinct from '10:15'::time or v_s.last_order_at is distinct from '22:45'::time then
    raise exception 'FAIL V1 saved: % – %', v_s.orders_open_at, v_s.last_order_at;
  end if;
  perform save_receipt_settings(v_a, '{"receiptTitle":"Verify W7"}');
  if (select orders_open_at from branch_pos_settings where branch_id = v_a) is distinct from '10:15'::time then
    raise exception 'FAIL V1 absent keys changed the times';
  end if;
  perform save_receipt_settings(v_a, '{"receiptTitle":"Verify W7","ordersOpenAt":null,"lastOrderAt":null}');
  if (select orders_open_at is not null or last_order_at is not null from branch_pos_settings where branch_id = v_a) then
    raise exception 'FAIL V1 nulls did not clear the times';
  end if;
  perform pg_temp.expect_error(format('update branch_pos_settings set orders_open_at = %L where branch_id = %L', '09:00', v_a),
    'new row for relation "branch_pos_settings" violates check constraint "branch_pos_settings_order_window_check"', 'V1 the table check');

  -- inside the window (an hour before now to an hour after): a guest adds a line — with a remark, and a
  -- takeaway flag a guest cannot set
  update branch_pos_settings set orders_open_at = v_now - interval '1 hour', last_order_at = v_now + interval '1 hour'
   where branch_id = v_a;
  perform qr_cart_put(v_tok, g, v_line, null);
  -- outside (opens in 2 hours, last order in 3): add, send and the one-phone order are refused with the sentence
  update branch_pos_settings set orders_open_at = v_now + interval '2 hours', last_order_at = v_now + interval '3 hours'
   where branch_id = v_a;
  v_msg := pos_orders_closed_message(v_a);
  perform pg_temp.expect_error(format('select qr_cart_put(%L, %L::jsonb, %L::jsonb, null)', v_tok, g, v_line), v_msg, 'V1 QR add outside');
  perform pg_temp.expect_error(format('select qr_cart_send(%L, 2, %L, null, %L)', v_tok, qr_cart_state(v_tok)->>'version', gen_random_uuid()),
    v_msg, 'V1 QR send outside');
  perform pg_temp.expect_error(format('select place_table_order(%L, 2, %L::jsonb, %L)', v_tok, jsonb_build_array(v_line - 'note'), gen_random_uuid()),
    v_msg, 'V1 place_table_order outside');
  -- outside across midnight (opened an hour from now, last order an hour ago): still refused
  update branch_pos_settings set orders_open_at = v_now + interval '1 hour', last_order_at = v_now - interval '1 hour'
   where branch_id = v_a;
  perform pg_temp.expect_error(format('select qr_cart_send(%L, 2, %L, null, %L)', v_tok, qr_cart_state(v_tok)->>'version', gen_random_uuid()),
    pos_orders_closed_message(v_a), 'V1 QR send outside, across midnight');
  -- the POS orders outside the window
  perform pg_temp.act(pg_temp.id('dev'));
  v_order := pg_temp.order_on('w4', 2, array['latte']);
  if v_order is null then raise exception 'FAIL V1 the POS could not order outside the window'; end if;
  -- inside again: the cart goes in; the remark is the item's note; the guest's takeaway flag is ignored
  update branch_pos_settings set orders_open_at = v_now - interval '1 hour', last_order_at = v_now + interval '1 hour'
   where branch_id = v_a;
  perform qr_cart_send(v_tok, 2, qr_cart_state(v_tok)->>'version', null, gen_random_uuid());
  select id into v_bill from bills where table_id = pg_temp.id('w3') and status = 'open';
  if (select note from order_items where bill_id = v_bill) is distinct from 'less sweet' then
    raise exception 'FAIL V1 the remark: %', (select note from order_items where bill_id = v_bill);
  end if;
  if (select order_type from order_items where bill_id = v_bill) is distinct from 'dine_in'
     or (select takeaway_fee_sen from order_items where bill_id = v_bill) <> 0 then
    raise exception 'FAIL V1 a QR guest set a takeaway line';
  end if;
  update branch_pos_settings set orders_open_at = null, last_order_at = null where branch_id = v_a;
end $$;

-- ── V2. A takeaway line inside a dine-in bill (spec §4): fee, no service charge on it, ticket and void
--    ticket marked, the trigger keeps it; a takeaway bill unchanged ──
do $$
declare
  v_order uuid;
  v_d     uuid;
  v_ta    uuid;
  v_dine  uuid;
  v_tot   jsonb;
  v_job   jsonb;
  v_copy  uuid;
  v_type  text;
  v_tb    uuid;
begin
  perform pg_temp.act(pg_temp.id('dev'));
  v_order := pg_temp.order_on('w1', 2, array['latte', 'latte:1:ta']);
  v_d := pg_temp.bill_of(v_order);
  perform pg_temp.put('D1', v_d);
  select id into v_ta from order_items where order_id = v_order and order_type = 'takeaway';
  select id into v_dine from order_items where order_id = v_order and order_type = 'dine_in';
  if v_ta is null or v_dine is null then
    raise exception 'FAIL V2 one takeaway and one dine-in line: %',
      (select jsonb_agg(jsonb_build_object('type', order_type, 'fee', takeaway_fee_sen)) from order_items where order_id = v_order);
  end if;
  perform pg_temp.put('TA1', v_ta);
  if (select takeaway_fee_sen from order_items where id = v_ta) <> 100 or (select takeaway_fee_sen from order_items where id = v_dine) <> 0 then
    raise exception 'FAIL V2 the fee: takeaway % / dine-in %',
      (select takeaway_fee_sen from order_items where id = v_ta), (select takeaway_fee_sen from order_items where id = v_dine);
  end if;
  -- the totals: the packaging fee once, the 10% service charge on the dine-in line only
  v_tot := pos_bill_totals(v_d);
  if (v_tot->>'takeawayFeeSen')::integer <> 100 or (v_tot->>'serviceChargeSen')::integer <> 100 then
    raise exception 'FAIL V2 totals: fee % and service charge % (expected 100 and 100)', v_tot->>'takeawayFeeSen', v_tot->>'serviceChargeSen';
  end if;
  -- the ticket marks the takeaway line, and only it
  select payload into v_job from print_jobs where kind = 'ticket' and order_id = v_order and not payload ? 'void';
  if (select count(*) from jsonb_array_elements(v_job->'lines') l where l->'takeaway' = 'true'::jsonb) <> 1
     or (select count(*) from jsonb_array_elements(v_job->'lines') l where not l ? 'takeaway') <> 1 then
    raise exception 'FAIL V2 the ticket: %', v_job;
  end if;
  -- a void ticket marks it too
  perform pos_queue_void_tickets(array[v_ta]);
  if not exists (select 1 from print_jobs where kind = 'ticket' and order_id = v_order and payload ? 'void'
                  and payload->'lines'->0->'takeaway' = 'true'::jsonb) then
    raise exception 'FAIL V2 the void ticket: %', (select payload from print_jobs where kind = 'ticket' and order_id = v_order and payload ? 'void');
  end if;
  -- the trigger: a line inserted as takeaway on a dine-in bill stays takeaway
  insert into order_items(order_id, bill_id, product_id, variant_id, name_snapshot, unit_price_sen, sst_rate_bp, modifiers_snapshot, qty, order_type)
  select order_id, bill_id, product_id, variant_id, name_snapshot, unit_price_sen, sst_rate_bp, modifiers_snapshot, qty, 'takeaway'
    from order_items where id = v_dine
  returning id, order_type into v_copy, v_type;
  if v_type is distinct from 'takeaway' then raise exception 'FAIL V2 the trigger overwrote a takeaway line: %', v_type; end if;
  delete from order_items where id = v_copy;
  -- a takeaway bill: every line takeaway with its fee (the flag changes nothing), no takeaway key on its ticket
  v_tb := pg_temp.bill_of(pg_temp.order_on(null, null, array['cake:1:ta', 'latte']));
  perform pg_temp.put('T1', v_tb);
  if exists (select 1 from order_items where bill_id = v_tb and (order_type <> 'takeaway' or takeaway_fee_sen = 0)) then
    raise exception 'FAIL V2 the takeaway bill''s lines: %',
      (select jsonb_agg(jsonb_build_object('type', order_type, 'fee', takeaway_fee_sen)) from order_items where bill_id = v_tb);
  end if;
  if exists (select 1 from print_jobs j cross join jsonb_array_elements(j.payload->'lines') l
              where j.kind = 'ticket' and j.order_id = (select id from orders where bill_id = v_tb) and l ? 'takeaway') then
    raise exception 'FAIL V2 a takeaway bill''s ticket marks its lines';
  end if;
  -- and a line inserted as dine-in on a takeaway bill becomes takeaway
  insert into order_items(order_id, bill_id, product_id, variant_id, name_snapshot, unit_price_sen, sst_rate_bp, modifiers_snapshot, qty, order_type)
  select order_id, bill_id, product_id, variant_id, name_snapshot, unit_price_sen, sst_rate_bp, modifiers_snapshot, qty, 'dine_in'
    from order_items where bill_id = v_tb limit 1
  returning id, order_type into v_copy, v_type;
  if v_type is distinct from 'takeaway' then raise exception 'FAIL V2 a takeaway bill''s line is %', v_type; end if;
  delete from order_items where id = v_copy;
end $$;

select 'VERIFY OK' as result;
rollback;
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts`
Expected: PASS (every test, including `migration-2026-11-22-pos-feedme-habits.sql: every DELETE / UPDATE inside a function has a WHERE` and `scans the W7 migration: …`).

- [ ] **Step 11: Commit**

```bash
git add supabase/migration-2026-11-22-pos-feedme-habits.sql supabase/migration-2026-11-22-pos-feedme-habits-verify.sql src/features/pos/sqlSafeUpdate.test.ts
git commit -m "$(cat <<'EOF'
feat(pos): W7 SQL — last-order time (QR refused outside, POS not) and a takeaway line inside a dine-in bill

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---
### Task 2: SQL — children in the pax, the receipts and Serve (H3, H2 / H3 receipts, H4)

**Files:**
- Modify: `supabase/migration-2026-11-22-pos-feedme-habits.sql` (insert before its last three lines)
- Modify: `supabase/migration-2026-11-22-pos-feedme-habits-verify.sql` (insert before `select 'VERIFY OK' as result;`)
- Modify: `src/features/pos/sqlSafeUpdate.test.ts` (the W7 `it` of Task 1)

**Interfaces:**
- Consumes (Task 1): the file, its fixture keys (`branch`, `w2`, `w3`, `w5`, `cake`, `cake_v`, `dev`, `cashier`, `D1`, `TA1`, `T1`) and helpers; `order_items.order_type` of a takeaway line on a dine-in bill. Live: `pos_ctx()`, `pos_my_branch()`, `pos_insert_order`, `pos_next_bill_no`, `pos_bill_totals`.
- Produces (the client relies on these):
  - `bills.pax_children integer`; check `bills_pax_children_check` (`pax_children is null or (pax is not null and pax_children between 0 and pax)`).
  - `place_counter_order(p_table_id uuid, p_order_type text, p_pax integer, p_items jsonb, p_client_order_id uuid, p_catalog_id uuid default null, p_staff_id uuid default null, p_pax_children integer default null) returns uuid`.
  - `pos_set_bill_pax(p_bill_id uuid, p_pax integer, p_children integer default null) returns void`; `open_table(p_table_id uuid, p_pax integer, p_children integer default null) returns uuid`. Refusal `Invalid number of children`.
  - Receipt and part receipt payloads: `paxChildren` (number or null); `items[].name` ends with ` (Takeaway)` for a takeaway line of a dine-in bill.
  - `order_items.served_at timestamptz`, `served_by uuid`; `set_items_served(p_item_ids uuid[], p_served boolean) returns integer`; refusals `Choose the items first.`, `Item not found`, `The items must be on one bill.`, `This bill is no longer open.`

- [ ] **Step 1: Write the failing test**

In `src/features/pos/sqlSafeUpdate.test.ts`, inside `it('scans the W7 migration: …')`, replace:

```ts
    const internal: [string, string][] = [
      ['pos_orders_open', 'uuid, timestamptz'], ['pos_orders_closed_message', 'uuid'], ['order_items_order_type', ''],
      ['pos_insert_order', 'uuid, uuid, text, integer, text, uuid, jsonb, uuid, uuid'], ['pos_queue_void_tickets', 'uuid[]'],
    ]
    const staff: [string, string][] = [['save_receipt_settings', 'uuid, jsonb']]
```

with:

```ts
    const internal: [string, string][] = [
      ['pos_orders_open', 'uuid, timestamptz'], ['pos_orders_closed_message', 'uuid'], ['order_items_order_type', ''],
      ['pos_insert_order', 'uuid, uuid, text, integer, text, uuid, jsonb, uuid, uuid'], ['pos_queue_void_tickets', 'uuid[]'],
      ['pos_receipt_payload', 'uuid, boolean'], ['pos_part_receipt_payload', 'uuid'],
    ]
    const staff: [string, string][] = [
      ['save_receipt_settings', 'uuid, jsonb'], ['place_counter_order', 'uuid, text, integer, jsonb, uuid, uuid, uuid, integer'],
      ['pos_set_bill_pax', 'uuid, integer, integer'], ['open_table', 'uuid, integer, integer'], ['set_items_served', 'uuid[], boolean'],
    ]
```

and after the line

```ts
    expect(body('order_items_order_type')).toContain("if new.order_type = '' then return new; end if;")   // bodies have their strings emptied
```

add:

```ts
    // H3: the old signatures go first, so PostgREST has one candidate each
    for (const d of ['place_counter_order(uuid, text, integer, jsonb, uuid, uuid, uuid)', 'pos_set_bill_pax(uuid, integer)', 'open_table(uuid, integer)']) {
      expect(sql).toContain(`drop function if exists ${d};`)
    }
    expect(sql).toContain('alter table bills add column if not exists pax_children integer;')
    expect(sql).toContain('alter table order_items add column if not exists served_at timestamptz;')
    expect(body('set_items_served')).toContain('pos_ctx()')
    // least() skips a null: every clamp of p_children sits inside a case that handles null first
    expect(sql).not.toMatch(/least\(p_children, p_pax\)(?! end)/)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts`
Expected: FAIL in `scans the W7 migration: …` — the function names differ (`place_counter_order`, `pos_set_bill_pax`, `open_table`, `set_items_served`, `pos_receipt_payload`, `pos_part_receipt_payload` missing).

- [ ] **Step 3: Add H3 (the column, place_counter_order, pos_set_bill_pax, open_table)**

In `supabase/migration-2026-11-22-pos-feedme-habits.sql`, insert before the line `-- PostgREST picks up the new and changed functions now, not at its next poll` exactly:

```sql
-- ── H3. Children in the pax (spec §5) ───────────────────────────────────────
alter table bills add column if not exists pax_children integer;                                 -- H3: null = not given
alter table bills drop constraint if exists bills_pax_children_check;
alter table bills add constraint bills_pax_children_check
  check (pax_children is null or (pax is not null and pax_children between 0 and pax));

-- place_counter_order: the live text of migration-2026-10-29-pos-device-till.sql (T5) with the lines marked H3
-- changed — p_pax_children: the children of the pax chosen for an empty table, set with its first order
-- (clamped to the pax; a bill that already has them keeps them, so a resend changes nothing). The
-- seven-argument version is dropped first: PostgREST cannot choose between two candidates.
drop function if exists place_counter_order(uuid, text, integer, jsonb, uuid, uuid, uuid);                -- H3
create or replace function place_counter_order(p_table_id uuid, p_order_type text, p_pax integer, p_items jsonb,
                                               p_client_order_id uuid, p_catalog_id uuid default null,
                                               p_staff_id uuid default null,
                                               p_pax_children integer default null) returns uuid          -- H3
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ctx record;
  v_by  uuid;
  v_order uuid;                                                                                   -- H3
begin
  if p_pax_children is not null and (p_pax_children < 0 or p_pax_children > 99) then            -- H3
    raise exception 'Invalid number of children';                                                 -- H3
  end if;                                                                                         -- H3
  select * into v_ctx from pos_ctx();
  -- an order sent from this tablet's offline queue is placed by whoever queued it: someone who has
  -- signed in on this tablet and may still work here; anyone else, or a staff login, is ignored
  v_by := case when p_staff_id is not null and v_ctx.device_id is not null
                    and exists (select 1 from pos_staff_sessions s where s.device_id = v_ctx.device_id and s.staff_id = p_staff_id)
                    and pos_staff_may_work(p_staff_id, v_ctx.branch_id) then p_staff_id
               else v_ctx.staff_id end;
  v_order := pos_insert_order(v_ctx.branch_id, p_table_id, p_order_type, p_pax, 'counter', v_by, p_items,   -- H3
                              p_client_order_id, p_catalog_id);                                              -- H3
  if p_pax_children is not null then                                                                         -- H3
    update bills b set pax_children = least(p_pax_children, b.pax), updated_at = now()                      -- H3
     where b.id = (select o.bill_id from orders o where o.id = v_order)                                      -- H3
       and b.status = 'open' and b.pax is not null and b.pax_children is null;                               -- H3
  end if;                                                                                                    -- H3
  return v_order;                                                                                            -- H3
end $$;
revoke all on function place_counter_order(uuid, text, integer, jsonb, uuid, uuid, uuid, integer) from public, anon;   -- H3
grant execute on function place_counter_order(uuid, text, integer, jsonb, uuid, uuid, uuid, integer) to authenticated;  -- H3

-- pos_set_bill_pax: the live text of migration-2026-10-26-pos-frontend.sql (F3) with the lines marked H3 changed
-- — p_children: of which children (null = not given; above the pax = the pax). The two-argument version is
-- dropped first; a two-argument call (an older till) now clears the children.
drop function if exists pos_set_bill_pax(uuid, integer);                                                   -- H3
create or replace function pos_set_bill_pax(p_bill_id uuid, p_pax integer, p_children integer default null) returns void   -- H3
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
begin
  if p_pax is null or p_pax < 1 or p_pax > 99 then raise exception 'Invalid number of guests'; end if;
  if p_children is not null and (p_children < 0 or p_children > 99) then raise exception 'Invalid number of children'; end if;   -- H3
  update bills set pax = p_pax,                                                                              -- H3
                   pax_children = case when p_children is null then null else least(p_children, p_pax) end,   -- H3
                   updated_at = now()                                                                         -- H3
   where id = p_bill_id and branch_id = v_branch and status = 'open' and order_type = 'dine_in';
  if not found then raise exception 'Bill not found'; end if;
end $$;
revoke all on function pos_set_bill_pax(uuid, integer, integer) from public, anon;                          -- H3
grant execute on function pos_set_bill_pax(uuid, integer, integer) to authenticated;                        -- H3

-- open_table: the live text of migration-2026-10-24-pos-bill-actions-fn.sql with the lines marked H3 changed —
-- p_children with the pax (Open for QR). The two-argument version is dropped first.
drop function if exists open_table(uuid, integer);                                                          -- H3
create or replace function open_table(p_table_id uuid, p_pax integer, p_children integer default null) returns uuid   -- H3
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch  uuid := pos_my_branch();
  v_bill_id uuid;
  v_kids    integer := case when p_pax is null or p_children is null then null else least(p_children, p_pax) end;   -- H3
begin
  if p_pax is not null and (p_pax < 1 or p_pax > 99) then raise exception 'Invalid number of guests'; end if;
  if p_children is not null and (p_children < 0 or p_children > 99) then raise exception 'Invalid number of children'; end if;   -- H3
  if not exists (select 1 from dining_tables where id = p_table_id and branch_id = v_branch and is_active) then
    raise exception 'Invalid table';
  end if;
  select id into v_bill_id from bills where table_id = p_table_id and status = 'open';
  if v_bill_id is null then
    insert into bills(branch_id, bill_no, table_id, order_type, pax, pax_children)                          -- H3
    values (v_branch, pos_next_bill_no(v_branch), p_table_id, 'dine_in', p_pax, v_kids)                     -- H3
    on conflict (table_id) where status = 'open' and table_id is not null do nothing
    returning id into v_bill_id;
    if v_bill_id is null then                       -- lost the race: the table was just opened
      select id into v_bill_id from bills where table_id = p_table_id and status = 'open';
    end if;
  elsif p_pax is not null then
    update bills set pax = p_pax, pax_children = v_kids where id = v_bill_id and pax is null;               -- H3
  end if;
  return v_bill_id;
end $$;
revoke all on function open_table(uuid, integer, integer) from public, anon;                                -- H3
grant execute on function open_table(uuid, integer, integer) to authenticated;                              -- H3
```

- [ ] **Step 4: Add both receipt payloads (H2, H3), copied from their live texts**

Insert next (still before the `-- PostgREST picks up …` line) this comment:

```sql
-- ── H2 / H3. The receipts ──────────────────────────────────────────────────
-- pos_receipt_payload and pos_part_receipt_payload: the live texts of migration-2026-11-22-pos-receipt-numbers.sql
-- (C2) with the lines marked H2 / H3 changed — a takeaway line of a dine-in bill is named "<name> (Takeaway)";
-- paxChildren. Exactly ReceiptPayload / PartReceiptPayload (src/features/pos/print/receipt.ts). Internal.
```

Then copy lines 216–290 of `supabase/migration-2026-11-22-pos-receipt-numbers.sql` verbatim (from `create or replace function pos_receipt_payload(p_bill_id uuid, p_reprint boolean) returns jsonb` to `revoke all on function pos_receipt_payload(uuid, boolean) from public, anon, authenticated;`), then lines 295–372 verbatim (from `create or replace function pos_part_receipt_payload(p_part_id uuid) returns jsonb` to `revoke all on function pos_part_receipt_payload(uuid) from public, anon, authenticated;`). Make these two edits in **each** of the two copies (each "find" text appears once per copy):

(a) After the line

```sql
    'pax', b.pax,
```

insert:

```sql
    'paxChildren', b.pax_children,                                                                       -- H3
```

(b) Replace the line

```sql
               'qty', oi.qty, 'name', oi.name_snapshot, 'unitSen', oi.unit_price_sen,
```

with:

```sql
               'qty', oi.qty,                                                                                     -- H2
               'name', oi.name_snapshot                                                                           -- H2
                       || case when oi.order_type = 'takeaway' and b.order_type = 'dine_in' then ' (Takeaway)' else '' end,   -- H2
               'unitSen', oi.unit_price_sen,                                                                      -- H2
```

- [ ] **Step 5: Add H4 (the columns and set_items_served)**

Insert next (still before the `-- PostgREST picks up …` line) exactly:

```sql
-- ── H4. Serve (spec §6) ─────────────────────────────────────────────────────
alter table order_items add column if not exists served_at timestamptz;                           -- H4: null = not served
alter table order_items add column if not exists served_by uuid references staff(id);             -- H4

-- Mark sent lines of one open bill of the caller's outlet served (p_served true) or not served. A voided
-- line is left as it is and not counted. No PIN; money and printing unchanged. Returns how many lines
-- changed; a change stamps the bill, so the other iPads hear of it (a bills event).
create or replace function set_items_served(p_item_ids uuid[], p_served boolean) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ctx    record;
  v_ids    uuid[];
  v_bill   uuid;
  v_status text;
  v_n      integer;
begin
  select * into v_ctx from pos_ctx();
  if p_served is null then raise exception 'Invalid served state'; end if;
  select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(coalesce(p_item_ids, '{}'::uuid[])) as u(x) where x is not null;
  if cardinality(v_ids) = 0 then raise exception 'Choose the items first.'; end if;
  if (select count(*) from order_items oi where oi.id = any (v_ids)) <> cardinality(v_ids) then
    raise exception 'Item not found';
  end if;
  if (select count(distinct oi.bill_id) from order_items oi where oi.id = any (v_ids)) > 1 then
    raise exception 'The items must be on one bill.';
  end if;
  select oi.bill_id into v_bill from order_items oi where oi.id = v_ids[1];
  select b.status into v_status from bills b where b.id = v_bill and b.branch_id = v_ctx.branch_id for update;
  if not found then raise exception 'Item not found'; end if;
  if v_status <> 'open' then raise exception 'This bill is no longer open.'; end if;
  update order_items
     set served_at = case when p_served then now() end,
         served_by = case when p_served then v_ctx.staff_id end
   where id = any (v_ids) and bill_id = v_bill and voided_at is null and (served_at is null) = p_served;
  get diagnostics v_n = row_count;
  if v_n > 0 then update bills set updated_at = now() where id = v_bill; end if;
  return v_n;
end $$;
revoke all on function set_items_served(uuid[], boolean) from public, anon;
grant execute on function set_items_served(uuid[], boolean) to authenticated;

```

- [ ] **Step 6: Self-check the migration by reading**

Check against the live texts, line by line, that nothing but the `-- H2` / `-- H3` lines differ:
- `place_counter_order` vs `supabase/migration-2026-10-29-pos-device-till.sql` lines 265–284.
- `pos_set_bill_pax` vs `supabase/migration-2026-10-26-pos-frontend.sql` lines 66–77; `open_table` vs `supabase/migration-2026-10-24-pos-bill-actions-fn.sql` lines 370–395.
- `pos_receipt_payload` / `pos_part_receipt_payload` vs `supabase/migration-2026-11-22-pos-receipt-numbers.sql` lines 216–290 / 295–372.

Then confirm by reading: (a) every `least(p_children, p_pax)` and `least(p_pax_children, b.pax)` has both arguments non-null when it runs (`least` skips a null and would return the other one); (b) `jsonb_build_object` in the receipt payload now has 26 pairs and in the part receipt 30 (limit 50); (c) the table check `bills_pax_children_check` holds after every write: `merge_bills` only adds to the target's pax, `pos_insert_order` fills pax only while it is null (then children are null too), and the split part bills are inserted without pax or children; (d) every UPDATE has a WHERE.

- [ ] **Step 7: Add V3 and V4 to the verify**

In `supabase/migration-2026-11-22-pos-feedme-habits-verify.sql`, insert before the line `select 'VERIFY OK' as result;` exactly:

```sql
-- ── V3. Children (spec §5) and the receipts: the first order sets them, a later order keeps them, Pax changes
--    and clamps them, bad values refused, the table check, Open for QR, none from QR; the receipt carries
--    paxChildren and names the takeaway line ──
do $$
declare
  v_b    uuid;
  v_q    uuid;
  v_r    jsonb;
  v_pax  integer;
  v_kids integer;
  v_item jsonb := jsonb_build_array(jsonb_build_object('productId', pg_temp.id('cake'), 'variantId', pg_temp.id('cake_v'), 'qty', 1));
begin
  perform pg_temp.act(pg_temp.id('dev'));
  -- an empty table: 4 pax, 1 child, with its first order
  v_b := pg_temp.bill_of(place_counter_order(pg_temp.id('w2'), 'dine_in', 4, v_item, gen_random_uuid(), null, null, 1));
  select pax, pax_children into v_pax, v_kids from bills where id = v_b;
  if v_pax is distinct from 4 or v_kids is distinct from 1 then raise exception 'FAIL V3 the first order: % pax, % children', v_pax, v_kids; end if;
  -- a later order (with another count) keeps them
  perform place_counter_order(pg_temp.id('w2'), 'dine_in', null, v_item, gen_random_uuid(), null, null, 3);
  select pax, pax_children into v_pax, v_kids from bills where id = v_b;
  if v_pax is distinct from 4 or v_kids is distinct from 1 then raise exception 'FAIL V3 a later order: % pax, % children', v_pax, v_kids; end if;
  -- Pax: 3 with 2 children; 2 with 5 asked → 2; null clears; a two-argument call (an older till) clears too
  perform pos_set_bill_pax(v_b, 3, 2);
  select pax, pax_children into v_pax, v_kids from bills where id = v_b;
  if v_pax is distinct from 3 or v_kids is distinct from 2 then raise exception 'FAIL V3 3 with 2: % / %', v_pax, v_kids; end if;
  perform pos_set_bill_pax(v_b, 2, 5);
  select pax, pax_children into v_pax, v_kids from bills where id = v_b;
  if v_pax is distinct from 2 or v_kids is distinct from 2 then raise exception 'FAIL V3 clamped: % / %', v_pax, v_kids; end if;
  perform pos_set_bill_pax(v_b, 2, null);
  if (select pax_children from bills where id = v_b) is not null then raise exception 'FAIL V3 null did not clear'; end if;
  perform pos_set_bill_pax(v_b, 2, 1);
  perform pos_set_bill_pax(v_b, 5);
  select pax, pax_children into v_pax, v_kids from bills where id = v_b;
  if v_pax is distinct from 5 or v_kids is not null then raise exception 'FAIL V3 two arguments: % / %', v_pax, v_kids; end if;
  perform pg_temp.expect_error(format('select pos_set_bill_pax(%L, 2, -1)', v_b), 'Invalid number of children', 'V3 children below 0');
  perform pg_temp.expect_error(format('select place_counter_order(%L, %L, 2, %L::jsonb, %L, null, null, 100)',
    pg_temp.id('w5'), 'dine_in', v_item, gen_random_uuid()), 'Invalid number of children', 'V3 children above 99');
  perform pg_temp.expect_error(format('update bills set pax_children = 9 where id = %L', v_b),
    'new row for relation "bills" violates check constraint "bills_pax_children_check"', 'V3 the table check');
  -- Open for QR: 2 pax, 1 child
  v_q := open_table(pg_temp.id('w5'), 2, 1);
  select pax, pax_children into v_pax, v_kids from bills where id = v_q;
  if v_pax is distinct from 2 or v_kids is distinct from 1 then raise exception 'FAIL V3 open_table: % / %', v_pax, v_kids; end if;
  -- a QR order (W3, sent in V1) brings none
  if (select pax_children from bills where table_id = pg_temp.id('w3') and status = 'open') is not null then
    raise exception 'FAIL V3 a QR bill has children';
  end if;
  -- the receipt: paxChildren; a takeaway bill has none
  perform pos_set_bill_pax(v_b, 3, 1);
  if (pos_receipt_payload(v_b, false)->>'paxChildren')::integer is distinct from 1 then
    raise exception 'FAIL V3 the receipt''s paxChildren: %', pos_receipt_payload(v_b, false)->'paxChildren';
  end if;
  if (pos_receipt_payload(pg_temp.id('T1'), false)->'paxChildren') is distinct from 'null'::jsonb then
    raise exception 'FAIL V3 a takeaway receipt''s paxChildren: %', pos_receipt_payload(pg_temp.id('T1'), false)->'paxChildren';
  end if;
  -- the receipt names D1's takeaway line "(Takeaway)" and not its other line; a takeaway bill's lines keep their names
  v_r := pos_receipt_payload(pg_temp.id('D1'), false);
  if (select count(*) from jsonb_array_elements(v_r->'items') i where i->>'name' = 'Verify W7 Latte (Takeaway)') <> 1
     or (select count(*) from jsonb_array_elements(v_r->'items') i where i->>'name' = 'Verify W7 Latte') <> 1 then
    raise exception 'FAIL V3 the receipt''s names: %', v_r->'items';
  end if;
  if exists (select 1 from jsonb_array_elements(pos_receipt_payload(pg_temp.id('T1'), false)->'items') i
              where i->>'name' like '%(Takeaway)') then
    raise exception 'FAIL V3 a takeaway bill''s receipt marks its lines';
  end if;
  -- the part receipt is built the same way
  if pg_get_functiondef('pos_part_receipt_payload(uuid)'::regprocedure) not like '%(Takeaway)%'
     or pg_get_functiondef('pos_part_receipt_payload(uuid)'::regprocedure) not like '%paxChildren%' then
    raise exception 'FAIL V3 the part receipt is not the W7 version';
  end if;
end $$;

-- ── V4. Serve (spec §6): serve, again (0), not served, Mark all served, money and printing unchanged, a voided
--    line never served, the refusals ──
do $$
declare
  v_d    uuid := pg_temp.id('D1');
  v_ids  uuid[];
  v_one  uuid;
  v_tot  jsonb;
  v_jobs integer := (select count(*) from print_jobs where branch_id = pg_temp.id('branch'));
  v_n    integer;
begin
  perform pg_temp.act(pg_temp.id('dev'));
  select array_agg(id order by id) into v_ids from order_items where bill_id = v_d and voided_at is null;
  v_one := v_ids[1];
  v_tot := pos_bill_totals(v_d);
  v_n := set_items_served(array[v_one], true);
  if v_n <> 1 or (select served_at is null or served_by is distinct from pg_temp.id('cashier') from order_items where id = v_one) then
    raise exception 'FAIL V4 serve: % changed, %', v_n, (select row(served_at, served_by) from order_items where id = v_one);
  end if;
  v_n := set_items_served(array[v_one], true);
  if v_n <> 0 then raise exception 'FAIL V4 serving a served line again changed %', v_n; end if;
  v_n := set_items_served(array[v_one], false);
  if v_n <> 1 or (select served_at is not null or served_by is not null from order_items where id = v_one) then
    raise exception 'FAIL V4 not served: % changed, %', v_n, (select row(served_at, served_by) from order_items where id = v_one);
  end if;
  -- Mark all served: every live line of the bill
  v_n := set_items_served(v_ids, true);
  if v_n <> cardinality(v_ids) then raise exception 'FAIL V4 mark all: % of %', v_n, cardinality(v_ids); end if;
  if pos_bill_totals(v_d) is distinct from v_tot then raise exception 'FAIL V4 serving changed the money'; end if;
  if (select count(*) from print_jobs where branch_id = pg_temp.id('branch')) <> v_jobs then raise exception 'FAIL V4 serving printed'; end if;
  -- a voided line is never served
  update order_items set voided_at = now(), served_at = null, served_by = null where id = pg_temp.id('TA1');
  v_n := set_items_served(array[pg_temp.id('TA1')], true);
  if v_n <> 0 or (select served_at from order_items where id = pg_temp.id('TA1')) is not null then
    raise exception 'FAIL V4 a voided line was served';
  end if;
  -- the refusals
  perform pg_temp.expect_error('select set_items_served(''{}''::uuid[], true)', 'Choose the items first.', 'V4 no items');
  perform pg_temp.expect_error(format('select set_items_served(%L::uuid[], true)', array[gen_random_uuid()]), 'Item not found', 'V4 an unknown item');
  perform pg_temp.expect_error(format('select set_items_served(%L::uuid[], true)',
    array[v_one, (select id from order_items where bill_id = pg_temp.id('T1') limit 1)]), 'The items must be on one bill.', 'V4 two bills');
end $$;

```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add supabase/migration-2026-11-22-pos-feedme-habits.sql supabase/migration-2026-11-22-pos-feedme-habits-verify.sql src/features/pos/sqlSafeUpdate.test.ts
git commit -m "$(cat <<'EOF'
feat(pos): W7 SQL — children in the pax, (Takeaway) and paxChildren on receipts, set_items_served

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: QR — the Remark field, the cart's `Remark: …`, the last-order banner and Add / Place order off

**Files:**
- Create: `src/features/pos/order/orderWindow.ts`, `src/features/pos/order/orderWindow.test.ts`
- Create: `src/qr/CartRow.tsx`, `src/qr/CartRow.test.tsx`
- Modify: `src/features/pos/order/LineSheet.tsx`, `src/features/pos/order/LineSheet.test.tsx`
- Modify: `src/features/pos/order/cart.ts` (`QrMenuJson` only)
- Modify: `src/qr/QrApp.tsx`

**Interfaces:**
- Consumes (Task 1): `qr_menu` keys `ordersOpenAt`, `lastOrderAt`; the QR cart line's `note` (already stored and sent by `qr_cart_put` / `qr_cart_send`); the refusal sentence from `qr_cart_put` / `qr_cart_send` (shown as `Not added: …` / `Not sent: …` by the existing error paths).
- Produces (Tasks 4 and later use these):
  - `orderWindow.ts`: `WINDOW_HELP`, `SET_BOTH`, `SAME_TIMES`; `minutesOf(hhmm: string | null | undefined): number | null`; `myMinuteOfDay(at: Date): number`; `ordersOpen(openAt: string | null, lastAt: string | null, at: Date): boolean`; `lastOrderMessage(openAt: string, lastAt: string): string`; `pastLastOrder(lastAt: string): string`; `qrClosedMessage(openAt, lastAt, at): string | null`; `padPastLastOrder(openAt, lastAt, at): string | null`; `orderWindowProblem(openAt: string | null, lastAt: string | null): string | null`; `hhmm(t: string | null | undefined): string | null`.
  - `QrMenuJson.ordersOpenAt?: string | null`, `lastOrderAt?: string | null`.
  - `LineSheet` prop `closed?: string | null`; `src/qr/CartRow.tsx` default export `CartRow({ menu, line, onEdit?, onRemove? })`.

- [ ] **Step 1: Write the failing tests**

Create `src/features/pos/order/orderWindow.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  hhmm, lastOrderMessage, minutesOf, myMinuteOfDay, orderWindowProblem, ordersOpen, padPastLastOrder, pastLastOrder,
  qrClosedMessage, SAME_TIMES, SET_BOTH, WINDOW_HELP,
} from './orderWindow'

const at = (iso: string) => new Date(iso)   // written with +08:00: Malaysia time as it reads

describe('the ordering window (W7 spec §3)', () => {
  it('reads HH:MM', () => {
    expect(minutesOf('21:30')).toBe(1290)
    expect(minutesOf('00:00')).toBe(0)
    expect(minutesOf('9:00')).toBeNull()
    expect(minutesOf('24:00')).toBeNull()
    expect(minutesOf(null)).toBeNull()
  })
  it('the minute of the day in Malaysia, whatever the device\'s own zone', () => {
    expect(myMinuteOfDay(at('2026-01-05T21:30:59+08:00'))).toBe(1290)
    expect(myMinuteOfDay(at('2026-01-05T16:00:00Z'))).toBe(0)
    expect(myMinuteOfDay(at('2026-01-05T15:59:00Z'))).toBe(1439)
  })
  it('no times: always open', () => {
    expect(ordersOpen(null, null, at('2026-01-05T03:00:00+08:00'))).toBe(true)
  })
  it('09:00–21:30: from the 09:00 minute to the end of the 21:30 minute', () => {
    const cases: [string, boolean][] = [
      ['2026-01-05T08:59:59+08:00', false], ['2026-01-05T09:00:00+08:00', true],
      ['2026-01-05T21:30:59+08:00', true], ['2026-01-05T21:31:00+08:00', false],
    ]
    for (const [iso, want] of cases) expect(ordersOpen('09:00', '21:30', at(iso)), iso).toBe(want)
  })
  it('09:00–02:00 runs past midnight', () => {
    const cases: [string, boolean][] = [
      ['2026-01-05T23:30:00+08:00', true], ['2026-01-06T01:59:00+08:00', true], ['2026-01-06T02:00:30+08:00', true],
      ['2026-01-06T02:01:00+08:00', false], ['2026-01-06T08:59:00+08:00', false], ['2026-01-06T09:00:00+08:00', true],
    ]
    for (const [iso, want] of cases) expect(ordersOpen('09:00', '02:00', at(iso)), iso).toBe(want)
  })
  it('the words', () => {
    expect(lastOrderMessage('09:00', '21:30')).toBe('Last orders were at 21:30. Ordering opens again at 09:00.')
    expect(pastLastOrder('21:30')).toBe('Past last order (21:30)')
    expect(WINDOW_HELP).toBe('QR ordering stops outside these times. Staff can still order on the POS.')
    expect(SET_BOTH).toBe('Set both times or neither.')
    expect(SAME_TIMES).toBe('Orders open at and Last order at must be different times.')
  })
  it('the QR page\'s sentence and the pad\'s banner: outside the window only', () => {
    const late = at('2026-01-05T22:00:00+08:00')
    const noon = at('2026-01-05T12:00:00+08:00')
    expect(qrClosedMessage('09:00', '21:30', late)).toBe('Last orders were at 21:30. Ordering opens again at 09:00.')
    expect(qrClosedMessage('09:00', '21:30', noon)).toBeNull()
    expect(qrClosedMessage(null, null, late)).toBeNull()
    expect(padPastLastOrder('09:00', '21:30', late)).toBe('Past last order (21:30)')
    expect(padPastLastOrder('09:00', '21:30', noon)).toBeNull()
    expect(padPastLastOrder(null, null, late)).toBeNull()
  })
  it('the settings check: both or neither, not the same time', () => {
    expect(orderWindowProblem(null, null)).toBeNull()
    expect(orderWindowProblem('09:00', null)).toBe('Set both times or neither.')
    expect(orderWindowProblem(null, '21:30')).toBe('Set both times or neither.')
    expect(orderWindowProblem('10:00', '10:00')).toBe('Orders open at and Last order at must be different times.')
    expect(orderWindowProblem('09:00', '02:00')).toBeNull()
  })
  it('a Postgres time as HH:MM', () => {
    expect(hhmm('09:00:00')).toBe('09:00')
    expect(hhmm('21:30')).toBe('21:30')
    expect(hhmm(null)).toBeNull()
  })
})
```

Create `src/qr/CartRow.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import CartRow from './CartRow'
import type { PosMenu } from '../features/pos/order/cart'
import type { CartLine } from './qrCart'

afterEach(cleanup)

const menu: PosMenu = { categories: [{ name: 'Coffee', products: [{
  id: 'p1', name: 'Latte', description: null, soldOut: false,
  variants: [{ id: 'v1', name: 'Regular', priceSen: 900, isBase: true }], groups: [],
}] }] }
const line = (note: string | null): CartLine => ({
  id: 'l1', guestId: 'g1', guestLabel: 'Mei', guestAvatar: 'a2', productId: 'p1', variantId: 'v1', qty: 2, note, optionIds: [],
})

describe('CartRow remark (W7 spec §2)', () => {
  it('shows the remark under the line', () => {
    render(<CartRow menu={menu} line={line('less sweet')} />)
    expect(screen.getByText('Remark: less sweet')).toBeTruthy()
    expect(screen.getByText('RM 18.00')).toBeTruthy()
  })
  it('no remark, no Remark line', () => {
    render(<CartRow menu={menu} line={line(null)} />)
    expect(screen.queryByText(/Remark:/)).toBeNull()
  })
  it('the guest\'s own line opens for editing and can be removed', () => {
    const onEdit = vi.fn()
    const onRemove = vi.fn()
    render(<CartRow menu={menu} line={line('less sweet')} onEdit={onEdit} onRemove={onRemove} />)
    fireEvent.click(screen.getByRole('button', { name: /2 × Latte/ }))
    expect(onEdit).toHaveBeenCalledWith(menu.categories[0].products[0])
    fireEvent.click(screen.getByRole('button', { name: 'Remove Latte' }))
    expect(onRemove).toHaveBeenCalledOnce()
  })
})
```

In `src/features/pos/order/LineSheet.test.tsx`, replace the first two import lines:

```tsx
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
```

with:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
```

and add at the end of the file:

```tsx
describe('LineSheet remark and last orders (W7 spec §2, §3)', () => {
  const tea: PosProduct = {
    id: 'p2', name: 'Tea', description: null, soldOut: false,
    variants: [{ id: 't', name: 'Regular', priceSen: 500, isBase: true }], groups: [],
  }
  it('a Remark (optional) field, up to 120 characters, goes into the line', () => {
    const onDone = vi.fn()
    render(<LineSheet product={tea} onCancel={() => {}} onDone={onDone} />)
    const box = screen.getByLabelText('Remark (optional)') as HTMLInputElement
    expect(box.maxLength).toBe(120)
    fireEvent.change(box, { target: { value: 'less sweet' } })
    fireEvent.click(screen.getByRole('button', { name: /^Add/ }))
    expect(onDone).toHaveBeenCalledWith({ productId: 'p2', variantId: 't', qty: 1, note: 'less sweet', optionIds: [] })
  })
  it('editing a line shows its remark', () => {
    render(<LineSheet product={tea} initial={{ productId: 'p2', variantId: 't', qty: 1, note: 'no sugar', optionIds: [] }}
      confirmLabel="Save" onCancel={() => {}} onDone={() => {}} />)
    expect((screen.getByLabelText('Remark (optional)') as HTMLInputElement).value).toBe('no sugar')
  })
  it('past the last-order time: Add is off and the sentence shows', () => {
    render(<LineSheet product={tea} closed="Last orders were at 21:30. Ordering opens again at 09:00." onCancel={() => {}} onDone={() => {}} />)
    expect((screen.getByRole('button', { name: /^Add/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('alert').textContent).toBe('Last orders were at 21:30. Ordering opens again at 09:00.')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/pos/order/orderWindow.test.ts src/qr/CartRow.test.tsx src/features/pos/order/LineSheet.test.tsx`
Expected: FAIL — `./orderWindow` and `./CartRow` do not exist; no field labelled `Remark (optional)`; `closed` does nothing.

- [ ] **Step 3: orderWindow.ts**

Create `src/features/pos/order/orderWindow.ts`:

```ts
// src/features/pos/order/orderWindow.ts
/** The outlet's ordering window (W7 spec §3): QR ordering stops outside Orders open at … Last order at,
 *  Malaysia time; the window may cross midnight (09:00–02:00). pos_orders_open
 *  (supabase/migration-2026-11-22-pos-feedme-habits.sql) decides on the server; this mirrors it for the
 *  screen only. Times are "HH:MM"; both null = no limit. Pure. */

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

export const WINDOW_HELP = 'QR ordering stops outside these times. Staff can still order on the POS.'
export const SET_BOTH = 'Set both times or neither.'
export const SAME_TIMES = 'Orders open at and Last order at must be different times.'

/** "21:30" → 1290; null for anything that is not HH:MM. */
export function minutesOf(hhmm: string | null | undefined): number | null {
  const m = hhmm ? HHMM.exec(hhmm) : null
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** The minute of the day in Malaysia (UTC+8, no daylight saving), whatever the device's own zone. */
export function myMinuteOfDay(at: Date): number {
  const m = Math.floor(at.getTime() / 60_000) + 8 * 60
  return ((m % 1440) + 1440) % 1440
}

/** pos_orders_open's rule: from the opening minute to the end of the last-order minute; a window that opens
 *  later than it closes runs past midnight. No (or a broken) time = always open. */
export function ordersOpen(openAt: string | null, lastAt: string | null, at: Date): boolean {
  const o = minutesOf(openAt)
  const l = minutesOf(lastAt)
  if (o === null || l === null) return true
  const m = myMinuteOfDay(at)
  return o <= l ? m >= o && m <= l : m >= o || m <= l
}

/** pos_orders_closed_message's sentence: "Last orders were at 21:30. Ordering opens again at 09:00." */
export const lastOrderMessage = (openAt: string, lastAt: string): string =>
  `Last orders were at ${lastAt}. Ordering opens again at ${openAt}.`

/** The POS order pad's thin banner: "Past last order (21:30)". */
export const pastLastOrder = (lastAt: string): string => `Past last order (${lastAt})`

/** What the QR page says now: the sentence outside the window; null inside it or with no window. */
export function qrClosedMessage(openAt: string | null, lastAt: string | null, at: Date): string | null {
  if (!openAt || !lastAt || ordersOpen(openAt, lastAt, at)) return null
  return lastOrderMessage(openAt, lastAt)
}

/** The POS order pad's banner now: "Past last order (21:30)" outside the window, else null. The POS still orders. */
export function padPastLastOrder(openAt: string | null, lastAt: string | null, at: Date): string | null {
  if (!openAt || !lastAt || ordersOpen(openAt, lastAt, at)) return null
  return pastLastOrder(lastAt)
}

/** The settings check (save_receipt_settings refuses the same): both times or neither, and not the same time. */
export function orderWindowProblem(openAt: string | null, lastAt: string | null): string | null {
  if (!openAt && !lastAt) return null
  if (!openAt || !lastAt) return SET_BOTH
  if (minutesOf(openAt) === minutesOf(lastAt)) return SAME_TIMES
  return null
}

/** A Postgres time ("09:00:00") as "HH:MM"; null stays null. */
export const hhmm = (t: string | null | undefined): string | null => (t ? t.slice(0, 5) : null)
```

- [ ] **Step 4: The Remark field and `closed` in LineSheet; the menu's times**

In `src/features/pos/order/cart.ts`, in `interface QrMenuJson`, replace:

```ts
  needsPax: boolean
```

with:

```ts
  needsPax: boolean
  /** W7: the outlet's ordering window, "HH:MM" Malaysia time; null (or absent from an older server) = no limit */
  ordersOpenAt?: string | null
  lastOrderAt?: string | null
```

In `src/features/pos/order/LineSheet.tsx`:

1. Replace:

```tsx
  /** the confirm button's word: 'Add' (default) or 'Save' when an existing line is edited */
  confirmLabel?: string
```

with:

```tsx
  /** the confirm button's word: 'Add' (default) or 'Save' when an existing line is edited */
  confirmLabel?: string
  /** QR (W7): past the outlet's last-order time — Add / Save is off and this sentence shows */
  closed?: string | null
```

2. Replace:

```tsx
export default function LineSheet({ product, initial, mostPicked, busy, error, confirmLabel, onCancel, onDone }: {
```

with:

```tsx
export default function LineSheet({ product, initial, mostPicked, busy, error, confirmLabel, closed, onCancel, onDone }: {
```

3. Replace:

```tsx
        <div className="mt-3 flex items-center gap-3">
          <span className="text-sm">Qty</span>
```

with:

```tsx
        <label className="mt-3 block">
          <span className="text-sm font-medium">Remark (optional)</span>
          <input className="mt-1 w-full rounded-lg border border-border p-2 text-base" maxLength={120}
            value={line.note ?? ''} onChange={(e) => setLine({ ...line, note: e.target.value || null })} />
        </label>

        <div className="mt-3 flex items-center gap-3">
          <span className="text-sm">Qty</span>
```

4. Delete these two lines (the old note box, now replaced by the Remark field above):

```tsx
        <input className="mt-3 w-full rounded-lg border border-border p-2 text-base" placeholder="Note for the kitchen (optional)"
          value={line.note ?? ''} onChange={(e) => setLine({ ...line, note: e.target.value || null })} maxLength={120} />
```

5. Replace:

```tsx
        {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
```

with:

```tsx
        {closed && <p role="alert" className="mt-2 text-sm text-amber-800">{closed}</p>}
        {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
```

6. Replace:

```tsx
          <button disabled={!!problem || busy} onClick={() => onDone(line)}
```

with:

```tsx
          <button disabled={!!problem || busy || !!closed} onClick={() => onDone(line)}
```

- [ ] **Step 5: CartRow, moved out of QrApp, with the remark**

Create `src/qr/CartRow.tsx`:

```tsx
// src/qr/CartRow.tsx
import { findProduct, formatSen, lineLabel, linePriceSen, type PosMenu, type PosProduct } from '../features/pos/order/cart'
import { lineAvailable, type CartLine } from './qrCart'

/** One line of the table's cart. With onEdit / onRemove it is the guest's own; without, someone else's
 *  (read-only). A line the menu no longer offers is struck through and says so. W7 spec §2: the guest's
 *  remark shows under it ("Remark: less sweet"). */
export default function CartRow({ menu, line, onEdit, onRemove }: {
  menu: PosMenu
  line: CartLine
  onEdit?: (product: PosProduct) => void
  onRemove?: () => void
}) {
  const p = findProduct(menu, line.productId)
  const ok = lineAvailable(menu, line)
  const label = p && ok ? lineLabel(p, line) : { name: p?.name ?? 'Unavailable item', mods: [] as string[] }
  const text = <>{line.qty} × {label.name}{label.mods.length > 0 && <span className="text-brown-muted"> · {label.mods.join(', ')}</span>}</>
  return (
    <div className="flex justify-between gap-2 py-1">
      <span>
        {onEdit && p && ok
          ? <button type="button" className="text-left" onClick={() => onEdit(p)}>{text}</button>
          : <span className={ok ? '' : 'line-through opacity-60'}>{text}</span>}
        {line.note && <span className="block text-xs text-brown-muted">Remark: {line.note}</span>}
        {!ok && <span className="block text-xs text-red-700">Not available now</span>}
      </span>
      <span className="shrink-0">
        {p && ok ? formatSen((linePriceSen(p, line) ?? 0) * line.qty) : ''}
        {onRemove && <button type="button" aria-label={`Remove ${label.name}`} className="ml-2 text-red-700" onClick={onRemove}>✕</button>}
      </span>
    </div>
  )
}
```

- [ ] **Step 6: QrApp — the banner, Add and Place order off, CartRow**

In `src/qr/QrApp.tsx`:

1. Replace `  findProduct, formatSen, lineLabel, linePriceSen, posMenuFromQr,` with `  findProduct, formatSen, posMenuFromQr,`.
2. Replace `  additionsToast, cartChannel, cartTotalSen, groupCart, groupOrdered, isNetworkError, lineAvailable, orderWasSent, sendGroups, sentKey, skipIds,` with `  additionsToast, cartChannel, cartTotalSen, groupCart, groupOrdered, isNetworkError, orderWasSent, sendGroups, sentKey, skipIds,`.
3. Replace `import SendSheet from './SendSheet'` with:

```tsx
import SendSheet from './SendSheet'
import CartRow from './CartRow'
import { useMinuteClock } from '../features/pos/order/useMinuteClock'
import { qrClosedMessage } from '../features/pos/order/orderWindow'
```

4. After the line `  const pairsShown = useRef(new Set<string>())                           // Goes well with: once per product per visit` insert:

```tsx
  const clock = useMinuteClock()                                         // W7: the last-order banner turns on and off on the minute
```

5. After the line `  const showGoesWell = goesWell.length > 0 && goesWellName !== null && goesWellVisible(goesWellFor, cartLines)` insert:

```tsx
  // W7 spec §3: outside the outlet's window the page says when ordering opens again; Add and Place order are
  // off (the server refuses them anyway — its clock decides)
  const closedMsg = qrClosedMessage(info.ordersOpenAt ?? null, info.lastOrderAt ?? null, new Date(clock))
```

6. Replace `      {placed && (` with:

```tsx
      {closedMsg && <div role="status" className="m-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{closedMsg}</div>}
      {placed && (
```

7. Replace `        <button disabled={sendable.length === 0 || table.status !== 'ready'}` with `        <button disabled={sendable.length === 0 || table.status !== 'ready' || closedMsg !== null}`.
8. Replace `          mostPicked={mostPickedFor(picks, sheet.product.id)} busy={sheetBusy} error={sheetError} confirmLabel={sheet.lineId === null ? undefined : 'Save'}` with `          mostPicked={mostPickedFor(picks, sheet.product.id)} busy={sheetBusy} error={sheetError} confirmLabel={sheet.lineId === null ? undefined : 'Save'} closed={closedMsg}`.
9. Delete the whole `CartRow` function at the bottom — from the line `/** One line of the table's cart. With onEdit / onRemove it is the guest's own; without, someone else's` through the `}` that closes `function CartRow(…)` (the line before `/** A card of Popular here and Goes well with: photo, name, price; a tap opens the item sheet. */`). The two `<CartRow …>` uses in the cart panel now use the import and stay as they are.

- [ ] **Step 7: Run the tests and the type check**

Run: `npx vitest run src/features/pos/order/orderWindow.test.ts src/qr/CartRow.test.tsx src/features/pos/order/LineSheet.test.tsx src/qr`
Expected: PASS.
Run: `npx tsc -b`
Expected: exits 0 (no unused imports left in QrApp).

- [ ] **Step 8: Commit**

```bash
git add src/features/pos/order/orderWindow.ts src/features/pos/order/orderWindow.test.ts src/qr/CartRow.tsx src/qr/CartRow.test.tsx src/features/pos/order/LineSheet.tsx src/features/pos/order/LineSheet.test.tsx src/features/pos/order/cart.ts src/qr/QrApp.tsx
git commit -m "$(cat <<'EOF'
feat(qr): W7 Remark on QR items, shown in the table cart; the last-order banner turns Add and Place order off

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: POS settings — Orders open at / Last order at; the order pad's "Past last order" banner

**Files:**
- Modify: `src/features/pos/checkout/checkoutApi.ts` (`PosSettings`, `DEFAULT_POS_SETTINGS`, `ReceiptDetails`, `SettingsRow`, `toSettings`, `fetchPosSettings`, `fetchReceiptDetails`)
- Modify: `src/features/pos/checkout/settingsForm.ts`, `src/features/pos/checkout/settingsForm.test.ts`
- Modify: `src/features/pos/checkout/CheckoutSettings.tsx` (the Receipt section)
- Modify: `src/features/pos/order/OrderScreen.tsx` (the banner only)

**Interfaces:**
- Consumes (Task 1): `branch_pos_settings.orders_open_at` / `last_order_at` (read as `"09:00:00"`), `save_receipt_settings` keys `ordersOpenAt` / `lastOrderAt`. (Task 3): `hhmm`, `orderWindowProblem`, `padPastLastOrder`, `WINDOW_HELP`.
- Produces: `PosSettings.ordersOpenAt: string | null`, `PosSettings.lastOrderAt: string | null` (also in `BillingConfig.settings`); `ReceiptDetails.ordersOpenAt`, `ReceiptDetails.lastOrderAt` (sent as is by `saveReceiptDetails`); `ReceiptDetailsForm.ordersOpenAt?`, `lastOrderAt?`.

- [ ] **Step 1: Write the failing test**

In `src/features/pos/checkout/settingsForm.test.ts`, add at the end of the file:

```ts
describe('the ordering window in the receipt settings (W7 spec §3)', () => {
  const ok = { receiptTitle: 'Craft Cafe - Demo', legalName: '', registrationNo: '', sstNo: '', address: '', phone: '', email: '', footer: 'Thanks' }
  it('both times or neither, not the same time; a window past midnight is fine', () => {
    expect(receiptDetailsProblem({ ...ok, ordersOpenAt: null, lastOrderAt: null })).toBeNull()
    expect(receiptDetailsProblem({ ...ok, ordersOpenAt: '09:00', lastOrderAt: '02:00' })).toBeNull()
    expect(receiptDetailsProblem({ ...ok, ordersOpenAt: '09:00', lastOrderAt: null })).toBe('Set both times or neither.')
    expect(receiptDetailsProblem({ ...ok, ordersOpenAt: null, lastOrderAt: '21:30' })).toBe('Set both times or neither.')
    expect(receiptDetailsProblem({ ...ok, ordersOpenAt: '21:30', lastOrderAt: '21:30' })).toBe('Orders open at and Last order at must be different times.')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/features/pos/checkout/settingsForm.test.ts`
Expected: FAIL — `receiptDetailsProblem` returns null for one time only (and TypeScript reports the unknown keys).

- [ ] **Step 3: settingsForm — the window check**

In `src/features/pos/checkout/settingsForm.ts`:

1. Replace `import type { PaymentKind } from './tender'` with:

```ts
import type { PaymentKind } from './tender'
import { orderWindowProblem } from '../order/orderWindow'
```

2. Replace:

```ts
  footerQr?: string // W4: printed as a QR code under the footer
}
```

with:

```ts
  footerQr?: string // W4: printed as a QR code under the footer
  ordersOpenAt?: string | null // W7: "HH:MM" Malaysia time, with lastOrderAt or not at all
  lastOrderAt?: string | null
}
```

3. Replace:

```ts
  if ((f.footerQr ?? '').trim().length > 300) return 'The QR text is too long (300 characters at most).'
  return null
```

with:

```ts
  if ((f.footerQr ?? '').trim().length > 300) return 'The QR text is too long (300 characters at most).'
  return orderWindowProblem(f.ordersOpenAt ?? null, f.lastOrderAt ?? null)
```

- [ ] **Step 4: checkoutApi — the times in the settings**

In `src/features/pos/checkout/checkoutApi.ts`:

1. Replace `import type { ReceiptLogo } from '../print/logo'` with:

```ts
import type { ReceiptLogo } from '../print/logo'
import { hhmm } from '../order/orderWindow'
```

2. Replace:

```ts
  fontSize: FontSize
  hideFreeMods: boolean
}
export const DEFAULT_POS_SETTINGS: PosSettings = {
  sstRegistered: true, cashRounding: 'nearest_5_sen', receiptRoute: null, receiptFooter: DEFAULT_FOOTER, qrRequiresOpenBill: false,
  receiptLogo: null, footerQr: '', fontSize: 'normal', hideFreeMods: false,
}
```

with:

```ts
  fontSize: FontSize
  hideFreeMods: boolean
  ordersOpenAt: string | null       // W7: "HH:MM" Malaysia time; both null = QR orders at any time
  lastOrderAt: string | null
}
export const DEFAULT_POS_SETTINGS: PosSettings = {
  sstRegistered: true, cashRounding: 'nearest_5_sen', receiptRoute: null, receiptFooter: DEFAULT_FOOTER, qrRequiresOpenBill: false,
  receiptLogo: null, footerQr: '', fontSize: 'normal', hideFreeMods: false, ordersOpenAt: null, lastOrderAt: null,
}
```

3. Replace:

```ts
  hideFreeMods: boolean             // W4
}
```

with:

```ts
  hideFreeMods: boolean             // W4
  ordersOpenAt: string | null       // W7: "HH:MM"; null with lastOrderAt = no limit
  lastOrderAt: string | null        // W7
}
```

4. Replace:

```ts
interface SettingsRow {
  sst_registered: boolean; cash_rounding: CashRounding; receipt_route: string | null; receipt_footer: string; qr_requires_open_bill: boolean
  receipt_logo: ReceiptLogo | null; receipt_footer_qr: string | null; receipt_font_size: FontSize; receipt_hide_free_mods: boolean
}
const toSettings = (r: SettingsRow | null): PosSettings => (r ? {
  sstRegistered: r.sst_registered, cashRounding: r.cash_rounding, receiptRoute: r.receipt_route,
  receiptFooter: r.receipt_footer, qrRequiresOpenBill: r.qr_requires_open_bill,
  receiptLogo: r.receipt_logo, footerQr: r.receipt_footer_qr ?? '', fontSize: r.receipt_font_size ?? 'normal',
  hideFreeMods: r.receipt_hide_free_mods ?? false,
} : DEFAULT_POS_SETTINGS)

export async function fetchPosSettings(branchId: string): Promise<PosSettings> {
  const { data, error } = await supabase.from('branch_pos_settings')
    .select('sst_registered, cash_rounding, receipt_route, receipt_footer, qr_requires_open_bill, receipt_logo, receipt_footer_qr, receipt_font_size, receipt_hide_free_mods')
```

with:

```ts
interface SettingsRow {
  sst_registered: boolean; cash_rounding: CashRounding; receipt_route: string | null; receipt_footer: string; qr_requires_open_bill: boolean
  receipt_logo: ReceiptLogo | null; receipt_footer_qr: string | null; receipt_font_size: FontSize; receipt_hide_free_mods: boolean
  orders_open_at: string | null; last_order_at: string | null   // W7: Postgres times, "09:00:00"
}
const toSettings = (r: SettingsRow | null): PosSettings => (r ? {
  sstRegistered: r.sst_registered, cashRounding: r.cash_rounding, receiptRoute: r.receipt_route,
  receiptFooter: r.receipt_footer, qrRequiresOpenBill: r.qr_requires_open_bill,
  receiptLogo: r.receipt_logo, footerQr: r.receipt_footer_qr ?? '', fontSize: r.receipt_font_size ?? 'normal',
  hideFreeMods: r.receipt_hide_free_mods ?? false,
  ordersOpenAt: hhmm(r.orders_open_at), lastOrderAt: hhmm(r.last_order_at),
} : DEFAULT_POS_SETTINGS)

export async function fetchPosSettings(branchId: string): Promise<PosSettings> {
  const { data, error } = await supabase.from('branch_pos_settings')
    .select('sst_registered, cash_rounding, receipt_route, receipt_footer, qr_requires_open_bill, receipt_logo, receipt_footer_qr, receipt_font_size, receipt_hide_free_mods, orders_open_at, last_order_at')
```

5. Replace:

```ts
    receiptLogo: s.receiptLogo, footerQr: s.footerQr, fontSize: s.fontSize, hideFreeMods: s.hideFreeMods,
```

with:

```ts
    receiptLogo: s.receiptLogo, footerQr: s.footerQr, fontSize: s.fontSize, hideFreeMods: s.hideFreeMods,
    ordersOpenAt: s.ordersOpenAt, lastOrderAt: s.lastOrderAt,
```

- [ ] **Step 5: The two time fields in POS Settings → Receipt**

In `src/features/pos/checkout/CheckoutSettings.tsx`:

1. Replace `import ReceiptLogoField from './ReceiptLogoField'` with:

```tsx
import ReceiptLogoField from './ReceiptLogoField'
import { WINDOW_HELP } from '../order/orderWindow'
```

2. Replace:

```tsx
        <label className="col-span-2 text-sm"><input type="checkbox" checked={d.qrRequiresOpenBill} onChange={(e) => setD({ ...d, qrRequiresOpenBill: e.target.checked })} /> Staff must open a table before customers can order by QR</label>
```

with:

```tsx
        <label className="col-span-2 text-sm"><input type="checkbox" checked={d.qrRequiresOpenBill} onChange={(e) => setD({ ...d, qrRequiresOpenBill: e.target.checked })} /> Staff must open a table before customers can order by QR</label>
        <label className="text-sm">Orders open at
          <input type="time" className={`${input} ml-2`} value={d.ordersOpenAt ?? ''}
            onChange={(e) => setD({ ...d, ordersOpenAt: e.target.value || null })} />
        </label>
        <label className="text-sm">Last order at
          <input type="time" className={`${input} ml-2`} value={d.lastOrderAt ?? ''}
            onChange={(e) => setD({ ...d, lastOrderAt: e.target.value || null })} />
        </label>
        <p className="col-span-2 text-xs text-brown-muted">{WINDOW_HELP}</p>
```

(`save` already runs `receiptDetailsProblem(d)` before `saveReceiptDetails(branchId, d)`, which sends `d` — with `ordersOpenAt` / `lastOrderAt` — as `p`.)

- [ ] **Step 6: The order pad's banner**

In `src/features/pos/order/OrderScreen.tsx`:

1. Replace `import { tileSlotLabel } from './padSlots'` with:

```tsx
import { tileSlotLabel } from './padSlots'
import { padPastLastOrder } from './orderWindow'
```

2. Replace:

```tsx
  const tileNotice = !takesNewItems(target) ? (bill ? TAKEAWAY_ONE_ORDER : BILL_GONE) : null
```

with:

```tsx
  const tileNotice = !takesNewItems(target) ? (bill ? TAKEAWAY_ONE_ORDER : BILL_GONE) : null
  // W7 spec §3: past the outlet's last-order time the pad says so (the pad's server-time clock); the POS still orders
  const pastLast = billing ? padPastLastOrder(billing.settings.ordersOpenAt, billing.settings.lastOrderAt, slots.now) : null
```

3. Replace:

```tsx
            {soldOutMode && <p className="m-2 rounded bg-red-50 p-2 text-sm text-red-700">Tap items to mark them sold out, or back on sale.</p>}
```

with:

```tsx
            {pastLast && <p role="status" className="mx-2 mt-2 rounded bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">{pastLast}</p>}
            {soldOutMode && <p className="m-2 rounded bg-red-50 p-2 text-sm text-red-700">Tap items to mark them sold out, or back on sale.</p>}
```

- [ ] **Step 7: Run the tests and the type check**

Run: `npx vitest run src/features/pos/checkout src/features/pos/order/billView.test.ts src/features/pos/order/orderWindow.test.ts`
Expected: PASS.
Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git add src/features/pos/checkout/checkoutApi.ts src/features/pos/checkout/settingsForm.ts src/features/pos/checkout/settingsForm.test.ts src/features/pos/checkout/CheckoutSettings.tsx src/features/pos/order/OrderScreen.tsx
git commit -m "$(cat <<'EOF'
feat(pos): W7 Orders open at / Last order at in POS settings; the order pad says Past last order

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The Takeaway switch — a takeaway line inside a dine-in bill, on the bill and the ticket

**Files:**
- Modify: `src/features/pos/order/cart.ts` (`OrderLine` only)
- Modify: `src/features/pos/order/modifiers.ts`, `src/features/pos/order/modifiers.test.ts`
- Modify: `src/features/pos/order/ModifierSheet.tsx`, `src/features/pos/order/ModifierSheet.test.tsx`
- Modify: `src/features/pos/order/billView.ts`, `src/features/pos/order/billView.test.ts`
- Modify: `src/features/pos/print/ticket.ts`, `src/features/pos/print/ticket.test.ts`
- Modify: `src/features/pos/offline/orderQueue.test.ts` (a test only)
- Modify: `src/features/pos/order/OrderScreen.tsx` (one prop)

**Interfaces:**
- Consumes (Task 1): an item JSON `"takeaway": true` on a dine-in counter order → `order_items.order_type = 'takeaway'` + the fee; ticket line `"takeaway": true`. (Task 2): receipt item names already end with ` (Takeaway)` (nothing to do in `receipt.ts`).
- Produces: `OrderLine.takeaway?: true`; `withTakeaway(line: OrderLine, on: boolean): OrderLine` (modifiers.ts); `ModifierSheet` prop `takeawaySwitch?: boolean`; `TAKEAWAY_SUFFIX = ' (Takeaway)'` (billView.ts); `TicketLine.takeaway?: true`.

- [ ] **Step 1: Write the failing tests**

In `src/features/pos/order/modifiers.test.ts`, replace `import { groupBadge, tileInitials, toggleOption } from './modifiers'` with `import { groupBadge, tileInitials, toggleOption, withTakeaway } from './modifiers'` and add at the end of the file:

```ts
describe('withTakeaway (W7 spec §4)', () => {
  const line = { productId: 'p', variantId: 'v', qty: 1, note: null, optionIds: [] }
  it('on: the line carries takeaway: true; off: the key is gone, the line as before W7', () => {
    expect(withTakeaway(line, true)).toEqual({ ...line, takeaway: true })
    expect(withTakeaway({ ...line, takeaway: true }, false)).toEqual(line)
    expect('takeaway' in withTakeaway(line, false)).toBe(false)
  })
})
```

In `src/features/pos/order/ModifierSheet.test.tsx`, add at the end of the file:

```tsx
describe('ModifierSheet Takeaway switch (W7 spec §4)', () => {
  const tea: PosProduct = {
    id: 'p2', name: 'Tea', description: null, soldOut: false,
    variants: [{ id: 't', name: 'Regular', priceSen: 500, isBase: true }], groups: [],
  }
  it('on a dine-in bill: a Takeaway switch, off at first; on, the line is a takeaway line', () => {
    const onDone = vi.fn()
    render(<ModifierSheet product={tea} takeawaySwitch onCancel={() => {}} onDone={onDone} />)
    const sw = screen.getByRole('switch', { name: 'Takeaway' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(sw)
    expect(sw.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm · RM 5.00' }))
    expect(onDone).toHaveBeenCalledWith({ productId: 'p2', variantId: 't', qty: 1, note: null, optionIds: [], takeaway: true })
  })
  it('switched off again, the line has no takeaway key', () => {
    const onDone = vi.fn()
    render(<ModifierSheet product={tea} takeawaySwitch onCancel={() => {}} onDone={onDone} />)
    fireEvent.click(screen.getByRole('switch', { name: 'Takeaway' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Takeaway' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm · RM 5.00' }))
    expect(onDone).toHaveBeenCalledWith({ productId: 'p2', variantId: 't', qty: 1, note: null, optionIds: [] })
  })
  it('editing a takeaway draft shows the switch on', () => {
    render(<ModifierSheet product={tea} takeawaySwitch initial={{ productId: 'p2', variantId: 't', qty: 1, note: null, optionIds: [], takeaway: true }}
      onCancel={() => {}} onDone={() => {}} />)
    expect(screen.getByRole('switch', { name: 'Takeaway' }).getAttribute('aria-checked')).toBe('true')
  })
  it('no switch on a takeaway bill, and a line never leaves it with the flag', () => {
    const onDone = vi.fn()
    render(<ModifierSheet product={tea} initial={{ productId: 'p2', variantId: 't', qty: 1, note: null, optionIds: [], takeaway: true }}
      onCancel={() => {}} onDone={onDone} />)
    expect(screen.queryByRole('switch')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm · RM 5.00' }))
    expect(onDone).toHaveBeenCalledWith({ productId: 'p2', variantId: 't', qty: 1, note: null, optionIds: [] })
  })
})
```

In `src/features/pos/order/billView.test.ts`, replace `import { billView, discardQuestion, draftsDiscarded, itemsWord, payGate, sendFirstQuestion } from './billView'` with `import { billView, discardQuestion, draftsDiscarded, itemsWord, payGate, sendFirstQuestion, TAKEAWAY_SUFFIX } from './billView'` and add at the end of the file:

```ts
describe('a takeaway line inside a dine-in bill (W7 spec §4)', () => {
  const sc: BillingConfig = {
    settings: { ...billing.settings, sstRegistered: false },
    rules: [{ rateBp: 1000, orderTypes: ['dine_in'], tableIds: null, productIds: null }],
  }
  const ta = item('i3', false, { order_type: 'takeaway', takeaway_fee_sen: 100 })
  it('a sent takeaway line reads " (Takeaway)" on a dine-in bill, not on a takeaway bill', () => {
    expect(TAKEAWAY_SUFFIX).toBe(' (Takeaway)')
    expect(billView({ orderType: 'dine_in', tableId: 't1', items: [item('i1'), ta], lines: [], menu, info, billing }).sent.map((s) => s.name))
      .toEqual(['Nasi Lemak', 'Nasi Lemak (Takeaway)'])
    expect(billView({ orderType: 'takeaway', tableId: null, items: [ta], lines: [], menu, info, billing }).sent[0].name).toBe('Nasi Lemak')
  })
  it('a takeaway draft: named so, its packaging fee, no dine-in service charge', () => {
    const v = billView({ orderType: 'dine_in', tableId: 't1', items: [], lines: [draft, { ...draft, takeaway: true }], menu, info, billing: sc })
    expect(v.drafts.map((d) => d.name)).toEqual(['Nasi Lemak', 'Nasi Lemak (Takeaway)'])
    // 7.00 + 7.00; service charge 10% of the dine-in 7.00 only = 0.70; packaging 1.00
    expect([v.totals?.subtotalSen, v.totals?.serviceChargeSen, v.totals?.takeawayFeeSen]).toEqual([1400, 70, 100])
  })
  it('a sent takeaway line is priced by its own type', () => {
    const v = billView({ orderType: 'dine_in', tableId: 't1', items: [item('i1'), ta], lines: [], menu, info, billing: sc })
    // 20.00 + 20.00; service charge 10% of the dine-in 20.00 = 2.00; packaging 1.00 × 2
    expect([v.totals?.serviceChargeSen, v.totals?.takeawayFeeSen]).toEqual([200, 200])
  })
})
```

In `src/features/pos/print/ticket.test.ts`, add inside `describe('renderTicketLines', () => { … })`, after the `it('names the guest after the item when the line has one', …)` block:

```ts
  it('W7: a takeaway line of a dine-in bill reads TAKEAWAY before the item name; other lines as before', () => {
    const t: TicketPayload = { ...base, lines: [
      { qty: 1, name: 'Latte', note: null, takeaway: true },
      { qty: 2, name: 'Cake', note: 'no nuts', guest: 'Eric', takeaway: true },
      { qty: 1, name: 'Tea', note: null },
    ] }
    expect(renderTicketLines(t, 32).slice(5, -1)).toEqual([
      '1 x TAKEAWAY Latte',
      '2 x TAKEAWAY Cake - Eric',
      '    * no nuts',
      '1 x Tea',
    ])
  })
```

In `src/features/pos/offline/orderQueue.test.ts`, add at the end of the file:

```ts
describe('a takeaway line (W7 spec §4)', () => {
  it('goes to place_counter_order as it is, the flag on the item', () => {
    const ta = { ...line, takeaway: true as const }
    expect(counterOrderArgs(newQueuedOrder('dine_in', 't1', 2, [line, ta], 5, 'id')).p_items).toEqual([line, ta])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/pos/order/modifiers.test.ts src/features/pos/order/ModifierSheet.test.tsx src/features/pos/order/billView.test.ts src/features/pos/print/ticket.test.ts src/features/pos/offline/orderQueue.test.ts`
Expected: FAIL — `withTakeaway` and `TAKEAWAY_SUFFIX` do not exist; no switch; the ticket prints `1 x Latte`. (The orderQueue test passes already — it pins that the queue keeps the flag.)

- [ ] **Step 3: The line flag and withTakeaway**

In `src/features/pos/order/cart.ts`, replace:

```ts
export interface OrderLine {
  productId: string
  variantId: string
  qty: number
  note: string | null
  optionIds: string[]
}
```

with:

```ts
export interface OrderLine {
  productId: string
  variantId: string
  qty: number
  note: string | null
  optionIds: string[]
  /** W7: a takeaway line inside a dine-in bill (POS only; the server ignores it elsewhere). Absent = the bill's type */
  takeaway?: true
}
```

In `src/features/pos/order/modifiers.ts`, add at the end of the file:

```ts
/** W7 spec §4: the item sheet's Takeaway switch. On: the line carries takeaway: true (a takeaway line inside a
 *  dine-in bill); off: the key is gone, so the line is exactly what it was before W7. */
export function withTakeaway(line: OrderLine, on: boolean): OrderLine {
  const { takeaway: _drop, ...rest } = line
  void _drop
  return on ? { ...rest, takeaway: true } : rest
}
```

- [ ] **Step 4: The switch in ModifierSheet**

In `src/features/pos/order/ModifierSheet.tsx`:

1. Replace `import { groupBadge, toggleOption } from './modifiers'` with `import { groupBadge, toggleOption, withTakeaway } from './modifiers'`.
2. Replace:

```tsx
export default function ModifierSheet({ product, initial, mostPicked, onCancel, onDone, onRemove }: {
  product: PosProduct
  initial?: OrderLine
  /** Most picked (menu picks): group id → option id, marked with a pill — never chosen for the cashier */
  mostPicked?: Readonly<Record<string, string>>
```

with:

```tsx
export default function ModifierSheet({ product, initial, mostPicked, takeawaySwitch = false, onCancel, onDone, onRemove }: {
  product: PosProduct
  initial?: OrderLine
  /** Most picked (menu picks): group id → option id, marked with a pill — never chosen for the cashier */
  mostPicked?: Readonly<Record<string, string>>
  /** W7 spec §4: a dine-in bill — the Takeaway switch makes this a takeaway line inside the bill */
  takeawaySwitch?: boolean
```

3. Replace:

```tsx
  const confirm = () => { if (problem) setTouched(true); else onDone(line) }
```

with:

```tsx
  // a takeaway bill has no switch: a line never leaves this sheet with the flag there
  const confirm = () => { if (problem) setTouched(true); else onDone(takeawaySwitch ? line : withTakeaway(line, false)) }
```

4. Replace:

```tsx
          <input className="h-12 w-full rounded-xl border border-border-mid px-3 text-base" placeholder="Note for the kitchen (optional)"
            value={line.note ?? ''} onChange={(e) => setLine({ ...line, note: e.target.value || null })} maxLength={120} />
```

with:

```tsx
          <input className="h-12 w-full rounded-xl border border-border-mid px-3 text-base" placeholder="Note for the kitchen (optional)"
            value={line.note ?? ''} onChange={(e) => setLine({ ...line, note: e.target.value || null })} maxLength={120} />
          {takeawaySwitch && (
            <button type="button" role="switch" aria-checked={line.takeaway === true}
              onClick={() => setLine((l) => withTakeaway(l, l.takeaway !== true))}
              className="flex min-h-12 w-full items-center justify-between rounded-xl border border-border-mid px-3 text-left">
              <span className="font-semibold text-brown-dark">Takeaway</span>
              <span aria-hidden="true" className={`h-7 w-12 rounded-full p-1 ${line.takeaway ? 'bg-brown-btn' : 'bg-border'}`}>
                <span className={`block h-5 w-5 rounded-full bg-white ${line.takeaway ? 'translate-x-5' : ''}`} />
              </span>
            </button>
          )}
```

- [ ] **Step 5: billView — the name and the draft's price**

In `src/features/pos/order/billView.ts`:

1. Replace:

```ts
export function billView(i: BillViewInput): BillView {
```

with:

```ts
/** W7 spec §4: a takeaway line inside a dine-in bill reads "Nasi Lemak (Takeaway)" (the receipt says the same). */
export const TAKEAWAY_SUFFIX = ' (Takeaway)'

export function billView(i: BillViewInput): BillView {
```

2. Replace:

```ts
      item: it, qty: it.qty, name: it.name_snapshot, mods: it.modifiers_snapshot.map((m) => m.name), note: it.note,
```

with:

```ts
      item: it, qty: it.qty, mods: it.modifiers_snapshot.map((m) => m.name), note: it.note,
      name: it.name_snapshot + (i.orderType === 'dine_in' && it.order_type === 'takeaway' ? TAKEAWAY_SUFFIX : ''),
```

3. Replace:

```ts
    const { name, mods } = lineLabel(p, line)
    return { index, line, qty: line.qty, name, mods, note: line.note, unitSen: linePriceSen(p, line) }
```

with:

```ts
    const { name, mods } = lineLabel(p, line)
    const shown = name + (i.orderType === 'dine_in' && line.takeaway ? TAKEAWAY_SUFFIX : '')
    return { index, line, qty: line.qty, name: shown, mods, note: line.note, unitSen: linePriceSen(p, line) }
```

4. Replace:

```ts
  // a draft counts like pos_insert_order will snapshot it: its price, its product's SST rate, the
  // packaging fee on a takeaway order only, and its catalog's discount
  const draftLines: BillLineInput[] = drafts.flatMap((d) => {
    const info = i.info.get(d.line.productId)
    if (d.unitSen === null || !info) return []
    return [{ productId: d.line.productId, unitPriceSen: d.unitSen, qty: d.qty, sstRateBp: info.sstRateBp,
              takeawayFeeSen: i.orderType === 'takeaway' ? info.takeawayFeeSen : 0, voided: false, orderType: i.orderType,
              catalogDiscountBp: i.draftCatalogDiscountBp ?? 0 }]
  })
```

with:

```ts
  // a draft counts like pos_insert_order will snapshot it: its price, its product's SST rate, the
  // packaging fee on a takeaway line (a takeaway order, or W7 a takeaway line of a dine-in order), and
  // its catalog's discount
  const draftLines: BillLineInput[] = drafts.flatMap((d) => {
    const info = i.info.get(d.line.productId)
    if (d.unitSen === null || !info) return []
    const type: OrderType = i.orderType === 'dine_in' && d.line.takeaway ? 'takeaway' : i.orderType
    return [{ productId: d.line.productId, unitPriceSen: d.unitSen, qty: d.qty, sstRateBp: info.sstRateBp,
              takeawayFeeSen: type === 'takeaway' ? info.takeawayFeeSen : 0, voided: false, orderType: type,
              catalogDiscountBp: i.draftCatalogDiscountBp ?? 0 }]
  })
```

- [ ] **Step 6: TAKEAWAY on the ticket**

In `src/features/pos/print/ticket.ts`:

1. Replace:

```ts
  guest?: string // QR table cart: the guest who added the line ("Eric", "Guest 2"); absent for the counter
}
```

with:

```ts
  guest?: string // QR table cart: the guest who added the line ("Eric", "Guest 2"); absent for the counter
  takeaway?: true // W7: a takeaway line of a dine-in bill ("TAKEAWAY" before the name); absent otherwise and before W7
}
```

2. Replace:

```ts
      ...wrap(`${l.qty} x ${l.name}${g ? ` - ${g}` : ''}`, cols, '    '),
```

with:

```ts
      ...wrap(`${l.qty} x ${l.takeaway ? 'TAKEAWAY ' : ''}${l.name}${g ? ` - ${g}` : ''}`, cols, '    '),
```

- [ ] **Step 7: The order screen passes the switch on a dine-in bill**

In `src/features/pos/order/OrderScreen.tsx`, replace:

```tsx
          mostPicked={mostPickedFor(picks, sheet.product.id)}
```

with:

```tsx
          mostPicked={mostPickedFor(picks, sheet.product.id)}
          takeawaySwitch={orderType === 'dine_in'}
```

- [ ] **Step 8: Run the tests and the type check**

Run: `npx vitest run src/features/pos/order src/features/pos/print src/features/pos/offline`
Expected: PASS (`printJob.test.ts` still shows old tickets print as before).
Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 9: Commit**

```bash
git add src/features/pos/order/cart.ts src/features/pos/order/modifiers.ts src/features/pos/order/modifiers.test.ts src/features/pos/order/ModifierSheet.tsx src/features/pos/order/ModifierSheet.test.tsx src/features/pos/order/billView.ts src/features/pos/order/billView.test.ts src/features/pos/print/ticket.ts src/features/pos/print/ticket.test.ts src/features/pos/offline/orderQueue.test.ts src/features/pos/order/OrderScreen.tsx
git commit -m "$(cat <<'EOF'
feat(pos): W7 Takeaway switch in the item sheet — a takeaway line inside a dine-in bill, (Takeaway) on the bill, TAKEAWAY on the ticket

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Children in the pax — the picker, the first order, the bill header, the receipt

**Files:**
- Modify: `src/features/pos/print/receipt.ts`, `src/features/pos/print/receipt.test.ts`
- Modify: `src/features/pos/offline/orderQueue.ts`, `src/features/pos/offline/orderQueue.test.ts`
- Modify: `src/features/pos/order/posApi.ts` (`OpenBillRow`, `fetchOpenBills`)
- Modify: `src/features/pos/order/orderTarget.ts`, `src/features/pos/order/orderTarget.test.ts`
- Modify: `src/features/pos/shell/PaxDialog.tsx`, `src/features/pos/shell/PaxDialog.test.tsx`
- Modify: `src/features/pos/order/BillColumn.tsx`, `src/features/pos/order/BillColumn.test.tsx`
- Modify: `src/features/pos/checkout/checkoutApi.ts` (`setBillPax`, `openTable`)
- Modify: `src/features/pos/order/OrderScreen.tsx`, `src/features/pos/order/PosTill.tsx` (the pax wiring)

**Interfaces:**
- Consumes (Task 2): `bills.pax_children`; `place_counter_order(…, p_pax_children)`; `pos_set_bill_pax(p_bill_id, p_pax, p_children)`; `open_table(p_table_id, p_pax, p_children)`; receipt `paxChildren`.
- Produces:
  - `ReceiptPayload.paxChildren?: number | null`; `paxChildrenNote(children: number | null | undefined): string` (print/receipt.ts: `' (1 child)'`, `' (2 children)'`, `''` for none or 0).
  - `QueuedOrder.paxChildren?: number | null`; `newQueuedOrder(orderType, tableId, pax, items, now?, id?, catalogId?, paxChildren: number | null = null)`; `counterOrderArgs` adds `p_pax_children` only when set.
  - `OpenBillRow.pax_children?: number | null`; `OrderTarget` table variant `children?: number | null`; `shownChildren(t: OrderTarget, bill: OpenBillRow | null): number | null`.
  - `PaxDialog` props `currentChildren?: number | null`, `onPick(pax: number, children: number | null)`; exports `stepChildren(children: number | null, by: 1 | -1): number | null`, `clampChildren(children: number | null, pax: number): number | null`.
  - `BillColumn` prop `paxChildren?: number | null`.
  - `setBillPax(billId: string, pax: number, children: number | null = null)`, `openTable(tableId: string, pax: number | null, children: number | null = null)`.

- [ ] **Step 1: Write the failing tests**

In `src/features/pos/print/receipt.test.ts`, after its second line (the `import { money, toAscii, … } from './receipt'` line) add:

```ts
import { paxChildrenNote } from './receipt'
```

and add at the end of the file:

```ts
describe('children in the pax (W7 spec §5)', () => {
  it('the words', () => {
    expect(paxChildrenNote(1)).toBe(' (1 child)')
    expect(paxChildrenNote(2)).toBe(' (2 children)')
    expect(paxChildrenNote(0)).toBe('')
    expect(paxChildrenNote(null)).toBe('')
    expect(paxChildrenNote(undefined)).toBe('')
  })
  it('the Table pax row says them; a receipt without paxChildren prints as before', () => {
    expect(renderReceiptLines({ ...r87846, paxChildren: 1 }, 48)).toContain(lr('Table pax', '4 (1 child)', 48)[0])
    expect(renderReceiptLines({ ...r87846, paxChildren: 2 }, 48)).toContain(lr('Table pax', '4 (2 children)', 48)[0])
    expect(renderReceiptLines({ ...r87846, paxChildren: null }, 48)).toEqual(renderReceiptLines(r87846, 48))
    expect(renderReceiptLines(r87846, 48)).toContain('Table pax                                      4')
  })
})
```

In `src/features/pos/offline/orderQueue.test.ts`, add at the end of the file:

```ts
describe('children with the first order (W7 spec §5)', () => {
  it('kept on the queued order and sent as p_pax_children, only when given', () => {
    const withKids = newQueuedOrder('dine_in', 't1', 4, [line], 5, 'id', null, 1)
    expect(withKids.paxChildren).toBe(1)
    expect(counterOrderArgs(withKids)).toMatchObject({ p_pax: 4, p_pax_children: 1 })
    const none = newQueuedOrder('dine_in', 't1', 4, [line], 5, 'id')
    expect('paxChildren' in none).toBe(false)
    expect('p_pax_children' in counterOrderArgs(none)).toBe(false)
  })
})
```

In `src/features/pos/order/orderTarget.test.ts`, replace `import { billTitle, shownPax, takesNewItems, targetBill, targetKey, targetOrderType, targetTitle } from './orderTarget'` with `import { billTitle, shownChildren, shownPax, takesNewItems, targetBill, targetKey, targetOrderType, targetTitle } from './orderTarget'` and add inside `describe('order targets', …)`, after the `it('pax: …')` block:

```ts
  it('children (W7): the bill\'s once it has a pax, else the ones chosen with the pax', () => {
    expect(shownChildren({ kind: 'table', tableId: 't1', pax: 2, children: 1 }, { ...bills[0], pax_children: 2 })).toBe(2)
    expect(shownChildren({ kind: 'table', tableId: 't1', pax: 2, children: 1 }, bills[0])).toBeNull()
    expect(shownChildren({ kind: 'table', tableId: 't2', pax: 3, children: 1 }, null)).toBe(1)
    expect(shownChildren({ kind: 'table', tableId: 't2', pax: 3 }, null)).toBeNull()
    expect(shownChildren({ kind: 'takeaway', billId: '002' }, bills[1])).toBeNull()
  })
```

In `src/features/pos/shell/PaxDialog.test.tsx`: replace `import PaxDialog, { PAX_CHOICES } from './PaxDialog'` with `import PaxDialog, { clampChildren, PAX_CHOICES, stepChildren } from './PaxDialog'`; replace

```tsx
    expect(onPick).toHaveBeenCalledWith(4)
    expect(screen.getAllByRole('button')).toHaveLength(21)   // 20 numbers + Cancel
```

with

```tsx
    expect(onPick).toHaveBeenCalledWith(4, null)
    expect(screen.getAllByRole('button')).toHaveLength(23)   // 20 numbers + Fewer / More children + Cancel
```

and add at the end of the file:

```tsx
describe('PaxDialog children (W7 spec §5)', () => {
  it('Of which children: None at first; More counts up, Fewer back; the pax tap picks both', () => {
    const onPick = vi.fn()
    render(<PaxDialog title="Table T3" current={null} onPick={onPick} onClose={() => {}} />)
    expect(screen.getByText('Of which children')).toBeTruthy()
    expect(screen.getByText('None')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Fewer children' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'More children' }))
    fireEvent.click(screen.getByRole('button', { name: 'More children' }))
    expect(screen.getByText('2', { selector: 'span' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '4' }))
    expect(onPick).toHaveBeenCalledWith(4, 2)
  })
  it('children above the pax tapped are clamped to it', () => {
    const onPick = vi.fn()
    render(<PaxDialog title="Table T3" current={null} onPick={onPick} onClose={() => {}} />)
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: 'More children' }))
    fireEvent.click(screen.getByRole('button', { name: '2' }))
    expect(onPick).toHaveBeenCalledWith(2, 2)
  })
  it('opens with the bill\'s children; Fewer from 1 is None', () => {
    const onPick = vi.fn()
    render(<PaxDialog title="Table T3" current={3} currentChildren={1} onPick={onPick} onClose={() => {}} />)
    expect(screen.getByText('1', { selector: 'span' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Fewer children' }))
    expect(screen.getByText('None')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '3' }))
    expect(onPick).toHaveBeenCalledWith(3, null)
  })
  it('the stepper rule', () => {
    expect(stepChildren(null, 1)).toBe(1)
    expect(stepChildren(5, 1)).toBe(6)
    expect(stepChildren(20, 1)).toBe(20)
    expect(stepChildren(5, -1)).toBe(4)
    expect(stepChildren(1, -1)).toBeNull()
    expect(stepChildren(0, -1)).toBeNull()
    expect(stepChildren(null, -1)).toBeNull()
    expect(clampChildren(5, 3)).toBe(3)
    expect(clampChildren(2, 3)).toBe(2)
    expect(clampChildren(null, 3)).toBeNull()
  })
})
```

In `src/features/pos/order/BillColumn.test.tsx`, add at the end of the file:

```tsx
describe('BillColumn pax with children (W7 spec §5)', () => {
  it('reads "3 pax (1 child)", "4 pax (2 children)", or just the pax', () => {
    const { rerender } = render(<BillColumn {...props} pax={3} paxChildren={1} onPax={() => {}} catalogName={null} onCatalog={null} />)
    expect(screen.getByRole('button', { name: '3 pax (1 child)' })).toBeTruthy()
    rerender(<BillColumn {...props} pax={4} paxChildren={2} onPax={() => {}} catalogName={null} onCatalog={null} />)
    expect(screen.getByRole('button', { name: '4 pax (2 children)' })).toBeTruthy()
    rerender(<BillColumn {...props} pax={4} paxChildren={null} onPax={() => {}} catalogName={null} onCatalog={null} />)
    expect(screen.getByRole('button', { name: '4 pax' })).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/pos/print/receipt.test.ts src/features/pos/offline/orderQueue.test.ts src/features/pos/order/orderTarget.test.ts src/features/pos/shell/PaxDialog.test.tsx src/features/pos/order/BillColumn.test.tsx`
Expected: FAIL — `paxChildrenNote`, `shownChildren`, `stepChildren`, `clampChildren` do not exist; `onPick` gets one argument; no children on the header.

- [ ] **Step 3: The receipt**

In `src/features/pos/print/receipt.ts`:

1. Replace:

```ts
  pax: number | null
  items: ReceiptItem[]
```

with:

```ts
  pax: number | null
  paxChildren?: number | null // W7: of which children (null = not given); absent before W7
  items: ReceiptItem[]
```

2. Replace:

```ts
/** "Part 2 of 3"; "Part 2" for a part by amount. */
```

with:

```ts
/** W7 spec §5: " (1 child)", " (2 children)" after the pax; nothing when not given or 0. */
export function paxChildrenNote(children: number | null | undefined): string {
  if (!children || children < 1) return ''
  return ` (${children} ${children === 1 ? 'child' : 'children'})`
}

/** "Part 2 of 3"; "Part 2" for a part by amount. */
```

3. Replace:

```ts
type HeadInput = Pick<ReceiptPayload, 'reprint' | 'header' | 'billNo' | 'closedAt' | 'cashier' | 'pax' | 'tableLabel' | 'splitFrom'>
```

with:

```ts
type HeadInput = Pick<ReceiptPayload, 'reprint' | 'header' | 'billNo' | 'closedAt' | 'cashier' | 'pax' | 'paxChildren' | 'tableLabel' | 'splitFrom'>
```

4. Replace:

```ts
    ...(r.pax !== null ? lr('Table pax', String(r.pax), cols) : []),
```

with:

```ts
    ...(r.pax !== null ? lr('Table pax', `${r.pax}${paxChildrenNote(r.paxChildren)}`, cols) : []),
```

- [ ] **Step 4: The order queue**

In `src/features/pos/offline/orderQueue.ts`:

1. Replace:

```ts
  staffId?: string | null
}
```

(the end of `interface QueuedOrder`) with:

```ts
  staffId?: string | null
  /** W7: of which children, with the pax of an empty table's first order. Absent = not given (and on older orders). */
  paxChildren?: number | null
}
```

2. Replace:

```ts
  catalogId: string | null = null,
): QueuedOrder {
  return {
    clientOrderId: id, orderType, tableId, pax,
    items: items.map((l) => ({ ...l, optionIds: [...l.optionIds] })),
    queuedAt: now, failedReason: null, catalogId,
  }
}
```

with:

```ts
  catalogId: string | null = null,
  paxChildren: number | null = null,
): QueuedOrder {
  return {
    clientOrderId: id, orderType, tableId, pax,
    items: items.map((l) => ({ ...l, optionIds: [...l.optionIds] })),
    queuedAt: now, failedReason: null, catalogId,
    ...(paxChildren !== null ? { paxChildren } : {}),
  }
}
```

3. Replace:

```ts
    p_client_order_id: o.clientOrderId, p_catalog_id: o.catalogId ?? null, p_staff_id: o.staffId ?? null,
  }
```

with:

```ts
    p_client_order_id: o.clientOrderId, p_catalog_id: o.catalogId ?? null, p_staff_id: o.staffId ?? null,
    ...(o.paxChildren != null ? { p_pax_children: o.paxChildren } : {}),   // W7: only when given
  }
```

- [ ] **Step 5: Open bills, the target, the API**

In `src/features/pos/order/posApi.ts`:

1. Replace:

```ts
  call_no?: string | null   // W4: TA012 on a takeaway bill; null for dine-in and bills made before W4
}
export interface BillItemRow {
```

with:

```ts
  call_no?: string | null   // W4: TA012 on a takeaway bill; null for dine-in and bills made before W4
  pax_children?: number | null   // W7: of which children; null = not given
}
export interface BillItemRow {
```

2. Replace `    .select('id, bill_no, table_id, order_type, pax, opened_at, discount_kind, discount_value, discount_reason, call_no')` with `    .select('id, bill_no, table_id, order_type, pax, opened_at, discount_kind, discount_value, discount_reason, call_no, pax_children')`.

In `src/features/pos/order/orderTarget.ts`:

1. Replace `  | { kind: 'table'; tableId: string; pax: number | null }` with `  | { kind: 'table'; tableId: string; pax: number | null; children?: number | null }   // W7: of which children, with the pax`.
2. After the `shownPax` definition (the line `  bill?.pax ?? (t.kind === 'table' ? t.pax : null)`) add:

```ts

/** W7 spec §5: the children to show with that pax — the bill's once it has a pax, else what Select pax chose. */
export const shownChildren = (t: OrderTarget, bill: OpenBillRow | null): number | null =>
  bill?.pax != null ? bill.pax_children ?? null : t.kind === 'table' ? t.children ?? null : null
```

In `src/features/pos/checkout/checkoutApi.ts`, replace:

```ts
export async function setBillPax(billId: string, pax: number): Promise<void> {
  const { error } = await supabase.rpc('pos_set_bill_pax', { p_bill_id: billId, p_pax: pax })
  if (error) fail(error)
}

export async function openTable(tableId: string, pax: number | null): Promise<string> {
  const { data, error } = await supabase.rpc('open_table', { p_table_id: tableId, p_pax: pax })
```

with:

```ts
/** The pax of an open dine-in bill and, W7, of which children (null = none given; the server clamps to the pax). */
export async function setBillPax(billId: string, pax: number, children: number | null = null): Promise<void> {
  const { error } = await supabase.rpc('pos_set_bill_pax', { p_bill_id: billId, p_pax: pax, p_children: children })
  if (error) fail(error)
}

export async function openTable(tableId: string, pax: number | null, children: number | null = null): Promise<string> {
  const { data, error } = await supabase.rpc('open_table', { p_table_id: tableId, p_pax: pax, p_children: children })
```

- [ ] **Step 6: The picker**

Replace the whole of `src/features/pos/shell/PaxDialog.tsx` with:

```tsx
// src/features/pos/shell/PaxDialog.tsx
import { useState } from 'react'
import { Minus, Plus } from 'lucide-react'

/** Select pax (spec §1): a 1–20 grid, Feedme style. Asked when an empty table is opened, and by
 *  Pax in the bill actions. W7 spec §5: an optional "Of which children" above the grid (None, 1 … 20);
 *  one tap on the pax still picks — both, the children clamped to the pax. */
export const PAX_CHOICES: number[] = Array.from({ length: 20 }, (_, i) => i + 1)
const MAX_CHILDREN = 20

/** The stepper: None → 1 → … → 20; back down, 1 (or 0) → None. */
export function stepChildren(children: number | null, by: 1 | -1): number | null {
  if (by === 1) return children === null ? 1 : Math.min(MAX_CHILDREN, children + 1)
  return children === null || children <= 1 ? null : children - 1
}

/** Never more children than the pax tapped (the server clamps the same way). */
export const clampChildren = (children: number | null, pax: number): number | null =>
  children === null ? null : Math.min(children, pax)

export default function PaxDialog({ title, current, currentChildren = null, onPick, onClose }: {
  title: string                    // "Table T3"
  current: number | null           // highlighted
  currentChildren?: number | null  // W7: the children already given (null = none)
  onPick: (pax: number, children: number | null) => void
  onClose: () => void
}) {
  const [children, setChildren] = useState<number | null>(currentChildren)
  const step = 'flex h-11 w-11 items-center justify-center rounded-lg border border-border-mid disabled:opacity-40'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Select pax" className="w-full max-w-md rounded-2xl bg-card p-5 shadow-card"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold text-brown-dark">Select pax</h2>
          <span className="text-sm text-brown-muted">{title}</span>
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-brown-dark">Of which children</span>
          <div className="flex items-center gap-2">
            <button type="button" aria-label="Fewer children" disabled={children === null} className={step}
              onClick={() => setChildren((c) => stepChildren(c, -1))}><Minus size={18} /></button>
            <span className="w-12 text-center text-lg tabular-nums" aria-live="polite">{children ?? 'None'}</span>
            <button type="button" aria-label="More children" disabled={children === MAX_CHILDREN} className={step}
              onClick={() => setChildren((c) => stepChildren(c, 1))}><Plus size={18} /></button>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-5 gap-2">
          {PAX_CHOICES.map((n) => (
            <button key={n} type="button" onClick={() => onPick(n, clampChildren(children, n))} aria-pressed={current === n}
              className={`h-14 rounded-xl text-lg font-semibold ${current === n ? 'bg-brown-btn text-white' : 'border border-border-mid bg-canvas text-brown-dark'}`}>
              {n}
            </button>
          ))}
        </div>
        <button type="button" onClick={onClose} className="mt-4 min-h-12 w-full rounded-xl border border-border-mid text-brown-dark">Cancel</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 7: The bill header**

In `src/features/pos/order/BillColumn.tsx`:

1. Replace `import DiscountRows from '../checkout/DiscountRows'` with:

```tsx
import DiscountRows from '../checkout/DiscountRows'
import { paxChildrenNote } from '../print/receipt'
```

2. Replace:

```tsx
  pax: number | null
  onPax: (() => void) | null          // null = no pax here (takeaway)
```

with:

```tsx
  pax: number | null
  paxChildren?: number | null         // W7: of which children ("3 pax (1 child)")
  onPax: (() => void) | null          // null = no pax here (takeaway)
```

3. Replace `              <Users size={16} />{p.pax ?? '—'} pax` with `              <Users size={16} />{p.pax ?? '—'} pax{paxChildrenNote(p.paxChildren)}`.

- [ ] **Step 8: The order screen and the till**

In `src/features/pos/order/OrderScreen.tsx`:

1. Replace `import { shownPax, takesNewItems, TAKEAWAY_ONE_ORDER, targetBill, targetOrderType, targetTitle, type OrderTarget } from './orderTarget'` with `import { shownChildren, shownPax, takesNewItems, TAKEAWAY_ONE_ORDER, targetBill, targetOrderType, targetTitle, type OrderTarget } from './orderTarget'`.
2. Replace:

```tsx
      const pax = target.kind === 'table' && !bill?.pax ? target.pax : null
      const res = await submit(newQueuedOrder(orderType, target.kind === 'table' ? target.tableId : null, pax, lines,
        Date.now(), crypto.randomUUID(), catalogId))
```

with:

```tsx
      const pax = target.kind === 'table' && !bill?.pax ? target.pax : null
      const children = target.kind === 'table' && pax !== null ? target.children ?? null : null   // W7: with that pax only
      const res = await submit(newQueuedOrder(orderType, target.kind === 'table' ? target.tableId : null, pax, lines,
        Date.now(), crypto.randomUUID(), catalogId, children))
```

3. Replace:

```tsx
  const pickPax = (n: number) => {
    const purpose = dialog?.kind === 'pax' ? dialog.purpose : 'set'
    setDialog(null)
    if (purpose === 'open_qr' && table) { void run(async () => { await openTable(table.id, n) }); return }
    if (bill) { void run(() => setBillPax(bill.id, n)); return }
    if (target.kind === 'table') onTarget({ ...target, pax: n })
  }
```

with:

```tsx
  const pickPax = (n: number, children: number | null) => {
    const purpose = dialog?.kind === 'pax' ? dialog.purpose : 'set'
    setDialog(null)
    if (purpose === 'open_qr' && table) { void run(async () => { await openTable(table.id, n, children) }); return }
    if (bill) { void run(() => setBillPax(bill.id, n, children)); return }
    if (target.kind === 'table') onTarget({ ...target, pax: n, children })
  }
```

4. Replace:

```tsx
        pax={shownPax(target, bill)}
```

with:

```tsx
        pax={shownPax(target, bill)}
        paxChildren={shownChildren(target, bill)}
```

5. Replace `        <PaxDialog title={title} current={shownPax(target, bill)} onPick={pickPax} onClose={() => setDialog(null)} />` with `        <PaxDialog title={title} current={shownPax(target, bill)} currentChildren={shownChildren(target, bill)} onPick={pickPax} onClose={() => setDialog(null)} />`.

In `src/features/pos/order/PosTill.tsx`, replace:

```tsx
          onPick={(n) => { const t = paxFor; setPaxFor(null); openOrder({ kind: 'table', tableId: t.id, pax: n }) }} />
```

with:

```tsx
          onPick={(n, children) => { const t = paxFor; setPaxFor(null); openOrder({ kind: 'table', tableId: t.id, pax: n, children }) }} />
```

- [ ] **Step 9: Run the tests and the type check**

Run: `npx vitest run src/features/pos src/pos`
Expected: PASS.
Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 10: Commit**

```bash
git add src/features/pos/print/receipt.ts src/features/pos/print/receipt.test.ts src/features/pos/offline/orderQueue.ts src/features/pos/offline/orderQueue.test.ts src/features/pos/order/posApi.ts src/features/pos/order/orderTarget.ts src/features/pos/order/orderTarget.test.ts src/features/pos/shell/PaxDialog.tsx src/features/pos/shell/PaxDialog.test.tsx src/features/pos/order/BillColumn.tsx src/features/pos/order/BillColumn.test.tsx src/features/pos/checkout/checkoutApi.ts src/features/pos/order/OrderScreen.tsx src/features/pos/order/PosTill.tsx
git commit -m "$(cat <<'EOF'
feat(pos): W7 Of which children in the pax picker — sent with the first order, on the bill header and the receipt

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Serve — Serve / Not served on a sent line, Mark all served, ✓ on the bill

**Files:**
- Modify: `src/features/pos/order/posApi.ts` (`BillItemRow`, `fetchBillItems`)
- Modify: `src/features/pos/checkout/checkoutApi.ts` (`setItemsServed`)
- Modify: `src/features/pos/order/billView.ts`, `src/features/pos/order/billView.test.ts`
- Modify: `src/features/pos/order/billActions.ts`, `src/features/pos/order/billActions.test.ts`
- Modify: `src/features/pos/order/ItemActionsOverlay.tsx`, `src/features/pos/order/BillActionsOverlay.tsx`
- Modify: `src/features/pos/order/BillColumn.tsx`, `src/features/pos/order/BillColumn.test.tsx`
- Modify: `src/features/pos/order/OrderScreen.tsx` (the Serve wiring)

**Interfaces:**
- Consumes (Task 2): `order_items.served_at`; `set_items_served(p_item_ids, p_served) returns integer` (its bills event refreshes the other iPads through the existing `bills` subscription). (Task 6): `BillColumn`'s `paxChildren` prop and the `OrderScreen` edits of Task 6 are in place.
- Produces: `BillItemRow.served_at?: string | null`; `setItemsServed(itemIds: string[], served: boolean): Promise<number>`; `SentRow.served: boolean`; `unservedIds(sent: SentRow[]): string[]`; `BillAction` `'mark_served'` (`Mark all served`) via `billActions({ …, unservedCount?: number })`; `ItemAction` `'serve'` (`Serve`) / `'unserve'` (`Not served`) via `itemActions({ discounted, served })`.

- [ ] **Step 1: Write the failing tests**

In `src/features/pos/order/billActions.test.ts`, replace `import { BILL_ACTION_LABEL, PART_PAID_FIRST, billActionNotes, billActions, clearedNotice, itemActionNotes, itemActions } from './billActions'` with `import { BILL_ACTION_LABEL, ITEM_ACTION_LABEL, PART_PAID_FIRST, billActionNotes, billActions, clearedNotice, itemActionNotes, itemActions } from './billActions'`; replace

```ts
describe('itemActions', () => {
  it('Discount item and Void item; a discounted item offers Edit and Remove', () => {
    expect(itemActions({ discounted: false })).toEqual(['discount_item', 'void_item'])
    expect(itemActions({ discounted: true })).toEqual(['edit_item_discount', 'remove_item_discount', 'void_item'])
  })
})
```

with

```ts
describe('itemActions', () => {
  it('Serve first (Not served once served), then Discount item and Void item; a discounted item offers Edit and Remove', () => {
    expect(itemActions({ discounted: false, served: false })).toEqual(['serve', 'discount_item', 'void_item'])
    expect(itemActions({ discounted: true, served: false })).toEqual(['serve', 'edit_item_discount', 'remove_item_discount', 'void_item'])
    expect(itemActions({ discounted: false, served: true })).toEqual(['unserve', 'discount_item', 'void_item'])
    expect([ITEM_ACTION_LABEL.serve, ITEM_ACTION_LABEL.unserve]).toEqual(['Serve', 'Not served'])
  })
  it('a part paid does not stop Serve', () => {
    const notes = itemActionNotes({ partPaid: true })
    expect(notes.serve).toBeUndefined()
    expect(notes.unserve).toBeUndefined()
  })
})
```

and add at the end of the file:

```ts
describe('Mark all served (W7 spec §6)', () => {
  it('on a loaded bill with a live unserved line, right after Send; never without one', () => {
    expect(billActions({ ...table, unservedCount: 2 })).toEqual(['mark_served', 'move', 'split', 'discount_bill', 'void_bill', 'pax', 'pause_qr', 'clear_qr_cart'])
    expect(billActions({ ...table, draftCount: 1, unservedCount: 1 }).slice(0, 2)).toEqual(['send', 'mark_served'])
    expect(billActions({ ...table, unservedCount: 0 })).not.toContain('mark_served')
    expect(billActions({ ...table, loaded: false, unservedCount: 2 })).not.toContain('mark_served')
    expect(billActions({ ...table, hasBill: false, liveSentCount: 0, unservedCount: 2 })).not.toContain('mark_served')
    expect(BILL_ACTION_LABEL.mark_served).toBe('Mark all served')
  })
})
```

In `src/features/pos/order/billView.test.ts`, replace `import { billView, discardQuestion, draftsDiscarded, itemsWord, payGate, sendFirstQuestion, TAKEAWAY_SUFFIX } from './billView'` with `import { billView, discardQuestion, draftsDiscarded, itemsWord, payGate, sendFirstQuestion, TAKEAWAY_SUFFIX, unservedIds } from './billView'` and add at the end of the file:

```ts
describe('served lines (W7 spec §6)', () => {
  const at = '2026-11-22T03:00:00Z'
  it('a line with served_at is served; a voided one never is; Mark all served takes the live unserved lines', () => {
    const v = billView({ orderType: 'dine_in', tableId: 't1', items: [item('i1', false, { served_at: at }), item('i2'), item('i3', true, { served_at: at })],
      lines: [], menu, info, billing })
    expect(v.sent.map((s) => s.served)).toEqual([true, false, false])
    expect(unservedIds(v.sent)).toEqual(['i2'])
  })
  it('money is the same served or not', () => {
    const open = billView({ orderType: 'dine_in', tableId: 't1', items: [item('i1')], lines: [], menu, info, billing })
    const served = billView({ orderType: 'dine_in', tableId: 't1', items: [item('i1', false, { served_at: at })], lines: [], menu, info, billing })
    expect(served.totals).toEqual(open.totals)
  })
})
```

In `src/features/pos/order/BillColumn.test.tsx`, after `import type { BillView } from './billView'` add:

```tsx
import { billView } from './billView'
import type { BillItemRow } from './posApi'
```

and add at the end of the file:

```tsx
describe('BillColumn served lines (W7 spec §6)', () => {
  const row = (id: string, served: string | null): BillItemRow => ({
    id, order_id: 'o1', product_id: 'p1', name_snapshot: 'Latte', unit_price_sen: 900, sst_rate_bp: 600, takeaway_fee_sen: 0,
    order_type: 'dine_in', qty: 2, note: null, modifiers_snapshot: [], voided_at: null, catalog_discount_bp: 0, catalog_discount_name: null,
    discount_kind: null, discount_value: null, discount_reason: null, served_at: served,
    orders: { order_no: '1', source: 'counter', placed_at: '2026-11-22T02:00:00Z' },
  })
  it('a served line: ✓ before its name, muted; an unserved one as before', () => {
    const v = billView({ orderType: 'dine_in', tableId: 't1', items: [row('i1', '2026-11-22T03:00:00Z'), row('i2', null)],
      lines: [], menu: null, info: new Map(), billing: null })
    render(<BillColumn {...props} view={v} catalogName={null} onCatalog={null} />)
    const [served, open] = screen.getAllByRole('button', { name: /× Latte/ })
    expect(served.textContent).toMatch(/^✓ 2 × Latte/)
    expect(served.className).toContain('text-brown-muted')
    expect(open.textContent).toMatch(/^2 × Latte/)
    expect(open.className).not.toContain('text-brown-muted')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/pos/order/billActions.test.ts src/features/pos/order/billView.test.ts src/features/pos/order/BillColumn.test.tsx`
Expected: FAIL — no `serve` / `mark_served`, no `unservedIds`, `served` undefined, no ✓.

- [ ] **Step 3: The data**

In `src/features/pos/order/posApi.ts`:

1. Replace:

```ts
  guest_label?: string | null
  discount_kind: DiscountKind | null    // its item discount
```

with:

```ts
  guest_label?: string | null
  served_at?: string | null             // W7: when it was marked served; null = not served (absent in older fixtures)
  discount_kind: DiscountKind | null    // its item discount
```

2. Replace `            'catalog_discount_bp, catalog_discount_name, discount_kind, discount_value, discount_reason, guest_id, guest_label, ' +` with `            'catalog_discount_bp, catalog_discount_name, discount_kind, discount_value, discount_reason, guest_id, guest_label, served_at, ' +`.

In `src/features/pos/checkout/checkoutApi.ts`, replace:

```ts
/** Paid, voided and merged bills of the branch closed since `sinceIso` (newest first). */
```

with:

```ts
/** W7 spec §6: mark sent, live lines of one open bill served (or not served); how many changed. No PIN. */
export async function setItemsServed(itemIds: string[], served: boolean): Promise<number> {
  const { data, error } = await supabase.rpc('set_items_served', { p_item_ids: itemIds, p_served: served })
  if (error) fail(error)
  return Number(data ?? 0)
}

/** Paid, voided and merged bills of the branch closed since `sinceIso` (newest first). */
```

In `src/features/pos/order/billView.ts`:

1. Replace:

```ts
  item: BillItemRow; qty: number; name: string; mods: string[]; note: string | null; amountSen: number; voided: boolean
```

with:

```ts
  item: BillItemRow; qty: number; name: string; mods: string[]; note: string | null; amountSen: number; voided: boolean
  served: boolean               // W7: marked served (✓); a voided line never is
```

2. Replace:

```ts
      amountSen: d.grossSen, voided: it.voided_at !== null,
```

with:

```ts
      amountSen: d.grossSen, voided: it.voided_at !== null, served: it.voided_at === null && !!it.served_at,
```

3. Replace:

```ts
/** What the Payment button does (spec §2 rules), in this order: no open shift → disabled; drafts →
```

with:

```ts
/** W7 spec §6: the lines Mark all served sends — sent, live and not served yet. */
export const unservedIds = (sent: SentRow[]): string[] => sent.filter((s) => !s.voided && !s.served).map((s) => s.item.id)

/** What the Payment button does (spec §2 rules), in this order: no open shift → disabled; drafts →
```

- [ ] **Step 4: The actions**

In `src/features/pos/order/billActions.ts`:

1. Replace:

```ts
export type BillAction = 'send' | 'move' | 'split' | 'discount_bill' | 'edit_bill_discount' | 'remove_bill_discount'
```

with:

```ts
export type BillAction = 'send' | 'mark_served' | 'move' | 'split' | 'discount_bill' | 'edit_bill_discount' | 'remove_bill_discount'
```

2. Replace `  send: 'Send', move: 'Move', split: SPLIT_ACTION_LABEL, discount_bill: 'Discount bill', edit_bill_discount: 'Edit discount',` with `  send: 'Send', mark_served: 'Mark all served', move: 'Move', split: SPLIT_ACTION_LABEL, discount_bill: 'Discount bill', edit_bill_discount: 'Edit discount',`.
3. Replace:

```ts
  qrPaused: boolean; qrRequiresOpenBill: boolean; billDiscount: boolean
}): BillAction[] {
  const out: BillAction[] = []
  if (p.draftCount > 0) out.push('send')
```

with:

```ts
  qrPaused: boolean; qrRequiresOpenBill: boolean; billDiscount: boolean
  unservedCount?: number   // W7: live sent lines not served yet — Mark all served right after Send
}): BillAction[] {
  const out: BillAction[] = []
  if (p.draftCount > 0) out.push('send')
  if (p.hasBill && p.loaded && (p.unservedCount ?? 0) > 0) out.push('mark_served')
```

4. Replace:

```ts
export type ItemAction = 'discount_item' | 'edit_item_discount' | 'remove_item_discount' | 'void_item'

export const ITEM_ACTION_LABEL: Record<ItemAction, string> = {
  discount_item: 'Discount item', edit_item_discount: 'Edit discount', remove_item_discount: 'Remove discount', void_item: 'Void item',
}

/** A tapped sent item: Discount item (Edit and Remove discount when it has one), then Void item. */
export function itemActions(p: { discounted: boolean }): ItemAction[] {
  return p.discounted ? ['edit_item_discount', 'remove_item_discount', 'void_item'] : ['discount_item', 'void_item']
}
```

with:

```ts
export type ItemAction = 'serve' | 'unserve' | 'discount_item' | 'edit_item_discount' | 'remove_item_discount' | 'void_item'

export const ITEM_ACTION_LABEL: Record<ItemAction, string> = {
  serve: 'Serve', unserve: 'Not served',
  discount_item: 'Discount item', edit_item_discount: 'Edit discount', remove_item_discount: 'Remove discount', void_item: 'Void item',
}

/** A tapped sent item (W7: the Feedme long-press menu): Serve, or Not served once served; then Discount item
 *  (Edit and Remove discount when it has one), then Void item. */
export function itemActions(p: { discounted: boolean; served: boolean }): ItemAction[] {
  const rest: ItemAction[] = p.discounted ? ['edit_item_discount', 'remove_item_discount', 'void_item'] : ['discount_item', 'void_item']
  return [p.served ? 'unserve' : 'serve', ...rest]
}
```

In `src/features/pos/order/ItemActionsOverlay.tsx`, replace:

```tsx
import { Ban, Percent, Undo2 } from 'lucide-react'
```

with:

```tsx
import { Ban, Check, Percent, RotateCcw, Undo2 } from 'lucide-react'
```

and replace:

```tsx
  discount_item: Percent, edit_item_discount: Percent, remove_item_discount: Undo2, void_item: Ban,
```

with:

```tsx
  serve: Check, unserve: RotateCcw, discount_item: Percent, edit_item_discount: Percent, remove_item_discount: Undo2, void_item: Ban,
```

In `src/features/pos/order/BillActionsOverlay.tsx`, replace `import { ArrowRightLeft, Ban, CircleX, Eraser, Pause, Percent, Play, QrCode, Scissors, Send, Undo2, Users } from 'lucide-react'` with `import { ArrowRightLeft, Ban, CheckCheck, CircleX, Eraser, Pause, Percent, Play, QrCode, Scissors, Send, Undo2, Users } from 'lucide-react'`, and replace `  send: Send, move: ArrowRightLeft, split: Scissors, discount_bill: Percent, edit_bill_discount: Percent, remove_bill_discount: Undo2,` with `  send: Send, mark_served: CheckCheck, move: ArrowRightLeft, split: Scissors, discount_bill: Percent, edit_bill_discount: Percent, remove_bill_discount: Undo2,`.

- [ ] **Step 5: ✓ on the bill**

In `src/features/pos/order/BillColumn.tsx`:

1. Replace:

```tsx
                className={`flex min-h-11 w-full justify-between gap-2 py-1.5 text-left ${s.voided ? 'line-through opacity-50' : ''}`}>
                <span>
                  <LineText qty={s.qty} name={s.name} mods={s.mods} note={s.note} guest={s.item.guest_label} />
```

with:

```tsx
                className={`flex min-h-11 w-full justify-between gap-2 py-1.5 text-left ${s.voided ? 'line-through opacity-50' : s.served ? 'text-brown-muted' : ''}`}>
                <span>
                  <LineText qty={s.qty} name={s.name} mods={s.mods} note={s.note} guest={s.item.guest_label} served={s.served} />
```

2. Replace:

```tsx
function LineText({ qty, name, mods, note, guest }: { qty: number; name: string; mods: string[]; note: string | null; guest?: string | null }) {
  return (
    <span>
      {qty} × {name}{guest && <span className="ml-1 text-xs text-brown-muted">· {guest}</span>}
```

with:

```tsx
function LineText({ qty, name, mods, note, guest, served = false }: {
  qty: number; name: string; mods: string[]; note: string | null; guest?: string | null
  served?: boolean   // W7: ✓ before the line; nothing prints
}) {
  return (
    <span>
      {served && <span aria-hidden="true">✓ </span>}{qty} × {name}{guest && <span className="ml-1 text-xs text-brown-muted">· {guest}</span>}
```

- [ ] **Step 6: The order screen**

In `src/features/pos/order/OrderScreen.tsx`:

1. Replace `import { billView, discardQuestion, draftsDiscarded, NO_SHIFT_PAY, payGate, sendFirstQuestion, type DraftRow, type SentRow } from './billView'` with `import { billView, discardQuestion, draftsDiscarded, NO_SHIFT_PAY, payGate, sendFirstQuestion, unservedIds, type DraftRow, type SentRow } from './billView'`.
2. Replace `  clearBillDiscount, clearItemDiscount, mergeBills, moveBill, openTable, setBillDiscount, setBillPax, setItemDiscount, voidBill, voidItem,` with `  clearBillDiscount, clearItemDiscount, mergeBills, moveBill, openTable, setBillDiscount, setBillPax, setItemDiscount, setItemsServed, voidBill, voidItem,`.
3. Replace:

```tsx
    qrPaused: paused, qrRequiresOpenBill: billing?.settings.qrRequiresOpenBill ?? false, billDiscount: billDisc !== null,
  })
```

with:

```tsx
    qrPaused: paused, qrRequiresOpenBill: billing?.settings.qrRequiresOpenBill ?? false, billDiscount: billDisc !== null,
    unservedCount: unservedIds(view.sent).length,
  })
```

4. Replace:

```tsx
    else if (a === 'move') setDialog({ kind: 'move' })
```

with:

```tsx
    else if (a === 'mark_served') {
      const ids = unservedIds(view.sent)                              // W7: every live line not served yet
      if (ids.length > 0) void run(async () => { await setItemsServed(ids, true) })
    }
    else if (a === 'move') setDialog({ kind: 'move' })
```

5. Replace:

```tsx
    if (itemNotes[a]) return
    if (a === 'void_item') setDialog({ kind: 'void_item', row })
```

with:

```tsx
    if (itemNotes[a]) return
    if (a === 'serve' || a === 'unserve') { void run(async () => { await setItemsServed([row.item.id], a === 'serve') }); return }   // W7
    if (a === 'void_item') setDialog({ kind: 'void_item', row })
```

6. Replace `          actions={itemActions({ discounted: storedDiscount(dialog.row.item) !== null })}` with `          actions={itemActions({ discounted: storedDiscount(dialog.row.item) !== null, served: dialog.row.served })}`.

- [ ] **Step 7: Run the tests and the type check**

Run: `npx vitest run src/features/pos src/pos`
Expected: PASS.
Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git add src/features/pos/order/posApi.ts src/features/pos/checkout/checkoutApi.ts src/features/pos/order/billView.ts src/features/pos/order/billView.test.ts src/features/pos/order/billActions.ts src/features/pos/order/billActions.test.ts src/features/pos/order/ItemActionsOverlay.tsx src/features/pos/order/BillActionsOverlay.tsx src/features/pos/order/BillColumn.tsx src/features/pos/order/BillColumn.test.tsx src/features/pos/order/OrderScreen.tsx
git commit -m "$(cat <<'EOF'
feat(pos): W7 Serve / Not served on a sent line and Mark all served; served lines show a muted check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Dev SQL, browser check with the owner, docs, push (controller)

Run by the controller, not an implementer. A fix found here goes back to the task that owns the file, with its own commit, and this task starts again from Step 1.

**Files:**
- Modify: `docs/pos/2026-10-29-feedme-replacement-readiness.md` (§2 W7; §4 the rollout chain)

**Interfaces:**
- Consumes: everything above; the dev SQL route used for W3 / W4 (Supabase SQL editor in the owner's Chrome, project `egznnbjmicebbhwasloy` only; never `yfsoesxzurzjdwstszru`).
- Produces: the migration live on craft-os-dev, `VERIFY OK`, a browser-checked QR page, settings page and till, the docs, the branch pushed.

- [ ] **Step 1: Full test run, type check and both builds**

Run: `npx vitest run`, then `npx tsc -b`, then `npm run build`, then `npm run build:pos`
Expected: every test passes; `tsc -b` exits 0; both builds succeed.

- [ ] **Step 2: Run the migration on craft-os-dev**

Check the editor URL holds `egznnbjmicebbhwasloy`, load `supabase/migration-2026-11-22-pos-feedme-habits.sql`, Run.
Expected: one result row `pos feedme habits applied`. `STOP: run migration-2026-11-22-pos-receipt-numbers.sql and migration-2026-11-22-qr-table-cart.sql first …` means dev lacks the chain: stop and report.

- [ ] **Step 3: Run the verify on craft-os-dev**

Load `supabase/migration-2026-11-22-pos-feedme-habits-verify.sql`, Run.
Expected: one result row `VERIFY OK` (everything rolled back). `ERROR: FAIL <section> …` names the failing check: V1–V2 → Task 1's files, V3–V4 → Task 2's; fix, commit, re-run Step 2 and this step. Then run `supabase/migration-2026-11-22-qr-table-cart-verify.sql` and `supabase/migration-2026-11-22-pos-receipt-numbers-verify.sql` again: both still `VERIFY OK` (A8 of the QR file checks `pos_insert_order` is still guest-aware).

- [ ] **Step 4: Start this worktree's dev server against craft-os-dev and restart the print agent**

Start the `craft-os-dev` entry of **this worktree's** `.claude/launch.json` (`npm run dev` in `/Users/USER/Desktop/Craft_OS/.claude/worktrees/pos-demo`; its `.env.local` points to `egznnbjmicebbhwasloy`). In the browser check that a network request's host is `egznnbjmicebbhwasloy.supabase.co`; stop if it is `yfsoesxzurzjdwstszru`. Restart the print agent from this worktree (`node --env-file=tools/print-agent/.env tools/print-agent/agent.ts`, the office ZyWell at `192.168.0.32:9100`) so tickets print `TAKEAWAY`.

- [ ] **Step 5: Browser — with the owner on the Demo outlet (the owner types their PIN on the till)**

1. **POS Settings → Receipt:** `Orders open at`, `Last order at` and the help text show. Only one time → Save receipt settings → `Set both times or neither.`. Orders open at = an hour from now, Last order at = an hour ago (a window that is closed now and crosses midnight) → Save → `Receipt settings saved`; reload → both kept.
2. **QR page** of a free Demo table: the banner `Last orders were at HH:MM. Ordering opens again at HH:MM.` with those times; an item's sheet has Add off and the sentence; Place order is off. Back in settings, clear both times → Save; reload the QR page → no banner. Add an item with `Remark (optional)` = `less sweet` → the cart shows `Remark: less sweet`; tap the line → the sheet shows the remark; Place order → the POS bill line shows `* less sweet` and the ticket carries it.
3. **Till** with the window closed again (step 1's times): the order pad shows `Past last order (HH:MM)`; a counter order still sends.
4. **Takeaway switch:** on a table, an item with options → the sheet shows `Takeaway` → on → Confirm → the draft reads `<name> (Takeaway)` and the totals show Takeaway packaging; a one-tap item, then tap its draft → the switch is there. Send → the sent line reads `(Takeaway)`; the Bar ticket reads `1 x TAKEAWAY <name>`; the service charge does not include that line. A new takeaway bill's sheet has no switch.
5. **Children:** an empty table → Select pax → `Of which children` → More once → tap 3 → the header button reads `3 pax (1 child)`; send the first order; reload → still. Bill actions → Pax → the stepper shows 1 → tap 2 → `2 pax (1 child)`; again, Fewer → None → tap 4 → `4 pax`.
6. **Serve:** tap a sent line → `Serve` is first → the line shows `✓` and muted; tap it → `Not served` → back. Bill actions → `Mark all served` → every live line ✓, and the action is gone; a second iPad (or a reload) shows the same. Nothing printed (Printers list unchanged).
7. **Receipt:** pay the step-5 bill with a takeaway line on it → the receipt reads `Table pax  3 (1 child)` (whatever the pax then is) and `<name> (Takeaway)`. Clear the times in settings afterwards.

- [ ] **Step 6: Docs — W7 and the rollout chain**

In `docs/pos/2026-10-29-feedme-replacement-readiness.md` §2, replace:

```
- [ ] **W7 Smaller Feedme habits** — customer item remark on QR orders; last-order time before closing; takeaway
      line inside a dine-in bill (Feedme "Takeaway 1.06" add-on); adults / children pax; "Serve" marking;
      member lookup (only if D2 = c).
```

with:

```
- [x] **W7 Smaller Feedme habits** — customer item remark on QR orders; last-order time before closing; takeaway
      line inside a dine-in bill (Feedme "Takeaway 1.06" add-on); adults / children pax; "Serve" marking;
      member lookup (only if D2 = c).
      Built on dev 2026-11-22 (plan docs/superpowers/plans/2026-11-22-pos-feedme-habits.md): Remark on QR items;
      Orders open at / Last order at per outlet in POS Settings → Receipt (QR refused outside, the POS only warns);
      a Takeaway switch in the item sheet of a dine-in bill (packaging fee, no service charge, TAKEAWAY on the
      ticket, "(Takeaway)" on the bill and the receipt); Of which children in the pax picker (bill header and
      receipt); Serve / Not served and Mark all served. Member lookup stays out (D2 = a).
```

In §4, replace:

```
      QR table cart (`migration-2026-11-22-qr-table-cart.sql`, which re-creates `pos_insert_order` and
      `qr_table_state`; SQL before the front end)),
```

with:

```
      QR table cart (`migration-2026-11-22-qr-table-cart.sql`, which re-creates `pos_insert_order` and
      `qr_table_state`; SQL before the front end) → smaller Feedme habits
      (`migration-2026-11-22-pos-feedme-habits.sql`, which re-creates `pos_insert_order`, `qr_menu`, the QR
      cart add / send and both receipt payloads and replaces `place_counter_order`, `pos_set_bill_pax` and
      `open_table`; SQL before the front ends, then restart the print agent)),
```

and replace:

```
      silently put back `pos_insert_order` and `qr_table_state` without the guest fields (the verify script
      checks for this).
```

with:

```
      silently put back `pos_insert_order` and `qr_table_state` without the guest fields (the verify script
      checks for this). After the W7 file, re-running the QR table cart file, the receipt-numbers file or
      `migration-2026-10-29-pos-device-till.sql` undoes W7 (the last one also leaves two `place_counter_order`s
      PostgREST cannot choose between): re-run `migration-2026-11-22-pos-feedme-habits.sql` after any of them.
```

- [ ] **Step 7: Commit and push**

```bash
git add docs/pos/2026-10-29-feedme-replacement-readiness.md
git commit -m "$(cat <<'EOF'
docs(pos): W7 smaller Feedme habits live on dev — readiness, rollout chain

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
git push origin feature/pos-demo
```

Expected: the push succeeds. Report: the test count, both builds, `pos feedme habits applied` and `VERIFY OK` on dev (and the two earlier verifies still OK), browser checks 1–7. Prod is untouched (the migration runs there with the POS chain).

---

## Self-review

**Spec coverage**

| Spec | Task |
|---|---|
| §1 five habits; out of scope (member lookup, QR takeaway, children in reports, KDS, printing served) | 1–7; none built: QR's takeaway flag is ignored (V1), reports keep `pax`, `set_items_served` queues nothing (V4) |
| §2 `Remark (optional)` ≤ 120 under the options; travels in `note`; ticket and POS bill like a staff note; cart `Remark: …`; editing one's line edits it | 3 (LineSheet, CartRow); V1 the remark lands on `order_items.note` (tickets and the bill already show `note`) |
| §3 `orders_open_at` / `last_order_at`, both or neither (`Set both times or neither.`), crossing midnight, saved through `save_receipt_settings` keys | 1 (H1; Spec note 1), 4 (fields, help text, client check); V1 rule, sentence, validation, table check |
| §3 QR banner + Add / Send off; QR add and send RPCs refuse with the sentence (server time) | 1 (`qr_cart_put`, `qr_cart_send`, `pos_insert_order` for QR — Spec conflict 2), 3 (banner, `closed`, Place order); V1 refused inside / outside / across midnight |
| §3 POS thin banner `Past last order (21:30)`, ordering not blocked | 4 (`padPastLastOrder` on the pad's server clock); V1 the POS orders outside |
| §3 `pos_orders_open(p_branch_id, p_at default now())` + message builder in SQL; client mirrors | 1, 3 (`orderWindow.ts`, same cases in vitest and V1) |
| §4 Takeaway switch on a dine-in bill only; `order_type 'takeaway'` + the product fee; no dine-in service charge | 1 (H2), 5 (switch, `withTakeaway`, draft pricing — Spec conflict 4); V2 fee, totals |
| §4 the trigger keeps a line's `takeaway`; a takeaway bill's lines stay takeaway | 1 (`order_items_order_type`); V2 both inserts |
| §4 ticket `TAKEAWAY` before the name; receipt and POS bill ` (Takeaway)`; split / move keep the type; QR cannot set it | 1 (tickets, void tickets), 2 (receipts), 5 (renderer, `TAKEAWAY_SUFFIX`); V1, V2, V3; `pos_move_units` copies `order_type` unchanged |
| §5 `bills.pax_children` (null; 0 ≤ children ≤ pax); `pax` stays the total | 2 (H3, check; Spec conflict 3); V3 |
| §5 picker row `Of which children`, default none; later pax change clamps | 6 (stepper, `clampChildren`; Spec conflict 5), 2 (server clamps); V3 |
| §5 `3 pax (1 child)` / `(2 children)` on the bill header and the receipt | 6 (`paxChildrenNote`, BillColumn, receipt row; Spec note 7), 2 (`paxChildren` in both payloads); V3 |
| §6 `served_at`, `served_by`; `set_items_served` (sent, live, one open bill of the outlet, no PIN, count) | 2 (H4; Spec note 8); V4 |
| §6 long-press → `Serve` / `Not served`; bill actions `Mark all served`; `✓` and muted; nothing prints; money unchanged | 7 (item actions — Spec conflict 1, `mark_served`, BillColumn); V4 money and print count |
| §7 one migration + rolled-back verify after W4 and the QR cart; re-created from newest texts with marked lines | 1–2 (STOP guard, "Where the live code is", copy steps with exact line ranges and `-- H1`…`-- H4`) |
| §7 verify list; unit / component tests per UI piece; browser on dev with the owner | V1–V4; Tasks 3–7 tests; Task 8 |

**Placeholder scan:** every code step carries its full code or an exact copy instruction (file, line range, first and last line) with exact find / replace text; no "add error handling" or "similar to"; the only run-time values are the dev ids (the owner's dev login, from W4's verify) and the printer address in Task 8.

**Type consistency:** `ordersOpenAt` / `lastOrderAt` are the save keys and `qr_menu` keys (Task 1), `QrMenuJson` fields (Task 3) and `PosSettings` / `ReceiptDetails` / `ReceiptDetailsForm` fields (Task 4); `orderWindow.ts` names (Task 3) are the ones Task 4 imports (`hhmm`, `orderWindowProblem`, `padPastLastOrder`, `WINDOW_HELP`); `takeaway: true` is the item JSON key read by `pos_insert_order` (Task 1), `OrderLine.takeaway` and `withTakeaway` (Task 5) and the ticket line key (Tasks 1, 5); `pax_children` / `paxChildren` / `p_pax_children` / `p_children` match across Task 2 (SQL), Task 6 (`OpenBillRow`, `ReceiptPayload`, `counterOrderArgs`, `setBillPax`, `openTable`); `served_at`, `set_items_served(p_item_ids, p_served)` (Task 2) match `BillItemRow.served_at` and `setItemsServed(ids, served)` (Task 7); `SentRow.served` feeds `itemActions({ served })`, `unservedIds` and `BillColumn`.
