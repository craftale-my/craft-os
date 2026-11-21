# POS receipt template, call numbers and cash drawer (W4) — design

Date: 2026-11-22 · Branch: `feature/pos-demo` · Owner approved the design in chat on 2026-11-22.
Source: `docs/pos/2026-10-29-feedme-replacement-readiness.md` §2 W4; Feedme settings seen in the iPad teardown
(order-number ranges per channel, per-method "Pulse drawer" toggle).

## 1. Goal

Takeaway customers are called by a short number, the receipt looks like the shop's (logo, QR, font size, no
free add-on noise), and the cash drawer opens by itself for cash and on demand, with every no-sale open logged.

Out of scope: a pickup channel (we have none yet; P001 comes with it), Grab numbers (WG), Chinese text,
logo/QR on Epson or Star printers (they print the text only), ticket font size.

## 2. Call numbers (TA001–TA999)

- A new takeaway bill gets a **call number** `TA` + 3 digits when it is created: TA001, TA002 … TA999, then
  TA001 again. The counter is per outlet, per channel, per **business day** (06:00–05:59 Malaysia time,
  `pos_business_day`, the same as the reports), so a 01:00 bill continues the night's numbers.
- Table `pos_call_counters(branch_id, channel, business_day, next_no)`; function
  `pos_next_call_no(p_branch_id, p_channel)` (channel `'takeaway'` → prefix `TA`; the table is keyed by channel
  so pickup / Grab can add theirs later). Column `bills.call_no text` (null for dine-in and for bills made before
  this change).
- Dine-in bills get no number (the table is their number). A bill split off a takeaway bill by item copies its
  source's call number. Every other path that creates a bill keeps the rule: takeaway → new number, dine-in → none.
- `bill_no` stays as it is and stays the accounting number.
- Shown: big (double width and height) at the top of the receipt, the part receipt and every kitchen/bar
  ticket of that bill; on the POS open-bills list and bill header ("TA012 · Takeaway"); in Transactions (list,
  detail) and Transactions search matches it ("TA12", "ta012" and "12" find TA012 of the chosen day).

## 3. Receipt template (POS Settings → Receipt, per outlet)

New `branch_pos_settings` columns, saved through `save_receipt_settings(p_branch_id, p)`:

- `receipt_logo jsonb` — `{ "width": w, "height": h, "data": "<base64>" }`: a 1-bit raster, rows top to bottom,
  `ceil(w/8)` bytes per row, most significant bit = leftmost dot, 1 = black. `w` ≤ 384 and a multiple of 8,
  `h` ≤ 240. Made in the browser when the owner uploads an image (scale to fit, grayscale, Floyd–Steinberg
  dither, pack); the settings page shows the dithered preview and a Remove button. The server checks the shape
  and the size and refuses `The logo must be at most 384 × 240 dots.` otherwise.
- `receipt_footer_qr text` — up to 300 characters (a review link, Instagram, anything); printed as a QR code
  under the footer text. Empty = none.
- `receipt_font_size text` — `small` | `normal` | `large`, default `normal`. Small = the printer's Font B (more
  characters per line: `round(cols × 4 / 3)`); large = double height, same characters per line.
- `receipt_hide_free_mods boolean` default false — when on, add-ons with price 0 are left off receipt lines
  (receipt and part receipt; kitchen tickets always show them).
- The existing header fields (title, legal name, registration no, SST no, address, phone, email) and footer
  text stay as they are.

The receipt payload (`pos_receipt_payload`, `pos_part_receipt_payload`) carries `callNo`, `fontSize`,
`header.logo` and `footerQr`, and builds the add-on list without the free ones when the switch is on. Receipts
queued before this change lack those fields and print as before.

## 4. Printing

- Rendering moves from plain lines to a small document: a list of blocks — text line (with `big` for double
  width + height, centred), image (the logo raster), QR (data), drawer pulse — plus the font size.
  `renderJobDoc(payload, cols)` builds it for every job kind; `renderJobLines` stays as its text-only view (tests,
  Epson, Star).
- ESC/POS (`encodeEscPos`, used by the print agent for the shop's ZyWell printers): Font B `ESC M 1`, double
  height `GS ! 0x01`, double width+height `GS ! 0x11`, centring `ESC a 1`, raster image `GS v 0`, QR
  `GS ( k` (model 2, module size 6, error level M), drawer pulse `ESC p 0 25 250`.
- Epson ePOS / Star WebPRNT: text as today (big text as normal text), the pulse as `<pulse/>` /
  `<peripheral/>`; logo and QR are skipped.
- The print agent needs redeploying with the POS build (as for the part receipt).

## 5. Cash drawer

- `payment_methods.opens_drawer boolean not null default false`; the migration sets it true on every `cash`
  method. The payment-method form shows "Opens the cash drawer" (on by default for a new cash method).
- A print job of kind `drawer` (`{ kind: 'drawer', route, reason }`) prints nothing and kicks the drawer on the
  receipt printer (`receipt_route`; no receipt route = no kick). It is queued:
  - when a payment is taken (full checkout, a part payment) with any method that opens the drawer — queued
    before that payment's receipt;
  - when a refund is paid out with such a method;
  - on a cash pay in / pay out;
  - by **Open drawer**. Reprints never kick it.
- **Open drawer** (POS grid menu): the cashier picks a reason (reason templates, new action `open_drawer`,
  defaults "Give change", "Check the cash", "Swap a note"; Other allowed) — no supervisor PIN. RPC
  `pos_open_drawer(…, reason)` logs it in `pos_drawer_opens(id, branch_id, shift_id, opened_by, reason,
  created_at)` and queues the kick. It needs an open shift at the outlet (`Open a shift first.`).
- Z report: `Drawer opened without a sale: n` under the cash section (`pos_shift_report` → `noSaleOpens`).
- Reports → Cash drawer: a "No-sale opens" column per shift; the Voids/audit data is unchanged.

## 6. SQL

One migration `supabase/migration-2026-11-22-pos-receipt-numbers.sql` (+ `-verify.sql`, rolled back), run after
the reports migration. It redefines, from their latest versions, every function it changes (receipt and part
receipt payloads, the functions that create bills, checkout / part payment / refund / pay in-out, the shift
report, the drawer report, `save_receipt_settings`, the payment-method save, reason-template check).

## 7. Testing

- Verify SQL on dev: two takeaway bills get TA001/TA002; a bill at 05:30 and one at 06:30 the next morning
  straddle the reset; TA999 wraps to TA001; a dine-in bill has none; a split part copies it; a cash checkout
  queues a drawer job before its receipt, a card one does not; Open drawer without a shift is refused, with one
  is logged and counted in the shift report; the logo size check refuses 400 dots; hide-free-mods drops a 0 add-on.
- Unit tests: call-number search matching, dither/pack, every ESC/POS command, renderJobDoc for each kind
  (call number, logo, QR, font sizes, old payloads without the new fields), Epson/Star pulse.
- Browser on dev: settings (upload logo, QR, font, switch), a takeaway order shows TA…, Open drawer flow;
  then a real receipt and drawer kick through the print agent on the office ZyWell.
