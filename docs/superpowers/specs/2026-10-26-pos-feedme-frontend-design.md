# POS front end, Feedme layout (design)

Date: 2026-10-26. Branch `feature/pos-demo`. Source: the owner's three videos of the Feedme iPad POS at Craft Cafe Cheras (2026-10-26) and the back-office teardown `docs/superpowers/research/2026-10-23-feedme-back-office-teardown.md`.

## Owner decisions (2026-10-26)

- **Feedme layout, Craft colours.** Copy Feedme's screens, positions and flow; keep the Craft OS brown palette and fonts.
- **Approach A:** rebuild the POS screens and flow; keep every piece of logic (cart, offline order queue, checkout, voids, refunds, move, merge, shifts, print host) and every existing RPC. Only two small data additions (§6).
- **Sections 1 and 2 below were approved as presented.** The owner then asked to start building; sections 3–6 follow Feedme the same way (standing rule: settle open POS choices the Feedme way).
- Feedme actions we do not have yet (Discount, Customer, Voucher, Serve, View activity, delivery) are **not shown** — no dead buttons. The bill discount is a separate, paused design.

## Out of scope

Bill discount, members, vouchers, delivery orders, pax adults/children split, pre-bill "Print" and "Check list" printing, new reports, offline payment. No change to money rules, RPC behaviour or print payloads.

## 1. Shell and home (tables)

Design size: iPad landscape **1180 × 820**; touch targets ≥ 44 px high.

**Bottom bar** on every POS screen:
- Left: **grid button** → menu sheet with **Order** (home), **Menu** (`/menu`), **Transaction** (§5), **Report** (the existing Shifts drawer / Z report), **Setting** (`/pos/settings`, only with `access_settings`).
- Middle: the current screen's name.
- Right: staff name and the time. Tap → right-side **staff panel**: Open shift / Close shift and Pay in / Pay out (today's ShiftBar), My PIN, printer status (today's PrintHostPanel), live status, **Logout** (back to Craft OS `/profile`).
- The current top header row is removed.

**Home:**
- Top row: Search (filters table labels), Refresh, then **area tabs**: `All (n)` then one tab per area in table sort order, `(n)` = tables with an open bill. Tables with no area appear only under All.
- Main area: table tiles, 5 per row. Empty = light; open bill = brown fill with label, **current total** and **minutes open** (`RM106.70 · 12m`, `1h 05m` past an hour); new QR order = the existing green ring.
- Right column **Other bills** (≈ 260 px): **+ Takeaway** button, then every open takeaway bill (bill no, total, minutes open); tap → order screen.
- Banners above the tiles: "No shift open — Open shift" when no shift is open; the offline queue strip (waiting / rejected orders, Edit / Discard) as today.
- Tap an empty table → **Select pax** dialog (1–20 grid, Feedme style) → order screen. Tap an occupied table or an Other bill → order screen.

## 2. Order screen (bill and menu together)

Replaces both the right-hand BillPanel and the OrderPad overlay. Three columns:

