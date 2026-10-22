# POS Phase 1 · Sub-plan 3 — Checkout, payments, receipts, voids and refunds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff close a bill on the iPad — the server computes subtotal, service charge, SST, takeaway packaging and 5-sen rounding, takes one or more payments (cash with change, card terminal amount typed in, DuitNow, e-wallet) and the ZY301 prints a customer receipt laid out like Feedme's #87846. A supervisor's PIN approves voids (the kitchen gets a `*** VOID ***` ticket) and refunds (a refund slip prints); bills move between tables and merge; today's bills can be reprinted or refunded; managers keep receipt details, service-charge rules, payment methods and reason templates on `/pos/settings`.

**Architecture:** One schema migration adds `branch_pos_settings`, `service_charge_rules`, `payment_methods`, `reason_templates`, `payments`, `refunds`, `staff_pos_pins` and new columns on `branches`, `bills` and `order_items`, and puts `bills` on Realtime. Totals are one pure SQL function `pos_compute_bill(jsonb)` with exactly the input and output of the TypeScript `computeBill`; `pos_bill_totals(bill_id)` feeds it from the database, and both are tested against one vectors file. Every money write is a `security definer` RPC: `checkout_bill` (idempotent on `checkout_id`), `refund_bill` (idempotent on `refund_id`), `void_order_item`, `void_bill`, `move_bill`, `merge_bills`, `open_table`, `reprint_receipt`, `save_receipt_settings`. The approver's PIN (bcrypt, in a table no client can read) is checked inside each protected RPC; a wrong PIN is answered with `{ok:false,error}` instead of an exception so the lockout counter is not rolled back. Receipts and refund slips are `print_jobs` rows with `kind = 'receipt'` and a payload built in SQL; the Node agent and the iPad print host both render every job through `renderJobLines(payload, cols)` (ticket · receipt · refund slip). The POS gains a checkout sheet, an approval dialog with a PIN pad, bill actions, a today's-bills drawer and My PIN. A new Craft OS capability `pos_supervise` decides who may approve. Shifts, Z report and e-Invoice stay in **Sub-plan 4**.

**Tech Stack:** React 19 + Vite 6 + TypeScript + Tailwind, Supabase (Postgres, RLS, plpgsql RPC, Realtime), pgcrypto bcrypt (`extensions.crypt` / `extensions.gen_salt('bf')`), Vitest, Node 22 print agent (type stripping, no bundler).

**Spec:** `docs/superpowers/specs/2026-10-23-pos-checkout-design.md` (every section). Builds on Sub-plan 2: `docs/superpowers/plans/2026-10-23-pos-phase1-ordering.md` (executed, reviewed; ledger `.superpowers/sdd/progress.md`). Feedme reference: `docs/superpowers/research/2026-10-23-feedme-back-office-teardown.md` (§2.3 payment types, §2.4 reason template, §2.8 service charge, §2.10 receipt template, §3.2 Close up, §6 role permissions).

## Decisions still marked [CONFIRM] in the design (confirm before Task 1 starts)

Each one is built the way the design says; the line after "If not" is the whole change if the owner answers differently.

