# POS · Sub-plan 4a — Shifts, Pay in / Pay out and the Z report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A branch runs on **one shift a day**. With no shift open the POS top bar shows **Open shift**; the cashier enters the **Opening float** (prefilled with the last shift's) and the bar then reads "Shift open · since 09:02" (amber "This shift was opened yesterday — close it" after 20 hours). **No money moves without an open shift**: checkout, refund, Pay in and Pay out are refused with "Open the shift first", while ordering (counter and QR) and kitchen tickets keep working. **Pay in / Pay out** is one sheet (kind, amount, reason); a pay out needs a supervisor's PIN in the existing approval dialog. **Close shift** warns about bills still open, asks for the counted cash **blind** (the expected amount is never shown before the count), and closes at once when the count is within the branch's **Cash variance limit** (default RM 5.00); above it the sheet shows expected and difference and asks for a reason and a supervisor's PIN. A new count may correct the figure (the first count is kept beside the final one), but once the first count was above the limit the supervisor still approves; if the expected cash moves while the supervisor comes over, the sheet shows the new figures before any PIN is tried. At close the server freezes a **Z report** (Feedme's "Close up" without discount, delivery and member sections), stores it and queues it on the receipt printer (none → "Not printed — no receipt printer set"). A **Shifts** drawer (Approve POS voids & refunds) lists the last 30 closed shifts and opens each frozen report with **Reprint**. The limit is set on POS settings → **Shifts**.

**Architecture:** Two migrations. `supabase/migration-2026-10-24-pos-shifts.sql` adds `pos_shifts` (one open row per branch, a trigger that refuses any change to a closed shift and any delete), `pos_cash_moves` (client-generated ids), `bills.shift_id`, `payments.shift_id`, `refunds.shift_id`, `refunds.kind`, `branch_pos_settings.cash_variance_limit_sen` (default 500). Both new tables have RLS on, **no policy and no table privilege**: every read and write goes through the functions. `supabase/migration-2026-10-24-pos-shifts-fn.sql` adds `pos_current_shift`, `open_shift`, `record_cash_move`, `close_shift`, `pos_shift_list`, `pos_shift_zreport`, `reprint_zreport`, `save_shift_settings` and the internal `pos_shift_expected_cash`, `pos_shift_report` (the Z report builder) and `pos_queue_zreport`, and re-creates `checkout_bill` (from `migration-2026-10-24-pos-checkout-fn.sql`) and `refund_bill` (the **last** definition in `migration-2026-10-24-pos-checkout-fixes.sql`) with only the lines marked `4a` added: both take the open shift `FOR SHARE` and stamp it (checkout_bill on the paid bill too; refund_bill also snapshots the payment's `kind`); `close_shift` takes the shift `FOR UPDATE`, so a close waits for a checkout in flight and then counts it. No other function is re-created (checked: `checkout_bill` is defined only in `checkout-fn`; `refund_bill` in `bill-actions-fn` and twice in `checkout-fixes`; catalogs-fn, menu-editor-fn and slots-photos-fn re-create neither). On the client the Z report is a new print payload kind `zreport` rendered by `renderJobLines` (both print hosts — the iPad page and the Node agent — print it with no other change; `print_jobs.kind` stays `receipt`, as the refund slip does). The rules live in a pure `shift.ts` with Vitest tests; the RPC wrappers in `shiftApi.ts`; the sheets in `src/features/pos/shift/`; `PosPage` gains one `<ShiftBar>` line and `PosSettingsPage` one `<ShiftSettingsSection>` line.

**Tech Stack:** React 19 + Vite 6 + TypeScript + Tailwind, Supabase (Postgres RLS, plpgsql `security definer` RPCs, Realtime), Vitest. No ESLint config in the repo; the gates are `npx tsc -b` and `npx vitest run`.

**Spec:** `docs/superpowers/specs/2026-10-24-pos-shifts-design.md` (commit `57f13dd`; its close-shift steps 2, 4–5, data model and testing list revised together with this plan's review fixes I1–I3). Its owner decisions 1–6 are final and bind this plan, with the resolutions below. Builds on Sub-plans 1–3 and menu catalogs M1–M3 (head `57f13dd`).

## Resolutions (decided while planning, 2026-10-24)

The owner asked that open choices follow Feedme's behaviour; the spec already settled the Close up layout that way. The rest, each listed again under Open points:

- **Reads are RPC-only.** `pos_shifts` and `pos_cash_moves` have no RLS policy and no table privilege for `anon` / `authenticated`. The top bar reads `pos_current_shift()`: `{ shift: null | { id, openedAt, openedByName, openingFloatSen }, openBillCount, lastFloatSen, now }` — **never the expected cash** (the count is blind). Other iPads learn about an open or closed shift on the POS page's existing refresh (`refreshKey`: every bill change and the 15-second sweep), not through Realtime.
- **"Above the limit" means `|counted − expected| > limit`**; a difference of exactly RM 5.00 closes without approval. The first `close_shift` call stores `first_count_sen`, whatever the outcome; it is never replaced. **Once the first count is above the limit, the close needs the approver, the PIN and a reason even when a later count is within it** (decided with the controller after review, 2026-10-24, in line with the owner's blind count: after the first answer the cashier has seen the expected cash, so a re-count only corrects the figure; the sheet then says "A supervisor still approves, because the first count was more than RM 5.00 off.").
- **Close answers**: `{ok:true, shiftId, report, printed}`; `{ok:false, needsApproval:true, expectedSen, varianceSen, limitSen}` above the limit (this count or the first) without an approver — **and also with an approver when `p_expected_sen`, the expected cash the sheet showed the approver, is not the expected cash now** (a sale, refund or pay in / out on another iPad meanwhile): the answer comes before the reason and PIN checks, so no PIN try is spent, and the sheet shows the new figures to approve; `{ok:false, error}` for a wrong PIN (no raise: the PIN counter and the first count must persist, as in the existing approval flows). A resend of a close that went through with the same count answers the same report (nothing printed twice); any other call on a closed shift raises "This shift is already closed". A reason is required only above the limit ("Enter a reason for the difference"); within the limit a reason sent is not stored.
- **Pay in / Pay out**: `record_cash_move(p_id, p_kind, p_amount_sen, p_reason, p_approver_id, p_pin)` is idempotent on `p_id`; a resend with another kind or amount answers `{ok:false, error:'This was already recorded as Pay in RM 20.00 — close and reopen to record another'}`. The reason is free text (required, at most 200 characters) — the reason templates stay for voids and refunds. The sheet asks kind, amount and reason; a pay out then opens the approval dialog without its reason field (`askReason={false}`). A pay out's approver is checked by the existing `pos_check_approver` (its words: "Choose who approves", "This person cannot approve voids or refunds").
- **The approval dialog** gets three small, backwards-compatible options: `action: ReasonAction | null` (null = no template: a reason is required, any wording — used for the cash variance), `askReason?: boolean` (default true) and `reasonMissing?: string` (with `action` null, the words for an empty reason — the cash variance passes the server's "Enter a reason for the difference"). It also gains the double-tap ref every new button has.
- **The Z report's numbers.** A bill belongs to the shift it was checked out in: `checkout_bill` stamps `bills.shift_id` (a bill of RM 0.00 — free items only — is paid with no payment rows and still counts in its shift's bills, pax and product sales); `payments.shift_id` stays for the cash maths. *Nett sales* = the sum of those bills' `total_sen` (SST, service charge, takeaway fee and rounding included); *Sales summary* = Gross (`subtotal_sen`) → Takeaway fee → Service charge → SST → Rounding → Nett, each the sum over the shift's bills, so it adds up to Nett; refunds are shown apart (Summary "Total refund", per method, the Refunds list), not taken off Nett (Feedme's Close up does the same). *Average per bill / per pax* round half up to the sen (0 when there are no bills / no pax). *Void bills* = bills of the branch voided between open and close (an empty bill voided by mistake counts too); *Total void* = the value of items voided between open and close (`unit_price_sen × qty`), whether their bill was later paid or voided. *Source* = the shift's bills' orders by source (orders, and the value of their items not voided). *Product sales* = items of the shift's bills not voided, by `name_snapshot`, most sold first (then value, then name).
- **The shift report's time window** is `opened_at .. closed_at` (the close time while it is being built). `closed_at` is `clock_timestamp()` at the close's UPDATE, not the transaction's `now()`: a close that waited for a checkout's lock still sees a void committed during the wait inside its window.
- **On screen** the Z report is shown as the receipt layout's lines at 48 columns (`renderZReportLines`), in the close sheet and the Shifts drawer. The printers print the same content wrapped at their own width (the iPad print host at `TICKET_COLS` = 42, the Node agent at its `.env` `TICKET_COLS`), so line breaks may differ from the screen.
- **The cash variance limit** is saved by a new `save_shift_settings(p_cash_variance_limit_sen)` (`access_settings` holders, own branch, RM 0.00–10000.00), not by re-creating `save_receipt_settings`; it is read from `branch_pos_settings` (already readable by staff). It is its own section, **Shifts**, on `/pos/settings` (CheckoutSettings is already past 250 lines).
- **Open shift is not idempotent by id**: a resend after a lost reply answers "A shift is already open — opened by <you> at HH:MM"; the bar reloads its status when the sheet closes.
- **The checkout verify script** (`migration-2026-10-24-pos-checkout-verify.sql`) opens a shift for its VERIFY branch when `pos_shifts` exists: without it, its checkouts are now refused and the regression run would fail. It still runs unchanged before 4a is applied.

## Global Constraints

- **Dev database first.** The SQL here is applied on `craft-os-dev` (ref `egznnbjmicebbhwasloy`) by the controller from the owner's Chrome tab on the dashboard SQL editor; prod (`yfsoesxzurzjdwstszru`) is a later step the owner decides. Both migrations run on prod **right before** the first main deploy that carries Task 7: once `migration-2026-10-24-pos-shifts-fn.sql` is applied, checkout and refunds are refused until a shift is opened, and only Task 7's top bar can open one. Seeds never run on prod; the verify script is dev-only.
- Every step that reads or writes the dev database is marked **(controller, … ; the implementer does not touch the database)**; implementers run only local commands (`grep`, `diff`, `npx tsc -b`, `npx vitest run`) and commit.
- All UI copy, field names and error messages in English (`english-product-copy` rule); code comments may be Chinese or English, matching the surrounding file.
- **Money is integer sen.** Amounts typed in ringgit go through the existing `parseRinggit` (`src/features/pos/checkout/tender.ts`). Expected cash = opening float + `sum(payments.amount_sen)` of cash payments (change already taken off) − cash refunds + pay in − pay out, each by `shift_id`. Sub-plan 3's money rules and the 22 vectors in `src/features/pos/checkout/billVectors.json` do not change.
- **The server is the truth.** Every check in `shift.ts` repeats the server's rule with the server's words; the server refuses on its own ("Open the shift first", "Enter the counted cash", …).
- **Every new `security definer` function** pins `set search_path = public, pg_temp`, revokes execute from `public, anon` and grants `authenticated`; the internal helpers (`pos_shift_expected_cash`, `pos_shift_report`, `pos_queue_zreport`) are revoked from `authenticated` too. Live staff only: `pos_my_branch()` (`is_active and status = 'active'`, with a branch) for every call; `has_menu_cap('pos_supervise')` for the Shifts drawer and Reprint; `has_menu_cap('access_settings')` for the limit; `pos_check_approver` (live staff of the branch with `pos_supervise`, PIN) for a pay out and a variance above the limit.
- **Nothing is deleted.** A shift is never deleted and never changes after its close (trigger `pos_shifts_guard`; the one write after the close is the frozen report itself, written once by `close_shift`). Cash moves are only inserted.
- **pg-safeupdate:** Supabase's API role refuses a DELETE or UPDATE without WHERE even inside a function (the SQL editor does not, so the verify script cannot catch it). Every DELETE / UPDATE in the new files has a WHERE; `src/features/pos/sqlSafeUpdate.test.ts` scans every `migration-*-pos-*.sql` and Task 1 names the two new files and the new write functions.
- **No unpaged reads that can pass 1,000 rows.** Every new read is an RPC returning one JSON value (the Shifts list is capped at 30).
- **Migrations are idempotent** (`create table if not exists`, `add column if not exists`, guarded constraints, `create index if not exists`, `drop trigger if exists` + `create trigger`, `create or replace function`), and each ends with `notify pgrst, 'reload schema';` before its final `select`.
- **STOP guards:** the schema file stops without the checkout fixes (`pos_refundable_methods`, `pos_caller_branch`) or without M1 (`branch_catalogs`); the function file stops without the schema file, when `refund_bill` is not the original-route version of the checkout fixes, or without `pos_check_approver`.
- **Re-run hazards.** (1) Re-running `migration-2026-10-24-pos-checkout-fixes.sql` or `migration-2026-10-24-pos-bill-actions-fn.sql` brings back a `refund_bill` without the shift check and stamp; re-running `migration-2026-10-24-pos-checkout-fn.sql` is already stopped by its own M1 guard, but would bring back `checkout_bill` without them. Re-run `migration-2026-10-24-pos-shifts-fn.sql` afterwards: Task 1 says so in the headers of bill-actions-fn and checkout-fixes (checkout-fn's header says it cannot be re-run after M1 and names the canonical file), and the shifts verify's A section fails until then. (2) Re-running either 4a file is harmless.
- **Staff fixtures in the verify script** are created after `request.jwt.claims` is set to the dev owner `76cbcf9f-905e-450d-9f5e-1c9e72a9373d`, inserted as `staff` and promoted by the owner (the staff authority guard).
- **UI lessons from M1/M2, applied to every new sheet and section:** each action shows its outcome next to the control that made it; every write button is disabled while it runs and a ref refuses a second tap in the same render; a load that fails locks the writes and offers **Try again** (the top bar offers nothing that moves money while the shift status is unknown); every load keyed by a selection drops a stale reply (a sequence ref); every input has a visible label or an `aria-label`; no `.ts` / `.tsx` file this plan creates or rewrites passes ~250 lines (the SQL files are longer, as in Sub-plans 1–3).
- `tsconfig` has `noUnusedLocals` / `noUnusedParameters`: remove an import the moment it is no longer used.
- Every commit ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work in the worktree `/Users/USER/Desktop/Craft_OS/.claude/worktrees/pos-demo`, branch `feature/pos-demo`. Several sessions share the stash stack: never use a bare `git stash`. Every replacement below quotes its old text — if one does not match, another session changed the file since `57f13dd`: read it and apply the same change to what is there.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migration-2026-10-24-pos-shifts.sql` | `pos_shifts`, its guard trigger, `pos_cash_moves`, the shift stamp and kind columns, the variance limit, RLS (Task 1) |
| `supabase/migration-2026-10-24-pos-shifts-fn.sql` | Every 4a function; canonical `checkout_bill` and `refund_bill` (Task 1) |
| `supabase/migration-2026-10-24-pos-checkout-fn.sql`, `-bill-actions-fn.sql`, `-checkout-fixes.sql` | Header comments only: the shifts function file is canonical — re-run it after them (Task 1) |
| `src/features/pos/sqlSafeUpdate.test.ts` | Names the two new files and their write functions in the pg-safeupdate scan (Task 1) |
| `supabase/migration-2026-10-24-pos-shifts-verify.sql` | Self-check, rolled back (Task 2) |
| `supabase/migration-2026-10-24-pos-checkout-verify.sql` | Opens a shift for its VERIFY branch once shifts exist (Task 2) |
| `src/features/pos/print/zreport.ts` (+test), `receipt.ts`, `printJob.ts` | The Z report payload and layout; three layout helpers exported; the `zreport` kind for both print hosts (Task 3) |
| `src/features/pos/shift/shift.ts` (+test), `shiftApi.ts` | Pure shift rules and reply parsing; the RPC wrappers (Task 4) |
| `src/features/pos/checkout/ApprovalDialog.tsx`, `shift/OpenShiftSheet.tsx`, `shift/CashMoveSheet.tsx` | The dialog's two options; Open shift; Pay in / Pay out (Task 5) |
| `src/features/pos/shift/ZReportView.tsx`, `CloseShiftSheet.tsx`, `ShiftsDrawer.tsx` | The on-screen report; Close shift; past shifts with Reprint (Task 6) |
| `src/features/pos/shift/ShiftBar.tsx`, `src/features/pos/order/PosPage.tsx` | The shift part of the POS top bar (Task 7) |
| `src/features/pos/shift/ShiftSettingsSection.tsx`, `src/features/pos/order/PosSettingsPage.tsx` | POS settings → Shifts (Task 8) |

`checkout_bill` and `refund_bill` change only by their `4a` lines; `CheckoutSheet`, `TodayBillsDrawer`, `BillPanel`, `CheckoutSettings`, every ordering function, every earlier RLS policy and the print hosts' code do not change (a refused checkout or refund already shows the server's words in its sheet).

**Test counts** (checked while planning on a scratch copy of the worktree at `57f13dd`, by replaying this document task by task): baseline 98 files / 852 tests. After Task 1: 98 / 855. Task 2: 98 / 855. Task 3: 99 / 860. Task 4: 100 / 874. Tasks 5–8: 100 / 874. `npx tsc -b` prints nothing after every task.

---

### Task 1: Shifts schema and functions (SQL), the re-run notes, the pg-safeupdate scan

**Files:**
- Create: `supabase/migration-2026-10-24-pos-shifts.sql`, `supabase/migration-2026-10-24-pos-shifts-fn.sql`
- Modify: `src/features/pos/sqlSafeUpdate.test.ts`; header comments only in `supabase/migration-2026-10-24-pos-checkout-fn.sql`, `supabase/migration-2026-10-24-pos-bill-actions-fn.sql`, `supabase/migration-2026-10-24-pos-checkout-fixes.sql`

**Interfaces:**
- Consumes: `pos_my_branch()`, `pos_bill_totals`, `pos_queue_receipt`, `pos_checkout_result` (checkout-fn); `pos_check_approver`, `pos_check_reason`, `pos_refund_slip_payload` (bill-actions-fn); `has_menu_cap` (catalogs, canonical); `pos_refundable_methods`, `pos_caller_branch` (checkout-fixes); tables `bills`, `orders`, `order_items`, `payments`, `refunds`, `print_jobs`, `branch_pos_settings`, `branches`, `staff`.
- Produces (later tasks call these exact names and shapes; JSON keys camelCase; times ISO UTC strings `YYYY-MM-DDTHH:MM:SS.mmmZ`):
  - `pos_current_shift() → { shift: null | { id, openedAt, openedByName, openingFloatSen }, openBillCount, lastFloatSen: int|null, now }`
  - `open_shift(p_float_sen integer) → pos_current_shift()`
  - `record_cash_move(p_id uuid, p_kind text 'pay_in'|'pay_out', p_amount_sen integer, p_reason text, p_approver_id uuid, p_pin text) → { ok: true, id, kind, amountSen } | { ok: false, error }`
  - `close_shift(p_shift_id uuid, p_counted_sen integer, p_reason text, p_approver_id uuid, p_pin text, p_expected_sen integer) → { ok: true, shiftId, report: ZReport, printed } | { ok: false, needsApproval: true, expectedSen, varianceSen, limitSen } | { ok: false, error }` — `p_expected_sen` is null on a count without approval, and the `expectedSen` the approver was shown on an approval; needs approval when this count or the first count is above the limit.
  - `bills.shift_id` — set by `checkout_bill` when the bill is paid; `pos_shift_report` takes a shift's bills by it.
  - `pos_shift_list() → [{ id, openedAt, closedAt, openedBy, closedBy, nettSen, varianceSen }]` (last 30 closed, newest first), `pos_shift_zreport(p_shift_id uuid) → ZReport`, `reprint_zreport(p_shift_id uuid) → void`, `save_shift_settings(p_cash_variance_limit_sen integer) → void`
  - `ZReport` = `{ branch, openedAt, openedBy, closedAt, closedBy, summary: { billCount, pax, nettSen, avgPerBillSen, avgPerPaxSen, voidBillCount, voidSen, refundSen }, sales: { grossSen, takeawayFeeSen, serviceChargeSen, sstSen, roundingSen, nettSen }, payments: [{ name, kind, count, amountSen, refundCount, refundSen, netSen }], orderTypes: [{ orderType, bills, nettSen }] (dine_in, takeaway), sources: [{ source, orders, itemSen }] (counter, qr), cash: { openingFloatSen, cashSalesSen, cashRefundSen, moves: [{ kind, amountSen, reason, by, approvedBy, at }], payInSen, payOutSen, expectedSen, firstCountSen, countedSen, varianceSen, varianceReason, varianceApprovedBy }, voids: { items: [{ at, billNo, name, qty, valueSen, reason, by, approvedBy }], bills: [{ at, billNo, reason, by, approvedBy }] }, refunds: [{ at, billNo, amountSen, method, reason, approvedBy }], products: [{ name, qty, valueSen }] }` — Task 3's `ZReport` type is exactly this.
  - Print job: `print_jobs(kind 'receipt', route = branch_pos_settings.receipt_route, payload { kind: 'zreport', route, reprint, report })`.
  - Refusal words (shown as they are): `Open the shift first`; `Enter the opening float (RM 0.00 to RM 100000.00)`; `A shift is already open — opened by <name> at HH:MM`; `Cash move id is missing`; `This cash move id belongs to another branch`; `Choose Pay in or Pay out`; `Enter the amount (RM 0.01 to RM 100000.00)`; `Enter a reason`; `Reason is too long`; `Enter the counted cash (RM 0.00 to RM 100000.00)`; `Shift not found`; `This shift is already closed`; `Enter a reason for the difference`; `Only a supervisor can see past shifts`; `Only a supervisor can reprint a Z report`; `No receipt printer is set — choose one in POS settings`; `Only a manager can change the shift settings`; `Enter a cash variance limit between RM 0.00 and RM 10000.00`; `A closed shift never changes`; `A shift is never deleted`; plus the existing approver words (`Choose who approves`, `This person cannot approve voids or refunds`, `Wrong PIN — n tries left`, …).

- [ ] **Step 1: Make the pg-safeupdate scan name the new files.** In `src/features/pos/sqlSafeUpdate.test.ts` make exactly these replacements (each old text occurs once, in this order):

1. Replace

```ts
      'migration-2026-10-24-pos-slots-photos-fn.sql',
    ]))
```

   with

```ts
      'migration-2026-10-24-pos-slots-photos-fn.sql',
      'migration-2026-10-24-pos-shifts.sql',
      'migration-2026-10-24-pos-shifts-fn.sql',
    ]))
```

2. Replace

```ts
      'menu_set_product_image', 'pos_insert_order', 'qr_menu',
    ]))
  })
```

   with

```ts
      'menu_set_product_image', 'pos_insert_order', 'qr_menu',
    ]))
  })

  it('scans every write function of shifts (Sub-plan 4a)', () => {
    const sql = readFileSync(new URL('migration-2026-10-24-pos-shifts-fn.sql', SUPABASE), 'utf8')
    const names = functionBodies(sql).map((b) => b.name)
    expect(names).toEqual(expect.arrayContaining([
      'open_shift', 'record_cash_move', 'close_shift', 'pos_queue_zreport', 'reprint_zreport', 'save_shift_settings',
      'checkout_bill', 'refund_bill',
    ]))
  })
```


- [ ] **Step 2: Run it to verify it fails.** Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts` — Expected: FAIL, `Tests  2 failed | 20 passed (22)` (`reads the POS function migrations` misses the two files; the new test cannot read the function file: `ENOENT`).

- [ ] **Step 3: Say in the three older files' headers that the shifts function file is canonical** — re-run it after bill-actions-fn or checkout-fixes; checkout-fn cannot be re-run after M1 at all (comments only; the function bodies Step 6 compares do not move). Make exactly these replacements (each old text occurs once):

   In `supabase/migration-2026-10-24-pos-checkout-fn.sql`:

1. Replace

```sql
-- Totals (pos_compute_bill) are mirrored by computeBill in
-- src/features/pos/checkout/bill.ts; both are tested against the same vectors.
```

   with

```sql
-- Totals (pos_compute_bill) are mirrored by computeBill in
-- src/features/pos/checkout/bill.ts; both are tested against the same vectors.
-- Sub-plan 4a: this file cannot be re-run after M1 (see the STOP guard); checkout_bill is
-- canonical in migration-2026-10-24-pos-shifts-fn.sql (the open shift, stamped on each
-- payment and on the bill).
```


   In `supabase/migration-2026-10-24-pos-bill-actions-fn.sql`:

1. Replace

