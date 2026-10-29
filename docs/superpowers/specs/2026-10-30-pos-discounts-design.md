# POS discounts — design

Date: 2026-10-30 · Branch: `feature/pos-demo` · Readiness item: W2 in
`docs/pos/2026-10-29-feedme-replacement-readiness.md` · Owner approved all three parts in chat on 2026-10-30.

## Goal

Cashiers can give a supervisor-approved discount on one item or on the whole bill, and the Staff Meal
catalog sells at 50% off without anyone keying a discount. Service charge, SST, rounding, receipts, the Z report
and later the e-invoice and Accounting module all use the discounted amounts.

Feedme reference: Feedme's Staff Meal catalog keeps the normal prices (e.g. Baked Salmon Steak 43.00) and the
50% is a separate discount. Feedme's bill discount is Amount or Percent, quick buttons 5 / 10 / 20 / 50, capped at
the subtotal, with a reason. We follow the same shape.

## Decisions

- Three kinds of discount:
  1. **Catalog discount** — a percentage set on a menu catalog (Staff Meal = 50%). Every item ordered from that
     catalog gets it automatically. No PIN.
  2. **Item discount** — at most one per order item. Amount or percent. Supervisor PIN and reason.
  3. **Bill discount** — at most one per bill. Amount or percent, quick buttons 5 / 10 / 20 / 50%. Supervisor PIN
     and reason. No maximum percentage.
- Discounts are stored as data on the catalog, item and bill, and the server computes the money (approach A).
  Rejected: a negative line item (no SST rate to tax it at, service charge comes out wrong, reports get messy) and a
  discount applied only on the payment screen (not visible before payment, two tablets disagree).
- A Staff Meal bill can still take item and bill discounts, each with a PIN.
- Removing a discount needs no PIN (it only raises the price) but is logged with who removed it.
- Discounts lock once the bill is paid. Refunds work as today, against the paid total.
- The takeaway packaging fee is never discounted.
- A bill with a bill discount cannot be merged into another bill; remove the discount first. Item discounts
  travel with their items. Moving a bill to another table is not affected.

## Money rules

All money is integer sen, all rates are basis points (bp), as in `bill.ts` today. Per live (not voided) line:

1. **Line amount** = `unitPriceSen × qty`.
2. **Catalog discount** = `round(lineAmount × catalogDiscountBp / 10000)`. After it: `afterCatalog`.
3. **Item discount** applies to the whole line, not per unit.
   - Percent: `round(afterCatalog × bp / 10000)`.
   - Amount: `min(valueSen, afterCatalog)`.
   - After it: `lineNet` (the line's subtotal amount).
4. **Subtotal** = Σ `lineNet`.
5. **Bill discount**:
   - Percent: `round(subtotal × bp / 10000)`.
   - Amount: `min(valueSen, subtotal)`.
6. **Allocation.** The bill discount is shared over the live lines in proportion to `lineNet`:
   - Each line first gets `floor(billDiscount × lineNet / subtotal)`.
   - The leftover sen go to the line with the largest `lineNet`. Ties go to the earlier line in bill order. If that
     line has no room left, the rest go to the next largest, and so on, so no line ever goes below zero.
   - `lineFinal = lineNet − share`.
   - When the subtotal is 0 the bill discount is 0 and nothing is shared.
7. **Service charge** per the first matching rule, as today, on `lineFinal` instead of the line amount.
8. **SST** per rate, as today, on `lineFinal` plus the packaging fee of takeaway lines. No SST on service charge.
9. **Before rounding** = `subtotal − billDiscount + serviceCharge + SST + packagingFee`.
10. **Rounding** to the nearest 5 sen, as today.

`round` is half-up on non-negative numbers (`Math.round` in TypeScript, `round()` on numeric in SQL), the same
as the service-charge and SST groups today.

A percent discount is recomputed every time the bill is computed, so adding or voiding items changes it. An amount
discount keeps its stored value and is capped at what is left, so the bill can never go below zero. If items come
back the cap lifts again.

With no discounts every number equals today's, so the existing bill vectors stay valid.

## Data

New migration `supabase/migration-2026-10-30-pos-discounts.sql` with its `-verify.sql`.

- `menu_catalogs.discount_bp integer not null default 0 check (discount_bp between 0 and 10000)`.
- `order_items.catalog_discount_bp integer not null default 0`, the catalog's discount_bp copied when the item is
  ordered (in `pos_insert_order`, from the order's catalog). Changing a catalog later does not touch items already
  ordered.
- `order_items` item discount: `discount_kind text` (`'amount' | 'percent'`), `discount_value integer` (sen for
  amount, bp for percent), `discount_reason text`, `discount_approved_by uuid`, `discount_by uuid`,
  `discount_at timestamptz`. A check keeps them all null or kind, value, reason, approved_by, by and at all set.
  Amount > 0; percent between 100 and 10000 in steps of 100 (whole percent 1–100).
- `bills` bill discount: the same six columns with the same checks.
- `pos_discount_log` (append-only): `id`, `branch_id`, `bill_id`, `order_item_id` (null for a bill discount),
  `action` (`'set' | 'clear'`), `kind`, `value`, `reason`, `approved_by`, `actor`, `created_at`. Written only by
  the RPCs below. Read policy: the same outlets that may read the bill. This also feeds the discount report in W3.
- `reason_templates.action` check gains `'discount'`.

## Server

Four RPCs, written like `void_order_item` (security definer, `pos_my_branch()` for the outlet, `pos_actor()` for
who acts — never `auth.uid()`, which `sqlSafeUpdate.test.ts` guards — bill row locked `for update`, every
UPDATE with a WHERE):

- `set_item_discount(p_item_id uuid, p_kind text, p_value integer, p_reason text, p_approver_id uuid, p_pin text) returns jsonb`
- `clear_item_discount(p_item_id uuid) returns jsonb`
- `set_bill_discount(p_bill_id uuid, p_kind text, p_value integer, p_reason text, p_approver_id uuid, p_pin text) returns jsonb`
- `clear_bill_discount(p_bill_id uuid) returns jsonb`

Rules:
- Only on an open bill of the caller's outlet; a voided item cannot be discounted. Error words:
  "Only an open bill can be discounted".
- Reason through `pos_check_reason(branch, 'discount', reason)`; PIN through `pos_check_approver`, so the approver
  must hold `pos_supervise`. A wrong PIN returns `{ok: false, error}` as voids do.
- Setting again replaces the existing discount of that item or bill; it never stacks.
- Clearing an item or bill that has no discount returns `{ok: true}` (a retry).
- Each call writes one `pos_discount_log` row and sets `bills.updated_at = now()` so other tablets hear of it at once.
- `merge_bills` refuses when the source bill has a bill discount: "Remove the bill discount before merging".

Bill math:
- `BillLineInput` gains `id?: string`, `catalogDiscountBp: number`, `discount: { kind: 'amount' | 'percent'; value: number } | null`.
- `BillInput` gains `billDiscount: { kind: 'amount' | 'percent'; value: number } | null`.
- `BillTotals` gains `grossSen` (Σ line amounts), `catalogDiscountSen`, `itemDiscountSen`, `billDiscountSen` and
  `lines: { id, catalogDiscountSen, itemDiscountSen, billShareSen, netSen }[]` in input order. `subtotalSen` becomes
  Σ `lineNet` (equal to today's value when there are no discounts).
- `computeBill` in `bill.ts` and `pos_compute_bill` in SQL follow the money rules exactly. `pos_bill_totals` passes
  the new fields. `billVectors.json` gains cases for: Staff Meal 50%; item plus bill discount; a bill discount over
  two SST rates; a percent discount then an item added; an amount discount then an item voided (cap); a takeaway
  fee line; leftover-sen allocation including a tie and a tiny bill where the largest line runs out of room; rounding.
  The verify SQL runs the same vectors through `pos_compute_bill`.
- `checkout_bill` and `refund_bill` keep working on the server totals; no change beyond the new fields.

## Screens

All UI copy in English.

- **Order screen** (`OrderScreen.tsx`): tapping a sent line offers **Discount item** next to Void item; the bill
  actions offer **Discount bill** next to Void bill. When a discount exists the actions read **Edit discount** and
  **Remove discount**; Remove asks one "Remove this discount?" confirm, no PIN.
- **Discount dialog** (one dialog for both): an **Amount | Percent** switch; Percent shows quick buttons
  5 / 10 / 20 / 50 and a numpad; a live line such as "−RM 4.30"; then the reason picker from the Discount reason
  template; then the existing `ApprovalDialog` for supervisor and PIN. Discounts need a connection, like voids.
- **Bill display** (order screen panel, payment screen, Transaction screen): under a discounted line a grey row
  "Staff Meal 50%  −RM 21.50" (catalog name from the order's catalog) or "Discount 10% (Regular)  −RM 1.20".
  Totals read: Subtotal, Discount (with reason), Service charge, SST, Rounding, Total. A bill with any catalog
  discount shows a small "Staff Meal 50%" tag at the top.
- **Back office**: Catalogs gets a **Discount %** field (0–100, whole numbers; `menu_save_catalog` saves it).
  Reason templates get a **Discount** section (`ReasonAction` and `ACTION_TITLES` gain `discount`).

## Printing and reports

- **Receipt** (`pos_receipt_payload`, `receipt.ts`): discount rows under lines ("Staff Meal 50%  −RM 21.50",
  "Discount 10%  −RM 1.20") and "Discount −RM x.xx" in the totals. No reason or approver name on the receipt.
- **Kitchen and bar tickets**: unchanged, no discounts.
- **Z report** (`pos_shift_report`, `zreport.ts`): a **Discounts** section with three rows — Staff Meal (catalog)
  total and bill count, item discounts total and count, bill discounts total and count — and a "Gross before
  discounts" line. Sales stay the discounted amounts actually charged.
- The full discount report (every discount, approver, reason) is part of W3 Sales reports, not this work.

## Later, not in this work

- E-invoice: when `feature/einvoice` is merged (W5), invoice lines must use `netSen` / the bill share, not the
  list price.
- Accounting: `BillTotals.lines` gives per-line, per-rate net amounts for ledger posting.

## Testing

- Vitest: `bill.test.ts` over the new vectors; dialog validation (amount > 0, percent 1–100, reason rules);
  receipt and Z report formatting.
- Verify SQL on **craft-os-dev only**: the shared vectors; set without PIN or with a wrong PIN is refused; a paid
  bill cannot be discounted; merge refused with a bill discount; clear without PIN works and is logged;
  `catalog_discount_bp` copied at order time and unchanged by a later catalog edit.
- On-site checks join the readiness testing step once the build items are done.