- **[CONFIRM] Takeaway service charge.** The dev seed has one rule: 10 %, dine-in, all tables, all products — takeaway pays none (vector "takeaway: packaging fee per unit, no service charge"). *If not:* tick Takeaway on that rule in POS settings (no code change; vector "takeaway rule: service charge, SST and packaging fee together" already covers it).
- **[CONFIRM] SST and service charge per rate group, not per line.** `pos_compute_bill` / `computeBill` round once per rate (vector "SST per rate group, not per line…" gives 1.39 where per-line gives 1.38). *If not:* change `groups()` in `bill.ts` and the `sc` / `sst` CTEs in `pos_compute_bill` to sum per-line rounded amounts, and update that one vector in both copies.
- **[CONFIRM] Packaging fee is not taxed.** Feedme shows "Packaging Fee 1.06" (looks like 1.00 + 6 % SST). We charge the snapshotted `takeaway_fee_sen` with no SST and no service charge. *If not:* add the fee to the SST base of its line's rate in both totals functions and in the two takeaway vectors.
- **[CONFIRM] Whole-bill 5-sen rounding for every payment method** (receipt #87846 prints "Bill rounding" for a Touch 'n Go payment). *If not:* round only when every payment is cash — a change in `checkout_bill` (rounding then depends on the payments, so `pos_bill_totals` would take the payment kinds) and in the checkout sheet.
- **[CONFIRM] One capability `pos_supervise` is enough for the pilot** (Feedme's role matrix is finer: discount %, change price, waive service charge, change payment type). *If not:* nothing in this plan changes; finer capabilities come with discounts in a later sub-plan.

## Open points for the owner (choices made while planning, 2026-10-24 — each can be changed later)

1. **Task order differs from the suggested split:** the `pos_supervise` capability is Task 3 (before the approvals SQL, Task 4, and the dev run, Task 5) because the approval functions call it and the verify script needs it live, while the rule says its TypeScript and SQL land in one commit.
2. **`staff_has_cap(staff_id, cap)`** is a second SQL helper with `has_menu_cap`'s exact rule, for the approver (who is not the signed-in cashier); the verify script checks the two agree for every role.
3. **A wrong PIN returns `{ok:false, error}`** from the protected RPCs instead of raising, so the failed-attempt counter survives; every other refusal raises as usual.
4. **Changing an existing PIN needs the current PIN** (wrong tries count toward the lockout); a forgotten PIN is cleared by a settings holder (`clear_pos_pin`, "Approvers" on POS settings).
5. **No reason template saved for an action = a reason is required, any wording** (Feedme's reason templates are empty today).
6. **An empty bill closes without approval** ("Close empty bill": opened by mistake, or every item already voided with approval).
7. **Merge:** the bill on screen absorbs the bill you pick; guests add up (capped at 99).
8. **Approvers are staff whose own branch is the bill's branch** — an owner based at another branch cannot approve at Demo until their branch is set.
9. **Receipt layout details:** cash prints the amount handed over, then Change; every item line shows `(unit/ea)`; modifiers print as `+ name` (ASCII, not `•`); "Bill rounding" always prints; the Charges summary prints only when there is a charge.
10. **Receipt #87846 test fixture:** prices, totals and the payment are the real ones; item names, header numbers, cashier and time are placeholders — send the real names if the test should match the paper word for word.
11. **Extra columns not in the design:** `payments.branch_id`, `payments.line_no` (receipt order), `refunds.branch_id`, `refunds.slip_queued`, `bills.totals` (jsonb snapshot for the receipt's charges summary and reprints), `bills.receipt_queued`, `bills.void_reason`, `bills.void_approved_by`, `order_items.void_approved_by`.
12. **`checkout_bill` also returns `billId` and `receiptQueued`;** with no receipt route the bill is still paid and the sheet says "No receipt printer is set".
13. **Receipt route defaults to none** in the table; the dev seed sets `Bar` (the ZY301). Prod branches must pick one in POS settings.
14. **Quick-tender buttons show only notes above the amount** (Exact is always there).
15. **Refunds are money only** (no item lines, no stock); the slip prints on the receipt route.
16. **"Maybank Terminal" is seeded without a required reference;** tick "Needs reference" to make cashiers type the approval code.
17. **POS settings page and nav entry renamed** from "Tables & printers" to "POS settings".
18. **Address on the receipt is `branches.address`,** the same field the rest of Craft OS shows for the branch.
19. **Realtime listens to bill INSERT and UPDATE** (`event: '*'`), so a table opened on one iPad shows on the others too.
20. **pgcrypto must live in schema `extensions`** (Supabase default); the migration stops with a clear message otherwise.
21. **Resigned staff:** Craft OS ends access with `staff.status = 'resigned'` (values `active` / `resigned`; `is_active` stays true), so every POS lookup of the caller or approver requires `is_active and status = 'active'`. Sub-plan 2's `place_counter_order` had the same gap and is re-created here on `pos_my_branch()`; Sub-plan 2's `insert_test_print` and the print-job RPCs still check only `is_active` (low risk: test prints and job status) — left for the final review.
22. **Merge direction:** a takeaway bill may merge into a table's bill (it then loses its packaging fee and picks up the table's service charge, because totals follow the surviving bill's order type); a table's bill may not merge into a takeaway bill — the server refuses and the picker does not offer it.
23. **Wrong PINs are forgotten after a day** (the counter restarts if the last failure is more than 24 h old).
24. **Not fixed here (from the Sub-plan 2 ledger):** the agent keys routes by name across branches; QR tokens are not rotated on checkout (the `qr_requires_open_bill` switch is the design's mitigation instead).

## Spec deltas (decided while planning, 2026-10-24)

- **Totals function shape.** The design's `pos_bill_totals` is split in two: `pos_compute_bill(p_input jsonb) returns jsonb` (pure, `immutable`, the exact twin of `computeBill(input)`) and `pos_bill_totals(p_bill_id uuid) returns jsonb` (reads the bill, its items, the branch settings and active rules, then calls the pure one). This is what lets the verify script run the very same vectors as Vitest. Output: `{ subtotalSen, serviceChargeSen, sstSen, takeawayFeeSen, beforeRoundingSen, roundingSen, totalSen, sstGroups[], serviceChargeGroups[] }`, groups = `{ rateBp, baseSen, amountSen }` for non-zero rates, ascending.
- **Vectors.** One file `src/features/pos/checkout/billVectors.json` (21 vectors: #87846, takeaway with packaging fee, 0 % SST item, the nine rounding endings 1–9 plus rounding off, voided line, two table/product-limited rules, per-group SST, a half-sen, not SST-registered, takeaway service-charge rule, fee ignored on dine-in). The verify script carries a byte-for-byte copy between `$vectors$` markers and `bill.test.ts` fails if they differ.
- **Wrong PIN = `{ok:false}`** (Open point 3). Protected RPCs (`void_order_item`, `void_bill`, `refund_bill`, `set_my_pos_pin`) return `jsonb`: `{"ok": true, …}` or `{"ok": false, "error": "Wrong PIN — 4 tries left"}`. The client's `unwrapAction` throws the error text.
- **Receipt payload kinds.** `print_jobs.kind` keeps its two values; a receipt is `kind = 'receipt'` with `payload.kind = 'receipt'`, a refund slip is `kind = 'receipt'` with `payload.kind = 'refund'`, a void ticket is `kind = 'ticket'` with `payload.void = true`. Hosts dispatch on `payload.kind`.
- **`bills.totals`** keeps the totals object fixed at checkout, so a reprint shows the same charges summary even after the rules change.
- **Approvers RPC.** `pos_approvers()` returns `(staff_id, name, has_pin)` for the caller's branch.
- **Settings write path.** `branches` receipt columns and `branch_pos_settings` are written only by `save_receipt_settings(p jsonb)` (checks `access_settings`, validates the receipt route), so a manager never hits `branches_manage`'s different role list; rules, methods and reason templates are written directly under `access_settings` policies.
- **Live staff** = `is_active and status = 'active'` for the caller (`pos_my_branch`, also used by a re-created `place_counter_order`) and the approver (Open point 21).
- **Merge direction:** `merge_bills` refuses a dine-in bill into a takeaway bill (Open point 22).
- **Replays answer like the first call:** a known `checkout_id` only for the same bill and branch (`bills.receipt_queued` keeps the first `receiptQueued`); a known `refund_id` with `refunds.slip_queued`.
- **Void bill without items** needs no approval (Open point 6). **Void item / void bill retries** are safe without a key: an already-voided item or bill answers `ok`.
- **ASCII on receipts.** `renderReceiptLines` maps `– — ‘ ’ “ ” • nbsp` to ASCII and anything else to `?` (the ZY301 cannot print it anyway).

## Global Constraints

- **Dev database first.** Every SQL file here is applied on `craft-os-dev` (ref `egznnbjmicebbhwasloy`) by the controller in the browser (Task 5) and verified there; prod (`yfsoesxzurzjdwstszru`) is a separate, later step the owner decides. The seed files never run on prod (their guard stops on any database without the dev test login). The worktree's `.env.local` points at dev.
- All UI copy, field names and error messages in English (`english-product-copy` rule); comments may be Chinese or English, matching surrounding files.
- Money is integer sen; SST and service charge are basis points (600 = 6 %). **Totals are computed on the server** (`pos_bill_totals` → `pos_compute_bill`); the client never sends a price or a total. `computeBill` mirrors `pos_compute_bill` and both are tested against `billVectors.json` (Vitest) and its copy in the verify script.
- Every `security definer` function pins `set search_path = public, pg_temp`, revokes execute from `public, anon` (internal helpers also from `authenticated`) and grants only what is needed; new `security invoker` functions pin `search_path` too. pgcrypto is called schema-qualified (`extensions.crypt`, `extensions.gen_salt`).
- PIN hashes live only in `staff_pos_pins`: RLS on, **no policies**, all table privileges revoked from `anon` and `authenticated`. The approver PIN is checked **inside** each protected RPC — never a separate "is this PIN right?" call. 5 wrong PINs lock that approver for 10 minutes.
- Idempotency keys: `bills.checkout_id` (checkout) and `refunds.id` (refund) are generated on the iPad once per sheet/dialog, so a retry after a lost reply returns the first result. `client_order_id` stays as in Sub-plan 2.
- A staff member counts as live only when `is_active and status = 'active'` (`status = 'resigned'` is what Craft OS uses to end access).
- Every step that reads or writes the dev database is marked **(controller)**; implementers run only local commands (`grep`, `tsc`, `vitest`, `node`) and commit.
- Permission helper is `has_menu_cap(p_cap)` (mirrors `buildRoleCaps`: the Owner's override in `system_role_permissions` wins over the default); `staff_has_cap(staff_id, cap)` is the same rule for any staff member. Any signed-in staff member with a `branch_id` may check out, move, merge, open a table and reprint; voids and refunds need an approver with `pos_supervise`; POS settings need `access_settings`.
- Every write whose success is shown to a user goes through `writeOutcome` (`src/shared/lib/db-write.ts`) with `.select()`, or is an RPC whose error is thrown (`{ok:false}` replies are thrown by `unwrapAction`).
- Payloads built in SQL have exactly the TypeScript shapes: `TicketPayload` (`ticket.ts`, now with optional `void: true`), `ReceiptPayload` and `RefundSlipPayload` (`receipt.ts`).
- Realtime subscriptions use a unique channel name per subscription (`crypto.randomUUID()`), filter by `branch_id`, and re-sweep on `SUBSCRIBED` and every 15 s (Phase 0 lesson). `bills` is added to `supabase_realtime`; `PosPage` refreshes on every bill INSERT/UPDATE.
- The print modules the Node agent loads (`ticket.ts`, `receipt.ts`, `printJob.ts`, `escpos.ts`, `printHost.ts`) import each other at runtime **with the `.ts` extension** (Node has no bundler; `allowImportingTsExtensions` is on). Type-only imports may omit it.
- Receipts are ASCII only and 48 columns on the ZY301 (the agent's `TICKET_COLS=48`); the iPad host renders browser-printer jobs at `TICKET_COLS` (42).
- The repo has no ESLint config (pre-existing) — lint steps are skipped; `npx tsc -b` and `npx vitest run` are the gates. `tools/` is not type-checked by `tsc -b`; the agent is checked with `node --check` and a module-graph import.
- Every commit ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work in the worktree `/Users/USER/Desktop/Craft_OS/.claude/worktrees/pos-demo`, branch `feature/pos-demo`.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migration-2026-10-24-pos-checkout.sql` | Tables `branch_pos_settings`, `service_charge_rules`, `payment_methods`, `reason_templates`, `payments`, `refunds`, `staff_pos_pins`; columns on `branches`, `bills`, `order_items`; RLS; `bills` on Realtime; `has_menu_cap` + `staff_has_cap` with `pos_supervise` (Task 3) |
| `supabase/migration-2026-10-24-pos-checkout-fn.sql` | `pos_my_branch`, `pos_compute_bill`, `pos_bill_totals`, re-created `pos_insert_order`, `place_counter_order` and `place_table_order`, `pos_receipt_payload`, `pos_queue_receipt`, `pos_checkout_result`, `checkout_bill`, `reprint_receipt`, `save_receipt_settings` |
| `supabase/migration-2026-10-24-pos-bill-actions-fn.sql` | `pos_approvers`, `pos_pin_attempt`, `set_my_pos_pin`, `clear_pos_pin`, `pos_check_approver`, `pos_check_reason`, `pos_queue_void_tickets`, `void_order_item`, `void_bill`, `move_bill`, `merge_bills`, `pos_refund_slip_payload`, `refund_bill`, `open_table` |
| `supabase/migration-2026-10-24-pos-checkout-verify.sql` | Self-check of the three files (rolled back), with the shared vectors |
| `supabase/seed-2026-10-24-pos-checkout-demo.sql` | Dev-only: Demo branch receipt header, receipt route `Bar`, 10 % dine-in rule, four payment methods, reason templates |
| `src/features/pos/checkout/billVectors.json` | Shared totals vectors (Vitest + verify script) |
| `src/features/pos/checkout/bill.ts` (+test) | Pure `computeBill`, `roundingDeltaSen`, `formatRate` |
| `src/features/pos/checkout/rpcResult.ts` (+test) | `unwrapAction`, `parseCheckoutResult` |
| `src/features/pos/checkout/tender.ts` (+test) | Split tender: `parseRinggit`, `remainingSen`, `changeSen`, `quickTenders`, `lineProblem`, `payProblem`, `toPayments` |
| `src/features/pos/checkout/reasons.ts` (+test) | `reasonProblem` (same words as `pos_check_reason`), `DEFAULT_TEMPLATE`, `ACTION_TITLES` |
| `src/features/pos/checkout/todayBills.ts` (+test) | `mytDayStartIso`, `refundableSen`, `STATUS_LABEL` |
| `src/features/pos/checkout/settingsForm.ts` (+test) | `parsePercentBp`, `bpToPercentText`, `parseReasons`, `receiptDetailsProblem`, `scopeLabel` |
| `src/features/pos/checkout/checkoutApi.ts` | Supabase calls: totals, checkout, reprint, approvers, PIN, voids, move, merge, refund, open table, closed bills, settings |
| `src/features/pos/checkout/CheckoutSheet.tsx` | Checkout: server totals, methods, amount, quick tender, references, split tender, Pay, change screen |
| `src/features/pos/checkout/ApprovalDialog.tsx` | Reason picker + approver picker + PIN pad |
| `src/features/pos/checkout/BillPickers.tsx` | `PickerSheet` for Move table / Merge with… |
| `src/features/pos/checkout/TodayBillsDrawer.tsx` | Today's paid/voided/merged bills; Reprint receipt; Refund |
| `src/features/pos/checkout/MyPinDialog.tsx` | Set or change my POS PIN |
| `src/features/pos/checkout/CheckoutSettings.tsx` | POS settings sections: Receipt, Service charge, Payment methods, Reasons, Approvers |
| `src/features/pos/print/receipt.ts` (+test) | `ReceiptPayload`, `RefundSlipPayload`, `renderReceiptLines`, `renderRefundSlipLines`, `toAscii`, `money` |
| `src/features/pos/print/printJob.ts` (+test) | `JobPayload`, `renderJobLines` dispatcher, `jobLabel` |
| `src/features/pos/print/ticket.ts` (+test), `printHost.ts`, `adapter.ts` (+test) | VOID banner; payload type `JobPayload`; browser printing through the dispatcher |
| `tools/print-agent/agent.ts` | Renders every job through `renderJobLines` |
| `src/features/pos/order/posApi.ts`, `usePosRealtime.ts` | Bill item fields for totals; bills on Realtime |
| `src/features/pos/order/BillPanel.tsx`, `PosPage.tsx`, `PrintHostPanel.tsx`, `PosSettingsPage.tsx` | Totals, Checkout, bill actions, header buttons, job labels, settings sections |
| `src/shared/types/index.ts`, `src/shared/types/capabilities.test.ts` | Capability `pos_supervise` |
| `src/shared/lib/nav.ts` | Nav label "POS Settings" |

---

### Task 1: Checkout schema, RLS and Realtime

**Files:**
- Create: `supabase/migration-2026-10-24-pos-checkout.sql`

**Interfaces:**
- Consumes: `branches`, `staff`, `bills`, `order_items`, `print_routes` (Sub-plan 2); `has_menu_cap(text)` (Sub-plan 1); pgcrypto in schema `extensions`.
- Produces (later tasks' SQL and TS select by these exact names):
  - `branches.receipt_title, legal_name, registration_no, sst_no, phone, email` (text, nullable)
  - `branch_pos_settings(branch_id pk, sst_registered bool, cash_rounding 'none'|'nearest_5_sen', receipt_route text, receipt_footer text, qr_requires_open_bill bool, updated_at)`
  - `service_charge_rules(id, branch_id, rate_bp, order_types text[], table_ids uuid[]|null, product_ids uuid[]|null, sort_order, is_active, created_at)`
  - `payment_methods(id, branch_id, name, kind 'cash'|'card'|'duitnow'|'ewallet'|'other', needs_reference, sort_order, is_active)` unique `(branch_id, name)`
  - `reason_templates(branch_id, action 'void_item'|'void_bill'|'refund', reasons text[], compulsory, allow_other)` pk `(branch_id, action)`
  - `payments(id, bill_id, branch_id, method_id, method_name, kind, amount_sen, tendered_sen, change_sen, reference, taken_by, taken_at, line_no)`
  - `refunds(id client-generated, bill_id, branch_id, amount_sen, method_id, method_name, reason, approved_by, created_by, created_at, slip_queued)`
  - `bills.status` adds `'merged'`; `bills.merged_into, checkout_id (unique index `bills_checkout_id_key`), refunded_sen, totals jsonb, receipt_queued boolean, void_reason, void_approved_by` — added as bare columns, constraints added by name only when missing, so a re-run adds nothing twice
  - `order_items.takeaway_fee_sen int not null default 0`, `order_items.void_approved_by`
  - `staff_pos_pins(staff_id pk, pin_hash, failed_attempts, locked_until, updated_at)` — RLS on, no policies, no grants

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================================
-- Craft OS — POS Phase 1 · Checkout, payments, receipts, voids, refunds (2026-10-24)
-- Run on craft-os-dev first, after the ordering migrations. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-24-pos-phase1-checkout.md
-- Design: docs/superpowers/specs/2026-10-23-pos-checkout-design.md §3
-- ============================================================================
create extension if not exists pgcrypto;

-- PINs are hashed with crypt()/gen_salt('bf'), called schema-qualified from
-- functions whose search_path is pinned to public — so pgcrypto must live in
-- the "extensions" schema (Supabase's default). Stop here if it does not.
do $$ begin
  if to_regprocedure('extensions.crypt(text,text)') is null then
    raise exception 'STOP: pgcrypto is not in schema "extensions" — the PIN functions call extensions.crypt()';
  end if;
end $$;

-- ── Receipt header per branch (managers edit on /pos/settings) ──────────────
alter table branches add column if not exists receipt_title    text;   -- e.g. "Craft Cafe - Cheras"; null = branches.name
alter table branches add column if not exists legal_name       text;
alter table branches add column if not exists registration_no  text;
alter table branches add column if not exists sst_no           text;
alter table branches add column if not exists phone            text;
alter table branches add column if not exists email            text;

-- ── POS settings, one row per branch (a missing row means the defaults) ─────
create table if not exists branch_pos_settings (
  branch_id              uuid primary key references branches(id),
  sst_registered         boolean not null default true,
  cash_rounding          text not null default 'nearest_5_sen' check (cash_rounding in ('none', 'nearest_5_sen')),
  receipt_route          text,                                          -- print route for receipts; null = none printed
  receipt_footer         text not null default 'This is an official receipt. Thank you for visiting us.',
  qr_requires_open_bill  boolean not null default false,
  updated_at             timestamptz not null default now()
);

-- ── Service charge: rules, first match per line in sort_order ──────────────
create table if not exists service_charge_rules (
  id           uuid primary key default gen_random_uuid(),
  branch_id    uuid not null references branches(id),
  rate_bp      integer not null check (rate_bp between 0 and 10000),
  order_types  text[] not null check (cardinality(order_types) > 0 and order_types <@ array['dine_in', 'takeaway']),
  table_ids    uuid[],                                                  -- null = every table
  product_ids  uuid[],                                                  -- null = every product
  sort_order   integer not null default 0,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);
create index if not exists service_charge_rules_branch_idx on service_charge_rules(branch_id, sort_order);

create table if not exists payment_methods (
  id               uuid primary key default gen_random_uuid(),
  branch_id        uuid not null references branches(id),
  name             text not null check (length(trim(name)) between 1 and 40),
  kind             text not null check (kind in ('cash', 'card', 'duitnow', 'ewallet', 'other')),
  needs_reference  boolean not null default false,
  sort_order       integer not null default 0,
  is_active        boolean not null default true,
  unique (branch_id, name)
);

create table if not exists reason_templates (
  branch_id    uuid not null references branches(id),
  action       text not null check (action in ('void_item', 'void_bill', 'refund')),
  reasons      text[] not null default '{}',
  compulsory   boolean not null default true,
  allow_other  boolean not null default true,
  primary key (branch_id, action)
);

-- ── Money in and out (written only by checkout_bill / refund_bill) ─────────
create table if not exists payments (
  id            uuid primary key default gen_random_uuid(),
  bill_id       uuid not null references bills(id),
  branch_id     uuid not null references branches(id),                 -- denormalised for day/shift reports
  method_id     uuid references payment_methods(id),
  method_name   text not null,                                          -- snapshot
  kind          text not null check (kind in ('cash', 'card', 'duitnow', 'ewallet', 'other')),
  amount_sen    integer not null check (amount_sen > 0),
  tendered_sen  integer,                                                -- cash only
  change_sen    integer not null default 0 check (change_sen >= 0),
  reference     text,
  taken_by      uuid references staff(id),
  taken_at      timestamptz not null default now(),
  line_no       integer not null default 1,                            -- order on the receipt (one checkout = one taken_at)
  check (tendered_sen is null or (kind = 'cash' and tendered_sen >= amount_sen)),
  check (change_sen = coalesce(tendered_sen - amount_sen, 0))
);
create index if not exists payments_bill_idx on payments(bill_id);
create index if not exists payments_branch_day_idx on payments(branch_id, taken_at);

create table if not exists refunds (
  id           uuid primary key,                                        -- client-generated: retries are safe
  bill_id      uuid not null references bills(id),
  branch_id    uuid not null references branches(id),
  amount_sen   integer not null check (amount_sen > 0),
  method_id    uuid references payment_methods(id),
  method_name  text not null,
  reason       text,
  approved_by  uuid not null references staff(id),
  created_by   uuid not null references staff(id),
  created_at   timestamptz not null default now(),
  slip_queued  boolean not null default false                          -- was a refund slip queued (repeated on a replay)
);
create index if not exists refunds_bill_idx on refunds(bill_id);

-- ── Bills: merged status, idempotent checkout, refunds, void audit ─────────
-- Bare columns first, constraints by name afterwards: a re-run adds nothing twice.
alter table bills drop constraint if exists bills_status_check;
alter table bills add constraint bills_status_check check (status in ('open', 'paid', 'voided', 'merged'));
alter table bills add column if not exists merged_into       uuid;
alter table bills add column if not exists checkout_id       uuid;
alter table bills add column if not exists refunded_sen      integer not null default 0;
alter table bills add column if not exists totals            jsonb;     -- pos_bill_totals() at checkout: groups for the receipt's charges summary
alter table bills add column if not exists receipt_queued    boolean;   -- set by checkout_bill: was a receipt job queued
alter table bills add column if not exists void_reason       text;
alter table bills add column if not exists void_approved_by  uuid;

-- ── Order items: takeaway fee snapshot, void approver ──────────────────────
alter table order_items add column if not exists takeaway_fee_sen  integer not null default 0;
alter table order_items add column if not exists void_approved_by  uuid;

create unique index if not exists bills_checkout_id_key on bills(checkout_id);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bills_merged_into_fkey') then
    alter table bills add constraint bills_merged_into_fkey foreign key (merged_into) references bills(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bills_void_approved_by_fkey') then
    alter table bills add constraint bills_void_approved_by_fkey foreign key (void_approved_by) references staff(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bills_refunded_sen_check') then
    alter table bills add constraint bills_refunded_sen_check check (refunded_sen >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'order_items_void_approved_by_fkey') then
    alter table order_items add constraint order_items_void_approved_by_fkey foreign key (void_approved_by) references staff(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'order_items_takeaway_fee_sen_check') then
    alter table order_items add constraint order_items_takeaway_fee_sen_check check (takeaway_fee_sen >= 0);
  end if;
end $$;

-- ── Staff POS PINs: bcrypt hashes nobody can read ──────────────────────────
create table if not exists staff_pos_pins (
  staff_id         uuid primary key references staff(id) on delete cascade,
  pin_hash         text not null,                                       -- extensions.crypt(pin, extensions.gen_salt('bf'))
  failed_attempts  integer not null default 0,
  locked_until     timestamptz,
  updated_at       timestamptz not null default now()
);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Every signed-in staff member reads the checkout tables (one shop). Payments and
-- refunds are written only by the security-definer RPCs; settings tables by
-- access_settings holders; branch_pos_settings only through save_receipt_settings.
do $$
declare t text;
begin
  foreach t in array array['branch_pos_settings','service_charge_rules','payment_methods',
                           'reason_templates','payments','refunds']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists pos_read on %I', t);
    execute format('create policy pos_read on %I for select to authenticated using (true)', t);
  end loop;
end $$;

drop policy if exists service_charge_rules_manage on service_charge_rules;
create policy service_charge_rules_manage on service_charge_rules for all to authenticated
  using (has_menu_cap('access_settings')) with check (has_menu_cap('access_settings'));
drop policy if exists payment_methods_manage on payment_methods;
create policy payment_methods_manage on payment_methods for all to authenticated
  using (has_menu_cap('access_settings')) with check (has_menu_cap('access_settings'));
drop policy if exists reason_templates_manage on reason_templates;
create policy reason_templates_manage on reason_templates for all to authenticated
  using (has_menu_cap('access_settings')) with check (has_menu_cap('access_settings'));

-- PIN hashes: RLS on, no policy at all, and no table privilege either
alter table staff_pos_pins enable row level security;
revoke all on staff_pos_pins from public, anon, authenticated;

-- ── Realtime: every iPad sees a bill close, move or merge ──────────────────
do $$ begin alter publication supabase_realtime add table bills;
exception when duplicate_object then null; end $$;

select 'checkout schema applied' as result;
```

- [ ] **Step 2: Local sanity checks (no database).** Run: `grep -c "create table if not exists" supabase/migration-2026-10-24-pos-checkout.sql` — Expected: `7`. Run: `grep -c "add column if not exists" supabase/migration-2026-10-24-pos-checkout.sql` — Expected: `15`. Run: `grep -c "if not exists (select 1 from pg_constraint" supabase/migration-2026-10-24-pos-checkout.sql` — Expected: `5`. Run: `grep -c "add column if not exists.*references" supabase/migration-2026-10-24-pos-checkout.sql` — Expected: `0` (foreign keys are added by name, not inline). Run: `grep -n "create policy" supabase/migration-2026-10-24-pos-checkout.sql | grep -c staff_pos_pins` — Expected: `0` (PIN hashes have no policy at all).

- [ ] **Step 3: Commit**

```bash
git add supabase/migration-2026-10-24-pos-checkout.sql
git commit -m "feat(pos-checkout): checkout schema — settings, service-charge rules, payment methods, reasons, payments, refunds, PIN hashes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

The migration is applied to dev by the controller in Task 5 together with the functions.

---

### Task 2: Totals, checkout and receipt RPCs (+ `pos_insert_order` / `place_counter_order` / `place_table_order` re-created)

**Files:**
- Create: `supabase/migration-2026-10-24-pos-checkout-fn.sql`

**Interfaces:**
- Consumes: Task 1 tables; `pos_next_bill_no(uuid)`, `bills`, `orders`, `order_items`, `print_jobs`, `dining_tables`, `menu_*` (Sub-plan 2); `has_menu_cap(text)`.
- Produces (called by Tasks 4, 5, 8 and the print hosts):
  - `pos_my_branch() returns uuid` — internal; the caller must be `is_active and status = 'active'` (a resigned person keeps `is_active = true`); raises `Sign in required` / `Your account is not active` / `Your account has no branch — ask a manager to set it in Team`
  - `pos_compute_bill(p_input jsonb) returns jsonb` — pure; staff may call; input/output exactly as `BillInput` / `BillTotals` in `src/features/pos/checkout/bill.ts` (Task 6)
  - `pos_bill_totals(p_bill_id uuid) returns jsonb` — `BillTotals` of a real bill; staff
  - `pos_insert_order(...)` and `place_table_order(text, integer, jsonb, uuid)` — same signatures as Sub-plan 2; changed only as the diff in Step 2 shows
  - `place_counter_order(uuid, text, integer, jsonb, uuid)` — same signature; now takes the branch from `pos_my_branch()`, so a resigned cashier is refused
  - `pos_receipt_payload(p_bill_id uuid, p_reprint boolean) returns jsonb` — internal; exactly `ReceiptPayload` (`src/features/pos/print/receipt.ts`, Task 7)
  - `pos_queue_receipt(p_bill_id uuid, p_reprint boolean) returns boolean`, `pos_checkout_result(p_bill_id uuid) returns jsonb` — internal
  - `checkout_bill(p_bill_id uuid, p_payments jsonb, p_checkout_id uuid) returns jsonb` → `{ billId, billNo, totalSen, changeSen, receiptQueued }` (`receiptQueued` is stored in `bills.receipt_queued`); payments `[{ methodId, amountSen, tenderedSen|null, reference|null }]`; a known `checkout_id` replays only for the same bill of the caller's branch; staff
  - `reprint_receipt(p_bill_id uuid) returns void` — staff
  - `save_receipt_settings(p jsonb) returns void` — `access_settings`; `receiptTitle` required; optional keys `legalName, registrationNo, sstNo, address, phone, email, footer, receiptRoute, sstRegistered, cashRounding, qrRequiresOpenBill` — an absent key leaves its column unchanged
  - Error words the UI shows: `Your account is not active`, `This checkout id belongs to another bill`, `Payments (RM x) do not match the total (RM y)`, `Only cash can be tendered above the amount`, `Cash received is less than the amount`, `Enter the reference for <method>`, `Payment method is not available at this branch`, `Invalid payment amount`, `This bill is already paid|voided|merged into another bill`, `This bill has no items to pay for`, `No receipt printer is set — choose one in POS settings`, `Please ask our staff to open your table before ordering.`

- [ ] **Step 1: Write the functions.** `pos_insert_order` and `place_table_order` below are the live text of `supabase/migration-2026-10-23-pos-ordering-fn.sql` with only the marked "Sub-plan 3" lines added; `place_counter_order` is shortened to call `pos_my_branch()` (same error words, plus the resigned check)`.

```sql
-- ============================================================================
-- Craft OS — POS Phase 1 · Checkout RPCs (2026-10-24). Run after
-- migration-2026-10-24-pos-checkout.sql. Idempotent.
-- Totals (pos_compute_bill) are mirrored by computeBill in
-- src/features/pos/checkout/bill.ts; both are tested against the same vectors.
-- ============================================================================

-- ── The caller's branch (every POS RPC works inside it) ─────────────────────
-- A resigned person keeps is_active = true (see migration-2026-09-02's staff_guard
-- comment): status = 'resigned' is what really ends access, so both are checked.
create or replace function pos_my_branch() returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid;
  v_live   boolean;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select branch_id, (is_active and status = 'active') into v_branch, v_live from staff where id = auth.uid();
  if not coalesce(v_live, false) then raise exception 'Your account is not active'; end if;
  if v_branch is null then
    raise exception 'Your account has no branch — ask a manager to set it in Team';
  end if;
  return v_branch;
end $$;
revoke all on function pos_my_branch() from public, anon, authenticated;

-- ── Totals: pure. Same input and output shape as computeBill (bill.ts) ──────
-- input:  { orderType, tableId, sstRegistered, cashRounding,
--           rules: [{ rateBp, orderTypes[], tableIds[]|null, productIds[]|null }]   (sort order: first match wins)
--           lines: [{ productId, unitPriceSen, qty, sstRateBp, takeawayFeeSen, voided }] }
-- output: { subtotalSen, serviceChargeSen, sstSen, takeawayFeeSen, beforeRoundingSen, roundingSen, totalSen,
--           sstGroups: [{ rateBp, baseSen, amountSen }], serviceChargeGroups: [...] }   (non-zero rates, ascending)
-- Service charge and SST are both on the line amounts (SST is not charged on the
-- service charge — receipt #87846), rounded half-up per rate group.
create or replace function pos_compute_bill(p_input jsonb) returns jsonb
language sql immutable security invoker set search_path = public, pg_temp as $$
  with lines as (
    select (x.l->>'productId') as product_id,
           (x.l->>'unitPriceSen')::bigint * (x.l->>'qty')::bigint as amount,
           (x.l->>'sstRateBp')::integer as sst_bp,
           coalesce((x.l->>'takeawayFeeSen')::bigint, 0) * (x.l->>'qty')::bigint as fee
      from jsonb_array_elements(coalesce(p_input->'lines', '[]'::jsonb)) as x(l)
     where not coalesce((x.l->>'voided')::boolean, false)
  ),
  rated as (
    select ln.*,
           (select (rr.rule->>'rateBp')::integer
              from jsonb_array_elements(coalesce(p_input->'rules', '[]'::jsonb)) with ordinality as rr(rule, ord)
             where (rr.rule->'orderTypes') ? (p_input->>'orderType')
               and (jsonb_typeof(rr.rule->'tableIds') is distinct from 'array'
                    or (p_input->>'tableId' is not null and (rr.rule->'tableIds') ? (p_input->>'tableId')))
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
  sst as (
    select sst_bp as rate_bp, sum(amount) as base, round(sum(amount) * sst_bp / 10000.0) as amt
      from lines
     where sst_bp > 0 and coalesce((p_input->>'sstRegistered')::boolean, true)
     group by sst_bp
  ),
  t as (
    select coalesce((select sum(amount) from lines), 0) as subtotal,
           coalesce((select sum(amt) from sc), 0) as sc_total,
           coalesce((select sum(amt) from sst), 0) as sst_total,
           case when p_input->>'orderType' = 'takeaway' then coalesce((select sum(fee) from lines), 0) else 0 end as fee_total
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

-- ── Totals of a real bill (checkout preview; checkout_bill uses it too) ────
-- security invoker: everything it reads is readable through the pos_read policies.
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
                                          'voided', oi.voided_at is not null) order by oi.id)
        from order_items oi where oi.bill_id = b.id), '[]'::jsonb)))
  from bills b
  left join branch_pos_settings s on s.branch_id = b.branch_id
  where b.id = p_bill_id
$$;
revoke all on function pos_bill_totals(uuid) from public, anon;
grant execute on function pos_bill_totals(uuid) to authenticated;

-- ── pos_insert_order, re-created: Sub-plan 2's function with one change — a
--    takeaway bill's items snapshot menu_products.takeaway_fee_sen ──────────
create or replace function pos_insert_order(
  p_branch_id uuid, p_table_id uuid, p_order_type text, p_pax integer,
  p_source text, p_placed_by uuid, p_items jsonb, p_client_order_id uuid
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_existing   uuid;
  v_bill_id    uuid;
  v_bill_no    text;
  v_order_id   uuid;
  v_order_no   text;
  v_label      text;
  v_item       jsonb;
  v_opt_id     uuid;
  v_opt_ids    uuid[];
  v_prod       menu_products;
  v_var        menu_variants;
  v_opt_row    record;
  v_grp        record;
  v_qty        numeric;
  v_n          integer;
  v_price      integer;
  v_mods       jsonb;
  v_allowed    text[] := case when p_source = 'qr' then array['all'] else array['all', 'counter_only'] end;
begin
  if p_client_order_id is null then
    raise exception 'Order id is missing';
  end if;
  select id into v_existing from orders where client_order_id = p_client_order_id;
  if v_existing is not null then
    return v_existing;                         -- resend: already in
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Order has no items';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception 'Too many items in one order';
  end if;
  if p_order_type is null or p_order_type not in ('dine_in', 'takeaway') then
    raise exception 'Invalid order type';
  end if;
  if (p_order_type = 'dine_in') <> (p_table_id is not null) then
    raise exception 'Dine-in orders need a table; takeaway orders have none';
  end if;
  if p_pax is not null and (p_pax < 1 or p_pax > 99) then
    raise exception 'Invalid number of guests';
  end if;

  -- ── validate every line before writing anything (bad input is always P0001 = final) ──
  for v_item in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object'
       or jsonb_typeof(v_item->'productId') is distinct from 'string'
       or jsonb_typeof(v_item->'variantId') is distinct from 'string'
       or (v_item->>'productId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or (v_item->>'variantId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Invalid item';
    end if;
    select * into v_prod from menu_products
     where id = (v_item->>'productId')::uuid and is_active and not is_addon;
    if not found or not (v_prod.availability = any (v_allowed)) then
      raise exception 'Item is not available: %', coalesce(v_prod.name, v_item->>'productId');
    end if;
    if exists (select 1 from branch_menu_status s
                where s.branch_id = p_branch_id and s.product_id = v_prod.id and s.is_sold_out) then
      raise exception 'Sold out: %', v_prod.name;
    end if;
    select * into v_var from menu_variants
     where id = (v_item->>'variantId')::uuid and product_id = v_prod.id and is_active;
    if not found then
      raise exception 'Item is not available: %', v_prod.name;
    end if;
    if v_item->'qty' is not null then
      if jsonb_typeof(v_item->'qty') <> 'number' then raise exception 'Invalid quantity'; end if;
      v_qty := (v_item->'qty')::numeric;
      if v_qty < 1 or v_qty > 20 or v_qty <> trunc(v_qty) then raise exception 'Invalid quantity'; end if;
    end if;
    if v_item->'optionIds' is not null and jsonb_typeof(v_item->'optionIds') <> 'array' then
      raise exception 'Invalid add-ons';
    end if;
    -- each option must be a well-formed uuid string, appear once (compared as uuids, so
    -- letter case cannot sneak a duplicate past), belong to a group linked to this
    -- product, and be orderable here
    if exists (select 1 from jsonb_array_elements(coalesce(v_item->'optionIds', '[]'::jsonb)) e
                where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      raise exception 'Invalid add-ons';
    end if;
    select coalesce(array_agg(x.v::uuid), '{}') into v_opt_ids
      from jsonb_array_elements_text(coalesce(v_item->'optionIds', '[]'::jsonb)) as x(v);
    if cardinality(v_opt_ids) <> (select count(distinct u) from unnest(v_opt_ids) u) then
      raise exception 'Invalid add-ons';
    end if;
    foreach v_opt_id in array v_opt_ids loop
      select o.id, o.name, o.availability, o.product_id, g.name as group_name into v_opt_row
        from modifier_options o
        join modifier_groups g on g.id = o.group_id and g.is_active
        join product_modifier_groups pmg on pmg.group_id = g.id and pmg.product_id = v_prod.id
       where o.id = v_opt_id;
      if not found then
        raise exception 'Add-on is not available for %', v_prod.name;
      end if;
      if not (v_opt_row.availability = any (v_allowed))
         or exists (select 1 from branch_menu_status s
                     where s.branch_id = p_branch_id and s.product_id = v_opt_row.product_id and s.is_sold_out) then
        raise exception 'Sold out: %', v_opt_row.name;
      end if;
    end loop;
    -- per linked group: min..max
    for v_grp in
      select g.name, g.min_select, g.max_select,
             (select count(*) from modifier_options o
               where o.group_id = g.id
                 and o.id = any (v_opt_ids)) as chosen
        from product_modifier_groups pmg join modifier_groups g on g.id = pmg.group_id and g.is_active
       where pmg.product_id = v_prod.id
    loop
      if v_grp.chosen < v_grp.min_select then
        raise exception 'Choose at least % for %: %', v_grp.min_select, v_prod.name, v_grp.name;
      end if;
      if v_grp.chosen > v_grp.max_select then
        raise exception 'Choose at most % for %: %', v_grp.max_select, v_prod.name, v_grp.name;
      end if;
    end loop;
  end loop;

  -- ── bill + order share one savepoint: a concurrent resend that wins the
  --    client_order_id race rolls both back, so no orphan bill is left ──
  begin
    if p_table_id is not null then
      select label into v_label from dining_tables
       where id = p_table_id and branch_id = p_branch_id and is_active;
      if not found then raise exception 'Invalid table'; end if;
      select id, bill_no into v_bill_id, v_bill_no from bills
       where table_id = p_table_id and status = 'open';
      if v_bill_id is null then
        v_bill_no := pos_next_bill_no(p_branch_id);
        insert into bills(branch_id, bill_no, table_id, order_type, pax)
        values (p_branch_id, v_bill_no, p_table_id, 'dine_in', p_pax)
        on conflict (table_id) where status = 'open' and table_id is not null do nothing
        returning id into v_bill_id;
        if v_bill_id is null then                 -- lost the race: use the winner's bill
          select id, bill_no into v_bill_id, v_bill_no from bills
           where table_id = p_table_id and status = 'open';
        end if;
      elsif p_pax is not null then
        update bills set pax = p_pax where id = v_bill_id and pax is null;
      end if;
    else
      v_bill_no := pos_next_bill_no(p_branch_id);
      insert into bills(branch_id, bill_no, table_id, order_type, pax)
      values (p_branch_id, v_bill_no, null, 'takeaway', p_pax)
      returning id into v_bill_id;
    end if;

    -- serialise order numbering on this bill, and refuse a bill that was closed meanwhile
    perform 1 from bills where id = v_bill_id and status = 'open' for update;
    if not found then
      raise exception 'This bill was just closed. Please send the order again.';
    end if;
    select count(*) + 1 into v_n from orders where bill_id = v_bill_id;
    v_order_no := v_bill_no || '/' || v_n;
    insert into orders(bill_id, branch_id, order_no, source, placed_by, client_order_id)
    values (v_bill_id, p_branch_id, v_order_no, p_source, p_placed_by, p_client_order_id)
    returning id into v_order_id;
  exception when unique_violation then
    select id into v_order_id from orders where client_order_id = p_client_order_id;
    if v_order_id is not null then return v_order_id; end if;
    raise;
  end;

  -- ── items: snapshot name, price, SST and modifiers from the menu ──
  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from menu_products where id = (v_item->>'productId')::uuid;
    select * into v_var  from menu_variants where id = (v_item->>'variantId')::uuid;
    select coalesce(jsonb_agg(jsonb_build_object(
             'optionId', o.id, 'group', g.name, 'name', o.name,
             'priceDeltaSen', o.price_delta_sen, 'route', ap.print_route)
             order by pmg.sort_order, g.name, o.sort_order, o.name), '[]'::jsonb),
           coalesce(sum(o.price_delta_sen), 0)
      into v_mods, v_price
      from jsonb_array_elements_text(coalesce(v_item->'optionIds', '[]'::jsonb)) as x(v)
      join modifier_options o on o.id = x.v::uuid
      join modifier_groups g on g.id = o.group_id
      join product_modifier_groups pmg on pmg.group_id = g.id and pmg.product_id = v_prod.id
      left join menu_products ap on ap.id = o.product_id;
    insert into order_items(order_id, bill_id, product_id, variant_id, name_snapshot, unit_price_sen,
                            sst_rate_bp, modifiers_snapshot, print_route, qty, note, takeaway_fee_sen)
    values (v_order_id, v_bill_id, v_prod.id, v_var.id,
            v_prod.name || case when v_var.feedme_variant_key <> '' then ' (' || v_var.name || ')' else '' end,
            v_var.price_sen + v_price, v_prod.sst_rate_bp, v_mods, v_prod.print_route,
            coalesce((v_item->'qty')::numeric::integer, 1),
            nullif(trim(left(case when jsonb_typeof(v_item->'note') = 'string' then v_item->>'note' end, 200)), ''),
            -- Sub-plan 3: the packaging fee is fixed when the item is ordered (takeaway bills only)
            case when p_order_type = 'takeaway' then v_prod.takeaway_fee_sen else 0 end);
  end loop;

  -- ── tickets: one job per route, shaped exactly like TicketPayload (ticket.ts) ──
  insert into print_jobs(branch_id, order_id, route, kind, payload)
  select p_branch_id, v_order_id, l.route, 'ticket', jsonb_build_object(
           'kind', 'ticket', 'route', l.route, 'tableLabel', v_label, 'orderNo', v_order_no,
           'source', p_source,
           'placedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'lines', jsonb_agg(jsonb_build_object('qty', l.qty, 'name', l.name, 'note', l.note, 'mods', l.mods)
                              order by l.kind_order, l.name))
    from (
      -- the item on its own route, modifiers as sub-lines
      select oi.print_route as route, 1 as kind_order, oi.name_snapshot as name, oi.qty, oi.note,
             coalesce((select jsonb_agg(m->>'name' order by ord)
                         from jsonb_array_elements(oi.modifiers_snapshot) with ordinality as x(m, ord)), '[]'::jsonb) as mods
        from order_items oi
       where oi.order_id = v_order_id and oi.print_route is not null
      union all
      -- a modifier whose add-on product prints somewhere else gets its own line there
      select m->>'route', 2, m->>'name', oi.qty, 'for ' || oi.name_snapshot, '[]'::jsonb
        from order_items oi cross join jsonb_array_elements(oi.modifiers_snapshot) m
       where oi.order_id = v_order_id and m->>'route' is not null
         and m->>'route' is distinct from oi.print_route
    ) l
   group by l.route;

  return v_order_id;
end $$;
revoke all on function pos_insert_order(uuid, uuid, text, integer, text, uuid, jsonb, uuid) from public, anon, authenticated;

-- ── place_counter_order, re-created: Sub-plan 2's function with one change — the
--    caller is checked by pos_my_branch(), so a resigned person can no longer order ─
create or replace function place_counter_order(
  p_table_id uuid, p_order_type text, p_pax integer, p_items jsonb, p_client_order_id uuid
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return pos_insert_order(pos_my_branch(), p_table_id, p_order_type, p_pax, 'counter', auth.uid(), p_items, p_client_order_id);
end $$;
revoke all on function place_counter_order(uuid, text, integer, jsonb, uuid) from public, anon;
grant execute on function place_counter_order(uuid, text, integer, jsonb, uuid) to authenticated;

-- ── place_table_order, re-created: Sub-plan 2's function with one change — the
--    branch switch qr_requires_open_bill refuses a table that staff have not opened ─
create or replace function place_table_order(p_token text, p_pax integer, p_items jsonb, p_client_order_id uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_table   dining_tables;
  v_recent  integer;
  v_existing uuid;
begin
  select * into v_table from dining_tables where qr_token = p_token;
  if not found then raise exception 'Invalid table code'; end if;
  -- resend of an order that already went in: return it even if the table was paused since
  select id into v_existing from orders where client_order_id = p_client_order_id;
  if v_existing is not null then return v_existing; end if;
  if not v_table.is_active then raise exception 'Invalid table code'; end if;
  if v_table.qr_paused then
    raise exception 'Ordering is paused for this table. Please order at the counter.';
  end if;
  -- Sub-plan 3: with the branch switch on, a table orders by QR only after staff open it
  if coalesce((select s.qr_requires_open_bill from branch_pos_settings s where s.branch_id = v_table.branch_id), false)
     and not exists (select 1 from bills b where b.table_id = v_table.id and b.status = 'open') then
    raise exception 'Please ask our staff to open your table before ordering.';
  end if;
  select count(*) into v_recent
    from orders o join bills b on b.id = o.bill_id
   where b.table_id = v_table.id and o.source = 'qr' and o.placed_at > now() - interval '1 minute';
  if v_recent >= 5 then
    raise exception 'Too many orders from this table. Please wait a minute.';
  end if;
  return pos_insert_order(v_table.branch_id, v_table.id, 'dine_in', p_pax, 'qr', null, p_items, p_client_order_id);
end $$;
revoke all on function place_table_order(text, integer, jsonb, uuid) from public;
grant execute on function place_table_order(text, integer, jsonb, uuid) to anon, authenticated;

-- ── Receipt payload: exactly the shape of ReceiptPayload (src/features/pos/print/receipt.ts) ─
create or replace function pos_receipt_payload(p_bill_id uuid, p_reprint boolean) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'kind', 'receipt',
    'route', s.receipt_route,
    'reprint', p_reprint,
    'header', jsonb_build_object(
      'title', coalesce(nullif(trim(br.receipt_title), ''), br.name),
      'legalName', nullif(trim(br.legal_name), ''),
      'registrationNo', nullif(trim(br.registration_no), ''),
      'sstNo', nullif(trim(br.sst_no), ''),
      'address', nullif(trim(br.address), ''),
      'phone', nullif(trim(br.phone), ''),
      'email', nullif(trim(br.email), '')),
    'billNo', b.bill_no,
    'closedAt', to_char(b.closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'cashier', (select st.name from staff st where st.id = b.closed_by),
    'tableLabel', t.label,
    'pax', b.pax,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'qty', oi.qty, 'name', oi.name_snapshot, 'unitSen', oi.unit_price_sen,
               'amountSen', oi.unit_price_sen * oi.qty,
               'mods', (select coalesce(jsonb_agg(m->>'name' order by ord), '[]'::jsonb)
                          from jsonb_array_elements(oi.modifiers_snapshot) with ordinality as x(m, ord)))
             order by o.placed_at, oi.name_snapshot, oi.id)
        from order_items oi join orders o on o.id = oi.order_id
       where oi.bill_id = b.id and oi.voided_at is null), '[]'::jsonb),
    'itemCount', (select coalesce(sum(oi.qty), 0) from order_items oi where oi.bill_id = b.id and oi.voided_at is null),
    'subtotalSen', b.subtotal_sen,
    'sstGroups', coalesce(b.totals->'sstGroups', '[]'::jsonb),
    'serviceChargeGroups', coalesce(b.totals->'serviceChargeGroups', '[]'::jsonb),
    'takeawayFeeSen', b.takeaway_fee_sen,
    'roundingSen', b.rounding_sen,
    'totalSen', b.total_sen,
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object('name', p.method_name, 'kind', p.kind, 'amountSen', p.amount_sen,
                                          'tenderedSen', p.tendered_sen, 'reference', p.reference)
                       order by p.line_no, p.id)
        from payments p where p.bill_id = b.id), '[]'::jsonb),
    'changeSen', (select coalesce(sum(p.change_sen), 0) from payments p where p.bill_id = b.id),
    'footer', coalesce(s.receipt_footer, 'This is an official receipt. Thank you for visiting us.'))
  from bills b
  join branches br on br.id = b.branch_id
  left join branch_pos_settings s on s.branch_id = b.branch_id
  left join dining_tables t on t.id = b.table_id
  where b.id = p_bill_id
$$;
revoke all on function pos_receipt_payload(uuid, boolean) from public, anon, authenticated;

-- queue the receipt on the branch's receipt route; false = no receipt printer set
create or replace function pos_queue_receipt(p_bill_id uuid, p_reprint boolean) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_branch uuid; v_route text;
begin
  select b.branch_id, s.receipt_route into v_branch, v_route
    from bills b left join branch_pos_settings s on s.branch_id = b.branch_id
   where b.id = p_bill_id;
  if v_route is null then return false; end if;
  insert into print_jobs(branch_id, route, kind, payload)
  values (v_branch, v_route, 'receipt', pos_receipt_payload(p_bill_id, p_reprint));
  return true;
end $$;
revoke all on function pos_queue_receipt(uuid, boolean) from public, anon, authenticated;

-- what checkout_bill answers — also on a resend of the same checkout_id
create or replace function pos_checkout_result(p_bill_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'billId', b.id, 'billNo', b.bill_no, 'totalSen', b.total_sen,
    'changeSen', (select coalesce(sum(p.change_sen), 0) from payments p where p.bill_id = b.id),
    'receiptQueued', coalesce(b.receipt_queued, false))
  from bills b where b.id = p_bill_id
$$;
revoke all on function pos_checkout_result(uuid) from public, anon, authenticated;

-- ── Checkout: online only, idempotent on p_checkout_id ─────────────────────
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
begin
  if p_checkout_id is null then raise exception 'Checkout id is missing'; end if;
  -- a resend of a checkout that already went through gets the first answer —
  -- but only for the same bill of the caller's branch
  select * into v_bill from bills where checkout_id = p_checkout_id;
  if found then
    if v_bill.id <> p_bill_id or v_bill.branch_id <> v_branch then
      raise exception 'This checkout id belongs to another bill';
    end if;
    return pos_checkout_result(v_bill.id);
  end if;

  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  if v_bill.checkout_id is not distinct from p_checkout_id then  -- won by the same checkout while we waited
    return pos_checkout_result(v_bill.id);
  end if;
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
                         change_sen, reference, taken_by, line_no)
    values (v_bill.id, v_branch, v_m.id, v_m.name, v_m.kind, v_amount, v_tendered,
            coalesce(v_tendered - v_amount, 0),
            nullif(trim(left(case when jsonb_typeof(v_p->'reference') = 'string' then v_p->>'reference' end, 60)), ''),
            auth.uid(), v_n);
  end loop;

  update bills
     set status = 'paid', closed_at = now(), closed_by = auth.uid(), checkout_id = p_checkout_id,
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

-- ── Reprint: the same receipt again, marked REPRINT ────────────────────────
create or replace function reprint_receipt(p_bill_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_status text;
begin
  select status into v_status from bills where id = p_bill_id and branch_id = v_branch;
  if v_status is null then raise exception 'Bill not found'; end if;
  if v_status <> 'paid' then raise exception 'Only a paid bill has a receipt'; end if;
  if not pos_queue_receipt(p_bill_id, true) then
    raise exception 'No receipt printer is set — choose one in POS settings';
  end if;
end $$;
revoke all on function reprint_receipt(uuid) from public, anon;
grant execute on function reprint_receipt(uuid) to authenticated;

-- ── Receipt details + POS switches of the caller's branch (/pos/settings) ──
-- p: { receiptTitle, legalName, registrationNo, sstNo, address, phone, email, footer,
--      receiptRoute, sstRegistered, cashRounding, qrRequiresOpenBill }
create or replace function save_receipt_settings(p jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_route  text;
  v_round  text;
  v_footer constant text := 'This is an official receipt. Thank you for visiting us.';
begin
  if not has_menu_cap('access_settings') then
    raise exception 'Only a manager can change the receipt settings';
  end if;
  if jsonb_typeof(p) is distinct from 'object' then raise exception 'Invalid settings'; end if;
  if nullif(trim(p->>'receiptTitle'), '') is null then raise exception 'Enter the receipt title'; end if;
  v_route := nullif(trim(p->>'receiptRoute'), '');
  v_round := coalesce(p->>'cashRounding', 'nearest_5_sen');
  if v_round not in ('none', 'nearest_5_sen') then raise exception 'Invalid rounding setting'; end if;
  if v_route is not null and not exists (select 1 from print_routes where branch_id = v_branch and name = v_route) then
    raise exception 'No printer is set for route %', v_route;
  end if;
  -- a key that is absent leaves its column as it is (branches.address is shown all over Craft OS)
  update branches
     set receipt_title   = trim(p->>'receiptTitle'),
         legal_name      = case when p ? 'legalName'      then nullif(trim(p->>'legalName'), '')      else legal_name end,
         registration_no = case when p ? 'registrationNo' then nullif(trim(p->>'registrationNo'), '') else registration_no end,
         sst_no          = case when p ? 'sstNo'          then nullif(trim(p->>'sstNo'), '')          else sst_no end,
         address         = case when p ? 'address'        then nullif(trim(p->>'address'), '')        else address end,
         phone           = case when p ? 'phone'          then nullif(trim(p->>'phone'), '')          else phone end,
         email           = case when p ? 'email'          then nullif(trim(p->>'email'), '')          else email end
   where id = v_branch;
  insert into branch_pos_settings(branch_id) values (v_branch) on conflict (branch_id) do nothing;
  update branch_pos_settings
     set sst_registered        = case when p ? 'sstRegistered' then coalesce((p->>'sstRegistered')::boolean, sst_registered) else sst_registered end,
         cash_rounding         = case when p ? 'cashRounding' then v_round else cash_rounding end,
         receipt_route         = case when p ? 'receiptRoute' then v_route else receipt_route end,
         receipt_footer        = case when p ? 'footer' then coalesce(nullif(trim(left(p->>'footer', 300)), ''), v_footer) else receipt_footer end,
         qr_requires_open_bill = case when p ? 'qrRequiresOpenBill' then coalesce((p->>'qrRequiresOpenBill')::boolean, qr_requires_open_bill) else qr_requires_open_bill end,
         updated_at            = now()
   where branch_id = v_branch;
end $$;
revoke all on function save_receipt_settings(jsonb) from public, anon;
grant execute on function save_receipt_settings(jsonb) to authenticated;

select 'checkout functions applied' as result;
```

- [ ] **Step 2: Local sanity checks.** Run: `grep -c "create or replace function" supabase/migration-2026-10-24-pos-checkout-fn.sql` — Expected: `12`. Run: `grep -c "set search_path = public, pg_temp" supabase/migration-2026-10-24-pos-checkout-fn.sql` — Expected: `12`. Run: `grep -c "status = 'active'" supabase/migration-2026-10-24-pos-checkout-fn.sql` — Expected: `1` (in `pos_my_branch`, which every RPC of this file uses). Run: `grep -n "grant execute" supabase/migration-2026-10-24-pos-checkout-fn.sql | grep -c anon` — Expected: `1` (only `place_table_order`). Then prove the two re-created functions changed only where intended:

```bash
diff <(sed -n '/^create or replace function pos_insert_order/,/^revoke all on function pos_insert_order/p' supabase/migration-2026-10-23-pos-ordering-fn.sql) \
     <(sed -n '/^create or replace function pos_insert_order/,/^revoke all on function pos_insert_order/p' supabase/migration-2026-10-24-pos-checkout-fn.sql)
diff <(sed -n '/^create or replace function place_table_order/,/^grant execute on function place_table_order/p' supabase/migration-2026-10-23-pos-ordering-fn.sql) \
     <(sed -n '/^create or replace function place_table_order/,/^grant execute on function place_table_order/p' supabase/migration-2026-10-24-pos-checkout-fn.sql)
```

Expected output, exactly:

```text
186c186
<                             sst_rate_bp, modifiers_snapshot, print_route, qty, note)
---
>                             sst_rate_bp, modifiers_snapshot, print_route, qty, note, takeaway_fee_sen)
191c191,193
<             nullif(trim(left(case when jsonb_typeof(v_item->'note') = 'string' then v_item->>'note' end, 200)), ''));
---
>             nullif(trim(left(case when jsonb_typeof(v_item->'note') = 'string' then v_item->>'note' end, 200)), ''),
>             -- Sub-plan 3: the packaging fee is fixed when the item is ordered (takeaway bills only)
>             case when p_order_type = 'takeaway' then v_prod.takeaway_fee_sen else 0 end);
17a18,22
>   -- Sub-plan 3: with the branch switch on, a table orders by QR only after staff open it
>   if coalesce((select s.qr_requires_open_bill from branch_pos_settings s where s.branch_id = v_table.branch_id), false)
>      and not exists (select 1 from bills b where b.table_id = v_table.id and b.status = 'open') then
>     raise exception 'Please ask our staff to open your table before ordering.';
>   end if;
```

If the live `-fn.sql` changed since this plan was written, copy the live text again and re-apply only these lines.

- [ ] **Step 3: Commit**

```bash
git add supabase/migration-2026-10-24-pos-checkout-fn.sql
git commit -m "feat(pos-checkout): server totals, idempotent checkout and receipt jobs; takeaway fee snapshot and QR open-bill switch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Capability `pos_supervise` — "Approve POS voids & refunds" (TypeScript and SQL in one commit)

**Files:**
- Modify: `src/shared/types/index.ts` (Capability, CAPABILITIES, DEFAULT_SYSTEM_ROLE_CAPS)
- Modify: `supabase/migration-2026-10-24-pos-checkout.sql` (append the capability block before the final `select`)
- Test: `src/shared/types/capabilities.test.ts` (new — `grep -rln "CAPABILITIES\|DEFAULT_SYSTEM_ROLE_CAPS" src | grep test` finds only a comment in `src/features/tasks/Tasks.refresh.test.tsx`; no existing test enumerates the capabilities, so nothing else needs updating)

**Interfaces:**
- Consumes: `system_role_permissions`, `staff.system_role` (RBAC migration 2026-07-06).
- Produces: `Capability` gains `'pos_supervise'`; `CAPABILITIES` gains `{ key: 'pos_supervise', label: 'Approve POS voids & refunds' }` (so Settings → System Roles shows the column with no change to `Settings.tsx`); defaults owner/admin/manager/supervisor `true`, hr/staff `false`; SQL `has_menu_cap('pos_supervise')` and `staff_has_cap(p_staff_id uuid, p_cap text) returns boolean` (internal) with the same Owner-override merge.

- [ ] **Step 1: Write the failing test** `src/shared/types/capabilities.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { CAPABILITIES, DEFAULT_SYSTEM_ROLE_CAPS, SYSTEM_ROLES } from './index'

describe('capabilities', () => {
  it('every role has a default for every capability in the matrix', () => {
    for (const role of SYSTEM_ROLES) {
      for (const c of CAPABILITIES) expect(typeof DEFAULT_SYSTEM_ROLE_CAPS[role][c.key], `${role}.${c.key}`).toBe('boolean')
    }
  })

  it('pos_supervise is in the System Roles matrix with its label', () => {
    expect(CAPABILITIES.find((c) => c.key === 'pos_supervise')?.label).toBe('Approve POS voids & refunds')
  })

  it('pos_supervise defaults match has_menu_cap / staff_has_cap in SQL', () => {
    expect(Object.fromEntries(SYSTEM_ROLES.map((r) => [r, DEFAULT_SYSTEM_ROLE_CAPS[r].pos_supervise]))).toEqual({
      owner: true, admin: true, hr: false, manager: true, supervisor: true, staff: false,
    })
  })
})
```

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run src/shared/types/capabilities.test.ts` — Expected: FAIL (the label test finds no `pos_supervise`; `tsc` would also reject the key).

- [ ] **Step 3: Implement in TypeScript.** In `src/shared/types/index.ts` make exactly these replacements (each old text occurs once):

1. Replace:

```ts
  | 'manage_projects'  // create/edit/delete Projects; edit the Tasks tag vocabulary
```

   with:

```ts
  | 'manage_projects'  // create/edit/delete Projects; edit the Tasks tag vocabulary
  | 'pos_supervise'    // approve POS voids & refunds with a PIN (SQL: has_menu_cap / staff_has_cap)
```

2. Replace:

```ts
  { key: 'manage_system_roles', label: 'Manage System Roles' },
]
```

   with:

```ts
  { key: 'manage_system_roles', label: 'Manage System Roles' },
  { key: 'pos_supervise',       label: 'Approve POS voids & refunds' },
]
```

3. Replace:

```ts
    access_settings: true, manage_system_roles: true, manage_projects: true,
  },
  admin: {
```

   with:

```ts
    access_settings: true, manage_system_roles: true, manage_projects: true,
    pos_supervise: true,
  },
  admin: {
```

4. Replace:

```ts
    access_settings: true, manage_system_roles: false, manage_projects: true,
  },
  hr: {
```

   with:

```ts
    access_settings: true, manage_system_roles: false, manage_projects: true,
    pos_supervise: true,
  },
  hr: {
```

5. Replace:

```ts
    access_settings: false, manage_system_roles: false, manage_projects: true,
  },
  manager: {
```

   with:

```ts
    access_settings: false, manage_system_roles: false, manage_projects: true,
    pos_supervise: false,
  },
  manager: {
```

6. Replace:

```ts
    access_settings: true, manage_system_roles: false, manage_projects: true,
  },
  supervisor: {
```

   with:

```ts
    access_settings: true, manage_system_roles: false, manage_projects: true,
    pos_supervise: true,
  },
  supervisor: {
```

7. Replace:

```ts
    access_settings: false, manage_system_roles: false, manage_projects: true,
  },
  staff: {
```

   with:

```ts
    access_settings: false, manage_system_roles: false, manage_projects: true,
    pos_supervise: true,
  },
  staff: {
```

8. Replace:

```ts
    access_settings: false, manage_system_roles: false, manage_projects: false,
  },
}
```

   with:

```ts
    access_settings: false, manage_system_roles: false, manage_projects: false,
    pos_supervise: false,
  },
}
```

- [ ] **Step 4: Implement in SQL.** In `supabase/migration-2026-10-24-pos-checkout.sql` insert this block directly above the last line `select 'checkout schema applied' as result;` (the block keeps `has_menu_cap` exactly as in `migration-2026-10-22-pos-menu.sql` plus the one `pos_supervise` branch; `create or replace` keeps its existing grants):

```sql
-- ── Capability pos_supervise ("Approve POS voids & refunds") ─────────────────
-- Both functions mirror buildRoleCaps (src/shared/lib/lookups.tsx) over
-- DEFAULT_SYSTEM_ROLE_CAPS (src/shared/types/index.ts): the Owner's setting in
-- system_role_permissions wins over the default; rank is not consulted.
-- Change the three places together (the verify script checks the two SQL ones agree).
create or replace function has_menu_cap(p_cap text) returns boolean
language sql security definer stable set search_path = public, pg_temp as $$
  select coalesce((
    select coalesce(
      (select (srp.permissions ->> p_cap)::boolean
         from system_role_permissions srp
        where srp.system_role = s.system_role),
      case p_cap
        when 'access_settings' then s.system_role in ('owner','admin','manager')
        when 'pos_supervise'   then s.system_role in ('owner','admin','manager','supervisor')
        else false
      end)
    from staff s
    where s.id = auth.uid()
  ), false)
$$;

-- The same rule for any staff member: the approver of a void or refund is not
-- the signed-in cashier. Internal — called only by the POS RPCs.
create or replace function staff_has_cap(p_staff_id uuid, p_cap text) returns boolean
language sql security definer stable set search_path = public, pg_temp as $$
  select coalesce((
    select coalesce(
      (select (srp.permissions ->> p_cap)::boolean
         from system_role_permissions srp
        where srp.system_role = s.system_role),
      case p_cap
        when 'access_settings' then s.system_role in ('owner','admin','manager')
        when 'pos_supervise'   then s.system_role in ('owner','admin','manager','supervisor')
        else false
      end)
    from staff s
    where s.id = p_staff_id
  ), false)
$$;
revoke all on function staff_has_cap(uuid, text) from public, anon, authenticated;

```

- [ ] **Step 5: Run the tests.** Run: `npx vitest run src/shared/types` — Expected: PASS (13 tests in 3 files; `capabilities.test.ts` has 3). Run: `npx tsc -b` — Expected: no output. Run: `grep -c "create or replace function" supabase/migration-2026-10-24-pos-checkout.sql` — Expected: `2`. Run: `npx vitest run` — Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/index.ts src/shared/types/capabilities.test.ts supabase/migration-2026-10-24-pos-checkout.sql
git commit -m "feat(pos): pos_supervise capability — Approve POS voids & refunds (TS defaults, has_menu_cap, staff_has_cap)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Approvals, voids, move, merge, refunds and open table (SQL)

**Files:**
- Create: `supabase/migration-2026-10-24-pos-bill-actions-fn.sql`

**Interfaces:**
- Consumes: Tasks 1–3 (`pos_my_branch`, `staff_has_cap`, `pos_next_bill_no`, `staff_pos_pins`, `reason_templates`, `payment_methods`, `print_jobs`).
- Produces (called by Tasks 5 and 8):
  - `pos_approvers() returns table (staff_id uuid, name text, has_pin boolean)` — staff
  - `set_my_pos_pin(p_new_pin text, p_current_pin text) returns jsonb` — `{ok}` / `{ok:false, error:'Current PIN: …'}`; raises `The PIN must be 4 to 6 digits`
  - `clear_pos_pin(p_staff_id uuid) returns void` — `access_settings`, staff of the caller's branch only
  - `void_order_item(p_item_id uuid, p_reason text, p_approver_id uuid, p_pin text) returns jsonb`
  - `void_bill(p_bill_id uuid, p_reason text, p_approver_id uuid, p_pin text) returns jsonb`
  - `move_bill(p_bill_id uuid, p_table_id uuid) returns void`, `merge_bills(p_from_bill uuid, p_into_bill uuid) returns void` (a dine-in bill never merges into a takeaway bill)
  - approvers and the caller count only when `is_active and status = 'active'`; wrong PINs older than a day are forgotten (`updated_at` is stamped on every failure)
  - `refund_bill(p_refund_id uuid, p_bill_id uuid, p_amount_sen integer, p_method_id uuid, p_reason text, p_approver_id uuid, p_pin text) returns jsonb` → `{ok, refundedSen, slipQueued}` — a replay of the same `refund_id` answers the same shape (`slipQueued` from `refunds.slip_queued`)
  - `open_table(p_table_id uuid, p_pax integer) returns uuid` (the open bill's id)
  - internal: `pos_pin_attempt(uuid, text) returns text`, `pos_check_approver(uuid, uuid, text) returns text`, `pos_check_reason(uuid, text, text) returns text`, `pos_queue_void_tickets(uuid[]) returns void`, `pos_refund_slip_payload(uuid) returns jsonb` (exactly `RefundSlipPayload`)
  - Words the UI shows: `Wrong PIN — N tries left`, `Wrong PIN — locked for 10 minutes after 5 wrong tries`, `Too many wrong PINs — locked until HH:MI`, `No POS PIN is set for this person yet — they set one under My PIN`, `Choose who approves`, `The approver is not active staff of this branch`, `This person cannot approve voids or refunds`, `Choose a reason`, `Choose one of the listed reasons`, `Reason is too long`, `Only items on an open bill can be voided — refund a paid bill instead`, `This bill is paid — refund it instead`, `Table X already has an open bill — merge instead`, `Only a dine-in bill can move to another table`, `Only open bills can be merged`, `Merge the takeaway bill into the table's bill, not the other way round`, `This person is not staff of your branch`, `Your account is not active`, `Only a paid bill can be refunded`, `Refund is more than what is left on this bill (RM x)`

- [ ] **Step 1: Write the functions**

```sql
-- ============================================================================
-- Craft OS — POS Phase 1 · Approvals, voids, move, merge, refunds, open table
-- (2026-10-24). Run after migration-2026-10-24-pos-checkout.sql and -fn.sql. Idempotent.
--
-- A wrong approver PIN must leave its mark (5 wrong = locked 10 minutes), so the
-- protected functions do NOT raise on a wrong PIN — a raise would roll the
-- counter back. They answer {"ok": false, "error": "..."} instead, and
-- {"ok": true, ...} when done. Every other refusal is a raised exception.
-- ============================================================================

-- ── Who may approve at the caller's branch ─────────────────────────────────
create or replace function pos_approvers() returns table (staff_id uuid, name text, has_pin boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.id, s.name, exists (select 1 from staff_pos_pins p where p.staff_id = s.id)
    from staff s
   where s.is_active and s.status = 'active' and s.branch_id = pos_my_branch() and staff_has_cap(s.id, 'pos_supervise')
   order by s.name
$$;
revoke all on function pos_approvers() from public, anon;
grant execute on function pos_approvers() to authenticated;

-- ── One PIN attempt: null = right; otherwise the words to show ──────────────
-- Wrong tries older than a day are forgotten (updated_at is stamped on every failure).
create or replace function pos_pin_attempt(p_staff_id uuid, p_pin text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pin staff_pos_pins;
  v_n   integer;
begin
  select * into v_pin from staff_pos_pins where staff_id = p_staff_id for update;
  if not found then
    return 'No POS PIN is set for this person yet — they set one under My PIN';
  end if;
  if v_pin.locked_until is not null and v_pin.locked_until > now() then
    return 'Too many wrong PINs — locked until ' || to_char(v_pin.locked_until at time zone 'Asia/Kuala_Lumpur', 'HH24:MI');
  end if;
  if p_pin is not null and p_pin ~ '^\d{4,6}$' and v_pin.pin_hash = extensions.crypt(p_pin, v_pin.pin_hash) then
    update staff_pos_pins set failed_attempts = 0, locked_until = null where staff_id = p_staff_id;
    return null;
  end if;
  v_n := case when v_pin.updated_at < now() - interval '1 day' then 0 else v_pin.failed_attempts end + 1;
  if v_n >= 5 then
    update staff_pos_pins set failed_attempts = 0, locked_until = now() + interval '10 minutes', updated_at = now()
     where staff_id = p_staff_id;
    return 'Wrong PIN — locked for 10 minutes after 5 wrong tries';
  end if;
  update staff_pos_pins set failed_attempts = v_n, updated_at = now() where staff_id = p_staff_id;
  return format('Wrong PIN — %s %s left', 5 - v_n, case when 5 - v_n = 1 then 'try' else 'tries' end);
end $$;
revoke all on function pos_pin_attempt(uuid, text) from public, anon, authenticated;

-- ── My PIN: 4–6 digits; changing an existing PIN needs the current one ─────
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
     set pin_hash = excluded.pin_hash, failed_attempts = 0, locked_until = null, updated_at = now();
  return jsonb_build_object('ok', true);
end $$;
revoke all on function set_my_pos_pin(text, text) from public, anon;
grant execute on function set_my_pos_pin(text, text) to authenticated;

-- a forgotten PIN: a settings holder of the same branch clears it and the person sets a new one
create or replace function clear_pos_pin(p_staff_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not has_menu_cap('access_settings') then raise exception 'Only a manager can clear a PIN'; end if;
  if not exists (select 1 from staff where id = p_staff_id and branch_id = pos_my_branch()) then
    raise exception 'This person is not staff of your branch';
  end if;
  delete from staff_pos_pins where staff_id = p_staff_id;
end $$;
revoke all on function clear_pos_pin(uuid) from public, anon;
grant execute on function clear_pos_pin(uuid) to authenticated;

-- ── Approver check, inside every protected RPC: raise for a wrong person,
--    return the PIN words (or null) so a wrong PIN still counts ─────────────
create or replace function pos_check_approver(p_branch_id uuid, p_approver_id uuid, p_pin text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_approver_id is null then raise exception 'Choose who approves'; end if;
  if not exists (select 1 from staff s where s.id = p_approver_id and s.is_active and s.status = 'active'
                   and s.branch_id = p_branch_id) then
    raise exception 'The approver is not active staff of this branch';
  end if;
  if not staff_has_cap(p_approver_id, 'pos_supervise') then
    raise exception 'This person cannot approve voids or refunds';
  end if;
  return pos_pin_attempt(p_approver_id, p_pin);
end $$;
revoke all on function pos_check_approver(uuid, uuid, text) from public, anon, authenticated;

-- ── Reason templates: same rule and words as reasonProblem (reasons.ts) ────
-- no template saved for the action = a reason is required, any wording
create or replace function pos_check_reason(p_branch_id uuid, p_action text, p_reason text) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_t      reason_templates;
  v_reason text := nullif(trim(p_reason), '');
begin
  select * into v_t from reason_templates where branch_id = p_branch_id and action = p_action;
  if not found then
    v_t.reasons := '{}'; v_t.compulsory := true; v_t.allow_other := true;
  end if;
  if v_reason is null then
    if v_t.compulsory then raise exception 'Choose a reason'; end if;
    return null;
  end if;
  if not v_t.allow_other and not (v_reason = any (v_t.reasons)) then
    raise exception 'Choose one of the listed reasons';
  end if;
  if length(v_reason) > 200 then raise exception 'Reason is too long'; end if;
  return v_reason;
end $$;
revoke all on function pos_check_reason(uuid, text, text) from public, anon, authenticated;

-- ── VOID tickets: one per order and route, so the kitchen stops those lines ─
-- Same routing as pos_insert_order's tickets; payload = TicketPayload with void: true.
create or replace function pos_queue_void_tickets(p_item_ids uuid[]) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into print_jobs(branch_id, order_id, route, kind, payload)
  select o.branch_id, o.id, l.route, 'ticket', jsonb_build_object(
           'kind', 'ticket', 'route', l.route, 'tableLabel', t.label, 'orderNo', o.order_no,
           'source', o.source,
           'placedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'void', true,
           'lines', jsonb_agg(jsonb_build_object('qty', l.qty, 'name', l.name, 'note', l.note, 'mods', l.mods)
                              order by l.kind_order, l.name))
    from (
      select oi.order_id, oi.print_route as route, 1 as kind_order, oi.name_snapshot as name, oi.qty, oi.note,
             coalesce((select jsonb_agg(m->>'name' order by ord)
                         from jsonb_array_elements(oi.modifiers_snapshot) with ordinality as x(m, ord)), '[]'::jsonb) as mods
        from order_items oi
       where oi.id = any (p_item_ids) and oi.print_route is not null
      union all
      select oi.order_id, m->>'route', 2, m->>'name', oi.qty, 'for ' || oi.name_snapshot, '[]'::jsonb
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

-- ── Void one item of an open bill (approver + reason) ──────────────────────
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
  perform pos_queue_void_tickets(array[p_item_id]);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function void_order_item(uuid, text, uuid, text) from public, anon;
grant execute on function void_order_item(uuid, text, uuid, text) to authenticated;

-- ── Void a whole open bill. A bill with nothing left on it (opened by mistake,
--    or every item already voided with approval) closes without a second approval ─
create or replace function void_bill(p_bill_id uuid, p_reason text, p_approver_id uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
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
       set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason, void_approved_by = p_approver_id
     where id = any (v_ids);
  else
    v_reason := nullif(trim(left(p_reason, 200)), '');
  end if;
  update bills
     set status = 'voided', closed_at = now(), closed_by = auth.uid(), void_reason = v_reason,
         void_approved_by = case when cardinality(v_ids) > 0 then p_approver_id end
   where id = v_bill.id;
  perform pos_queue_void_tickets(v_ids);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function void_bill(uuid, text, uuid, text) from public, anon;
grant execute on function void_bill(uuid, text, uuid, text) to authenticated;

-- ── Move an open dine-in bill to an empty table (any staff, no reprint) ────
create or replace function move_bill(p_bill_id uuid, p_table_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_bill   bills;
  v_label  text;
begin
  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  if v_bill.status <> 'open' then raise exception 'Only an open bill can move'; end if;
  if v_bill.order_type <> 'dine_in' then raise exception 'Only a dine-in bill can move to another table'; end if;
  if v_bill.table_id = p_table_id then return; end if;
  select label into v_label from dining_tables where id = p_table_id and branch_id = v_branch and is_active;
  if not found then raise exception 'Invalid table'; end if;
  if exists (select 1 from bills where table_id = p_table_id and status = 'open') then
    raise exception 'Table % already has an open bill — merge instead', v_label;
  end if;
  begin
    update bills set table_id = p_table_id where id = v_bill.id;
  exception when unique_violation then
    raise exception 'Table % already has an open bill — merge instead', v_label;
  end;
end $$;
revoke all on function move_bill(uuid, uuid) from public, anon;
grant execute on function move_bill(uuid, uuid) to authenticated;

-- ── Merge: every order and item of p_from_bill moves to p_into_bill ────────
create or replace function merge_bills(p_from_bill uuid, p_into_bill uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
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
     set status = 'merged', merged_into = v_into.id, closed_at = now(), closed_by = auth.uid()
   where id = v_from.id;
end $$;
revoke all on function merge_bills(uuid, uuid) from public, anon;
grant execute on function merge_bills(uuid, uuid) to authenticated;

-- ── Refund slip payload: exactly RefundSlipPayload (src/features/pos/print/receipt.ts) ─
create or replace function pos_refund_slip_payload(p_refund_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'kind', 'refund',
    'route', s.receipt_route,
    'title', coalesce(nullif(trim(br.receipt_title), ''), br.name),
    'billNo', b.bill_no,
    'refundedAt', to_char(rf.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'amountSen', rf.amount_sen,
    'methodName', rf.method_name,
    'reason', rf.reason,
    'refundedBy', (select st.name from staff st where st.id = rf.created_by),
    'approvedBy', (select st.name from staff st where st.id = rf.approved_by))
  from refunds rf
  join bills b on b.id = rf.bill_id
  join branches br on br.id = b.branch_id
  left join branch_pos_settings s on s.branch_id = b.branch_id
  where rf.id = p_refund_id
$$;
revoke all on function pos_refund_slip_payload(uuid) from public, anon, authenticated;

-- ── Refund on a paid bill (approver + reason), idempotent on p_refund_id ───
create or replace function refund_bill(p_refund_id uuid, p_bill_id uuid, p_amount_sen integer, p_method_id uuid,
                                       p_reason text, p_approver_id uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch   uuid := pos_my_branch();
  v_bill     bills;
  v_existing refunds;
  v_m        payment_methods;
  v_reason   text;
  v_err      text;
  v_route    text;
begin
  if p_refund_id is null then raise exception 'Refund id is missing'; end if;
  -- a resend of a refund that already went through gets the same reply as the first time
  select * into v_existing from refunds where id = p_refund_id;
  if found then
    if v_existing.bill_id <> p_bill_id or v_existing.branch_id <> v_branch then
      raise exception 'This refund id belongs to another bill';
    end if;
    return jsonb_build_object('ok', true, 'refundedSen', (select refunded_sen from bills where id = p_bill_id),
                              'slipQueued', v_existing.slip_queued);
  end if;
  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  select * into v_existing from refunds where id = p_refund_id;        -- the same refund won while we waited
  if found then
    return jsonb_build_object('ok', true, 'refundedSen', v_bill.refunded_sen, 'slipQueued', v_existing.slip_queued);
  end if;
  if v_bill.status <> 'paid' then raise exception 'Only a paid bill can be refunded'; end if;
  if p_amount_sen is null or p_amount_sen <= 0 then raise exception 'Invalid refund amount'; end if;
  if p_amount_sen > v_bill.total_sen - v_bill.refunded_sen then
    raise exception 'Refund is more than what is left on this bill (RM %)',
      to_char((v_bill.total_sen - v_bill.refunded_sen) / 100.0, 'FM999999990.00');
  end if;
  select * into v_m from payment_methods where id = p_method_id and branch_id = v_branch and is_active;
  if not found then raise exception 'Payment method is not available at this branch'; end if;
  v_reason := pos_check_reason(v_branch, 'refund', p_reason);
  v_err := pos_check_approver(v_branch, p_approver_id, p_pin);
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  insert into refunds(id, bill_id, branch_id, amount_sen, method_id, method_name, reason, approved_by, created_by)
  values (p_refund_id, v_bill.id, v_branch, p_amount_sen, v_m.id, v_m.name, v_reason, p_approver_id, auth.uid());
  update bills set refunded_sen = refunded_sen + p_amount_sen where id = v_bill.id;
  select s.receipt_route into v_route from branch_pos_settings s where s.branch_id = v_branch;
  if v_route is not null then
    insert into print_jobs(branch_id, route, kind, payload)
    values (v_branch, v_route, 'receipt', pos_refund_slip_payload(p_refund_id));
    update refunds set slip_queued = true where id = p_refund_id;
  end if;
  return jsonb_build_object('ok', true, 'refundedSen', v_bill.refunded_sen + p_amount_sen, 'slipQueued', v_route is not null);
end $$;
revoke all on function refund_bill(uuid, uuid, integer, uuid, text, uuid, text) from public, anon;
grant execute on function refund_bill(uuid, uuid, integer, uuid, text, uuid, text) to authenticated;

-- ── Open a table before anything is ordered (needed when qr_requires_open_bill is on) ─
create or replace function open_table(p_table_id uuid, p_pax integer) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch  uuid := pos_my_branch();
  v_bill_id uuid;
begin
  if p_pax is not null and (p_pax < 1 or p_pax > 99) then raise exception 'Invalid number of guests'; end if;
  if not exists (select 1 from dining_tables where id = p_table_id and branch_id = v_branch and is_active) then
    raise exception 'Invalid table';
  end if;
  select id into v_bill_id from bills where table_id = p_table_id and status = 'open';
  if v_bill_id is null then
    insert into bills(branch_id, bill_no, table_id, order_type, pax)
    values (v_branch, pos_next_bill_no(v_branch), p_table_id, 'dine_in', p_pax)
    on conflict (table_id) where status = 'open' and table_id is not null do nothing
    returning id into v_bill_id;
    if v_bill_id is null then                       -- lost the race: the table was just opened
      select id into v_bill_id from bills where table_id = p_table_id and status = 'open';
    end if;
  elsif p_pax is not null then
    update bills set pax = p_pax where id = v_bill_id and pax is null;
  end if;
  return v_bill_id;
end $$;
revoke all on function open_table(uuid, integer) from public, anon;
grant execute on function open_table(uuid, integer) to authenticated;

select 'bill action functions applied' as result;
```

- [ ] **Step 2: Local sanity checks.** Run: `grep -c "create or replace function" supabase/migration-2026-10-24-pos-bill-actions-fn.sql` — Expected: `14`. Run: `grep -c "set search_path = public, pg_temp" supabase/migration-2026-10-24-pos-bill-actions-fn.sql` — Expected: `14`. Run: `grep -n "grant execute" supabase/migration-2026-10-24-pos-bill-actions-fn.sql | grep -c anon` — Expected: `0`. Run: `grep -c "pos_check_approver(v_branch" supabase/migration-2026-10-24-pos-bill-actions-fn.sql` — Expected: `3` (void item, void bill, refund: the PIN is checked inside each). Run: `grep -c "status = 'active'" supabase/migration-2026-10-24-pos-bill-actions-fn.sql` — Expected: `3` (`pos_approvers`, `set_my_pos_pin`, `pos_check_approver`).

- [ ] **Step 3: Commit**

```bash
git add supabase/migration-2026-10-24-pos-bill-actions-fn.sql
git commit -m "feat(pos-checkout): approver PINs, voids with VOID tickets, move, merge, refunds and open table

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Shared vectors, verify script, dev seed — and applying everything on craft-os-dev (implementer + controller)

**Files:**
- Create: `src/features/pos/checkout/billVectors.json`
- Create: `supabase/migration-2026-10-24-pos-checkout-verify.sql`
- Create: `supabase/seed-2026-10-24-pos-checkout-demo.sql`

**Interfaces:**
- Consumes: Tasks 1–4; the dev test login `76cbcf9f-905e-450d-9f5e-1c9e72a9373d` (owner, Demo branch) and the Demo branch from `seed-2026-10-23-pos-demo-branch.sql`.
- Produces: the vectors file Task 6 tests against (`{ name, input: BillInput, expected: BillTotals }[]`, 21 entries); on dev, the three migrations applied and the Demo branch's checkout settings (receipt route `Bar`, 10 % dine-in rule, methods Cash / Maybank Terminal / DuitNow QR / Touch 'n Go, reason templates). The verify script's expected error messages are the ones Tasks 9–12 show to users.

- [ ] **Step 1: Write the vectors file** `src/features/pos/checkout/billVectors.json` (one vector per line; the numbers are worked out in the design's §2 rules — e.g. #87846: 8000 + 800 + 480 = 9280):

```json
[
  {"name": "receipt #87846: dine-in, 10% service charge, 6% SST", "input": {"orderType": "dine_in", "tableId": "t-7", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in"], "tableIds": null, "productIds": null}], "lines": [{"productId": "p-a", "unitPriceSen": 2400, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}, {"productId": "p-b", "unitPriceSen": 2500, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}, {"productId": "p-c", "unitPriceSen": 1800, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}, {"productId": "p-d", "unitPriceSen": 1300, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 8000, "serviceChargeSen": 800, "sstSen": 480, "takeawayFeeSen": 0, "beforeRoundingSen": 9280, "roundingSen": 0, "totalSen": 9280, "sstGroups": [{"rateBp": 600, "baseSen": 8000, "amountSen": 480}], "serviceChargeGroups": [{"rateBp": 1000, "baseSen": 8000, "amountSen": 800}]}},
  {"name": "takeaway: packaging fee per unit, no service charge, rounds 4381 down to 4380", "input": {"orderType": "takeaway", "tableId": null, "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in"], "tableIds": null, "productIds": null}], "lines": [{"productId": "p-latte", "unitPriceSen": 1300, "qty": 2, "sstRateBp": 600, "takeawayFeeSen": 100, "voided": false}, {"productId": "p-cake", "unitPriceSen": 1250, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 100, "voided": false}]}, "expected": {"subtotalSen": 3850, "serviceChargeSen": 0, "sstSen": 231, "takeawayFeeSen": 300, "beforeRoundingSen": 4381, "roundingSen": -1, "totalSen": 4380, "sstGroups": [{"rateBp": 600, "baseSen": 3850, "amountSen": 231}], "serviceChargeGroups": []}},
  {"name": "0% SST item pays service charge but no SST", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in"], "tableIds": null, "productIds": null}], "lines": [{"productId": "p-a", "unitPriceSen": 2400, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}, {"productId": "p-keychain", "unitPriceSen": 3500, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 5900, "serviceChargeSen": 590, "sstSen": 144, "takeawayFeeSen": 0, "beforeRoundingSen": 6634, "roundingSen": 1, "totalSen": 6635, "sstGroups": [{"rateBp": 600, "baseSen": 2400, "amountSen": 144}], "serviceChargeGroups": [{"rateBp": 1000, "baseSen": 5900, "amountSen": 590}]}},
  {"name": "rounding: 1001 sen -> 1000 sen", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1001, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1001, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1001, "roundingSen": -1, "totalSen": 1000, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "rounding: 1002 sen -> 1000 sen", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1002, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1002, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1002, "roundingSen": -2, "totalSen": 1000, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "rounding: 1003 sen -> 1005 sen", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1003, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1003, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1003, "roundingSen": 2, "totalSen": 1005, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "rounding: 1004 sen -> 1005 sen", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1004, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1004, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1004, "roundingSen": 1, "totalSen": 1005, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "rounding: 1005 sen -> 1005 sen", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1005, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1005, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1005, "roundingSen": 0, "totalSen": 1005, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "rounding: 1006 sen -> 1005 sen", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1006, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1006, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1006, "roundingSen": -1, "totalSen": 1005, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "rounding: 1007 sen -> 1005 sen", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1007, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1007, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1007, "roundingSen": -2, "totalSen": 1005, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "rounding: 1008 sen -> 1010 sen", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1008, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1008, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1008, "roundingSen": 2, "totalSen": 1010, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "rounding: 1009 sen -> 1010 sen", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1009, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1009, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1009, "roundingSen": 1, "totalSen": 1010, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "rounding off: 1003 sen stays 1003", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "none", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1003, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1003, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1003, "roundingSen": 0, "totalSen": 1003, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "voided line is excluded", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in"], "tableIds": null, "productIds": null}], "lines": [{"productId": "p-a", "unitPriceSen": 2400, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": true}, {"productId": "p-b", "unitPriceSen": 1300, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1300, "serviceChargeSen": 130, "sstSen": 78, "takeawayFeeSen": 0, "beforeRoundingSen": 1508, "roundingSen": 2, "totalSen": 1510, "sstGroups": [{"rateBp": 600, "baseSen": 1300, "amountSen": 78}], "serviceChargeGroups": [{"rateBp": 1000, "baseSen": 1300, "amountSen": 130}]}},
  {"name": "service-charge rules: table rule matches first on the VIP table", "input": {"orderType": "dine_in", "tableId": "t-vip", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in"], "tableIds": ["t-vip"], "productIds": null}, {"rateBp": 500, "orderTypes": ["dine_in"], "tableIds": null, "productIds": ["p-cake"]}], "lines": [{"productId": "p-latte", "unitPriceSen": 1300, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}, {"productId": "p-cake", "unitPriceSen": 1500, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 2800, "serviceChargeSen": 280, "sstSen": 168, "takeawayFeeSen": 0, "beforeRoundingSen": 3248, "roundingSen": 2, "totalSen": 3250, "sstGroups": [{"rateBp": 600, "baseSen": 2800, "amountSen": 168}], "serviceChargeGroups": [{"rateBp": 1000, "baseSen": 2800, "amountSen": 280}]}},
  {"name": "service-charge rules: elsewhere only the cake rule matches", "input": {"orderType": "dine_in", "tableId": "t-2", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in"], "tableIds": ["t-vip"], "productIds": null}, {"rateBp": 500, "orderTypes": ["dine_in"], "tableIds": null, "productIds": ["p-cake"]}], "lines": [{"productId": "p-latte", "unitPriceSen": 1300, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}, {"productId": "p-cake", "unitPriceSen": 1500, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 2800, "serviceChargeSen": 75, "sstSen": 168, "takeawayFeeSen": 0, "beforeRoundingSen": 3043, "roundingSen": 2, "totalSen": 3045, "sstGroups": [{"rateBp": 600, "baseSen": 2800, "amountSen": 168}], "serviceChargeGroups": [{"rateBp": 500, "baseSen": 1500, "amountSen": 75}]}},
  {"name": "SST per rate group, not per line: 2 x 11.55 at 6% is 1.39 (per line would be 1.38)", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in"], "tableIds": null, "productIds": null}], "lines": [{"productId": "p-a", "unitPriceSen": 1155, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}, {"productId": "p-b", "unitPriceSen": 1155, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}, {"productId": "p-c", "unitPriceSen": 990, "qty": 1, "sstRateBp": 800, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 3300, "serviceChargeSen": 330, "sstSen": 218, "takeawayFeeSen": 0, "beforeRoundingSen": 3848, "roundingSen": 2, "totalSen": 3850, "sstGroups": [{"rateBp": 600, "baseSen": 2310, "amountSen": 139}, {"rateBp": 800, "baseSen": 990, "amountSen": 79}], "serviceChargeGroups": [{"rateBp": 1000, "baseSen": 3300, "amountSen": 330}]}},
  {"name": "half a sen rounds up: 24.75 x 6% = 1.485 -> 1.49", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-a", "unitPriceSen": 2475, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 2475, "serviceChargeSen": 0, "sstSen": 149, "takeawayFeeSen": 0, "beforeRoundingSen": 2624, "roundingSen": 1, "totalSen": 2625, "sstGroups": [{"rateBp": 600, "baseSen": 2475, "amountSen": 149}], "serviceChargeGroups": []}},
  {"name": "branch not SST-registered: no SST", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": false, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in"], "tableIds": null, "productIds": null}], "lines": [{"productId": "p-a", "unitPriceSen": 2400, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 2400, "serviceChargeSen": 240, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 2640, "roundingSen": 0, "totalSen": 2640, "sstGroups": [], "serviceChargeGroups": [{"rateBp": 1000, "baseSen": 2400, "amountSen": 240}]}},
  {"name": "takeaway rule: service charge, SST and packaging fee together", "input": {"orderType": "takeaway", "tableId": null, "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in", "takeaway"], "tableIds": null, "productIds": null}], "lines": [{"productId": "p-a", "unitPriceSen": 1000, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 100, "voided": false}]}, "expected": {"subtotalSen": 1000, "serviceChargeSen": 100, "sstSen": 60, "takeawayFeeSen": 100, "beforeRoundingSen": 1260, "roundingSen": 0, "totalSen": 1260, "sstGroups": [{"rateBp": 600, "baseSen": 1000, "amountSen": 60}], "serviceChargeGroups": [{"rateBp": 1000, "baseSen": 1000, "amountSen": 100}]}},
  {"name": "packaging fee is ignored on a dine-in bill", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-a", "unitPriceSen": 1000, "qty": 2, "sstRateBp": 0, "takeawayFeeSen": 100, "voided": false}]}, "expected": {"subtotalSen": 2000, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 2000, "roundingSen": 0, "totalSen": 2000, "sstGroups": [], "serviceChargeGroups": []}}
]
```

- [ ] **Step 2: Write the verify script** (everything inside `begin … rollback`; success = a result row `VERIFY OK`). The text between the two `$vectors$` markers is a byte-for-byte copy of Step 1's file — paste the file, do not retype it.

```sql
-- Self-check for the POS checkout migrations (Sub-plan 3). Run on craft-os-dev after
-- migration-2026-10-24-pos-checkout.sql, -checkout-fn.sql and -bill-actions-fn.sql.
-- Everything is rolled back. Success = a result row "VERIFY OK".
-- The vectors below are a byte-for-byte copy of src/features/pos/checkout/billVectors.json
-- (bill.test.ts fails if the two differ).
begin;

do $$
declare
  v_vectors jsonb := $vectors$
[
  {"name": "receipt #87846: dine-in, 10% service charge, 6% SST", "input": {"orderType": "dine_in", "tableId": "t-7", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in"], "tableIds": null, "productIds": null}], "lines": [{"productId": "p-a", "unitPriceSen": 2400, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}, {"productId": "p-b", "unitPriceSen": 2500, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}, {"productId": "p-c", "unitPriceSen": 1800, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}, {"productId": "p-d", "unitPriceSen": 1300, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 8000, "serviceChargeSen": 800, "sstSen": 480, "takeawayFeeSen": 0, "beforeRoundingSen": 9280, "roundingSen": 0, "totalSen": 9280, "sstGroups": [{"rateBp": 600, "baseSen": 8000, "amountSen": 480}], "serviceChargeGroups": [{"rateBp": 1000, "baseSen": 8000, "amountSen": 800}]}},
  {"name": "takeaway: packaging fee per unit, no service charge, rounds 4381 down to 4380", "input": {"orderType": "takeaway", "tableId": null, "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in"], "tableIds": null, "productIds": null}], "lines": [{"productId": "p-latte", "unitPriceSen": 1300, "qty": 2, "sstRateBp": 600, "takeawayFeeSen": 100, "voided": false}, {"productId": "p-cake", "unitPriceSen": 1250, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 100, "voided": false}]}, "expected": {"subtotalSen": 3850, "serviceChargeSen": 0, "sstSen": 231, "takeawayFeeSen": 300, "beforeRoundingSen": 4381, "roundingSen": -1, "totalSen": 4380, "sstGroups": [{"rateBp": 600, "baseSen": 3850, "amountSen": 231}], "serviceChargeGroups": []}},
  {"name": "0% SST item pays service charge but no SST", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in"], "tableIds": null, "productIds": null}], "lines": [{"productId": "p-a", "unitPriceSen": 2400, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}, {"productId": "p-keychain", "unitPriceSen": 3500, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 5900, "serviceChargeSen": 590, "sstSen": 144, "takeawayFeeSen": 0, "beforeRoundingSen": 6634, "roundingSen": 1, "totalSen": 6635, "sstGroups": [{"rateBp": 600, "baseSen": 2400, "amountSen": 144}], "serviceChargeGroups": [{"rateBp": 1000, "baseSen": 5900, "amountSen": 590}]}},
  {"name": "rounding: 1001 sen -> 1000 sen", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1001, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1001, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1001, "roundingSen": -1, "totalSen": 1000, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "rounding: 1002 sen -> 1000 sen", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1002, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1002, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1002, "roundingSen": -2, "totalSen": 1000, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "rounding: 1003 sen -> 1005 sen", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1003, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1003, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1003, "roundingSen": 2, "totalSen": 1005, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "rounding: 1004 sen -> 1005 sen", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1004, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1004, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1004, "roundingSen": 1, "totalSen": 1005, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "rounding: 1005 sen -> 1005 sen", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1005, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1005, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1005, "roundingSen": 0, "totalSen": 1005, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "rounding: 1006 sen -> 1005 sen", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1006, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1006, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1006, "roundingSen": -1, "totalSen": 1005, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "rounding: 1007 sen -> 1005 sen", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1007, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1007, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1007, "roundingSen": -2, "totalSen": 1005, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "rounding: 1008 sen -> 1010 sen", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1008, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1008, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1008, "roundingSen": 2, "totalSen": 1010, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "rounding: 1009 sen -> 1010 sen", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1009, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1009, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1009, "roundingSen": 1, "totalSen": 1010, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "rounding off: 1003 sen stays 1003", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "none", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1003, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1003, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1003, "roundingSen": 0, "totalSen": 1003, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "voided line is excluded", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in"], "tableIds": null, "productIds": null}], "lines": [{"productId": "p-a", "unitPriceSen": 2400, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": true}, {"productId": "p-b", "unitPriceSen": 1300, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1300, "serviceChargeSen": 130, "sstSen": 78, "takeawayFeeSen": 0, "beforeRoundingSen": 1508, "roundingSen": 2, "totalSen": 1510, "sstGroups": [{"rateBp": 600, "baseSen": 1300, "amountSen": 78}], "serviceChargeGroups": [{"rateBp": 1000, "baseSen": 1300, "amountSen": 130}]}},
  {"name": "service-charge rules: table rule matches first on the VIP table", "input": {"orderType": "dine_in", "tableId": "t-vip", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in"], "tableIds": ["t-vip"], "productIds": null}, {"rateBp": 500, "orderTypes": ["dine_in"], "tableIds": null, "productIds": ["p-cake"]}], "lines": [{"productId": "p-latte", "unitPriceSen": 1300, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}, {"productId": "p-cake", "unitPriceSen": 1500, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 2800, "serviceChargeSen": 280, "sstSen": 168, "takeawayFeeSen": 0, "beforeRoundingSen": 3248, "roundingSen": 2, "totalSen": 3250, "sstGroups": [{"rateBp": 600, "baseSen": 2800, "amountSen": 168}], "serviceChargeGroups": [{"rateBp": 1000, "baseSen": 2800, "amountSen": 280}]}},
  {"name": "service-charge rules: elsewhere only the cake rule matches", "input": {"orderType": "dine_in", "tableId": "t-2", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in"], "tableIds": ["t-vip"], "productIds": null}, {"rateBp": 500, "orderTypes": ["dine_in"], "tableIds": null, "productIds": ["p-cake"]}], "lines": [{"productId": "p-latte", "unitPriceSen": 1300, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}, {"productId": "p-cake", "unitPriceSen": 1500, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 2800, "serviceChargeSen": 75, "sstSen": 168, "takeawayFeeSen": 0, "beforeRoundingSen": 3043, "roundingSen": 2, "totalSen": 3045, "sstGroups": [{"rateBp": 600, "baseSen": 2800, "amountSen": 168}], "serviceChargeGroups": [{"rateBp": 500, "baseSen": 1500, "amountSen": 75}]}},
  {"name": "SST per rate group, not per line: 2 x 11.55 at 6% is 1.39 (per line would be 1.38)", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in"], "tableIds": null, "productIds": null}], "lines": [{"productId": "p-a", "unitPriceSen": 1155, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}, {"productId": "p-b", "unitPriceSen": 1155, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}, {"productId": "p-c", "unitPriceSen": 990, "qty": 1, "sstRateBp": 800, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 3300, "serviceChargeSen": 330, "sstSen": 218, "takeawayFeeSen": 0, "beforeRoundingSen": 3848, "roundingSen": 2, "totalSen": 3850, "sstGroups": [{"rateBp": 600, "baseSen": 2310, "amountSen": 139}, {"rateBp": 800, "baseSen": 990, "amountSen": 79}], "serviceChargeGroups": [{"rateBp": 1000, "baseSen": 3300, "amountSen": 330}]}},
  {"name": "half a sen rounds up: 24.75 x 6% = 1.485 -> 1.49", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-a", "unitPriceSen": 2475, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 2475, "serviceChargeSen": 0, "sstSen": 149, "takeawayFeeSen": 0, "beforeRoundingSen": 2624, "roundingSen": 1, "totalSen": 2625, "sstGroups": [{"rateBp": 600, "baseSen": 2475, "amountSen": 149}], "serviceChargeGroups": []}},
  {"name": "branch not SST-registered: no SST", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": false, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in"], "tableIds": null, "productIds": null}], "lines": [{"productId": "p-a", "unitPriceSen": 2400, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 2400, "serviceChargeSen": 240, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 2640, "roundingSen": 0, "totalSen": 2640, "sstGroups": [], "serviceChargeGroups": [{"rateBp": 1000, "baseSen": 2400, "amountSen": 240}]}},
  {"name": "takeaway rule: service charge, SST and packaging fee together", "input": {"orderType": "takeaway", "tableId": null, "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in", "takeaway"], "tableIds": null, "productIds": null}], "lines": [{"productId": "p-a", "unitPriceSen": 1000, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 100, "voided": false}]}, "expected": {"subtotalSen": 1000, "serviceChargeSen": 100, "sstSen": 60, "takeawayFeeSen": 100, "beforeRoundingSen": 1260, "roundingSen": 0, "totalSen": 1260, "sstGroups": [{"rateBp": 600, "baseSen": 1000, "amountSen": 60}], "serviceChargeGroups": [{"rateBp": 1000, "baseSen": 1000, "amountSen": 100}]}},
  {"name": "packaging fee is ignored on a dine-in bill", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-a", "unitPriceSen": 1000, "qty": 2, "sstRateBp": 0, "takeawayFeeSen": 100, "voided": false}]}, "expected": {"subtotalSen": 2000, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 2000, "roundingSen": 0, "totalSen": 2000, "sstGroups": [], "serviceChargeGroups": []}}
]
$vectors$;
  v_owner   uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_sup     uuid := 'aaaaaaaa-0000-0000-0000-000000000001';   -- verify supervisor
  v_staff   uuid := 'aaaaaaaa-0000-0000-0000-000000000002';   -- verify cashier (no pos_supervise)
  v_far     uuid := 'aaaaaaaa-0000-0000-0000-000000000003';   -- supervisor of another branch
  v_branch  uuid; v_branch2 uuid;
  v_t1 dining_tables; v_t2 dining_tables; v_t3 dining_tables; v_t4 dining_tables;
  v_cat uuid; v_plate uuid; v_plate_var uuid;
  v_cash uuid; v_card uuid; v_tng uuid; v_far_cash uuid;
  v_order uuid; v_bill bills; v_bill2 bills; v_bill3 bills;
  v_item uuid; v_items jsonb; v_res jsonb; v_job print_jobs;
  v_refund uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
  v_checkout uuid := 'cccccccc-0000-0000-0000-000000000001';
  n integer; r record; v_role text;
begin
  -- ── A. schema, RLS, grants ────────────────────────────────────────────────
  for r in select t from unnest(array['branch_pos_settings','service_charge_rules','payment_methods',
                                      'reason_templates','payments','refunds','staff_pos_pins']) as t loop
    if not exists (select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
                    where ns.nspname = 'public' and c.relname = r.t and c.relrowsecurity) then
      raise exception 'FAIL schema: % missing or RLS off', r.t;
    end if;
  end loop;
  for r in select t from unnest(array['branch_pos_settings','service_charge_rules','payment_methods',
                                      'reason_templates','payments','refunds']) as t loop
    if not exists (select 1 from pg_policies where tablename = r.t and policyname = 'pos_read' and cmd = 'SELECT') then
      raise exception 'FAIL rls: % has no pos_read', r.t;
    end if;
  end loop;
  if exists (select 1 from pg_policies where tablename in ('payments','refunds','branch_pos_settings')
              and cmd in ('INSERT','UPDATE','DELETE','ALL')) then
    raise exception 'FAIL rls: payments/refunds/branch_pos_settings must be written only by RPCs';
  end if;
  if exists (select 1 from pg_policies where tablename = 'staff_pos_pins')
     or has_table_privilege('authenticated', 'staff_pos_pins', 'SELECT')
     or has_table_privilege('anon', 'staff_pos_pins', 'SELECT') then
    raise exception 'FAIL pins: PIN hashes must be unreadable by clients';
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'bills') then
    raise exception 'FAIL realtime: bills not published';
  end if;
  if exists (select 1 from information_schema.columns where table_name = 'bills' and column_name = 'status')
     and not exists (select 1 from pg_constraint where conname = 'bills_status_check'
                      and pg_get_constraintdef(oid) like '%merged%') then
    raise exception 'FAIL schema: bills.status does not allow merged';
  end if;
  -- callable by staff, never by anon
  for r in select f from unnest(array[
      'pos_compute_bill(jsonb)', 'pos_bill_totals(uuid)', 'checkout_bill(uuid,jsonb,uuid)', 'reprint_receipt(uuid)',
      'save_receipt_settings(jsonb)', 'pos_approvers()', 'set_my_pos_pin(text,text)', 'clear_pos_pin(uuid)',
      'void_order_item(uuid,text,uuid,text)', 'void_bill(uuid,text,uuid,text)', 'move_bill(uuid,uuid)',
      'merge_bills(uuid,uuid)', 'refund_bill(uuid,uuid,integer,uuid,text,uuid,text)', 'open_table(uuid,integer)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') then raise exception 'FAIL grants: anon can call %', r.f; end if;
    if not has_function_privilege('authenticated', r.f, 'execute') then raise exception 'FAIL grants: staff cannot call %', r.f; end if;
  end loop;
  -- internal: nobody outside the definer functions
  for r in select f from unnest(array[
      'pos_my_branch()', 'pos_receipt_payload(uuid,boolean)', 'pos_queue_receipt(uuid,boolean)', 'pos_checkout_result(uuid)',
      'staff_has_cap(uuid,text)', 'pos_pin_attempt(uuid,text)', 'pos_check_approver(uuid,uuid,text)',
      'pos_check_reason(uuid,text,text)', 'pos_queue_void_tickets(uuid[])', 'pos_refund_slip_payload(uuid)',
      'pos_insert_order(uuid,uuid,text,integer,text,uuid,jsonb,uuid)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') or has_function_privilege('authenticated', r.f, 'execute') then
      raise exception 'FAIL grants: % must be internal', r.f;
    end if;
  end loop;
  if not has_function_privilege('anon', 'place_table_order(text,integer,jsonb,uuid)', 'execute') then
    raise exception 'FAIL grants: anon lost place_table_order';
  end if;
  -- every function of this sub-plan pins its search_path
  for r in select p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'public' and p.proname = any (array[
              'pos_my_branch','pos_compute_bill','pos_bill_totals','pos_insert_order','place_table_order','place_counter_order',
              'pos_receipt_payload','pos_queue_receipt','pos_checkout_result','checkout_bill','reprint_receipt',
              'save_receipt_settings','has_menu_cap','staff_has_cap','pos_approvers','pos_pin_attempt','set_my_pos_pin',
              'clear_pos_pin','pos_check_approver','pos_check_reason','pos_queue_void_tickets','void_order_item',
              'void_bill','move_bill','merge_bills','pos_refund_slip_payload','refund_bill','open_table'])
              and not coalesce(p.proconfig @> array['search_path=public, pg_temp'], false) loop
    raise exception 'FAIL search_path: % does not pin search_path = public, pg_temp', r.proname;
  end loop;

  -- ── B. totals: the shared vectors ─────────────────────────────────────────
  if jsonb_array_length(v_vectors) <> 21 then raise exception 'FAIL vectors: expected 21, got %', jsonb_array_length(v_vectors); end if;
  for r in select v from jsonb_array_elements(v_vectors) v loop
    if pos_compute_bill(r.v->'input') <> r.v->'expected' then
      raise exception 'FAIL vector "%": got %', r.v->>'name', pos_compute_bill(r.v->'input');
    end if;
  end loop;

  -- ── C. fixture: two branches, staff, tables, a menu item, methods, settings ─
  insert into branches(name, address, receipt_title, legal_name, sst_no) values ('VERIFY', 'verify street', 'Verify Cafe', 'Verify Sdn Bhd', 'W10-VERIFY')
    returning id into v_branch;
  insert into branches(name, address) values ('VERIFY2', 'far away') returning id into v_branch2;
  insert into dining_tables(branch_id, label) values (v_branch, 'V1') returning * into v_t1;
  insert into dining_tables(branch_id, label) values (v_branch, 'V2') returning * into v_t2;
  insert into dining_tables(branch_id, label) values (v_branch, 'V3') returning * into v_t3;
  insert into dining_tables(branch_id, label) values (v_branch, 'V4') returning * into v_t4;
  insert into print_routes(branch_id, name, kind, address) values (v_branch, 'Bar', 'agent', '127.0.0.1:9100');
  insert into menu_categories(name) values ('VERIFY CAT') returning id into v_cat;
  insert into menu_products(name, category_id, feedme_product_id, print_route, sst_rate_bp, takeaway_fee_sen)
    values ('Verify Plate', v_cat, 'verify-c-plate', 'Bar', 600, 100) returning id into v_plate;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_plate, '', 'Regular', 2000)
    returning id into v_plate_var;
  insert into payment_methods(branch_id, name, kind, needs_reference, sort_order) values (v_branch, 'V Cash', 'cash', false, 1)
    returning id into v_cash;
  insert into payment_methods(branch_id, name, kind, needs_reference, sort_order) values (v_branch, 'V Card', 'card', true, 2)
    returning id into v_card;
  insert into payment_methods(branch_id, name, kind, needs_reference, sort_order) values (v_branch, 'V TnG', 'ewallet', false, 3)
    returning id into v_tng;
  insert into payment_methods(branch_id, name, kind) values (v_branch2, 'X Cash', 'cash') returning id into v_far_cash;
  insert into branch_pos_settings(branch_id, receipt_route) values (v_branch, 'Bar');
  insert into service_charge_rules(branch_id, rate_bp, order_types) values (v_branch, 1000, array['dine_in']);
  insert into reason_templates(branch_id, action, reasons, compulsory, allow_other)
    values (v_branch, 'void_item', array['Wrong item keyed', 'Customer changed mind'], true, false);
  update system_role_permissions set permissions = permissions - 'pos_supervise';   -- code defaults for this run
  update staff set branch_id = v_branch where id = v_owner;
  delete from staff_pos_pins where staff_id = v_owner;                           -- the owner approves without a PIN below
  insert into auth.users (id) values (v_sup), (v_staff), (v_far);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_sup,   'Verify Supervisor', 'supervisor', true, current_date, 'supervisor', v_branch),
    (v_staff, 'Verify Cashier',    'trainee',    true, current_date, 'staff',      v_branch),
    (v_far,   'Far Supervisor',    'supervisor', true, current_date, 'supervisor', v_branch2);

  -- ── D. capability pos_supervise: defaults, Owner override, SQL helpers agree ─
  for r in select * from (values ('owner', true), ('admin', true), ('hr', false), ('manager', true),
                                 ('supervisor', true), ('staff', false)) as x(role, expected) loop
    -- the owner changes the role (staff_guard_authority_update refuses a self-promotion)
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    update staff set system_role = r.role where id = v_staff;
    perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
    if staff_has_cap(v_staff, 'pos_supervise') <> r.expected or has_menu_cap('pos_supervise') <> r.expected then
      raise exception 'FAIL cap: % pos_supervise should be %', r.role, r.expected;
    end if;
    if staff_has_cap(v_staff, 'access_settings') <> has_menu_cap('access_settings') then
      raise exception 'FAIL cap: staff_has_cap and has_menu_cap disagree on access_settings for %', r.role;
    end if;
  end loop;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  update staff set system_role = 'staff' where id = v_staff;
  update system_role_permissions set permissions = permissions || '{"pos_supervise": false}' where system_role = 'supervisor';
  if staff_has_cap(v_sup, 'pos_supervise') then raise exception 'FAIL cap: Owner override ignored'; end if;
  update system_role_permissions set permissions = permissions - 'pos_supervise' where system_role = 'supervisor';

  -- ── E. PINs ───────────────────────────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
  begin perform set_my_pos_pin('12a4', null); raise exception 'FAIL: bad PIN accepted';
  exception when raise_exception then if sqlerrm <> 'The PIN must be 4 to 6 digits' then raise; end if; end;
  if not (set_my_pos_pin('1234', null)->>'ok')::boolean then raise exception 'FAIL pin: first PIN not set'; end if;
  if (select pin_hash from staff_pos_pins where staff_id = v_sup) !~ '^\$2[ab]\$' then raise exception 'FAIL pin: not bcrypt'; end if;
  v_res := set_my_pos_pin('5678', '0000');
  if (v_res->>'ok')::boolean or v_res->>'error' <> 'Current PIN: Wrong PIN — 4 tries left' then
    raise exception 'FAIL pin: change without the current PIN: %', v_res;
  end if;
  if not (set_my_pos_pin('1234', '1234')->>'ok')::boolean then raise exception 'FAIL pin: change with the current PIN'; end if;
  if (select failed_attempts from staff_pos_pins where staff_id = v_sup) <> 0 then raise exception 'FAIL pin: counter not reset'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_far, 'role', 'authenticated')::text, true);
  perform set_my_pos_pin('9999', null);
  -- approvers of the VERIFY branch: the owner (test login) and the supervisor, not the cashier or VERIFY2's supervisor
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  if (select array_agg(staff_id order by name) from pos_approvers()) is distinct from
     (select array_agg(id order by name) from staff where id in (v_owner, v_sup)) then
    raise exception 'FAIL approvers: %', (select json_agg(a) from pos_approvers() a);
  end if;
  if not (select has_pin from pos_approvers() where staff_id = v_sup) then raise exception 'FAIL approvers: has_pin'; end if;
  begin perform clear_pos_pin(v_sup); raise exception 'FAIL: cashier cleared a PIN';
  exception when raise_exception then if sqlerrm <> 'Only a manager can clear a PIN' then raise; end if; end;

  -- ── F. totals of a real bill; takeaway fee snapshot ────────────────────────
  -- (the cashier places the orders: any staff member may)
  v_order := place_counter_order(v_t1.id, 'dine_in', 4,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_var, 'qty', 4)),
    gen_random_uuid());
  select b.* into v_bill from bills b join orders o on o.bill_id = b.id where o.id = v_order;
  if (select takeaway_fee_sen from order_items where order_id = v_order) <> 0 then raise exception 'FAIL fee: dine-in item has a fee'; end if;
  v_res := pos_bill_totals(v_bill.id);
  if (v_res->>'subtotalSen')::int <> 8000 or (v_res->>'serviceChargeSen')::int <> 800 or (v_res->>'sstSen')::int <> 480
     or (v_res->>'totalSen')::int <> 9280 then
    raise exception 'FAIL totals: %', v_res;
  end if;
  v_order := place_counter_order(null, 'takeaway', null,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_var, 'qty', 2)), gen_random_uuid());
  select b.* into v_bill2 from bills b join orders o on o.bill_id = b.id where o.id = v_order;
  if (select takeaway_fee_sen from order_items where order_id = v_order) <> 100 then raise exception 'FAIL fee: takeaway not snapshotted'; end if;
  v_res := pos_bill_totals(v_bill2.id);
  -- 4000 + SST 240 + fee 200, no service charge on takeaway (the rule is dine-in only)
  if (v_res->>'takeawayFeeSen')::int <> 200 or (v_res->>'serviceChargeSen')::int <> 0 or (v_res->>'totalSen')::int <> 4440 then
    raise exception 'FAIL takeaway totals: %', v_res;
  end if;

  -- ── G. checkout ───────────────────────────────────────────────────────────
  begin perform checkout_bill(v_bill.id, jsonb_build_array(jsonb_build_object('methodId', v_tng, 'amountSen', 9000)), gen_random_uuid());
    raise exception 'FAIL: short payment accepted';
  exception when raise_exception then if sqlerrm <> 'Payments (RM 90.00) do not match the total (RM 92.80)' then raise; end if; end;
  begin perform checkout_bill(v_bill.id, jsonb_build_array(jsonb_build_object('methodId', v_tng, 'amountSen', 9280, 'tenderedSen', 10000)), gen_random_uuid());
    raise exception 'FAIL: change on e-wallet';
  exception when raise_exception then if sqlerrm <> 'Only cash can be tendered above the amount' then raise; end if; end;
  begin perform checkout_bill(v_bill.id, jsonb_build_array(jsonb_build_object('methodId', v_cash, 'amountSen', 9280, 'tenderedSen', 5000)), gen_random_uuid());
    raise exception 'FAIL: cash below amount';
  exception when raise_exception then if sqlerrm <> 'Cash received is less than the amount' then raise; end if; end;
  begin perform checkout_bill(v_bill.id, jsonb_build_array(jsonb_build_object('methodId', v_card, 'amountSen', 9280)), gen_random_uuid());
    raise exception 'FAIL: card without reference';
  exception when raise_exception then if sqlerrm <> 'Enter the reference for V Card' then raise; end if; end;
  begin perform checkout_bill(v_bill.id, jsonb_build_array(jsonb_build_object('methodId', v_far_cash, 'amountSen', 9280)), gen_random_uuid());
    raise exception 'FAIL: other branch method';
  exception when raise_exception then if sqlerrm <> 'Payment method is not available at this branch' then raise; end if; end;
  begin perform checkout_bill(v_bill.id, jsonb_build_array(jsonb_build_object('methodId', v_tng, 'amountSen', 9280.5)), gen_random_uuid());
    raise exception 'FAIL: fractional sen';
  exception when raise_exception then if sqlerrm <> 'Invalid payment amount' then raise; end if; end;
  if exists (select 1 from payments where bill_id = v_bill.id) then raise exception 'FAIL: a refused checkout wrote payments'; end if;

  v_res := checkout_bill(v_bill.id, jsonb_build_array(
    jsonb_build_object('methodId', v_tng, 'amountSen', 5000, 'reference', null),
    jsonb_build_object('methodId', v_cash, 'amountSen', 4280, 'tenderedSen', 5000)), v_checkout);
  if v_res->>'billNo' <> v_bill.bill_no or (v_res->>'totalSen')::int <> 9280 or (v_res->>'changeSen')::int <> 720
     or not (v_res->>'receiptQueued')::boolean then
    raise exception 'FAIL checkout result: %', v_res;
  end if;
  select * into v_bill from bills where id = v_bill.id;
  if v_bill.status <> 'paid' or v_bill.closed_by <> v_staff or v_bill.closed_at is null or v_bill.total_sen <> 9280
     or v_bill.subtotal_sen <> 8000 or v_bill.service_charge_sen <> 800 or v_bill.sst_sen <> 480 or v_bill.rounding_sen <> 0
     or v_bill.totals->'sstGroups'->0->>'baseSen' <> '8000' or not v_bill.receipt_queued then
    raise exception 'FAIL paid bill: %', row_to_json(v_bill);
  end if;
  if (select string_agg(method_name || ':' || amount_sen || ':' || coalesce(tendered_sen, -1) || ':' || change_sen, ',' order by line_no)
        from payments where bill_id = v_bill.id) <> 'V TnG:5000:-1:0,V Cash:4280:5000:720' then
    raise exception 'FAIL payments rows';
  end if;
  select * into v_job from print_jobs where branch_id = v_branch and kind = 'receipt' and payload->>'billNo' = v_bill.bill_no;
  if v_job.route <> 'Bar' or v_job.payload->>'kind' <> 'receipt' or (v_job.payload->>'reprint')::boolean
     or v_job.payload->'header'->>'title' <> 'Verify Cafe' or v_job.payload->'header'->>'sstNo' <> 'W10-VERIFY'
     or v_job.payload->>'cashier' <> 'Verify Cashier' or v_job.payload->>'tableLabel' <> 'V1' or (v_job.payload->>'pax')::int <> 4
     or (v_job.payload->>'itemCount')::int <> 4 or v_job.payload->'items'->0->>'name' <> 'Verify Plate'
     or (v_job.payload->'items'->0->>'amountSen')::int <> 8000 or (v_job.payload->>'totalSen')::int <> 9280
     or v_job.payload->'payments'->1->>'name' <> 'V Cash' or (v_job.payload->'payments'->1->>'tenderedSen')::int <> 5000
     or (v_job.payload->>'changeSen')::int <> 720
     or v_job.payload->'serviceChargeGroups' <> '[{"rateBp": 1000, "baseSen": 8000, "amountSen": 800}]'::jsonb
     or v_job.payload->>'footer' <> 'This is an official receipt. Thank you for visiting us.' then
    raise exception 'FAIL receipt payload: %', v_job.payload;
  end if;
  -- the same checkout again: the first answer, nothing new
  if checkout_bill(v_bill.id, '[]'::jsonb, v_checkout) <> v_res then raise exception 'FAIL checkout replay'; end if;
  select count(*) into n from payments where bill_id = v_bill.id; if n <> 2 then raise exception 'FAIL replay wrote payments'; end if;
  select count(*) into n from print_jobs where branch_id = v_branch and kind = 'receipt' and payload->>'billNo' = v_bill.bill_no;
  if n <> 1 then raise exception 'FAIL replay queued % receipts', n; end if;
  -- a checkout id is only ever replayed for its own bill
  begin perform checkout_bill(v_bill2.id, '[]'::jsonb, v_checkout); raise exception 'FAIL: checkout id reused on another bill';
  exception when raise_exception then if sqlerrm <> 'This checkout id belongs to another bill' then raise; end if; end;
  begin perform checkout_bill(v_bill.id, jsonb_build_array(jsonb_build_object('methodId', v_tng, 'amountSen', 9280)), gen_random_uuid());
    raise exception 'FAIL: paid twice';
  exception when raise_exception then if sqlerrm <> 'This bill is already paid' then raise; end if; end;
  -- a paid bill is closed for good: a new order on its table opens a new bill
  v_order := place_counter_order(v_t1.id, 'dine_in', 2,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_var)), gen_random_uuid());
  if (select bill_id from orders where id = v_order) = v_bill.id then raise exception 'FAIL: order joined a paid bill'; end if;
  select count(*) into n from orders where bill_id = v_bill.id; if n <> 1 then raise exception 'FAIL: paid bill gained orders'; end if;
  select id into v_item from order_items where bill_id = v_bill.id limit 1;
  begin perform void_order_item(v_item, 'Wrong item keyed', v_sup, '1234'); raise exception 'FAIL: voided on a paid bill';
  exception when raise_exception then if sqlerrm not like 'Only items on an open bill can be voided%' then raise; end if; end;
  -- reprint
  perform reprint_receipt(v_bill.id);
  select count(*) into n from print_jobs where branch_id = v_branch and kind = 'receipt' and payload->>'billNo' = v_bill.bill_no
     and (payload->>'reprint')::boolean;
  if n <> 1 then raise exception 'FAIL reprint'; end if;
  update branch_pos_settings set receipt_route = null where branch_id = v_branch;
  begin perform reprint_receipt(v_bill.id); raise exception 'FAIL: reprint without a printer';
  exception when raise_exception then if sqlerrm not like 'No receipt printer is set%' then raise; end if; end;
  update branch_pos_settings set receipt_route = 'Bar' where branch_id = v_branch;
  -- nothing to pay for
  v_item := open_table(v_t3.id, 2);
  begin perform checkout_bill(v_item, '[]'::jsonb, gen_random_uuid()); raise exception 'FAIL: empty bill paid';
  exception when raise_exception then if sqlerrm <> 'This bill has no items to pay for' then raise; end if; end;

  -- ── H. void item: reasons, approver, PIN, lockout ─────────────────────────
  select b.* into v_bill3 from bills b where b.table_id = v_t1.id and b.status = 'open';     -- V1's new bill
  select id into v_item from order_items where bill_id = v_bill3.id limit 1;
  begin perform void_order_item(v_item, '', v_sup, '1234'); raise exception 'FAIL: no reason';
  exception when raise_exception then if sqlerrm <> 'Choose a reason' then raise; end if; end;
  begin perform void_order_item(v_item, 'Felt like it', v_sup, '1234'); raise exception 'FAIL: unlisted reason';
  exception when raise_exception then if sqlerrm <> 'Choose one of the listed reasons' then raise; end if; end;
  begin perform void_order_item(v_item, 'Wrong item keyed', v_staff, '1234'); raise exception 'FAIL: cashier approved';
  exception when raise_exception then if sqlerrm <> 'This person cannot approve voids or refunds' then raise; end if; end;
  begin perform void_order_item(v_item, 'Wrong item keyed', v_far, '9999'); raise exception 'FAIL: other branch approved';
  exception when raise_exception then if sqlerrm <> 'The approver is not active staff of this branch' then raise; end if; end;
  -- a resigned person keeps is_active = true; status = 'resigned' must end their authority
  update staff set status = 'resigned' where id = v_sup;
  begin perform void_order_item(v_item, 'Wrong item keyed', v_sup, '1234'); raise exception 'FAIL: resigned approver approved';
  exception when raise_exception then if sqlerrm <> 'The approver is not active staff of this branch' then raise; end if; end;
  update staff set status = 'active' where id = v_sup;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  update staff set status = 'resigned' where id = v_staff;                     -- the owner changes it (staff_guard)
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  begin perform place_counter_order(v_t2.id, 'dine_in', 1,
          jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_var)), gen_random_uuid());
    raise exception 'FAIL: resigned cashier ordered';
  exception when raise_exception then if sqlerrm <> 'Your account is not active' then raise; end if; end;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  update staff set status = 'active' where id = v_staff;
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  v_res := void_order_item(v_item, 'Wrong item keyed', v_owner, '1234');
  if (v_res->>'ok')::boolean or v_res->>'error' not like 'No POS PIN is set%' then raise exception 'FAIL: approver without a PIN: %', v_res; end if;
  v_res := void_order_item(v_item, 'Wrong item keyed', v_sup, '0000');
  if (v_res->>'ok')::boolean or v_res->>'error' <> 'Wrong PIN — 4 tries left' then raise exception 'FAIL wrong PIN: %', v_res; end if;
  if (select voided_at from order_items where id = v_item) is not null then raise exception 'FAIL: wrong PIN voided'; end if;
  if (select failed_attempts from staff_pos_pins where staff_id = v_sup) <> 1 then raise exception 'FAIL: wrong PIN not counted'; end if;
  v_res := void_order_item(v_item, ' Wrong item keyed ', v_sup, '1234');
  if not (v_res->>'ok')::boolean then raise exception 'FAIL void item: %', v_res; end if;
  if not exists (select 1 from order_items where id = v_item and voided_at is not null and voided_by = v_staff
                   and void_approved_by = v_sup and void_reason = 'Wrong item keyed') then
    raise exception 'FAIL void item audit';
  end if;
  select * into v_job from print_jobs where order_id = (select order_id from order_items where id = v_item)
     and (payload->>'void')::boolean;
  if v_job.route <> 'Bar' or v_job.payload->'lines'->0->>'name' <> 'Verify Plate' or v_job.payload->>'tableLabel' <> 'V1' then
    raise exception 'FAIL void ticket: %', v_job.payload;
  end if;
  if not (void_order_item(v_item, 'Wrong item keyed', v_sup, '0000')->>'ok')::boolean then raise exception 'FAIL void retry'; end if;
  select count(*) into n from print_jobs where order_id = (select order_id from order_items where id = v_item) and (payload->>'void')::boolean;
  if n <> 1 then raise exception 'FAIL void retry printed again'; end if;
  -- lockout: 5 wrong PINs lock the approver for 10 minutes, even the right PIN
  v_order := place_counter_order(v_t1.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_var)), gen_random_uuid());
  select id into v_item from order_items where order_id = v_order;
  for n in 1..4 loop perform void_order_item(v_item, 'Wrong item keyed', v_sup, '0000'); end loop;
  v_res := void_order_item(v_item, 'Wrong item keyed', v_sup, '0000');
  if v_res->>'error' <> 'Wrong PIN — locked for 10 minutes after 5 wrong tries' then raise exception 'FAIL lockout: %', v_res; end if;
  v_res := void_order_item(v_item, 'Wrong item keyed', v_sup, '1234');
  if (v_res->>'ok')::boolean or v_res->>'error' not like 'Too many wrong PINs — locked until %' then raise exception 'FAIL locked: %', v_res; end if;
  update staff_pos_pins set locked_until = now() - interval '1 second' where staff_id = v_sup;
  -- wrong tries older than a day are forgotten: 4 old failures + 1 new = "4 tries left", not a lock
  update staff_pos_pins set failed_attempts = 4, updated_at = now() - interval '2 days' where staff_id = v_sup;
  v_res := void_order_item(v_item, 'Wrong item keyed', v_sup, '0000');
  if v_res->>'error' <> 'Wrong PIN — 4 tries left' then raise exception 'FAIL: old failures still counted: %', v_res; end if;
  -- the supervisor may approve their own action
  perform set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
  if not (void_order_item(v_item, 'Customer changed mind', v_sup, '1234')->>'ok')::boolean then raise exception 'FAIL self-approval'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);

  -- ── I. void bill; empty bill closes without approval ──────────────────────
  v_order := place_counter_order(v_t2.id, 'dine_in', 2,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_var, 'qty', 2)), gen_random_uuid());
  select b.* into v_bill2 from bills b join orders o on o.bill_id = b.id where o.id = v_order;
  begin perform void_bill(v_bill2.id, '', v_sup, '1234'); raise exception 'FAIL: void bill without reason';
  exception when raise_exception then if sqlerrm <> 'Choose a reason' then raise; end if; end;
  v_res := void_bill(v_bill2.id, 'Customer left', v_sup, '1234');
  if not (v_res->>'ok')::boolean then raise exception 'FAIL void bill: %', v_res; end if;
  select * into v_bill2 from bills where id = v_bill2.id;
  if v_bill2.status <> 'voided' or v_bill2.closed_at is null or v_bill2.void_reason <> 'Customer left' or v_bill2.void_approved_by <> v_sup
     or exists (select 1 from order_items where bill_id = v_bill2.id and voided_at is null) then
    raise exception 'FAIL voided bill: %', row_to_json(v_bill2);
  end if;
  if not exists (select 1 from print_jobs where order_id = v_order and (payload->>'void')::boolean) then raise exception 'FAIL void bill ticket'; end if;
  select id into v_item from bills where table_id = v_t3.id and status = 'open';      -- V3: opened, nothing ordered
  if not (void_bill(v_item, null, null, null)->>'ok')::boolean then raise exception 'FAIL: empty bill needs approval'; end if;

  -- ── J. move and merge ─────────────────────────────────────────────────────
  v_order := place_counter_order(v_t2.id, 'dine_in', 2,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_var)), gen_random_uuid());
  select b.* into v_bill2 from bills b join orders o on o.bill_id = b.id where o.id = v_order;     -- open on V2
  begin perform move_bill(v_bill3.id, v_t2.id); raise exception 'FAIL: moved onto an occupied table';
  exception when raise_exception then if sqlerrm <> 'Table V2 already has an open bill — merge instead' then raise; end if; end;
  perform move_bill(v_bill3.id, v_t3.id);
  if (select table_id from bills where id = v_bill3.id) <> v_t3.id then raise exception 'FAIL move'; end if;
  v_order := place_counter_order(null, 'takeaway', null,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_var)), gen_random_uuid());
  select b.* into v_bill from bills b join orders o on o.bill_id = b.id where o.id = v_order;       -- a takeaway bill
  begin perform move_bill(v_bill.id, v_t4.id); raise exception 'FAIL: takeaway moved';
  exception when raise_exception then if sqlerrm <> 'Only a dine-in bill can move to another table' then raise; end if; end;
  begin perform merge_bills(v_bill3.id, v_bill.id); raise exception 'FAIL: table bill merged into a takeaway';
  exception when raise_exception then
    if sqlerrm <> 'Merge the takeaway bill into the table''s bill, not the other way round' then raise; end if;
  end;
  -- merge V2's bill (pax 2) into V3's bill (pax 2): V3 gets every order and item, pax 4, V2 is free
  select count(*) into n from order_items where bill_id in (v_bill2.id, v_bill3.id);
  perform merge_bills(v_bill2.id, v_bill3.id);
  if (select count(*) from order_items where bill_id = v_bill3.id) <> n or exists (select 1 from orders where bill_id = v_bill2.id) then
    raise exception 'FAIL merge: items';
  end if;
  select * into v_bill2 from bills where id = v_bill2.id;
  if v_bill2.status <> 'merged' or v_bill2.merged_into <> v_bill3.id or (select pax from bills where id = v_bill3.id) <> 4 then
    raise exception 'FAIL merge: bills';
  end if;
  v_order := place_counter_order(v_t3.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_var)), gen_random_uuid());
  if (select bill_id from orders where id = v_order) <> v_bill3.id then raise exception 'FAIL: order after merge'; end if;
  begin perform merge_bills(v_bill2.id, v_bill3.id); raise exception 'FAIL: merged a merged bill';
  exception when raise_exception then if sqlerrm <> 'Only open bills can be merged' then raise; end if; end;

  -- ── K. refunds ────────────────────────────────────────────────────────────
  select * into v_bill from bills where checkout_id = v_checkout;                                -- the paid #87846-like bill
  begin perform refund_bill(gen_random_uuid(), v_bill3.id, 100, v_cash, 'x', v_sup, '1234'); raise exception 'FAIL: refund on open bill';
  exception when raise_exception then if sqlerrm <> 'Only a paid bill can be refunded' then raise; end if; end;
  begin perform refund_bill(gen_random_uuid(), v_bill.id, 9281, v_cash, 'x', v_sup, '1234'); raise exception 'FAIL: refund above total';
  exception when raise_exception then if sqlerrm <> 'Refund is more than what is left on this bill (RM 92.80)' then raise; end if; end;
  begin perform refund_bill(gen_random_uuid(), v_bill.id, 1300, v_cash, '', v_sup, '1234'); raise exception 'FAIL: refund without reason';
  exception when raise_exception then if sqlerrm <> 'Choose a reason' then raise; end if; end;
  v_res := refund_bill(v_refund, v_bill.id, 1300, v_cash, 'Item not served', v_sup, '0000');
  if (v_res->>'ok')::boolean or exists (select 1 from refunds where id = v_refund) then raise exception 'FAIL: refund with wrong PIN'; end if;
  v_res := refund_bill(v_refund, v_bill.id, 1300, v_cash, 'Item not served', v_sup, '1234');
  if not (v_res->>'ok')::boolean or (v_res->>'refundedSen')::int <> 1300 or not (v_res->>'slipQueued')::boolean then
    raise exception 'FAIL refund: %', v_res;
  end if;
  if not exists (select 1 from refunds where id = v_refund and amount_sen = 1300 and method_name = 'V Cash'
                   and approved_by = v_sup and created_by = v_staff and reason = 'Item not served') then
    raise exception 'FAIL refund row';
  end if;
  if not exists (select 1 from print_jobs where branch_id = v_branch and kind = 'receipt' and payload->>'kind' = 'refund'
                   and payload->>'billNo' = v_bill.bill_no and (payload->>'amountSen')::int = 1300
                   and payload->>'approvedBy' = 'Verify Supervisor') then
    raise exception 'FAIL refund slip';
  end if;
  if refund_bill(v_refund, v_bill.id, 1300, v_cash, 'Item not served', v_sup, '1234') <> v_res
     or (select refunded_sen from bills where id = v_bill.id) <> 1300
     or (select count(*) from refunds where bill_id = v_bill.id) <> 1 then
    raise exception 'FAIL refund replay: the reply must equal the first one';
  end if;
  begin perform refund_bill(gen_random_uuid(), v_bill.id, 8000, v_cash, 'x', v_sup, '1234'); raise exception 'FAIL: refund cap';
  exception when raise_exception then if sqlerrm <> 'Refund is more than what is left on this bill (RM 79.80)' then raise; end if; end;

  -- ── L. QR open-bill switch; a paid table shows nothing to the next party ──
  update branch_pos_settings set qr_requires_open_bill = true where branch_id = v_branch;
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  begin perform place_table_order(v_t4.qr_token, 2, jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_var)), gen_random_uuid());
    raise exception 'FAIL: QR ordered on a table nobody opened';
  exception when raise_exception then if sqlerrm <> 'Please ask our staff to open your table before ordering.' then raise; end if; end;
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  v_item := open_table(v_t4.id, 3);
  if open_table(v_t4.id, null) <> v_item then raise exception 'FAIL open_table not idempotent'; end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  v_order := place_table_order(v_t4.qr_token, null, jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_var)), gen_random_uuid());
  if (select bill_id from orders where id = v_order) <> v_item then raise exception 'FAIL: QR order missed the opened bill'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  perform checkout_bill(v_item, jsonb_build_array(jsonb_build_object('methodId', v_cash, 'amountSen', (pos_bill_totals(v_item)->>'totalSen')::int)), gen_random_uuid());
  if qr_table_state(v_t4.qr_token)->>'billNo' is not null or jsonb_array_length(qr_table_state(v_t4.qr_token)->'items') <> 0 then
    raise exception 'FAIL: the next party sees a paid bill';
  end if;
  update branch_pos_settings set qr_requires_open_bill = false where branch_id = v_branch;

  -- ── M. receipt settings: managers only, route must have a printer ─────────
  begin perform save_receipt_settings('{"receiptTitle": "Nope"}'::jsonb); raise exception 'FAIL: cashier saved settings';
  exception when raise_exception then if sqlerrm <> 'Only a manager can change the receipt settings' then raise; end if; end;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  begin perform clear_pos_pin(v_far); raise exception 'FAIL: cleared a PIN of another branch';
  exception when raise_exception then if sqlerrm <> 'This person is not staff of your branch' then raise; end if; end;
  begin perform save_receipt_settings('{"receiptTitle": "Verify Cafe", "receiptRoute": "Nowhere"}'::jsonb); raise exception 'FAIL: unknown route';
  exception when raise_exception then if sqlerrm <> 'No printer is set for route Nowhere' then raise; end if; end;
  perform save_receipt_settings('{"receiptTitle": " Verify Cafe 2 ", "legalName": "", "phone": "03-1234", "footer": "Thanks!",
                                  "receiptRoute": "Bar", "sstRegistered": false, "cashRounding": "none", "qrRequiresOpenBill": true}'::jsonb);
  -- legalName "" clears it; address is absent from the payload, so it stays as it was
  if (select receipt_title || '|' || coalesce(legal_name, 'null') || '|' || phone || '|' || address from branches where id = v_branch)
       <> 'Verify Cafe 2|null|03-1234|verify street'
     or not exists (select 1 from branch_pos_settings where branch_id = v_branch and not sst_registered and cash_rounding = 'none'
                      and receipt_footer = 'Thanks!' and qr_requires_open_bill) then
    raise exception 'FAIL save_receipt_settings';
  end if;

  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;