```sql
-- {"ok": true, ...} when done. Every other refusal is a raised exception.
```

   with

```sql
-- {"ok": true, ...} when done. Every other refusal is a raised exception.
-- refund_bill here is an old body: migration-2026-10-24-pos-checkout-fixes.sql and then
-- migration-2026-10-24-pos-shifts-fn.sql re-create it — re-run both after this file.
```


   In `supabase/migration-2026-10-24-pos-checkout-fixes.sql`:

1. Replace

```sql
-- puts back the older bodies — re-run this file afterwards.
```

   with

```sql
-- puts back the older bodies — re-run this file afterwards.
-- Sub-plan 4a: refund_bill is canonical in migration-2026-10-24-pos-shifts-fn.sql now
-- (the open shift, shift_id and kind on each refund). After re-running THIS file,
-- re-run migration-2026-10-24-pos-shifts-fn.sql too.
```


- [ ] **Step 4: Write the schema migration.** Create `supabase/migration-2026-10-24-pos-shifts.sql`:

```sql
-- ============================================================================
-- Craft OS — POS Sub-plan 4a schema: shifts, Pay in / Pay out, the Z report (2026-10-24).
-- Run on craft-os-dev after every earlier POS migration (the checkout fixes and the
-- menu catalogs M1–M3 included). Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-24-pos-shifts.md
-- Design: docs/superpowers/specs/2026-10-24-pos-shifts-design.md
--
-- One shift per branch at a time (several iPads share one cash drawer). Every money
-- row (payment, refund, pay in / pay out) is stamped with the shift that was open
-- when it was written, by the server (checkout_bill, refund_bill, record_cash_move);
-- so is a paid bill (checkout_bill): a bill of RM 0.00 has no payment rows and still
-- belongs to its shift.
-- Old dev rows keep shift_id null and appear in no report.
-- pos_shifts and pos_cash_moves have RLS on and no policy at all: they are read
-- and written only through the functions in migration-2026-10-24-pos-shifts-fn.sql
-- (the top bar never sees the expected cash before the blind count).
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_refundable_methods(uuid)') is null or to_regprocedure('pos_caller_branch()') is null then
    raise exception 'STOP: run migration-2026-10-24-pos-checkout-fixes.sql first (pos_refundable_methods is missing)';
  end if;
  if to_regclass('public.branch_catalogs') is null then
    raise exception 'STOP: run migration-2026-10-24-pos-catalogs.sql first (branch_catalogs is missing)';
  end if;
end $$;

-- ── Shifts: opened with a float, closed with a blind count ──────────────────
create table if not exists pos_shifts (
  id                    uuid primary key default gen_random_uuid(),
  branch_id             uuid not null references branches(id),
  opened_by             uuid not null references staff(id),
  opened_at             timestamptz not null default now(),
  opening_float_sen     integer not null check (opening_float_sen between 0 and 10000000),
  status                text not null default 'open' check (status in ('open', 'closed')),
  first_count_sen       integer check (first_count_sen between 0 and 10000000),     -- the first blind count, kept
  counted_cash_sen      integer check (counted_cash_sen between 0 and 10000000),    -- the count the shift closed with
  expected_cash_sen     integer,
  variance_sen          integer,                                                     -- counted − expected
  variance_reason       text,                                                        -- only when |variance| > the limit
  variance_approved_by  uuid references staff(id),
  closed_by             uuid references staff(id),
  closed_at             timestamptz,
  report                jsonb,                                                       -- the frozen Z report, written once
  report_printed        boolean,                                                     -- was it queued at close
  constraint pos_shifts_closed_complete check (
    status = 'open' or (closed_at is not null and closed_by is not null and counted_cash_sen is not null
                        and expected_cash_sen is not null and variance_sen is not null))
);
create unique index if not exists pos_shifts_one_open on pos_shifts(branch_id) where status = 'open';
create index if not exists pos_shifts_branch_closed_idx on pos_shifts(branch_id, closed_at desc) where status = 'closed';

-- A closed shift never changes. The one write allowed after the close is the frozen
-- report itself (close_shift writes it once, right after closing). Nothing is deleted.
create or replace function pos_shifts_guard() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'A shift is never deleted';
  end if;
  if old.status = 'closed'
     and not (old.report is null and new.report is not null
              and (to_jsonb(new) - 'report' - 'report_printed') = (to_jsonb(old) - 'report' - 'report_printed')) then
    raise exception 'A closed shift never changes';
  end if;
  return new;
end $$;
drop trigger if exists pos_shifts_guard on pos_shifts;
create trigger pos_shifts_guard before update or delete on pos_shifts
  for each row execute function pos_shifts_guard();

-- ── Pay in / Pay out: cash put into or taken out of the drawer ──────────────
create table if not exists pos_cash_moves (
  id           uuid primary key,                                        -- client-generated: a resend is safe
  shift_id     uuid not null references pos_shifts(id),
  branch_id    uuid not null references branches(id),
  kind         text not null check (kind in ('pay_in', 'pay_out')),
  amount_sen   integer not null check (amount_sen between 1 and 10000000),
  reason       text not null check (length(trim(reason)) between 1 and 200),
  created_by   uuid not null references staff(id),
  approved_by  uuid references staff(id),                               -- pay out only
  created_at   timestamptz not null default now(),
  constraint pos_cash_moves_approval check ((kind = 'pay_out') = (approved_by is not null))
);
create index if not exists pos_cash_moves_shift_idx on pos_cash_moves(shift_id, created_at);

-- ── The shift stamp on every money row and paid bill; the refund's kind; the variance limit ─
alter table bills add column if not exists shift_id uuid;                -- the shift it was checked out in
alter table payments add column if not exists shift_id uuid;
alter table refunds add column if not exists shift_id uuid;
alter table refunds add column if not exists kind text;                -- snapshot of the payment's kind: cash refunds leave the drawer
alter table branch_pos_settings add column if not exists cash_variance_limit_sen integer not null default 500;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bills_shift_id_fkey') then
    alter table bills add constraint bills_shift_id_fkey foreign key (shift_id) references pos_shifts(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payments_shift_id_fkey') then
    alter table payments add constraint payments_shift_id_fkey foreign key (shift_id) references pos_shifts(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'refunds_shift_id_fkey') then
    alter table refunds add constraint refunds_shift_id_fkey foreign key (shift_id) references pos_shifts(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'refunds_kind_check') then
    alter table refunds add constraint refunds_kind_check
      check (kind is null or kind in ('cash', 'card', 'duitnow', 'ewallet', 'other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'branch_pos_settings_cash_variance_limit_sen_check') then
    alter table branch_pos_settings add constraint branch_pos_settings_cash_variance_limit_sen_check
      check (cash_variance_limit_sen between 0 and 1000000);
  end if;
end $$;
create index if not exists bills_shift_idx on bills(shift_id) where shift_id is not null;
create index if not exists payments_shift_idx on payments(shift_id) where shift_id is not null;
create index if not exists refunds_shift_idx on refunds(shift_id) where shift_id is not null;

-- ── RLS: on, no policy, no table privilege — functions only ─────────────────
alter table pos_shifts enable row level security;
alter table pos_cash_moves enable row level security;
revoke all on pos_shifts, pos_cash_moves from public, anon, authenticated;

-- PostgREST picks up the new tables and columns now, not at its next poll
notify pgrst, 'reload schema';

select 'shifts schema applied' as result;
```

- [ ] **Step 5: Write the function migration.** Create `supabase/migration-2026-10-24-pos-shifts-fn.sql`. Its last two functions are `checkout_bill` (the live text of `migration-2026-10-24-pos-checkout-fn.sql`) and `refund_bill` (the **second** `refund_bill` of `migration-2026-10-24-pos-checkout-fixes.sql`, the one after `pos_refundable_methods`), each with only the lines marked `4a` added:

```sql
-- ============================================================================
-- Craft OS — POS Sub-plan 4a functions: shifts, Pay in / Pay out, the Z report (2026-10-24).
-- Run on craft-os-dev after migration-2026-10-24-pos-shifts.sql. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-24-pos-shifts.md
-- Design: docs/superpowers/specs/2026-10-24-pos-shifts-design.md
--
-- New: pos_current_shift, open_shift, record_cash_move, close_shift, pos_shift_list,
-- pos_shift_zreport, reprint_zreport, save_shift_settings, and the internal
-- pos_shift_expected_cash, pos_shift_report (the Z report) and pos_queue_zreport.
-- A wrong approver PIN answers {"ok": false, "error": ...} instead of raising, as in
-- migration-2026-10-24-pos-bill-actions-fn.sql: a raise would roll back the
-- failed-attempt counter (and close_shift's first count).
--
-- Canonical from here on: checkout_bill (the live text of
-- migration-2026-10-24-pos-checkout-fn.sql) and refund_bill (the last definition in
-- migration-2026-10-24-pos-checkout-fixes.sql), each with only the lines marked "4a"
-- added: both take the branch's open shift FOR SHARE ("Open the shift first" when
-- there is none) and stamp it on the payment / refund rows (checkout_bill on the
-- paid bill too); refund_bill also keeps the payment's kind. Re-running
-- checkout-fn, bill-actions-fn or checkout-fixes brings an old body back — re-run
-- this file afterwards (the shifts verify's A section fails until then).
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regclass('public.pos_shifts') is null or to_regclass('public.pos_cash_moves') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'branch_pos_settings'
                       and column_name = 'cash_variance_limit_sen') then
    raise exception 'STOP: run migration-2026-10-24-pos-shifts.sql first (pos_shifts is missing)';
  end if;
  -- nested, not "or": PostgreSQL does not promise left-to-right evaluation, and the
  -- function text can only be read once refund_bill is known to exist
  if to_regprocedure('refund_bill(uuid,uuid,integer,uuid,text,uuid,text)') is null
     or to_regprocedure('pos_refundable_methods(uuid)') is null then
    raise exception 'STOP: run migration-2026-10-24-pos-checkout-fixes.sql first (refund_bill is not the original-route version)';
  elsif pg_get_functiondef(to_regprocedure('refund_bill(uuid,uuid,integer,uuid,text,uuid,text)'))
          not like '%Refunds go back the way the bill was paid%' then
    raise exception 'STOP: run migration-2026-10-24-pos-checkout-fixes.sql first (refund_bill is not the original-route version)';
  end if;
  if to_regprocedure('pos_check_approver(uuid,uuid,text)') is null then
    raise exception 'STOP: run migration-2026-10-24-pos-bill-actions-fn.sql first (pos_check_approver is missing)';
  end if;
end $$;

-- ── The top bar: the branch's open shift, never the expected cash ───────────
-- { shift: null | { id, openedAt, openedByName, openingFloatSen },
--   openBillCount, lastFloatSen (the last closed shift's float, for the Open shift sheet), now }
create or replace function pos_current_shift() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
begin
  return jsonb_build_object(
    'shift', (select jsonb_build_object(
                'id', s.id,
                'openedAt', to_char(s.opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'openedByName', (select st.name from staff st where st.id = s.opened_by),
                'openingFloatSen', s.opening_float_sen)
                from pos_shifts s where s.branch_id = v_branch and s.status = 'open'),
    'openBillCount', (select count(*) from bills b where b.branch_id = v_branch and b.status = 'open'),
    'lastFloatSen', (select s.opening_float_sen from pos_shifts s
                      where s.branch_id = v_branch and s.status = 'closed'
                      order by s.closed_at desc, s.opened_at desc limit 1),
    'now', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end $$;
revoke all on function pos_current_shift() from public, anon;
grant execute on function pos_current_shift() to authenticated;

-- ── Open shift: any live POS staff of the branch ───────────────────────────
create or replace function open_shift(p_float_sen integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
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
      insert into pos_shifts(branch_id, opened_by, opening_float_sen) values (v_branch, auth.uid(), p_float_sen);
      return pos_current_shift();
    exception when unique_violation then                                  -- another iPad opened it a moment ago
      select * into v_open from pos_shifts where branch_id = v_branch and status = 'open';
    end;
  end if;
  raise exception 'A shift is already open — opened by % at %',
    coalesce((select name from staff where id = v_open.opened_by), 'someone'),
    to_char(v_open.opened_at at time zone 'Asia/Kuala_Lumpur', 'HH24:MI');
end $$;
revoke all on function open_shift(integer) from public, anon;
grant execute on function open_shift(integer) to authenticated;

-- ── Pay in / Pay out, idempotent on p_id. Pay out needs an approver + PIN ───
-- Answers { ok: true, id, kind, amountSen } or { ok: false, error } (a wrong PIN, or a
-- resend of the same id with another kind or amount). Every other refusal raises.
create or replace function record_cash_move(p_id uuid, p_kind text, p_amount_sen integer, p_reason text,
                                            p_approver_id uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
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
  values (p_id, v_shift, v_branch, p_kind, p_amount_sen, v_reason, auth.uid(),
          case when p_kind = 'pay_out' then p_approver_id end)
  on conflict (id) do nothing;
  if not found then                                                       -- the same id won meanwhile
    return record_cash_move(p_id, p_kind, p_amount_sen, p_reason, p_approver_id, p_pin);
  end if;
  return jsonb_build_object('ok', true, 'id', p_id, 'kind', p_kind, 'amountSen', p_amount_sen);
end $$;
revoke all on function record_cash_move(uuid, text, integer, text, uuid, text) from public, anon;
grant execute on function record_cash_move(uuid, text, integer, text, uuid, text) to authenticated;

-- ── Expected cash = float + cash payments − cash refunds + pay in − pay out ──
-- Cash payments count amount_sen (the change is already taken off). Internal.
create or replace function pos_shift_expected_cash(p_shift_id uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select (s.opening_float_sen
          + coalesce((select sum(p.amount_sen) from payments p where p.shift_id = s.id and p.kind = 'cash'), 0)
          - coalesce((select sum(r.amount_sen) from refunds r where r.shift_id = s.id and r.kind = 'cash'), 0)
          + coalesce((select sum(m.amount_sen) from pos_cash_moves m where m.shift_id = s.id and m.kind = 'pay_in'), 0)
          - coalesce((select sum(m.amount_sen) from pos_cash_moves m where m.shift_id = s.id and m.kind = 'pay_out'), 0)
         )::integer
    from pos_shifts s where s.id = p_shift_id
$$;
revoke all on function pos_shift_expected_cash(uuid) from public, anon, authenticated;

-- ── The Z report (Feedme "Close up", without discount, delivery and member) ─
-- Exactly ZReport in src/features/pos/print/zreport.ts. A bill belongs to the shift it
-- was checked out in (bills.shift_id: a bill of RM 0.00 has no payment rows); voids (no
-- money moves) by their time, opened_at..closed_at (now() while the shift is still open).
-- Money in integer sen, times ISO UTC. Internal.
create or replace function pos_shift_report(p_shift_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with s as (
    select sh.*, coalesce(sh.closed_at, now()) as until from pos_shifts sh where sh.id = p_shift_id
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
  vi as (                                                                -- items voided during the shift
    select oi.*, b.bill_no from order_items oi join bills b on b.id = oi.bill_id, s
     where b.branch_id = s.branch_id and oi.voided_at >= s.opened_at and oi.voided_at <= s.until
  ),
  vb as (                                                                -- bills voided during the shift
    select b.* from bills b, s
     where b.branch_id = s.branch_id and b.status = 'voided' and b.closed_at >= s.opened_at and b.closed_at <= s.until
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

-- queue a Z report on the branch's receipt route (print_jobs.kind 'receipt', as the
-- refund slip); false = no receipt printer set. Internal.
create or replace function pos_queue_zreport(p_branch_id uuid, p_report jsonb, p_reprint boolean) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_route text;
begin
  select s.receipt_route into v_route from branch_pos_settings s where s.branch_id = p_branch_id;
  if v_route is null then return false; end if;
  insert into print_jobs(branch_id, route, kind, payload)
  values (p_branch_id, v_route, 'receipt',
          jsonb_build_object('kind', 'zreport', 'route', v_route, 'reprint', p_reprint, 'report', p_report));
  return true;
end $$;
revoke all on function pos_queue_zreport(uuid, jsonb, boolean) from public, anon, authenticated;

-- ── Close shift: blind count; above the limit an approver + PIN + reason ────
-- Answers { ok: true, shiftId, report, printed }, or { ok: false, needsApproval: true,
-- expectedSen, varianceSen, limitSen } (above the limit with no approver yet, or with an
-- approver who was shown another expected cash), or { ok: false, error } (a wrong PIN).
-- The first count is stored on the first call and never replaced. Once the first count
-- was above the limit, the close needs the approver, the PIN and a reason even if a new
-- count is within it (the cashier has seen the expected cash by then). p_expected_sen is
-- the expected cash the approver was shown: when it changed meanwhile (a sale, refund or
-- pay in / out on another iPad) the answer is "needs approval" again with the new
-- figures, before the PIN is tried. A resend of a close that went through (same count)
-- gets the same answer; any other call on a closed shift is refused.
create or replace function close_shift(p_shift_id uuid, p_counted_sen integer, p_reason text,
                                       p_approver_id uuid, p_pin text, p_expected_sen integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
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
  if v_shift.first_count_sen is null then
    update pos_shifts set first_count_sen = p_counted_sen where id = v_shift.id;
  end if;
  v_expected := pos_shift_expected_cash(v_shift.id);
  v_var      := p_counted_sen - v_expected;
  v_limit    := coalesce((select s.cash_variance_limit_sen from branch_pos_settings s where s.branch_id = v_branch), 500);
  -- v_shift was read before the first count was stored: on the first call this is the count itself
  v_above    := abs(v_var) > v_limit or abs(coalesce(v_shift.first_count_sen, p_counted_sen) - v_expected) > v_limit;
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
         closed_by = auth.uid(), closed_at = clock_timestamp()   -- not now(): after any wait for the lock
   where id = v_shift.id;
  v_report  := pos_shift_report(v_shift.id);
  v_printed := pos_queue_zreport(v_branch, v_report, false);
  update pos_shifts set report = v_report, report_printed = v_printed where id = v_shift.id;
  return jsonb_build_object('ok', true, 'shiftId', v_shift.id, 'report', v_report, 'printed', v_printed);
end $$;
revoke all on function close_shift(uuid, integer, text, uuid, text, integer) from public, anon;
grant execute on function close_shift(uuid, integer, text, uuid, text, integer) to authenticated;

-- ── Past shifts (Approve POS voids & refunds): the last 30 closed, newest first ─
create or replace function pos_shift_list() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
begin
  if not has_menu_cap('pos_supervise') then raise exception 'Only a supervisor can see past shifts'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', x.id,
             'openedAt', to_char(x.opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'closedAt', to_char(x.closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'openedBy', (select st.name from staff st where st.id = x.opened_by),
             'closedBy', (select st.name from staff st where st.id = x.closed_by),
             'nettSen', coalesce((x.report->'summary'->>'nettSen')::integer, 0),
             'varianceSen', x.variance_sen)
           order by x.closed_at desc, x.opened_at desc)
      from (select * from pos_shifts s where s.branch_id = v_branch and s.status = 'closed'
             order by s.closed_at desc, s.opened_at desc limit 30) x), '[]'::jsonb);
end $$;
revoke all on function pos_shift_list() from public, anon;
grant execute on function pos_shift_list() to authenticated;

-- the frozen Z report of one closed shift of the caller's branch
create or replace function pos_shift_zreport(p_shift_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_report jsonb;
begin
  if not has_menu_cap('pos_supervise') then raise exception 'Only a supervisor can see past shifts'; end if;
  select s.report into v_report from pos_shifts s
   where s.id = p_shift_id and s.branch_id = v_branch and s.status = 'closed';
  if v_report is null then raise exception 'Shift not found'; end if;
  return v_report;
end $$;
revoke all on function pos_shift_zreport(uuid) from public, anon;
grant execute on function pos_shift_zreport(uuid) to authenticated;

-- the same Z report again, marked REPRINT
create or replace function reprint_zreport(p_shift_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_report jsonb;
begin
  if not has_menu_cap('pos_supervise') then raise exception 'Only a supervisor can reprint a Z report'; end if;
  select s.report into v_report from pos_shifts s
   where s.id = p_shift_id and s.branch_id = v_branch and s.status = 'closed';
  if v_report is null then raise exception 'Shift not found'; end if;
  if not pos_queue_zreport(v_branch, v_report, true) then
    raise exception 'No receipt printer is set — choose one in POS settings';
  end if;
end $$;
revoke all on function reprint_zreport(uuid) from public, anon;
grant execute on function reprint_zreport(uuid) to authenticated;

-- ── POS settings → Shifts: the branch's cash variance limit (access_settings) ─
create or replace function save_shift_settings(p_cash_variance_limit_sen integer) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
begin
  if not has_menu_cap('access_settings') then raise exception 'Only a manager can change the shift settings'; end if;
  if p_cash_variance_limit_sen is null or p_cash_variance_limit_sen < 0 or p_cash_variance_limit_sen > 1000000 then
    raise exception 'Enter a cash variance limit between RM 0.00 and RM 10000.00';
  end if;
  insert into branch_pos_settings(branch_id) values (v_branch) on conflict (branch_id) do nothing;
  update branch_pos_settings
     set cash_variance_limit_sen = p_cash_variance_limit_sen, updated_at = now()
   where branch_id = v_branch;
end $$;
revoke all on function save_shift_settings(integer) from public, anon;
grant execute on function save_shift_settings(integer) to authenticated;

-- ── Checkout, re-created: the live text of migration-2026-10-24-pos-checkout-fn.sql with
--    only the lines marked "4a" added (the open shift, FOR SHARE, stamped on each payment and the bill) ─
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
    return pos_checkout_result(v_bill.id);
  end if;

  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  if v_bill.checkout_id is not distinct from p_checkout_id then  -- won by the same checkout while we waited
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

-- ── Refund, re-created: the last refund_bill of migration-2026-10-24-pos-checkout-fixes.sql
--    with only the lines marked "4a" added (the open shift NOW, FOR SHARE; shift_id and kind) ─
create or replace function refund_bill(p_refund_id uuid, p_bill_id uuid, p_amount_sen integer, p_method_id uuid,
                                       p_reason text, p_approver_id uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
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
  values (p_refund_id, v_bill.id, v_branch, p_amount_sen, p_method_id, v_method_name, v_reason, p_approver_id, auth.uid(),
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
end $$;
revoke all on function refund_bill(uuid, uuid, integer, uuid, text, uuid, text) from public, anon;
grant execute on function refund_bill(uuid, uuid, integer, uuid, text, uuid, text) to authenticated;

-- PostgREST picks up the new functions now, not at its next poll
notify pgrst, 'reload schema';

select 'shifts functions applied' as result;
```

- [ ] **Step 6: Check the re-created functions against their live text.** Run:

```bash
diff <(sed -n '/^create or replace function checkout_bill/,/^grant execute on function checkout_bill/p' supabase/migration-2026-10-24-pos-checkout-fn.sql) \
     <(sed -n '/^create or replace function checkout_bill/,/^grant execute on function checkout_bill/p' supabase/migration-2026-10-24-pos-shifts-fn.sql)
diff <(awk '/^create or replace function refund_bill/{n++} n==2' supabase/migration-2026-10-24-pos-checkout-fixes.sql | sed -n '1,/^grant execute on function refund_bill/p') \
     <(sed -n '/^create or replace function refund_bill/,/^grant execute on function refund_bill/p' supabase/migration-2026-10-24-pos-shifts-fn.sql)
```

Expected: exactly the `4a` lines, nothing else —

```
14a15
>   v_shift     uuid;                                                -- 4a
31a33,36
>   -- 4a: money moves only inside the branch's open shift. FOR SHARE lets checkouts run
>   -- side by side, while close_shift (FOR UPDATE) waits for one in flight and then counts it.
>   select id into v_shift from pos_shifts where branch_id = v_branch and status = 'open' for share;
>   if not found then raise exception 'Open the shift first'; end if;
90c95
<                          change_sen, reference, taken_by, line_no)
---
>                          change_sen, reference, taken_by, line_no, shift_id)            -- 4a: shift_id
94c99
<             auth.uid(), v_n);
---
>             auth.uid(), v_n, v_shift);                                          -- 4a: v_shift
98a104
>          shift_id = v_shift,                                                     -- 4a: the bill's shift
```