1. **Categories** (≈ 200 px): vertical list, selected = dark brown. Above it: **←** back button and a full-width **Search menu** field, with the **Sold out** mode toggle at its right.
2. **Product tiles**: 3–4 per row, photo on top, name below; no photo → first three letters on a grey block (Feedme's "Cus" tile). Out-of-slot products stay greyed as today. A product with modifiers opens the **modifier sheet** restyled the Feedme way: groups with a red `SELECT n` badge when required, options as a two-column grid of name + price, **Confirm** at the bottom (LineSheet logic unchanged).
3. **Bill** (≈ 380 px):
   - Header: table label or takeaway bill no, **pax** (tap to change via the Select pax dialog → `open_table`/pax update as today), the current catalog (amber when it is an additional catalog, as today; tap to switch).
   - **Sent items** from the server, each with modifiers and note; tap → **Void item** (approval dialog, unchanged).
   - **Draft items** (the cart) under them with an amber left rule and the heading `Not sent · n items`; tap → edit qty / modifiers / note or Remove.
   - Totals: Subtotal / SST / Service charge / Rounding (client preview via `computeBill`, as today; drafts are counted in the preview and the heading says so).
   - Buttons: **grid** (bill actions, §3), **Send** (sends the drafts through the existing queue), **Payment RM x.xx**.

Rules:
- Payment with drafts → dialog "Send n new items first?" with **Send & pay** / Cancel; Send & pay sends, waits for the queue to accept, then opens Payment.
- **←** with drafts → dialog "Discard n unsent items?".
- No open shift → Payment disabled with "Open a shift to take payment"; ordering and Send still work.
- An empty table that the cashier leaves with no drafts and no sent items leaves no bill behind (as today: the bill is created by the first order).
- Guests field in the old pad is removed; pax is asked when the table is opened.

## 3. Bill actions (grid button)

A dark overlay with round icon buttons, Feedme style, showing only what exists:
- **Send** (same as the Send button), **Move**, **Void bill** (approval dialog), **Pax**, **Close empty bill** (only when the bill has nothing on it — today's "Close bill").
- **Move** opens **Move to**: a grid of every table with its current total (Feedme). An empty table → `move_bill`. An occupied table → confirm "Merge into B4?" → `merge_bills(from = this bill, into = that table's bill)`. A takeaway bill can only go onto an occupied table (merge); a takeaway target is not offered from a table bill (today's rule).
- Every `window.confirm` on the POS screens is replaced by an in-app confirm dialog (the built-in browser pane and some iPad states auto-dismiss native dialogs).

## 4. Payment screen

Full screen, replacing the Checkout sheet; logic (`paySession`, `tender`, `follow`, idempotent checkout ids, unsure-reply lock) unchanged.
- Left (≈ 40 %): bill header (table / takeaway, bill no, item count), items, Subtotal / SST / Service charge / Rounding from the server preview, and **Cancel payment** at the bottom.
- Right: the **amount due** (or "Left to pay" during split) large in the centre, a **Reference** field when the chosen method needs one, the method buttons of the chosen tab, and the **tabs** at the bottom: **Cash** · **Card** · **E-payment** (duitnow + ewallet) · **Other**; a tab with no active method is hidden.
- Cash tab: quick tender Exact · 10 · 20 · 50 · 100 and a number pad for the tendered amount; change shown live.
- **Split payment** (top right): switches to entering an amount per payment; taken payments are listed with remove; Pay is enabled when the sum equals the total (existing rule).
- Success: the change amount large, "Receipt printing", **Done** → home.

## 5. Transaction screen

Full POS page (from the grid menu), replacing the Today's bills drawer; same data and actions.
- Left list: search by bill no or table, today's date (Malaysia day), filter **All / Paid / Voided / Refunded / Merged**; rows show bill no, table or Takeaway, total, time.
- Right detail: bill no, items with modifiers, totals, payments, refunds; **Reprint receipt** and **Refund** (approval dialog, unchanged).

## 6. Data additions

- `dining_tables.area text null` (trimmed, ≤ 40 chars); edited per table on `/pos/settings` (table admin). Area tab order = the lowest `sort_order` in each area.
- RPC `pos_open_bill_summaries(p_branch_id uuid)` → for each open bill of the branch: `bill_id, total_sen, item_count`, totals from `pos_bill_totals` (the same numbers checkout uses). Staff of that branch only; anon none. Home reads it with the open bills and on every realtime refresh.
- One migration file `supabase/migration-2026-10-26-pos-frontend.sql` + a rolled-back verify script. Prod rollout: after the whole POS chain; the client needs it (home tiles read the RPC).

## 7. Testing

- Vitest for every new pure helper: area tabs and counts, elapsed-time label, draft/sent bill view model, payment tab grouping, Move-to target rules (move vs merge vs refused).
- SQL verify (rolled back): area column constraint, summaries match `pos_bill_totals`, other-branch and anon refused.
- Existing 852+ tests stay green; `tsc` and the vitest safe-update scan pass.
- Browser check on dev at 1180 × 820: open table with pax → order with modifiers → Send → Move → Merge → Payment (cash with change, split) → Transaction → Reprint → Refund; offline order still queues; no shift → Payment disabled.
