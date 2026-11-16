# POS split bill and move items — design

Date: 2026-11-16 · Branch: `feature/pos-demo` · Status: approved by the owner in chat, awaiting spec review.

## 1. Goal

Several people at one table pay for their own items, each with their own receipt (Feedme "Split Bill").
The same screen also moves selected items to another table (Feedme "Separate Table").

Today the POS can only pay a whole bill (with several payments: Split payment), move a whole bill to a
free table (`move_bill`) and merge two bills (`merge_bills`).

## 2. Owner decisions (2026-11-01 and 2026-11-16)

- Split **by item**, with a quantity per line (1 of 3 lattes). No "split evenly by N".
- **Moving selected items to another table** is built at the same time, on the same item picker.
- A **bill discount follows the paid part pro rata**: a percent discount is copied; an amount discount is
  shared by value, and the parts add up to the original amount. No new supervisor PIN.
- Approach A: **"Pay selected" is one server call** that creates the paid part as its own bill, already paid.
  Rejected: several open sub-bills per table (B: breaks the one-open-bill-per-table rule, the home screen,
  QR routing, move and merge) and split-then-pay in two steps (C: leaves orphan bills when payment stops).
- Moving items out of a bill that has a bill discount is refused, as `merge_bills` refuses today.

## 3. Screens

### 3.1 Entry

Bill actions (`BillActionsOverlay`) get **Split / Move items**, shown for an open bill with at least two
item units that are not voided. It is disabled while the tablet is offline ("Split needs a connection"):
the server must price the part at the moment of payment.

### 3.2 Item picker (`SplitItemsScreen`, new)

- Lists every line of the bill that is not voided, in bill order: name, modifiers, note, line price.
- A line with qty 1 is a tick box. A line with qty > 1 has a stepper 0…qty ("2 of 3").
- **Select all** / **Clear**.
- Footer: the selected part's total, read from the server (§4.2) after each change (debounced 300 ms);
  shows "…" while loading and the server's message if it refuses.
- Two buttons, both disabled while nothing is selected:
  - **Pay selected** → the existing Payment screen in split mode (§3.3). When every unit is selected it opens
    the normal whole-bill Payment instead (no split).
  - **Move to table** → the existing table grid (`MoveToGrid`), current table hidden. When every unit is
    selected it runs the existing whole-bill move or merge flow instead.
- If the bill has a bill discount, Move to table is disabled with the note
  "Remove the bill discount before moving items".

### 3.3 Payment screen, split mode

`PaymentScreen` gets an optional `split: { items: SplitItem[] }` prop.

- Title: "Table T5 · Split" (or "Takeaway 261116-004 · Split").
- The left column lists only the selected units; totals come from `pos_split_totals` instead of
  `pos_checkout_state`'s totals.
- Pay calls `checkout_items` (§4.3) with a fresh checkout id per attempt, exactly as today's paySession.
- Cancel payment returns to the picker with the selection kept.
- After success: the receipt for the paid part prints as usual; **Done** returns to the table's bill, which
  now shows the remaining items (the realtime bills event refreshes it).
- The follow rules stay: if the table's bill is paid, voided or merged elsewhere, the screen locks with
  today's messages.

### 3.4 After a move

Back on the source bill, a toast says "Moved 2 items to T7". The target table shows the items at once
(realtime). No kitchen ticket is reprinted for a split or a move.

## 4. Server

One migration `supabase/migration-2026-11-16-pos-split-bill.sql` plus `-verify.sql`. Every new function is
`security definer`, `set search_path = public, pg_temp`, granted to `authenticated` only, and uses
`pos_my_branch()` / `pos_actor()` / `pos_current_device()` like the other front-of-house RPCs (they move to
`pos_ctx` together with the rest in W1 Part C).

### 4.1 Schema

```sql
alter table bills       add column if not exists split_from      uuid references bills(id);
alter table order_items add column if not exists split_from_item uuid references order_items(id);
-- pos_discount_log.action gains 'split'
```

- `bills.split_from` is set only on a paid part. `pax` stays null on it.
- `order_items.split_from_item` is set on a row created by cutting a line's quantity.
- The two insert triggers `order_items_catalog_discount` and `order_items_order_type` return `new`
  unchanged when `new.split_from_item is not null`: a cut row keeps the catalog discount and the line's
  order type it was ordered with, even if the catalog's Discount % changed since.
- `bills_one_open_per_table` is unchanged: a paid part is never open.

### 4.2 Selection input and preview

`p_items` is a JSON array `[{ "itemId": uuid, "qty": int }]`: each item at most once, qty 1…the line's qty.

A private helper `pos_split_check(v_bill bills, p_items jsonb)` validates it against the bill **under the
bill's row lock** and raises:

