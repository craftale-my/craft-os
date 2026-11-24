# POS smaller Feedme habits (W7) — design

Date: 2026-11-22 · Branch: `feature/pos-demo` · Owner approved the design in chat on 2026-11-22.
Source: `docs/pos/2026-10-29-feedme-replacement-readiness.md` §2 W7; Feedme iPad teardown (memory
feedme-ipad-teardown: pax with optional adults/children, "Takeaway 1.06" add-on inside a dine-in bill left out
of the service charge, long-press menu with Serve).

## 1. Goal and scope

Five habits the cashiers know from Feedme: a remark on QR items, a last-order time, a takeaway line inside a
dine-in bill, adults / children in the pax, and marking lines served.

Out of scope: member lookup (D2 = a), guests choosing takeaway on QR, children in reports, a kitchen display,
printing served state.

## 2. QR item remark

- The QR item sheet gets a text field `Remark (optional)`, at most 120 characters, under the options.
- It travels in the QR table cart line's existing `note` (migration-2026-11-22-qr-table-cart.sql already stores
  and sends it) to `order_items.note`, so it shows on the kitchen/bar ticket and the POS bill line like a staff
  note. The cart shows it under the line (`Remark: …`). Editing one's own line edits the remark.

## 3. Last-order time (per outlet)

- `branch_pos_settings.orders_open_at time` and `last_order_at time` (Malaysia time; both null = no limit;
  set together or not at all — `Set both times or neither.`). The window may cross midnight (09:00–02:00).
  Saved through `save_receipt_settings` keys `ordersOpenAt`, `lastOrderAt` ("HH:MM" or null).
- POS Settings: two time fields `Orders open at` and `Last order at` with the help text
  `QR ordering stops outside these times. Staff can still order on the POS.`
- QR: outside the window the page shows a banner
  `Last orders were at 21:30. Ordering opens again at 09:00.` and Add / Send are disabled. The QR add and send
  RPCs refuse with the same sentence (server time decides).
- POS order pad: outside the window a thin banner `Past last order (21:30)`; ordering is not blocked.
- A helper `pos_orders_open(p_branch_id, p_at timestamptz default now()) returns boolean` and the message
  builder live in SQL; the client mirrors the rule for display only.

## 4. Takeaway line inside a dine-in bill

- The POS item sheet (ModifierSheet) shows a switch `Takeaway` on a dine-in bill only.
- A line sent with it on is stored with `order_items.order_type = 'takeaway'` and `takeaway_fee_sen` = the
  product's takeaway fee (as on a takeaway bill). The totals engine already prices lines by their own order type
  (service charge rules by order type, takeaway fee per line), so such a line pays the packaging fee and no
  dine-in service charge.
- The trigger `order_items_order_type` keeps a line's own `takeaway` on a dine-in bill instead of overwriting
  it with the bill's type (a takeaway bill's lines stay takeaway).
- Ticket: the line reads `TAKEAWAY` before the item name. Receipt and POS bill: the line name gets
  ` (Takeaway)`. Split / move keep the line's type as today.
- QR guests cannot set it.

## 5. Adults / children

- `bills.pax_children integer` (null = not given; 0 ≤ children ≤ pax). `pax` stays the total; reports and the
  Z report keep using `pax`.
- The pax picker gets an optional row `Of which children` (0 … pax, default none); changing the pax later keeps
  children ≤ pax (clamped).
- Shown as `3 pax (1 child)` / `(2 children)` on the bill header and the receipt.

## 6. Serve

- `order_items.served_at timestamptz`, `served_by uuid` (staff). RPC `set_items_served(p_item_ids uuid[],
  p_served boolean)` — sent, live (not voided) lines of one open bill of the caller's outlet; no PIN; returns the
  number changed.
- Long-press a sent line → `Serve` (or `Not served` when it is). The bill action menu gets `Mark all served`
  (every sent, live, unserved line of the bill).
- A served line shows `✓` before its name and muted text on the POS bill; nothing prints; money unchanged.

## 7. SQL and testing

- One migration `supabase/migration-2026-11-22-pos-feedme-habits.sql` (+ `-verify.sql`, rolled back), run after
  the W4 receipt-numbers and QR table cart migrations. Functions it changes are re-created from their newest
  definitions with marked lines only.
- Verify: QR send refused outside the window (also across midnight), allowed inside, POS order allowed outside;
  settings validation; a dine-in bill with one takeaway line: fee charged, no service charge on that line, ticket
  payload marks it; trigger keeps it; pax_children bounds; serve / unserve / mark all; a voided line not served.
- Unit/component tests for each UI piece; browser on dev with the owner (PIN).
