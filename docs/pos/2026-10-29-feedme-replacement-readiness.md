# Replacing the Feedme POS — what is not ready yet

Date: 2026-10-29 · Branch: `feature/pos-demo` · Sources: a read-only walk through every Feedme back-office page
(Craft Cafe – Cheras, 2026-10-29), the 2026-10-23 back-office teardown, the 2026-10-26 iPad teardown and the POS
specs on this branch.

"Replaced" means: Craft Cafe outlets take every walk-in, table, QR and takeaway order on the Craft POS, print
tickets and receipts, close the day with our Z report, and the accountant gets sales and SST figures from Craft OS.
Feedme may stay for whatever the owner decides below (Grab, members).

Work runs top to bottom: decisions first (they change what gets built), then build, then data and setup, then prod,
then testing and cut-over. Check items off as they land.

## 1. Owner decisions (block the build)

**Answers 2026-10-29:**
- D1 = (c). Grab orders must come into our POS through Grab's API **before** the switch; this is a hard gate
  for cut-over. Grab integrations go through Grab's developer portal (developer.grab.com); eligibility of an own
  in-house POS as an integration partner is not confirmed yet — the owner applies first. Fallback if Grab will
  not let an in-house POS connect: a middleware that is already a Grab partner (e.g. Deliverect) and offers an
  API for a custom POS — costs a subscription, check before building.
- D2 = (a). Few Feedme members; points are kept by hand or recalculated later. Not a cut-over gate.
- D3 = no online payment for now (QR stays pay at the counter). Pickup orders are not needed on day one.
- D4 = confirmed as designed, plus: the Staff Meal catalog sells at 50% off the normal price.
- D5 = no accountant export today (figures by hand). Craft OS will get its own Accounting module later, so
  reports and sales data must be ledger-friendly (per bill, per line, per tax rate, per payment method).
- D6 = Cheras first, Feedme kept as fallback.
- D7 = owner asked for a recommendation: switch Manager "All branches" off on prod, as on dev. Only owner and
  admin are HQ (approve tablets, clear HQ PINs); outlet managers keep `access_settings` for their own outlets
  and `pos_supervise` for approvals. Set it in System Roles on prod when the POS chain goes to prod (step 4).
- Test kit ready: one Android tablet, one Mac, one iPad, one Wi-Fi printer. Testing waits until the build items
  below are done.

- [x] **D1 Grab orders.** Feedme receives Grab Food and Grab Mart orders straight into the POS (active at Cheras).
      Craft POS has no delivery-platform link. Choose: (a) keep a Grab tablet / Feedme for Grab only, staff key
      nothing into our POS; (b) staff re-key Grab orders into a "Grab" catalog on our POS (tickets print, sales
      counted, double work); (c) build a Grab integration (needs Grab partner API access — weeks, not days).
- [x] **D2 Members and points.** Feedme loyalty (about 1k members, vouchers, points) only works with the Feedme POS
      and Feedme has no API. Once bills move to our POS, members stop earning. Choose: (a) accept a pause in
      earning until our own Loyalty module (build order: POS → Inventory → Loyalty); (b) keep a Feedme device
      to record member purchases (double entry); (c) pull Loyalty forward before cut-over.
- [x] **D3 QR payment and online pickup.** Feedme lets QR diners pay online and runs scheduled pickup orders with
      SMS. Ours: QR orders only, pay at the counter, no pickup. Decide whether either is needed on day one.
- [x] **D4 Discount rules.** Discounts are used daily. Confirm the paused design: amount or percent, reason,
      supervisor PIN every time, service charge after the discount, one discount per bill; and decide whether an
      item-level discount and staff-meal / staff discount are also needed.
- [x] **D5 Accountant hand-off.** Which figures the accountant takes today from Feedme (daily sales, SST
      6% / 8% / exempt, payment methods, Xero?) — this fixes the report list in W3.
- [x] **D6 Cut-over style.** One outlet first (Cheras) with Feedme kept signed in for a week as a fallback, then
      Puchong and Kepong; and the Feedme licence end date.
- [x] **D7 Prod roles.** Manager "All branches" off on prod (only owner/admin are HQ), as on dev.

## 2. Build (in this order)

- [ ] **W1 POS app, Part C** — separate `craft-pos` app, tablets sign in as devices, staff name + PIN, the RPC
      swap to `pos_ctx`, scoped read policies (plan to write; Parts A and B are live on dev).
- [ ] **W2 Bill discount** — spec from the paused design (D4), server totals, PIN approval, receipt and Z report
      lines, discount report; Staff Meal catalog at 50% off the normal price.