rollback;
```

- [ ] **Step 3: Check the copy.** Run:

```bash
node --input-type=module -e 'import { readFileSync } from "node:fs"; const v = JSON.parse(readFileSync("src/features/pos/checkout/billVectors.json", "utf8")); const m = readFileSync("supabase/migration-2026-10-24-pos-checkout-verify.sql", "utf8").match(/\$vectors\$([\s\S]*?)\$vectors\$/); console.log(v.length, JSON.stringify(JSON.parse(m[1])) === JSON.stringify(v))'
```

Expected: `21 true`.

- [ ] **Step 4: Write the dev seed** (dev only — never on prod):

```sql
-- Dev-only seed for POS checkout (craft-os-dev), after seed-2026-10-23-pos-demo-branch.sql.
-- Re-runnable. NEVER run this on prod (prod branches get these from /pos/settings).
-- Demo branch: receipt header, receipts on the Bar route (the ZY301), one 10% dine-in
-- service-charge rule, four payment methods and reason templates.
do $$
declare v_branch uuid;
begin
  if not exists (select 1 from staff where id = '76cbcf9f-905e-450d-9f5e-1c9e72a9373d') then
    raise exception 'STOP: this seed is for craft-os-dev only';
  end if;
  select id into v_branch from branches where name = 'Demo';
  if v_branch is null then raise exception 'STOP: run seed-2026-10-23-pos-demo-branch.sql first'; end if;

  update branches
     set receipt_title = coalesce(receipt_title, 'Craft Cafe - Demo'),
         legal_name    = coalesce(legal_name, 'Craftale Sdn Bhd'),
         phone         = coalesce(phone, '03-0000 0000')
   where id = v_branch;

  insert into branch_pos_settings(branch_id, sst_registered, cash_rounding, receipt_route)
  values (v_branch, true, 'nearest_5_sen', 'Bar')
  on conflict (branch_id) do update set receipt_route = coalesce(branch_pos_settings.receipt_route, excluded.receipt_route);

  if not exists (select 1 from service_charge_rules where branch_id = v_branch) then
    insert into service_charge_rules(branch_id, rate_bp, order_types, sort_order) values (v_branch, 1000, array['dine_in'], 1);
  end if;

  insert into payment_methods(branch_id, name, kind, needs_reference, sort_order) values
    (v_branch, 'Cash', 'cash', false, 1),
    (v_branch, 'Maybank Terminal', 'card', false, 2),
    (v_branch, 'DuitNow QR', 'duitnow', false, 3),
    (v_branch, 'Touch ''n Go', 'ewallet', false, 4)
  on conflict (branch_id, name) do nothing;

  insert into reason_templates(branch_id, action, reasons, compulsory, allow_other) values
    (v_branch, 'void_item', array['Customer changed mind', 'Wrong item keyed', 'Out of stock', 'Kitchen mistake'], true, true),
    (v_branch, 'void_bill', array['Customer left', 'Duplicate bill', 'Test bill'], true, true),
    (v_branch, 'refund',    array['Item not served', 'Wrong charge', 'Quality complaint', 'Customer changed mind'], true, true)
  on conflict (branch_id, action) do nothing;
  raise notice 'Demo branch % checkout settings ready', v_branch;