| Case | Message |
|---|---|
| Not an array, empty, more than 100 entries, bad uuid, qty not a whole number ≥ 1 | `Invalid selection` |
| Same item twice | `Invalid selection` |
| An item not on this bill, voided, or with fewer units than chosen | `The bill changed. Check the items again.` |
| Every unit of the bill selected | `Select fewer items, or pay the whole bill` |

A private helper `pos_split_input(p_bill_id, p_items)` returns the `pos_compute_bill` input for the selected
part: the same settings, rules, `orderType` and `tableId` as `pos_bill_totals`, the selected lines with
their chosen qty and their share of an item amount discount (§5), and the part's bill discount (§5).

`pos_split_totals(p_bill_id uuid, p_items jsonb) returns jsonb` (stable, read-only): checks the bill is the
caller branch's open bill, runs the check without a lock, returns `pos_compute_bill(pos_split_input(…))`.
The client never computes the part's money itself.

### 4.3 `checkout_items(p_bill_id uuid, p_items jsonb, p_payments jsonb, p_checkout_id uuid) returns jsonb`

In one transaction:

1. **Replay.** If a bill with `checkout_id = p_checkout_id` exists: it must have `split_from = p_bill_id`
   and the caller's branch, else `This checkout id belongs to another bill`; same payments
   (`pos_checkout_same_payments`) or the existing "already recorded with other amounts" message; then
   return `pos_checkout_result` of that paid part.
2. Lock the table's bill (`for update`), require `status = 'open'` (today's paid / voided / merged
   messages), take the open shift `for share` (`Open the shift first`), run `pos_split_check`. Look for
   the checkout id once more after the lock: a resend that waited behind the first call replays its result
   (step 1) instead of failing the check.
3. Totals `v_totals := pos_compute_bill(pos_split_input(…))`; validate payments against
   `v_totals.totalSen` with exactly checkout_bill's rules and messages.
4. Insert the paid part: new `bill_no` from `pos_next_bill_no`, same `branch_id`, `table_id`, `order_type`,
   `split_from = p_bill_id`, `status = 'paid'`, `checkout_id`, `shift_id`, `closed_*`, frozen `totals` and
   the six money columns, and its bill discount share (§5) with the original reason, approver, `discount_by`
   and `discount_at`.
5. Move the selected units (§4.5) to the paid part.
6. Reduce the table bill's amount discount by the part's share (§5); log both sides (§5).
7. Insert the payments (`bill_id` = the paid part) as checkout_bill does; queue the receipt; set
   `receipt_queued`; bump the table bill's `updated_at`.
8. Return `pos_checkout_result(paid part)`.

The payment-writing part of `checkout_bill` (validate + insert payments + freeze totals + queue receipt) moves
into one private helper used by both functions, so the two can never drift. `checkout_bill`'s behaviour
does not change.

### 4.4 `move_items(p_bill_id uuid, p_items jsonb, p_table_id uuid) returns jsonb`

1. Lock the source bill and, if one exists, the target table's open bill, in id order (as merge does).
2. Source must be open and have no bill discount (`Remove the bill discount before moving items`); run
   `pos_split_check`. Target table must be an active table of the branch and not the source's own table
   (`Invalid table`).
3. Target bill: the table's open bill, or a new open dine-in bill there (`pos_next_bill_no`, `pax = 1`,
   opened by the actor). A unique-violation race turns into `Table T7 just got a bill. Try again.`
4. Move the selected units (§4.5) to the target bill; bump `updated_at` on both bills.
5. Return `{ "targetBillId": …, "targetBillNo": …, "movedUnits": n }`.

No idempotency key: a move moves no money, the button is disabled offline, and the client does not retry
on a lost reply; it re-reads the bill instead. A resend that finds the items gone gets "The bill changed".

### 4.5 Moving units

For each selected entry:

- **Whole line** (qty chosen = line qty): `update order_items set bill_id = <to>` — the row keeps its id,
  `order_id`, discounts and void history.
- **Part of a line**: insert a copy with `qty = chosen`, `bill_id = <to>`, `split_from_item = <line>` and
  every snapshot column copied (`order_id`, product, variant, name, unit price, SST rate, modifiers, print
  route, note, takeaway fee, catalog discount, order type, item discount — amount shared per §5); then
  reduce the original row's `qty` (and its amount discount).

Items keep their `order_id`, so an order's source (Counter / QR) and catalog stay true on both bills. Every
screen and report reads lines by `order_items.bill_id` (bill column, receipt, Z report, QR table state);
the implementation plan re-checks each one.

## 5. Discount shares

All amounts in sen; "line net" = `unit_price × qty` after the catalog discount and the item discount, as
`pos_compute_bill` computes it.