- [ ] **WG Grab integration (cut-over gate, D1)** — owner applies for Grab API access now (long lead); then a
      spec: menu sync from our catalogs, order webhook into a Grab bill with tickets, accept/reject and
      ready status, Grab payment type, sold-out sync. Built as soon as access is granted, in parallel with W3–W6.
- [ ] **W3 Sales reports** — at least: daily sales, hourly sales, product and add-on sales, category sales, payment
      methods, discounts, voids, refunds, cash drawer, SST by rate (6% / 8% / exempt), per outlet and date range.
- [ ] **W4 Receipt and numbers** — receipt template (logo, header, address, phone, email, hide zero-price add-ons,
      footer text, footer QR, font size); order numbers per channel (takeaway TA001–TA999, pickup P001–P999) with
      auto reset; an "open drawer" button and per-payment-method drawer pulse.
- [ ] **W5 E-invoice** — merge `feature/einvoice` into this branch, add MyInvois sandbox secrets and company
      details, then production credentials.
- [ ] **W6 Print agent pairing, Part D** — the agent pairs like a device instead of an email/password login; one
      printing tablet per outlet also kicks the cash drawer.
- [ ] **W7 Smaller Feedme habits** — customer item remark on QR orders; last-order time before closing; takeaway
      line inside a dine-in bill (Feedme "Takeaway 1.06" add-on); adults / children pax; "Serve" marking;
      member lookup (only if D2 = c).
- [ ] **W8 Known defects** — order pad opened while offline shows no menu and no Retry; a stalled "Check bill"
      shows the raw "AbortError" text.

## 3. Data and setup (per outlet)

- [ ] Prod menu import from Feedme, then `menu-data-2026-10-25-packaging-fee.sql` and
      `menu-data-2026-10-25-print-routes.sql`; rebuild the photo zip for prod.
- [ ] 32 on-sale products still without a photo; Mi-4 / Mi-7 / Mi-8 and Staff Meal prices.
- [ ] Tables and areas per outlet (Cheras uses Ground Floor, Beside Floor, Upstairs, Staff, Grab).
- [ ] Payment methods to match Feedme (cash, e-wallets, online banking, Maybank and Pine Labs terminals, Grab
      payment types — depends on D1).
- [ ] Service-charge rules (by order type, table and product), reason templates, rounding (5 sen), receipt text.
- [ ] Every cashier and supervisor has their own PIN; supervisors hold `pos_supervise`.
- [ ] Printer IP per route per outlet (Cheras: Bar and Kitchen on one printer for now); tablets activated and one
      marked as the printing tablet.

## 4. Prod rollout

- [ ] Run the whole POS SQL chain on prod in order (menu → catalogs → ordering → checkout → shifts → hardening →
      front end → outlets → devices), each with its VERIFY, after the prod menu import.
- [ ] Deploy Edge Functions `pos-device-activation` (with `--no-verify-jwt`) and `einvoice`.
- [ ] Create the `craft-pos` Vercel project; staff email logins lose front-of-house RPCs at the same time.
- [ ] Revoke the access tokens that were pasted in chat (Supabase dashboard → Account → Access tokens).

## 5. Testing

- [ ] Full run sheet (`docs/pos/2026-10-25-simulated-run-sheet.md`) on two real iPads and a phone, results filled in.
- [ ] Steps 14–15 again on iPad Safari with real Wi-Fi off/on ("Load failed" lock).
- [ ] Void and refund approvals with a real supervisor PIN; offline queue on the new order screen.
- [ ] Failure cases: printer off or out of paper, print agent / printing tablet down, shop internet down
      (orders queue, no tickets print until it is back).
- [ ] Discount, reports and receipt template once built; Z report matches the reports for the same day.
- [ ] One parallel day: same orders on Feedme and Craft POS, compare totals and SST.

## 6. Cut-over

- [ ] Staff training (cashier flow, void/refund, shift close) and a one-page cheat sheet.
- [ ] Day 0: open shift with float, Feedme kept signed in as fallback; end of day Z report checked against cash.
- [ ] After a clean week: next outlet; stop Feedme POS use per D1/D2.

## Not needed (Feedme has it, Cheras does not use it)

Deposits, currency exchange, kitchen display (ODS/KDS), serving sequence, cooking guide, variants page, price groups,
member price, linked-product rule groups, self-order kiosk machines, reservations, Feedme discount rules (empty),
order pacing (one 10-minute delay on one product).
