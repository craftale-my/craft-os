# POS sales reports (W3) — design

Date: 2026-11-18 · Branch: `feature/pos-demo` · Owner approved the design in chat on 2026-11-18.
Source of the report list: `docs/pos/2026-10-29-feedme-replacement-readiness.md` §2 W3 and D5, and Feedme's
Report pages (`docs/superpowers/research/2026-10-23-feedme-back-office-teardown.md` §3).

## 1. Goal

The owner and outlet managers read sales, payments, SST and the cash drawer for any outlets and dates in
Craft OS, without Feedme, and hand the accountant CSV files that a later Accounting module can also read
(D5: per bill, per line, per tax rate, per payment method).

Out of scope: inventory, members, vouchers, delivery platforms, KDS, emailing reports, saved report
templates, refunds apportioned to items or tax (see §7).

## 2. Where and who

- A new back office page **POS → Reports** at `/pos/reports`, in the POS nav group after Register, with
  the same capability as POS Settings (`access_settings`).
- A person sees only the outlets `my_outlets()` returns (`staff_outlet_scope`): an outlet manager their
  own outlets, HQ every outlet. Every report function checks `pos_manages_outlet(id)` for every outlet
  asked for and refuses with `You cannot see reports for this outlet.` otherwise.
- The tablet's grid menu **Report** stays as it is (shifts and Z reports).

## 3. Filters (one bar for every report)

- **Outlets:** a multi-select of `my_outlets()`; the default is the caller's home outlet (HQ: all).
- **Dates:** Today · Yesterday · This week (Mon–Sun) · This month · Last month · Custom (from, to), whole
  business days, at most 366 days.
- **Business day** (assumed — Feedme behaviour, its Operation Hour is 9:00 AM–3:00 AM): a day runs from
  06:00 to 05:59 the next morning, Malaysia time (UTC+8). A bill belongs to the business day of its
  `closed_at`: `((closed_at at time zone 'Asia/Kuala_Lumpur') - interval '6 hours')::date`. Shifts,
  refunds, voids and discounts use the same rule on their own times.
- The filter is kept in the page URL (`?outlets=…&from=…&to=…&tab=…`) so a report can be reopened.

## 4. What counts

- **Sales** are bills with `status = 'paid'` (a split-by-item part is its own paid bill; the table bill
  keeps only its remaining units, so nothing counts twice). Voided and merged bills are not sales.
- Money comes from the totals frozen at checkout (`bills.totals`, `bills.*_sen`): the report never
  re-prices.