```
13a14,15
>   v_kind        text;                                              -- 4a
>   v_shift       uuid;                                              -- 4a
44a47,49
>   -- 4a: a refund belongs to the shift open NOW (a refund of an old bill too); FOR SHARE as in checkout_bill
>   select id into v_shift from pos_shifts where branch_id = v_branch and status = 'open' for share;
>   if not found then raise exception 'Open the shift first'; end if;
53c58
<   select p.method_name into v_method_name
---
>   select p.method_name, p.kind into v_method_name, v_kind                 -- 4a: the kind too
70,71c75,78
<   insert into refunds(id, bill_id, branch_id, amount_sen, method_id, method_name, reason, approved_by, created_by)
<   values (p_refund_id, v_bill.id, v_branch, p_amount_sen, p_method_id, v_method_name, v_reason, p_approver_id, auth.uid());
---
>   insert into refunds(id, bill_id, branch_id, amount_sen, method_id, method_name, reason, approved_by, created_by,
>                       shift_id, kind)                                                   -- 4a
>   values (p_refund_id, v_bill.id, v_branch, p_amount_sen, p_method_id, v_method_name, v_reason, p_approver_id, auth.uid(),
>           v_shift, v_kind);                                                             -- 4a
```

If any other line differs, the older file changed since this plan was written: take its current text for the function and add the same `4a` lines again.

- [ ] **Step 7: Run the scan and the gates.** Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts` — Expected: PASS, 24 tests (two more files scanned, one more test). If a statement is listed, add its WHERE — never silence the scan. Run: `grep -c "set search_path = public, pg_temp" supabase/migration-2026-10-24-pos-shifts-fn.sql supabase/migration-2026-10-24-pos-shifts.sql` — Expected: `13` and `1` (every function, and the trigger function). Run: `grep -c "notify pgrst, 'reload schema'" supabase/migration-2026-10-24-pos-shifts.sql supabase/migration-2026-10-24-pos-shifts-fn.sql` — Expected: `1` each. Run: `npx vitest run` — Expected: 98 files, 855 tests pass. Run: `npx tsc -b` — Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add supabase/migration-2026-10-24-pos-shifts.sql supabase/migration-2026-10-24-pos-shifts-fn.sql src/features/pos/sqlSafeUpdate.test.ts supabase/migration-2026-10-24-pos-checkout-fn.sql supabase/migration-2026-10-24-pos-bill-actions-fn.sql supabase/migration-2026-10-24-pos-checkout-fixes.sql
git commit -m "feat(pos-shift): shifts, pay in / pay out and the frozen Z report — schema and functions; checkout and refunds need an open shift

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Verify script, the checkout verify's shift — and applying 4a on craft-os-dev (implementer + controller)

**Files:**
- Create: `supabase/migration-2026-10-24-pos-shifts-verify.sql`
- Modify: `supabase/migration-2026-10-24-pos-checkout-verify.sql` (one fixture block)

**Interfaces:**
- Consumes: Task 1; M1's `place_counter_order` / `place_table_order`; `void_order_item`, `void_bill`, `set_my_pos_pin`, `pos_bill_totals`; the dev test login `76cbcf9f-905e-450d-9f5e-1c9e72a9373d` (owner).
- Produces: on dev, both 4a migrations applied and seven verify scripts printing `VERIFY OK` (menu, ordering, checkout, catalogs, menu editor, slots and photos, shifts).

The script covers every test bullet of the spec, each refusal paired with the success it guards: grants, internal helpers, `search_path`, no policy and no table privilege on the two tables (SELECT, INSERT, UPDATE, DELETE, for `anon` and `authenticated`), one `checkout_bill` / `refund_bill` each **with the shift check** (a re-run of an older file is caught), the lock modes (money `FOR SHARE`, close `FOR UPDATE`), the guard trigger, the one-open index, the 500 default (A); the fixture — a branch with a catalog of two products (a 6 % SST plate with a takeaway fee, a 0 % tea) and a free water (RM 0.00), cash and card, four tables, a supervisor with a PIN, a cashier, a supervisor of another branch, five bills from the counter and QR (B); **no shift: checkout and pay in refused, nothing written; ordering works**; a float above RM 100000.00 refused (C); **open twice refused** with the opener's name and time, a second open row refused by the index, another branch opens its own (D); **stamps on payments, refunds and the paid bills**; voids of an item on an open bill, of an item on a bill later paid and of a whole bill; pay in without approver and its resend; **pay out without the PIN refused** (and by the cashier, and without an approver); an amount above RM 100000.00 refused; a cash and a card refund; **expected cash with float, cash and card payments, change, a cash refund, pay in and pay out** = 145.15 (E); the limit saved by the owner only; **above the limit needs approval**; **a new count of exactly the expected cash still needs it** (the first count was above the limit); **an approval of an expected cash that has changed answers the new figures, with the PIN not tried**; a second count with a wrong PIN leaves the shift open; **first count kept**; the closed row; **report totals equal the bills' totals**; every section of the report; the Z report job on the receipt route (F); **a closed shift never changes** — a resend answers the same, another count is refused, a direct UPDATE or DELETE is refused by the trigger, checkout / refund / pay in refused until the next shift (G); **a refund of a closed shift's bill lands in the new shift**; **a bill of RM 0.00 paid with no payment rows counts in its shift** (bills, products, the report's totals equal the bills'); **within-limit close** with no reason kept; no printer → not printed (H); the Shifts list and report for supervisors only, own branch only, reprint (I). **The race** ("a checkout racing a close lands in the closed shift's report") cannot be run in one SQL session, which never waits for itself: section A pins the lock modes that make it true (a close `FOR UPDATE` waits for every checkout holding the shift `FOR SHARE` and then counts it; a checkout arriving after the close finds no open shift), and G checks the second half.

- [ ] **Step 1: Write the verify script.** Create `supabase/migration-2026-10-24-pos-shifts-verify.sql`:

```sql
-- Self-check for POS Sub-plan 4a (shifts, Pay in / Pay out, the Z report). Run on
-- craft-os-dev after migration-2026-10-24-pos-shifts.sql and -shifts-fn.sql.
-- Everything is rolled back. Success = a result row "VERIFY OK".
-- Every refusal is paired with the success it guards. Inside one transaction now() does
-- not move, so the script sets the first shift's open time and its voids back by hand.
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
  v_sup     uuid := 'eeeeeeee-0000-0000-0000-000000000041';   -- supervisor of VERIFY 4A (approves)
  v_cashier uuid := 'eeeeeeee-0000-0000-0000-000000000042';   -- staff of VERIFY 4A
  v_far     uuid := 'eeeeeeee-0000-0000-0000-000000000043';   -- supervisor of another branch
  v_branch uuid; v_branch2 uuid;
  v_t1 dining_tables; v_t2 dining_tables; v_t3 dining_tables; v_t4 dining_tables;
  v_cat uuid; v_catalog uuid; v_plate uuid; v_plate_v uuid; v_tea uuid; v_tea_v uuid; v_water uuid; v_water_v uuid;
  v_cash uuid; v_card uuid;
  b1 uuid; b2 uuid; b3 uuid; b4 uuid; b5 uuid; b6 uuid; b7 uuid;
  s1 uuid; s2 uuid;
  v_move uuid := 'eeeeeeee-1111-0000-0000-000000000001';
  v_move2 uuid := 'eeeeeeee-1111-0000-0000-000000000002';
  v_res jsonb; v_rep jsonb; v_rep1 jsonb; v_text text; v_id uuid; n integer; r record; v_role text; v_tbl text; v_priv text;