end $$;
select b.name,
       (select receipt_route from branch_pos_settings s where s.branch_id = b.id) as receipt_route,
       (select count(*) from service_charge_rules r where r.branch_id = b.id) as sc_rules,
       (select count(*) from payment_methods m where m.branch_id = b.id) as methods,
       (select count(*) from reason_templates t where t.branch_id = b.id) as reason_templates
  from branches b where b.name = 'Demo';
```

- [ ] **Step 5: Commit the three files**

```bash
git add src/features/pos/checkout/billVectors.json supabase/migration-2026-10-24-pos-checkout-verify.sql supabase/seed-2026-10-24-pos-checkout-demo.sql
git commit -m "test(pos-checkout): shared bill vectors, verify script for checkout/approvals/refunds, dev seed for Demo checkout settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6 (controller, dashboard of craft-os-dev):** confirm the top bar reads **craft-os-dev** (`egznnbjmicebbhwasloy`) — never the prod project — then run in order, each with `cmd+Return` after loading it into the SQL editor via `window.monaco.editor.getModels()[0].setValue(...)`: (1) `migration-2026-10-24-pos-checkout.sql` → result row `checkout schema applied` (if the dashboard warns about tables without RLS, choose **Run without RLS** — RLS is enabled inside a `do` block it does not read; accept the "Potential issue" dialog for `revoke`); (2) `migration-2026-10-24-pos-checkout-fn.sql` → `checkout functions applied`; (3) `migration-2026-10-24-pos-bill-actions-fn.sql` → `bill action functions applied`; (4) `seed-2026-10-24-pos-checkout-demo.sql` → one row `Demo | Bar | 1 | 4 | 3`; (5) `migration-2026-10-24-pos-checkout-verify.sql` → result row `VERIFY OK`; (6) regression: Sub-plan 2's `migration-2026-10-23-pos-ordering-verify.sql` → `VERIFY OK` (the re-created `pos_insert_order` / `place_table_order` still pass every ordering check). If (5) or (6) fails, the message names the check (`FAIL …`): fix the function file, re-run it, re-run the verify. Record the outcome in the ledger.

---

### Task 6: Pure totals — `computeBill`

**Files:**
- Create: `src/features/pos/checkout/bill.ts`
- Test: `src/features/pos/checkout/bill.test.ts`

**Interfaces:**
- Consumes: `billVectors.json` and the verify script (Task 5).
- Produces (used by Tasks 8, 9, 12):

```ts
export type BillOrderType = 'dine_in' | 'takeaway'
export type CashRounding = 'none' | 'nearest_5_sen'
export interface BillLineInput { productId: string | null; unitPriceSen: number; qty: number; sstRateBp: number; takeawayFeeSen: number; voided: boolean }
export interface ServiceChargeRuleInput { rateBp: number; orderTypes: BillOrderType[]; tableIds: string[] | null; productIds: string[] | null }
export interface BillInput { orderType: BillOrderType; tableId: string | null; sstRegistered: boolean; cashRounding: CashRounding; rules: ServiceChargeRuleInput[]; lines: BillLineInput[] }
export interface ChargeGroup { rateBp: number; baseSen: number; amountSen: number }
export interface BillTotals { subtotalSen: number; serviceChargeSen: number; sstSen: number; takeawayFeeSen: number; beforeRoundingSen: number; roundingSen: number; totalSen: number; sstGroups: ChargeGroup[]; serviceChargeGroups: ChargeGroup[] }
export function roundingDeltaSen(sen: number): number      // −2…+2
export function computeBill(input: BillInput): BillTotals   // = pos_compute_bill(input)
export function formatRate(bp: number): string              // 600 → "6%", 650 → "6.5%"
```