- **Nett sales** = the bills' `total_sen`. Refunds are listed apart and never taken out of sales or
  SST (Feedme's Close up does the same; "Nett after refunds" is shown next to it on Overview).
- A line's value after discounts is `totals.lines[].netSen` for that `order_items.id`; its SST rate is
  `order_items.sst_rate_bp` (a snapshot); its category is the product's category today.
- Add-ons are the options chosen on lines (`order_items.modifiers_snapshot`, value = `priceDeltaSen × qty`).

## 5. The reports (tabs)

Every table has **Download CSV** (UTF-8 with BOM, comma, ringgit with two decimals, dates `YYYY-MM-DD`).

1. **Overview** — cards: Nett sales · Bills · Pax · Average per bill · Average per pax · Discounts ·
   Voids (value) · Refunds · Nett after refunds; each with the change against the previous period of the
   same length (`+12%`, `—` when the previous period is 0). Bar charts: daily nett sales, hourly nett
   sales (by hour of `closed_at`, 0–23, Malaysia time). Top 10 products by quantity.
2. **Sales summary** — Feedme's order: Gross before discounts → Discounts (Staff Meal / item / bill) →
   Gross sales → Takeaway fee → Service charge → SST → Rounding → Nett sales; then by order type
   (dine-in, takeaway: bills, nett) and by source (counter, QR: orders, item value), as the Z report.
3. **Daily sales** — one row per outlet per business day: bills, pax, gross, discounts, service charge,
   SST, rounding, nett, refunds.
4. **Hourly sales** — one row per hour 0–23 over the range: bills, nett, average per bill.
5. **Products** — per product: category, quantity, gross (unit price × qty), discounts, net. Under it
   **Add-ons** (per option name: count, value) and **Categories** (quantity, net).
6. **Payments** — per method: count, amount, refunds, net; part payments are payments like any other.
7. **SST** — per rate (6%, 8%, …): taxable base and SST, from `totals.sstGroups`; **Exempt**: the net
   of 0% lines; then one row per calendar month (for the SST-02 return): taxable at each rate, SST at each
   rate, exempt. Service charge carries no SST (as the bills do).
8. **Discounts** — every discount set and cleared (`pos_discount_log`): time, bill, item or bill, kind
   and value, reason, by, approved by; and the discount totals by kind from the bills.
9. **Voids** — voided items (time, bill, item, qty, value, reason, by, approved by) and voided bills.
10. **Refunds** — time, bill, method, amount, reason, approved by.
11. **Cash drawer** — one row per shift whose close (or open, for a shift still open) falls in the range:
    outlet, opened, closed, by, float, cash sales, cash refunds, pay in, pay out, expected, counted,
    variance, reason.
12. **Ledger export** — three CSV files for the range, for the accountant and the future Accounting
    module: `bills.csv` (one row per paid bill: outlet, business date, closed at, bill no, order type,
    table, pax, gross, discounts, service charge, SST, rounding, total, refunded), `lines.csv` (one row
    per live line of those bills: bill no, item, qty, unit price, catalog / item / bill-share discounts,
    net, SST rate, SST amount — the line's share of its rate group, largest-remainder so they add up to
    the bill's group), `payments.csv` (bill no, part no, method, kind, amount, tendered, change,
    reference, taken at).

## 6. Design

- **SQL:** one migration `supabase/migration-2026-11-18-pos-reports.sql` (+ `-verify.sql`): a helper
  `pos_report_scope(p_branch_ids uuid[], p_from date, p_to date)` that checks access, the range (≤ 366
  days, from ≤ to) and returns the UTC bounds; and one function per report group returning jsonb,
  `stable security definer`, granted to `authenticated` only:
  `pos_report_sales(ids, from, to)` (overview cards for both periods, daily, hourly, sales summary, order
  types, sources), `pos_report_products`, `pos_report_payments`, `pos_report_sst`,
  `pos_report_audit` (discounts, voids, refunds), `pos_report_drawer`, `pos_report_ledger` (the three row
  sets). An index on `pos_discount_log(branch_id, created_at)`; the paid-bills index exists
  (`bills_branch_paid_closed_idx`). Run after the menu picks migration.
- **Client:** `src/features/pos/reports/` — `reportsApi.ts` (RPC calls, parse), `reportRange.ts` (date
  presets, business day, previous period, URL state; pure), `csv.ts` (rows → CSV text, download),
  `ReportsPage.tsx` (filter bar + tabs), one small component per tab, `Bars.tsx` (plain CSS bar chart,
  no chart library). English copy. Ringgit via the existing `formatSen`.
- **Errors:** each tab loads on its own; a failed read shows the reason (plain words for no reply,
  `readableError`) and Retry. An empty range says `No sales in this range.`

## 7. Known limits (told to the owner)

- Refunds carry an amount and a method only; SST shows the tax charged on the bills, with refunds
  listed apart. Credit notes come with e-invoicing (W5).
- A product's category is today's, not the category at the time of sale.
- Comparison is with the previous period of the same length only.

## 8. Testing

- Verify SQL on dev (rolled back): an outlet with bills across two business days (one at 01:30 counts to
  the day before), a 6% and an 8% product and a 0% product, a discount, a void, a refund, a split part,
  a part payment, a shift; every report's numbers checked by hand; a manager of another outlet refused.
- Unit tests: range presets and business day, previous period, CSV escaping, parsers, each tab's table
  from a fixture.
- Browser on dev: every tab for the Demo outlet with this week's test bills; CSV downloads open.