begin
  -- ── A. grants, internal helpers, search_path, RLS, the canonical money functions ──
  for r in select f from unnest(array[
             'pos_current_shift()', 'open_shift(integer)', 'record_cash_move(uuid,text,integer,text,uuid,text)',
             'close_shift(uuid,integer,text,uuid,text,integer)', 'pos_shift_list()', 'pos_shift_zreport(uuid)',
             'reprint_zreport(uuid)', 'save_shift_settings(integer)', 'checkout_bill(uuid,jsonb,uuid)',
             'refund_bill(uuid,uuid,integer,uuid,text,uuid,text)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') then raise exception 'FAIL grants: anon can call %', r.f; end if;
    if not has_function_privilege('authenticated', r.f, 'execute') then raise exception 'FAIL grants: staff cannot call %', r.f; end if;
  end loop;
  for r in select f from unnest(array[
             'pos_shift_expected_cash(uuid)', 'pos_shift_report(uuid)', 'pos_queue_zreport(uuid,jsonb,boolean)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') or has_function_privilege('authenticated', r.f, 'execute') then
      raise exception 'FAIL grants: % must be internal', r.f;
    end if;
  end loop;
  for r in select p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'public' and p.proname = any (array[
              'pos_shifts_guard','pos_current_shift','open_shift','record_cash_move','pos_shift_expected_cash',
              'pos_shift_report','pos_queue_zreport','close_shift','pos_shift_list','pos_shift_zreport',
              'reprint_zreport','save_shift_settings','checkout_bill','refund_bill'])
              and not coalesce(p.proconfig @> array['search_path=public, pg_temp'], false) loop
    raise exception 'FAIL search_path: % does not pin search_path = public, pg_temp', r.proname;
  end loop;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('pos_shifts', 'pos_cash_moves'))
     or exists (select 1 from pg_class where relname in ('pos_shifts', 'pos_cash_moves')
                 and relnamespace = 'public'::regnamespace and not relrowsecurity) then
    raise exception 'FAIL rls: pos_shifts and pos_cash_moves must be read and written only through the functions';
  end if;
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_tbl in array array['pos_shifts', 'pos_cash_moves'] loop
      foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
        if has_table_privilege(v_role, v_tbl, v_priv) then
          raise exception 'FAIL rls: % has % on % (the functions only)', v_role, v_priv, v_tbl;
        end if;
      end loop;
    end loop;
  end loop;
  if (select count(*) from pg_proc where proname = 'checkout_bill') is distinct from 1 or (select count(*) from pg_proc where proname = 'refund_bill') is distinct from 1 then
    raise exception 'FAIL: more than one checkout_bill or refund_bill';
  end if;
  -- re-running checkout-fn, bill-actions-fn or checkout-fixes silently drops the shift check
  if pg_get_functiondef('checkout_bill(uuid,jsonb,uuid)'::regprocedure) not like '%Open the shift first%'
     or pg_get_functiondef('refund_bill(uuid,uuid,integer,uuid,text,uuid,text)'::regprocedure) not like '%Open the shift first%'
     or pg_get_functiondef('refund_bill(uuid,uuid,integer,uuid,text,uuid,text)'::regprocedure) not like '%Refunds go back the way the bill was paid%' then
    raise exception 'FAIL: checkout_bill or refund_bill has no shift check — re-run migration-2026-10-24-pos-shifts-fn.sql';
  end if;
  -- the race rule: money functions hold the open shift FOR SHARE, close_shift takes it FOR UPDATE,
  -- so a close waits for a checkout in flight and then counts it (one session cannot race itself)
  if pg_get_functiondef('checkout_bill(uuid,jsonb,uuid)'::regprocedure) not like '%status = ''open'' for share%'
     or pg_get_functiondef('refund_bill(uuid,uuid,integer,uuid,text,uuid,text)'::regprocedure) not like '%status = ''open'' for share%'
     or pg_get_functiondef('record_cash_move(uuid,text,integer,text,uuid,text)'::regprocedure) not like '%status = ''open'' for share%'
     or pg_get_functiondef('close_shift(uuid,integer,text,uuid,text,integer)'::regprocedure) not like '%for update%' then
    raise exception 'FAIL race: the shift lock modes changed (money FOR SHARE, close FOR UPDATE)';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'pos_shifts_guard' and tgrelid = 'pos_shifts'::regclass)
     or to_regclass('public.pos_shifts_one_open') is null then
    raise exception 'FAIL schema: the closed-shift guard or the one-open-shift index is missing';
  end if;
  if (select column_default from information_schema.columns
       where table_name = 'branch_pos_settings' and column_name = 'cash_variance_limit_sen') is distinct from '500' then
    raise exception 'FAIL schema: cash_variance_limit_sen must default to 500 (RM 5.00)';
  end if;

  -- ── B. fixture: two branches, a catalog with two products, two methods, staff ──
  update system_role_permissions set permissions = permissions - 'pos_supervise' - 'access_settings' where true;   -- code defaults
  insert into branches(name, address, receipt_title) values ('VERIFY 4A', 'verify', 'Verify 4A Cafe') returning id into v_branch;
  insert into branches(name, address) values ('VERIFY 4A FAR', 'far') returning id into v_branch2;
  insert into dining_tables(branch_id, label) values (v_branch, 'S1') returning * into v_t1;
  insert into dining_tables(branch_id, label) values (v_branch, 'S2') returning * into v_t2;
  insert into dining_tables(branch_id, label) values (v_branch, 'S3') returning * into v_t3;
  insert into dining_tables(branch_id, label) values (v_branch, 'S4') returning * into v_t4;
  insert into print_routes(branch_id, name, kind, address) values (v_branch, 'Bar', 'agent', '127.0.0.1:9100');
  insert into branch_pos_settings(branch_id, receipt_route) values (v_branch, 'Bar');
  insert into menu_categories(name, sort_order) values ('VERIFY 4A FOOD', 900) returning id into v_cat;
  insert into menu_products(name, category_id, sst_rate_bp, takeaway_fee_sen) values ('Verify 4A Plate', v_cat, 600, 100) returning id into v_plate;
  insert into menu_products(name, category_id, sst_rate_bp) values ('Verify 4A Tea', v_cat, 0) returning id into v_tea;
  insert into menu_products(name, category_id, sst_rate_bp) values ('Verify 4A Water', v_cat, 0) returning id into v_water;   -- free
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_plate, '', 'Regular', 2000) returning id into v_plate_v;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_tea, '', 'Regular', 550) returning id into v_tea_v;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_water, '', 'Regular', 0) returning id into v_water_v;
  insert into menu_catalogs(name, sort_order) values ('VERIFY 4A CATALOG', 900) returning id into v_catalog;
  insert into catalog_products(catalog_id, product_id, availability) values
    (v_catalog, v_plate, 'all'), (v_catalog, v_tea, 'all'), (v_catalog, v_water, 'all');
  insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values
    (v_catalog, v_plate_v, 2000), (v_catalog, v_tea_v, 550), (v_catalog, v_water_v, 0);
  insert into branch_catalogs(branch_id, role, catalog_id) values
    (v_branch, 'dine_in', v_catalog), (v_branch, 'takeaway', v_catalog), (v_branch, 'qr', v_catalog);
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_branch, 'V Cash', 'cash', 1) returning id into v_cash;
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_branch, 'V Card', 'card', 2) returning id into v_card;
  update staff set branch_id = v_branch where id = v_owner;
  -- staff are inserted as 'staff' and promoted by the owner (the staff guard refuses anything else)
  perform pg_temp.act(v_owner);
  insert into auth.users (id) values (v_sup), (v_cashier), (v_far);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_sup,     'Verify 4A Supervisor', 'trainee', true, current_date, 'staff', v_branch),
    (v_cashier, 'Verify 4A Cashier',    'trainee', true, current_date, 'staff', v_branch),
    (v_far,     'Verify 4A Far',        'trainee', true, current_date, 'staff', v_branch2);
  update staff set system_role = 'supervisor' where id in (v_sup, v_far);
  perform pg_temp.act(v_sup);
  if not (set_my_pos_pin('2468', null)->>'ok')::boolean then raise exception 'FAIL fixture: supervisor PIN'; end if;
  perform pg_temp.act(v_cashier);
  v_id := place_counter_order(v_t1.id, 'dine_in', 2,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_v, 'qty', 2)), gen_random_uuid());
  b1 := (select bill_id from orders where id = v_id);
  v_id := place_counter_order(null, 'takeaway', null, jsonb_build_array(
    jsonb_build_object('productId', v_plate, 'variantId', v_plate_v), jsonb_build_object('productId', v_tea, 'variantId', v_tea_v)),
    gen_random_uuid());
  b2 := (select bill_id from orders where id = v_id);
  v_id := place_table_order(v_t2.qr_token, 2,
    jsonb_build_array(jsonb_build_object('productId', v_tea, 'variantId', v_tea_v)), gen_random_uuid());
  b3 := (select bill_id from orders where id = v_id);
  v_id := place_counter_order(v_t3.id, 'dine_in', 1,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_v)), gen_random_uuid());
  b4 := (select bill_id from orders where id = v_id);
  v_id := place_counter_order(null, 'takeaway', null,
    jsonb_build_array(jsonb_build_object('productId', v_tea, 'variantId', v_tea_v)), gen_random_uuid());
  b5 := (select bill_id from orders where id = v_id);
  if (pos_bill_totals(b1)->>'totalSen')::int is distinct from 4240 or (pos_bill_totals(b2)->>'totalSen')::int is distinct from 2775
     or (pos_bill_totals(b3)->>'totalSen')::int is distinct from 550 or b4 is null or b5 is null then
    raise exception 'FAIL fixture: totals % % %', pos_bill_totals(b1), pos_bill_totals(b2), pos_bill_totals(b3);
  end if;

  -- ── C. no open shift: no money moves; ordering still works (the bills above) ──
  set local role authenticated;
  v_res := pos_current_shift();
  reset role;
  if v_res->'shift' is distinct from 'null'::jsonb or (v_res->>'openBillCount')::int is distinct from 5 or v_res->'lastFloatSen' is distinct from 'null'::jsonb then
    raise exception 'FAIL C status without a shift: %', v_res;
  end if;
  perform pg_temp.expect_error(format('select checkout_bill(%L, %L::jsonb, %L)', b1,
      jsonb_build_array(jsonb_build_object('methodId', v_cash, 'amountSen', 4240)), gen_random_uuid()),
    'Open the shift first', 'C checkout without a shift');
  perform pg_temp.expect_error(format('select record_cash_move(%L, %L, 1000, %L, null, null)', gen_random_uuid(), 'pay_in', 'Float'),
    'Open the shift first', 'C pay in without a shift');
  if exists (select 1 from payments where bill_id = b1) or (select status from bills where id = b1) is distinct from 'open' then
    raise exception 'FAIL C: a refused checkout wrote something';
  end if;
  perform pg_temp.expect_error('select open_shift(-1)', 'Enter the opening float (RM 0.00 to RM 100000.00)', 'C negative float');
  perform pg_temp.expect_error('select open_shift(null)', 'Enter the opening float (RM 0.00 to RM 100000.00)', 'C no float');
  perform pg_temp.expect_error('select open_shift(10000001)', 'Enter the opening float (RM 0.00 to RM 100000.00)', 'C float above RM 100000');
  perform pg_temp.expect_error(format('select close_shift(%L, 0, null, null, null, null)', gen_random_uuid()), 'Shift not found', 'C close unknown');

  -- ── D. open: one shift per branch; the top bar never sees the expected cash ──
  v_res := open_shift(10000);
  s1 := (v_res->'shift'->>'id')::uuid;
  if s1 is null or v_res->'shift'->>'openedByName' is distinct from 'Verify 4A Cashier' or (v_res->'shift'->>'openingFloatSen')::int is distinct from 10000
     or v_res::text ilike '%expected%' or v_res::text ilike '%count%Sen%' then
    raise exception 'FAIL D open: %', v_res;
  end if;
  perform pg_temp.act(v_sup);
  perform pg_temp.expect_error('select open_shift(5000)',
    format('A shift is already open — opened by Verify 4A Cashier at %s', to_char(now() at time zone 'Asia/Kuala_Lumpur', 'HH24:MI')),
    'D open twice');
  begin
    insert into pos_shifts(branch_id, opened_by, opening_float_sen) values (v_branch, v_sup, 0);
    raise exception 'FAIL D: a second open shift was stored';
  exception when unique_violation then null;
  end;
  perform pg_temp.act(v_far);                                            -- another branch opens its own
  if (open_shift(0)->'shift'->>'id')::uuid = s1 then raise exception 'FAIL D: branches share a shift'; end if;
  perform pg_temp.act(v_cashier);
  update pos_shifts set opened_at = now() - interval '2 hours' where id = s1;   -- the shift began two hours ago

  -- ── E. money inside shift 1: every row stamped; pay in / pay out; a cash and a card refund ──
  -- a tea added to S1 and voided before payment: a void of a paid bill, not in its product sales
  v_id := place_counter_order(v_t1.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_tea, 'variantId', v_tea_v)), gen_random_uuid());
  perform void_order_item((select id from order_items where order_id = v_id), 'Wrong item keyed', v_sup, '2468');
  v_res := checkout_bill(b1, jsonb_build_array(jsonb_build_object('methodId', v_cash, 'amountSen', 4240, 'tenderedSen', 5000)), gen_random_uuid());
  if (v_res->>'changeSen')::int is distinct from 760 then raise exception 'FAIL E checkout b1: %', v_res; end if;
  perform checkout_bill(b2, jsonb_build_array(jsonb_build_object('methodId', v_card, 'amountSen', 2000),
                                              jsonb_build_object('methodId', v_cash, 'amountSen', 775)), gen_random_uuid());
  perform checkout_bill(b3, jsonb_build_array(jsonb_build_object('methodId', v_card, 'amountSen', 550)), gen_random_uuid());
  if exists (select 1 from payments where bill_id in (b1, b2, b3) and shift_id is distinct from s1)
     or (select count(*) from payments where shift_id = s1) is distinct from 4
     or exists (select 1 from bills where id in (b1, b2, b3) and shift_id is distinct from s1)
     or (select count(*) from bills where shift_id = s1) is distinct from 3 then
    raise exception 'FAIL E stamps: payments or bills not stamped with shift 1';
  end if;
  -- voids: one item of an open bill, one whole bill (listed by time, they move no money)
  perform void_order_item((select id from order_items where bill_id = b4), 'Wrong item keyed', v_sup, '2468');
  perform void_bill(b5, 'Customer left', v_sup, '2468');
  update order_items set voided_at = now() - interval '1 hour' where bill_id in (b1, b4, b5) and voided_at is not null;
  update bills set closed_at = now() - interval '1 hour' where id = b5;
  -- pay in: no approver; idempotent on its id
  v_res := record_cash_move(v_move, 'pay_in', 2000, '  Float top-up ', null, null);
  if not (v_res->>'ok')::boolean or record_cash_move(v_move, 'pay_in', 2000, 'Float top-up', null, null) is distinct from v_res then
    raise exception 'FAIL E pay in: %', v_res;
  end if;
  v_res := record_cash_move(v_move, 'pay_in', 3000, 'Float top-up', null, null);
  if (v_res->>'ok')::boolean or v_res->>'error' is distinct from 'This was already recorded as Pay in RM 20.00 — close and reopen to record another' then
    raise exception 'FAIL E pay in resend with another amount: %', v_res;
  end if;
  if (select count(*) from pos_cash_moves where shift_id = s1) is distinct from 1
     or (select reason || ':' || coalesce(approved_by::text, '-') from pos_cash_moves where id = v_move) is distinct from 'Float top-up:-' then
    raise exception 'FAIL E pay in row';
  end if;
  perform pg_temp.expect_error(format('select record_cash_move(%L, %L, 0, %L, null, null)', v_move2, 'pay_out', 'Ice'),
    'Enter the amount (RM 0.01 to RM 100000.00)', 'E zero');
  perform pg_temp.expect_error(format('select record_cash_move(%L, %L, 10000001, %L, null, null)', v_move2, 'pay_in', 'Ice'),
    'Enter the amount (RM 0.01 to RM 100000.00)', 'E above RM 100000');
  perform pg_temp.expect_error(format('select record_cash_move(%L, %L, 1500, %L, null, null)', v_move2, 'pay_out', ' '), 'Enter a reason', 'E no reason');
  perform pg_temp.expect_error(format('select record_cash_move(%L, %L, 1500, %L, null, null)', v_move2, 'tips', 'Ice'), 'Choose Pay in or Pay out', 'E kind');
  -- pay out: an approver with the right PIN, never the cashier, never without the PIN
  perform pg_temp.expect_error(format('select record_cash_move(%L, %L, 1500, %L, null, null)', v_move2, 'pay_out', 'Ice'),
    'Choose who approves', 'E pay out without an approver');
  perform pg_temp.expect_error(format('select record_cash_move(%L, %L, 1500, %L, %L, %L)', v_move2, 'pay_out', 'Ice', v_cashier, '1111'),
    'This person cannot approve voids or refunds', 'E pay out approved by the cashier');
  v_res := record_cash_move(v_move2, 'pay_out', 1500, 'Ice', v_sup, null);
  if (v_res->>'ok')::boolean or v_res->>'error' is distinct from 'Wrong PIN — 4 tries left'
     or exists (select 1 from pos_cash_moves where id = v_move2) then
    raise exception 'FAIL E pay out without the PIN: %', v_res;
  end if;
  v_res := record_cash_move(v_move2, 'pay_out', 1500, 'Ice', v_sup, '2468');
  if not (v_res->>'ok')::boolean or (select approved_by from pos_cash_moves where id = v_move2) is distinct from v_sup then
    raise exception 'FAIL E pay out: %', v_res;
  end if;
  -- refunds in shift 1: cash (leaves the drawer) and card (does not)
  if not (refund_bill(gen_random_uuid(), b1, 1000, v_cash, 'Verify refund', v_sup, '2468')->>'ok')::boolean
     or not (refund_bill(gen_random_uuid(), b2, 300, v_card, 'Verify refund', v_sup, '2468')->>'ok')::boolean then
    raise exception 'FAIL E refunds';
  end if;
  if (select string_agg(kind || ':' || amount_sen, ',' order by amount_sen) from refunds where shift_id = s1) is distinct from 'card:300,cash:1000' then
    raise exception 'FAIL E refund stamps: %', (select json_agg(rr) from refunds rr where rr.bill_id in (b1, b2));
  end if;
  -- expected = float 100.00 + cash 42.40 + 7.75 (amounts, change taken off) − cash refund 10.00 + pay in 20.00 − pay out 15.00
  if pos_shift_expected_cash(s1) is distinct from 14515 then raise exception 'FAIL E expected cash: %', pos_shift_expected_cash(s1); end if;

  -- ── F. close shift 1: blind count, above the limit, approval, first count kept ──
  perform pg_temp.expect_error('select save_shift_settings(800)', 'Only a manager can change the shift settings', 'F settings by the cashier');
  perform pg_temp.act(v_owner);
  perform pg_temp.expect_error('select save_shift_settings(-1)', 'Enter a cash variance limit between RM 0.00 and RM 10000.00', 'F bad limit');
  perform save_shift_settings(500);
  if (select cash_variance_limit_sen from branch_pos_settings where branch_id = v_branch) is distinct from 500
     or (select receipt_route from branch_pos_settings where branch_id = v_branch) is distinct from 'Bar' then
    raise exception 'FAIL F settings';
  end if;
  perform pg_temp.act(v_cashier);
  perform pg_temp.expect_error(format('select close_shift(%L, -5, null, null, null, null)', s1),
    'Enter the counted cash (RM 0.00 to RM 100000.00)', 'F negative count');
  perform pg_temp.expect_error(format('select close_shift(%L, 10000001, null, null, null, null)', s1),
    'Enter the counted cash (RM 0.00 to RM 100000.00)', 'F count above RM 100000');
  -- short RM 5.15 (more than RM 5.00): no approver yet → the sheet asks for one
  v_res := close_shift(s1, 14000, null, null, null, null);
  if v_res is distinct from jsonb_build_object('ok', false, 'needsApproval', true, 'expectedSen', 14515, 'varianceSen', -515, 'limitSen', 500)
     or (select status || ':' || first_count_sen from pos_shifts where id = s1) is distinct from 'open:14000' then
    raise exception 'FAIL F above the limit: %', v_res;
  end if;
  -- the expected cash is on screen now: a new count of exactly that still needs the approval
  v_res := close_shift(s1, 14515, null, null, null, null);
  if v_res is distinct from jsonb_build_object('ok', false, 'needsApproval', true, 'expectedSen', 14515, 'varianceSen', 0, 'limitSen', 500)
     or (select status || ':' || first_count_sen from pos_shifts where id = s1) is distinct from 'open:14000' then
    raise exception 'FAIL F a re-count within the limit after a first count above it closed without approval: %', v_res;
  end if;
  -- the approver was shown another expected cash (it moved meanwhile): the new figures, no PIN tried
  v_res := close_shift(s1, 13900, 'Short — till miscount', v_sup, '0000', 14000);
  if v_res is distinct from jsonb_build_object('ok', false, 'needsApproval', true, 'expectedSen', 14515, 'varianceSen', -615, 'limitSen', 500)
     or (select status from pos_shifts where id = s1) is distinct from 'open'
     or (select failed_attempts from staff_pos_pins where staff_id = v_sup) is distinct from 0 then
    raise exception 'FAIL F approval of a stale expected cash: %', v_res;
  end if;
  -- counted again (RM 139.00, short 6.15): a wrong PIN leaves it open; the first count stays
  v_res := close_shift(s1, 13900, 'Short — till miscount', v_sup, '0000', 14515);
  if (v_res->>'ok')::boolean or v_res->>'error' is distinct from 'Wrong PIN — 4 tries left'
     or (select status || ':' || first_count_sen from pos_shifts where id = s1) is distinct from 'open:14000' then
    raise exception 'FAIL F wrong PIN: %', v_res;
  end if;
  perform pg_temp.expect_error(format('select close_shift(%L, 13900, %L, %L, %L, 14515)', s1, ' ', v_sup, '2468'),
    'Enter a reason for the difference', 'F no reason');
  v_res := close_shift(s1, 13900, 'Short — till miscount', v_sup, '2468', 14515);
  if not (v_res->>'ok')::boolean or not (v_res->>'printed')::boolean then raise exception 'FAIL F close: %', v_res; end if;
  v_rep1 := v_res->'report';
  select * into r from pos_shifts where id = s1;
  if r.status is distinct from 'closed' or r.counted_cash_sen is distinct from 13900 or r.first_count_sen is distinct from 14000 or r.expected_cash_sen is distinct from 14515
     or r.variance_sen is distinct from -615 or r.variance_reason is distinct from 'Short — till miscount' or r.variance_approved_by is distinct from v_sup
     or r.closed_by is distinct from v_cashier or r.report is distinct from v_rep1 or not r.report_printed then
    raise exception 'FAIL F closed row: %', row_to_json(r);
  end if;
  -- the Z report
  if v_rep1->>'branch' is distinct from 'Verify 4A Cafe' or v_rep1->>'openedBy' is distinct from 'Verify 4A Cashier' or v_rep1->>'closedBy' is distinct from 'Verify 4A Cashier'
     or v_rep1->'summary' is distinct from '{"pax": 4, "nettSen": 7565, "voidSen": 3100, "billCount": 3, "refundSen": 1300,
                               "avgPerPaxSen": 1891, "avgPerBillSen": 2522, "voidBillCount": 1}'::jsonb
     or v_rep1->'sales' is distinct from '{"sstSen": 366, "nettSen": 7565, "grossSen": 7100, "roundingSen": -1,
                             "takeawayFeeSen": 100, "serviceChargeSen": 0}'::jsonb then
    raise exception 'FAIL F report summary: % %', v_rep1->'summary', v_rep1->'sales';
  end if;
  -- the report's totals are the bills' totals
  if (select jsonb_build_object('grossSen', sum(subtotal_sen), 'takeawayFeeSen', sum(takeaway_fee_sen), 'serviceChargeSen', sum(service_charge_sen),
                                'sstSen', sum(sst_sen), 'roundingSen', sum(rounding_sen), 'nettSen', sum(total_sen))
        from bills where shift_id = s1) is distinct from v_rep1->'sales' then
    raise exception 'FAIL F report totals differ from the bills';
  end if;
  if v_rep1->'payments' is distinct from '[{"kind": "card", "name": "V Card", "count": 2, "netSen": 2250, "amountSen": 2550, "refundSen": 300, "refundCount": 1},
                            {"kind": "cash", "name": "V Cash", "count": 2, "netSen": 4015, "amountSen": 5015, "refundSen": 1000, "refundCount": 1}]'::jsonb
     or v_rep1->'orderTypes' is distinct from '[{"bills": 2, "nettSen": 4790, "orderType": "dine_in"}, {"bills": 1, "nettSen": 2775, "orderType": "takeaway"}]'::jsonb
     or v_rep1->'sources' is distinct from '[{"orders": 3, "itemSen": 6550, "source": "counter"}, {"orders": 1, "itemSen": 550, "source": "qr"}]'::jsonb
     or v_rep1->'products' is distinct from '[{"qty": 3, "name": "Verify 4A Plate", "valueSen": 6000}, {"qty": 2, "name": "Verify 4A Tea", "valueSen": 1100}]'::jsonb then
    raise exception 'FAIL F report lists: % % % %', v_rep1->'payments', v_rep1->'orderTypes', v_rep1->'sources', v_rep1->'products';
  end if;
  if (v_rep1->'cash') - 'moves' is distinct from '{"countedSen": 13900, "payInSen": 2000, "payOutSen": 1500, "expectedSen": 14515,
                                    "varianceSen": -615, "cashSalesSen": 5015, "cashRefundSen": 1000, "firstCountSen": 14000,
                                    "varianceReason": "Short — till miscount", "openingFloatSen": 10000,
                                    "varianceApprovedBy": "Verify 4A Supervisor"}'::jsonb
     or (select string_agg(m->>'kind' || ':' || (m->>'amountSen') || ':' || (m->>'reason') || ':' || (m->>'by') || ':' || coalesce(m->>'approvedBy', '-'), ',')
           from jsonb_array_elements(v_rep1->'cash'->'moves') m)
        is distinct from 'pay_in:2000:Float top-up:Verify 4A Cashier:-,pay_out:1500:Ice:Verify 4A Cashier:Verify 4A Supervisor' then
    raise exception 'FAIL F report cash drawer: %', v_rep1->'cash';
  end if;
  if (select string_agg((v->>'name') || ':' || (v->>'qty') || ':' || (v->>'valueSen') || ':' || (v->>'reason') || ':' || (v->>'approvedBy'), ',' order by v->>'name', v->>'reason')
        from jsonb_array_elements(v_rep1->'voids'->'items') v)
        is distinct from 'Verify 4A Plate:1:2000:Wrong item keyed:Verify 4A Supervisor,Verify 4A Tea:1:550:Customer left:Verify 4A Supervisor,'
                         'Verify 4A Tea:1:550:Wrong item keyed:Verify 4A Supervisor'
     or jsonb_array_length(v_rep1->'voids'->'bills') is distinct from 1 or v_rep1->'voids'->'bills'->0->>'reason' is distinct from 'Customer left'
     or (select string_agg((x->>'amountSen') || ':' || (x->>'method'), ',' order by (x->>'amountSen')::int) from jsonb_array_elements(v_rep1->'refunds') x)
        is distinct from '300:V Card,1000:V Cash' then
    raise exception 'FAIL F report voids and refunds: % %', v_rep1->'voids', v_rep1->'refunds';
  end if;
  -- printed on the receipt route as a Z report (print_jobs.kind stays 'receipt')
  select count(*) into n from print_jobs where branch_id = v_branch and kind = 'receipt' and route = 'Bar'
     and payload->>'kind' = 'zreport' and payload->'report' = v_rep1 and not (payload->>'reprint')::boolean;
  if n is distinct from 1 then raise exception 'FAIL F: % Z report jobs queued', n; end if;

  -- ── G. a closed shift never changes; money stops until the next shift opens ──
  if close_shift(s1, 13900, null, null, null, null) is distinct from v_res then raise exception 'FAIL G: a resend of the close got another answer'; end if;
  perform pg_temp.expect_error(format('select close_shift(%L, 14515, null, null, null, null)', s1), 'This shift is already closed', 'G close again');
  if (select count(*) from print_jobs where branch_id = v_branch and payload->>'kind' = 'zreport') is distinct from 1 then
    raise exception 'FAIL G: a resend printed the Z report again';
  end if;
  begin
    update pos_shifts set counted_cash_sen = 14515 where id = s1;
    raise exception 'FAIL G: a closed shift was changed';
  exception when raise_exception then if sqlerrm is distinct from 'A closed shift never changes' then raise; end if;
  end;
  begin
    delete from pos_shifts where id = s1;
    raise exception 'FAIL G: a shift was deleted';
  exception when raise_exception then if sqlerrm is distinct from 'A shift is never deleted' then raise; end if;
  end;
  v_id := place_counter_order(v_t4.id, 'dine_in', 1,
    jsonb_build_array(jsonb_build_object('productId', v_tea, 'variantId', v_tea_v)), gen_random_uuid());
  b6 := (select bill_id from orders where id = v_id);
  perform pg_temp.expect_error(format('select checkout_bill(%L, %L::jsonb, %L)', b6,
      jsonb_build_array(jsonb_build_object('methodId', v_cash, 'amountSen', 550)), gen_random_uuid()),
    'Open the shift first', 'G checkout after the close');
  perform pg_temp.expect_error(format('select refund_bill(%L, %L, 500, %L, %L, %L, %L)', gen_random_uuid(), b1, v_cash, 'Verify refund', v_sup, '2468'),
    'Open the shift first', 'G refund without a shift');
  perform pg_temp.expect_error(format('select record_cash_move(%L, %L, 100, %L, null, null)', gen_random_uuid(), 'pay_in', 'x'),
    'Open the shift first', 'G pay in after the close');
  v_res := pos_current_shift();
  if v_res->'shift' is distinct from 'null'::jsonb or (v_res->>'lastFloatSen')::int is distinct from 10000 or (v_res->>'openBillCount')::int is distinct from 2 then
    raise exception 'FAIL G status after the close: %', v_res;
  end if;

  -- ── H. shift 2: an old bill's refund belongs to the shift open now; within the limit; no printer ──
  perform pg_temp.act(v_sup);
  s2 := (open_shift(12000)->'shift'->>'id')::uuid;
  v_res := refund_bill(gen_random_uuid(), b1, 500, v_cash, 'Verify refund', v_sup, '2468');
  if not (v_res->>'ok')::boolean
     or (select shift_id from refunds where bill_id = b1 and amount_sen = 500) is distinct from s2 then
    raise exception 'FAIL H: the refund of a closed shift''s bill is not in the shift open now';
  end if;
  perform checkout_bill(b6, jsonb_build_array(jsonb_build_object('methodId', v_cash, 'amountSen', 550, 'tenderedSen', 1000)), gen_random_uuid());
  if (select shift_id from payments where bill_id = b6) is distinct from s2 then raise exception 'FAIL H: b6 not in shift 2'; end if;
  -- a bill of RM 0.00 (a free water) is paid with no payment rows and still belongs to the shift
  v_id := place_counter_order(null, 'takeaway', null,
    jsonb_build_array(jsonb_build_object('productId', v_water, 'variantId', v_water_v)), gen_random_uuid());
  b7 := (select bill_id from orders where id = v_id);
  perform checkout_bill(b7, '[]'::jsonb, gen_random_uuid());
  if (select status || ':' || total_sen || ':' || coalesce(shift_id::text, '-') from bills where id = b7) is distinct from 'paid:0:' || s2
     or exists (select 1 from payments where bill_id = b7) then
    raise exception 'FAIL H: the RM 0.00 bill is not paid in shift 2';
  end if;
  update branch_pos_settings set receipt_route = null where branch_id = v_branch;
  -- expected 120.00 − 5.00 + 5.50 = 120.50; counted 121.00 is within RM 5.00: no approver, no reason kept
  v_res := close_shift(s2, 12100, 'ignored', null, null, null);
  if not (v_res->>'ok')::boolean or (v_res->>'printed')::boolean then raise exception 'FAIL H close: %', v_res; end if;
  v_rep := v_res->'report';
  select * into r from pos_shifts where id = s2;
  if r.variance_sen is distinct from 50 or r.expected_cash_sen is distinct from 12050 or r.variance_reason is not null or r.variance_approved_by is not null
     or r.report_printed then
    raise exception 'FAIL H closed row: %', row_to_json(r);
  end if;
  if (v_rep->'summary'->>'billCount')::int is distinct from 2 or (v_rep->'summary'->>'refundSen')::int is distinct from 500
     or v_rep->'products' is distinct from '[{"qty": 1, "name": "Verify 4A Tea", "valueSen": 550}, {"qty": 1, "name": "Verify 4A Water", "valueSen": 0}]'::jsonb
     or (v_rep->'cash'->>'cashRefundSen')::int is distinct from 500 or jsonb_array_length(v_rep->'voids'->'items') is distinct from 0
     or v_rep->'refunds'->0->>'billNo' is distinct from (select bill_no from bills where id = b1) then
    raise exception 'FAIL H report: %', v_rep;
  end if;
  if (select jsonb_build_object('grossSen', sum(subtotal_sen), 'takeawayFeeSen', sum(takeaway_fee_sen), 'serviceChargeSen', sum(service_charge_sen),
                                'sstSen', sum(sst_sen), 'roundingSen', sum(rounding_sen), 'nettSen', sum(total_sen))
        from bills where shift_id = s2) is distinct from v_rep->'sales' then
    raise exception 'FAIL H report totals differ from the bills';
  end if;
  if (select report from pos_shifts where id = s1) is distinct from v_rep1 then raise exception 'FAIL H: shift 1''s report changed'; end if;
  if exists (select 1 from print_jobs where branch_id = v_branch and payload->>'kind' = 'zreport' and payload->'report' = v_rep) then
    raise exception 'FAIL H: printed without a receipt printer';
  end if;

  -- ── I. past shifts and reprint: Approve POS voids & refunds only, own branch only ──
  perform pg_temp.act(v_cashier);
  perform pg_temp.expect_error('select pos_shift_list()', 'Only a supervisor can see past shifts', 'I list by the cashier');
  perform pg_temp.expect_error(format('select pos_shift_zreport(%L)', s1), 'Only a supervisor can see past shifts', 'I report by the cashier');
  perform pg_temp.expect_error(format('select reprint_zreport(%L)', s1), 'Only a supervisor can reprint a Z report', 'I reprint by the cashier');
  perform pg_temp.act(v_sup);
  set local role authenticated;
  v_res := pos_shift_list();
  reset role;
  if jsonb_array_length(v_res) is distinct from 2 or (v_res->0->>'id')::uuid is distinct from s2 or (v_res->1->>'id')::uuid is distinct from s1
     or (v_res->1->>'nettSen')::int is distinct from 7565 or (v_res->1->>'varianceSen')::int is distinct from -615 or v_res->1->>'openedBy' is distinct from 'Verify 4A Cashier' then
    raise exception 'FAIL I list: %', v_res;
  end if;
  if pos_shift_zreport(s1) is distinct from v_rep1 then raise exception 'FAIL I: the frozen report'; end if;
  perform pg_temp.expect_error(format('select reprint_zreport(%L)', s2), 'No receipt printer is set — choose one in POS settings', 'I reprint without a printer');
  update branch_pos_settings set receipt_route = 'Bar' where branch_id = v_branch;
  perform reprint_zreport(s1);
  if (select count(*) from print_jobs where branch_id = v_branch and payload->>'kind' = 'zreport' and (payload->>'reprint')::boolean
        and payload->'report' = v_rep1) is distinct from 1 then
    raise exception 'FAIL I reprint';
  end if;
  perform pg_temp.act(v_far);
  perform pg_temp.expect_error(format('select pos_shift_zreport(%L)', s1), 'Shift not found', 'I another branch');
  perform pg_temp.act(v_owner);

  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;
rollback;
```

- [ ] **Step 2: Let the checkout verify run inside a shift.** In `supabase/migration-2026-10-24-pos-checkout-verify.sql` make exactly this replacement (the old text occurs once):

1. Replace

```sql
    (v_far,   'Far Supervisor',    'supervisor', true, current_date, 'supervisor', v_branch2);
```

   with

```sql
    (v_far,   'Far Supervisor',    'supervisor', true, current_date, 'supervisor', v_branch2);
  -- Sub-plan 4a (migration-2026-10-24-pos-shifts.sql): money moves only inside an open shift.
  -- Once shifts are applied, VERIFY works inside one; the shifts verify script tests the shifts.
  if to_regclass('public.pos_shifts') is not null then
    execute 'insert into pos_shifts(branch_id, opened_by, opening_float_sen) values ($1, $2, 0)' using v_branch, v_owner;
  end if;