- [ ] **Step 1: Write the failing tests** `src/features/pos/checkout/bill.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { computeBill, formatRate, roundingDeltaSen, type BillInput, type BillTotals } from './bill'
import vectors from './billVectors.json'

interface Vector { name: string; input: BillInput; expected: BillTotals }
const all = vectors as Vector[]

describe('computeBill — shared vectors (same numbers as the SQL verify script)', () => {
  it('has the vectors the design asks for', () => {
    expect(all).toHaveLength(21)
    expect(all[0].expected.totalSen).toBe(9280) // receipt #87846
  })
  for (const v of all) {
    it(v.name, () => {
      expect(computeBill(v.input)).toEqual(v.expected)
    })
  }
})

describe('the SQL verify script carries the very same vectors', () => {
  it('matches billVectors.json exactly', () => {
    const sql = readFileSync(new URL('../../../../supabase/migration-2026-10-24-pos-checkout-verify.sql', import.meta.url), 'utf8')
    const m = sql.match(/\$vectors\$([\s\S]*?)\$vectors\$/)
    expect(m).not.toBeNull()
    expect(JSON.parse((m as RegExpMatchArray)[1])).toEqual(vectors)
  })
})

describe('roundingDeltaSen', () => {
  it('rounds to the nearest 5 sen', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(roundingDeltaSen)).toEqual([0, -1, -2, 2, 1, 0, -1, -2, 2, 1])
  })
})

describe('formatRate', () => {
  it('prints basis points as a percentage', () => {
    expect(formatRate(600)).toBe('6%')
    expect(formatRate(650)).toBe('6.5%')
    expect(formatRate(1000)).toBe('10%')
    expect(formatRate(0)).toBe('0%')
  })
})
```

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run src/features/pos/checkout/bill.test.ts` — Expected: FAIL, `Failed to resolve import "./bill"`.

- [ ] **Step 3: Write `bill.ts`**

```ts
/** Bill totals — the TypeScript mirror of the SQL function pos_compute_bill
 *  (supabase/migration-2026-10-24-pos-checkout-fn.sql). Both take the same
 *  input shape and are tested against the same vectors (billVectors.json, and
 *  the copy inside supabase/migration-2026-10-24-pos-checkout-verify.sql).
 *  The server's result is the truth; this one is for instant display.
 *  All money is integer sen; all rates are basis points (600 = 6%). */

export type BillOrderType = 'dine_in' | 'takeaway'
export type CashRounding = 'none' | 'nearest_5_sen'

export interface BillLineInput {
  productId: string | null
  unitPriceSen: number // variant + modifiers, already
  qty: number
  sstRateBp: number
  takeawayFeeSen: number // snapshotted on the order item; counted only on takeaway bills
  voided: boolean
}

export interface ServiceChargeRuleInput {
  rateBp: number
  orderTypes: BillOrderType[]
  tableIds: string[] | null // null = every table
  productIds: string[] | null // null = every product
}

export interface BillInput {
  orderType: BillOrderType
  tableId: string | null
  sstRegistered: boolean
  cashRounding: CashRounding
  rules: ServiceChargeRuleInput[] // already in sort_order: the first match wins
  lines: BillLineInput[]
}

export interface ChargeGroup {
  rateBp: number
  baseSen: number
  amountSen: number
}

export interface BillTotals {
  subtotalSen: number
  serviceChargeSen: number
  sstSen: number
  takeawayFeeSen: number
  beforeRoundingSen: number
  roundingSen: number
  totalSen: number
  sstGroups: ChargeGroup[] // one per non-zero SST rate, ascending
  serviceChargeGroups: ChargeGroup[] // one per non-zero service-charge rate, ascending
}

/** Whole bill to the nearest 5 sen: …1,2 down; …3,4 up; …6,7 down; …8,9 up. Returns the delta (−2…+2). */
export function roundingDeltaSen(sen: number): number {
  const r = ((sen % 5) + 5) % 5
  if (r === 0) return 0
  return r <= 2 ? -r : 5 - r
}

function groups(bases: Map<number, number>): ChargeGroup[] {
  return [...bases.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rateBp, baseSen]) => ({ rateBp, baseSen, amountSen: Math.round((baseSen * rateBp) / 10000) }))
}

function ruleFor(input: BillInput, line: BillLineInput): ServiceChargeRuleInput | undefined {
  return input.rules.find(
    (r) =>
      r.orderTypes.includes(input.orderType) &&
      (r.tableIds === null || (input.tableId !== null && r.tableIds.includes(input.tableId))) &&
      (r.productIds === null || (line.productId !== null && r.productIds.includes(line.productId))),
  )
}

export function computeBill(input: BillInput): BillTotals {
  const live = input.lines.filter((l) => !l.voided)
  const amount = (l: BillLineInput) => l.unitPriceSen * l.qty
  const subtotalSen = live.reduce((n, l) => n + amount(l), 0)

  const scBases = new Map<number, number>()
  for (const l of live) {
    const rule = ruleFor(input, l)
    if (rule && rule.rateBp > 0) scBases.set(rule.rateBp, (scBases.get(rule.rateBp) ?? 0) + amount(l))
  }
  const serviceChargeGroups = groups(scBases)

  const sstBases = new Map<number, number>()
  if (input.sstRegistered) {
    for (const l of live) if (l.sstRateBp > 0) sstBases.set(l.sstRateBp, (sstBases.get(l.sstRateBp) ?? 0) + amount(l))
  }
  const sstGroups = groups(sstBases)

  const serviceChargeSen = serviceChargeGroups.reduce((n, g) => n + g.amountSen, 0)
  const sstSen = sstGroups.reduce((n, g) => n + g.amountSen, 0)
  const takeawayFeeSen = input.orderType === 'takeaway' ? live.reduce((n, l) => n + l.takeawayFeeSen * l.qty, 0) : 0
  const beforeRoundingSen = subtotalSen + serviceChargeSen + sstSen + takeawayFeeSen
  const roundingSen = input.cashRounding === 'nearest_5_sen' ? roundingDeltaSen(beforeRoundingSen) : 0
  return {
    subtotalSen,
    serviceChargeSen,
    sstSen,
    takeawayFeeSen,
    beforeRoundingSen,
    roundingSen,
    totalSen: beforeRoundingSen + roundingSen,
    sstGroups,
    serviceChargeGroups,
  }
}

/** 600 → "6%", 650 → "6.5%", 1000 → "10%". */
export function formatRate(bp: number): string {
  return `${Number((bp / 100).toFixed(2))}%`
}
```

- [ ] **Step 4: Run the tests.** Run: `npx vitest run src/features/pos/checkout/bill.test.ts` — Expected: PASS (25 tests: 21 vectors, the count, the SQL copy, rounding, formatRate). Then `npx tsc -b` — Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/features/pos/checkout/bill.ts src/features/pos/checkout/bill.test.ts
git commit -m "feat(pos-checkout): computeBill mirrors pos_compute_bill on the shared vectors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Receipt and refund-slip renderers, VOID banner, one job dispatcher for the agent and the iPad

**Files:**
- Create: `src/features/pos/print/receipt.ts`, `src/features/pos/print/printJob.ts`
- Test: `src/features/pos/print/receipt.test.ts`, `src/features/pos/print/printJob.test.ts` (new); `src/features/pos/print/ticket.test.ts`, `src/features/pos/print/adapter.test.ts` (one case each)
- Modify: `src/features/pos/print/ticket.ts`, `src/features/pos/print/printHost.ts`, `src/features/pos/print/adapter.ts`, `tools/print-agent/agent.ts`, `src/features/pos/order/PrintHostPanel.tsx`

**Interfaces:**
- Consumes: `pos_receipt_payload` / `pos_refund_slip_payload` / `pos_queue_void_tickets` shapes (Tasks 2, 4); `formatMyt`, `wrap` (`ticket.ts`).
- Produces (used by Tasks 8, 9 and both print hosts):

```ts
// receipt.ts
export interface ReceiptHeader { title: string; legalName: string | null; registrationNo: string | null; sstNo: string | null; address: string | null; phone: string | null; email: string | null }
export interface ReceiptItem { qty: number; name: string; unitSen: number; amountSen: number; mods: string[] }
export interface ReceiptCharge { rateBp: number; baseSen: number; amountSen: number }
export interface ReceiptPayment { name: string; kind: 'cash' | 'card' | 'duitnow' | 'ewallet' | 'other'; amountSen: number; tenderedSen: number | null; reference: string | null }
export interface ReceiptPayload { kind: 'receipt'; route: string; reprint: boolean; header: ReceiptHeader; billNo: string; closedAt: string; cashier: string | null; tableLabel: string | null; pax: number | null; items: ReceiptItem[]; itemCount: number; subtotalSen: number; sstGroups: ReceiptCharge[]; serviceChargeGroups: ReceiptCharge[]; takeawayFeeSen: number; roundingSen: number; totalSen: number; payments: ReceiptPayment[]; changeSen: number; footer: string }
export interface RefundSlipPayload { kind: 'refund'; route: string; title: string; billNo: string; refundedAt: string; amountSen: number; methodName: string; reason: string | null; refundedBy: string | null; approvedBy: string | null }
export function toAscii(text: string): string
export function money(sen: number): string                     // 9280 → "92.80"
export function renderReceiptLines(r: ReceiptPayload, cols: number): string[]
export function renderRefundSlipLines(s: RefundSlipPayload, cols: number): string[]
// printJob.ts
export type JobPayload = TicketPayload | ReceiptPayload | RefundSlipPayload
export function renderJobLines(payload: JobPayload, cols: number): string[]
export function jobLabel(payload: JobPayload): string
// ticket.ts
TicketPayload.void?: true   // rendered as a first line "*** VOID ***"
// printHost.ts
PrintJob.payload: JobPayload
```

- [ ] **Step 1: Write the failing tests.** Create `src/features/pos/print/receipt.test.ts` (the first case is receipt #87846 at 48 columns, line for line):

```ts
import { describe, it, expect } from 'vitest'
import { money, toAscii, renderReceiptLines, renderRefundSlipLines, type ReceiptPayload, type RefundSlipPayload } from './receipt'

// Receipt #87846 (Craft Cafe Cheras, 22/10/2026): the four prices, the totals and the
// payment are the real ones; item names, header numbers and the time are placeholders
// (see the plan's open points) — the layout is what this test pins.
const r87846: ReceiptPayload = {
  kind: 'receipt', route: 'Bar', reprint: false,
  header: {
    title: 'Craft Cafe – Cheras', legalName: 'Craftale Sdn Bhd', registrationNo: '000000-X', sstNo: 'W10-0000-00000000',
    address: 'Taman Connaught, 56000 Cheras, Kuala Lumpur', phone: '03-0000 0000', email: 'cheras@example.com',
  },
  billNo: '87846', closedAt: '2026-10-22T05:12:00.000Z', cashier: 'Aina', tableLabel: 'T7', pax: 4,
  items: [
    { qty: 1, name: 'Chicken Chop', unitSen: 2400, amountSen: 2400, mods: [] },
    { qty: 1, name: 'Beef Lasagna', unitSen: 2500, amountSen: 2500, mods: [] },
    { qty: 1, name: 'Carbonara', unitSen: 1800, amountSen: 1800, mods: [] },
    { qty: 1, name: 'Coffee Latte (COLD)', unitSen: 1300, amountSen: 1300, mods: ['Oat milk'] },
  ],
  itemCount: 4,
  subtotalSen: 8000,
  sstGroups: [{ rateBp: 600, baseSen: 8000, amountSen: 480 }],
  serviceChargeGroups: [{ rateBp: 1000, baseSen: 8000, amountSen: 800 }],
  takeawayFeeSen: 0, roundingSen: 0, totalSen: 9280,
  payments: [{ name: "Touch 'n Go", kind: 'ewallet', amountSen: 9280, tenderedSen: null, reference: null }],
  changeSen: 0,
  footer: 'This is an official receipt. Thank you for visiting us.',
}

describe('money / toAscii', () => {
  it('formats sen as ringgit with a sign', () => {
    expect(money(9280)).toBe('92.80')
    expect(money(-2)).toBe('-0.02')
    expect(money(0)).toBe('0.00')
  })
  it('maps look-alikes to ASCII and anything else to ?', () => {
    expect(toAscii('Craft Cafe – Cheras')).toBe('Craft Cafe - Cheras')
    expect(toAscii('拿铁 Latte')).toBe('?? Latte')
  })
})

describe('renderReceiptLines', () => {
  it('reproduces receipt #87846 at 48 columns', () => {
    expect(renderReceiptLines(r87846, 48)).toEqual([
      '              Craft Cafe - Cheras',
      '                Craftale Sdn Bhd',
      '                REG NO: 000000-X',
      '           SST NO: W10-0000-00000000',
      '  Taman Connaught, 56000 Cheras, Kuala Lumpur',
      '               TEL: 03-0000 0000',
      '               cheras@example.com',
      '',
      'Invoice no                                 87846',
      'Date                            22/10/2026 13:12',
      'Cashier                                     Aina',
      'Table pax                                      4',
      '                    ORDER T7',
      '------------------------------------------------',
      '1 Chicken Chop (24.00/ea)                  24.00',
      '1 Beef Lasagna (25.00/ea)                  25.00',
      '1 Carbonara (18.00/ea)                     18.00',
      '1 Coffee Latte (COLD) (13.00/ea)           13.00',
      '   + Oat milk',
      '------------------------------------------------',
      'Item count                                     4',
      'Subtotal                                   80.00',
      'SST (6%)                                    4.80',
      'SERVICE CHARGE (10%)                        8.00',
      'Bill rounding                               0.00',
      '================================================',
      'Total (MYR)                                92.80',
      '================================================',
      "Touch 'n Go                                92.80",
      'Change                                      0.00',
      '------------------------------------------------',
      'Charges summary',
      '                             Base Amt     Amount',
      'SST 6%                          80.00       4.80',
      'SERVICE CHARGE 10%              80.00       8.00',
      '------------------------------------------------',
      '   This is an official receipt. Thank you for',
      '                  visiting us.',
    ])
  })

  it('takeaway cash reprint: banner, no table, packaging fee, negative rounding, tendered and change', () => {
    const out = renderReceiptLines({
      ...r87846, reprint: true, tableLabel: null, pax: null,
      items: [
        { qty: 2, name: 'Coffee Latte (COLD)', unitSen: 1300, amountSen: 2600, mods: [] },
        { qty: 1, name: 'Burnt Cheesecake', unitSen: 1250, amountSen: 1250, mods: [] },
      ],
      itemCount: 3, subtotalSen: 3850,
      sstGroups: [{ rateBp: 600, baseSen: 3850, amountSen: 231 }], serviceChargeGroups: [],
      takeawayFeeSen: 300, roundingSen: -1, totalSen: 4380,
      payments: [{ name: 'Cash', kind: 'cash', amountSen: 4380, tenderedSen: 5000, reference: null }],
      changeSen: 620,
    }, 48)
    expect(out[0]).toBe('                *** REPRINT ***')
    expect(out).toContain('                    TAKEAWAY')
    expect(out).not.toContain('Table pax                                      4')
    expect(out).toContain('2 Coffee Latte (COLD) (13.00/ea)           26.00')
    expect(out).toContain('Takeaway packaging                          3.00')
    expect(out).toContain('Bill rounding                              -0.01')
    expect(out).toContain('Total (MYR)                                43.80')
    expect(out).toContain('Cash                                       50.00')
    expect(out).toContain('Change                                      6.20')
    expect(out).not.toContain('SERVICE CHARGE 10%              80.00       8.00')
  })

  it('prints a payment reference under the payment and wraps a long item name', () => {
    const out = renderReceiptLines({
      ...r87846,
      items: [{ qty: 1, name: 'Fried Chicken Curry DON with extra sauce on the side', unitSen: 2400, amountSen: 2400, mods: [] }],
      payments: [{ name: 'Maybank Terminal', kind: 'card', amountSen: 9280, tenderedSen: null, reference: '004512' }],
    }, 48)
    expect(out).toContain('1 Fried Chicken Curry DON with extra sauce 24.00')
    expect(out).toContain('   on the side (24.00/ea)')
    expect(out).toContain('Maybank Terminal                           92.80')
    expect(out).toContain('  Ref: 004512')
  })

  it('every line fits the paper and is plain ASCII', () => {
    for (const l of renderReceiptLines(r87846, 48)) {
      expect(l.length).toBeLessThanOrEqual(48)
      expect(/^[\x20-\x7e]*$/.test(l)).toBe(true)
    }
  })
})

describe('renderRefundSlipLines', () => {
  it('lays out a refund slip', () => {
    const s: RefundSlipPayload = {
      kind: 'refund', route: 'Bar', title: 'Craft Cafe – Cheras', billNo: '261024-007', refundedAt: '2026-10-24T06:30:00.000Z',
      amountSen: 1300, methodName: 'Cash', reason: 'Item not served', refundedBy: 'Aina', approvedBy: 'Mei Ling',
    }
    expect(renderRefundSlipLines(s, 48)).toEqual([
      '              Craft Cafe - Cheras',
      '                     REFUND',
      '',
      'Invoice no                            261024-007',
      'Date                            24/10/2026 14:30',
      'Refunded by                                 Aina',
      'Approved by                             Mei Ling',
      '------------------------------------------------',
      'Refund (MYR)                               13.00',
      'Paid back by                                Cash',
      'Reason: Item not served',
      '------------------------------------------------',
    ])
  })
})
```

Create `src/features/pos/print/printJob.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { jobLabel, renderJobLines, type JobPayload } from './printJob'
import { renderTicketLines, type TicketPayload } from './ticket'
import { renderReceiptLines, renderRefundSlipLines, type ReceiptPayload, type RefundSlipPayload } from './receipt'

const ticket: TicketPayload = {
  kind: 'ticket', route: 'Kitchen', tableLabel: 'T2', orderNo: '261024-003/1', source: 'counter',
  placedAt: '2026-10-24T04:00:00.000Z', lines: [{ qty: 1, name: 'Carbonara', note: null, mods: [] }],
}
const receipt: ReceiptPayload = {
  kind: 'receipt', route: 'Bar', reprint: false,
  header: { title: 'Craft Cafe', legalName: null, registrationNo: null, sstNo: null, address: null, phone: null, email: null },
  billNo: '261024-003', closedAt: '2026-10-24T05:00:00.000Z', cashier: 'Aina', tableLabel: null, pax: null,
  items: [{ qty: 1, name: 'Carbonara', unitSen: 1800, amountSen: 1800, mods: [] }], itemCount: 1,
  subtotalSen: 1800, sstGroups: [], serviceChargeGroups: [], takeawayFeeSen: 0, roundingSen: 0, totalSen: 1800,
  payments: [{ name: 'Cash', kind: 'cash', amountSen: 1800, tenderedSen: 2000, reference: null }], changeSen: 200, footer: 'Thanks',
}
const refund: RefundSlipPayload = {
  kind: 'refund', route: 'Bar', title: 'Craft Cafe', billNo: '261024-003', refundedAt: '2026-10-24T06:00:00.000Z',
  amountSen: 1800, methodName: 'Cash', reason: null, refundedBy: 'Aina', approvedBy: 'Aina',
}

describe('renderJobLines', () => {
  it('renders each kind with its own renderer', () => {
    expect(renderJobLines(ticket, 42)).toEqual(renderTicketLines(ticket, 42))
    expect(renderJobLines(receipt, 48)).toEqual(renderReceiptLines(receipt, 48))
    expect(renderJobLines(refund, 48)).toEqual(renderRefundSlipLines(refund, 48))
  })
  it('refuses a payload it does not know', () => {
    expect(() => renderJobLines({ kind: 'label' } as unknown as JobPayload, 42)).toThrow('Unknown print job kind: label')
  })
})

describe('jobLabel', () => {
  it('names the job for the printer-problems list', () => {
    expect(jobLabel(ticket)).toBe('261024-003/1 · T2')
    expect(jobLabel({ ...ticket, tableLabel: null, void: true })).toBe('261024-003/1 · takeaway · VOID')
    expect(jobLabel(receipt)).toBe('Receipt 261024-003 · takeaway')
    expect(jobLabel(refund)).toBe('Refund slip 261024-003')
  })
})
```

In `src/features/pos/print/ticket.test.ts` make this replacement (append a case inside `describe('renderTicketLines', …)`):

1. Replace:

```ts
    expect(out.slice(5, 9)).toEqual([
      '2 x Coffee Latte (COLD)',
      '    + Oat milk',
      '    + Extra shot',
      '    * less ice',
    ])
  })
```

   with:

```ts
    expect(out.slice(5, 9)).toEqual([
      '2 x Coffee Latte (COLD)',
      '    + Oat milk',
      '    + Extra shot',
      '    * less ice',
    ])
  })

  it('puts a VOID banner above a void ticket and keeps the rest unchanged', () => {
    const out = renderTicketLines({ ...base, void: true }, 32)
    expect(out[0]).toBe('*** VOID ***')
    expect(out.slice(1)).toEqual(renderTicketLines(base, 32))
  })