- **Catalog discount** (`catalog_discount_bp`): a percent, copied to a cut row.
- **Item discount, percent:** copied to a cut row.
- **Item discount, amount** on a line of qty q, k units taken: the cut row gets `floor(value × k / q)`, the
  original keeps the rest. If the cut row's share is 0 it carries no discount (all six columns null).
- **Bill discount, percent:** the paid part gets the same percent; the table bill keeps it.
- **Bill discount, amount** V: share = `round(V × part base / bill base)`, where base = the sum of line nets
  of all non-voided lines (bill) or the selected units (part). The paid part gets the share; the table bill
  keeps `V − share`. A share of 0 means the part carries no bill discount; a remainder of 0 clears the
  table bill's discount.
- `pos_discount_log` gets one `action = 'split'` row per bill whose discount changed: on the paid part (its
  share) and on the table bill (its new value), with the original reason and approver and the actor who
  split.

Service charge, SST and 5 sen rounding are computed separately for the paid part and for the rest, by the
same `pos_compute_bill`, so each receipt adds up on its own.

## 6. Receipt, reports, QR

- **Receipt:** `pos_receipt_payload` adds `splitFrom: { billNo, table }` for a paid part, printed under
  the bill number as `Split from 261116-009 · T5`. Totals, discounts and payments print as for any bill.
- **Z report and sales:** a paid part is a normal paid bill (bills, payments, discounts, SST). Its pax is
  null, so covers are not counted twice. Bill count goes up by one per split.
- **Today's bills / refunds:** a paid part shows like any paid bill and can be refunded as usual.
- **QR table page:** shows the table bill's remaining items only.

## 7. Client

| File | Change |
|---|---|
| `src/features/pos/order/splitSelection.ts` (new) | Pure selection state: lines → selection, toggle, stepper, select all, `toSplitItems()`, "everything selected" |
| `src/features/pos/order/SplitItemsScreen.tsx` (new) | The picker (§3.2), server preview, both buttons |
| `src/features/pos/order/BillActionsOverlay.tsx` | Split / Move items entry, offline note |
| `src/features/pos/order/PosTill.tsx` | Routes picker → Payment (split) / MoveToGrid, then back to the bill |
| `src/features/pos/checkout/PaymentScreen.tsx` | Optional `split` prop: title, items, totals source, `checkoutItems` |
| `src/features/pos/checkout/checkoutApi.ts` | `splitTotals`, `checkoutItems` |
| `src/features/pos/order/posApi.ts` | `moveItems` |
| `src/features/pos/print/receipt.ts` | `splitFrom` line |

UI copy (English): "Split / Move items", "Pay selected", "Move to table", "Select all", "Clear",
"2 of 3", "Split needs a connection", "Remove the bill discount before moving items",
"The bill changed. Check the items again.", "Moved 2 items to T7", "Split from <bill no> · <table>".

## 8. Testing

- **SQL verify** (`-verify.sql`, ends with `VERIFY OK`), on a seeded test bill:
  1. Pay 1 of 3 lattes plus one whole line: paid part totals = `pos_split_totals`; table bill keeps 2
     lattes; row counts and `split_from_item` right; payments on the paid part.
  2. Replay with the same checkout id and payments returns the first result; other amounts are refused.
  3. Item amount discount RM 3.00 on qty 3, take 1 → 100 / 200 sen; take 2 of 3 with RM 1.00 → 66 / 34.
  4. Bill amount discount shared: parts add up to V; percent copied; log rows written.
  5. Every unit selected, a voided item, a stale qty, a duplicate item → the messages in §4.2.
  6. Move: to a free table (new bill, pax 1), to a table with a bill, source with bill discount refused,
     whole-line and part-line moves, catalog discount and order type kept on a cut row after the catalog's
     Discount % changed.
  7. Shift Z report: the paid part counted once, covers unchanged.
- **Client unit tests:** `splitSelection` (stepper bounds, select all, everything-selected), Payment screen
  split mode (title, uses `checkoutItems`, Cancel keeps the selection), picker buttons' disabled states.
- **Browser check on dev:** split-pay a table into two receipts, move items to a free and a busy table,
  two tablets: change the bill on one while the other has the picker open → "The bill changed".

## 9. Rollout

Dev first (SQL, verify, browser check, redeploy craft-pos-dev). On prod the migration joins the POS SQL
chain after `migration-2026-10-30-pos-discounts.sql` and runs before the app that uses it. `checkout_items`,
`move_items` and `pos_split_totals` are front-of-house RPCs and belong in W1 Part C's switch to `pos_ctx`.

## 10. Not in scope

- Split evenly by N people, or by amount.
- Several open bills on one table.
- Moving items between two takeaway bills, or from a table to takeaway.
- Offline split or move.
- Reprinting kitchen tickets for moved items.