```


- [ ] **Step 3: Local checks.** Run: `grep -c "VERIFY OK" supabase/migration-2026-10-24-pos-shifts-verify.sql` — Expected: `3` (header, notice, final select). Run: `grep -c "perform pg_temp.expect_error" supabase/migration-2026-10-24-pos-shifts-verify.sql` — Expected: `27`. Run: `grep -n "insert into staff" -B3 supabase/migration-2026-10-24-pos-shifts-verify.sql | grep -c "act(v_owner)"` — Expected: `1` (the staff are inserted after the claims are set to the owner). Run: `npx vitest run` — Expected: 98 files, 855 tests pass (the scan ignores `-verify` files).

- [ ] **Step 4: Commit**

```bash
git add supabase/migration-2026-10-24-pos-shifts-verify.sql supabase/migration-2026-10-24-pos-checkout-verify.sql
git commit -m "test(pos-shift): verify script for shifts, pay in / pay out and the Z report; the checkout verify opens a shift

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5 (controller, craft-os-dev — dashboard SQL editor in the owner's Chrome tab; the implementer does not touch the database):** confirm the top bar reads **craft-os-dev** (`egznnbjmicebbhwasloy`) — never the prod project. Load each file with `window.monaco.editor.getModels()[0].setValue(...)` and run it with `cmd+Return`, in order:
  1. `migration-2026-10-24-pos-shifts.sql` → `shifts schema applied`. Run it a **second time** → the same row.
  2. `migration-2026-10-24-pos-shifts-fn.sql` → `shifts functions applied`. Run it a **second time** → the same row. A `STOP: …` error names the file to run first.
  3. `migration-2026-10-24-pos-shifts-verify.sql` → `VERIFY OK`.
  4. Regression, each → `VERIFY OK`: `migration-2026-10-22-pos-menu-verify.sql`, `migration-2026-10-23-pos-ordering-verify.sql`, `migration-2026-10-24-pos-checkout-verify.sql` (the Step 2 version), `migration-2026-10-24-pos-catalogs-verify.sql`, `migration-2026-10-24-pos-menu-editor-verify.sql`, `migration-2026-10-24-pos-slots-photos-verify.sql`.
  5. Nothing real moved:

```sql
select (select count(*) from pos_shifts)                                          as shifts,
       (select count(*) from bills where shift_id is not null)                    as stamped_bills,
       (select count(*) from payments where shift_id is not null)                 as stamped_payments,
       (select count(*) from pg_proc where proname in ('checkout_bill', 'refund_bill')) as money_functions,
       (select count(*) from pg_policies where tablename in ('pos_shifts', 'pos_cash_moves')) as policies,
       (select count(*) from branch_pos_settings where cash_variance_limit_sen <> 500) as changed_limits;
```

     Expected: `0`, `0`, `0`, `2`, `0`, `0`.

  If a script stops with `FAIL …`, the message names the check: fix the function file (implementer, new commit), re-run it, then re-run the verify. From now until Task 7 lands, checkout and refunds on dev answer "Open the shift first" (the bar that opens a shift comes in Task 7). If a demo needs checkout before then, open a shift for the test login's branch in the SQL editor, as one run: `select set_config('request.jwt.claims', json_build_object('sub', '76cbcf9f-905e-450d-9f5e-1c9e72a9373d', 'role', 'authenticated')::text, true), open_shift(0);` — and close it from the Task 7 bar later. Record the outcome in the ledger.

---

### Task 3: The Z report layout — the `zreport` print kind

**Files:**
- Create: `src/features/pos/print/zreport.ts`, `src/features/pos/print/zreport.test.ts`
- Modify: `src/features/pos/print/receipt.ts` (three helpers exported), `src/features/pos/print/printJob.ts`

**Interfaces:**
- Consumes: `formatMyt`, `wrap` (`ticket.ts`); `asciiDeep`, `center`, `lr`, `money` (`receipt.ts`, exported here).
- Produces: `ZReport` (Task 1's shape), `ZReportPayment`, `ZReportCashMove`, `ZReportVoidItem`, `ZReportVoidBill`, `ZReportRefund`, `ZReportPayload { kind: 'zreport'; route: string; reprint: boolean; report: ZReport }`, `renderZReportLines(payload, cols): string[]`, `signedMoney(sen)`; `JobPayload` gains `ZReportPayload`, `renderJobLines` renders it, `jobLabel` says "Z report 24/10/2026 22:31" (· REPRINT). The Node print agent (`tools/print-agent/agent.ts`) loads these files directly, so every import in them keeps its explicit `.ts` extension.

- [ ] **Step 1: Write the failing test.** Create `src/features/pos/print/zreport.test.ts` (the fixture is the verify script's first shift, section F, with real-looking names; every line of the layout is pinned):

```ts
import { describe, expect, it } from 'vitest'
import { renderZReportLines, signedMoney, type ZReport, type ZReportPayload } from './zreport'
import { jobLabel, renderJobLines } from './printJob'

// The first shift of the shifts verify script (supabase/migration-2026-10-24-pos-shifts-verify.sql,
// section F) with real-looking names and times: the numbers are the ones the SQL checks.
const shiftOne: ZReport = {
  branch: 'Craft Cafe – Cheras',
  openedAt: '2026-10-24T01:02:00.000Z', openedBy: 'Aina',
  closedAt: '2026-10-24T14:31:00.000Z', closedBy: 'Aina',
  summary: { billCount: 3, pax: 4, nettSen: 7565, avgPerBillSen: 2522, avgPerPaxSen: 1891, voidBillCount: 1, voidSen: 3100, refundSen: 1300 },
  sales: { grossSen: 7100, takeawayFeeSen: 100, serviceChargeSen: 0, sstSen: 366, roundingSen: -1, nettSen: 7565 },
  payments: [
    { name: 'Card', kind: 'card', count: 2, amountSen: 2550, refundCount: 1, refundSen: 300, netSen: 2250 },
    { name: 'Cash', kind: 'cash', count: 2, amountSen: 5015, refundCount: 1, refundSen: 1000, netSen: 4015 },
  ],
  orderTypes: [{ orderType: 'dine_in', bills: 2, nettSen: 4790 }, { orderType: 'takeaway', bills: 1, nettSen: 2775 }],
  sources: [{ source: 'counter', orders: 3, itemSen: 6550 }, { source: 'qr', orders: 1, itemSen: 550 }],
  cash: {
    openingFloatSen: 10000, cashSalesSen: 5015, cashRefundSen: 1000,
    moves: [
      { kind: 'pay_in', amountSen: 2000, reason: 'Float top-up', by: 'Aina', approvedBy: null, at: '2026-10-24T03:00:00.000Z' },
      { kind: 'pay_out', amountSen: 1500, reason: 'Ice', by: 'Aina', approvedBy: 'Hafiz', at: '2026-10-24T05:00:00.000Z' },
    ],
    payInSen: 2000, payOutSen: 1500, expectedSen: 14515, firstCountSen: 14000, countedSen: 13900, varianceSen: -615,
    varianceReason: 'Short — till miscount', varianceApprovedBy: 'Hafiz',
  },
  voids: {
    items: [
      { at: '2026-10-24T04:00:00.000Z', billNo: '261024-001', name: 'Iced Tea', qty: 1, valueSen: 550, reason: 'Wrong item keyed', by: 'Aina', approvedBy: 'Hafiz' },
      { at: '2026-10-24T04:10:00.000Z', billNo: '261024-004', name: 'Chicken Chop', qty: 1, valueSen: 2000, reason: 'Wrong item keyed', by: 'Aina', approvedBy: 'Hafiz' },
    ],
    bills: [{ at: '2026-10-24T04:20:00.000Z', billNo: '261024-005', reason: 'Customer left', by: 'Aina', approvedBy: 'Hafiz' }],
  },
  refunds: [
    { at: '2026-10-24T06:00:00.000Z', billNo: '261024-002', amountSen: 300, method: 'Card', reason: 'Cold food', approvedBy: 'Hafiz' },
    { at: '2026-10-24T06:05:00.000Z', billNo: '261024-001', amountSen: 1000, method: 'Cash', reason: 'Cold food', approvedBy: 'Hafiz' },
  ],
  products: [{ name: 'Chicken Chop', qty: 3, valueSen: 6000 }, { name: 'Iced Tea', qty: 2, valueSen: 1100 }],
}

const payload = (report: ZReport, reprint = false): ZReportPayload => ({ kind: 'zreport', route: 'Bar', reprint, report })

describe('renderZReportLines', () => {
  it('lays out the close up report at 48 columns', () => {
    expect(renderZReportLines(payload(shiftOne), 48)).toEqual([
      '              Craft Cafe - Cheras',
      '                CLOSE UP REPORT',
      '',
      'Opened                          24/10/2026 09:02',
      'Opened by                                   Aina',
      'Closed                          24/10/2026 22:31',
      'Closed by                                   Aina',
      '------------------------------------------------',
      'SUMMARY',
      'Bills                                          3',
      'Pax                                            4',
      'Nett sales                                 75.65',
      'Average per bill                           25.22',
      'Average per pax                            18.91',
      'Void bills                                     1',
      'Total void                                 31.00',
      'Total refund                               13.00',
      '------------------------------------------------',
      'SALES SUMMARY',
      'Gross sales                                71.00',
      'Takeaway fee                                1.00',
      'Service charge                              0.00',
      'SST                                         3.66',
      'Rounding                                   -0.01',
      'Nett sales                                 75.65',
      '------------------------------------------------',
      'PAYMENTS',
      'Card (2)                                   25.50',
      '  Refunds (1)                              -3.00',
      '  Net                                      22.50',
      'Cash (2)                                   50.15',
      '  Refunds (1)                             -10.00',
      '  Net                                      40.15',
      '------------------------------------------------',
      'ORDER TYPE',
      'Dine-in (2)                                47.90',
      'Takeaway (1)                               27.75',
      '------------------------------------------------',
      'SOURCE',
      'Counter (3 orders)                         65.50',
      'QR (1 order)                                5.50',
      '------------------------------------------------',
      'CASH DRAWER',
      'Opening float                             100.00',
      'Cash sales                                 50.15',
      'Cash refunds                              -10.00',
      'Pay in: Float top-up                       20.00',
      '  by Aina',
      'Pay out: Ice                              -15.00',
      '  by Aina, approved by Hafiz',
      'Expected cash                             145.15',
      'First count                               140.00',
      'Counted cash                              139.00',
      'Variance                                   -6.15',
      '  Reason: Short - till miscount',
      '  Approved by Hafiz',
      '------------------------------------------------',
      'VOIDS',
      '1 Iced Tea                                  5.50',
      '  261024-001, Wrong item keyed, by Aina,',
      '    approved by Hafiz',
      '1 Chicken Chop                             20.00',
      '  261024-004, Wrong item keyed, by Aina,',
      '    approved by Hafiz',
      'Bill 261024-005 voided, Customer left, by Aina,',
      '  approved by Hafiz',
      '------------------------------------------------',
      'REFUNDS',
      '261024-002 Card                             3.00',
      '  Cold food, approved by Hafiz',
      '261024-001 Cash                            10.00',
      '  Cold food, approved by Hafiz',
      '------------------------------------------------',
      'PRODUCT SALES',
      '3 Chicken Chop                             60.00',
      '2 Iced Tea                                 11.00',
      '------------------------------------------------',
      '                 END OF REPORT',
    ])
  })

  it('marks a reprint, hides a first count equal to the final one, and says when a list is empty', () => {
    const quiet: ZReport = {
      ...shiftOne,
      payments: [], refunds: [], products: [], voids: { items: [], bills: [] },
      cash: { ...shiftOne.cash, moves: [], firstCountSen: 14515, countedSen: 14515, varianceSen: 0, varianceReason: null, varianceApprovedBy: null },
    }
    const lines = renderZReportLines(payload(quiet, true), 48)
    expect(lines[0]).toBe('                *** REPRINT ***')
    expect(lines).not.toContain('First count                               145.15')
    expect(lines).toContain('Variance                                    0.00')
    for (const empty of ['No payments', 'No voids', 'No refunds', 'No sales']) expect(lines).toContain(empty)
    expect(lines.some((l) => l.startsWith('  Reason:') || l.startsWith('  Approved by'))).toBe(false)
  })

  it('never prints a line wider than the paper', () => {
    const long: ZReport = { ...shiftOne, products: [{ name: 'Very Long Product Name With Many Words In It', qty: 12, valueSen: 123456 }] }
    for (const cols of [32, 42, 48]) {
      for (const l of renderZReportLines(payload(long), cols)) expect(l.length).toBeLessThanOrEqual(cols)
    }
  })
})

describe('signedMoney', () => {
  it('shows over with a plus and short with a minus', () => {
    expect(signedMoney(50)).toBe('+0.50')
    expect(signedMoney(-615)).toBe('-6.15')
    expect(signedMoney(0)).toBe('0.00')
  })
})

describe('the print hosts know the Z report', () => {
  it('renders it through renderJobLines and names it for the printer-problems list', () => {
    expect(renderJobLines(payload(shiftOne), 48)).toEqual(renderZReportLines(payload(shiftOne), 48))
    expect(jobLabel(payload(shiftOne))).toBe('Z report 24/10/2026 22:31')
    expect(jobLabel(payload(shiftOne, true))).toBe('Z report 24/10/2026 22:31 · REPRINT')
  })
})
```

- [ ] **Step 2: Run it to verify it fails.** Run: `npx vitest run src/features/pos/print/zreport.test.ts` — Expected: FAIL, `Failed to load url ./zreport`.

- [ ] **Step 3: Export the three layout helpers of the receipt.** In `src/features/pos/print/receipt.ts` make exactly these replacements (each old text occurs once):

1. Replace

```ts
function asciiDeep<T>(value: T): T {
```

   with

```ts
export function asciiDeep<T>(value: T): T {
```

2. Replace

```ts
function lr(left: string, right: string, cols: number): string[] {
```

   with

```ts
export function lr(left: string, right: string, cols: number): string[] {
```

3. Replace

```ts
function center(text: string, cols: number): string[] {
```

   with

```ts
export function center(text: string, cols: number): string[] {
```


- [ ] **Step 4: Write the renderer.** Create `src/features/pos/print/zreport.ts`:

```ts
// Explicit .ts extensions: the Node print agent loads this file directly (no bundler).
import { formatMyt, wrap } from './ticket.ts'
import { asciiDeep, center, lr, money } from './receipt.ts'

/** The Z report of one shift (Feedme's "Close up" without discount, delivery and
 *  member sections). pos_shift_report (supabase/migration-2026-10-24-pos-shifts-fn.sql)
 *  builds exactly this shape once, at close; it is frozen in pos_shifts.report.
 *  Money is integer sen; times are ISO, UTC. */
export interface ZReportPayment {
  name: string
  kind: string
  count: number
  amountSen: number
  refundCount: number
  refundSen: number
  netSen: number
}

export interface ZReportCashMove {
  kind: 'pay_in' | 'pay_out'
  amountSen: number
  reason: string
  by: string | null
  approvedBy: string | null // pay out only
  at: string
}

export interface ZReportVoidItem {
  at: string
  billNo: string
  name: string
  qty: number
  valueSen: number
  reason: string | null
  by: string | null
  approvedBy: string | null
}

export interface ZReportVoidBill {
  at: string
  billNo: string
  reason: string | null
  by: string | null
  approvedBy: string | null
}

export interface ZReportRefund {
  at: string
  billNo: string
  amountSen: number
  method: string
  reason: string | null
  approvedBy: string | null
}

export interface ZReport {
  branch: string
  openedAt: string
  openedBy: string | null
  closedAt: string
  closedBy: string | null
  summary: {
    billCount: number
    pax: number
    nettSen: number
    avgPerBillSen: number
    avgPerPaxSen: number
    voidBillCount: number
    voidSen: number
    refundSen: number
  }
  sales: { grossSen: number; takeawayFeeSen: number; serviceChargeSen: number; sstSen: number; roundingSen: number; nettSen: number }
  payments: ZReportPayment[]
  orderTypes: { orderType: 'dine_in' | 'takeaway'; bills: number; nettSen: number }[]
  sources: { source: 'counter' | 'qr'; orders: number; itemSen: number }[]
  cash: {
    openingFloatSen: number
    cashSalesSen: number
    cashRefundSen: number
    moves: ZReportCashMove[]
    payInSen: number
    payOutSen: number
    expectedSen: number
    firstCountSen: number | null
    countedSen: number | null
    varianceSen: number | null
    varianceReason: string | null
    varianceApprovedBy: string | null
  }
  voids: { items: ZReportVoidItem[]; bills: ZReportVoidBill[] }
  refunds: ZReportRefund[]
  products: { name: string; qty: number; valueSen: number }[]
}

/** print_jobs.payload of a Z report (print_jobs.kind stays 'receipt'). */
export interface ZReportPayload {
  kind: 'zreport'
  route: string
  reprint: boolean
  report: ZReport
}

const ORDER_TYPE_LABEL: Record<string, string> = { dine_in: 'Dine-in', takeaway: 'Takeaway' }
const SOURCE_LABEL: Record<string, string> = { counter: 'Counter', qr: 'QR' }

/** −615 → "-6.15", 50 → "+0.50", 0 → "0.00". */
export function signedMoney(sen: number): string {
  return sen > 0 ? `+${money(sen)}` : money(sen)
}

const indented = (text: string, cols: number) => wrap(text, cols - 2, '  ').map((s) => `  ${s}`)

export function renderZReportLines(input: ZReportPayload, cols: number): string[] {
  const r = asciiDeep(input.report)
  const rule = '-'.repeat(cols)
  const s = r.summary
  const c = r.cash
  const section = (title: string, lines: string[]) => [rule, title, ...lines]
  return [
    ...(input.reprint ? center('*** REPRINT ***', cols) : []),
    ...center(r.branch, cols),
    ...center('CLOSE UP REPORT', cols),
    '',
    ...lr('Opened', formatMyt(r.openedAt), cols),
    ...lr('Opened by', r.openedBy ?? '-', cols),
    ...lr('Closed', formatMyt(r.closedAt), cols),
    ...lr('Closed by', r.closedBy ?? '-', cols),
    ...section('SUMMARY', [
      ...lr('Bills', String(s.billCount), cols),
      ...lr('Pax', String(s.pax), cols),
      ...lr('Nett sales', money(s.nettSen), cols),
      ...lr('Average per bill', money(s.avgPerBillSen), cols),
      ...lr('Average per pax', money(s.avgPerPaxSen), cols),
      ...lr('Void bills', String(s.voidBillCount), cols),
      ...lr('Total void', money(s.voidSen), cols),
      ...lr('Total refund', money(s.refundSen), cols),
    ]),
    ...section('SALES SUMMARY', [
      ...lr('Gross sales', money(r.sales.grossSen), cols),
      ...lr('Takeaway fee', money(r.sales.takeawayFeeSen), cols),
      ...lr('Service charge', money(r.sales.serviceChargeSen), cols),
      ...lr('SST', money(r.sales.sstSen), cols),
      ...lr('Rounding', money(r.sales.roundingSen), cols),
      ...lr('Nett sales', money(r.sales.nettSen), cols),
    ]),
    ...section('PAYMENTS', r.payments.length === 0 ? ['No payments'] : r.payments.flatMap((p) => [
      ...lr(`${p.name} (${p.count})`, money(p.amountSen), cols),
      ...(p.refundCount > 0 ? lr(`  Refunds (${p.refundCount})`, money(-p.refundSen), cols) : []),
      ...lr('  Net', money(p.netSen), cols),
    ])),
    ...section('ORDER TYPE', r.orderTypes.flatMap((o) => lr(`${ORDER_TYPE_LABEL[o.orderType] ?? o.orderType} (${o.bills})`, money(o.nettSen), cols))),
    ...section('SOURCE', r.sources.flatMap((o) => lr(`${SOURCE_LABEL[o.source] ?? o.source} (${o.orders} order${o.orders === 1 ? '' : 's'})`, money(o.itemSen), cols))),
    ...section('CASH DRAWER', [
      ...lr('Opening float', money(c.openingFloatSen), cols),
      ...lr('Cash sales', money(c.cashSalesSen), cols),
      ...lr('Cash refunds', money(-c.cashRefundSen), cols),
      ...c.moves.flatMap((m) => [
        ...lr(`${m.kind === 'pay_in' ? 'Pay in' : 'Pay out'}: ${m.reason}`, money(m.kind === 'pay_in' ? m.amountSen : -m.amountSen), cols),
        ...indented(`by ${m.by ?? '-'}${m.approvedBy ? `, approved by ${m.approvedBy}` : ''}`, cols),
      ]),
      ...lr('Expected cash', money(c.expectedSen), cols),
      ...(c.firstCountSen !== null && c.firstCountSen !== c.countedSen ? lr('First count', money(c.firstCountSen), cols) : []),
      ...lr('Counted cash', c.countedSen === null ? '-' : money(c.countedSen), cols),
      ...lr('Variance', c.varianceSen === null ? '-' : signedMoney(c.varianceSen), cols),
      ...(c.varianceReason ? indented(`Reason: ${c.varianceReason}`, cols) : []),
      ...(c.varianceApprovedBy ? indented(`Approved by ${c.varianceApprovedBy}`, cols) : []),
    ]),
    ...section('VOIDS', r.voids.items.length + r.voids.bills.length === 0 ? ['No voids'] : [
      ...r.voids.items.flatMap((v) => [
        ...lr(`${v.qty} ${v.name}`, money(v.valueSen), cols),
        ...indented(`${v.billNo}, ${v.reason ?? '-'}, by ${v.by ?? '-'}${v.approvedBy ? `, approved by ${v.approvedBy}` : ''}`, cols),
      ]),
      ...r.voids.bills.flatMap((v) => wrap(
        `Bill ${v.billNo} voided, ${v.reason ?? '-'}, by ${v.by ?? '-'}${v.approvedBy ? `, approved by ${v.approvedBy}` : ''}`, cols, '  ')),
    ]),
    ...section('REFUNDS', r.refunds.length === 0 ? ['No refunds'] : r.refunds.flatMap((f) => [
      ...lr(`${f.billNo} ${f.method}`, money(f.amountSen), cols),
      ...indented(`${f.reason ?? '-'}${f.approvedBy ? `, approved by ${f.approvedBy}` : ''}`, cols),
    ])),
    ...section('PRODUCT SALES', r.products.length === 0 ? ['No sales'] : r.products.flatMap((p) => lr(`${p.qty} ${p.name}`, money(p.valueSen), cols))),
    rule,
    ...center('END OF REPORT', cols),
  ].map((l) => l.trimEnd())
}
```

- [ ] **Step 5: Teach both print hosts the new kind.** In `src/features/pos/print/printJob.ts` make exactly these replacements (each old text occurs once, in this order):

1. Replace

```ts
import { renderTicketLines, type TicketPayload } from './ticket.ts'
import { renderReceiptLines, renderRefundSlipLines, type ReceiptPayload, type RefundSlipPayload } from './receipt.ts'
```

   with

```ts
import { formatMyt, renderTicketLines, type TicketPayload } from './ticket.ts'
import { renderReceiptLines, renderRefundSlipLines, type ReceiptPayload, type RefundSlipPayload } from './receipt.ts'
import { renderZReportLines, type ZReportPayload } from './zreport.ts'
```

2. Replace

```ts
export type JobPayload = TicketPayload | ReceiptPayload | RefundSlipPayload
```

   with

```ts
export type JobPayload = TicketPayload | ReceiptPayload | RefundSlipPayload | ZReportPayload
```

3. Replace

```ts
    case 'refund':
      return renderRefundSlipLines(payload, cols)
```

   with

```ts
    case 'refund':
      return renderRefundSlipLines(payload, cols)
    case 'zreport':
      return renderZReportLines(payload, cols)
```

4. Replace

```ts
  if (payload.kind === 'refund') return `Refund slip ${payload.billNo}`
```

   with

```ts
  if (payload.kind === 'refund') return `Refund slip ${payload.billNo}`
  if (payload.kind === 'zreport') return `Z report ${formatMyt(payload.report.closedAt)}${payload.reprint ? ' · REPRINT' : ''}`
```


- [ ] **Step 6: Run the tests and the gates.** Run: `npx vitest run src/features/pos/print/` — Expected: PASS, 7 files, 44 tests. Run: `node --experimental-strip-types --no-warnings -e "import('./src/features/pos/print/printJob.ts').then((m) => console.log(typeof m.renderJobLines))"` — Expected: `function` (the agent's import chain still loads without a bundler). Run: `npx vitest run` — Expected: 99 files, 860 tests pass. Run: `npx tsc -b` — Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/features/pos/print/zreport.ts src/features/pos/print/zreport.test.ts src/features/pos/print/receipt.ts src/features/pos/print/printJob.ts
git commit -m "feat(pos-print): the Z report (close up) as a print kind — rendered by both print hosts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Shift rules and the RPC wrappers

**Files:**
- Create: `src/features/pos/shift/shift.ts`, `src/features/pos/shift/shift.test.ts`, `src/features/pos/shift/shiftApi.ts`

**Interfaces:**
- Consumes: `parseRinggit` (`checkout/tender.ts`), `formatSen` (`order/cart.ts`), `Approval` (`checkout/checkoutApi.ts`), `ZReport` (Task 3), the Task 1 RPCs.
- Produces — `shift.ts`: `CashMoveKind = 'pay_in' | 'pay_out'`, `KIND_LABEL`, `SHIFT_STALE_HOURS = 20`, `MAX_CASH_SEN = 10_000_000`, `OpenShift { id; openedAt; openedByName: string | null; openingFloatSen }`, `ShiftStatus { shift: OpenShift | null; openBillCount; lastFloatSen: number | null; now }`, `CloseResult = { kind: 'closed'; report: ZReport; printed: boolean } | { kind: 'needsApproval'; expectedSen; varianceSen; limitSen }`, `CashMoveResult { id; kind; amountSen }`, `ShiftListRow { id; openedAt; closedAt; openedBy; closedBy; nettSen; varianceSen }`, `parseShiftStatus`, `parseZReport`, `parseCloseResult` (throws the server's words for a wrong PIN), `parseCashMoveResult`, `parseShiftList`, `mytTime(iso)` ("09:02"), `shiftLabel(status)` ("Shift open · since 09:02" / "No shift open"), `staleShiftNote(status)` (more than 20 h by the server's `now` → "This shift was opened yesterday — close it"), `openBillsWarning(n)`, `senToText(sen)`, `floatProblem`, `countProblem`, `cashMoveProblem(amountText, reason)` (each capped at RM 100000.00, with the server's words), `limitProblem`, `varianceLabel(sen)` ("Short RM 6.15" / "Over RM 0.50" / "Exact"), `approvalNote({ varianceSen, limitSen })` (this count more than the limit off, or "A supervisor still approves, because the first count was more than RM 5.00 off."), `closeShiftError(message)` ("This shift is already closed" + "— a supervisor can open its Z report under Shifts"), `printedNote(printed)`, `looksOffline(message)`, `cashMoveMayBeRecorded(message)` (a lost reply or "This was already recorded …": keep the pay in / pay out sheet locked). `shiftApi.ts`: `fetchShiftStatus()`, `openShift(floatSen)`, `CashMoveInput { id; kind; amountSen; reason; approverId; pin }`, `recordCashMove(m)`, `closeShift(shiftId, countedSen, approval: Approval | null, expectedSen: number | null)` (`expectedSen`: what the approver was shown), `fetchShiftList()`, `fetchShiftZReport(shiftId)`, `reprintZReport(shiftId)`, `fetchCashVarianceLimit(branchId)` (no row → 500), `saveCashVarianceLimit(limitSen)`.

- [ ] **Step 1: Write the failing test.** Create `src/features/pos/shift/shift.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  approvalNote, cashMoveMayBeRecorded, cashMoveProblem, closeShiftError, countProblem, floatProblem, limitProblem, mytTime,
  openBillsWarning, parseCashMoveResult, parseCloseResult, parseShiftList, parseShiftStatus, printedNote, senToText, shiftLabel,
  staleShiftNote, varianceLabel, type ShiftStatus,
} from './shift'

const open = (openedAt: string, now: string): ShiftStatus => ({
  shift: { id: 's1', openedAt, openedByName: 'Aina', openingFloatSen: 10000 }, openBillCount: 0, lastFloatSen: null, now,
})
const report = { summary: {}, sales: {}, cash: {}, payments: [] }

describe('the shift status banner', () => {
  it('says whether a shift is open, in Malaysia time', () => {
    expect(mytTime('2026-10-24T01:02:00.000Z')).toBe('09:02')
    expect(shiftLabel(open('2026-10-24T01:02:00.000Z', '2026-10-24T05:00:00.000Z'))).toBe('Shift open · since 09:02')
    expect(shiftLabel({ shift: null, openBillCount: 0, lastFloatSen: 10000, now: '2026-10-24T05:00:00.000Z' })).toBe('No shift open')
  })
  it('asks for a close once the shift is open more than 20 hours, by the server clock', () => {
    expect(staleShiftNote(open('2026-10-24T01:00:00.000Z', '2026-10-24T21:00:00.000Z'))).toBeNull()        // exactly 20 h
    expect(staleShiftNote(open('2026-10-24T01:00:00.000Z', '2026-10-24T21:00:01.000Z')))
      .toBe('This shift was opened yesterday — close it')
    expect(staleShiftNote({ shift: null, openBillCount: 0, lastFloatSen: null, now: '2026-10-25T01:00:00.000Z' })).toBeNull()
  })
  it('warns at close when bills are still open', () => {
    expect(openBillsWarning(0)).toBeNull()
    expect(openBillsWarning(1)).toBe('1 bill is still open — it stays open for the next shift')
    expect(openBillsWarning(3)).toBe('3 bills are still open — they stay open for the next shift')
  })
})

describe('amount fields', () => {
  it('takes an opening float and a count from RM 0.00 to RM 100000.00', () => {
    expect(floatProblem('100')).toBeNull()
    expect(floatProblem('0')).toBeNull()
    expect(floatProblem('100000.00')).toBeNull()
    expect(floatProblem('')).toBe('Enter the opening float (RM 0.00 to RM 100000.00)')
    expect(floatProblem('-5')).toBe('Enter the opening float (RM 0.00 to RM 100000.00)')
    expect(floatProblem('100000.01')).toBe('Enter the opening float (RM 0.00 to RM 100000.00)')
    expect(countProblem('139.00')).toBeNull()
    expect(countProblem('12.345')).toBe('Enter the counted cash (RM 0.00 to RM 100000.00)')
    expect(countProblem('200000')).toBe('Enter the counted cash (RM 0.00 to RM 100000.00)')
  })
  it('needs an amount from RM 0.01 to RM 100000.00 and a reason for pay in / pay out', () => {
    expect(cashMoveProblem('15', 'Ice')).toBeNull()
    expect(cashMoveProblem('0', 'Ice')).toBe('Enter the amount (RM 0.01 to RM 100000.00)')
    expect(cashMoveProblem('abc', 'Ice')).toBe('Enter the amount (RM 0.01 to RM 100000.00)')
    expect(cashMoveProblem('100000.01', 'Ice')).toBe('Enter the amount (RM 0.01 to RM 100000.00)')
    expect(cashMoveProblem('15', '  ')).toBe('Enter a reason')
    expect(cashMoveProblem('15', 'x'.repeat(201))).toBe('Reason is too long')
  })
  it('keeps the cash variance limit between RM 0 and RM 10000', () => {
    expect(limitProblem('5.00')).toBeNull()
    expect(limitProblem('0')).toBeNull()
    expect(limitProblem('10000.01')).toBe('Enter a cash variance limit between RM 0.00 and RM 10000.00')
    expect(senToText(500)).toBe('5.00')
  })
  it('names a variance as short, over or exact', () => {
    expect(varianceLabel(-615)).toBe('Short RM 6.15')
    expect(varianceLabel(50)).toBe('Over RM 0.50')
    expect(varianceLabel(0)).toBe('Exact')
    expect(printedNote(false)).toBe('Not printed — no receipt printer set')
  })
  it('says why a supervisor approves: this count, or the first one', () => {
    expect(approvalNote({ varianceSen: -615, limitSen: 500 }))
      .toBe('More than RM 5.00 off: a supervisor approves the difference with a reason. If you miscounted, count again — the approval is still needed.')
    expect(approvalNote({ varianceSen: 0, limitSen: 500 })).toBe('A supervisor still approves, because the first count was more than RM 5.00 off.')
    expect(approvalNote({ varianceSen: 500, limitSen: 500 })).toBe('A supervisor still approves, because the first count was more than RM 5.00 off.')
  })
})

describe('refusals', () => {
  it('points to Shifts when the shift closed under another count', () => {
    expect(closeShiftError('This shift is already closed')).toBe('This shift is already closed — a supervisor can open its Z report under Shifts')
    expect(closeShiftError('Wrong PIN — 4 tries left')).toBe('Wrong PIN — 4 tries left')
  })
  it('keeps a pay in / pay out locked only when something may be recorded under its id', () => {
    expect(cashMoveMayBeRecorded('Failed to fetch')).toBe(true)
    expect(cashMoveMayBeRecorded('This was already recorded as Pay in RM 20.00 — close and reopen to record another')).toBe(true)
    expect(cashMoveMayBeRecorded('Open the shift first')).toBe(false)
    expect(cashMoveMayBeRecorded('Wrong PIN — 4 tries left')).toBe(false)
  })
})

describe('server replies', () => {
  it('reads the shift status, without a shift too', () => {
    expect(parseShiftStatus({ shift: null, openBillCount: 2, lastFloatSen: null, now: 'x' }))
      .toEqual({ shift: null, openBillCount: 2, lastFloatSen: null, now: 'x' })
    expect(parseShiftStatus({ shift: { id: 's', openedAt: 'a', openedByName: 'Aina', openingFloatSen: 5000 }, openBillCount: 0, lastFloatSen: 5000, now: 'n' }).shift)
      .toEqual({ id: 's', openedAt: 'a', openedByName: 'Aina', openingFloatSen: 5000 })
    expect(() => parseShiftStatus({ shift: { id: 's' }, openBillCount: 0, now: 'n' })).toThrow('Unexpected reply from the server')
  })
  it('reads a close: closed, needs approval, or the PIN words', () => {
    expect(parseCloseResult({ ok: true, shiftId: 's', report, printed: false })).toEqual({ kind: 'closed', report, printed: false })
    expect(parseCloseResult({ ok: false, needsApproval: true, expectedSen: 14515, varianceSen: -515, limitSen: 500 }))
      .toEqual({ kind: 'needsApproval', expectedSen: 14515, varianceSen: -515, limitSen: 500 })
    expect(() => parseCloseResult({ ok: false, error: 'Wrong PIN — 4 tries left' })).toThrow('Wrong PIN — 4 tries left')
    expect(() => parseCloseResult({ ok: true, printed: true, report: null })).toThrow('Unexpected reply from the server')
  })
  it('reads a cash move and a resend that does not match', () => {
    expect(parseCashMoveResult({ ok: true, id: 'm', kind: 'pay_out', amountSen: 1500 })).toEqual({ id: 'm', kind: 'pay_out', amountSen: 1500 })
    expect(() => parseCashMoveResult({ ok: false, error: 'This was already recorded as Pay in RM 20.00 — close and reopen to record another' }))
      .toThrow('This was already recorded as Pay in RM 20.00')
  })
  it('reads the list of past shifts', () => {
    const row = { id: 's', openedAt: 'a', closedAt: 'b', openedBy: 'Aina', closedBy: null, nettSen: 7565, varianceSen: -615 }
    expect(parseShiftList([row])).toEqual([row])
    expect(() => parseShiftList({})).toThrow('Unexpected reply from the server')
  })
})
```

- [ ] **Step 2: Run it to verify it fails.** Run: `npx vitest run src/features/pos/shift/shift.test.ts` — Expected: FAIL, `Failed to load url ./shift`.

- [ ] **Step 3: Write the rules.** Create `src/features/pos/shift/shift.ts`:

```ts
/** Pure rules of the shift screens (Sub-plan 4a). The server repeats every check with
 *  the same words (migration-2026-10-24-pos-shifts-fn.sql); these are only so the
 *  cashier sees the problem before pressing the button. Money is integer sen. */
import { parseRinggit } from '../checkout/tender'
import { formatSen } from '../order/cart'
import type { ZReport } from '../print/zreport'

export type CashMoveKind = 'pay_in' | 'pay_out'
export const KIND_LABEL: Record<CashMoveKind, string> = { pay_in: 'Pay in', pay_out: 'Pay out' }

/** A shift open longer than this gets the amber "close it" note in the top bar. */
export const SHIFT_STALE_HOURS = 20

/** The most a float, a count or a pay in / pay out can be (RM 100000.00), as the server says. */
export const MAX_CASH_SEN = 10_000_000

export interface OpenShift { id: string; openedAt: string; openedByName: string | null; openingFloatSen: number }
/** pos_current_shift: never the expected cash (the count at close is blind). */
export interface ShiftStatus { shift: OpenShift | null; openBillCount: number; lastFloatSen: number | null; now: string }

export type CloseResult =
  | { kind: 'closed'; report: ZReport; printed: boolean }
  | { kind: 'needsApproval'; expectedSen: number; varianceSen: number; limitSen: number }

export interface CashMoveResult { id: string; kind: CashMoveKind; amountSen: number }

export interface ShiftListRow {
  id: string
  openedAt: string
  closedAt: string
  openedBy: string | null
  closedBy: string | null
  nettSen: number
  varianceSen: number
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const strOrNull = (x: unknown): string | null => (typeof x === 'string' ? x : null)
const unexpected = (): never => { throw new Error('Unexpected reply from the server') }

export function parseShiftStatus(data: unknown): ShiftStatus {
  if (!isObj(data) || !isNum(data.openBillCount) || typeof data.now !== 'string') return unexpected()
  const s = data.shift
  let shift: OpenShift | null = null
  if (s !== null) {
    if (!isObj(s) || typeof s.id !== 'string' || typeof s.openedAt !== 'string' || !isNum(s.openingFloatSen)) return unexpected()
    shift = { id: s.id, openedAt: s.openedAt, openedByName: strOrNull(s.openedByName), openingFloatSen: s.openingFloatSen }
  }
  return { shift, openBillCount: data.openBillCount, lastFloatSen: isNum(data.lastFloatSen) ? data.lastFloatSen : null, now: data.now }
}

/** A frozen Z report as the server stored it (only its outline is checked). */
export function parseZReport(data: unknown): ZReport {
  if (!isObj(data) || !isObj(data.summary) || !isObj(data.sales) || !isObj(data.cash) || !Array.isArray(data.payments)) return unexpected()
  return data as unknown as ZReport
}

/** Throws the server's words for a wrong PIN; otherwise closed, or "needs approval". */
export function parseCloseResult(data: unknown): CloseResult {
  if (!isObj(data) || typeof data.ok !== 'boolean') return unexpected()
  if (data.ok) {
    if (typeof data.printed !== 'boolean') return unexpected()
    return { kind: 'closed', report: parseZReport(data.report), printed: data.printed }
  }
  if (data.needsApproval === true) {
    if (!isNum(data.expectedSen) || !isNum(data.varianceSen) || !isNum(data.limitSen)) return unexpected()
    return { kind: 'needsApproval', expectedSen: data.expectedSen, varianceSen: data.varianceSen, limitSen: data.limitSen }
  }
  throw new Error(typeof data.error === 'string' && data.error ? data.error : 'Not approved')
}

export function parseCashMoveResult(data: unknown): CashMoveResult {
  if (!isObj(data) || typeof data.ok !== 'boolean') return unexpected()
  if (!data.ok) throw new Error(typeof data.error === 'string' && data.error ? data.error : 'Not approved')
  if (typeof data.id !== 'string' || (data.kind !== 'pay_in' && data.kind !== 'pay_out') || !isNum(data.amountSen)) return unexpected()
  return { id: data.id, kind: data.kind, amountSen: data.amountSen }
}

export function parseShiftList(data: unknown): ShiftListRow[] {
  if (!Array.isArray(data)) return unexpected()
  return data.map((r) => {
    if (!isObj(r) || typeof r.id !== 'string' || typeof r.openedAt !== 'string' || typeof r.closedAt !== 'string'
        || !isNum(r.nettSen) || !isNum(r.varianceSen)) return unexpected()
    return { id: r.id, openedAt: r.openedAt, closedAt: r.closedAt, openedBy: strOrNull(r.openedBy), closedBy: strOrNull(r.closedBy),
      nettSen: r.nettSen, varianceSen: r.varianceSen }
  })
}

const MYT_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit', hour12: false })

/** "09:02", Malaysia time. */
export function mytTime(iso: string): string {
  return MYT_TIME.format(new Date(iso))
}

/** The top bar's words for the shift. */
export function shiftLabel(s: ShiftStatus): string {
  return s.shift ? `Shift open · since ${mytTime(s.shift.openedAt)}` : 'No shift open'
}

/** The amber note: a shift open more than 20 hours (by the server's clock) was not closed last night. */
export function staleShiftNote(s: ShiftStatus): string | null {
  if (!s.shift) return null
  const hours = (Date.parse(s.now) - Date.parse(s.shift.openedAt)) / 3_600_000
  return hours > SHIFT_STALE_HOURS ? 'This shift was opened yesterday — close it' : null
}

/** Close shift's first screen: open bills are not closed with the shift. */
export function openBillsWarning(n: number): string | null {
  if (n <= 0) return null
  return n === 1 ? '1 bill is still open — it stays open for the next shift'
    : `${n} bills are still open — they stay open for the next shift`
}

/** 1250 → "12.50", for prefilling an amount field. */
export function senToText(sen: number): string {
  return (sen / 100).toFixed(2)
}

/** The opening float: RM 0.00 to RM 100000.00. */
export function floatProblem(text: string): string | null {
  const sen = parseRinggit(text)
  return sen === null || sen > MAX_CASH_SEN ? 'Enter the opening float (RM 0.00 to RM 100000.00)' : null
}

/** The blind count: RM 0.00 to RM 100000.00. */
export function countProblem(text: string): string | null {
  const sen = parseRinggit(text)
  return sen === null || sen > MAX_CASH_SEN ? 'Enter the counted cash (RM 0.00 to RM 100000.00)' : null
}

/** Pay in / Pay out: an amount from RM 0.01 to RM 100000.00 and a reason, as record_cash_move says. */
export function cashMoveProblem(amountText: string, reason: string): string | null {
  const sen = parseRinggit(amountText)
  if (sen === null || sen <= 0 || sen > MAX_CASH_SEN) return 'Enter the amount (RM 0.01 to RM 100000.00)'
  if (!reason.trim()) return 'Enter a reason'
  if (reason.trim().length > 200) return 'Reason is too long'
  return null
}

/** The cash variance limit on POS settings: RM 0.00 to RM 10000.00. */
export function limitProblem(text: string): string | null {
  const sen = parseRinggit(text)
  return sen === null || sen > 1_000_000 ? 'Enter a cash variance limit between RM 0.00 and RM 10000.00' : null
}

/** −615 → "Short RM 6.15", 50 → "Over RM 0.50", 0 → "Exact". */
export function varianceLabel(sen: number): string {
  if (sen === 0) return 'Exact'
  return sen < 0 ? `Short ${formatSen(-sen)}` : `Over ${formatSen(sen)}`
}

/** Why the close sheet asks for a supervisor: this count is off by more than the limit, or the
 *  first count was (a new count corrects the figure, the approval stays — close_shift's rule). */
export function approvalNote(check: { varianceSen: number; limitSen: number }): string {
  const limit = formatSen(check.limitSen)
  return Math.abs(check.varianceSen) > check.limitSen
    ? `More than ${limit} off: a supervisor approves the difference with a reason. If you miscounted, count again — the approval is still needed.`
    : `A supervisor still approves, because the first count was more than ${limit} off.`
}

/** The close refusal that leaves a cashier without the report (a resend with another count
 *  after a lost reply) says where the report is. */
export function closeShiftError(m: string): string {
  return m === 'This shift is already closed' ? `${m} — a supervisor can open its Z report under Shifts` : m
}

export function printedNote(printed: boolean): string {
  return printed ? 'Z report sent to the receipt printer' : 'Not printed — no receipt printer set'
}

/** What happened after a request with no reply: the id makes a resend safe. */
export const looksOffline = (m: string) => /fetch|network|timeout|abort|signal/i.test(m)

/** After a refused pay in / pay out: was anything recorded under its id? Only a lost reply (maybe)
 *  or a resend that does not match (yes) keep the sheet locked; every other refusal wrote nothing. */
export const cashMoveMayBeRecorded = (m: string) => looksOffline(m) || m.startsWith('This was already recorded')
```

- [ ] **Step 4: Write the RPC wrappers.** Create `src/features/pos/shift/shiftApi.ts`:

```ts
// src/features/pos/shift/shiftApi.ts — Supabase calls for shifts, Pay in / Pay out, the
// Z report and the Shifts settings (migration-2026-10-24-pos-shifts-fn.sql). pos_shifts and
// pos_cash_moves have no RLS policy: everything goes through these RPCs.
import { supabase } from '../../../shared/lib/supabase'
import type { Approval } from '../checkout/checkoutApi'
import type { ZReport } from '../print/zreport'
import {
  parseCashMoveResult, parseCloseResult, parseShiftList, parseShiftStatus, parseZReport,
  type CashMoveKind, type CashMoveResult, type CloseResult, type ShiftListRow, type ShiftStatus,
} from './shift'

const MONEY_TIMEOUT_MS = 10_000
const DEFAULT_LIMIT_SEN = 500

function fail(error: { message: string } | null): never {
  throw new Error(error?.message ?? 'Unknown error')
}

/** The top bar: the branch's open shift (never the expected cash), open bills, the last float. */
export async function fetchShiftStatus(): Promise<ShiftStatus> {
  const { data, error } = await supabase.rpc('pos_current_shift')
  if (error) fail(error)
  return parseShiftStatus(data)
}

export async function openShift(floatSen: number): Promise<ShiftStatus> {
  const { data, error } = await supabase.rpc('open_shift', { p_float_sen: floatSen })
  if (error) fail(error)
  return parseShiftStatus(data)
}

export interface CashMoveInput { id: string; kind: CashMoveKind; amountSen: number; reason: string; approverId: string | null; pin: string | null }

/** Idempotent on `id`: a resend after a lost reply records nothing twice. */
export async function recordCashMove(m: CashMoveInput): Promise<CashMoveResult> {
  const { data, error } = await supabase
    .rpc('record_cash_move', {
      p_id: m.id, p_kind: m.kind, p_amount_sen: m.amountSen, p_reason: m.reason, p_approver_id: m.approverId, p_pin: m.pin,
    })
    .abortSignal(AbortSignal.timeout(MONEY_TIMEOUT_MS))
  if (error) fail(error)
  return parseCashMoveResult(data)
}

/** The blind count. Without `approval` the server answers "needs approval" above the limit (or
 *  when the first count was above it); with it, `expectedSen` is the expected cash the approver
 *  was shown — changed meanwhile, the answer is "needs approval" again with the new figures.
 *  A resend of a close that went through answers the same report. */
export async function closeShift(shiftId: string, countedSen: number, approval: Approval | null,
                                 expectedSen: number | null): Promise<CloseResult> {
  const { data, error } = await supabase
    .rpc('close_shift', {
      p_shift_id: shiftId, p_counted_sen: countedSen,
      p_reason: approval?.reason ?? null, p_approver_id: approval?.approverId ?? null, p_pin: approval?.pin ?? null,
      p_expected_sen: expectedSen,
    })
    .abortSignal(AbortSignal.timeout(MONEY_TIMEOUT_MS))
  if (error) fail(error)
  return parseCloseResult(data)
}

/** The last 30 closed shifts of the branch (Approve POS voids & refunds). */
export async function fetchShiftList(): Promise<ShiftListRow[]> {
  const { data, error } = await supabase.rpc('pos_shift_list')
  if (error) fail(error)
  return parseShiftList(data)
}

export async function fetchShiftZReport(shiftId: string): Promise<ZReport> {
  const { data, error } = await supabase.rpc('pos_shift_zreport', { p_shift_id: shiftId })
  if (error) fail(error)
  return parseZReport(data)
}

export async function reprintZReport(shiftId: string): Promise<void> {
  const { error } = await supabase.rpc('reprint_zreport', { p_shift_id: shiftId })
  if (error) fail(error)
}

/** branch_pos_settings is readable by every signed-in staff member (pos_read); no row = the default. */
export async function fetchCashVarianceLimit(branchId: string): Promise<number> {
  const { data, error } = await supabase.from('branch_pos_settings')
    .select('cash_variance_limit_sen').eq('branch_id', branchId).maybeSingle()
  if (error) fail(error)
  return (data as { cash_variance_limit_sen: number } | null)?.cash_variance_limit_sen ?? DEFAULT_LIMIT_SEN
}

export async function saveCashVarianceLimit(limitSen: number): Promise<void> {
  const { error } = await supabase.rpc('save_shift_settings', { p_cash_variance_limit_sen: limitSen })
  if (error) fail(error)
}
```

- [ ] **Step 5: Run the tests and the gates.** Run: `npx vitest run src/features/pos/shift/shift.test.ts` — Expected: PASS, 14 tests. Run: `npx vitest run` — Expected: 100 files, 874 tests pass. Run: `npx tsc -b` — Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/features/pos/shift/shift.ts src/features/pos/shift/shift.test.ts src/features/pos/shift/shiftApi.ts
git commit -m "feat(pos-shift): shift rules (banner, amounts, variance) and the shift RPC wrappers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The approval dialog for pay outs and variances; the Open shift and Pay in / Pay out sheets

**Files:**
- Create: `src/features/pos/shift/OpenShiftSheet.tsx`, `src/features/pos/shift/CashMoveSheet.tsx`
- Modify: `src/features/pos/checkout/ApprovalDialog.tsx`

**Interfaces:**
- Consumes: Task 4; `formatSen`; `parseRinggit`.
- Produces: `ApprovalDialog` props gain `action: ReasonAction | null`, `askReason?: boolean` and `reasonMissing?: string` (existing callers — voids and refunds in `BillPanel` / `TodayBillsDrawer` — pass an action and no `askReason`, so they behave as before); `<OpenShiftSheet lastFloatSen onClose onOpened(status: ShiftStatus)>`; `<CashMoveSheet branchId onClose onRecorded(note: string)>` ("Pay in RM 20.00 recorded").

- [ ] **Step 1: Give the approval dialog its three options and a double-tap guard.** In `src/features/pos/checkout/ApprovalDialog.tsx` make exactly these replacements (each old text occurs once, in this order):

1. Replace

```tsx
import { useEffect, useState, type ReactNode } from 'react'
```

   with

```tsx
import { useEffect, useRef, useState, type ReactNode } from 'react'
```

2. Replace

```tsx
/** Reason + approver + PIN, for voids and refunds. The PIN is checked by the
 *  protected RPC itself (onApprove), never by a separate call. */
export default function ApprovalDialog({ branchId, action, title, summary, extra, extraProblem, approveDisabled, onApprove, onClose, onDone }: {
  branchId: string
  action: ReasonAction
```

   with

```tsx
/** Reason + approver + PIN, for voids, refunds, pay outs and a cash variance. The PIN is
 *  checked by the protected RPC itself (onApprove), never by a separate call. */
export default function ApprovalDialog({ branchId, action, askReason = true, reasonMissing, title, summary, extra, extraProblem, approveDisabled, onApprove, onClose, onDone }: {
  branchId: string
  action: ReasonAction | null           // null: no reason template (a reason is required, any wording)
  askReason?: boolean                   // false: the reason was asked before (pay out)
  reasonMissing?: string                // action null: the server's words for an empty reason
```

3. Replace

```tsx
  const [busy, setBusy] = useState(false)
```

   with

```tsx
  const [busy, setBusy] = useState(false)
  const running = useRef(false)                    // a second tap in the same render must not send twice
```

4. Replace

```tsx
    fetchReasonTemplate(branchId, action).then((t) => setTemplate(t ?? DEFAULT_TEMPLATE), (e) => setError(msg(e)))
```

   with

```tsx
    if (action) fetchReasonTemplate(branchId, action).then((t) => setTemplate(t ?? DEFAULT_TEMPLATE), (e) => setError(msg(e)))
```

5. Replace

```tsx
    const problem = extraProblem ?? reasonProblem(template, reason)
```

   with

```tsx
    const problem = extraProblem
      ?? (!askReason ? null : action === null && reasonMissing && !reason.trim() ? reasonMissing : reasonProblem(template, reason))
```

6. Replace

```tsx
    if (problem) { setError(problem); return }
    setBusy(true); setError(null)
    try {
      await onApprove({ reason: reason.trim(), approverId, pin })
      onDone()
    } catch (e) {
      setError(msg(e)); setPin('')
    } finally { setBusy(false) }
```

   with

```tsx
    if (problem) { setError(problem); return }
    if (running.current) return
    running.current = true; setBusy(true); setError(null)
    try {
      await onApprove({ reason: reason.trim(), approverId, pin })
      onDone()
    } catch (e) {
      setError(msg(e)); setPin('')
    } finally { running.current = false; setBusy(false) }
```

7. Replace

```tsx
          {extra}
          <div>
            <div className="text-xs font-semibold uppercase text-brown-muted">Reason{template.compulsory ? '' : ' (optional)'}</div>
```

   with

```tsx
          {extra}
          {askReason && <div>
            <div className="text-xs font-semibold uppercase text-brown-muted">Reason{template.compulsory ? '' : ' (optional)'}</div>
```

8. Replace

```tsx
            {template.allowOther && (
              <input className="mt-2 w-full rounded border border-border p-2 text-sm" placeholder={template.reasons.length ? 'Other reason' : 'Reason'}
                value={other} onChange={(e) => { setOther(e.target.value); setChoice(''); setError(null) }} />
            )}
          </div>
```

   with

```tsx
            {template.allowOther && (
              <input className="mt-2 w-full rounded border border-border p-2 text-sm" placeholder={template.reasons.length ? 'Other reason' : 'Reason'}
                aria-label="Reason" value={other} onChange={(e) => { setOther(e.target.value); setChoice(''); setError(null) }} />
            )}
          </div>}
```


- [ ] **Step 2: Write the Open shift sheet.** Create `src/features/pos/shift/OpenShiftSheet.tsx`:

```tsx
import { useRef, useState } from 'react'
import { parseRinggit } from '../checkout/tender'
import { openShift } from './shiftApi'
import { floatProblem, senToText, type ShiftStatus } from './shift'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Open shift: the opening float, prefilled with the last shift's. Any live POS staff of the branch. */
export default function OpenShiftSheet({ lastFloatSen, onClose, onOpened }: {
  lastFloatSen: number | null
  onClose: () => void
  onOpened: (status: ShiftStatus) => void
}) {
  const [text, setText] = useState(lastFloatSen === null ? '' : senToText(lastFloatSen))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)

  const submit = async () => {
    const problem = floatProblem(text)
    if (problem) { setError(problem); return }
    if (running.current) return
    running.current = true; setBusy(true); setError(null)
    try { onOpened(await openShift(parseRinggit(text) ?? 0)) } catch (e) { setError(msg(e)) } finally { running.current = false; setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40" onClick={busy ? undefined : onClose}>
      <div className="w-full max-w-sm space-y-3 rounded-2xl bg-card p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">Open shift</h2>
        <p className="text-xs text-brown-muted">Count the cash in the drawer before the first sale. Checkout, refunds and pay in / pay out need an open shift.</p>
        <label className="block text-sm">Opening float (RM)
          <input inputMode="decimal" autoFocus className="mt-1 w-full rounded border border-border p-2" value={text}
            onChange={(e) => { setText(e.target.value); setError(null) }} />
        </label>
        {error && <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
        <div className="flex gap-2">
          <button onClick={onClose} disabled={busy} className="flex-1 rounded-xl border border-border py-3">Cancel</button>
          <button onClick={() => void submit()} disabled={busy} className="flex-1 rounded-xl bg-brown-btn py-3 text-white disabled:opacity-40">
            {busy ? 'Opening…' : 'Open shift'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Write the Pay in / Pay out sheet.** Create `src/features/pos/shift/CashMoveSheet.tsx` (one id per send: once sent, the kind and amount are locked, so a resend after a lost reply records nothing twice; a refusal that recorded nothing — "Open the shift first", an amount the server refuses, a wrong PIN — unlocks them and takes a new id):

```tsx
import { useRef, useState } from 'react'
import { formatSen } from '../order/cart'
import { parseRinggit } from '../checkout/tender'
import ApprovalDialog from '../checkout/ApprovalDialog'
import { recordCashMove } from './shiftApi'
import { cashMoveMayBeRecorded, cashMoveProblem, KIND_LABEL, looksOffline, type CashMoveKind, type CashMoveResult } from './shift'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const KINDS: CashMoveKind[] = ['pay_in', 'pay_out']

/** Pay in / Pay out: cash put into or taken out of the drawer, with a reason. Pay out needs an
 *  approver's PIN. One id per send: once sent, the kind and amount are fixed, so a resend after
 *  a lost reply can never record the money twice; a refusal that recorded nothing ("Open the
 *  shift first", a wrong PIN, …) unlocks the fields and takes a new id. */
export default function CashMoveSheet({ branchId, onClose, onRecorded }: {
  branchId: string
  onClose: () => void
  onRecorded: (note: string) => void
}) {
  const moveId = useRef(crypto.randomUUID())
  const [kind, setKind] = useState<CashMoveKind>('pay_in')
  const [amountText, setAmountText] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [locked, setLocked] = useState(false)
  const [approving, setApproving] = useState(false)
  const running = useRef(false)
  const result = useRef<CashMoveResult | null>(null)

  const amountSen = parseRinggit(amountText) ?? 0
  const done = (r: CashMoveResult) => onRecorded(`${KIND_LABEL[r.kind]} ${formatSen(r.amountSen)} recorded`)
  const send = async (approverId: string | null, pin: string | null) => {
    setLocked(true)
    try {
      return await recordCashMove({ id: moveId.current, kind, amountSen, reason: reason.trim(), approverId, pin })
    } catch (e) {
      if (!cashMoveMayBeRecorded(msg(e))) { moveId.current = crypto.randomUUID(); setLocked(false) }  // nothing was recorded
      throw e
    }
  }

  const submit = async () => {
    const problem = cashMoveProblem(amountText, reason)
    if (problem) { setError(problem); return }
    if (kind === 'pay_out') { setError(null); setApproving(true); return }
    if (running.current) return
    running.current = true; setBusy(true); setError(null)
    try { done(await send(null, null)) } catch (e) {
      const m = msg(e)
      setError(looksOffline(m) ? 'Not sure it was recorded (no reply). Press Record again — it will not be recorded twice.' : m)
    } finally { running.current = false; setBusy(false) }
  }

  return (
    <>
      <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40" onClick={busy ? undefined : onClose}>
        <div className="w-full max-w-sm space-y-3 rounded-2xl bg-card p-5" onClick={(e) => e.stopPropagation()}>
          <h2 className="text-lg font-semibold">Pay in / Pay out</h2>
          <div className="flex gap-2" role="radiogroup" aria-label="Pay in or pay out">
            {KINDS.map((k) => (
              <button key={k} role="radio" aria-checked={kind === k} disabled={locked} onClick={() => { setKind(k); setError(null) }}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm disabled:opacity-60 ${kind === k ? 'border-brown-btn bg-brown-btn text-white' : 'border-border'}`}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <label className="block text-sm">Amount (RM)
            <input inputMode="decimal" className="mt-1 w-full rounded border border-border p-2 disabled:opacity-60" value={amountText}
              disabled={locked} onChange={(e) => { setAmountText(e.target.value); setError(null) }} />
          </label>
          <label className="block text-sm">Reason
            <input className="mt-1 w-full rounded border border-border p-2 disabled:opacity-60" value={reason} maxLength={200}
              disabled={locked} placeholder={kind === 'pay_in' ? 'e.g. Float top-up' : 'e.g. Ice from the shop next door'}
              onChange={(e) => { setReason(e.target.value); setError(null) }} />
          </label>
          {kind === 'pay_out' && <p className="text-xs text-brown-muted">A pay out needs a supervisor's PIN.</p>}
          {locked && <p className="text-xs text-brown-muted">Kind and amount are fixed now. To record another, close and reopen.</p>}
          {error && <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
          <div className="flex gap-2">
            <button onClick={onClose} disabled={busy} className="flex-1 rounded-xl border border-border py-3">Cancel</button>
            <button onClick={() => void submit()} disabled={busy} className="flex-1 rounded-xl bg-brown-btn py-3 text-white disabled:opacity-40">
              {busy ? 'Recording…' : kind === 'pay_out' ? 'Next: approval' : 'Record pay in'}
            </button>
          </div>
        </div>
      </div>
      {approving && (
        <ApprovalDialog branchId={branchId} action={null} askReason={false} title="Approve pay out"
          summary={`Pay out ${formatSen(amountSen)} · ${reason.trim()}`}
          onApprove={async (a) => { result.current = await send(a.approverId, a.pin) }}
          onClose={() => setApproving(false)}
          onDone={() => { if (result.current) done(result.current) }} />
      )}
    </>
  )
}
```

- [ ] **Step 4: Gates.** Run: `git diff --stat HEAD -- src/features/pos/order src/features/pos/checkout` — Expected: only `src/features/pos/checkout/ApprovalDialog.tsx` (no caller changes). Run: `npx vitest run` — Expected: 100 files, 874 tests pass. Run: `npx tsc -b` — Expected: no output (the existing callers still type-check).

- [ ] **Step 5: Commit**

```bash
git add src/features/pos/checkout/ApprovalDialog.tsx src/features/pos/shift/OpenShiftSheet.tsx src/features/pos/shift/CashMoveSheet.tsx
git commit -m "feat(pos-shift): Open shift and Pay in / Pay out sheets; the approval dialog takes no template and no reason

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Close shift, the on-screen Z report and the Shifts drawer

**Files:**
- Create: `src/features/pos/shift/ZReportView.tsx`, `src/features/pos/shift/CloseShiftSheet.tsx`, `src/features/pos/shift/ShiftsDrawer.tsx`

**Interfaces:**
- Consumes: Tasks 3–5 (`renderZReportLines`, `closeShift`, `fetchShiftList`, `fetchShiftZReport`, `reprintZReport`, `ApprovalDialog` with `action={null}`), `formatMyt`.
- Produces: `<ZReportView report>`; `<CloseShiftSheet branchId shift: OpenShift openBillCount onClose onClosed>` (steps: open-bills warning → blind count → above the limit, or after a first count above it: counted / expected / difference, `approvalNote`, **Count again** or **Approve difference** → the report with the printed note → **Done**; an approval answered "needs approval" — the expected cash moved meanwhile — shows the new figures and "The expected cash changed meanwhile …" to approve again; "This shift is already closed" points to Shifts); `<ShiftsDrawer onClose>`.

- [ ] **Step 1: Write the on-screen report.** Create `src/features/pos/shift/ZReportView.tsx`:

```tsx
import { renderZReportLines, type ZReport } from '../print/zreport'

/** The Z report on screen: the receipt layout's lines at 48 columns. A printer wraps the same
 *  content at its own width (the iPad print host at TICKET_COLS 42, the Node agent at its .env's). */
export default function ZReportView({ report }: { report: ZReport }) {
  const lines = renderZReportLines({ kind: 'zreport', route: '', reprint: false, report }, 48)
  return (
    <pre aria-label="Z report" className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-white p-3 font-mono text-xs leading-snug">
      {lines.join('\n')}
    </pre>
  )
}
```

- [ ] **Step 2: Write the Close shift sheet.** Create `src/features/pos/shift/CloseShiftSheet.tsx` (the expected cash appears only in the reply to a count; the count field is empty again after **Count again**):

```tsx
import { useRef, useState } from 'react'
import { formatSen } from '../order/cart'
import { parseRinggit } from '../checkout/tender'
import ApprovalDialog from '../checkout/ApprovalDialog'
import { closeShift } from './shiftApi'
import ZReportView from './ZReportView'
import {
  approvalNote, closeShiftError, countProblem, looksOffline, openBillsWarning, printedNote, varianceLabel,
  type CloseResult, type OpenShift,
} from './shift'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
type Step = 'warn' | 'count' | 'approve' | 'done'
type NeedsApproval = Extract<CloseResult, { kind: 'needsApproval' }>
type Closed = Extract<CloseResult, { kind: 'closed' }>

/** Close shift: open-bills warning → blind count → (above the limit) expected, variance,
 *  reason and a supervisor's PIN → the Z report. The expected cash is shown only after the
 *  count was submitted. Re-entering a different count is allowed; the first one is kept, and
 *  once it was above the limit the approval stays (close_shift's rule). If the expected cash
 *  changed while the supervisor came over, the server answers with the new figures. */
export default function CloseShiftSheet({ branchId, shift, openBillCount, onClose, onClosed }: {
  branchId: string
  shift: OpenShift
  openBillCount: number
  onClose: () => void
  onClosed: () => void
}) {
  const warning = openBillsWarning(openBillCount)
  const [step, setStep] = useState<Step>(warning ? 'warn' : 'count')
  const [countText, setCountText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [check, setCheck] = useState<NeedsApproval | null>(null)
  const [closed, setClosed] = useState<Closed | null>(null)
  const [approving, setApproving] = useState(false)
  const [changed, setChanged] = useState(false)     // the expected cash moved while approving
  const running = useRef(false)
  const counted = useRef(0)

  const take = (r: CloseResult) => {
    if (r.kind === 'closed') { setClosed(r); setStep('done') } else { setCheck(r); setStep('approve') }
  }

  const submitCount = async () => {
    const problem = countProblem(countText)
    if (problem) { setError(problem); return }
    if (running.current) return
    running.current = true; setBusy(true); setError(null); setChanged(false)
    counted.current = parseRinggit(countText) ?? 0
    try { take(await closeShift(shift.id, counted.current, null, null)) } catch (e) {
      const m = msg(e)
      setError(looksOffline(m) ? 'Not sure the shift closed (no reply). Press Close shift again with the same count.' : closeShiftError(m))
    } finally { running.current = false; setBusy(false) }
  }

  const box = 'w-full max-w-md space-y-3 rounded-2xl bg-card p-5'
  return (
    <>
      <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40" onClick={busy || step === 'done' ? undefined : onClose}>
        <div className={step === 'done' ? `${box} max-w-xl` : box} onClick={(e) => e.stopPropagation()}>
          <h2 className="text-lg font-semibold">Close shift</h2>
          {step === 'warn' && (
            <>
              <p role="status" className="rounded bg-amber-50 p-2 text-sm text-amber-800">{warning}</p>
              <div className="flex gap-2">
                <button onClick={onClose} className="flex-1 rounded-xl border border-border py-3">Cancel</button>
                <button onClick={() => setStep('count')} className="flex-1 rounded-xl bg-brown-btn py-3 text-white">Continue</button>
              </div>
            </>
          )}
          {step === 'count' && (
            <>
              <p className="text-xs text-brown-muted">Count all the cash in the drawer, the float included, and enter the total.</p>
              <label className="block text-sm">Counted cash (RM)
                <input inputMode="decimal" autoFocus className="mt-1 w-full rounded border border-border p-2" value={countText}
                  onChange={(e) => { setCountText(e.target.value); setError(null) }} />
              </label>
              {error && <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
              <div className="flex gap-2">
                <button onClick={onClose} disabled={busy} className="flex-1 rounded-xl border border-border py-3">Cancel</button>
                <button onClick={() => void submitCount()} disabled={busy} className="flex-1 rounded-xl bg-red-700 py-3 text-white disabled:opacity-40">
                  {busy ? 'Closing…' : 'Close shift'}
                </button>
              </div>
            </>
          )}
          {step === 'approve' && check && (
            <>
              <dl className="grid grid-cols-2 gap-1 text-sm">
                <dt>Counted</dt><dd className="text-right">{formatSen(counted.current)}</dd>
                <dt>Expected</dt><dd className="text-right">{formatSen(check.expectedSen)}</dd>
                <dt className="font-semibold">Difference</dt><dd className="text-right font-semibold text-red-700">{varianceLabel(check.varianceSen)}</dd>
              </dl>
              {changed && (
                <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-700">
                  The expected cash changed meanwhile (a sale, refund or pay in / out) — check the new figures and approve again.
                </p>
              )}
              <p className="rounded bg-amber-50 p-2 text-sm text-amber-800">{approvalNote(check)}</p>
              <div className="flex gap-2">
                <button onClick={() => { setCountText(''); setError(null); setStep('count') }} className="flex-1 rounded-xl border border-border py-3">Count again</button>
                <button onClick={() => setApproving(true)} className="flex-1 rounded-xl bg-red-700 py-3 text-white">Approve difference</button>
              </div>
            </>
          )}
          {step === 'done' && closed && (
            <>
              <p role="status" className={`rounded p-2 text-sm ${closed.printed ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'}`}>
                Shift closed. {printedNote(closed.printed)}
              </p>
              <ZReportView report={closed.report} />
              <button onClick={onClosed} className="w-full rounded-xl bg-brown-btn py-3 text-white">Done</button>
            </>
          )}
        </div>
      </div>
      {approving && check && (
        <ApprovalDialog branchId={branchId} action={null} reasonMissing="Enter a reason for the difference" title="Approve cash difference"
          summary={`Counted ${formatSen(counted.current)} · expected ${formatSen(check.expectedSen)} · ${varianceLabel(check.varianceSen)}`}
          onApprove={async (a) => {
            let r: CloseResult
            try { r = await closeShift(shift.id, counted.current, a, check.expectedSen) } catch (e) {
              const m = msg(e)
              throw new Error(looksOffline(m) ? 'Not sure the shift closed (no reply). Press Approve again — it will not close twice.' : closeShiftError(m))
            }
            setChanged(r.kind === 'needsApproval')       // the server's new figures replace the old ones
            take(r)
          }}
          onClose={() => setApproving(false)}
          onDone={() => setApproving(false)} />
      )}
    </>
  )
}
```

- [ ] **Step 3: Write the Shifts drawer.** Create `src/features/pos/shift/ShiftsDrawer.tsx` (a slow report reply for a shift no longer open is dropped; Reprint has its outcome beside it):

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { formatSen } from '../order/cart'
import { formatMyt } from '../print/ticket'
import type { ZReport } from '../print/zreport'
import { fetchShiftList, fetchShiftZReport, reprintZReport } from './shiftApi'
import ZReportView from './ZReportView'
import { varianceLabel, type ShiftListRow } from './shift'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Shifts (Approve POS voids & refunds): the last 30 closed shifts; each opens its frozen Z report with Reprint. */
export default function ShiftsDrawer({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<ShiftListRow[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [open, setOpen] = useState<ShiftListRow | null>(null)
  const [report, setReport] = useState<ZReport | null>(null)
  const [reportError, setReportError] = useState<string | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [printing, setPrinting] = useState(false)
  const printingRef = useRef(false)
  const listSeq = useRef(0)
  const reportSeq = useRef(0)

  const loadList = useCallback(async () => {
    const id = ++listSeq.current
    setListError(null)
    try { const r = await fetchShiftList(); if (id === listSeq.current) setRows(r) } catch (e) { if (id === listSeq.current) setListError(msg(e)) }
  }, [])
  useEffect(() => { void loadList() }, [loadList])

  const loadReport = async (row: ShiftListRow) => {
    const id = ++reportSeq.current                 // a slow reply for a shift no longer open is dropped
    setOpen(row); setReport(null); setReportError(null); setNote(null)
    try { const r = await fetchShiftZReport(row.id); if (id === reportSeq.current) setReport(r) } catch (e) { if (id === reportSeq.current) setReportError(msg(e)) }
  }

  const reprint = async () => {
    if (!open || printingRef.current) return
    printingRef.current = true; setPrinting(true); setNote(null)
    try { await reprintZReport(open.id); setNote({ ok: true, text: 'Z report sent to the receipt printer' }) } catch (e) { setNote({ ok: false, text: msg(e) }) }
    finally { printingRef.current = false; setPrinting(false) }
  }

  const back = () => { reportSeq.current++; setOpen(null); setReport(null); setReportError(null); setNote(null) }
  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/30" onClick={onClose}>
      <div className="flex h-full w-full max-w-xl flex-col bg-card" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border p-4">
          <h2 className="text-lg font-semibold">{open ? `Shift closed ${formatMyt(open.closedAt)}` : 'Shifts'}</h2>
          <div className="flex gap-2">
            {open && <button onClick={back} className="rounded border border-border px-3 py-1 text-sm">Back</button>}
            <button onClick={onClose} className="rounded border border-border px-3 py-1 text-sm">Close</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-3 text-sm">
          {!open && (
            <>
              {listError && <p role="alert" className="rounded bg-red-50 p-2 text-red-700">{listError} <button className="underline" onClick={() => void loadList()}>Try again</button></p>}
              {!listError && rows === null && <p className="text-brown-muted">Loading…</p>}
              {rows?.length === 0 && <p className="text-brown-muted">No closed shifts yet.</p>}
              {rows?.map((r) => (
                <button key={r.id} onClick={() => void loadReport(r)} className="mb-2 flex w-full items-center justify-between rounded-lg border border-border p-2 text-left">
                  <div>
                    <div className="font-medium">{formatMyt(r.openedAt)} – {formatMyt(r.closedAt)}</div>
                    <div className="text-xs text-brown-muted">Opened by {r.openedBy ?? '—'} · closed by {r.closedBy ?? '—'}</div>
                  </div>
                  <div className="text-right">
                    <div>{formatSen(r.nettSen)}</div>
                    <div className={`text-xs ${r.varianceSen === 0 ? 'text-brown-muted' : 'text-red-700'}`}>{varianceLabel(r.varianceSen)}</div>
                  </div>
                </button>
              ))}
            </>
          )}
          {open && (
            <div className="space-y-3">
              {reportError && <p role="alert" className="rounded bg-red-50 p-2 text-red-700">{reportError} <button className="underline" onClick={() => void loadReport(open)}>Try again</button></p>}
              {!reportError && !report && <p className="text-brown-muted">Loading…</p>}
              {report && (
                <>
                  <div className="flex items-center gap-3">
                    <button onClick={() => void reprint()} disabled={printing} className="rounded bg-brown-btn px-3 py-2 text-white disabled:opacity-40">
                      {printing ? 'Printing…' : 'Reprint'}
                    </button>
                    {note && <p role={note.ok ? 'status' : 'alert'} className={note.ok ? 'text-green-800' : 'text-red-700'}>{note.text}</p>}
                  </div>
                  <ZReportView report={report} />
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Gates.** Run: `npx vitest run` — Expected: 100 files, 874 tests pass. Run: `npx tsc -b` — Expected: no output. Run: `wc -l src/features/pos/shift/*.tsx` — Expected: every file under 250 lines.

- [ ] **Step 5: Commit**

```bash
git add src/features/pos/shift/ZReportView.tsx src/features/pos/shift/CloseShiftSheet.tsx src/features/pos/shift/ShiftsDrawer.tsx
git commit -m "feat(pos-shift): Close shift with the blind count and variance approval; the Shifts drawer with Reprint

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The shift in the POS top bar

**Files:**
- Create: `src/features/pos/shift/ShiftBar.tsx`
- Modify: `src/features/pos/order/PosPage.tsx`

**Interfaces:**
- Consumes: Tasks 4–6; `PosPage`'s `refreshKey` (bumped on every bill change, every order and the 15-second sweep) and `can('pos_supervise')`.
- Produces: `<ShiftBar branchId refreshKey canSupervise>` in the `/pos` header, left of the print host: **Open shift** (no shift) or "Shift open · since 09:02" + amber stale note + **Pay in / out** + **Close shift**; **Shifts** for supervisors; a short outcome after each action ("Shift opened", "Pay out RM 15.00 recorded", "Shift closed") that clears after 8 s. The sheets and the drawer render through `createPortal(…, document.body)`, so they do not inherit the header's `text-xs text-brown-muted`; the header's right group wraps (`flex-wrap`) when the bar is full. A failed status read shows "Shift: <error> Try again" and offers nothing that moves money.

- [ ] **Step 1: Write the bar.** Create `src/features/pos/shift/ShiftBar.tsx` (the close sheet keeps the shift it was opened for: a status read meanwhile — the shift now closed — must not unmount it before the cashier has seen the report):

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { fetchShiftStatus } from './shiftApi'
import { shiftLabel, staleShiftNote, type OpenShift, type ShiftStatus } from './shift'
import OpenShiftSheet from './OpenShiftSheet'
import CashMoveSheet from './CashMoveSheet'
import CloseShiftSheet from './CloseShiftSheet'
import ShiftsDrawer from './ShiftsDrawer'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
type Sheet = 'open' | 'move' | 'shifts' | null
const NOTE_MS = 8_000                              // "Shift opened" and the like fade after a while

/** The shift part of the POS top bar: Open shift, or "Shift open · since 09:02" with Pay in / out
 *  and Close shift; Shifts for supervisors. Read again whenever the POS page refreshes
 *  (`refreshKey`: a bill changed here or on another iPad, and every 15 s). The sheets render
 *  into document.body, so they do not take the header's small muted text. */
export default function ShiftBar({ branchId, refreshKey, canSupervise }: { branchId: string; refreshKey: number; canSupervise: boolean }) {
  const [status, setStatus] = useState<ShiftStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sheet, setSheet] = useState<Sheet>(null)
  const [note, setNote] = useState<string | null>(null)
  // kept from when Close shift was pressed: a status read meanwhile (the shift now closed) must not unmount the sheet
  const [closing, setClosing] = useState<{ shift: OpenShift; openBillCount: number } | null>(null)
  const seq = useRef(0)

  const load = useCallback(async () => {
    const id = ++seq.current                       // only the newest reply counts
    try {
      const s = await fetchShiftStatus()
      if (id === seq.current) { setStatus(s); setError(null) }
    } catch (e) { if (id === seq.current) setError(msg(e)) }
  }, [])
  useEffect(() => { void load() }, [load, refreshKey])
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), NOTE_MS)
    return () => clearTimeout(t)
  }, [note])

  const closeSheet = () => { setSheet(null); setClosing(null); void load() }
  const btn = 'rounded border border-border px-3 py-1'
  const stale = status ? staleShiftNote(status) : null
  return (
    <>
      {error ? (
        // without a known shift nothing that moves money is offered
        <span role="alert" className="text-red-700">Shift: {error} <button className="underline" onClick={() => void load()}>Try again</button></span>
      ) : !status ? (
        <span>Shift…</span>
      ) : !status.shift ? (
        <button onClick={() => { setNote(null); setSheet('open') }} className="rounded bg-brown-btn px-3 py-1 text-white">Open shift</button>
      ) : (
        <>
          <span className="font-medium text-brown-dark">{shiftLabel(status)}</span>
          {stale && <span role="status" className="rounded bg-amber-100 px-2 py-0.5 text-amber-800">{stale}</span>}
          <button onClick={() => { setNote(null); setSheet('move') }} className={btn}>Pay in / out</button>
          <button onClick={() => { setNote(null); setClosing({ shift: status.shift as OpenShift, openBillCount: status.openBillCount }) }}
            className={btn}>Close shift</button>
        </>
      )}
      {note && <span role="status" className="text-green-800">{note}</span>}
      {canSupervise && <button onClick={() => setSheet('shifts')} className={btn}>Shifts</button>}
      {createPortal(
        <>
          {sheet === 'open' && status && (
            <OpenShiftSheet lastFloatSen={status.lastFloatSen} onClose={closeSheet}
              onOpened={(s) => { seq.current++; setStatus(s); setSheet(null); setNote('Shift opened') }} />
          )}
          {sheet === 'move' && (
            <CashMoveSheet branchId={branchId} onClose={closeSheet} onRecorded={(text) => { setNote(text); closeSheet() }} />
          )}
          {closing && (
            <CloseShiftSheet branchId={branchId} shift={closing.shift} openBillCount={closing.openBillCount}
              onClose={closeSheet} onClosed={() => { setNote('Shift closed'); closeSheet() }} />
          )}
          {sheet === 'shifts' && <ShiftsDrawer onClose={() => setSheet(null)} />}
        </>,
        document.body,
      )}
    </>
  )
}
```

- [ ] **Step 2: Put it in the top bar.** In `src/features/pos/order/PosPage.tsx` make exactly these replacements (each old text occurs once):

1. Replace

```tsx
import MyPinDialog from '../checkout/MyPinDialog'
```

   with

```tsx
import MyPinDialog from '../checkout/MyPinDialog'
import ShiftBar from '../shift/ShiftBar'
```

2. Replace

```tsx
        <div className="flex items-center gap-3 text-xs text-brown-muted">
          <PrintHostPanel branchId={branchId} />
```

   with

```tsx
        <div className="flex flex-wrap items-center justify-end gap-3 text-xs text-brown-muted">
          <ShiftBar branchId={branchId} refreshKey={refreshKey} canSupervise={can('pos_supervise')} />
          <PrintHostPanel branchId={branchId} />
```


- [ ] **Step 3: Gates.** Run: `npx vitest run` — Expected: 100 files, 874 tests pass. Run: `npx tsc -b` — Expected: no output. Run: `wc -l src/features/pos/order/PosPage.tsx` — Expected: `232`.

- [ ] **Step 4: Commit**

```bash
git add src/features/pos/shift/ShiftBar.tsx src/features/pos/order/PosPage.tsx
git commit -m "feat(pos-shift): the shift in the POS top bar — open, pay in / out, close, past shifts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5 (controller, craft-os-dev — browser on the dev server (launch entry `craft-os-dev`) and the SQL editor; the implementer does not touch the database):** test login (owner of the Demo branch; set **My PIN** first if it has none) → `/pos`. If Task 2's snippet opened a shift, close it first (Step 5.6) and start again.
  1. **No shift:** the bar shows **Open shift** and **Shifts**. Pick a table with an open bill (or place an order: ordering works) → **Checkout** → Cash → **Pay** → the sheet says "Open the shift first"; nothing is paid. **Today's bills** → a paid bill (if one is listed) → **Refund** → approve → "Open the shift first".
  2. **Open:** **Open shift** → the field holds the last closed shift's float (empty when the branch never closed one) → clear it → **Open shift** → "Enter the opening float (RM 0.00 to RM 100000.00)" → `100` → **Open shift** → the sheet closes, "Shift opened", the bar reads "Shift open · since HH:MM" (now, Malaysia time). A second tab on `/pos` shows the open shift within 15 s. SQL: `select opening_float_sen, status from pos_shifts where branch_id = (select id from branches where name = 'Demo')` → `10000 open`. Press **Open shift** in a tab that still shows it (before its refresh) → "A shift is already open — opened by <name> at HH:MM".
  3. **Pay in / out:** **Pay in / out** → Pay in, `20`, reason empty → **Record pay in** → "Enter a reason" → `Float top-up` → "Pay in RM 20.00 recorded". Again → **Pay out**, `15`, `Ice` → **Next: approval** → the dialog has no reason field and says "Pay out RM 15.00 · Ice" → approver, a wrong PIN → "Wrong PIN — 4 tries left" (nothing recorded) → **Cancel** → kind, amount and reason can be changed again → **Next: approval** → the right PIN → "Pay out RM 15.00 recorded"; the note beside the bar is gone about 8 s later. DevTools → Network → **Offline** → a pay in of `5`, reason `Coins` → "Not sure it was recorded (no reply)…", the fields stay locked → **No throttling** → **Record pay in** again → "Pay in RM 5.00 recorded", once (SQL: `select kind, amount_sen, reason from pos_cash_moves order by created_at` shows it once).
  4. **The stale note:** SQL `update pos_shifts set opened_at = now() - interval '21 hours' where status = 'open' and branch_id = (select id from branches where name = 'Demo')` → within 15 s the bar adds the amber "This shift was opened yesterday — close it"; set it back with `opened_at = now() - interval '1 hour'` → the note goes.
  5. **Shifts as a cashier:** (if a staff login without Approve POS voids & refunds is at hand) the bar has no **Shifts** button. **The bar on an iPad:** DevTools → device toolbar at 1024 × 768 → with a shift open (and the amber note from 5.4 back for a moment) the header's buttons wrap to a second line instead of running off the screen; the sheets' buttons and text are the normal size (not the header's small muted text).
  6. **Close within the limit:** with one open bill left on a table, **Close shift** → "1 bill is still open — it stays open for the next shift" → **Continue** → the count field shows no expected amount → enter the float + pay ins − pay out (`110.00` for 100 + 20 + 5 − 15, if nothing was paid by cash in this shift) → **Close shift** → "Shift closed. Z report sent to the receipt printer" (or "Not printed — no receipt printer set") and the report on screen. The print host (the iPad page or the Node agent) prints the same content, wrapped at its own width. **Done** → the bar shows **Open shift**; the open bill is still on its table.
  7. **Shifts:** **Shifts** → the closed shift with its nett sales and "Exact" (or its difference) → open it → the same report → **Reprint** → "Z report sent to the receipt printer"; the printer prints it with `*** REPRINT ***`.

---

### Task 8: POS settings → Shifts (the cash variance limit)

**Files:**
- Create: `src/features/pos/shift/ShiftSettingsSection.tsx`
- Modify: `src/features/pos/order/PosSettingsPage.tsx`

**Interfaces:**
- Consumes: `fetchCashVarianceLimit`, `saveCashVarianceLimit` (Task 4), `limitProblem`, `senToText`, `parseRinggit`.
- Produces: a **Shifts** section after the checkout sections of `/pos/settings`: "Cash variance limit (RM)", **Save shift settings**, the outcome beside the button; a failed load shows the error with **Try again** and no Save.

- [ ] **Step 1: Write the section.** Create `src/features/pos/shift/ShiftSettingsSection.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { parseRinggit } from '../checkout/tender'
import { fetchCashVarianceLimit, saveCashVarianceLimit } from './shiftApi'
import { limitProblem, senToText } from './shift'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** POS settings → Shifts: the branch's cash variance limit (access_settings, like the other branch settings). */
export default function ShiftSettingsSection({ branchId }: { branchId: string }) {
  const [text, setText] = useState<string | null>(null)        // null while loading or after a failed load
  const [loadError, setLoadError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const seq = useRef(0)

  const load = useCallback(async () => {
    const id = ++seq.current
    setLoadError(null); setText(null)
    try { const sen = await fetchCashVarianceLimit(branchId); if (id === seq.current) setText(senToText(sen)) }
    catch (e) { if (id === seq.current) setLoadError(msg(e)) }
  }, [branchId])
  useEffect(() => { void load() }, [load])

  const save = async () => {
    if (text === null) return
    const problem = limitProblem(text)
    if (problem) { setOutcome({ ok: false, text: problem }); return }
    if (running.current) return
    running.current = true; setBusy(true); setOutcome(null)
    try {
      const sen = parseRinggit(text) ?? 0
      await saveCashVarianceLimit(sen)
      setOutcome({ ok: true, text: 'Shift settings saved' })
      setText(senToText(sen))                      // "2" shows as "2.00"; no reload, which would hide the outcome
    } catch (e) { setOutcome({ ok: false, text: msg(e) }) } finally { running.current = false; setBusy(false) }
  }

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="font-semibold">Shifts</h2>
      <p className="text-xs text-brown-muted">
        At close the cashier counts the cash without seeing the expected amount. A count further off than this limit
        needs a supervisor's PIN and a reason.
      </p>
      {loadError && (
        <p role="alert" className="mt-3 rounded bg-red-50 p-3 text-sm text-red-700">
          Could not load the shift settings: {loadError} <button className="underline" onClick={() => void load()}>Try again</button>
        </p>
      )}
      {!loadError && text === null && <p className="mt-2 text-sm text-brown-muted">Loading…</p>}
      {text !== null && (
        <>
          <label className="mt-2 block text-sm">Cash variance limit (RM)
            <input inputMode="decimal" className="ml-2 w-28 rounded border border-border p-1" value={text}
              onChange={(e) => { setText(e.target.value); setOutcome(null) }} />
          </label>
          {outcome && (
            <p role={outcome.ok ? 'status' : 'alert'}
              className={`mt-3 rounded p-3 text-sm ${outcome.ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700'}`}>{outcome.text}</p>
          )}
          <button onClick={() => void save()} disabled={busy} className="mt-3 rounded bg-brown-btn px-3 py-2 text-sm text-white disabled:opacity-40">
            {busy ? 'Saving…' : 'Save shift settings'}
          </button>
        </>
      )}
    </section>
  )
}
```

- [ ] **Step 2: Put it on the settings page.** In `src/features/pos/order/PosSettingsPage.tsx` make exactly these replacements (each old text occurs once):

1. Replace

```tsx
import MenuCatalogsSection from './MenuCatalogsSection'
```

   with

```tsx
import MenuCatalogsSection from './MenuCatalogsSection'
import ShiftSettingsSection from '../shift/ShiftSettingsSection'
```

2. Replace

```tsx
      <CheckoutSettings branchId={branchId} routes={routes.map((r) => r.route)} tables={tables} />
```

   with

```tsx
      <CheckoutSettings branchId={branchId} routes={routes.map((r) => r.route)} tables={tables} />

      <ShiftSettingsSection branchId={branchId} />
```


- [ ] **Step 3: Gates.** Run: `npx vitest run` — Expected: 100 files, 874 tests pass. Run: `npx tsc -b` — Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/features/pos/shift/ShiftSettingsSection.tsx src/features/pos/order/PosSettingsPage.tsx
git commit -m "feat(pos-shift): POS settings → Shifts — the cash variance limit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5 (controller, craft-os-dev — browser on the dev server and the SQL editor; the implementer does not touch the database):** `/pos/settings` → **Shifts** shows `5.00`. Enter `10000.01` → **Save shift settings** → "Enter a cash variance limit between RM 0.00 and RM 10000.00" beside the button; `2` → "Shift settings saved" stays beside the button and the field reads `2.00`; reload → `2.00`. SQL: `select cash_variance_limit_sen from branch_pos_settings where branch_id = (select id from branches where name = 'Demo')` → `200`. Set it back to `5.00` → saved → `500`. DevTools → Network → **Offline** → reload the page section (navigate away and back) → "Could not load the shift settings: … Try again" and no Save button → **No throttling** → **Try again** → `5.00`.

---

### Task 9 (controller only): the spec's browser run on craft-os-dev

- [ ] **Step 1 (controller, craft-os-dev — browser on the dev server, the print host, the SQL editor; the implementer does not touch the database):** the spec's run, end to end, on the Demo branch with the print host running (the iPad page's print host panel, or the Node agent):
  1. **Open shift** with the prefilled float (the last shift's, from Task 7) → keep it (e.g. `100.00`).
  2. Orders: a counter dine-in order on one table (2 items), a takeaway at the counter (1 item), and a QR order on another table from a phone.
  3. Checkout: the table by **Cash** with cash received above the total (note the change), the takeaway by **Maybank Terminal**, the QR table half cash, half card.
  4. **Pay out** RM 10.00 "Ice" with a supervisor's PIN.
  5. **Today's bills** → refund RM 2.00 of the cash bill (Cash) with approval → the refund slip prints.
  6. Work out the expected cash by hand: float + the cash amounts paid (not the cash received) − 2.00 − 10.00. **Close shift** → count RM 7.00 less than that → the sheet shows Counted / Expected / "Short RM 7.00" and "More than RM 5.00 off: a supervisor approves …" → **Count again** → count exactly the expected cash → "Exact" and "A supervisor still approves, because the first count was more than RM 5.00 off." (the shift stays open) → **Count again** → count RM 6.00 less → "Short RM 6.00" → **Approve difference** → reason "Till miscount", supervisor PIN → "Shift closed. Z report sent to the receipt printer". The printed report: 3 bills; nett sales = the three bills' totals; Payments with Cash net of the RM 2.00 refund; Order type Dine-in (2) / Takeaway (1); Source Counter (2 orders) / QR (1 order); Cash drawer with the pay out, Expected, **First count** (7.00 short) and Counted (6.00 short), Variance -6.00 with the reason and approver; Refunds with the bill; Product sales most sold first.
  7. SQL: `select first_count_sen, counted_cash_sen, expected_cash_sen, variance_sen, variance_reason from pos_shifts where branch_id = (select id from branches where name = 'Demo') order by opened_at desc limit 1` → the numbers of the sheet; `select count(*) from payments where shift_id is null and taken_at > now() - interval '1 hour'` → `0`.
  8. **Shifts** → the shift on top → **Reprint** → the printer prints `*** REPRINT ***` and the same report.
  9. Record in the ledger: the report photo or its lines, the expected cash worked out by hand against the server's, and whether both print hosts printed it (agent and iPad page, if both are at hand).

---

## Execution notes for the controller

- Tasks 1–2 are SQL; Task 2 lands it on dev (Step 5). Tasks 3–6 are local (no database). Task 7 is the first visible change and needs Task 2's SQL; Tasks 7–8 end with a browser check on dev; Task 9 is the spec's browser run.
- Every step that reads or writes craft-os-dev (Task 2 Step 5, Task 7 Step 5, Task 8 Step 5, Task 9) is the controller's; implementers stop at `tsc` / `vitest` / commit.
- **Between Task 2's apply and Task 7** checkout and refunds on dev are refused ("Open the shift first"); Task 2 Step 5 gives the one-line SQL that opens a shift for a demo in between.
- **Checked while planning:** both migrations and the verify script were run on a throwaway local PostgreSQL 18 (Supabase stubs: `auth.uid()` from `request.jwt.claims`, `anon` / `authenticated` roles, `pgcrypto` in `extensions`, the `supabase_realtime` publication, the staff authority guard, a `storage` schema) after every earlier POS migration: both files apply twice; all seven verify scripts print `VERIFY OK` (the checkout verify only with Task 2's fixture block — without it, it stops at "Open the shift first"). Each of these mutations makes the shifts verify fail at the matching check: `refund_bill` from a re-run of checkout-fixes (A); the first count replaced on every call (F); cash payments counted by what was tendered (E); a refund not stamped, or without its kind (E); the pay-out PIN not checked (E); pay out left out of the expected cash (E); a limit check that lets −6.15 through (F); `needsApproval` never answered (F); voided items in the product sales or the source value (F); a reason kept within the limit (H); a close resend refused instead of answered (G); a cash-move resend with another amount accepted (E); the Shifts list open to a cashier (I); no "no printer" check (H). After the plan review (2026-10-24) the run was repeated on the revised files, with these too: a re-count within the limit closing without approval after a first count above it (F); an approval of a stale expected cash going through, or spending a PIN try (F); the paid bill not stamped (E), or a shift's bills taken from its payments, which drops the RM 0.00 bill (H); the float's RM 100000.00 cap removed (C); an INSERT privilege on `pos_cash_moves` for `authenticated` (A); the function file's STOP guard run on a database without `refund_bill` (its STOP message, not a raw error). pg-safeupdate itself was not available there — the Vitest scan stands in for it. The client side was replayed task by task on a scratch copy (the test counts above; `npx tsc -b` clean after every task); the screens were not run against a database while planning — Tasks 7–9 are their first run.
- The browser checks use the Demo branch's normal flow (no `[TEST]` rows); the shifts, cash moves and refunds they make stay on dev — nothing is deleted.
- **Prod rollout (owner's decision, later):** run `migration-2026-10-24-pos-shifts.sql` then `migration-2026-10-24-pos-shifts-fn.sql` on prod **right before** the first deploy from main that carries Task 7, and open the first shift on each branch's POS right after the deploy (until then checkout is refused). Nothing to backfill: old bills, payments and refunds keep `shift_id` null and appear in no report. The verify script is dev-only.

## Open points (choices made while planning, 2026-10-24 — each can be changed later)

1. **A difference of exactly the limit closes without approval** (`|variance| > limit` needs it), and a limit of RM 0.00 makes every difference need approval. **Once the first count is above the limit, the approval stays** for any later count (Resolutions); if the owner prefers that a correct re-count closes on its own, it is the one `v_above` line in `close_shift` and the verify F re-count check.
2. **Nett sales are the bills' totals** (tax, service charge, takeaway fee and rounding included); refunds are listed apart and not taken off Nett, as Feedme's Close up shows them.
3. **Void bills count every bill voided in the shift**, an empty bill opened by mistake too; *Total void* is the value of the voided items.
4. **The blind count is procedural**: `pos_current_shift` never sends the expected cash, but `payments` / `refunds` stay readable to signed-in staff (Sub-plan 3's `pos_read`), so a determined cashier could add them up.
5. **Other iPads see a shift open or close within 15 s** (the POS page's sweep) or at once on any bill change; no Realtime on `pos_shifts` (it has no read policy).
6. **Pay in / Pay out reasons are free text**; reason templates stay for voids and refunds.
7. **The approver of a pay out or a variance** is any live staff of the branch with Approve POS voids & refunds (the existing `pos_check_approver`, whose words mention voids and refunds); the cashier may be that person if they hold it, as for voids.
8. **Open shift has no client id**: a resend after a lost reply is refused with "A shift is already open — opened by <you>", and the bar reloads.
9. **The cash variance limit** has its own section and RPC (`save_shift_settings`) instead of joining the receipt settings.
10. **The race is checked by its lock modes**, not by two live sessions: the verify script pins `FOR SHARE` in the three money functions and `FOR UPDATE` in `close_shift`. Share lockers are not queued behind a waiting `FOR UPDATE`, so a steady stream of overlapping checkouts could keep a close waiting; at closing time that is negligible.
11. **Today's bills still lists the Malaysian day**, not the shift; a refund of an older bill is not reachable from the POS yet (it would land in the shift open then, as the verify checks).
12. **X report, denominations, cash drawer kick, several drawers, e-Invoice export** — Sub-plan 4b or later (spec "Out").
13. **Voids made while no shift is open are in no Z report** — e.g. a QR order voided before the morning **Open shift** or after the night close (ordering and voids keep working without a shift; no money moves). Refusing voids without a shift would re-create `void_order_item` / `void_bill`, outside this plan's "only checkout and refund change"; the owner may accept the gap or ask for it in 4b.
14. **Average per pax** divides all the shift's bills' nett (takeaways included) by the dine-in pax only (takeaways have no pax), as the spec's Summary lists it; computing it over dine-in bills only would be one line in `pos_shift_report` if the owner prefers.

## Self-review (2026-10-24)

- **Spec coverage:** Owner decision 1 (one shift a day, shared by the branch's iPads) → `pos_shifts_one_open`, verify D; 2 (no money without a shift; ordering keeps working) → `checkout_bill`, `refund_bill`, `record_cash_move`, verify C and G; 3 (blind count, limit RM 5.00, PIN and reason) → `close_shift`, `pos_current_shift`, Task 6, verify F/H; 4 (Pay in / Pay out recorded, in the expected cash) → `record_cash_move`, `pos_shift_expected_cash`, Task 5, verify E; 5 (the server stamps `shift_id`; voids by time) → the `4a` lines (payments, refunds and the paid bill), `pos_shift_report`, verify E/F/H; 6 (Close up layout; old bills' refunds to the shift open then) → Task 3, verify H. Data model → Task 1 (plus `report_printed`, so a resend of the close answers without printing twice). Flows: Open shift with the last float → Task 5/7; "already open" words → verify D; stale note → `staleShiftNote` (Task 4) and Task 7; the open-bills warning → Task 6; first count kept and shown → verify F, `renderZReportLines`; a re-count after a first count above the limit still approved, and an approval of a changed expected cash refused with the new figures → `close_shift`, `approvalNote`, Task 6, verify F; not printed → `printedNote`, verify H; closed shift immutable → trigger, verify G; Shifts drawer (last 30, date, opened/closed by, nett, variance, Reprint) → Task 6, verify I. Z report sections: header, summary, sales summary, payments (count, amount, refunds, net), order type, source, cash drawer, voids, refunds, product sales → `pos_shift_report` and Task 3, every one asserted in verify F. Permissions → Global Constraints and verify E/F/I. SQL rules → Global Constraints and Task 1 Step 7. Testing: every SQL bullet → Task 2 (the race by its lock modes, see Open point 10); Vitest — the Z report layout (Task 3), amount parsing and the banner rules (Task 4); the browser run → Task 9.
- **No placeholders:** every file is given in full or as exact replacements; every command has its expected output; the only values the controller fills in are the times and amounts read on dev.
- **Names and signatures** are the same in the SQL, the verify script, `shift.ts`, `shiftApi.ts`, `zreport.ts` and the sheets (`pos_current_shift`, `open_shift`, `record_cash_move`, `close_shift`, `pos_shift_list`, `pos_shift_zreport`, `reprint_zreport`, `save_shift_settings`; JSON keys `openedAt`, `openedByName`, `openingFloatSen`, `openBillCount`, `lastFloatSen`, `needsApproval`, `expectedSen`, `varianceSen`, `limitSen`, `printed`, `report`; the `ZReport` keys; `close_shift`'s sixth argument `p_expected_sen` in the function, its grants, verify A/C/F/G/H and `closeShift`). The words match between `shift.ts` and the functions ("Enter the opening float (RM 0.00 to RM 100000.00)", "Enter the counted cash (RM 0.00 to RM 100000.00)", "Enter the amount (RM 0.01 to RM 100000.00)", "Enter a reason", "Enter a reason for the difference" (the approval dialog's `reasonMissing`), "Reason is too long", "Enter a cash variance limit between RM 0.00 and RM 10000.00").
- **Re-created functions in full:** `checkout_bill` and `refund_bill` only, each the live text plus the `4a` lines (Task 1 Step 6 diffs them).
- **Plan review (2026-10-24):** its three Important findings are applied — the approval stays after a first count above the limit (I1), `close_shift` takes the expected cash the approver saw (I2), a bill is attributed by `bills.shift_id` (I3) — each with a verify check that fails when its fix is taken out; every Minor too (M7, voids outside a shift, and the *Average per pax* basis as Open points 13–14, as the review allows), with the spec updated where I1–I3 change it.
- **pg-safeupdate:** every UPDATE in the function file has a WHERE (`close_shift`: three, by id; `save_shift_settings`: by branch); there is no DELETE; the trigger function writes nothing; the Vitest scan checks both files (Task 1 Step 7).