```

In `src/features/pos/print/adapter.test.ts` make these replacements:

1. Replace:

```ts
import type { TicketPayload } from './ticket'
```

   with:

```ts
import type { TicketPayload } from './ticket'
import type { ReceiptPayload } from './receipt'
```

2. Replace:

```ts
  it('refuses routes that belong to the print agent', async () => {
```

   with:

```ts
  it('prints a receipt through the job dispatcher', async () => {
    const receipt: ReceiptPayload = {
      kind: 'receipt', route: 'Bar', reprint: false,
      header: { title: 'Craft Cafe', legalName: null, registrationNo: null, sstNo: null, address: null, phone: null, email: null },
      billNo: '261024-001', closedAt: '2026-10-24T05:00:00.000Z', cashier: 'Aina', tableLabel: 'T1', pax: 2,
      items: [{ qty: 1, name: 'Latte', unitSen: 1300, amountSen: 1300, mods: [] }], itemCount: 1,
      subtotalSen: 1300, sstGroups: [], serviceChargeGroups: [], takeawayFeeSen: 0, roundingSen: 0, totalSen: 1300,
      payments: [{ name: 'Cash', kind: 'cash', amountSen: 1300, tenderedSen: null, reference: null }], changeSen: 0, footer: 'Thanks',
    }
    const f = fakeFetch(200, '<response success="true" code="" status="251658262"/>')
    await printFromBrowser(epson, receipt, f)
    expect(String(vi.mocked(f).mock.calls[0][1]?.body)).toContain('Total (MYR)')
  })

  it('refuses routes that belong to the print agent', async () => {
```

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run src/features/pos/print` — Expected: FAIL (`./receipt` and `./printJob` not found; the VOID case fails).

- [ ] **Step 3: Write `receipt.ts`**

```ts
// Explicit .ts extension: the Node print agent loads this file directly (no bundler).
import { formatMyt, wrap } from './ticket.ts'

/** The customer receipt. pos_receipt_payload (supabase/migration-2026-10-24-
 *  pos-checkout-fn.sql) builds exactly this shape into print_jobs.payload, so
 *  keep the two in step. Money is integer sen; rates are basis points. */
export interface ReceiptHeader {
  title: string
  legalName: string | null
  registrationNo: string | null
  sstNo: string | null
  address: string | null
  phone: string | null
  email: string | null
}

export interface ReceiptItem {
  qty: number
  name: string
  unitSen: number
  amountSen: number
  mods: string[]
}

export interface ReceiptCharge {
  rateBp: number
  baseSen: number
  amountSen: number
}

export interface ReceiptPayment {
  name: string
  kind: 'cash' | 'card' | 'duitnow' | 'ewallet' | 'other'
  amountSen: number
  tenderedSen: number | null // cash only: what the customer handed over
  reference: string | null
}

export interface ReceiptPayload {
  kind: 'receipt'
  route: string
  reprint: boolean
  header: ReceiptHeader
  billNo: string
  closedAt: string // ISO, UTC
  cashier: string | null
  tableLabel: string | null // null = takeaway
  pax: number | null
  items: ReceiptItem[]
  itemCount: number
  subtotalSen: number
  sstGroups: ReceiptCharge[]
  serviceChargeGroups: ReceiptCharge[]
  takeawayFeeSen: number
  roundingSen: number
  totalSen: number
  payments: ReceiptPayment[]
  changeSen: number
  footer: string
}

/** A short slip printed on the receipt printer when a paid bill is refunded. */
export interface RefundSlipPayload {
  kind: 'refund'
  route: string
  title: string
  billNo: string
  refundedAt: string // ISO, UTC
  amountSen: number
  methodName: string
  reason: string | null
  refundedBy: string | null
  approvedBy: string | null
}

const ASCII_MAP: Record<string, string> = {
  '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '•': '-', ' ': ' ',
}

/** The ZY301 prints anything outside printable ASCII as "?"; map the common
 *  look-alikes first so "Craft Cafe – Cheras" prints as "Craft Cafe - Cheras". */
export function toAscii(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0x3f
    out += code >= 0x20 && code < 0x7f ? ch : (ASCII_MAP[ch] ?? '?')
  }
  return out
}

function asciiDeep<T>(value: T): T {
  if (typeof value === 'string') return toAscii(value) as T
  if (Array.isArray(value)) return value.map(asciiDeep) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, asciiDeep(v)])) as T
  }
  return value
}

/** 9280 → "92.80", −2 → "-0.02". */
export function money(sen: number): string {
  return `${sen < 0 ? '-' : ''}${(Math.abs(sen) / 100).toFixed(2)}`
}

function pct(bp: number): string {
  return `${Number((bp / 100).toFixed(2))}%`
}

/** Label on the left, value flush right; a label too long for one line wraps and the value goes under it. */
function lr(left: string, right: string, cols: number): string[] {
  if (left.length + 1 + right.length <= cols) return [left + ' '.repeat(cols - left.length - right.length) + right]
  return [...wrap(left, cols), right.padStart(cols)]
}

function center(text: string, cols: number): string[] {
  return wrap(text, cols).map((l) => ' '.repeat(Math.max(0, Math.floor((cols - l.length) / 2))) + l)
}

/** "1 Chicken Chop (24.00/ea)" … "24.00": the amount sits on the item's first line. */
function itemLines(it: ReceiptItem, cols: number): string[] {
  const amount = money(it.amountSen)
  const width = cols - amount.length - 1
  const parts = wrap(`${it.qty} ${it.name} (${money(it.unitSen)}/ea)`, width, '   ')
  return [
    `${parts[0].padEnd(width)} ${amount}`,
    ...parts.slice(1),
    ...it.mods.flatMap((m) => wrap(`+ ${m}`, cols - 3, '  ').map((s) => `   ${s}`)),
  ]
}

function chargeRow(label: string, base: string, amount: string, cols: number): string {
  const w = cols - 22
  return label.slice(0, w).padEnd(w) + base.padStart(11) + amount.padStart(11)
}

export function renderReceiptLines(input: ReceiptPayload, cols: number): string[] {
  const r = asciiDeep(input)
  const rule = '-'.repeat(cols)
  const h = r.header
  const header = [
    ...(r.reprint ? center('*** REPRINT ***', cols) : []),
    ...center(h.title, cols),
    ...(h.legalName ? center(h.legalName, cols) : []),
    ...(h.registrationNo ? center(`REG NO: ${h.registrationNo}`, cols) : []),
    ...(h.sstNo ? center(`SST NO: ${h.sstNo}`, cols) : []),
    ...(h.address ? center(h.address, cols) : []),
    ...(h.phone ? center(`TEL: ${h.phone}`, cols) : []),
    ...(h.email ? center(h.email, cols) : []),
    '',
    ...lr('Invoice no', r.billNo, cols),
    ...lr('Date', formatMyt(r.closedAt), cols),
    ...lr('Cashier', r.cashier ?? '-', cols),
    ...(r.pax !== null ? lr('Table pax', String(r.pax), cols) : []),
    ...center(r.tableLabel ? `ORDER ${r.tableLabel}` : 'TAKEAWAY', cols),
  ]
  const totals = [
    ...lr('Item count', String(r.itemCount), cols),
    ...lr('Subtotal', money(r.subtotalSen), cols),
    ...r.sstGroups.flatMap((g) => lr(`SST (${pct(g.rateBp)})`, money(g.amountSen), cols)),
    ...r.serviceChargeGroups.flatMap((g) => lr(`SERVICE CHARGE (${pct(g.rateBp)})`, money(g.amountSen), cols)),
    ...(r.takeawayFeeSen > 0 ? lr('Takeaway packaging', money(r.takeawayFeeSen), cols) : []),
    ...lr('Bill rounding', money(r.roundingSen), cols),
  ]
  const payments = [
    ...r.payments.flatMap((p) => [
      ...lr(p.name, money(p.kind === 'cash' ? (p.tenderedSen ?? p.amountSen) : p.amountSen), cols),
      ...(p.reference ? wrap(`Ref: ${p.reference}`, cols - 2).map((s) => `  ${s}`) : []),
    ]),
    ...lr('Change', money(r.changeSen), cols),
  ]
  const charges = r.sstGroups.length + r.serviceChargeGroups.length > 0
    ? [
        'Charges summary',
        chargeRow('', 'Base Amt', 'Amount', cols),
        ...r.sstGroups.map((g) => chargeRow(`SST ${pct(g.rateBp)}`, money(g.baseSen), money(g.amountSen), cols)),
        ...r.serviceChargeGroups.map((g) => chargeRow(`SERVICE CHARGE ${pct(g.rateBp)}`, money(g.baseSen), money(g.amountSen), cols)),
        rule,
      ]
    : []
  return [
    ...header,
    rule,
    ...r.items.flatMap((it) => itemLines(it, cols)),
    rule,
    ...totals,
    '='.repeat(cols),
    ...lr('Total (MYR)', money(r.totalSen), cols),
    '='.repeat(cols),
    ...payments,
    rule,
    ...charges,
    ...center(r.footer, cols),
  ].map((l) => l.trimEnd())
}

export function renderRefundSlipLines(input: RefundSlipPayload, cols: number): string[] {
  const s = asciiDeep(input)
  const rule = '-'.repeat(cols)
  return [
    ...center(s.title, cols),
    ...center('REFUND', cols),
    '',
    ...lr('Invoice no', s.billNo, cols),
    ...lr('Date', formatMyt(s.refundedAt), cols),
    ...lr('Refunded by', s.refundedBy ?? '-', cols),
    ...lr('Approved by', s.approvedBy ?? '-', cols),
    rule,
    ...lr('Refund (MYR)', money(s.amountSen), cols),
    ...lr('Paid back by', s.methodName, cols),
    ...(s.reason ? wrap(`Reason: ${s.reason}`, cols, '  ') : []),
    rule,
  ].map((l) => l.trimEnd())
}
```

- [ ] **Step 4: Write `printJob.ts`**

```ts
// Explicit .ts extensions: the Node print agent loads this file directly (no bundler).
import { renderTicketLines, type TicketPayload } from './ticket.ts'
import { renderReceiptLines, renderRefundSlipLines, type ReceiptPayload, type RefundSlipPayload } from './receipt.ts'

/** Everything a print_jobs.payload can hold. Both print hosts (the Node agent
 *  and the iPad page) render through renderJobLines, so a new kind is added here once. */
export type JobPayload = TicketPayload | ReceiptPayload | RefundSlipPayload

export function renderJobLines(payload: JobPayload, cols: number): string[] {
  switch (payload.kind) {
    case 'ticket':
      return renderTicketLines(payload, cols)
    case 'receipt':
      return renderReceiptLines(payload, cols)
    case 'refund':
      return renderRefundSlipLines(payload, cols)
    default:
      throw new Error(`Unknown print job kind: ${String((payload as { kind?: unknown }).kind)}`)
  }
}

/** One line for the printer-problems list: what this job is. */
export function jobLabel(payload: JobPayload): string {
  if (payload.kind === 'receipt') return `Receipt ${payload.billNo}${payload.tableLabel ? ` · ${payload.tableLabel}` : ' · takeaway'}`
  if (payload.kind === 'refund') return `Refund slip ${payload.billNo}`
  return `${payload.orderNo}${payload.tableLabel ? ` · ${payload.tableLabel}` : ' · takeaway'}${payload.void ? ' · VOID' : ''}`
}
```

- [ ] **Step 5: VOID banner and the dispatcher in both hosts.** Make exactly these replacements.

`src/features/pos/print/ticket.ts`:

1. Replace:

```ts
  placedAt: string // ISO, UTC
  lines: TicketLine[]
}
```

   with:

```ts
  placedAt: string // ISO, UTC
  lines: TicketLine[]
  void?: true // a void ticket: the kitchen stops these lines
}
```

2. Replace:

```ts
  return [
    `${t.route.toUpperCase()} TICKET`,
```

   with:

```ts
  return [
    ...(t.void ? ['*** VOID ***'] : []),
    `${t.route.toUpperCase()} TICKET`,
```

`src/features/pos/print/printHost.ts`:

1. Replace:

```ts
import type { TicketPayload } from './ticket'
```

   with:

```ts
import type { JobPayload } from './printJob'
```

2. Replace:

```ts
  payload: TicketPayload
```

   with:

```ts
  payload: JobPayload
```

`src/features/pos/print/adapter.ts`:

1. Replace:

```ts
import { renderTicketLines, type TicketPayload } from './ticket'
```

   with:

```ts
import { renderJobLines, type JobPayload } from './printJob'
```

2. Replace:

```ts
  payload: TicketPayload,
```

   with:

```ts
  payload: JobPayload,
```

3. Replace:

```ts
  const lines = renderTicketLines(payload, TICKET_COLS)
```

   with:

```ts
  const lines = renderJobLines(payload, TICKET_COLS)
```

`tools/print-agent/agent.ts`:

1. Replace:

```ts
import { renderTicketLines } from '../../src/features/pos/print/ticket.ts'
```

   with:

```ts
import { renderJobLines } from '../../src/features/pos/print/printJob.ts'
```

2. Replace:

```ts
encodeEscPos(renderTicketLines(j.payload, cols))
```

   with:

```ts
encodeEscPos(renderJobLines(j.payload, cols))
```

`src/features/pos/order/PrintHostPanel.tsx` (receipts have no `orderNo`; the problems list names every job kind):

1. Replace:

```tsx
import { printFromBrowser, type PrintRoute } from '../print/adapter'
```

   with:

```tsx
import { printFromBrowser, type PrintRoute } from '../print/adapter'
import { jobLabel } from '../print/printJob'
```

2. Replace:

```tsx
<div className="font-medium">{j.route} · {j.payload.orderNo}{j.payload.tableLabel ? ` · ${j.payload.tableLabel}` : ' · takeaway'}</div>
```

   with:

```tsx
<div className="font-medium">{j.route} · {jobLabel(j.payload)}</div>
```

- [ ] **Step 6: Gates.** Run: `npx vitest run src/features/pos/print` — Expected: PASS (39 tests). Run: `npx tsc -b` — Expected: no output. Run: `node --check tools/print-agent/agent.ts` — Expected: exit 0. Prove Node (no bundler) resolves the new module graph the agent loads:

```bash
node --input-type=module -e "import { renderJobLines } from './src/features/pos/print/printJob.ts'; console.log(renderJobLines({ kind: 'refund', route: 'Bar', title: 'Craft Cafe', billNo: 'X1', refundedAt: '2026-10-24T06:00:00.000Z', amountSen: 100, methodName: 'Cash', reason: null, refundedBy: null, approvedBy: null }, 48).length)"
```

Expected: `11`. Then `npx vitest run` — Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/features/pos/print tools/print-agent/agent.ts src/features/pos/order/PrintHostPanel.tsx
git commit -m "feat(pos-print): customer receipt and refund slip renderers, VOID banner, one job dispatcher for agent and iPad

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Checkout, approval and settings API layer; bills on Realtime

**Files:**
- Create: `src/features/pos/checkout/rpcResult.ts`, `src/features/pos/checkout/tender.ts`, `src/features/pos/checkout/reasons.ts`, `src/features/pos/checkout/checkoutApi.ts`
- Test: `src/features/pos/checkout/rpcResult.test.ts`, `src/features/pos/checkout/tender.test.ts`, `src/features/pos/checkout/reasons.test.ts`
- Modify: `src/features/pos/order/posApi.ts`, `src/features/pos/order/usePosRealtime.ts`

**Interfaces:**
- Consumes: the RPCs and tables of Tasks 1–4; `BillTotals`, `CashRounding`, `ServiceChargeRuleInput`, `BillOrderType` (Task 6); `writeOutcome`.
- Produces (used by Tasks 9–12):

```ts
// rpcResult.ts
export interface CheckoutResult { billId: string; billNo: string; totalSen: number; changeSen: number; receiptQueued: boolean }
export function unwrapAction(data: unknown): Record<string, unknown>   // throws the server's words on {ok:false}
export function parseCheckoutResult(data: unknown): CheckoutResult
// tender.ts
export type PaymentKind = 'cash' | 'card' | 'duitnow' | 'ewallet' | 'other'
export interface TenderMethod { id: string; name: string; kind: PaymentKind; needsReference: boolean }
export interface TenderLine { key: string; method: TenderMethod; amountSen: number; tenderedSen: number | null; reference: string | null }
export function parseRinggit(text: string): number | null
export function paidSen(lines: TenderLine[]): number
export function remainingSen(totalSen: number, lines: TenderLine[]): number
export function changeSen(lines: TenderLine[]): number
export function quickTenders(dueSen: number): number[]
export function lineProblem(line: Omit<TenderLine, 'key'>, remaining: number): string | null
export function payProblem(totalSen: number, lines: TenderLine[]): string | null
export function toPayments(lines: TenderLine[]): { methodId: string; amountSen: number; tenderedSen: number | null; reference: string | null }[]
// reasons.ts
export type ReasonAction = 'void_item' | 'void_bill' | 'refund'
export interface ReasonTemplate { reasons: string[]; compulsory: boolean; allowOther: boolean }
export const DEFAULT_TEMPLATE: ReasonTemplate
export function reasonProblem(t: ReasonTemplate, reason: string): string | null
export const ACTION_TITLES: Record<ReasonAction, string>
// checkoutApi.ts
export interface PosSettings { sstRegistered: boolean; cashRounding: CashRounding; receiptRoute: string | null; receiptFooter: string; qrRequiresOpenBill: boolean }
export const DEFAULT_POS_SETTINGS: PosSettings
export interface PaymentMethodRow { id: string; branch_id: string; name: string; kind: PaymentKind; needs_reference: boolean; sort_order: number; is_active: boolean }
export interface ServiceChargeRuleRow { id: string; branch_id: string; rate_bp: number; order_types: BillOrderType[]; table_ids: string[] | null; product_ids: string[] | null; sort_order: number; is_active: boolean }
export interface ReasonTemplateRow { branch_id: string; action: ReasonAction; reasons: string[]; compulsory: boolean; allow_other: boolean }
export interface ReceiptDetails { receiptTitle: string; legalName: string; registrationNo: string; sstNo: string; address: string; phone: string; email: string; footer: string; receiptRoute: string | null; sstRegistered: boolean; cashRounding: CashRounding; qrRequiresOpenBill: boolean }
export interface BillingConfig { settings: PosSettings; rules: ServiceChargeRuleInput[] }
export interface Approver { staffId: string; name: string; hasPin: boolean }
export interface PaymentInput { methodId: string; amountSen: number; tenderedSen: number | null; reference: string | null }
export interface Approval { reason: string; approverId: string | null; pin: string | null }
export interface ClosedBillRow { id: string; bill_no: string; table_id: string | null; order_type: BillOrderType; status: 'paid' | 'voided' | 'merged'; closed_at: string; total_sen: number | null; refunded_sen: number; merged_into: string | null; dining_tables: { label: string } | null }
export function fetchPosSettings(branchId: string): Promise<PosSettings>
export function fetchServiceChargeRules(branchId: string): Promise<ServiceChargeRuleRow[]>
export function fetchBillingConfig(branchId: string): Promise<BillingConfig>
export function fetchPaymentMethods(branchId: string, activeOnly: boolean): Promise<PaymentMethodRow[]>
export function fetchReasonTemplates(branchId: string): Promise<ReasonTemplateRow[]>
export function fetchReasonTemplate(branchId: string, action: ReasonAction): Promise<ReasonTemplate | null>
export function fetchReceiptDetails(branchId: string): Promise<ReceiptDetails>
export function fetchBillTotals(billId: string): Promise<BillTotals>
export function checkoutBill(billId: string, payments: PaymentInput[], checkoutId: string): Promise<CheckoutResult>
export function reprintReceipt(billId: string): Promise<void>
export function fetchApprovers(): Promise<Approver[]>
export function setMyPin(newPin: string, currentPin: string | null): Promise<void>
export function clearPin(staffId: string): Promise<void>
export function voidItem(itemId: string, a: Approval): Promise<void>
export function voidBill(billId: string, a: Approval): Promise<void>
export function moveBill(billId: string, tableId: string): Promise<void>
export function mergeBills(fromBillId: string, intoBillId: string): Promise<void>
export function refundBill(refundId: string, billId: string, amountSen: number, methodId: string, a: Approval): Promise<void>
export function openTable(tableId: string, pax: number | null): Promise<string>
export function fetchClosedBillsSince(branchId: string, sinceIso: string): Promise<ClosedBillRow[]>
export function fetchProductNames(): Promise<{ id: string; name: string }[]>
export function saveReceiptDetails(d: ReceiptDetails): Promise<void>
export function savePaymentMethod(row: Omit<PaymentMethodRow, 'id'> & { id?: string }): Promise<void>
export function saveServiceChargeRule(row: Omit<ServiceChargeRuleRow, 'id'> & { id?: string }): Promise<void>
export function deleteServiceChargeRule(id: string): Promise<void>
export function saveReasonTemplate(row: ReasonTemplateRow): Promise<void>
// posApi.ts — BillItemRow gains product_id: string | null; sst_rate_bp: number; takeaway_fee_sen: number
// usePosRealtime.ts — Handlers gains onBill?: (row: BillChange) => void; export interface BillChange { id; branch_id; status; table_id }
```

- [ ] **Step 1: Write the failing tests.** `src/features/pos/checkout/rpcResult.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseCheckoutResult, unwrapAction } from './rpcResult'

describe('unwrapAction', () => {
  it('returns an approved reply', () => {
    expect(unwrapAction({ ok: true, refundedSen: 1300 })).toEqual({ ok: true, refundedSen: 1300 })
  })
  it('throws the server words when refused', () => {
    expect(() => unwrapAction({ ok: false, error: 'Wrong PIN — 4 tries left' })).toThrow('Wrong PIN — 4 tries left')
    expect(() => unwrapAction({ ok: false })).toThrow('Not approved')
  })
  it('throws on anything else', () => {
    expect(() => unwrapAction(null)).toThrow('Unexpected reply')
    expect(() => unwrapAction({ ok: 'yes' })).toThrow('Unexpected reply')
  })
})

describe('parseCheckoutResult', () => {
  it('reads the checkout reply', () => {
    expect(parseCheckoutResult({ billId: 'b1', billNo: '261024-001', totalSen: 9280, changeSen: 0, receiptQueued: true }))
      .toEqual({ billId: 'b1', billNo: '261024-001', totalSen: 9280, changeSen: 0, receiptQueued: true })
  })
  it('refuses a reply with a missing field', () => {
    expect(() => parseCheckoutResult({ billNo: '261024-001', totalSen: 9280 })).toThrow('Unexpected reply')
  })
})
```

`src/features/pos/checkout/tender.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { changeSen, lineProblem, parseRinggit, payProblem, quickTenders, remainingSen, toPayments, type TenderLine, type TenderMethod } from './tender'

const cash: TenderMethod = { id: 'm-cash', name: 'Cash', kind: 'cash', needsReference: false }
const card: TenderMethod = { id: 'm-card', name: 'Maybank Terminal', kind: 'card', needsReference: true }
const tng: TenderMethod = { id: 'm-tng', name: "Touch 'n Go", kind: 'ewallet', needsReference: false }

describe('parseRinggit', () => {
  it('reads ringgit amounts as sen', () => {
    expect(parseRinggit('12.5')).toBe(1250)
    expect(parseRinggit('RM 92.80')).toBe(9280)
    expect(parseRinggit('100')).toBe(10000)
    expect(parseRinggit('1,000.00')).toBe(100000)
  })
  it('refuses junk', () => {
    expect(parseRinggit('')).toBeNull()
    expect(parseRinggit('12.345')).toBeNull()
    expect(parseRinggit('-5')).toBeNull()
    expect(parseRinggit('abc')).toBeNull()
  })
})

describe('split tender', () => {
  const lines: TenderLine[] = [
    { key: '1', method: tng, amountSen: 5000, tenderedSen: null, reference: null },
    { key: '2', method: cash, amountSen: 4280, tenderedSen: 5000, reference: null },
  ]
  it('tracks what is left and the change (cash only)', () => {
    expect(remainingSen(9280, lines)).toBe(0)
    expect(remainingSen(9280, lines.slice(0, 1))).toBe(4280)
    expect(changeSen(lines)).toBe(720)
  })
  it('offers the notes that cover what is due', () => {
    expect(quickTenders(4280)).toEqual([5000, 10000])
    expect(quickTenders(10000)).toEqual([])
  })
  it('says why a line or Pay is not possible', () => {
    expect(lineProblem({ method: cash, amountSen: 1000, tenderedSen: 500, reference: null }, 4280)).toBe('Cash received is less than the amount')
    expect(lineProblem({ method: tng, amountSen: 1000, tenderedSen: 2000, reference: null }, 4280)).toBe('Only cash can be tendered above the amount')
    expect(lineProblem({ method: card, amountSen: 1000, tenderedSen: null, reference: ' ' }, 4280)).toBe('Enter the reference for Maybank Terminal')
    expect(lineProblem({ method: card, amountSen: 5000, tenderedSen: null, reference: '1' }, 4280)).toBe('That is more than what is left to pay')
    expect(lineProblem({ method: card, amountSen: 0, tenderedSen: null, reference: '1' }, 4280)).toBe('Invalid payment amount')
    expect(lineProblem({ method: card, amountSen: 4280, tenderedSen: null, reference: '004512' }, 4280)).toBeNull()
    expect(payProblem(9280, lines.slice(0, 1))).toBe('RM 42.80 left to pay')
    expect(payProblem(9280, lines)).toBeNull()
  })
  it('builds the checkout_bill payments', () => {
    expect(toPayments([...lines, { key: '3', method: card, amountSen: 1, tenderedSen: 99, reference: ' 77 ' }])).toEqual([
      { methodId: 'm-tng', amountSen: 5000, tenderedSen: null, reference: null },
      { methodId: 'm-cash', amountSen: 4280, tenderedSen: 5000, reference: null },
      { methodId: 'm-card', amountSen: 1, tenderedSen: null, reference: '77' },
    ])
  })
})
```

`src/features/pos/checkout/reasons.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { DEFAULT_TEMPLATE, reasonProblem } from './reasons'

describe('reasonProblem', () => {
  const listed = { reasons: ['Customer changed mind', 'Wrong item keyed'], compulsory: true, allowOther: false }
  it('needs a reason when compulsory', () => {
    expect(reasonProblem(listed, '  ')).toBe('Choose a reason')
    expect(reasonProblem({ ...listed, compulsory: false }, '')).toBeNull()
  })
  it('keeps to the list when Other is not allowed', () => {
    expect(reasonProblem(listed, 'Wrong item keyed')).toBeNull()
    expect(reasonProblem(listed, 'Felt like it')).toBe('Choose one of the listed reasons')
    expect(reasonProblem({ ...listed, allowOther: true }, 'Felt like it')).toBeNull()
  })
  it('defaults to "any reason, but one is required"', () => {
    expect(reasonProblem(DEFAULT_TEMPLATE, '')).toBe('Choose a reason')
    expect(reasonProblem(DEFAULT_TEMPLATE, 'Spilled')).toBeNull()
  })
  it('caps the length', () => {
    expect(reasonProblem(DEFAULT_TEMPLATE, 'x'.repeat(201))).toBe('Reason is too long')
  })
})
```

- [ ] **Step 2: Run to verify they fail.** Run: `npx vitest run src/features/pos/checkout` — Expected: FAIL (`./rpcResult`, `./tender`, `./reasons` not found); `bill.test.ts` still passes.

- [ ] **Step 3: Write the three pure modules.** `src/features/pos/checkout/rpcResult.ts`:

```ts
/** Replies of the protected POS RPCs. A wrong approver PIN is not raised as an
 *  error on the server — the failed-attempt counter must be saved, and a raise
 *  would roll it back — so those functions answer {ok:false, error} instead. */

export interface CheckoutResult {
  billId: string
  billNo: string
  totalSen: number
  changeSen: number
  receiptQueued: boolean
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

/** Throws the server's words when the action was refused; returns the reply otherwise. */
export function unwrapAction(data: unknown): Record<string, unknown> {
  if (!isObj(data) || typeof data.ok !== 'boolean') throw new Error('Unexpected reply from the server')
  if (!data.ok) throw new Error(typeof data.error === 'string' && data.error ? data.error : 'Not approved')
  return data
}

export function parseCheckoutResult(data: unknown): CheckoutResult {
  if (!isObj(data) || typeof data.billId !== 'string' || typeof data.billNo !== 'string'
      || typeof data.totalSen !== 'number' || typeof data.changeSen !== 'number' || typeof data.receiptQueued !== 'boolean') {
    throw new Error('Unexpected reply from the server')
  }
  return { billId: data.billId, billNo: data.billNo, totalSen: data.totalSen, changeSen: data.changeSen, receiptQueued: data.receiptQueued }
}
```

`src/features/pos/checkout/tender.ts`:

```ts
/** Split tender on the checkout sheet. The server repeats every one of these
 *  checks (checkout_bill) with the same words; this is only so the cashier
 *  sees the problem before pressing Pay. */

export type PaymentKind = 'cash' | 'card' | 'duitnow' | 'ewallet' | 'other'

export interface TenderMethod {
  id: string
  name: string
  kind: PaymentKind
  needsReference: boolean
}

export interface TenderLine {
  key: string
  method: TenderMethod
  amountSen: number
  tenderedSen: number | null // cash only; null = exact
  reference: string | null
}

/** "12.5" / "RM 12.50" / "12" → sen; null when it is not a sensible amount. */
export function parseRinggit(text: string): number | null {
  const t = text.replace(/rm/i, '').replace(/,/g, '').trim()
  if (!/^\d{1,6}(\.\d{0,2})?$/.test(t)) return null
  const [whole, frac = ''] = t.split('.')
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'))
}

export function paidSen(lines: TenderLine[]): number {
  return lines.reduce((n, l) => n + l.amountSen, 0)
}

export function remainingSen(totalSen: number, lines: TenderLine[]): number {
  return totalSen - paidSen(lines)
}

export function changeSen(lines: TenderLine[]): number {
  return lines.reduce((n, l) => n + (l.method.kind === 'cash' && l.tenderedSen !== null ? l.tenderedSen - l.amountSen : 0), 0)
}

/** Exact, then the notes 10 / 20 / 50 / 100 that cover what is due. */
export function quickTenders(dueSen: number): number[] {
  return [1000, 2000, 5000, 10000].filter((n) => n > dueSen)
}

/** Why this payment line cannot be added, or null. Same words as checkout_bill. */
export function lineProblem(line: Omit<TenderLine, 'key'>, remaining: number): string | null {
  if (!Number.isInteger(line.amountSen) || line.amountSen <= 0) return 'Invalid payment amount'
  if (line.amountSen > remaining) return 'That is more than what is left to pay'
  if (line.tenderedSen !== null) {
    if (line.method.kind !== 'cash') return 'Only cash can be tendered above the amount'
    if (line.tenderedSen < line.amountSen) return 'Cash received is less than the amount'
  }
  if (line.method.needsReference && !line.reference?.trim()) return `Enter the reference for ${line.method.name}`
  return null
}

/** Why Pay is not possible yet, or null. */
export function payProblem(totalSen: number, lines: TenderLine[]): string | null {
  const left = remainingSen(totalSen, lines)
  if (left > 0) return `RM ${(left / 100).toFixed(2)} left to pay`
  if (left < 0) return 'Payments are more than the total'
  return null
}

/** What checkout_bill receives. */
export function toPayments(lines: TenderLine[]): { methodId: string; amountSen: number; tenderedSen: number | null; reference: string | null }[] {
  return lines.map((l) => ({
    methodId: l.method.id,
    amountSen: l.amountSen,
    tenderedSen: l.method.kind === 'cash' ? l.tenderedSen : null,
    reference: l.reference?.trim() || null,
  }))
}
```

`src/features/pos/checkout/reasons.ts`:

```ts
/** Reason templates for voids and refunds (Feedme's "Reason template").
 *  Same rule as pos_check_reason in SQL, with the same words. */

export type ReasonAction = 'void_item' | 'void_bill' | 'refund'

export interface ReasonTemplate {
  reasons: string[]
  compulsory: boolean
  allowOther: boolean
}

/** No template saved for the action: a reason is required, any wording. */
export const DEFAULT_TEMPLATE: ReasonTemplate = { reasons: [], compulsory: true, allowOther: true }

export function reasonProblem(t: ReasonTemplate, reason: string): string | null {
  const r = reason.trim()
  if (!r) return t.compulsory ? 'Choose a reason' : null
  if (!t.allowOther && !t.reasons.includes(r)) return 'Choose one of the listed reasons'
  if (r.length > 200) return 'Reason is too long'
  return null
}

export const ACTION_TITLES: Record<ReasonAction, string> = {
  void_item: 'Void item',
  void_bill: 'Void bill',
  refund: 'Refund',
}
```

- [ ] **Step 4: Run the tests.** Run: `npx vitest run src/features/pos/checkout` — Expected: PASS (bill 25, rpcResult 5, tender 6, reasons 4).

- [ ] **Step 5: Write `checkoutApi.ts`**

```ts
// src/features/pos/checkout/checkoutApi.ts — Supabase calls for checkout, receipts,
// approvals, voids, move/merge, refunds and the checkout sections of /pos/settings.
import { supabase } from '../../../shared/lib/supabase'
import { writeOutcome } from '../../../shared/lib/db-write'
import type { BillOrderType, BillTotals, CashRounding, ServiceChargeRuleInput } from './bill'
import type { PaymentKind } from './tender'
import type { ReasonAction, ReasonTemplate } from './reasons'
import { parseCheckoutResult, unwrapAction, type CheckoutResult } from './rpcResult'

const CHECKOUT_TIMEOUT_MS = 10_000
const DEFAULT_FOOTER = 'This is an official receipt. Thank you for visiting us.'

function fail(error: { message: string } | null): never {
  throw new Error(error?.message ?? 'Unknown error')
}

function saved(res: { data: unknown[] | null; error: { message: string } | null }, what: string): void {
  const out = writeOutcome(res)
  if (!out.ok) throw new Error(`${what} failed: ${out.reason}`)
}

export interface PosSettings {
  sstRegistered: boolean
  cashRounding: CashRounding
  receiptRoute: string | null
  receiptFooter: string
  qrRequiresOpenBill: boolean
}
export const DEFAULT_POS_SETTINGS: PosSettings = {
  sstRegistered: true, cashRounding: 'nearest_5_sen', receiptRoute: null, receiptFooter: DEFAULT_FOOTER, qrRequiresOpenBill: false,
}

export interface PaymentMethodRow {
  id: string
  branch_id: string
  name: string
  kind: PaymentKind
  needs_reference: boolean
  sort_order: number
  is_active: boolean
}

export interface ServiceChargeRuleRow {
  id: string
  branch_id: string
  rate_bp: number
  order_types: BillOrderType[]
  table_ids: string[] | null
  product_ids: string[] | null
  sort_order: number
  is_active: boolean
}

export interface ReasonTemplateRow {
  branch_id: string
  action: ReasonAction
  reasons: string[]
  compulsory: boolean
  allow_other: boolean
}

export interface ReceiptDetails {
  receiptTitle: string
  legalName: string
  registrationNo: string
  sstNo: string
  address: string
  phone: string
  email: string
  footer: string
  receiptRoute: string | null
  sstRegistered: boolean
  cashRounding: CashRounding
  qrRequiresOpenBill: boolean
}

export interface BillingConfig { settings: PosSettings; rules: ServiceChargeRuleInput[] }
export interface Approver { staffId: string; name: string; hasPin: boolean }
export interface PaymentInput { methodId: string; amountSen: number; tenderedSen: number | null; reference: string | null }
export interface ClosedBillRow {
  id: string
  bill_no: string
  table_id: string | null
  order_type: BillOrderType
  status: 'paid' | 'voided' | 'merged'
  closed_at: string
  total_sen: number | null
  refunded_sen: number
  merged_into: string | null
  dining_tables: { label: string } | null
}
export type { CheckoutResult }

interface SettingsRow { sst_registered: boolean; cash_rounding: CashRounding; receipt_route: string | null; receipt_footer: string; qr_requires_open_bill: boolean }
const toSettings = (r: SettingsRow | null): PosSettings => (r ? {
  sstRegistered: r.sst_registered, cashRounding: r.cash_rounding, receiptRoute: r.receipt_route,
  receiptFooter: r.receipt_footer, qrRequiresOpenBill: r.qr_requires_open_bill,
} : DEFAULT_POS_SETTINGS)

export async function fetchPosSettings(branchId: string): Promise<PosSettings> {
  const { data, error } = await supabase.from('branch_pos_settings')
    .select('sst_registered, cash_rounding, receipt_route, receipt_footer, qr_requires_open_bill')
    .eq('branch_id', branchId).maybeSingle()
  if (error) fail(error)
  return toSettings(data as SettingsRow | null)
}

export async function fetchServiceChargeRules(branchId: string): Promise<ServiceChargeRuleRow[]> {
  const { data, error } = await supabase.from('service_charge_rules')
    .select('id, branch_id, rate_bp, order_types, table_ids, product_ids, sort_order, is_active')
    .eq('branch_id', branchId).order('sort_order').order('created_at').order('id')
  if (error) fail(error)
  return (data ?? []) as ServiceChargeRuleRow[]
}

/** Settings + active rules in sort order: the input computeBill needs besides the lines. */
export async function fetchBillingConfig(branchId: string): Promise<BillingConfig> {
  const [settings, rules] = await Promise.all([fetchPosSettings(branchId), fetchServiceChargeRules(branchId)])
  return {
    settings,
    rules: rules.filter((r) => r.is_active).map((r) => ({ rateBp: r.rate_bp, orderTypes: r.order_types, tableIds: r.table_ids, productIds: r.product_ids })),
  }
}

export async function fetchPaymentMethods(branchId: string, activeOnly: boolean): Promise<PaymentMethodRow[]> {
  let q = supabase.from('payment_methods').select('id, branch_id, name, kind, needs_reference, sort_order, is_active').eq('branch_id', branchId)
  if (activeOnly) q = q.eq('is_active', true)
  const { data, error } = await q.order('sort_order').order('name')
  if (error) fail(error)
  return (data ?? []) as PaymentMethodRow[]
}

export async function fetchReasonTemplates(branchId: string): Promise<ReasonTemplateRow[]> {
  const { data, error } = await supabase.from('reason_templates')
    .select('branch_id, action, reasons, compulsory, allow_other').eq('branch_id', branchId)
  if (error) fail(error)
  return (data ?? []) as ReasonTemplateRow[]
}

/** null = no template saved for the action (the server then requires any reason). */
export async function fetchReasonTemplate(branchId: string, action: ReasonAction): Promise<ReasonTemplate | null> {
  const row = (await fetchReasonTemplates(branchId)).find((t) => t.action === action)
  return row ? { reasons: row.reasons, compulsory: row.compulsory, allowOther: row.allow_other } : null
}

export async function fetchReceiptDetails(branchId: string): Promise<ReceiptDetails> {
  const [b, s] = await Promise.all([
    supabase.from('branches').select('name, receipt_title, legal_name, registration_no, sst_no, address, phone, email').eq('id', branchId).maybeSingle(),
    fetchPosSettings(branchId),
  ])
  if (b.error) fail(b.error)
  const r = (b.data ?? {}) as Record<string, string | null>
  return {
    receiptTitle: r.receipt_title ?? r.name ?? '', legalName: r.legal_name ?? '', registrationNo: r.registration_no ?? '',
    sstNo: r.sst_no ?? '', address: r.address ?? '', phone: r.phone ?? '', email: r.email ?? '',
    footer: s.receiptFooter, receiptRoute: s.receiptRoute, sstRegistered: s.sstRegistered,
    cashRounding: s.cashRounding, qrRequiresOpenBill: s.qrRequiresOpenBill,
  }
}

/** Server preview of the bill's totals (pos_bill_totals) — what checkout will charge. */
export async function fetchBillTotals(billId: string): Promise<BillTotals> {
  const { data, error } = await supabase.rpc('pos_bill_totals', { p_bill_id: billId })
  if (error) fail(error)
  if (!data) throw new Error('Bill not found')
  return data as BillTotals
}

/** A timeout or dropped connection throws — the sheet then offers Pay again with the
 *  SAME checkoutId, which the server answers with the first result (never charges twice). */
export async function checkoutBill(billId: string, payments: PaymentInput[], checkoutId: string): Promise<CheckoutResult> {
  const { data, error } = await supabase
    .rpc('checkout_bill', { p_bill_id: billId, p_payments: payments, p_checkout_id: checkoutId })
    .abortSignal(AbortSignal.timeout(CHECKOUT_TIMEOUT_MS))
  if (error) fail(error)
  return parseCheckoutResult(data)
}

export async function reprintReceipt(billId: string): Promise<void> {
  const { error } = await supabase.rpc('reprint_receipt', { p_bill_id: billId })
  if (error) fail(error)
}

export async function fetchApprovers(): Promise<Approver[]> {
  const { data, error } = await supabase.rpc('pos_approvers')
  if (error) fail(error)
  return ((data ?? []) as { staff_id: string; name: string; has_pin: boolean }[]).map((a) => ({ staffId: a.staff_id, name: a.name, hasPin: a.has_pin }))
}

export async function setMyPin(newPin: string, currentPin: string | null): Promise<void> {
  const { data, error } = await supabase.rpc('set_my_pos_pin', { p_new_pin: newPin, p_current_pin: currentPin })
  if (error) fail(error)
  unwrapAction(data)
}

export async function clearPin(staffId: string): Promise<void> {
  const { error } = await supabase.rpc('clear_pos_pin', { p_staff_id: staffId })
  if (error) fail(error)
}

export interface Approval { reason: string; approverId: string | null; pin: string | null }

export async function voidItem(itemId: string, a: Approval): Promise<void> {
  const { data, error } = await supabase.rpc('void_order_item', { p_item_id: itemId, p_reason: a.reason, p_approver_id: a.approverId, p_pin: a.pin })
  if (error) fail(error)
  unwrapAction(data)
}

export async function voidBill(billId: string, a: Approval): Promise<void> {
  const { data, error } = await supabase.rpc('void_bill', { p_bill_id: billId, p_reason: a.reason, p_approver_id: a.approverId, p_pin: a.pin })
  if (error) fail(error)
  unwrapAction(data)
}

export async function moveBill(billId: string, tableId: string): Promise<void> {
  const { error } = await supabase.rpc('move_bill', { p_bill_id: billId, p_table_id: tableId })
  if (error) fail(error)
}

export async function mergeBills(fromBillId: string, intoBillId: string): Promise<void> {
  const { error } = await supabase.rpc('merge_bills', { p_from_bill: fromBillId, p_into_bill: intoBillId })
  if (error) fail(error)
}

export async function refundBill(refundId: string, billId: string, amountSen: number, methodId: string, a: Approval): Promise<void> {
  const { data, error } = await supabase.rpc('refund_bill', {
    p_refund_id: refundId, p_bill_id: billId, p_amount_sen: amountSen, p_method_id: methodId,
    p_reason: a.reason, p_approver_id: a.approverId, p_pin: a.pin,
  })
  if (error) fail(error)
  unwrapAction(data)
}

export async function openTable(tableId: string, pax: number | null): Promise<string> {
  const { data, error } = await supabase.rpc('open_table', { p_table_id: tableId, p_pax: pax })
  if (error) fail(error)
  return data as string
}

/** Paid, voided and merged bills of the branch closed since `sinceIso` (newest first). */
export async function fetchClosedBillsSince(branchId: string, sinceIso: string): Promise<ClosedBillRow[]> {
  const { data, error } = await supabase.from('bills')
    .select('id, bill_no, table_id, order_type, status, closed_at, total_sen, refunded_sen, merged_into, dining_tables(label)')
    .eq('branch_id', branchId).in('status', ['paid', 'voided', 'merged']).gte('closed_at', sinceIso)
    .order('closed_at', { ascending: false })
  if (error) fail(error)
  return (data ?? []) as unknown as ClosedBillRow[]
}

// ── /pos/settings ───────────────────────────────────────────────────────────
/** Orderable products (no add-ons), for choosing which products a service-charge rule covers. */
export async function fetchProductNames(): Promise<{ id: string; name: string }[]> {
  const { data, error } = await supabase.from('menu_products').select('id, name')
    .eq('is_active', true).eq('is_addon', false).order('name')
  if (error) fail(error)
  return (data ?? []) as { id: string; name: string }[]
}

export async function saveReceiptDetails(d: ReceiptDetails): Promise<void> {
  const { error } = await supabase.rpc('save_receipt_settings', { p: d })
  if (error) fail(error)
}

export async function savePaymentMethod(row: Omit<PaymentMethodRow, 'id'> & { id?: string }): Promise<void> {
  saved(await supabase.from('payment_methods').upsert(row).select('id'), 'Saving the payment method')
}

export async function saveServiceChargeRule(row: Omit<ServiceChargeRuleRow, 'id'> & { id?: string }): Promise<void> {
  saved(await supabase.from('service_charge_rules').upsert(row).select('id'), 'Saving the service-charge rule')
}

export async function deleteServiceChargeRule(id: string): Promise<void> {
  saved(await supabase.from('service_charge_rules').delete().eq('id', id).select('id'), 'Removing the rule')
}

export async function saveReasonTemplate(row: ReasonTemplateRow): Promise<void> {
  saved(await supabase.from('reason_templates').upsert(row).select('action'), 'Saving the reasons')
}
```

- [ ] **Step 6: Bill item fields and bills on Realtime.** In `src/features/pos/order/posApi.ts`:

1. Replace:

```ts
export interface BillItemRow {
  id: string
  order_id: string
  name_snapshot: string
  unit_price_sen: number
  qty: number
```

   with:

```ts
export interface BillItemRow {
  id: string
  order_id: string
  product_id: string | null
  name_snapshot: string
  unit_price_sen: number
  sst_rate_bp: number
  takeaway_fee_sen: number
  qty: number
```

2. Replace:

```ts
    .select('id, order_id, name_snapshot, unit_price_sen, qty, note, modifiers_snapshot, voided_at, orders!inner(order_no, source, placed_at)')
```

   with:

```ts
    .select('id, order_id, product_id, name_snapshot, unit_price_sen, sst_rate_bp, takeaway_fee_sen, qty, note, modifiers_snapshot, voided_at, ' +
            'orders!inner(order_no, source, placed_at)')
```

In `src/features/pos/order/usePosRealtime.ts`:

1. Replace:

```ts
interface Handlers {
  onOrder?: (row: OrderInsert) => void
```

   with:

```ts
export interface BillChange { id: string; branch_id: string; status: string; table_id: string | null }

interface Handlers {
  onOrder?: (row: OrderInsert) => void
  /** A bill was opened, paid, voided, moved or merged (INSERT or UPDATE on bills). */
  onBill?: (row: BillChange) => void
```

2. Replace:

```ts
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'print_jobs', filter }, (p) => h.current.onPrintJob?.(p.new as PrintJobRow))
```

   with:

```ts
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'print_jobs', filter }, (p) => h.current.onPrintJob?.(p.new as PrintJobRow))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bills', filter }, (p) => {
        if (p.new && 'id' in p.new) h.current.onBill?.(p.new as BillChange)
      })
```

- [ ] **Step 7: Gates.** Run: `npx tsc -b` — Expected: no output. Run: `npx vitest run src/features/pos` — Expected: PASS (162 tests in 22 files).

- [ ] **Step 8: Commit**

```bash
git add src/features/pos/checkout src/features/pos/order/posApi.ts src/features/pos/order/usePosRealtime.ts
git commit -m "feat(pos-checkout): checkout, approval and settings API layer; split-tender and reason rules; bills on Realtime

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Checkout sheet, bill-panel totals, refresh on bill changes

**Files:**
- Create: `src/features/pos/checkout/CheckoutSheet.tsx`
- Modify: `src/features/pos/order/BillPanel.tsx` (whole file below), `src/features/pos/order/PosPage.tsx`

**Interfaces:**
- Consumes: Task 8 (`fetchBillTotals`, `fetchPaymentMethods`, `checkoutBill`, `fetchBillingConfig`, tender helpers, `onBill`), Task 6 (`computeBill`, `formatRate`), `formatSen` (`cart.ts`), `OpenBillRow` (`posApi.ts`).
- Produces: `CheckoutSheet({ branchId, bill, title, onClose, onPaid })`; `BillPanel` props gain `billing: BillingConfig | null` and `onCheckout: () => void`. Task 10 replaces `BillPanel.tsx` again.

- [ ] **Step 1: Write `CheckoutSheet.tsx`** — server totals (the amount charged), method buttons, amount defaulting to what is left, cash "Cash received" with Exact and notes, reference when the method needs one, split tender list, **Pay**; a lost reply keeps the same `checkoutId`, so pressing Pay again cannot charge twice; success shows the change large and "Receipt printing…".

```tsx
import { useEffect, useRef, useState } from 'react'
import { formatSen } from '../order/cart'
import type { OpenBillRow } from '../order/posApi'
import { formatRate, type BillTotals } from './bill'
import { checkoutBill, fetchBillTotals, fetchPaymentMethods, type CheckoutResult } from './checkoutApi'
import {
  changeSen, lineProblem, parseRinggit, payProblem, quickTenders, remainingSen, toPayments,
  type TenderLine, type TenderMethod,
} from './tender'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const looksOffline = (m: string) => /fetch|network|timeout|abort|signal/i.test(m)

export default function CheckoutSheet({ branchId, bill, title, onClose, onPaid }: {
  branchId: string
  bill: OpenBillRow
  title: string                 // "Table T3" or "Takeaway 261024-004"
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
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<CheckoutResult | null>(null)
  // one id for this checkout: pressing Pay again after a lost reply can never charge twice
  const checkoutId = useRef(crypto.randomUUID())
  const keySeq = useRef(0)

  const loadTotals = async () => {
    try { setTotals(await fetchBillTotals(bill.id)) } catch (e) { setError(msg(e)) }
  }
  useEffect(() => {
    void loadTotals()
    fetchPaymentMethods(branchId, true)
      .then((rows) => setMethods(rows.map((m) => ({ id: m.id, name: m.name, kind: m.kind, needsReference: m.needs_reference }))))
      .catch((e) => setError(msg(e)))
  }, [bill.id, branchId]) // eslint-disable-line react-hooks/exhaustive-deps

  const total = totals?.totalSen ?? 0
  const left = remainingSen(total, lines)

  const pick = (m: TenderMethod) => {
    setMethod(m); setError(null); setTenderedText(''); setReference('')
    setAmountText((Math.max(0, left) / 100).toFixed(2))
  }

  const add = (tenderedOverride?: number | null) => {
    if (!method) return
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

  const pay = async () => {
    if (!totals) return
    const problem = payProblem(total, lines)
    if (problem) { setError(problem); return }
    setBusy(true); setError(null)
    try {
      setResult(await checkoutBill(bill.id, toPayments(lines), checkoutId.current))
    } catch (e) {
      const m = msg(e)
      if (looksOffline(m)) setError('Not sure the payment went through (no reply). Press Pay again — it will not be charged twice.')
      else { setError(m); await loadTotals() }    // e.g. a QR order arrived meanwhile and the total changed
    } finally { setBusy(false) }
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
          <button onClick={onClose} disabled={busy} className="rounded-lg border border-border px-3 py-2">← Back</button>
          <div className="text-lg font-semibold">Checkout · {title} · Bill {bill.bill_no}</div>
        </div>
        <div className="text-xs font-semibold uppercase text-brown-muted">Payment method</div>
        <div className="mt-1 grid grid-cols-3 gap-2">
          {methods.map((m) => (
            <button key={m.id} onClick={() => pick(m)} disabled={left <= 0 || busy}
              className={`min-h-16 rounded-xl border p-3 text-left disabled:opacity-40 ${method?.id === m.id ? 'border-brown-btn bg-brown-btn text-white' : 'border-border bg-card'}`}>
              <div className="font-medium">{m.name}</div>
              <div className="text-xs opacity-75">{m.kind}</div>
            </button>
          ))}
          {methods.length === 0 && <p className="text-sm text-brown-muted">No payment methods — add them in POS settings.</p>}
        </div>
        {method && (
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
        {error && <p className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      </div>

      <div className="flex flex-col border-l border-border bg-card p-4 text-sm">
        {!totals ? <p className="text-brown-muted">Loading totals…</p> : (
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
            <div className="flex justify-between border-t border-border pt-2 text-lg font-semibold"><span>Total</span><span>{formatSen(total)}</span></div>
          </div>
        )}
        <div className="mt-4 flex-1 space-y-1 overflow-y-auto">
          {lines.map((l) => (
            <div key={l.key} className="flex items-center justify-between rounded bg-cream p-2">
              <span>{l.method.name}{l.reference ? ` · ${l.reference}` : ''}{l.tenderedSen !== null ? ` · received ${formatSen(l.tenderedSen)}` : ''}</span>
              <span className="flex items-center gap-2">{formatSen(l.amountSen)}
                <button disabled={busy} className="text-xs text-red-700 underline" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>remove</button>
              </span>
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-between"><span>Left to pay</span><b>{formatSen(Math.max(0, left))}</b></div>
        <div className="flex justify-between"><span>Change</span><b>{formatSen(changeSen(lines))}</b></div>
        <button disabled={busy || !totals || left !== 0} onClick={() => void pay()}
          className="mt-3 w-full rounded-xl bg-brown-btn py-4 text-lg text-white hover:bg-brown-btn-hover disabled:opacity-40">
          {busy ? 'Paying…' : `Pay ${formatSen(total)}`}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Replace `src/features/pos/order/BillPanel.tsx`** with this file (instant totals from `computeBill`, **Checkout** next to **Add items**):

```tsx
import { useEffect, useState } from 'react'
import { fetchBillItems, setTablePaused, type BillItemRow, type OpenBillRow, type TableRow } from './posApi'
import { formatSen } from './cart'
import { computeBill, formatRate } from '../checkout/bill'
import type { BillingConfig } from '../checkout/checkoutApi'

export default function BillPanel({ table, bill, refreshKey, billing, onAddItems, onCheckout, onChanged }: {
  table: TableRow | null          // null = takeaway bill
  bill: OpenBillRow | null        // null = empty table
  refreshKey: number              // bump to refetch (a new order arrived)
  billing: BillingConfig | null   // settings + service-charge rules, for the instant totals
  onAddItems: () => void
  onCheckout: () => void
  onChanged?: () => void          // called after a successful pause toggle
}) {
  const [items, setItems] = useState<BillItemRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [paused, setPaused] = useState(table?.qr_paused ?? false)
  useEffect(() => { setPaused(table?.qr_paused ?? false) }, [table?.id, table?.qr_paused])
  useEffect(() => {
    if (!bill) { setItems([]); return }
    let alive = true
    fetchBillItems(bill.id).then((rows) => { if (alive) { setItems(rows); setError(null) } }, (e) => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [bill?.id, refreshKey])
  useEffect(() => { setItems([]); setError(null) }, [bill?.id])

  const live = items.filter((i) => !i.voided_at)
  // Instant preview with the same rules as the server (pos_bill_totals); checkout shows the server's numbers.
  const totals = bill && billing ? computeBill({
    orderType: bill.order_type, tableId: bill.table_id,
    sstRegistered: billing.settings.sstRegistered, cashRounding: billing.settings.cashRounding, rules: billing.rules,
    lines: items.map((i) => ({ productId: i.product_id, unitPriceSen: i.unit_price_sen, qty: i.qty, sstRateBp: i.sst_rate_bp,
                               takeawayFeeSen: i.takeaway_fee_sen, voided: i.voided_at !== null })),
  }) : null
  const orders = [...new Map(items.map((i) => [i.order_id, i.orders])).entries()]

  const togglePause = async () => {
    if (!table) return
    const next = !paused
    setPaused(next)
    try { await setTablePaused(table.id, next); onChanged?.() } catch (e) { setPaused(!next); setError(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <div className="flex h-full flex-col rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border p-3">
        <div>
          <div className="text-lg font-semibold">{table ? `Table ${table.label}` : 'Takeaway'}</div>
          <div className="text-xs text-brown-muted">
            {bill ? `Bill ${bill.bill_no}${bill.pax ? ` · ${bill.pax} pax` : ''}` : 'No open bill'}
          </div>
        </div>
        {table && (
          <button onClick={() => void togglePause()} className="rounded border border-border px-3 py-1 text-xs">
            {paused ? 'Resume QR' : 'Pause QR'}
          </button>
        )}
      </div>
      {error && <p className="m-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <div className="flex-1 overflow-y-auto p-3 text-sm">
        {orders.map(([orderId, o]) => (
          <div key={orderId} className="mb-3">
            <div className="text-xs text-brown-muted">{o.order_no} · {o.source.toUpperCase()} · {new Date(o.placed_at).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' })}</div>
            {items.filter((i) => i.order_id === orderId).map((i) => (
              <div key={i.id} className={`flex justify-between py-1 ${i.voided_at ? 'line-through opacity-50' : ''}`}>
                <div>
                  {i.qty} × {i.name_snapshot}
                  {i.modifiers_snapshot.map((m, k) => <div key={k} className="pl-4 text-xs text-brown-muted">+ {m.name}</div>)}
                  {i.note && <div className="pl-4 text-xs italic text-brown-muted">* {i.note}</div>}
                </div>
                <div>{formatSen(i.unit_price_sen * i.qty)}</div>
              </div>
            ))}
          </div>
        ))}
        {bill && items.length === 0 && !error && <p className="text-brown-muted">Loading…</p>}
      </div>
      <div className="border-t border-border p-3 text-sm">
        {totals ? (
          <div className="space-y-0.5">
            <div className="flex justify-between"><span>Subtotal</span><span>{formatSen(totals.subtotalSen)}</span></div>
            {totals.serviceChargeGroups.map((g) => (
              <div key={`sc${g.rateBp}`} className="flex justify-between text-brown-muted"><span>Service charge ({formatRate(g.rateBp)})</span><span>{formatSen(g.amountSen)}</span></div>
            ))}
            {totals.sstGroups.map((g) => (
              <div key={`sst${g.rateBp}`} className="flex justify-between text-brown-muted"><span>SST ({formatRate(g.rateBp)})</span><span>{formatSen(g.amountSen)}</span></div>
            ))}
            {totals.takeawayFeeSen > 0 && <div className="flex justify-between text-brown-muted"><span>Takeaway packaging</span><span>{formatSen(totals.takeawayFeeSen)}</span></div>}
            {totals.roundingSen !== 0 && <div className="flex justify-between text-brown-muted"><span>Rounding</span><span>{formatSen(totals.roundingSen)}</span></div>}
            <div className="flex justify-between text-base font-semibold"><span>Total</span><span>{formatSen(totals.totalSen)}</span></div>
          </div>
        ) : (
          <div className="flex justify-between"><span>Subtotal</span><b>{formatSen(live.reduce((n, i) => n + i.unit_price_sen * i.qty, 0))}</b></div>
        )}
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button onClick={onAddItems} className="rounded-xl border border-brown-btn py-3 text-brown-dark">
            {!table ? 'New takeaway order' : bill ? 'Add items' : 'New order'}
          </button>
          <button onClick={onCheckout} disabled={!bill || live.length === 0}
            className="rounded-xl bg-brown-btn py-3 text-white hover:bg-brown-btn-hover disabled:opacity-40">
            Checkout
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Wire it into `PosPage.tsx`.** Make exactly these replacements:

1. Replace:

```tsx
import { useOrderQueue } from './useOrderQueue'
```

   with:

```tsx
import { useOrderQueue } from './useOrderQueue'
import CheckoutSheet from '../checkout/CheckoutSheet'
import { fetchBillingConfig, type BillingConfig } from '../checkout/checkoutApi'
```

2. Replace:

```tsx
  const [stuckMenu, setStuckMenu] = useState<PosMenu | null>(null)
```

   with:

```tsx
  const [stuckMenu, setStuckMenu] = useState<PosMenu | null>(null)
  const [billing, setBilling] = useState<BillingConfig | null>(null)
  const [checkout, setCheckout] = useState<OpenBillRow | null>(null)
```

3. Replace:

```tsx
  useEffect(() => {
    if (branchId) fetchBranchName(branchId).then(setBranchName, () => setBranchName(null))
  }, [branchId])
```

   with:

```tsx
  useEffect(() => {
    if (branchId) fetchBranchName(branchId).then(setBranchName, () => setBranchName(null))
  }, [branchId])
  const loadBilling = useCallback(() => {
    if (branchId) fetchBillingConfig(branchId).then(setBilling, (e) => setError(e instanceof Error ? e.message : String(e)))
  }, [branchId])
  useEffect(() => { loadBilling() }, [loadBilling])
```

4. Replace:

```tsx
  const rtStatus = usePosRealtime(branchId, { onOrder, onSweep: () => { setRefreshKey((k) => k + 1); void reload() } })
```

   with:

```tsx
  const rtStatus = usePosRealtime(branchId, {
    onOrder,
    // another iPad paid, voided, moved or merged a bill: refresh the grid and the open panel
    onBill: () => { setRefreshKey((k) => k + 1); void reload() },
    onSweep: () => { setRefreshKey((k) => k + 1); void reload() },
  })
```

5. Replace:

```tsx
          <BillPanel table={selectedTable} bill={selectedBill} refreshKey={refreshKey} onChanged={() => void reload()}
            onAddItems={() => {
```

   with:

```tsx
          <BillPanel table={selectedTable} bill={selectedBill} refreshKey={refreshKey} billing={billing} onChanged={() => void reload()}
            onCheckout={() => { if (selectedBill) { loadBilling(); setCheckout(selectedBill) } }}
            onAddItems={() => {
```

6. Replace:

```tsx
          onSent={() => { closePad(); setRefreshKey((k) => k + 1); void reload() }} />
      )}
```

   with:

```tsx
          onSent={() => { closePad(); setRefreshKey((k) => k + 1); void reload() }} />
      )}
      {checkout && (
        <CheckoutSheet branchId={branchId} bill={checkout}
          title={checkout.table_id ? `Table ${tables.find((t) => t.id === checkout.table_id)?.label ?? '?'}` : 'Takeaway'}
          onClose={() => setCheckout(null)}
          onPaid={() => { setCheckout(null); setSelection(null); setRefreshKey((k) => k + 1); void reload() }} />
      )}
```

- [ ] **Step 4: Gates.** Run: `npx tsc -b` — Expected: no output. Run: `npx vitest run src/features/pos` — Expected: PASS.

- [ ] **Step 5 (controller, craft-os-dev — browser and SQL; the implementer does not touch the database):** Browser (dev server `pos-menu-dev`, `http://localhost:5174/pos`, test login, after Task 5): `T1` → **New order** → any 4 items → Send. The panel shows Subtotal, `Service charge (10%)`, `SST (6%)` and Total. **Checkout** → the sheet's Total equals the panel's → **Touch 'n Go** → amount `50.00` → **Add Touch 'n Go** → **Cash** → `RM 50` quick button (or Exact) → Left to pay `RM 0.00`, Change shown → **Pay** → the change screen with "Receipt printing…" → **Done** → `T1` is Empty. In a second browser tab on `/pos`, `T1` turns Empty within 2 s (Realtime on `bills`). In the dev DB: `select status, total_sen, checkout_id is not null from bills where bill_no = '<bill no>'` → `paid | <total> | t`; `select method_name, amount_sen, tendered_sen, change_sen from payments where bill_id = …` → two rows; `select route, status, payload->>'kind' from print_jobs where kind = 'receipt' order by created_at desc limit 1` → `Bar | pending | receipt` (it prints in Task 13).

- [ ] **Step 6: Commit**

```bash
git add src/features/pos/checkout/CheckoutSheet.tsx src/features/pos/order/BillPanel.tsx src/features/pos/order/PosPage.tsx
git commit -m "feat(pos-checkout): checkout sheet with split tender and change; bill panel totals; refresh on bill changes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Bill actions — void item / void bill with approval, move table, merge, open table

**Files:**
- Create: `src/features/pos/checkout/ApprovalDialog.tsx`, `src/features/pos/checkout/BillPickers.tsx`
- Modify: `src/features/pos/order/BillPanel.tsx` (whole file below), `src/features/pos/order/PosPage.tsx`

**Interfaces:**
- Consumes: Task 8 (`fetchApprovers`, `fetchReasonTemplate`, `voidItem`, `voidBill`, `moveBill`, `mergeBills`, `openTable`, `Approval`, `reasonProblem`, `DEFAULT_TEMPLATE`), Task 9's `BillPanel`.
- Produces:
  - `ApprovalDialog({ branchId, action, title, summary, extra?, extraProblem?, onApprove(a: Approval): Promise<void>, onClose, onDone })` — reused by Task 11 for refunds
  - `PickerSheet({ title, hint, options: PickOption[], empty, onPick(id), onClose })`, `interface PickOption { id: string; label: string; detail?: string }`
  - `BillPanel` props now: `branchId, table, bill, refreshKey, billing, moveTargets: PickOption[], mergeSources: PickOption[], onAddItems, onCheckout, onChanged?, onMoved?(tableId)`

- [ ] **Step 1: Write `ApprovalDialog.tsx`** — reason buttons from the template (+ "Other" text when allowed), approver buttons (`(no PIN)` ones disabled), PIN pad; the PIN goes only to the protected RPC, and a wrong PIN shows the server's words ("Wrong PIN — 4 tries left") and clears the pad.

```tsx
import { useEffect, useState, type ReactNode } from 'react'
import { fetchApprovers, fetchReasonTemplate, type Approval, type Approver } from './checkoutApi'
import { DEFAULT_TEMPLATE, reasonProblem, type ReasonAction, type ReasonTemplate } from './reasons'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Clear', '0', '⌫']

/** Reason + approver + PIN, for voids and refunds. The PIN is checked by the
 *  protected RPC itself (onApprove), never by a separate call. */
export default function ApprovalDialog({ branchId, action, title, summary, extra, extraProblem, onApprove, onClose, onDone }: {
  branchId: string
  action: ReasonAction
  title: string                         // "Void item"
  summary: string                       // "2 × Coffee Latte (COLD) · RM 26.00"
  extra?: ReactNode                     // refund: amount + method fields
  extraProblem?: string | null          // why the extra fields are not ready
  onApprove: (a: Approval) => Promise<void>
  onClose: () => void
  onDone: () => void
}) {
  const [template, setTemplate] = useState<ReasonTemplate>(DEFAULT_TEMPLATE)
  const [approvers, setApprovers] = useState<Approver[] | null>(null)
  const [choice, setChoice] = useState('')          // a listed reason, or '' when typing Other
  const [other, setOther] = useState('')
  const [approverId, setApproverId] = useState<string | null>(null)
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetchReasonTemplate(branchId, action).then((t) => setTemplate(t ?? DEFAULT_TEMPLATE), (e) => setError(msg(e)))
    fetchApprovers().then((a) => {
      setApprovers(a)
      if (a.length === 1 && a[0].hasPin) setApproverId(a[0].staffId)
    }, (e) => setError(msg(e)))
  }, [branchId, action])

  const reason = choice || other
  const press = (k: string) => {
    setError(null)
    if (k === 'Clear') setPin('')
    else if (k === '⌫') setPin((p) => p.slice(0, -1))
    else setPin((p) => (p.length < 6 ? p + k : p))
  }

  const approve = async () => {
    const problem = extraProblem ?? reasonProblem(template, reason)
      ?? (!approverId ? 'Choose who approves' : null)
      ?? (pin.length < 4 ? 'Enter the approver\'s PIN (4 to 6 digits)' : null)
    if (problem) { setError(problem); return }
    setBusy(true); setError(null)
    try {
      await onApprove({ reason: reason.trim(), approverId, pin })
      onDone()
    } catch (e) {
      setError(msg(e)); setPin('')
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40" onClick={busy ? undefined : onClose}>
      <div className="grid max-h-[92vh] w-full max-w-3xl grid-cols-2 gap-4 overflow-y-auto rounded-2xl bg-card p-5" onClick={(e) => e.stopPropagation()}>
        <div className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">{title}</h2>
            <p className="text-sm text-brown-muted">{summary}</p>
          </div>
          {extra}
          <div>
            <div className="text-xs font-semibold uppercase text-brown-muted">Reason{template.compulsory ? '' : ' (optional)'}</div>
            <div className="mt-1 flex flex-wrap gap-2">
              {template.reasons.map((r) => (
                <button key={r} onClick={() => { setChoice(r); setOther(''); setError(null) }}
                  className={`rounded-lg border px-3 py-2 text-sm ${choice === r ? 'border-brown-btn bg-brown-btn text-white' : 'border-border'}`}>{r}</button>
              ))}
            </div>
            {template.allowOther && (
              <input className="mt-2 w-full rounded border border-border p-2 text-sm" placeholder={template.reasons.length ? 'Other reason' : 'Reason'}
                value={other} onChange={(e) => { setOther(e.target.value); setChoice(''); setError(null) }} />
            )}
          </div>
          <div>
            <div className="text-xs font-semibold uppercase text-brown-muted">Approved by</div>
            {approvers === null && <p className="text-sm text-brown-muted">Loading…</p>}
            {approvers?.length === 0 && <p className="text-sm text-red-700">Nobody at this branch can approve. A manager grants "Approve POS voids &amp; refunds" in Settings → System Roles.</p>}
            <div className="mt-1 flex flex-wrap gap-2">
              {approvers?.map((a) => (
                <button key={a.staffId} disabled={!a.hasPin} onClick={() => { setApproverId(a.staffId); setPin(''); setError(null) }}
                  className={`rounded-lg border px-3 py-2 text-sm disabled:opacity-40 ${approverId === a.staffId ? 'border-brown-btn bg-brown-btn text-white' : 'border-border'}`}>
                  {a.name}{a.hasPin ? '' : ' (no PIN)'}
                </button>
              ))}
            </div>
          </div>
          {error && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
        </div>
        <div className="flex flex-col items-center gap-3">
          <div className="h-10 text-3xl tracking-[0.5em]">{'•'.repeat(pin.length) || <span className="text-base tracking-normal text-brown-muted">PIN</span>}</div>
          <div className="grid grid-cols-3 gap-2">
            {KEYS.map((k) => (
              <button key={k} onClick={() => press(k)} disabled={busy} className="h-16 w-20 rounded-xl border border-border text-xl">{k}</button>
            ))}
          </div>
          <div className="flex w-full gap-2">
            <button onClick={onClose} disabled={busy} className="flex-1 rounded-xl border border-border py-3">Cancel</button>
            <button onClick={() => void approve()} disabled={busy} className="flex-1 rounded-xl bg-red-700 py-3 text-white disabled:opacity-40">
              {busy ? 'Checking…' : 'Approve'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Write `BillPickers.tsx`**

```tsx
/** Small pickers for "Move table" and "Merge another bill into this one". */
export interface PickOption { id: string; label: string; detail?: string }

export default function PickerSheet({ title, hint, options, empty, onPick, onClose }: {
  title: string
  hint: string
  options: PickOption[]
  empty: string
  onPick: (id: string) => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-card p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-brown-muted">{hint}</p>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {options.map((o) => (
            <button key={o.id} onClick={() => onPick(o.id)} className="rounded-xl border border-border p-3 text-left">
              <div className="font-semibold">{o.label}</div>
              {o.detail && <div className="text-xs text-brown-muted">{o.detail}</div>}
            </button>
          ))}
        </div>
        {options.length === 0 && <p className="mt-3 text-sm text-brown-muted">{empty}</p>}
        <button onClick={onClose} className="mt-4 w-full rounded-xl border border-border py-2">Cancel</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Replace `src/features/pos/order/BillPanel.tsx`** with this file (per-item **Void**; header **Move table** · **Merge with…** · **Void bill** / **Close empty bill**; **Open table for QR ordering** when the branch switch is on):

```tsx
import { useEffect, useState } from 'react'
import { fetchBillItems, setTablePaused, type BillItemRow, type OpenBillRow, type TableRow } from './posApi'
import { formatSen } from './cart'
import { computeBill, formatRate } from '../checkout/bill'
import { mergeBills, moveBill, openTable, voidBill, voidItem, type BillingConfig } from '../checkout/checkoutApi'
import ApprovalDialog from '../checkout/ApprovalDialog'
import PickerSheet, { type PickOption } from '../checkout/BillPickers'

type Dialog = { kind: 'void_item'; item: BillItemRow } | { kind: 'void_bill' } | { kind: 'move' } | { kind: 'merge' } | null
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export default function BillPanel({ branchId, table, bill, refreshKey, billing, moveTargets, mergeSources, onAddItems, onCheckout, onChanged, onMoved }: {
  branchId: string
  table: TableRow | null          // null = takeaway bill
  bill: OpenBillRow | null        // null = empty table
  refreshKey: number              // bump to refetch (a new order arrived)
  billing: BillingConfig | null   // settings + service-charge rules, for the instant totals
  moveTargets: PickOption[]       // empty tables this bill can move to
  mergeSources: PickOption[]      // other open bills that can be merged into this one
  onAddItems: () => void
  onCheckout: () => void
  onChanged?: () => void          // after a pause toggle, void, merge or open table
  onMoved?: (tableId: string) => void
}) {
  const [items, setItems] = useState<BillItemRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [paused, setPaused] = useState(table?.qr_paused ?? false)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [localKey, setLocalKey] = useState(0)
  useEffect(() => { setPaused(table?.qr_paused ?? false) }, [table?.id, table?.qr_paused])
  useEffect(() => {
    if (!bill) { setItems([]); return }
    let alive = true
    fetchBillItems(bill.id).then((rows) => { if (alive) { setItems(rows); setError(null) } }, (e) => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [bill?.id, refreshKey, localKey])
  useEffect(() => { setItems([]); setError(null); setDialog(null) }, [bill?.id])

  const live = items.filter((i) => !i.voided_at)
  // Instant preview with the same rules as the server (pos_bill_totals); checkout shows the server's numbers.
  const totals = bill && billing ? computeBill({
    orderType: bill.order_type, tableId: bill.table_id,
    sstRegistered: billing.settings.sstRegistered, cashRounding: billing.settings.cashRounding, rules: billing.rules,
    lines: items.map((i) => ({ productId: i.product_id, unitPriceSen: i.unit_price_sen, qty: i.qty, sstRateBp: i.sst_rate_bp,
                               takeawayFeeSen: i.takeaway_fee_sen, voided: i.voided_at !== null })),
  }) : null
  const orders = [...new Map(items.map((i) => [i.order_id, i.orders])).entries()]
  const changed = () => { setDialog(null); setLocalKey((k) => k + 1); onChanged?.() }

  const run = async (fn: () => Promise<void>) => {
    try { await fn(); changed() } catch (e) { setDialog(null); setError(msg(e)) }
  }

  const togglePause = async () => {
    if (!table) return
    const next = !paused
    setPaused(next)
    try { await setTablePaused(table.id, next); onChanged?.() } catch (e) { setPaused(!next); setError(msg(e)) }
  }

  const voidWholeBill = () => {
    if (!bill) return
    if (live.length > 0) { setDialog({ kind: 'void_bill' }); return }
    if (!window.confirm(`Close bill ${bill.bill_no}? It has nothing on it.`)) return
    void run(() => voidBill(bill.id, { reason: '', approverId: null, pin: null }))
  }

  const open = () => {
    if (!table) return
    const answer = window.prompt(`Guests at table ${table.label}?`, '2')
    if (answer === null) return
    const pax = Number(answer)
    if (!Number.isInteger(pax) || pax < 1 || pax > 99) { setError('Enter the number of guests (1–99)'); return }
    void run(async () => { await openTable(table.id, pax) })
  }

  return (
    <div className="flex h-full flex-col rounded-xl border border-border bg-card">
      <div className="border-b border-border p-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-lg font-semibold">{table ? `Table ${table.label}` : 'Takeaway'}</div>
            <div className="text-xs text-brown-muted">
              {bill ? `Bill ${bill.bill_no}${bill.pax ? ` · ${bill.pax} pax` : ''}` : 'No open bill'}
            </div>
          </div>
          {table && (
            <button onClick={() => void togglePause()} className="rounded border border-border px-3 py-1 text-xs">
              {paused ? 'Resume QR' : 'Pause QR'}
            </button>
          )}
        </div>
        {bill && (
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {bill.order_type === 'dine_in' && <button onClick={() => setDialog({ kind: 'move' })} className="rounded border border-border px-2 py-1">Move table</button>}
            <button onClick={() => setDialog({ kind: 'merge' })} className="rounded border border-border px-2 py-1">Merge with…</button>
            <button onClick={voidWholeBill} className="rounded border border-red-300 px-2 py-1 text-red-700">{live.length > 0 ? 'Void bill' : 'Close empty bill'}</button>
          </div>
        )}
        {!bill && table && billing?.settings.qrRequiresOpenBill && (
          <button onClick={open} className="mt-2 rounded border border-brown-btn px-2 py-1 text-xs">Open table for QR ordering</button>
        )}
      </div>
      {error && <p className="m-3 rounded bg-red-50 p-2 text-sm text-red-700">{error} <button className="underline" onClick={() => setError(null)}>OK</button></p>}
      <div className="flex-1 overflow-y-auto p-3 text-sm">
        {orders.map(([orderId, o]) => (
          <div key={orderId} className="mb-3">
            <div className="text-xs text-brown-muted">{o.order_no} · {o.source.toUpperCase()} · {new Date(o.placed_at).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' })}</div>
            {items.filter((i) => i.order_id === orderId).map((i) => (
              <div key={i.id} className={`flex justify-between py-1 ${i.voided_at ? 'line-through opacity-50' : ''}`}>
                <div>
                  {i.qty} × {i.name_snapshot}
                  {i.modifiers_snapshot.map((m, k) => <div key={k} className="pl-4 text-xs text-brown-muted">+ {m.name}</div>)}
                  {i.note && <div className="pl-4 text-xs italic text-brown-muted">* {i.note}</div>}
                </div>
                <div className="text-right">
                  <div>{formatSen(i.unit_price_sen * i.qty)}</div>
                  {!i.voided_at && <button onClick={() => setDialog({ kind: 'void_item', item: i })} className="text-xs text-red-700 underline">Void</button>}
                </div>
              </div>
            ))}
          </div>
        ))}
        {bill && items.length === 0 && !error && <p className="text-brown-muted">Loading…</p>}
      </div>
      <div className="border-t border-border p-3 text-sm">
        {totals ? (
          <div className="space-y-0.5">
            <div className="flex justify-between"><span>Subtotal</span><span>{formatSen(totals.subtotalSen)}</span></div>
            {totals.serviceChargeGroups.map((g) => (
              <div key={`sc${g.rateBp}`} className="flex justify-between text-brown-muted"><span>Service charge ({formatRate(g.rateBp)})</span><span>{formatSen(g.amountSen)}</span></div>
            ))}
            {totals.sstGroups.map((g) => (
              <div key={`sst${g.rateBp}`} className="flex justify-between text-brown-muted"><span>SST ({formatRate(g.rateBp)})</span><span>{formatSen(g.amountSen)}</span></div>
            ))}
            {totals.takeawayFeeSen > 0 && <div className="flex justify-between text-brown-muted"><span>Takeaway packaging</span><span>{formatSen(totals.takeawayFeeSen)}</span></div>}
            {totals.roundingSen !== 0 && <div className="flex justify-between text-brown-muted"><span>Rounding</span><span>{formatSen(totals.roundingSen)}</span></div>}
            <div className="flex justify-between text-base font-semibold"><span>Total</span><span>{formatSen(totals.totalSen)}</span></div>
          </div>
        ) : (
          <div className="flex justify-between"><span>Subtotal</span><b>{formatSen(live.reduce((n, i) => n + i.unit_price_sen * i.qty, 0))}</b></div>
        )}
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button onClick={onAddItems} className="rounded-xl border border-brown-btn py-3 text-brown-dark">
            {!table ? 'New takeaway order' : bill ? 'Add items' : 'New order'}
          </button>
          <button onClick={onCheckout} disabled={!bill || live.length === 0}
            className="rounded-xl bg-brown-btn py-3 text-white hover:bg-brown-btn-hover disabled:opacity-40">
            Checkout
          </button>
        </div>
      </div>

      {bill && dialog?.kind === 'void_item' && (
        <ApprovalDialog branchId={branchId} action="void_item" title="Void item"
          summary={`${dialog.item.qty} × ${dialog.item.name_snapshot} · ${formatSen(dialog.item.unit_price_sen * dialog.item.qty)} — the kitchen gets a VOID ticket`}
          onApprove={(a) => voidItem(dialog.item.id, a)} onClose={() => setDialog(null)} onDone={changed} />
      )}
      {bill && dialog?.kind === 'void_bill' && (
        <ApprovalDialog branchId={branchId} action="void_bill" title="Void bill"
          summary={`Bill ${bill.bill_no} · ${live.length} item${live.length === 1 ? '' : 's'} · ${formatSen(totals?.totalSen ?? 0)} — every item is voided and the table is freed`}
          onApprove={(a) => voidBill(bill.id, a)} onClose={() => setDialog(null)} onDone={changed} />
      )}
      {bill && dialog?.kind === 'move' && (
        <PickerSheet title={`Move bill ${bill.bill_no}`} hint="Pick an empty table. Nothing is reprinted." options={moveTargets}
          empty="No empty table." onClose={() => setDialog(null)}
          onPick={(tableId) => void run(async () => { await moveBill(bill.id, tableId); onMoved?.(tableId) })} />
      )}
      {bill && dialog?.kind === 'merge' && (
        <PickerSheet title={`Merge into bill ${bill.bill_no}`} hint="Every order of the bill you pick moves onto this bill, and its table becomes empty."
          options={mergeSources} empty="No other open bill." onClose={() => setDialog(null)}
          onPick={(fromBillId) => {
            const from = mergeSources.find((o) => o.id === fromBillId)
            if (!window.confirm(`Move everything from ${from?.label ?? 'that bill'} onto bill ${bill.bill_no}?`)) return
            void run(() => mergeBills(fromBillId, bill.id))
          }} />
      )}
    </div>
  )
}
```

- [ ] **Step 4: Pass the pickers' options from `PosPage.tsx`.** Make exactly this replacement:

1. Replace:

```tsx
          <BillPanel table={selectedTable} bill={selectedBill} refreshKey={refreshKey} billing={billing} onChanged={() => void reload()}
            onCheckout={() => { if (selectedBill) { loadBilling(); setCheckout(selectedBill) } }}
```

   with:

```tsx
          <BillPanel branchId={branchId} table={selectedTable} bill={selectedBill} refreshKey={refreshKey} billing={billing}
            moveTargets={cards.filter((c) => c.state === 'empty').map((c) => ({ id: c.id, label: c.label }))}
            // a takeaway bill only takes in other takeaways; a table's bill takes in anything (merge_bills refuses the rest)
            mergeSources={bills.filter((b) => b.id !== selectedBill?.id
              && !(selectedBill?.order_type === 'takeaway' && b.order_type === 'dine_in')).map((b) => ({
              id: b.id,
              label: b.table_id ? `Table ${tables.find((t) => t.id === b.table_id)?.label ?? '?'}` : 'Takeaway',
              detail: `Bill ${b.bill_no}`,
            }))}
            onChanged={() => { setRefreshKey((k) => k + 1); void reload() }}
            onMoved={(tableId) => setSelection({ kind: 'table', tableId })}
            onCheckout={() => { if (selectedBill) { loadBilling(); setCheckout(selectedBill) } }}
```

- [ ] **Step 5: Gates.** Run: `npx tsc -b` — Expected: no output. Run: `npx vitest run src/features/pos` — Expected: PASS.

- [ ] **Step 6 (controller, craft-os-dev — browser and SQL; the implementer does not touch the database):** Browser (dev, test login): `T2` → order 2 items → the panel shows **Void** on each item and **Move table** · **Merge with…** · **Void bill**. **Move table** → pick `T5` → the bill shows under `T5`, `T2` is Empty. Start a takeaway order; on the takeaway, **Merge with…** lists only other takeaways (a table's bill never merges into a takeaway); on `T5` **Merge with…** → pick the takeaway → confirm → its items join `T5`'s bill and the takeaway button disappears. **Void** on an item opens the dialog with the Demo reasons ("Customer changed mind", …) and the approver list (the test login shows `(no PIN)` until it sets one — the PIN checks run in Task 11 Step 7). Open table: on dev run `update branch_pos_settings set qr_requires_open_bill = true where branch_id = (select id from branches where name = 'Demo')`, reload `/pos`, tap an empty table → **Open table for QR ordering** → guests `2` → the table shows a bill with **Close empty bill** → tap it → confirm → the table is Empty again (no approval for an empty bill); then set the switch back to `false`.

- [ ] **Step 7: Commit**

```bash
git add src/features/pos/checkout/ApprovalDialog.tsx src/features/pos/checkout/BillPickers.tsx src/features/pos/order/BillPanel.tsx src/features/pos/order/PosPage.tsx
git commit -m "feat(pos-checkout): void item / void bill with approver PIN, move table, merge bills, open table

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Today's bills (reprint, refund) and My PIN

**Files:**
- Create: `src/features/pos/checkout/todayBills.ts`, `src/features/pos/checkout/TodayBillsDrawer.tsx`, `src/features/pos/checkout/MyPinDialog.tsx`
- Test: `src/features/pos/checkout/todayBills.test.ts`
- Modify: `src/features/pos/order/PosPage.tsx`

**Interfaces:**
- Consumes: Task 8 (`fetchClosedBillsSince`, `fetchPaymentMethods`, `reprintReceipt`, `refundBill`, `setMyPin`, `parseRinggit`), Task 10 (`ApprovalDialog`).
- Produces: `mytDayStartIso(nowMs: number): string`, `refundableSen(bill: { status: string; total_sen: number | null; refunded_sen: number }): number`, `STATUS_LABEL: Record<string, string>`; `TodayBillsDrawer({ branchId, onClose })`; `MyPinDialog({ onClose })`; POS header buttons **Today's bills** and **My PIN**.

- [ ] **Step 1: Write the failing test** `src/features/pos/checkout/todayBills.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mytDayStartIso, refundableSen } from './todayBills'

describe('mytDayStartIso', () => {
  it('is midnight Malaysia time, i.e. 16:00 UTC the day before', () => {
    expect(mytDayStartIso(Date.parse('2026-10-23T15:59:00Z'))).toBe('2026-10-22T16:00:00.000Z')
    expect(mytDayStartIso(Date.parse('2026-10-23T16:00:00Z'))).toBe('2026-10-23T16:00:00.000Z')
    expect(mytDayStartIso(Date.parse('2026-10-24T03:00:00Z'))).toBe('2026-10-23T16:00:00.000Z')
  })
})

describe('refundableSen', () => {
  it('is the total less what was refunded, on paid bills only', () => {
    expect(refundableSen({ status: 'paid', total_sen: 9280, refunded_sen: 1300 })).toBe(7980)
    expect(refundableSen({ status: 'paid', total_sen: 9280, refunded_sen: 9280 })).toBe(0)
    expect(refundableSen({ status: 'voided', total_sen: null, refunded_sen: 0 })).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run src/features/pos/checkout/todayBills.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write `todayBills.ts`**

```ts
/** Start of today in Malaysia (UTC+8, no daylight saving) as an ISO instant. */
export function mytDayStartIso(nowMs: number): string {
  const h8 = 8 * 3600_000
  const myt = new Date(nowMs + h8)
  return new Date(Date.UTC(myt.getUTCFullYear(), myt.getUTCMonth(), myt.getUTCDate()) - h8).toISOString()
}

/** What can still be refunded on a paid bill. */
export function refundableSen(bill: { status: string; total_sen: number | null; refunded_sen: number }): number {
  if (bill.status !== 'paid' || bill.total_sen === null) return 0
  return Math.max(0, bill.total_sen - bill.refunded_sen)
}

export const STATUS_LABEL: Record<string, string> = { paid: 'Paid', voided: 'Voided', merged: 'Merged' }
```

- [ ] **Step 4: Run the test.** Run: `npx vitest run src/features/pos/checkout/todayBills.test.ts` — Expected: PASS (2 tests).

- [ ] **Step 5: Write the drawer and the PIN dialog.** `src/features/pos/checkout/TodayBillsDrawer.tsx` (one `refundId` per opened refund dialog, so a retry after a lost reply never refunds twice):

```tsx
import { useEffect, useRef, useState } from 'react'
import { formatSen } from '../order/cart'
import { fetchClosedBillsSince, fetchPaymentMethods, refundBill, reprintReceipt, type ClosedBillRow, type PaymentMethodRow } from './checkoutApi'
import ApprovalDialog from './ApprovalDialog'
import { mytDayStartIso, refundableSen, STATUS_LABEL } from './todayBills'
import { parseRinggit } from './tender'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kuala_Lumpur' })
const where = (b: ClosedBillRow) => (b.dining_tables ? `Table ${b.dining_tables.label}` : b.order_type === 'takeaway' ? 'Takeaway' : '—')

/** Today's closed bills (Malaysia day): reprint a receipt, refund a paid bill. */
export default function TodayBillsDrawer({ branchId, onClose }: { branchId: string; onClose: () => void }) {
  const [bills, setBills] = useState<ClosedBillRow[] | null>(null)
  const [methods, setMethods] = useState<PaymentMethodRow[]>([])
  const [note, setNote] = useState<string | null>(null)
  const [refunding, setRefunding] = useState<ClosedBillRow | null>(null)
  const [amountText, setAmountText] = useState('')
  const [methodId, setMethodId] = useState('')
  const refundId = useRef<string>('')

  const load = async () => {
    try { setBills(await fetchClosedBillsSince(branchId, mytDayStartIso(Date.now()))) } catch (e) { setNote(msg(e)) }
  }
  useEffect(() => {
    void load()
    fetchPaymentMethods(branchId, true).then(setMethods, (e) => setNote(msg(e)))
  }, [branchId]) // eslint-disable-line react-hooks/exhaustive-deps

  const reprint = async (b: ClosedBillRow) => {
    try { await reprintReceipt(b.id); setNote(`Receipt ${b.bill_no} sent to the printer`) } catch (e) { setNote(msg(e)) }
  }

  const startRefund = (b: ClosedBillRow) => {
    refundId.current = crypto.randomUUID()          // one id per refund: a retry can never refund twice
    setAmountText((refundableSen(b) / 100).toFixed(2))
    setMethodId(methods.find((m) => m.kind === 'cash')?.id ?? methods[0]?.id ?? '')
    setRefunding(b)
  }

  const amountSen = parseRinggit(amountText)
  const refundProblem = !refunding ? null
    : amountSen === null || amountSen <= 0 ? 'Enter the refund amount'
    : amountSen > refundableSen(refunding) ? `At most ${formatSen(refundableSen(refunding))} can be refunded`
    : !methodId ? 'Choose how the money goes back'
    : null

  return (
    <>
      <div className="fixed inset-0 z-30 flex justify-end bg-black/30" onClick={onClose}>
        <div className="flex h-full w-full max-w-xl flex-col bg-card" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-border p-4">
            <h2 className="text-lg font-semibold">Today's bills</h2>
            <div className="flex gap-2">
              <button onClick={() => void load()} className="rounded border border-border px-3 py-1 text-sm">Refresh</button>
              <button onClick={onClose} className="rounded border border-border px-3 py-1 text-sm">Close</button>
            </div>
          </div>
          {note && <p className="m-3 rounded bg-amber-50 p-2 text-sm text-amber-800">{note}</p>}
          <div className="flex-1 overflow-y-auto p-3 text-sm">
            {bills === null && <p className="text-brown-muted">Loading…</p>}
            {bills?.length === 0 && <p className="text-brown-muted">No closed bills yet today.</p>}
            {bills?.map((b) => (
              <div key={b.id} className="mb-2 flex items-center justify-between rounded-lg border border-border p-2">
                <div>
                  <div className="font-medium">{b.bill_no} · {where(b)}</div>
                  <div className="text-xs text-brown-muted">
                    {time(b.closed_at)} · {STATUS_LABEL[b.status] ?? b.status}
                    {b.total_sen !== null && ` · ${formatSen(b.total_sen)}`}
                    {b.refunded_sen > 0 && ` · refunded ${formatSen(b.refunded_sen)}`}
                  </div>
                </div>
                {b.status === 'paid' && (
                  <div className="flex gap-2">
                    <button onClick={() => void reprint(b)} className="rounded border border-border px-2 py-1 text-xs">Reprint receipt</button>
                    <button onClick={() => startRefund(b)} disabled={refundableSen(b) === 0}
                      className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 disabled:opacity-40">Refund</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      {refunding && (
        <ApprovalDialog branchId={branchId} action="refund" title={`Refund bill ${refunding.bill_no}`}
          summary={`Paid ${formatSen(refunding.total_sen ?? 0)}${refunding.refunded_sen ? `, already refunded ${formatSen(refunding.refunded_sen)}` : ''}`}
          extra={
            <div className="space-y-2 text-sm">
              <label className="block">Amount (RM)
                <input inputMode="decimal" className="ml-2 w-32 rounded border border-border p-2" value={amountText} onChange={(e) => setAmountText(e.target.value)} />
              </label>
              <label className="block">Paid back by
                <select className="ml-2 rounded border border-border p-2" value={methodId} onChange={(e) => setMethodId(e.target.value)}>
                  {methods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </label>
            </div>
          }
          extraProblem={refundProblem}
          onApprove={(a) => refundBill(refundId.current, refunding.id, amountSen ?? 0, methodId, a)}
          onClose={() => setRefunding(null)}
          onDone={() => { setNote(`Refunded ${formatSen(amountSen ?? 0)} on ${refunding.bill_no}`); setRefunding(null); void load() }} />
      )}
    </>
  )
}
```

`src/features/pos/checkout/MyPinDialog.tsx`:

```tsx
import { useState } from 'react'
import { setMyPin } from './checkoutApi'

const PIN = /^\d{4,6}$/

/** Every staff member sets their own POS PIN; it is stored only as a bcrypt hash. */
export default function MyPinDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (!PIN.test(next)) { setError('The PIN must be 4 to 6 digits'); return }
    if (next !== again) { setError('The two new PINs are different'); return }
    if (current && !PIN.test(current)) { setError('Your current PIN is 4 to 6 digits'); return }
    setBusy(true); setError(null)
    try { await setMyPin(next, current || null); setDone(true) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  const field = (label: string, value: string, set: (v: string) => void) => (
    <label className="block text-sm">{label}
      <input type="password" inputMode="numeric" autoComplete="off" maxLength={6} className="mt-1 w-full rounded border border-border p-2 tracking-widest"
        value={value} onChange={(e) => { set(e.target.value.replace(/\D/g, '')); setError(null) }} />
    </label>
  )

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-full max-w-sm space-y-3 rounded-2xl bg-card p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">My POS PIN</h2>
        {done ? (
          <>
            <p className="text-sm">PIN saved. Use it when you approve a void or a refund.</p>
            <button onClick={onClose} className="w-full rounded-xl bg-brown-btn py-3 text-white">Done</button>
          </>
        ) : (
          <>
            <p className="text-xs text-brown-muted">Approvers type this PIN on the cashier's iPad. Never share it. Forgot it? A manager can clear it in POS settings.</p>
            {field('Current PIN (leave empty if you never set one)', current, setCurrent)}
            {field('New PIN (4–6 digits)', next, setNext)}
            {field('New PIN again', again, setAgain)}
            {error && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
            <div className="flex gap-2">
              <button onClick={onClose} className="flex-1 rounded-xl border border-border py-3">Cancel</button>
              <button onClick={() => void save()} disabled={busy} className="flex-1 rounded-xl bg-brown-btn py-3 text-white disabled:opacity-40">{busy ? 'Saving…' : 'Save PIN'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
```

In `src/features/pos/order/PosPage.tsx` make exactly these replacements:

1. Replace:

```tsx
import { fetchBillingConfig, type BillingConfig } from '../checkout/checkoutApi'
```

   with:

```tsx
import { fetchBillingConfig, type BillingConfig } from '../checkout/checkoutApi'
import TodayBillsDrawer from '../checkout/TodayBillsDrawer'
import MyPinDialog from '../checkout/MyPinDialog'
```

2. Replace:

```tsx
  const [checkout, setCheckout] = useState<OpenBillRow | null>(null)
```

   with:

```tsx
  const [checkout, setCheckout] = useState<OpenBillRow | null>(null)
  const [drawer, setDrawer] = useState<'bills' | 'pin' | null>(null)
```

3. Replace:

```tsx
          <PrintHostPanel branchId={branchId} />
          <span>Live: {rtStatus}</span>
```

   with:

```tsx
          <PrintHostPanel branchId={branchId} />
          <button onClick={() => setDrawer('bills')} className="rounded border border-border px-3 py-1">Today's bills</button>
          <button onClick={() => setDrawer('pin')} className="rounded border border-border px-3 py-1">My PIN</button>
          <span>Live: {rtStatus}</span>
```

4. Replace:

```tsx
      {checkout && (
        <CheckoutSheet
```

   with:

```tsx
      {drawer === 'bills' && <TodayBillsDrawer branchId={branchId} onClose={() => setDrawer(null)} />}
      {drawer === 'pin' && <MyPinDialog onClose={() => setDrawer(null)} />}
      {checkout && (
        <CheckoutSheet
```

- [ ] **Step 6: Gates.** Run: `npx tsc -b` — Expected: no output. Run: `npx vitest run src/features/pos` — Expected: PASS.

- [ ] **Step 7 (controller, craft-os-dev — browser and SQL; the implementer does not touch the database):** Browser (dev, test login): **My PIN** → leave current empty, new `1234` twice → "PIN saved". Again with current `0000` → "Current PIN: Wrong PIN — 4 tries left"; with current `1234` → saved. Approval checks deferred from Task 10: on an open bill **Void** an item → reason "Wrong item keyed" → approver = the test login → PIN `0000` → "Wrong PIN — 4 tries left" (the successful PIN change reset the counter) and the item stays; PIN `1234` → the item is struck through; `select payload->>'void', route from print_jobs order by created_at desc limit 1` → `true | <the item's route>` (items with no route print nothing — set routes on /menu first, Task 13). **Void bill** on another bill → the table is Empty. **Today's bills** → the paid bill from Task 9 is listed `Paid`; **Reprint receipt** → "Receipt … sent to the printer" and a `receipt` job with `payload->>'reprint' = 'true'`; **Refund** → amount `5.00`, Paid back by Cash, reason "Item not served", approver PIN `1234` → "Refunded RM 5.00 on …", the row shows `refunded RM 5.00`; a second refund of more than what is left → "Refund is more than what is left on this bill (RM …)". The voided bill is listed `Voided`, a merged one `Merged`.

- [ ] **Step 8: Commit**

```bash
git add src/features/pos/checkout/todayBills.ts src/features/pos/checkout/todayBills.test.ts src/features/pos/checkout/TodayBillsDrawer.tsx src/features/pos/checkout/MyPinDialog.tsx src/features/pos/order/PosPage.tsx
git commit -m "feat(pos-checkout): today's bills with reprint and refund; My PIN

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: POS settings — receipt, service charge, payment methods, reasons, approvers

**Files:**
- Create: `src/features/pos/checkout/settingsForm.ts`, `src/features/pos/checkout/CheckoutSettings.tsx`
- Test: `src/features/pos/checkout/settingsForm.test.ts`
- Modify: `src/features/pos/order/PosSettingsPage.tsx`, `src/shared/lib/nav.ts`, `src/features/pos/order/PosPage.tsx`, `src/features/pos/order/PrintHostPanel.tsx`

**Interfaces:**
- Consumes: Task 8 (`fetchReceiptDetails`, `saveReceiptDetails`, `fetchServiceChargeRules`, `saveServiceChargeRule`, `deleteServiceChargeRule`, `fetchPaymentMethods`, `savePaymentMethod`, `fetchReasonTemplates`, `saveReasonTemplate`, `fetchApprovers`, `clearPin`, `fetchProductNames`), `TableRow` and `PrintRoute` (Sub-plan 2).
- Produces: `parsePercentBp(text: string): number | null`, `bpToPercentText(bp: number): string`, `parseReasons(text: string): string[]`, `interface ReceiptDetailsForm`, `receiptDetailsProblem(f: ReceiptDetailsForm): string | null`, `scopeLabel(ids: string[] | null, noun: string): string`; `CheckoutSettings({ branchId, routes: string[], tables: TableRow[] })` rendered on `/pos/settings`; the page and nav entry are named "POS settings" / "POS Settings".

- [ ] **Step 1: Write the failing test** `src/features/pos/checkout/settingsForm.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { bpToPercentText, parsePercentBp, parseReasons, receiptDetailsProblem, scopeLabel } from './settingsForm'

describe('percent ↔ basis points', () => {
  it('parses a percentage', () => {
    expect(parsePercentBp('10')).toBe(1000)
    expect(parsePercentBp('6.5%')).toBe(650)
    expect(parsePercentBp('0')).toBe(0)
    expect(parsePercentBp('100')).toBe(10000)
  })
  it('refuses junk and over 100', () => {
    expect(parsePercentBp('')).toBeNull()
    expect(parsePercentBp('101')).toBeNull()
    expect(parsePercentBp('6.555')).toBeNull()
    expect(parsePercentBp('ten')).toBeNull()
  })
  it('prints basis points back', () => {
    expect(bpToPercentText(1000)).toBe('10')
    expect(bpToPercentText(650)).toBe('6.5')
  })
})

describe('parseReasons', () => {
  it('keeps one trimmed reason per line, no blanks or repeats', () => {
    expect(parseReasons(' Wrong item keyed \n\nCustomer changed mind\nWrong item keyed')).toEqual(['Wrong item keyed', 'Customer changed mind'])
  })
})

describe('receiptDetailsProblem', () => {
  const ok = { receiptTitle: 'Craft Cafe - Demo', legalName: '', registrationNo: '', sstNo: '', address: '', phone: '', email: '', footer: 'Thanks' }
  it('needs a title and a sane email and footer', () => {
    expect(receiptDetailsProblem(ok)).toBeNull()
    expect(receiptDetailsProblem({ ...ok, receiptTitle: ' ' })).toMatch(/receipt title/)
    expect(receiptDetailsProblem({ ...ok, email: 'nope' })).toBe('The email address does not look right')
    expect(receiptDetailsProblem({ ...ok, footer: 'x'.repeat(301) })).toMatch(/too long/)
  })
})

describe('scopeLabel', () => {
  it('says All or a count', () => {
    expect(scopeLabel(null, 'table')).toBe('All tables')
    expect(scopeLabel(['a'], 'table')).toBe('1 table')
    expect(scopeLabel(['a', 'b'], 'product')).toBe('2 products')
  })
})
```

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run src/features/pos/checkout/settingsForm.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write `settingsForm.ts`**

```ts
/** Pure helpers for the checkout sections of /pos/settings. */

/** "10" → 1000, "6.5" → 650, "0" → 0; null when not a percentage between 0 and 100 with at most two decimals. */
export function parsePercentBp(text: string): number | null {
  const t = text.replace('%', '').trim()
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null
  const bp = Math.round(Number(t) * 100)
  return bp <= 10000 ? bp : null
}

/** 1000 → "10", 650 → "6.5". */
export function bpToPercentText(bp: number): string {
  return String(Number((bp / 100).toFixed(2)))
}

/** One reason per line; blank lines and repeats dropped. */
export function parseReasons(text: string): string[] {
  return [...new Set(text.split('\n').map((s) => s.trim()).filter(Boolean))]
}

export interface ReceiptDetailsForm {
  receiptTitle: string
  legalName: string
  registrationNo: string
  sstNo: string
  address: string
  phone: string
  email: string
  footer: string
}

export function receiptDetailsProblem(f: ReceiptDetailsForm): string | null {
  if (!f.receiptTitle.trim()) return 'Enter the receipt title (the shop name printed at the top)'
  if (f.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) return 'The email address does not look right'
  if (f.footer.length > 300) return 'The footer is too long (300 characters at most)'
  return null
}

/** "All tables" or "3 tables" for a rule row. */
export function scopeLabel(ids: string[] | null, noun: string): string {
  if (ids === null) return `All ${noun}s`
  return `${ids.length} ${noun}${ids.length === 1 ? '' : 's'}`
}
```

- [ ] **Step 4: Run the test.** Run: `npx vitest run src/features/pos/checkout/settingsForm.test.ts` — Expected: PASS (6 tests).

- [ ] **Step 5: Write `CheckoutSettings.tsx`**

```tsx
import { useEffect, useMemo, useState } from 'react'
import type { TableRow } from '../order/posApi'
import type { BillOrderType, CashRounding } from './bill'
import {
  clearPin, deleteServiceChargeRule, fetchApprovers, fetchPaymentMethods, fetchProductNames, fetchReasonTemplates,
  fetchReceiptDetails, fetchServiceChargeRules, savePaymentMethod, saveReasonTemplate, saveReceiptDetails,
  saveServiceChargeRule, type Approver, type PaymentMethodRow, type ReceiptDetails, type ServiceChargeRuleRow,
} from './checkoutApi'
import { ACTION_TITLES, type ReasonAction } from './reasons'
import { bpToPercentText, parsePercentBp, parseReasons, receiptDetailsProblem, scopeLabel } from './settingsForm'
import type { PaymentKind } from './tender'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const KINDS: PaymentKind[] = ['cash', 'card', 'duitnow', 'ewallet', 'other']
const ACTIONS: ReasonAction[] = ['void_item', 'void_bill', 'refund']
const ORDER_TYPES: { key: BillOrderType; label: string }[] = [{ key: 'dine_in', label: 'Dine-in' }, { key: 'takeaway', label: 'Takeaway' }]
const box = 'rounded-xl border border-border bg-card p-4'
const input = 'rounded border border-border p-1'

/** The checkout sections of /pos/settings: receipt details, service charge,
 *  payment methods, reason templates and approver PINs (access_settings holders). */
export default function CheckoutSettings({ branchId, routes, tables }: { branchId: string; routes: string[]; tables: TableRow[] }) {
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const run = async (fn: () => Promise<void>, done: string) => {
    setError(null); setNote(null)
    try { await fn(); setNote(done) } catch (e) { setError(msg(e)) }
  }
  return (
    <div className="space-y-6">
      {error && <p className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {note && <p className="rounded bg-green-50 p-3 text-sm text-green-800">{note}</p>}
      <ReceiptSection branchId={branchId} routes={routes} run={run} onError={setError} />
      <ServiceChargeSection branchId={branchId} tables={tables} run={run} onError={setError} />
      <PaymentMethodsSection branchId={branchId} run={run} onError={setError} />
      <ReasonsSection branchId={branchId} run={run} onError={setError} />
      <ApproversSection run={run} onError={setError} />
    </div>
  )
}

type Run = (fn: () => Promise<void>, done: string) => Promise<void>

function ReceiptSection({ branchId, routes, run, onError }: { branchId: string; routes: string[]; run: Run; onError: (m: string) => void }) {
  const [d, setD] = useState<ReceiptDetails | null>(null)
  useEffect(() => { fetchReceiptDetails(branchId).then(setD, (e) => onError(msg(e))) }, [branchId]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <section className={box}><h2 className="font-semibold">Receipt</h2><p className="text-sm text-brown-muted">Loading…</p></section>
  const text = (key: 'receiptTitle' | 'legalName' | 'registrationNo' | 'sstNo' | 'address' | 'phone' | 'email', label: string) => (
    <label className="block text-sm">{label}
      <input className={`${input} mt-1 w-full`} value={d[key]} onChange={(e) => setD({ ...d, [key]: e.target.value })} />
    </label>
  )
  const save = () => run(async () => {
    const problem = receiptDetailsProblem(d)
    if (problem) throw new Error(problem)
    await saveReceiptDetails(d)
  }, 'Receipt settings saved')
  return (
    <section className={box}>
      <h2 className="font-semibold">Receipt</h2>
      <p className="text-xs text-brown-muted">Printed at the top and bottom of every customer receipt. ASCII only for now: Chinese prints as "?".</p>
      <div className="mt-2 grid grid-cols-2 gap-3">
        {text('receiptTitle', 'Title (shop name)')}
        {text('legalName', 'Company name')}
        {text('registrationNo', 'Registration no.')}
        {text('sstNo', 'SST no.')}
        {text('address', 'Address')}
        {text('phone', 'Phone')}
        {text('email', 'Email')}
        <label className="block text-sm">Receipt printer (route)
          <select className={`${input} mt-1 w-full`} value={d.receiptRoute ?? ''} onChange={(e) => setD({ ...d, receiptRoute: e.target.value || null })}>
            <option value="">No receipt printer</option>
            {routes.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <label className="col-span-2 block text-sm">Footer
          <input className={`${input} mt-1 w-full`} value={d.footer} onChange={(e) => setD({ ...d, footer: e.target.value })} />
        </label>
        <label className="text-sm"><input type="checkbox" checked={d.sstRegistered} onChange={(e) => setD({ ...d, sstRegistered: e.target.checked })} /> SST registered (charge SST)</label>
        <label className="text-sm">Rounding
          <select className={`${input} ml-2`} value={d.cashRounding} onChange={(e) => setD({ ...d, cashRounding: e.target.value as CashRounding })}>
            <option value="nearest_5_sen">Nearest 5 sen (whole bill)</option>
            <option value="none">None</option>
          </select>
        </label>
        <label className="col-span-2 text-sm"><input type="checkbox" checked={d.qrRequiresOpenBill} onChange={(e) => setD({ ...d, qrRequiresOpenBill: e.target.checked })} /> Staff must open a table before customers can order by QR</label>
      </div>
      <button onClick={() => void save()} className="mt-3 rounded bg-brown-btn px-3 py-2 text-sm text-white">Save receipt settings</button>
    </section>
  )
}

interface RuleDraft { id?: string; rateText: string; orderTypes: BillOrderType[]; tableIds: string[] | null; productIds: string[] | null; sortOrder: number; isActive: boolean }
const toDraft = (r: ServiceChargeRuleRow): RuleDraft => ({
  id: r.id, rateText: bpToPercentText(r.rate_bp), orderTypes: r.order_types, tableIds: r.table_ids, productIds: r.product_ids, sortOrder: r.sort_order, isActive: r.is_active,
})

function ServiceChargeSection({ branchId, tables, run, onError }: { branchId: string; tables: TableRow[]; run: Run; onError: (m: string) => void }) {
  const [rules, setRules] = useState<ServiceChargeRuleRow[]>([])
  const [products, setProducts] = useState<{ id: string; name: string }[]>([])
  const [draft, setDraft] = useState<RuleDraft | null>(null)
  const [search, setSearch] = useState('')
  const load = () => fetchServiceChargeRules(branchId).then(setRules, (e) => onError(msg(e)))
  useEffect(() => { void load(); fetchProductNames().then(setProducts, (e) => onError(msg(e))) }, [branchId]) // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    const chosen = new Set(draft?.productIds ?? [])
    return products.filter((p) => chosen.has(p.id) || (q && p.name.toLowerCase().includes(q))).slice(0, 60)
  }, [products, search, draft?.productIds])

  const save = () => run(async () => {
    if (!draft) return
    const rate = parsePercentBp(draft.rateText)
    if (rate === null) throw new Error('Enter the rate as a percentage, e.g. 10')
    if (draft.orderTypes.length === 0) throw new Error('Choose at least one order type')
    if (draft.tableIds?.length === 0) throw new Error('Choose at least one table, or All tables')
    if (draft.productIds?.length === 0) throw new Error('Choose at least one product, or All products')
    await saveServiceChargeRule({
      ...(draft.id ? { id: draft.id } : {}), branch_id: branchId, rate_bp: rate, order_types: draft.orderTypes,
      table_ids: draft.tableIds, product_ids: draft.productIds, sort_order: draft.sortOrder, is_active: draft.isActive,
    })
    setDraft(null); await load()
  }, 'Service-charge rule saved')
  const remove = (r: ServiceChargeRuleRow) => {
    if (!window.confirm(`Remove the ${bpToPercentText(r.rate_bp)}% rule?`)) return
    void run(async () => { await deleteServiceChargeRule(r.id); await load() }, 'Rule removed')
  }
  const toggle = <T,>(list: T[], x: T) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x])

  return (
    <section className={box}>
      <h2 className="font-semibold">Service charge</h2>
      <p className="text-xs text-brown-muted">Each item takes the first matching active rule, top to bottom. Items no rule matches pay none. SST is not charged on the service charge.</p>
      <table className="mt-2 w-full text-sm">
        <tbody>
          {rules.map((r) => (
            <tr key={r.id} className={`border-t border-border ${r.is_active ? '' : 'opacity-50'}`}>
              <td className="py-2 font-medium">{bpToPercentText(r.rate_bp)}%</td>
              <td>{r.order_types.map((t) => ORDER_TYPES.find((o) => o.key === t)?.label ?? t).join(' + ')}</td>
              <td>{scopeLabel(r.table_ids, 'table')}</td>
              <td>{scopeLabel(r.product_ids, 'product')}</td>
              <td className="text-xs">#{r.sort_order}{r.is_active ? '' : ' · off'}</td>
              <td className="space-x-3 text-right text-xs">
                <button className="underline" onClick={() => { setDraft(toDraft(r)); setSearch('') }}>Edit</button>
                <button className="text-red-700 underline" onClick={() => remove(r)}>Remove</button>
              </td>
            </tr>
          ))}
          {rules.length === 0 && <tr><td className="py-2 text-brown-muted">No service charge.</td></tr>}
        </tbody>
      </table>
      {!draft && (
        <button onClick={() => setDraft({ rateText: '10', orderTypes: ['dine_in'], tableIds: null, productIds: null, sortOrder: rules.length + 1, isActive: true })}
          className="mt-2 rounded border border-border px-3 py-1 text-sm">Add rule</button>
      )}
      {draft && (
        <div className="mt-3 space-y-3 rounded-lg bg-cream p-3 text-sm">
          <div className="flex flex-wrap items-center gap-4">
            <label>Rate % <input className={`${input} w-20`} value={draft.rateText} onChange={(e) => setDraft({ ...draft, rateText: e.target.value })} /></label>
            {ORDER_TYPES.map((o) => (
              <label key={o.key}><input type="checkbox" checked={draft.orderTypes.includes(o.key)} onChange={() => setDraft({ ...draft, orderTypes: toggle(draft.orderTypes, o.key) })} /> {o.label}</label>
            ))}
            <label>Order <input type="number" className={`${input} w-16`} value={draft.sortOrder} onChange={(e) => setDraft({ ...draft, sortOrder: Number(e.target.value) || 0 })} /></label>
            <label><input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} /> Active</label>
          </div>
          <div>
            <label><input type="radio" checked={draft.tableIds === null} onChange={() => setDraft({ ...draft, tableIds: null })} /> All tables</label>
            <label className="ml-4"><input type="radio" checked={draft.tableIds !== null} onChange={() => setDraft({ ...draft, tableIds: draft.tableIds ?? [] })} /> Only these tables</label>
            {draft.tableIds !== null && (
              <div className="mt-1 flex flex-wrap gap-2">
                {tables.map((t) => (
                  <label key={t.id} className="rounded border border-border px-2 py-1">
                    <input type="checkbox" checked={draft.tableIds?.includes(t.id) ?? false} onChange={() => setDraft({ ...draft, tableIds: toggle(draft.tableIds ?? [], t.id) })} /> {t.label}
                  </label>
                ))}
              </div>
            )}
          </div>
          <div>
            <label><input type="radio" checked={draft.productIds === null} onChange={() => setDraft({ ...draft, productIds: null })} /> All products</label>
            <label className="ml-4"><input type="radio" checked={draft.productIds !== null} onChange={() => setDraft({ ...draft, productIds: draft.productIds ?? [] })} /> Only these products</label>
            {draft.productIds !== null && (
              <div className="mt-1">
                <input className={`${input} w-64`} placeholder="Search products" value={search} onChange={(e) => setSearch(e.target.value)} />
                <span className="ml-2 text-xs text-brown-muted">{draft.productIds.length} chosen</span>
                <div className="mt-1 max-h-48 overflow-y-auto">
                  {shown.map((p) => (
                    <label key={p.id} className="block">
                      <input type="checkbox" checked={draft.productIds?.includes(p.id) ?? false} onChange={() => setDraft({ ...draft, productIds: toggle(draft.productIds ?? [], p.id) })} /> {p.name}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={() => void save()} className="rounded bg-brown-btn px-3 py-1 text-white">Save rule</button>
            <button onClick={() => setDraft(null)} className="rounded border border-border px-3 py-1">Cancel</button>
          </div>
        </div>
      )}
    </section>
  )
}

function PaymentMethodsSection({ branchId, run, onError }: { branchId: string; run: Run; onError: (m: string) => void }) {
  const [rows, setRows] = useState<(Omit<PaymentMethodRow, 'id'> & { id?: string })[]>([])
  const load = () => fetchPaymentMethods(branchId, false).then(setRows, (e) => onError(msg(e)))
  useEffect(() => { void load() }, [branchId]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (i: number, patch: Partial<PaymentMethodRow>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)))
  const save = (i: number) => run(async () => {
    const r = rows[i]
    if (!r.name.trim()) throw new Error('Enter the payment method name')
    await savePaymentMethod({ ...r, name: r.name.trim() })
    await load()
  }, 'Payment method saved')
  return (
    <section className={box}>
      <h2 className="font-semibold">Payment methods</h2>
      <p className="text-xs text-brown-muted">Only cash gives change. "Needs reference" makes the cashier type the terminal or transfer reference. Turn a method off instead of deleting it: old bills keep its name.</p>
      {rows.map((r, i) => (
        <div key={r.id ?? `new${i}`} className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <input className={`${input} w-44`} value={r.name} onChange={(e) => set(i, { name: e.target.value })} />
          <select className={input} value={r.kind} onChange={(e) => set(i, { kind: e.target.value as PaymentKind })}>
            {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <label><input type="checkbox" checked={r.needs_reference} onChange={(e) => set(i, { needs_reference: e.target.checked })} /> Needs reference</label>
          <label><input type="checkbox" checked={r.is_active} onChange={(e) => set(i, { is_active: e.target.checked })} /> Active</label>
          <label>Order <input type="number" className={`${input} w-14`} value={r.sort_order} onChange={(e) => set(i, { sort_order: Number(e.target.value) || 0 })} /></label>
          <button onClick={() => void save(i)} className="rounded bg-brown-btn px-2 py-1 text-xs text-white">Save</button>
        </div>
      ))}
      <button onClick={() => setRows((rs) => [...rs, { branch_id: branchId, name: '', kind: 'other', needs_reference: false, sort_order: rs.length + 1, is_active: true }])}
        className="mt-2 rounded border border-border px-3 py-1 text-sm">Add payment method</button>
    </section>
  )
}

function ReasonsSection({ branchId, run, onError }: { branchId: string; run: Run; onError: (m: string) => void }) {
  const [drafts, setDrafts] = useState<Record<ReasonAction, { text: string; compulsory: boolean; allowOther: boolean }>>({
    void_item: { text: '', compulsory: true, allowOther: true },
    void_bill: { text: '', compulsory: true, allowOther: true },
    refund: { text: '', compulsory: true, allowOther: true },
  })
  useEffect(() => {
    fetchReasonTemplates(branchId).then((rows) => setDrafts((d) => {
      const next = { ...d }
      for (const r of rows) next[r.action] = { text: r.reasons.join('\n'), compulsory: r.compulsory, allowOther: r.allow_other }
      return next
    }), (e) => onError(msg(e)))
  }, [branchId]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = (a: ReasonAction) => run(async () => {
    const d = drafts[a]
    const reasons = parseReasons(d.text)
    if (!d.allowOther && reasons.length === 0) throw new Error('List at least one reason, or allow Other')
    await saveReasonTemplate({ branch_id: branchId, action: a, reasons, compulsory: d.compulsory, allow_other: d.allowOther })
  }, `${ACTION_TITLES[a]} reasons saved`)
  return (
    <section className={box}>
      <h2 className="font-semibold">Reasons for voids and refunds</h2>
      <div className="mt-2 grid grid-cols-3 gap-3 text-sm">
        {ACTIONS.map((a) => (
          <div key={a}>
            <div className="font-medium">{ACTION_TITLES[a]}</div>
            <textarea rows={5} className={`${input} mt-1 w-full`} placeholder="One reason per line" value={drafts[a].text}
              onChange={(e) => setDrafts({ ...drafts, [a]: { ...drafts[a], text: e.target.value } })} />
            <label className="block"><input type="checkbox" checked={drafts[a].compulsory} onChange={(e) => setDrafts({ ...drafts, [a]: { ...drafts[a], compulsory: e.target.checked } })} /> Reason required</label>
            <label className="block"><input type="checkbox" checked={drafts[a].allowOther} onChange={(e) => setDrafts({ ...drafts, [a]: { ...drafts[a], allowOther: e.target.checked } })} /> Allow "Other" (typed)</label>
            <button onClick={() => void save(a)} className="mt-1 rounded bg-brown-btn px-2 py-1 text-xs text-white">Save</button>
          </div>
        ))}
      </div>
    </section>
  )
}

function ApproversSection({ run, onError }: { run: Run; onError: (m: string) => void }) {
  const [rows, setRows] = useState<Approver[]>([])
  const load = () => fetchApprovers().then(setRows, (e) => onError(msg(e)))
  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const clear = (a: Approver) => {
    if (!window.confirm(`Clear ${a.name}'s PIN? They set a new one under My PIN on the POS.`)) return
    void run(async () => { await clearPin(a.staffId); await load() }, `${a.name}'s PIN cleared`)
  }
  return (
    <section className={box}>
      <h2 className="font-semibold">Approvers</h2>
      <p className="text-xs text-brown-muted">Staff of this branch who hold "Approve POS voids &amp; refunds" (Settings → System Roles). Each sets a PIN under My PIN on the POS.</p>
      {rows.map((a) => (
        <div key={a.staffId} className="mt-1 flex items-center justify-between text-sm">
          <span>{a.name} · {a.hasPin ? 'PIN set' : 'no PIN yet'}</span>
          {a.hasPin && <button onClick={() => clear(a)} className="text-xs text-red-700 underline">Clear PIN</button>}
        </div>
      ))}
      {rows.length === 0 && <p className="text-sm text-brown-muted">Nobody at this branch can approve yet.</p>}
    </section>
  )
}
```

- [ ] **Step 6: Render it and rename the page.** `src/features/pos/order/PosSettingsPage.tsx`:

1. Replace:

```tsx
import { addTableAction, friendlyDbMessage, openBillMessage, renameConflict } from './tableAdmin'
```

   with:

```tsx
import { addTableAction, friendlyDbMessage, openBillMessage, renameConflict } from './tableAdmin'
import CheckoutSettings from '../checkout/CheckoutSettings'
```

2. Replace:

```tsx
        <h1 className="text-2xl font-semibold">Tables & printers</h1>
```

   with:

```tsx
        <h1 className="text-2xl font-semibold">POS settings</h1>
```

3. Replace:

```tsx
      {card && (
        <div className="fixed inset-0 z-20
```

   with:

```tsx
      <CheckoutSettings branchId={branchId} routes={routes.map((r) => r.route)} tables={tables} />

      {card && (
        <div className="fixed inset-0 z-20
```

`src/shared/lib/nav.ts`:

1. Replace:

```ts
      { id: 'pos-settings', label: 'Tables & Printers', to: '/pos/settings', cap: 'access_settings' },
```

   with:

```ts
      { id: 'pos-settings', label: 'POS Settings',      to: '/pos/settings', cap: 'access_settings' },
```

`src/features/pos/order/PosPage.tsx`:

1. Replace:

```tsx
<Link to="/pos/settings" className="underline">Tables & printers</Link>
```

   with:

```tsx
<Link to="/pos/settings" className="underline">POS settings</Link>
```

`src/features/pos/order/PrintHostPanel.tsx`:

1. Replace:

```tsx
No printers set — see Tables & printers.
```

   with:

```tsx
No printers set — see POS settings.
```

2. Replace:

```tsx
— set them in Tables &amp; printers.
```

   with:

```tsx
— set them in POS settings.
```

- [ ] **Step 7: Gates.** Run: `npx tsc -b` — Expected: no output. Run: `npx vitest run` — Expected: all pass (670 tests at the time of writing; `nav.test.ts` checks ids, not labels). Run: `grep -rn "Tables & [Pp]rinters" src` — Expected: no output.

- [ ] **Step 8 (controller, craft-os-dev — browser and SQL; the implementer does not touch the database):** Browser `/pos/settings` (dev, test login): **Receipt** shows the seeded title `Craft Cafe - Demo` and route `Bar`; change the phone and **Save receipt settings** → "Receipt settings saved" and `select phone from branches where name = 'Demo'` shows it; choose route "No receipt printer" → save → a checkout says "No receipt printer is set…"; set `Bar` back. **Service charge** lists `10% · Dine-in · All tables · All products`; **Add rule** 5 %, Takeaway, Only these products → search `latte` → tick one → **Save rule** → a takeaway bill with that product shows `Service charge (5%)` in the bill panel and in checkout; remove the rule. **Payment methods**: add `Grab` (other) → **Save** → it appears in the checkout sheet; untick Active → gone. **Reasons**: untick "Allow Other" for Void item → **Save** → the void dialog has no Other box and the server refuses a typed reason. **Approvers** lists the test login with "PIN set"; **Clear PIN** → "no PIN yet" (set it again under My PIN). Sign in as a non-manager staff login (if one exists on dev) → `/pos/settings` is not reachable (route guard), and a direct `save_receipt_settings` call is refused with "Only a manager can change the receipt settings" (verified in Task 5's script).

- [ ] **Step 9: Commit**

```bash
git add src/features/pos/checkout/settingsForm.ts src/features/pos/checkout/settingsForm.test.ts src/features/pos/checkout/CheckoutSettings.tsx src/features/pos/order/PosSettingsPage.tsx src/shared/lib/nav.ts src/features/pos/order/PosPage.tsx src/features/pos/order/PrintHostPanel.tsx
git commit -m "feat(pos-checkout): receipt, service charge, payment methods, reasons and approvers on POS settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: On-site run on dev — checkout prints a receipt on the ZY301 next to a Feedme receipt (controller + owner)

No code. Extends Sub-plan 2's Task 13 (do that one first if it has not run: tickets must print). Done with the owner at the shop, where the ZY301 is reachable at `192.168.0.8`.

- [ ] **Step 1: Server and agent.** Start `pos-dev-lan` (Sub-plan 2 Task 13 Step 1) and the agent (`node --env-file=tools/print-agent/.env tools/print-agent/agent.ts` → `routes: Bar, Kitchen`, `realtime: SUBSCRIBED`). On `/menu` make sure the items used below have print routes (drinks `Bar`, food `Kitchen`; the ledger says only PASTA had one).
- [ ] **Step 2: Settings.** On the iPad open **POS → POS Settings**: fill the receipt header with the real Craft Cafe details (title, company, REG NO, SST NO, address, phone, email), receipt printer `Bar`, SST registered on, rounding "Nearest 5 sen", save. Each approver signs in once and sets **My PIN**.
- [ ] **Step 3: The #87846 comparison.** Owner brings Feedme receipt #87846 (or rings the same four items in Feedme today and keeps that receipt). On our POS: table `T1`, the same four items, the same pax → **Checkout** → pay the same way (Touch 'n Go, total) → our receipt prints on the ZY301 within 2 s. Lay both side by side and tick, line by line: title/company/REG NO/SST NO/address/phone/email · Invoice no · Date · Cashier · Table pax · ORDER T1 · each item `qty name (unit/ea) amount` and modifiers · Item count · Subtotal 80.00 · SST (6%) 4.80 · SERVICE CHARGE (10%) 8.00 · Bill rounding · Total (MYR) 92.80 · payment · Change · Charges summary (Base Amt 80.00 / Amount) · footer. Photograph both; every difference goes in the ledger as a fix task or an accepted difference (the owner decides).
- [ ] **Step 4: Cash, split and rounding.** Takeaway order whose total does not end in 0 or 5 → checkout with Cash, RM 50 → the receipt shows `Takeaway packaging`, `Bill rounding` (−0.02…+0.02), `Cash 50.00`, `Change`. A dine-in bill paid half Touch 'n Go, half Cash → both payments on the receipt in that order. If the owner has a Feedme **cash** receipt with non-zero rounding and a **takeaway** receipt, compare them too: they answer the [CONFIRM] questions on rounding and takeaway service charge.
- [ ] **Step 5: Voids, move, merge.** Void one item with a supervisor's PIN → a `*** VOID ***` ticket prints on that item's route. Wrong PIN five times → "locked for 10 minutes" (then `update staff_pos_pins set locked_until = null where staff_id = '<id>'` on dev to continue). Move `T2` → `T6`: no reprint. Merge a takeaway into `T6` → one bill. **Void bill** on a test bill → VOID tickets for each route.
- [ ] **Step 6: Reprint and refund.** **Today's bills** → **Reprint receipt** on the #87846 bill → `*** REPRINT ***` at the top. **Refund** RM 13.00, Cash, "Item not served", supervisor PIN → a refund slip prints (Invoice no, Refund (MYR) 13.00, Paid back by Cash, Approved by …).
- [ ] **Step 7: QR leak switch.** POS settings → tick "Staff must open a table before customers can order by QR" → phone scans `T7`'s card → ordering says "Please ask our staff to open your table before ordering." → iPad **Open table for QR ordering** on `T7`, guests 2 → the phone orders → checkout `T7` → the phone reloads and sees no previous items. Untick the switch (off for the demo) unless the owner wants it on.
- [ ] **Step 8: Two iPads.** With `/pos` open on a second device, every checkout, void bill, move and merge on the first shows on the second within 2 s.
- [ ] **Step 9: Record.** Ledger line with the date, receipt photos, the [CONFIRM] answers learned from the Feedme receipts, timings and anything that failed; failures become fix tasks before the final review.

---

## Execution notes for the controller

- Tasks 1–4 are SQL only (local grep checks); they land on dev together in Task 5 Step 6. Task 3 is the one task that touches both SQL and TypeScript (the capability rule). Tasks 6–12 each end with `npx tsc -b` and the relevant `vitest` run; Tasks 9–12 also have a browser check on dev. Task 13 needs the printer and the owner.
- Every step that reads or writes craft-os-dev (Task 5 Step 6, Task 9 Step 5, Task 10 Step 6, Task 11 Step 7, Task 12 Step 8, Task 13) is the controller's; implementers stop at `tsc` / `vitest` / commit.
- Approval checks of Task 10 run in Task 11 Step 7, once a PIN can be set from the POS (a PIN cannot be set from the SQL editor: `set_my_pos_pin` needs a signed-in staff JWT).
- When this sub-plan closes, the merge prerequisite grows again: on prod, in order, `migration-2026-10-24-pos-checkout.sql`, `-checkout-fn.sql`, `-bill-actions-fn.sql` (after Sub-plan 1 and 2's migrations), before the first deploy from main that carries checkout. The seeds (2026-10-23 and 2026-10-24) and both verify scripts are dev-only. On prod each branch then needs, from POS settings: receipt header and receipt printer, service-charge rules, payment methods, reasons, and approvers' PINs.
- Minor findings carried over from Sub-plan 2's ledger (agent route keying across branches, print RPCs without `search_path`, QR tokens never rotate) stay deferred; the final whole-branch review of this sub-plan triages them with its own.
