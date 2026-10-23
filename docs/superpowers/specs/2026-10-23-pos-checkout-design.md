# POS Demo · Sub-plan 3 — Checkout, payments, receipts, voids and refunds (design)

Date: 2026-10-23. Builds on `2026-10-22-pos-demo-design.md` (sections 金额计算, 结账, 错误处理原则) and on what exists after Sub-plan 2 (ordering). Informed by the Feedme back-office teardown (`docs/superpowers/research/2026-10-23-feedme-back-office-teardown.md`) and the real receipt #87846 (Craft Cafe Cheras, 22/10/2026).

Decisions taken overnight without the owner were marked for confirmation; the owner answered all five on 2026-10-24 (marked "Confirmed by the owner 2026-10-24" below). Answer 3 changed the packaging-fee rule (§2.5).

**Owner decisions 2026-10-24 (after the build review):**
- **Refunds go back the original route.** A refund may only go back by a payment method the bill was actually paid with, and never more than was paid by that method less what was already refunded by it. A bill paid Touch 'n Go 20.00 + Cash 22.90 can refund at most 20.00 by Touch 'n Go and 22.90 by Cash (cash counts the payment's amount, after change, not what was tendered). The method need not still be active at the branch. See §5 Refund.
- **Anyone at a shared iPad may set an account's first PIN.** `set_my_pos_pin` sets the signed-in account's PIN without a current PIN when it has none, so whoever is holding a signed-in iPad could set it first. Accepted for the pilot.

## 1. Scope

**In:** bill totals (subtotal, service charge, SST, takeaway packaging fee, rounding); checkout with one or more payments (cash with change, card terminal amount typed in, DuitNow, e-wallet); the customer receipt printed on the receipt printer and reprintable; voiding an item or a whole open bill (supervisor approval + reason); moving a bill to another table; merging two open bills; refunds on paid bills (supervisor approval + reason); a per-staff POS PIN; branch receipt details, service-charge rules, payment methods and reason templates managed on `/pos/settings`; an optional "staff must open the table before QR ordering" switch.

**Out (later or never for the demo):** discounts and change-price (Feedme roles have them; the spec excludes discount rules), split bill by item, deposits, tips, member pricing, terminal integration (amount typed by hand), shifts and Z report (Sub-plan 4), e-invoice export (Sub-plan 4), offline checkout.

## 2. Money rules (`computeBill`, mirrored in SQL `pos_bill_totals`)

All amounts are integer sen; rates are basis points. Rounding is half-up to the sen (`Math.round` on non-negative values = Postgres `round(numeric)`). The server result is the truth; the TS function exists for instant display and for shared test vectors.

1. `line = unit_price_sen × qty` for every non-voided item (`unit_price_sen` already includes modifier deltas).
2. `subtotal = Σ line`.
3. **Service charge — rules, not one rate** (Feedme models it this way). Each line takes the first matching rule of its branch, in `sort_order`: a rule matches when the bill's `order_type` is in `order_types`, the bill's table is in `table_ids` (or `table_ids` is null = all tables) and the item's product is in `product_ids` (or null = all products). `service_charge = Σ over rates of round(Σ lines with that rate × rate_bp / 10000)`. Lines with no matching rule pay none. Service charge is exclusive and applied to the pre-discount subtotal (no discounts exist). Demo seed: one rule, 10 %, dine-in, all tables, all products. **Confirmed by the owner 2026-10-24:** takeaway pays **no** service charge (the demo rule stays dine-in only; a branch may still add a takeaway rule).
4. **SST on the subtotal basis, per rate group:** `sst = Σ over sst_rate_bp of round(Σ lines with that rate × rate / 10000)`. SST is **not** charged on the service charge (verified on #87846: SST 6 % of 80.00 = 4.80, service charge 10 % of 80.00 = 8.00; Feedme's "Charges summary" shows both with base 80.00). On a takeaway bill each line's packaging fee joins its rate group's base (§2.5). If the branch is not SST-registered, SST is 0. **Confirmed by the owner 2026-10-24:** SST and service charge are rounded **per rate group**, not per line.
5. **Takeaway packaging fee:** for takeaway bills only, `Σ takeaway_fee_sen × qty`, using a value **snapshotted on the order item at order time** (new column `order_items.takeaway_fee_sen`; `pos_insert_order` fills it from `menu_products.takeaway_fee_sen` when the bill is takeaway). The fee is **SST-able at the line's rate**: `takeaway_fee_sen × qty` is added to the SST base of that line's `sst_rate_bp` group before the per-rate rounding (a 0 %-SST item's fee is untaxed; no SST at all when the branch is not SST-registered). No service charge on the fee. **Confirmed by the owner 2026-10-24:** the packaging fee carries SST (Feedme's "Packaging Fee 1.06" = 1.00 + 6 % SST).
6. `before_rounding = subtotal + service_charge + sst + takeaway_fee`.
7. **Rounding:** branch setting `cash_rounding` = `none` | `nearest_5_sen` (default `nearest_5_sen`). When on, the whole bill total is rounded to the nearest 5 sen (…1,2 → down; …3,4 → up to 5; …6,7 → down to 5; …8,9 → up), whatever the payment method, and `rounding_sen = total − before_rounding` (−2…+2). Receipt #87846 prints a "Bill rounding" line even for a Touch 'n Go payment. **Confirmed by the owner 2026-10-24:** whole-bill 5-sen rounding for **every** payment method.
8. `total = before_rounding + rounding_sen`.

First test vector (from #87846): lines 2400 + 2500 + 1800 + 1300, dine-in, 10 % SC rule, all at 6 % SST → subtotal 8000, service charge 800, SST 480, fee 0, rounding 0, **total 9280**.

## 3. Data model additions

- `branches`: `legal_name`, `registration_no`, `sst_no`, `phone`, `email` (nullable; receipt header; managers edit on `/pos/settings`). The receipt header uses the branch name (e.g. "Craft Cafe – Cheras" in Feedme; our `branches.name` is short, so a `receipt_title` column is added too).
- `branch_pos_settings` (one row per branch): `sst_registered` (default true), `cash_rounding`, `receipt_route` (print route name used for receipts; demo: `Bar`, the ZY301), `receipt_footer` (default "This is an official receipt. Thank you for visiting us."), `qr_requires_open_bill` (default false).
- `service_charge_rules`: `id, branch_id, rate_bp, order_types text[], table_ids uuid[] null, product_ids uuid[] null, sort_order, is_active`.
- `payment_methods`: `id, branch_id, name, kind` (`cash` | `card` | `duitnow` | `ewallet` | `other`), `needs_reference, sort_order, is_active`. Seed: Cash, Maybank Terminal (card), DuitNow QR, Touch 'n Go (ewallet). (Feedme's "Pulse Drawer" is out: no cash drawer is wired to the demo printer.)
- `reason_templates`: `branch_id, action` (`void_item` | `void_bill` | `refund`), `reasons text[]`, `compulsory`, `allow_other`. Seed sensible English reasons.
- `payments` (spec): `id, bill_id, method_id, method_name` (snapshot), `kind, amount_sen, tendered_sen, change_sen, reference, taken_by, taken_at`.
- `refunds` (spec): `id` (client-generated, idempotent), `bill_id, amount_sen, method_id, method_name, reason, approved_by, created_by, created_at`.
- `bills`: status gains `merged`; new `merged_into uuid`, `checkout_id uuid unique` (idempotent checkout), `refunded_sen int default 0`. Existing `subtotal_sen … total_sen` are filled at checkout.
- `order_items.takeaway_fee_sen int not null default 0` (see 2.5).
- `staff_pos_pins` (separate table, RLS on, **no policies** so no client can read hashes): `staff_id pk, pin_hash` (`crypt(pin, gen_salt('bf'))`), `failed_attempts, locked_until, updated_at`.
- Realtime: add `bills` to the publication so every iPad sees a bill close, move or merge.

## 4. Approvals — supervisor PIN

- New Craft OS capability **`pos_supervise`** ("Approve POS voids & refunds"), defaults owner / admin / manager / supervisor = true, hr / staff = false; editable in Settings → System Roles like every capability; `has_menu_cap('pos_supervise')` mirrors it with the same Owner-override merge as `access_settings`.
- Every staff member sets their own 4–6 digit PIN from the POS header ("My PIN"); stored only as a bcrypt hash via `set_my_pos_pin`.
- An approval = the approver picks their name from the branch's eligible approvers (`pos_approvers()`), then types their PIN on the cashier's iPad. The server checks: approver is active, in the branch, holds `pos_supervise`, PIN matches. 5 wrong PINs lock that approver for 10 minutes. The cashier may approve their own action if they hold `pos_supervise`.
- The PIN is checked **inside** each protected RPC (never a separate "is this PIN right?" call that the client could skip).
- Feedme's role matrix is finer (discount %, change price, waive service charge, change payment type, per-report access). The demo maps only void/refund to one capability. **Confirmed by the owner 2026-10-24:** one capability (`pos_supervise`) is enough for the pilot.

## 5. Operations

- **Checkout** (`checkout_bill(bill_id, payments, checkout_id)`): staff of the bill's branch; locks the bill; same `checkout_id` again returns the first result; bill must be open with at least one non-voided item; totals from `pos_bill_totals`; payments: each method active and in the branch; `Σ amount = total` exactly; cash may be tendered above its amount → `change = tendered − amount` (only cash gives change); reference required when the method says so; writes payments and the totals, `status = paid`, `closed_at/by`; queues the receipt print job; returns `{ billNo, totalSen, changeSen }`. Online only.
- **Receipt**: `print_jobs.kind = 'receipt'`, route = `branch_pos_settings.receipt_route`, payload `ReceiptPayload` built in SQL (`pos_receipt_payload`) and rendered by a pure `renderReceiptLines` that follows #87846: header (title, legal name, REG NO, SST NO, address, phone, email) · Invoice no (bill no) · Date · Cashier · Table pax · ORDER + table label (or TAKEAWAY) · items `qty  name (unit/ea)  amount` with `• modifier` lines · item count · Subtotal · SST (rate) · SERVICE CHARGE (rate) · Takeaway packaging · Bill rounding · **Total (MYR)** · each payment · Change · Charges summary (Base Amt / Amount per SST and service-charge rate) · footer. ASCII only for now (the ZY301 prints Chinese as "?"; raster printing is a separate project). `reprint_receipt(bill_id)` queues it again marked "REPRINT". Both the agent and the browser print host render by `payload.kind`.
- **Void item** (`void_order_item(item_id, reason, approver_id, pin)`): open bill only; sets `voided_at/by/void_reason`; queues a ticket on the item's print route marked `*** VOID ***` so the kitchen stops it. **Void bill** (`void_bill`): open bill only; voids every item, `status = voided`, closes it, tickets as above.
- **Move bill** (`move_bill(bill_id, table_id)`): open dine-in bill → an empty active table of the same branch; any staff; no reprint.
- **Merge** (`merge_bills(from_bill, into_bill)`): both open, same branch; orders and items move to `into`; `from.status = merged`, `merged_into`; any staff.
- **Refund** (`refund_bill(refund_id, bill_id, amount_sen, method_id, reason, approver_id, pin)`): paid bills only; `amount ≤ total − refunded`; **the method must be one the bill was paid with, and `amount ≤ Σ payments by that method − Σ refunds by that method`** (owner, 2026-10-24); the refund row's `method_name` is the payment's snapshot; idempotent on `refund_id`; increments `bills.refunded_sen`; prints a short refund slip on the receipt route. `pos_refundable_methods(bill_id)` lists, per method the bill was paid with (in payment order), `paid_sen`, `refunded_sen` and `left_sen`; the refund dialog offers only methods with something left ("Touch 'n Go · up to RM 20.00"), defaulting to the first and to its left.
- **Reasons**: when the action's template is compulsory the reason must be non-empty; when `allow_other` is false it must be one of the listed reasons.
- **QR leak mitigation** (open issue from Sub-plan 2): when `qr_requires_open_bill` is on, `place_table_order` refuses unless the table already has an open bill, and staff start one with `open_table(table_id, pax)` from the POS. Off by default for the demo. Paid bills are never visible to `qr_table_state` (it only reads the open bill), so a previous party sees nothing once the table is checked out; the remaining risk is a previous party adding to the next party's bill before staff check it out — accepted for the demo.

## 6. Screens

- **Bill panel** (open bill): per-item Void; header actions Move table · Merge with… · Void bill; footer **Checkout**.
- **Checkout sheet**: totals breakdown (server preview) · payment method buttons · amount (defaults to what is left) · cash quick-tender (Exact, 10, 20, 50, 100) and change · multiple payments for split tender · reference field when required · Pay. Success: large change amount, "Receipt printing", table returns to empty.
- **Approval dialog** (void/refund): reason picker (+ "Other" text when allowed) · approver picker · PIN pad.
- **Today's bills** drawer from the POS header: paid / voided / merged bills of the branch for the Malaysia day; Reprint receipt · Refund.
- **My PIN** dialog from the POS header.
- **`/pos/settings`** gains: Receipt details (title, legal name, reg no, SST no, address, phone, email, footer, receipt printer route, SST registered, rounding, QR requires open bill) · Service charge rules · Payment methods · Reason templates.

## 7. Testing

- Shared vectors file used by Vitest (`computeBill`) and copied into the SQL verify script (`pos_bill_totals`): #87846; a takeaway bill with packaging fee (taxed at its line's SST rate); a takeaway 0 % SST item whose fee stays untaxed; a bill with a 0 % SST item; rounding cases ending in 1–4 and 6–9 sen; voided lines excluded; a service-charge rule limited to some tables/products.
- SQL verify (rolled back): checkout idempotency, exact-sum rule, change only for cash, method of another branch refused, paid bill immutable (no orders, no void), void needs a valid approver PIN, lockout after 5 failures, refund cap, merge/move rules, reason template enforcement, QR open-bill switch, grants (anon none, hashes unreadable).
- On site (extends Sub-plan 2 Task 13): a full checkout printing a receipt on the ZY301 compared side by side with a Feedme receipt for the same items.
