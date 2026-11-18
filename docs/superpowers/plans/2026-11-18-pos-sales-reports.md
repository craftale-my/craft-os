# POS Sales Reports (W3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A back-office page **POS → Reports** (`/pos/reports`) where the owner and outlet managers read sales, products, payments, SST, discounts, voids, refunds and the cash drawer for any of their outlets and business days, and download CSV files — including a three-file ledger export — for the accountant.

**Architecture:** One SQL migration adds a scope check (`pos_report_scope`: access to every outlet asked for, 1–366 whole business days of 06:00–05:59 Malaysia time, their UTC bounds) and seven read-only `stable security definer` report functions returning jsonb, one per report group, all reading the totals frozen at checkout. The client (`src/features/pos/reports/`) keeps the filter in the page URL (pure `reportRange.ts`), calls one RPC per tab (`reportsApi.ts`, every reply checked), draws every table through one `ReportTable` with a CSV download (`columns.ts`, `csv.ts`) and two plain-CSS bar charts (`Bars.tsx`).

**Tech Stack:** Supabase Postgres (plpgsql / sql functions), React 19 + TypeScript + Vite, react-router-dom 7, Tailwind, Vitest + Testing Library (jsdom per file).

**Spec:** `docs/superpowers/specs/2026-11-18-pos-sales-reports-design.md` (owner approved 2026-11-18; binding).

## Spec notes (gaps found, readings taken)

1. **Top 10 products** (Overview) come from `pos_report_sales` (`topProducts`), so the Overview tab reads one RPC.
2. **Payments** are the payments of the bills counted as sales in the range (by the bill's business day), so the Payments total equals Nett sales; a part paid on a bill still open at the end of the range counts when its bill closes. Refunds count by their own time. Methods are grouped by name and kind across outlets (each outlet has its own method rows).
3. **Takeaway fee**: Daily sales and `bills.csv` carry a Takeaway fee column next to the listed columns, so a row adds up: Gross (before discounts) − Discounts + Takeaway fee + Service charge + SST + Rounding = Nett. "Gross" in those two tables is the gross before discounts.
4. **Outlet column** first in `lines.csv` and `payments.csv`: bill numbers are unique per outlet only (`unique (branch_id, bill_no)`).
5. **Exempt** = the net of 0% lines (`order_items.sst_rate_bp = 0`); SST months are the months of the bills' business days (`YYYY-MM`).
6. **Voids (value)** and the voided items list = items with `voided_at` in the range (a voided bill's items are voided with it, as in the Z report); a voided bill's value = its items' price × qty.
7. **Largest remainder** (ledger SST per line): weights are each line's SST base (net, plus a takeaway line's fee, as `pos_compute_bill`); floors first, the sen left go to the largest remainders, ties by order item id (the order of `totals.lines`).
8. **Discount log** has a third action, `split` (a bill discount shared to a split part, migration 11-16); it shows as "Split".
9. **Daily rows** exist only for outlet-days with a paid bill or a refund; the daily bar chart fills empty days with 0.
10. **Overview with no bills** shows `No sales in this range.` instead of the cards (the other sales tabs do the same; the audit and drawer tabs have their own empty words).
11. **Products** are grouped by product id (name = today's product name; a deleted product falls back to the line's name). The ledger's line item is the name as sold (`name_snapshot`).
12. **Default outlets**: "HQ" = the `all_branches` capability (as `DevicesPage`); others get their home outlet, or the first outlet `my_outlets()` returns when they have no home.
13. **Range words** (server and client alike): `Choose at least one outlet.` · `Choose a valid date range.` · `The start date is after the end date.` · `Choose at most 366 days.` · `You cannot see reports for this outlet.`

## Global Constraints

- Work only in the worktree `/Users/USER/Desktop/Craft_OS/.claude/worktrees/pos-demo` (branch `feature/pos-demo`); never `cd` to `/Users/USER/Desktop/Craft_OS`. Other sessions commit to this branch: before each task run `git log --oneline -3` and `git status`; touch only the files your task lists; **never run `git stash`**; `git add` exact paths only.
- Implementers never run SQL anywhere. SQL tasks end with the migration + verify file written and `src/features/pos/sqlSafeUpdate.test.ts` passing; the controller runs both on craft-os-dev in Task 9.
- Business day (spec §3, verbatim): "a day runs from 06:00 to 05:59 the next morning, Malaysia time (UTC+8). A bill belongs to the business day of its `closed_at`: `((closed_at at time zone 'Asia/Kuala_Lumpur') - interval '6 hours')::date`. Shifts, refunds, voids and discounts use the same rule on their own times."
- Dates: Today · Yesterday · This week (Mon–Sun) · This month · Last month · Custom (from, to), whole business days, at most 366 days. The filter is kept in the page URL (`?outlets=…&from=…&to=…&tab=…`).
- Access: page `/pos/reports`, POS nav group after Register, capability `access_settings` (as POS Settings). Every report function checks `pos_manages_outlet(id)` for every outlet asked for and refuses with `You cannot see reports for this outlet.`
- What counts (spec §4): sales are bills with `status = 'paid'`; money comes from the totals frozen at checkout (`bills.totals`, `bills.*_sen`), never re-priced; Nett sales = `total_sen`; refunds are listed apart and **never** taken out of sales or SST ("Nett after refunds" is shown next to it on Overview). A line's net = `totals.lines[].netSen` for that `order_items.id`; its SST rate = `order_items.sst_rate_bp`; its category = the product's category today; add-ons = `order_items.modifiers_snapshot`, value `priceDeltaSen × qty`.
- The Sales summary uses the live `pos_shift_report` arithmetic (migration 11-17 B6): before discounts = `coalesce(totals.grossSen, subtotal_sen)`; gross sales = `subtotal_sen − totals.billDiscountSen`; discounts = catalog (Staff Meal) + item + bill.
- CSV: UTF-8 with BOM, comma, ringgit with two decimals (no "RM"), dates `YYYY-MM-DD`, times `YYYY-MM-DD HH:MM` Malaysia time, CRLF line ends.
- English UI copy. Ringgit on screen via the existing `formatSen` (`src/features/pos/order/cart.ts`). Plain CSS bars, no chart library.
- Errors: each tab loads on its own; a failed read shows the reason (`readableError`: plain words for no reply) and Retry; an empty range says `No sales in this range.`
- SQL style: every function `security definer set search_path = public, pg_temp` (reports also `stable`); reports `revoke all on function f(uuid[], date, date) from public, anon;` + `grant execute on function f(uuid[], date, date) to authenticated;`; helpers `revoke all on function … from public, anon, authenticated;` and no grant. The file ends with `notify pgrst, 'reload schema';` and a result row. Every DELETE / UPDATE has a WHERE (pg-safeupdate; the reports never write).
- Component tests mock every module that reaches Supabase (`./reportsApi`, `../outlets/outletsApi`, `../../../shared/lib/permissions`): vitest loads `.env.local`, and an unmocked import builds a real client.
- Commands: tests `npx vitest run <file>`; type check `npx tsc -b`; builds `npm run build` and `npm run build:pos`.
- Every commit message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push (Task 9 pushes).

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `supabase/migration-2026-11-18-pos-reports.sql` | 1–3 | Create. R1 helpers + index, R2 sales, R3 lines/products/payments/SST, R4 audit/drawer/ledger |
| `supabase/migration-2026-11-18-pos-reports-verify.sql` | 1–3 | Create. Rolled-back fixture with hand-checked numbers; one DO block per section |
| `src/features/pos/sqlSafeUpdate.test.ts` | 1–3 | Modify. One `it` for the new migration: functions, grants, STOP guard, verify shape |
| `src/features/pos/reports/reportRange.ts` | 4 | Create. Business day, presets, previous period, range checks, URL filter. Pure |
| `src/features/pos/reports/csv.ts` | 4 | Create. CSV cells and text (BOM, CRLF), ringgit, CSV time, file names, download |
| `src/features/pos/reports/reportView.ts` | 4 | Create. Screen words and numbers: change %, averages, labels, day / time text, bar series. Pure |
| `src/features/pos/reports/columns.ts` | 4 | Create. Column builders (screen text + CSV value) and `tableCsv` |
| `src/features/pos/reports/reportsApi.ts` | 5 | Create. Report types, seven RPC calls, parsers |
| `src/features/pos/reports/testReports.ts` | 5 | Create. Typed fixtures of every report (test data only) |
| `src/features/pos/reports/useReport.ts` | 6 | Create. One tab's load state, stale replies dropped, Retry |
| `src/features/pos/reports/ReportBody.tsx` | 6 | Create. Loading / error with Retry / data; `NoSales` |
| `src/features/pos/reports/ReportTable.tsx` | 6 | Create. A titled table with Download CSV and its empty words |
| `src/features/pos/reports/Bars.tsx` | 6 | Create. Plain CSS bar chart |
| `src/features/pos/reports/FilterBar.tsx` | 6 | Create. Outlets, presets, custom range |
| `src/features/pos/reports/OverviewTab.tsx` | 6 | Create. Cards, two bar charts, top 10 products |
| `src/features/pos/reports/ReportsPage.tsx` | 6–8 | Create. Outlets load, URL filter, tabs, the tab body |
| `src/App.tsx`, `src/shared/lib/nav.ts`, `src/shared/lib/nav.test.ts`, `src/shared/components/Sidebar.tsx` | 6 | Modify. Route, nav leaf, its test, its icon |
| `src/features/pos/reports/{Summary,Daily,Hourly,Products,Payments,Sst}Tab.tsx` | 7 | Create. One small component per tab |
| `src/features/pos/reports/{Discounts,Voids,Refunds,Drawer,Ledger}Tab.tsx` | 8 | Create. One small component per tab |
| `src/features/pos/reports/ledgerCsv.ts` | 8 | Create. `bills.csv`, `lines.csv`, `payments.csv` columns |
| `docs/pos/2026-10-29-feedme-replacement-readiness.md` | 9 | Modify. Rollout chain §4, W3 ticked §2 |

Report JSON shapes (the contract between Tasks 1–3 and Task 5; keys exactly as written):

- `pos_report_sales` → `{ current: Cards, previous: Cards, daily: [{ branchId, outlet, day, bills, pax, grossSen, discountSen, takeawayFeeSen, serviceChargeSen, sstSen, roundingSen, nettSen, refundSen }], hourly: [{ hour, bills, nettSen }] (24 rows), summary: { beforeDiscountsSen, catalogDiscountSen, itemDiscountSen, billDiscountSen, grossSen, takeawayFeeSen, serviceChargeSen, sstSen, roundingSen, nettSen }, orderTypes: [{ orderType, bills, nettSen }], sources: [{ source, orders, itemSen }], topProducts: [{ name, qty, valueSen }] }`, Cards = `{ nettSen, bills, pax, discountSen, voidSen, refundSen }`
- `pos_report_products` → `{ products: [{ name, category, qty, grossSen, discountSen, netSen }], addOns: [{ name, count, valueSen }], categories: [{ category, qty, netSen }] }`
- `pos_report_payments` → `{ methods: [{ name, kind, count, amountSen, refundCount, refundSen, netSen }] }`
- `pos_report_sst` → `{ rates: [{ rateBp, baseSen, sstSen }], exemptSen, months: [{ month, rates: [{ rateBp, baseSen, sstSen }], exemptSen }] }`
- `pos_report_audit` → `{ discounts: [{ at, outlet, billNo, item, action, kind, value, reason, by, approvedBy }], discountTotals: { catalogSen, catalogBills, itemSen, itemCount, billSen, billCount }, voidItems: [{ at, outlet, billNo, name, qty, valueSen, reason, by, approvedBy }], voidBills: [{ at, outlet, billNo, valueSen, reason, by, approvedBy }], refunds: [{ at, outlet, billNo, method, amountSen, reason, approvedBy }] }`
- `pos_report_drawer` → `{ shifts: [{ outlet, openedAt, closedAt, openedBy, closedBy, floatSen, cashSalesSen, cashRefundSen, payInSen, payOutSen, expectedSen, countedSen, varianceSen, reason }] }`
- `pos_report_ledger` → `{ bills: [{ outlet, businessDate, closedAt, billNo, orderType, table, pax, grossSen, discountSen, takeawayFeeSen, serviceChargeSen, sstSen, roundingSen, totalSen, refundedSen }], lines: [{ outlet, billNo, item, qty, unitPriceSen, catalogDiscountSen, itemDiscountSen, billShareSen, netSen, sstRateBp, sstSen }], payments: [{ outlet, billNo, partNo, method, kind, amountSen, tenderedSen, changeSen, reference, takenAt }] }`

Times (`at`, `openedAt`, `closedAt`, `takenAt`) are ISO UTC strings `YYYY-MM-DDTHH:MI:SS.MSZ`; days are `YYYY-MM-DD`; months `YYYY-MM`. Nullable: `category`, `item`, `kind`, `value`, `reason`, `by`, `approvedBy`, `closedAt`, `openedBy`, `closedBy`, `countedSen`, `varianceSen`, `table`, `pax`, `partNo`, `tenderedSen`, `reference`.

---

### Task 1: SQL — business day, scope and the sales report

**Files:**
- Create: `supabase/migration-2026-11-18-pos-reports.sql`
- Create: `supabase/migration-2026-11-18-pos-reports-verify.sql`
- Modify: `src/features/pos/sqlSafeUpdate.test.ts` (a new `it` directly after `it('scans the menu picks: …')`, inside `describe('pg-safeupdate guard: POS migrations')`)

**Interfaces:**
- Consumes (live on dev): `pos_manages_outlet(uuid) → boolean` (access_settings + `staff_outlet_scope(auth.uid())`), `pos_picks_rules()`, `pos_shift_expected_cash(uuid)`, table `bill_parts`, the index `bills_branch_paid_closed_idx on bills(branch_id, closed_at) where status = 'paid'`.
- Produces:
  - `pos_business_day(p_at timestamptz) → date` — internal.
  - `pos_report_scope(p_branch_ids uuid[], p_from date, p_to date, out start_at timestamptz, out end_at timestamptz)` — internal; raises the five words of spec note 13; `start_at` = `p_from` 06:00 Malaysia, `end_at` = `p_to + 1` 06:00 Malaysia (exclusive).
  - `pos_report_paid_bills(p_branch_ids uuid[], p_start timestamptz, p_end timestamptz) → setof bills` — internal.
  - `pos_report_cards(p_branch_ids uuid[], p_start timestamptz, p_end timestamptz) → jsonb` `{ nettSen, bills, pax, discountSen, voidSen, refundSen }` — internal.
  - `pos_report_sales(p_branch_ids uuid[], p_from date, p_to date) → jsonb` — shape in File Structure; granted to authenticated.
  - Verify file: helpers `pg_temp.expect_error(sql, message, label)`, `pg_temp.act(uuid)`, `pg_temp.put(key, uuid)`, `pg_temp.id(key) → uuid`, `pg_temp.ok(jsonb, label)`, `pg_temp.pay(method key, sen, tendered default null) → jsonb`, `pg_temp.order_on(table key | null, pax, keys text[]) → order uuid`, `pg_temp.bill_of(order uuid) → bill uuid`; fixture keys `branch`, `other`, `r1`…`r7`, `latte` `cake` `muffin` `water` (+ `_v`), `card`, `cash`, `owner`, `sup`, `cashier`, `dev`, `mgr`, `shift`, `S1`, `A`, `B`, `Bwater`, `C`, `Dpart`, `D`, `E`, `Epart`, `F`, `G`, `P`. Tasks 2 and 3 add their DO blocks before the final `select 'VERIFY OK' as result;`.

- [ ] **Step 1: Write the failing test**

In `src/features/pos/sqlSafeUpdate.test.ts`, add this `it` directly after the `it('scans the menu picks: …', () => { … })` block (still inside `describe('pg-safeupdate guard: POS migrations', …)`):

```ts
  it('scans the sales reports: read-only reports for authenticated only, internal helpers closed, a STOP guard', () => {
    const sql = readFileSync(new URL('migration-2026-11-18-pos-reports.sql', SUPABASE), 'utf8')
    const internal = ['pos_business_day', 'pos_report_scope', 'pos_report_paid_bills', 'pos_report_cards']
    const reports = ['pos_report_sales']
    const bodies = functionBodies(sql)
    expect(bodies.map((b) => b.name).sort()).toEqual([...internal, ...reports].sort())
    for (const { name, body } of bodies) {
      expect(body, name).not.toMatch(/\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i)   // reports never write
    }
    for (const f of internal) {
      expect(sql).toMatch(new RegExp(`revoke all on function ${f}\\([^)]*\\) from public, anon, authenticated;`))
    }
    for (const f of reports) {
      expect(sql).toMatch(new RegExp(`revoke all on function ${f}\\(uuid\\[\\], date, date\\) from public, anon;`))
      expect(sql).toMatch(new RegExp(`grant execute on function ${f}\\(uuid\\[\\], date, date\\) to authenticated;`))
    }
    expect([...sql.matchAll(/grant execute on function (\w+)\(/g)].map((m) => m[1]).sort()).toEqual([...reports].sort())
    expect(sql).toMatch(/raise exception 'STOP: run migration-2026-11-17-menu-picks\.sql first/)
    expect(sql).toMatch(/create index if not exists pos_discount_log_branch_created_idx on pos_discount_log\(branch_id, created_at\);/)
    expect(sql).toMatch(/notify pgrst, 'reload schema';\s*select '[^']+' as result;\s*$/)
    const verify = readFileSync(new URL('migration-2026-11-18-pos-reports-verify.sql', SUPABASE), 'utf8')
    expect(verify).toMatch(/^begin;$/m)
    expect(verify).toMatch(/select 'VERIFY OK' as result;\s*rollback;\s*$/)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts`
Expected: FAIL — the new test throws `ENOENT: no such file or directory, open '…/supabase/migration-2026-11-18-pos-reports.sql'`; every other test passes.

- [ ] **Step 3: Write the migration**

Create `supabase/migration-2026-11-18-pos-reports.sql`:

```sql
-- ============================================================================
-- Craft OS — POS sales reports, W3 (2026-11-18). Run on craft-os-dev after
-- migration-2026-11-17-menu-picks.sql. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-11-18-pos-sales-reports.md
-- Design: docs/superpowers/specs/2026-11-18-pos-sales-reports-design.md
--
-- R1  pos_business_day: the business day of a time (06:00 to 05:59 the next morning, Malaysia time).
--     pos_report_scope: the caller manages every outlet asked for (pos_manages_outlet), the range is 1 to
--     366 whole business days; returns its UTC bounds [start_at, end_at). pos_report_paid_bills: the
--     sales of a scope (status 'paid', closed_at in the bounds). pos_report_cards: the Overview cards of
--     one period. Index pos_discount_log(branch_id, created_at).
-- R2  pos_report_sales: the cards of the range and of the period of the same length before it, daily,
--     hourly, the sales summary (the Z report's arithmetic), order types, sources, top 10 products.
-- R3  pos_report_lines: the live lines of the paid bills with their discounts and their net after
--     discounts (bills.totals.lines). pos_report_products, pos_report_payments, pos_report_sst.
-- R4  pos_report_audit (discounts set and cleared, voids, refunds), pos_report_drawer (one row per
--     shift), pos_report_ledger (bills, lines with their SST share, payments).
-- The reports read the totals frozen at checkout and never re-price. Refunds are listed apart and never
-- taken out of sales or SST. Every report is stable security definer, granted to authenticated only;
-- the helpers are internal.
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file; the reports never write).
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_picks_rules()') is null or to_regprocedure('pos_manages_outlet(uuid)') is null
     or to_regprocedure('pos_shift_expected_cash(uuid)') is null or to_regclass('public.bill_parts') is null then
    raise exception 'STOP: run migration-2026-11-17-menu-picks.sql first (pos_picks_rules, pos_manages_outlet, pos_shift_expected_cash or bill_parts is missing)';
  end if;
end $$;

-- ── R1. Index ───────────────────────────────────────────────────────────────
-- The Discounts tab reads the log by outlet and time. The paid bills already have theirs
-- (bills_branch_paid_closed_idx, migration-2026-11-17-menu-picks.sql).
create index if not exists pos_discount_log_branch_created_idx on pos_discount_log(branch_id, created_at);

-- ── R1. The business day, the scope, the sales of a scope ───────────────────
-- 06:00 to 05:59 the next morning, Malaysia time: a bill closed at 01:30 belongs to the day before.
create or replace function pos_business_day(p_at timestamptz) returns date
language sql immutable security definer set search_path = public, pg_temp as $$
  select ((p_at at time zone 'Asia/Kuala_Lumpur') - interval '6 hours')::date
$$;
revoke all on function pos_business_day(timestamptz) from public, anon, authenticated;

-- Every report starts here: the outlets asked for are all the caller's (a Craft OS back-office login
-- with access_settings and the outlet in its scope; a tablet's session is not one), the range is whole
-- business days, from <= to, at most 366 days. Returns the UTC bounds, end exclusive.
create or replace function pos_report_scope(p_branch_ids uuid[], p_from date, p_to date,
                                            out start_at timestamptz, out end_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if p_branch_ids is null or cardinality(p_branch_ids) = 0 then
    raise exception 'Choose at least one outlet.';
  end if;
  if p_from is null or p_to is null then
    raise exception 'Choose a valid date range.';
  end if;
  if p_from > p_to then
    raise exception 'The start date is after the end date.';
  end if;
  if p_to - p_from + 1 > 366 then
    raise exception 'Choose at most 366 days.';
  end if;
  foreach v_id in array p_branch_ids loop
    if v_id is null or not pos_manages_outlet(v_id) then
      raise exception 'You cannot see reports for this outlet.';
    end if;
  end loop;
  start_at := (p_from + time '06:00') at time zone 'Asia/Kuala_Lumpur';
  end_at   := (p_to + 1 + time '06:00') at time zone 'Asia/Kuala_Lumpur';
end $$;
revoke all on function pos_report_scope(uuid[], date, date) from public, anon, authenticated;

-- The sales: paid bills (a split part is its own paid bill; voided and merged bills are not sales)
-- closed inside the bounds. Uses bills_branch_paid_closed_idx.
create or replace function pos_report_paid_bills(p_branch_ids uuid[], p_start timestamptz, p_end timestamptz)
returns setof bills
language sql stable security definer set search_path = public, pg_temp as $$
  select b.* from bills b
   where b.branch_id = any (p_branch_ids) and b.status = 'paid'
     and b.closed_at >= p_start and b.closed_at < p_end
$$;
revoke all on function pos_report_paid_bills(uuid[], timestamptz, timestamptz) from public, anon, authenticated;

-- The Overview cards of one period (spec §5.1). Voids: items voided in the period (a voided bill's
-- items are voided with it); refunds by their own time, never taken off the sales.
create or replace function pos_report_cards(p_branch_ids uuid[], p_start timestamptz, p_end timestamptz) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'nettSen', coalesce(sum(b.total_sen), 0),
    'bills', count(*)::integer,
    'pax', coalesce(sum(b.pax), 0)::integer,
    'discountSen', coalesce(sum(coalesce((b.totals->>'catalogDiscountSen')::integer, 0)
                                + coalesce((b.totals->>'itemDiscountSen')::integer, 0)
                                + coalesce((b.totals->>'billDiscountSen')::integer, 0)), 0),
    'voidSen', (select coalesce(sum(oi.unit_price_sen * oi.qty), 0)
                  from order_items oi join bills vb on vb.id = oi.bill_id
                 where vb.branch_id = any (p_branch_ids) and oi.voided_at >= p_start and oi.voided_at < p_end),
    'refundSen', (select coalesce(sum(r.amount_sen), 0)
                    from refunds r
                   where r.branch_id = any (p_branch_ids) and r.created_at >= p_start and r.created_at < p_end))
    from pos_report_paid_bills(p_branch_ids, p_start, p_end) b
$$;
revoke all on function pos_report_cards(uuid[], timestamptz, timestamptz) from public, anon, authenticated;

-- ── R2. Sales: Overview, Sales summary, Daily and Hourly sales (spec §5.1–5.4) ─
-- previous = the period of the same length just before (Malaysia has no daylight saving, so the bounds
-- shift by whole days). The summary is pos_shift_report's arithmetic (migration-2026-11-17-pos-bill-parts.sql
-- B6): before discounts = totals.grossSen (subtotal for an old bill), gross = subtotal − bill discount.
create or replace function pos_report_sales(p_branch_ids uuid[], p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s     record;
  v_out jsonb;
begin
  select * into s from pos_report_scope(p_branch_ids, p_from, p_to);
  with pb as (
    select b.*, pos_business_day(b.closed_at) as bday,
           coalesce((b.totals->>'grossSen')::integer, b.subtotal_sen) as before_disc,
           coalesce((b.totals->>'catalogDiscountSen')::integer, 0) as cat_disc,
           coalesce((b.totals->>'itemDiscountSen')::integer, 0) as item_disc,
           coalesce((b.totals->>'billDiscountSen')::integer, 0) as bill_disc
      from pos_report_paid_bills(p_branch_ids, s.start_at, s.end_at) b),
  rf as (                                             -- refunds per outlet and business day of their own time
    select r.branch_id, pos_business_day(r.created_at) as bday, sum(r.amount_sen) as refund
      from refunds r
     where r.branch_id = any (p_branch_ids) and r.created_at >= s.start_at and r.created_at < s.end_at
     group by r.branch_id, pos_business_day(r.created_at)),
  bd as (                                             -- sales per outlet and business day
    select pb.branch_id, pb.bday, count(*)::integer as bills, coalesce(sum(pb.pax), 0)::integer as pax,
           sum(pb.before_disc) as gross, sum(pb.cat_disc + pb.item_disc + pb.bill_disc) as disc,
           sum(pb.takeaway_fee_sen) as fee, sum(pb.service_charge_sen) as sc, sum(pb.sst_sen) as sst,
           sum(pb.rounding_sen) as rounding, sum(pb.total_sen) as nett
      from pb
     group by pb.branch_id, pb.bday),
  days as (                                           -- an outlet-day with a sale or a refund
    select coalesce(bd.branch_id, rf.branch_id) as branch_id, coalesce(bd.bday, rf.bday) as bday,
           coalesce(bd.bills, 0) as bills, coalesce(bd.pax, 0) as pax, coalesce(bd.gross, 0) as gross,
           coalesce(bd.disc, 0) as disc, coalesce(bd.fee, 0) as fee, coalesce(bd.sc, 0) as sc,
           coalesce(bd.sst, 0) as sst, coalesce(bd.rounding, 0) as rounding, coalesce(bd.nett, 0) as nett,
           coalesce(rf.refund, 0) as refund
      from bd
      full join rf on rf.branch_id = bd.branch_id and rf.bday = bd.bday),
  hours as (                                          -- 0–23, the Malaysia hour of closed_at
    select h.hr, count(pb.id)::integer as bills, coalesce(sum(pb.total_sen), 0) as nett
      from generate_series(0, 23) as h(hr)
      left join pb on extract(hour from pb.closed_at at time zone 'Asia/Kuala_Lumpur')::integer = h.hr
     group by h.hr),
  best as (                                           -- top 10 products by quantity, today's name
    select coalesce(min(p.name), min(oi.name_snapshot)) as name, sum(oi.qty)::integer as qty,
           sum(oi.unit_price_sen * oi.qty) as val
      from order_items oi
      join pb on pb.id = oi.bill_id
      left join menu_products p on p.id = oi.product_id
     where oi.voided_at is null
     group by coalesce(oi.product_id::text, oi.name_snapshot)
     order by qty desc, val desc, name
     limit 10)
  select jsonb_build_object(
    'current', pos_report_cards(p_branch_ids, s.start_at, s.end_at),
    'previous', pos_report_cards(p_branch_ids, s.start_at - (s.end_at - s.start_at), s.start_at),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object(
               'branchId', d.branch_id, 'outlet', br.name, 'day', to_char(d.bday, 'YYYY-MM-DD'),
               'bills', d.bills, 'pax', d.pax, 'grossSen', d.gross, 'discountSen', d.disc, 'takeawayFeeSen', d.fee,
               'serviceChargeSen', d.sc, 'sstSen', d.sst, 'roundingSen', d.rounding, 'nettSen', d.nett,
               'refundSen', d.refund)
             order by d.bday, br.name, d.branch_id)
        from days d join branches br on br.id = d.branch_id), '[]'::jsonb),
    'hourly', (select jsonb_agg(jsonb_build_object('hour', x.hr, 'bills', x.bills, 'nettSen', x.nett) order by x.hr)
                 from hours x),
    'summary', (
      select jsonb_build_object(
               'beforeDiscountsSen', coalesce(sum(pb.before_disc), 0),
               'catalogDiscountSen', coalesce(sum(pb.cat_disc), 0),
               'itemDiscountSen', coalesce(sum(pb.item_disc), 0),
               'billDiscountSen', coalesce(sum(pb.bill_disc), 0),
               'grossSen', coalesce(sum(pb.subtotal_sen - pb.bill_disc), 0),
               'takeawayFeeSen', coalesce(sum(pb.takeaway_fee_sen), 0),
               'serviceChargeSen', coalesce(sum(pb.service_charge_sen), 0),
               'sstSen', coalesce(sum(pb.sst_sen), 0),
               'roundingSen', coalesce(sum(pb.rounding_sen), 0),
               'nettSen', coalesce(sum(pb.total_sen), 0))
        from pb),
    'orderTypes', (
      select jsonb_agg(jsonb_build_object(
               'orderType', x.ot,
               'bills', (select count(*)::integer from pb where pb.order_type = x.ot),
               'nettSen', (select coalesce(sum(pb.total_sen), 0) from pb where pb.order_type = x.ot))
             order by x.ord)
        from (values ('dine_in', 1), ('takeaway', 2)) as x(ot, ord)),
    'sources', (
      select jsonb_agg(jsonb_build_object(
               'source', x.src,
               'orders', (select count(distinct oi.order_id)::integer
                            from order_items oi join orders o on o.id = oi.order_id
                           where oi.bill_id in (select pb.id from pb) and o.source = x.src),
               'itemSen', (select coalesce(sum(oi.unit_price_sen * oi.qty), 0)
                             from order_items oi join orders o on o.id = oi.order_id
                            where oi.bill_id in (select pb.id from pb) and o.source = x.src and oi.voided_at is null))
             order by x.ord)
        from (values ('counter', 1), ('qr', 2)) as x(src, ord)),
    'topProducts', coalesce((
      select jsonb_agg(jsonb_build_object('name', t.name, 'qty', t.qty, 'valueSen', t.val)
                       order by t.qty desc, t.val desc, t.name)
        from best t), '[]'::jsonb))
    into v_out;
  return v_out;
end $$;
revoke all on function pos_report_sales(uuid[], date, date) from public, anon;
grant execute on function pos_report_sales(uuid[], date, date) to authenticated;

notify pgrst, 'reload schema';
select 'pos reports applied' as result;
```

- [ ] **Step 4: Write the verify script**

Create `supabase/migration-2026-11-18-pos-reports-verify.sql` (Tasks 2 and 3 add sections R3 and R4 before the final `select`):

```sql
-- Self-check for the POS sales reports (W3). Run on craft-os-dev after
-- migration-2026-11-18-pos-reports.sql. Everything is rolled back. Success = a result row
-- "VERIFY OK". Sections (one DO block each, ids in the temp table fixture): FIXTURE; R1 scope and
-- access; R2 sales; R3 products, payments and SST; R4 discounts, voids, refunds, cash drawer, ledger.
-- Outlet VERIFY R: SST registered, no service charge, 5 sen rounding. Latte 10.00 (6%), Cake 8.00 and
-- Muffin 10.20 (8%), Water 2.00 (0%). Business days D1 = Mon 5 Jan 2026, D2 = Tue 6 Jan 2026; the
-- times below are Malaysia time:
--   A   R1 pax 2  Latte, Cake (10% off), Water; a RM 1.00 bill discount set, then cleared   card 20.40   D1 12:00
--   B   R2 pax 1  Latte x2 (Water voided D1 13:00), RM 2.00 off the bill                     cash 19.10   6 Jan 01:30 = D1
--   C   takeaway  Cake, Muffin, Muffin                                                       cash 30.65   D2 10:00; RM 3.00 refunded 10:30
--   D'  R3        Water, split off D by item                                                 card  2.00   D2 13:00
--   D   R3 pax 2  Latte                                                                      card 10.60   D2 13:10
--   E   R4 pax 2  Cake, Latte (a QR order)                       card 10.00 part (13:50) + cash 9.25   D2 14:00
--   F   R5 pax 2  Water                                                                      card  2.00   7 Jan 06:00 = outside
--   G   R6 pax 2  Water; the bill voided                                                                  D2 15:00
--   P   R7 pax 2  Latte                                                       card 10.60   5 Jan 05:59 = 4 Jan, previous period
-- D1..D2: 6 bills, pax 7, nett 102.00, discounts 2.80, voids 4.00, refunds 3.00 (never taken off).
-- Shifts: S1 (D2 08:00–22:00, closed) holds C's and E's cash, C's refund, pay in 20.00, pay out 5.00;
-- the tablet's own shift stays open, moved to D2 20:00, with B's cash.
begin;

create function pg_temp.expect_error(p_sql text, p_message text, p_label text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FAIL %: no error (expected "%")', p_label, p_message using errcode = 'assert_failure';
exception when raise_exception then
  if sqlerrm is distinct from p_message then
    raise exception 'FAIL %: got "%" (expected "%")', p_label, sqlerrm, p_message;
  end if;
end $$;
create function pg_temp.act(p_user uuid) returns void
language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
create temp table fixture (k text primary key, v uuid);
create function pg_temp.put(p_k text, p_v uuid) returns void
language sql as $$ insert into pg_temp.fixture(k, v) values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.id(p_k text) returns uuid
language sql as $$ select v from pg_temp.fixture where k = p_k $$;
create function pg_temp.ok(p_res jsonb, p_label text) returns void
language plpgsql as $$
begin
  if not coalesce((p_res->>'ok')::boolean, false) then
    raise exception 'FAIL fixture %: %', p_label, p_res;
  end if;
end $$;
-- one payment of a method (fixture key 'card' or 'cash'); tendered only for cash
create function pg_temp.pay(p_method text, p_sen integer, p_tendered integer default null) returns jsonb
language sql as $$
  select jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('methodId', pg_temp.id(p_method), 'amountSen', p_sen,
                                                                 'tenderedSen', p_tendered)))
$$;
-- one counter order: p_table null = takeaway; a key 'latte:2' orders 2 on one line; returns the order id
create function pg_temp.order_on(p_table text, p_pax integer, p_keys text[]) returns uuid
language sql as $$
  select place_counter_order(
           pg_temp.id(p_table), case when p_table is null then 'takeaway' else 'dine_in' end, p_pax,
           (select jsonb_agg(jsonb_build_object('productId', pg_temp.id(split_part(k, ':', 1)),
                                                'variantId', pg_temp.id(split_part(k, ':', 1) || '_v'),
                                                'qty', coalesce(nullif(split_part(k, ':', 2), ''), '1')::integer)
                             order by o)
              from unnest(p_keys) with ordinality as x(k, o)),
           gen_random_uuid())
$$;
create function pg_temp.bill_of(p_order uuid) returns uuid
language sql as $$ select bill_id from orders where id = p_order $$;

-- ── FIXTURE: outlets VERIFY R and VERIFY R OTHER, tables R1–R7, four products in two categories, a
--    card and a cash method, a cashier and a supervisor with PINs, a manager of VERIFY R OTHER only, one
--    tablet signed in, a shift open; then the bills of the header, moved to their business days ──
do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_cash  uuid := 'eeeeeeee-0000-0000-0000-0000000007b1';
  v_sup   uuid := 'eeeeeeee-0000-0000-0000-0000000007b2';
  v_dev   uuid := 'eeeeeeee-0000-0000-0000-0000000007b3';
  v_mgr   uuid := 'eeeeeeee-0000-0000-0000-0000000007b4';
  v_a uuid; v_other uuid; v_t uuid; v_drinks uuid; v_food uuid; v_catalog uuid; v_p uuid; v_v uuid;
  v_o uuid; v_b uuid; v_s1 uuid; v_res jsonb; r record; i integer;
begin
  -- the role defaults decide (owner: every outlet; manager: access_settings) — and a manager is held to
  -- their own outlets here
  update system_role_permissions set permissions = permissions - 'pos_login' - 'all_branches' - 'access_settings' - 'pos_supervise'
   where true;
  update system_role_permissions set permissions = permissions || '{"all_branches": false}' where system_role = 'manager';
  insert into branches(name, address) values ('VERIFY R', 'r') returning id into v_a;
  insert into branches(name, address) values ('VERIFY R OTHER', 'r') returning id into v_other;
  perform pg_temp.put('branch', v_a); perform pg_temp.put('other', v_other);
  for i in 1..7 loop
    insert into dining_tables(branch_id, label, sort_order) values (v_a, 'R' || i, i) returning id into v_t;
    perform pg_temp.put('r' || i, v_t);
  end loop;
  insert into print_routes(branch_id, name, kind, address) values (v_a, 'Bar', 'agent', '127.0.0.1:9100');
  insert into branch_pos_settings(branch_id, receipt_route) values (v_a, 'Bar');
  insert into menu_categories(name, sort_order) values ('VERIFY R DRINKS', 901) returning id into v_drinks;
  insert into menu_categories(name, sort_order) values ('VERIFY R FOOD', 902) returning id into v_food;
  insert into menu_catalogs(name, sort_order) values ('VERIFY R MENU', 901) returning id into v_catalog;
  for r in select * from (values ('latte', 'Verify R Latte', 1000, 600, v_drinks), ('cake', 'Verify R Cake', 800, 800, v_food),
                                 ('muffin', 'Verify R Muffin', 1020, 800, v_food), ('water', 'Verify R Water', 200, 0, v_drinks))
                    as x(k, name, sen, bp, cat) loop
    insert into menu_products(name, category_id, sst_rate_bp) values (r.name, r.cat, r.bp) returning id into v_p;
    insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_p, '', 'Regular', r.sen) returning id into v_v;
    insert into catalog_products(catalog_id, product_id, availability) values (v_catalog, v_p, 'all');
    insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (v_catalog, v_v, r.sen);
    perform pg_temp.put(r.k, v_p); perform pg_temp.put(r.k || '_v', v_v);
  end loop;
  insert into branch_catalogs(branch_id, role, catalog_id) values (v_a, 'dine_in', v_catalog), (v_a, 'takeaway', v_catalog), (v_a, 'qr', v_catalog);
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_a, 'R Card', 'card', 1) returning id into v_t;
  perform pg_temp.put('card', v_t);
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_a, 'R Cash', 'cash', 2) returning id into v_t;
  perform pg_temp.put('cash', v_t);
  update staff set branch_id = v_a where id = v_owner;
  perform pg_temp.act(v_owner);
  insert into auth.users (id) values (v_cash), (v_sup), (v_dev), (v_mgr);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_cash, 'Verify R Cashier',    'trainee', true, current_date, 'staff', v_a),
    (v_sup,  'Verify R Supervisor', 'trainee', true, current_date, 'staff', v_a),
    (v_mgr,  'Verify R Manager',    'trainee', true, current_date, 'staff', v_other);
  update staff set system_role = 'supervisor' where id = v_sup;
  update staff set system_role = 'manager' where id = v_mgr;
  for r in select * from (values (v_cash, '1111'), (v_sup, '2222')) as x(id, pin) loop
    perform pg_temp.act(r.id);
    if not coalesce((set_my_pos_pin(r.pin, null)->>'ok')::boolean, false) then raise exception 'FAIL fixture: PIN of %', r.id; end if;
  end loop;
  insert into pos_devices(id, branch_id, kind, name, platform, prints, approved_by) values (v_dev, v_a, 'pos', 'R Counter', 'ipad', true, v_owner);
  perform pg_temp.put('owner', v_owner); perform pg_temp.put('sup', v_sup); perform pg_temp.put('cashier', v_cash);
  perform pg_temp.put('dev', v_dev); perform pg_temp.put('mgr', v_mgr);
  perform pg_temp.act(v_dev);
  v_res := pos_start_session(v_cash, '1111');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: cashier sign-in: %', v_res; end if;
  v_res := open_shift(10000);
  perform pg_temp.put('shift', (v_res->'shift'->>'id')::uuid);

  -- A: a bill discount set and cleared, then 10% off the Cake; 20.00 − 0.80 + SST 0.60 + 0.58 = 20.38 → 20.40
  v_b := pg_temp.bill_of(pg_temp.order_on('r1', 2, array['latte', 'cake', 'water']));
  perform pg_temp.put('A', v_b);
  perform pg_temp.ok(set_bill_discount(v_b, 'amount', 100, 'Regular', v_sup, '2222'), 'A bill discount');
  perform pg_temp.ok(clear_bill_discount(v_b), 'A clear');
  perform pg_temp.ok(set_item_discount((select id from order_items where bill_id = v_b and product_id = pg_temp.id('cake')),
                                       'percent', 1000, 'Regular', v_sup, '2222'), 'A item discount');
  perform checkout_bill(v_b, pg_temp.pay('card', 2040), gen_random_uuid());
  -- B: Water voided, RM 2.00 off; 20.00 − 2.00 + SST 1.08 = 19.08 → 19.10
  v_b := pg_temp.bill_of(pg_temp.order_on('r2', 1, array['latte:2', 'water']));
  perform pg_temp.put('B', v_b);
  perform pg_temp.put('Bwater', (select id from order_items where bill_id = v_b and product_id = pg_temp.id('water')));
  perform pg_temp.ok(void_order_item(pg_temp.id('Bwater'), 'Wrong item keyed', v_sup, '2222'), 'B void');
  perform pg_temp.ok(set_bill_discount(v_b, 'amount', 200, 'Regular', v_sup, '2222'), 'B bill discount');
  perform checkout_bill(v_b, pg_temp.pay('cash', 1910, 2000), gen_random_uuid());
  -- C: takeaway, 28.40 + SST 2.27 = 30.67 → 30.65; RM 3.00 refunded in cash
  v_b := pg_temp.bill_of(pg_temp.order_on(null, null, array['cake', 'muffin', 'muffin']));
  perform pg_temp.put('C', v_b);
  if (select count(*) from order_items where bill_id = v_b and product_id = pg_temp.id('muffin')) <> 2 then
    raise exception 'FAIL fixture: C should have two Muffin lines';
  end if;
  perform checkout_bill(v_b, pg_temp.pay('cash', 3065, 5000), gen_random_uuid());
  perform pg_temp.ok(refund_bill(gen_random_uuid(), v_b, 300, pg_temp.id('cash'), 'Cold cake', v_sup, '2222'), 'C refund');
  -- D: the Water split off by item (its own paid bill D'), then the Latte
  v_b := pg_temp.bill_of(pg_temp.order_on('r3', 2, array['latte', 'water']));
  perform pg_temp.put('D', v_b);
  v_res := checkout_items(v_b, jsonb_build_array(jsonb_build_object(
             'itemId', (select id from order_items where bill_id = v_b and product_id = pg_temp.id('water')), 'qty', 1)),
           pg_temp.pay('card', 200), gen_random_uuid());
  perform pg_temp.put('Dpart', (v_res->>'billId')::uuid);
  perform checkout_bill(v_b, pg_temp.pay('card', 1060), gen_random_uuid());
  -- E: a QR order; RM 10.00 paid as a part, the rest (19.24 → 19.25) in cash
  v_o := pg_temp.order_on('r4', 2, array['cake', 'latte']);
  v_b := pg_temp.bill_of(v_o);
  perform pg_temp.put('E', v_b);
  update orders set source = 'qr' where id = v_o;
  perform pg_temp.put('Epart', gen_random_uuid());
  perform pay_bill_part(v_b, pg_temp.id('Epart'), 1000, null, pg_temp.pay('card', 1000), 0);
  perform checkout_bill(v_b, pg_temp.pay('cash', 925, 925), gen_random_uuid());
  -- F: outside the range; G: a voided bill; P: the previous period
  v_b := pg_temp.bill_of(pg_temp.order_on('r5', 2, array['water']));
  perform pg_temp.put('F', v_b);
  perform checkout_bill(v_b, pg_temp.pay('card', 200), gen_random_uuid());
  v_b := pg_temp.bill_of(pg_temp.order_on('r6', 2, array['water']));
  perform pg_temp.put('G', v_b);
  perform pg_temp.ok(void_bill(v_b, 'Guest left', v_sup, '2222'), 'G void');
  v_b := pg_temp.bill_of(pg_temp.order_on('r7', 2, array['latte']));
  perform pg_temp.put('P', v_b);
  perform checkout_bill(v_b, pg_temp.pay('card', 1060), gen_random_uuid());

  -- add-ons as the lines carry them (the snapshot only; the prices above stay as charged)
  update order_items
     set modifiers_snapshot = '[{"optionId": null, "group": "Milk", "name": "Oat milk", "priceDeltaSen": 150, "route": null}]'
   where bill_id in (pg_temp.id('A'), pg_temp.id('E')) and product_id = pg_temp.id('latte');
  update order_items
     set modifiers_snapshot = '[{"optionId": null, "group": "Extra", "name": "Extra shot", "priceDeltaSen": 100, "route": null}]'
   where bill_id = pg_temp.id('B') and product_id = pg_temp.id('latte');

  -- the business days of the story (all of it ran at now(), in one transaction)
  for r in select * from (values ('A', '2026-01-05 12:00+08'), ('B', '2026-01-06 01:30+08'), ('C', '2026-01-06 10:00+08'),
                                 ('Dpart', '2026-01-06 13:00+08'), ('D', '2026-01-06 13:10+08'), ('E', '2026-01-06 14:00+08'),
                                 ('F', '2026-01-07 06:00+08'), ('G', '2026-01-06 15:00+08'), ('P', '2026-01-05 05:59+08'))
                    as x(k, at) loop
    update bills set closed_at = r.at::timestamptz where id = pg_temp.id(r.k);
    update payments set taken_at = r.at::timestamptz where bill_id = pg_temp.id(r.k);
  end loop;
  update payments set taken_at = '2026-01-06 13:50+08' where part_id = pg_temp.id('Epart');
  update order_items set voided_at = '2026-01-05 13:00+08' where id = pg_temp.id('Bwater');
  update order_items set voided_at = '2026-01-06 15:00+08' where bill_id = pg_temp.id('G');
  update refunds set created_at = '2026-01-06 10:30+08' where bill_id = pg_temp.id('C');
  update pos_discount_log set created_at = '2026-01-05 11:40+08'
   where bill_id = pg_temp.id('A') and order_item_id is null and action = 'set';
  update pos_discount_log set created_at = '2026-01-05 11:45+08' where bill_id = pg_temp.id('A') and action = 'clear';
  update pos_discount_log set created_at = '2026-01-05 11:50+08' where bill_id = pg_temp.id('A') and order_item_id is not null;
  update pos_discount_log set created_at = '2026-01-05 13:05+08' where bill_id = pg_temp.id('B');

  -- the cash drawer: S1 (D2 08:00–22:00) takes C's and E's cash, C's refund, a pay in and a pay out;
  -- expected 100.00 + 30.65 + 9.25 − 3.00 + 20.00 − 5.00 = 151.90, counted 151.50
  insert into pos_shifts(branch_id, opened_by, opened_at, opening_float_sen, status, counted_cash_sen, expected_cash_sen,
                         variance_sen, variance_reason, variance_approved_by, closed_by, closed_at)
  values (v_a, v_cash, '2026-01-06 08:00+08', 10000, 'closed', 15150, 15190, -40, 'Short at close', v_sup, v_cash,
          '2026-01-06 22:00+08')
  returning id into v_s1;
  perform pg_temp.put('S1', v_s1);
  update payments set shift_id = v_s1 where bill_id in (pg_temp.id('C'), pg_temp.id('E')) and kind = 'cash';
  update refunds set shift_id = v_s1 where bill_id = pg_temp.id('C');
  insert into pos_cash_moves(id, shift_id, branch_id, kind, amount_sen, reason, created_by, approved_by, created_at) values
    (gen_random_uuid(), v_s1, v_a, 'pay_in', 2000, 'Float top-up', v_cash, null, '2026-01-06 09:00+08'),
    (gen_random_uuid(), v_s1, v_a, 'pay_out', 500, 'Ice', v_cash, v_sup, '2026-01-06 16:00+08');
  -- the tablet's shift stays open: opened D2 20:00, B's cash in it, expected 100.00 + 19.10 = 119.10
  update pos_shifts set opened_at = '2026-01-06 20:00+08' where id = pg_temp.id('shift');
end $$;

-- ── R1. Scope and access (spec §2, §3) ──────────────────────────────────────
do $$
declare
  v_a     uuid := pg_temp.id('branch');
  v_other uuid := pg_temp.id('other');
  v_b     record;
  r       record;
begin
  -- grants: the report to authenticated only; the helpers to nobody; the index
  if not has_function_privilege('authenticated', 'pos_report_sales(uuid[],date,date)', 'execute')
     or has_function_privilege('anon', 'pos_report_sales(uuid[],date,date)', 'execute') then
    raise exception 'FAIL R1 grants: pos_report_sales';
  end if;
  for r in select f from unnest(array['pos_business_day(timestamptz)', 'pos_report_scope(uuid[],date,date)',
                                      'pos_report_paid_bills(uuid[],timestamptz,timestamptz)',
                                      'pos_report_cards(uuid[],timestamptz,timestamptz)']) f loop
    if has_function_privilege('authenticated', r.f, 'execute') or has_function_privilege('anon', r.f, 'execute') then
      raise exception 'FAIL R1 grants: % is internal', r.f;
    end if;
  end loop;
  if to_regclass('public.pos_discount_log_branch_created_idx') is null then
    raise exception 'FAIL R1: index pos_discount_log_branch_created_idx is missing';
  end if;
  -- the business day: 06:00 to 05:59 the next morning, Malaysia time
  if pos_business_day('2026-01-06 01:30+08') <> date '2026-01-05'
     or pos_business_day('2026-01-05 06:00+08') <> date '2026-01-05'
     or pos_business_day('2026-01-05 05:59:59+08') <> date '2026-01-04' then
    raise exception 'FAIL R1 business day';
  end if;
  -- D1..D2 = D1 06:00 up to (not including) 7 Jan 06:00
  perform pg_temp.act(pg_temp.id('owner'));
  select * into v_b from pos_report_scope(array[v_a], '2026-01-05', '2026-01-06');
  if v_b.start_at <> '2026-01-05 06:00+08'::timestamptz or v_b.end_at <> '2026-01-07 06:00+08'::timestamptz then
    raise exception 'FAIL R1 bounds: % %', v_b.start_at, v_b.end_at;
  end if;
  -- the range: from <= to, at most 366 days, at least one outlet, both dates
  perform pg_temp.expect_error(format('select pos_report_sales(%L, %L, %L)', array[v_a], '2026-01-06', '2026-01-05'),
    'The start date is after the end date.', 'R1 from after to');
  perform pg_temp.expect_error(format('select pos_report_sales(%L, %L, %L)', array[v_a], '2026-01-01', '2027-01-02'),
    'Choose at most 366 days.', 'R1 367 days');
  perform pos_report_sales(array[v_a], '2026-01-01', '2027-01-01');                 -- 366 days pass
  perform pg_temp.expect_error(format('select pos_report_sales(%L, %L, %L)', '{}'::uuid[], '2026-01-05', '2026-01-06'),
    'Choose at least one outlet.', 'R1 no outlet');
  perform pg_temp.expect_error(format('select pos_report_sales(%L, null, %L)', array[v_a], '2026-01-06'),
    'Choose a valid date range.', 'R1 no start date');
  -- every outlet asked for must be one the caller manages, from a back-office login
  perform pg_temp.act(pg_temp.id('mgr'));
  perform pg_temp.expect_error(format('select pos_report_sales(%L, %L, %L)', array[v_a], '2026-01-05', '2026-01-06'),
    'You cannot see reports for this outlet.', 'R1 a manager of another outlet');
  perform pg_temp.expect_error(format('select pos_report_sales(%L, %L, %L)', array[v_other, v_a], '2026-01-05', '2026-01-06'),
    'You cannot see reports for this outlet.', 'R1 one outlet of two not theirs');
  if (pos_report_sales(array[v_other], '2026-01-05', '2026-01-06')->'current'->>'bills')::int <> 0 then
    raise exception 'FAIL R1 the manager''s own outlet';
  end if;
  perform pg_temp.act(pg_temp.id('cashier'));
  perform pg_temp.expect_error(format('select pos_report_sales(%L, %L, %L)', array[v_a], '2026-01-05', '2026-01-06'),
    'You cannot see reports for this outlet.', 'R1 a cashier');
  perform pg_temp.act(pg_temp.id('dev'));
  perform pg_temp.expect_error(format('select pos_report_sales(%L, %L, %L)', array[v_a], '2026-01-05', '2026-01-06'),
    'You cannot see reports for this outlet.', 'R1 a tablet session');
end $$;

-- ── R2. Sales: Overview, Sales summary, Daily and Hourly (spec §4, §5.1–5.4) ─
do $$
declare
  v_a uuid := pg_temp.id('branch');
  v   jsonb;
begin
  perform pg_temp.act(pg_temp.id('owner'));
  v := pos_report_sales(array[v_a], '2026-01-05', '2026-01-06');
  -- A B C D' D E; F (7 Jan 06:00) and P (5 Jan 05:59) are outside; voids: B's and G's Water; C's refund apart
  if v->'current' <> '{"nettSen": 10200, "bills": 6, "pax": 7, "discountSen": 280, "voidSen": 400, "refundSen": 300}'::jsonb then
    raise exception 'FAIL R2 current: %', v->'current';
  end if;
  -- the period of the same length before, 3–4 Jan: P only
  if v->'previous' <> '{"nettSen": 1060, "bills": 1, "pax": 2, "discountSen": 0, "voidSen": 0, "refundSen": 0}'::jsonb then
    raise exception 'FAIL R2 previous: %', v->'previous';
  end if;
  -- one row per outlet and business day; B (6 Jan 01:30) counts to 5 Jan
  if v->'daily' <> jsonb_build_array(
       jsonb_build_object('branchId', v_a, 'outlet', 'VERIFY R', 'day', '2026-01-05', 'bills', 2, 'pax', 3,
                          'grossSen', 4000, 'discountSen', 280, 'takeawayFeeSen', 0, 'serviceChargeSen', 0,
                          'sstSen', 226, 'roundingSen', 4, 'nettSen', 3950, 'refundSen', 0),
       jsonb_build_object('branchId', v_a, 'outlet', 'VERIFY R', 'day', '2026-01-06', 'bills', 4, 'pax', 4,
                          'grossSen', 5840, 'discountSen', 0, 'takeawayFeeSen', 0, 'serviceChargeSen', 0,
                          'sstSen', 411, 'roundingSen', -1, 'nettSen', 6250, 'refundSen', 300)) then
    raise exception 'FAIL R2 daily: %', v->'daily';
  end if;
  -- 24 rows, the Malaysia hour of closed_at
  if jsonb_array_length(v->'hourly') <> 24
     or (select jsonb_agg(x.h order by (x.h->>'hour')::int) from jsonb_array_elements(v->'hourly') as x(h)
          where (x.h->>'bills')::int > 0)
        <> '[{"hour": 1, "bills": 1, "nettSen": 1910}, {"hour": 10, "bills": 1, "nettSen": 3065},
             {"hour": 12, "bills": 1, "nettSen": 2040}, {"hour": 13, "bills": 2, "nettSen": 1260},
             {"hour": 14, "bills": 1, "nettSen": 1925}]'::jsonb then
    raise exception 'FAIL R2 hourly: %', v->'hourly';
  end if;
  -- Feedme's order: 98.40 − 0.80 − 2.00 = 95.60 + SST 6.37 + rounding 0.03 = 102.00
  if v->'summary' <> '{"beforeDiscountsSen": 9840, "catalogDiscountSen": 0, "itemDiscountSen": 80, "billDiscountSen": 200,
                       "grossSen": 9560, "takeawayFeeSen": 0, "serviceChargeSen": 0, "sstSen": 637, "roundingSen": 3,
                       "nettSen": 10200}'::jsonb then
    raise exception 'FAIL R2 summary: %', v->'summary';
  end if;
  if v->'orderTypes' <> '[{"orderType": "dine_in", "bills": 5, "nettSen": 7135},
                          {"orderType": "takeaway", "bills": 1, "nettSen": 3065}]'::jsonb then
    raise exception 'FAIL R2 order types: %', v->'orderTypes';
  end if;
  -- orders, not bills: D and its split part D' are one counter order; E is the QR order
  if v->'sources' <> '[{"source": "counter", "orders": 4, "itemSen": 8040}, {"source": "qr", "orders": 1, "itemSen": 1800}]'::jsonb then
    raise exception 'FAIL R2 sources: %', v->'sources';
  end if;
  if v->'topProducts' <> '[{"name": "Verify R Latte", "qty": 5, "valueSen": 5000}, {"name": "Verify R Cake", "qty": 3, "valueSen": 2400},
                           {"name": "Verify R Muffin", "qty": 2, "valueSen": 2040}, {"name": "Verify R Water", "qty": 2, "valueSen": 400}]'::jsonb then
    raise exception 'FAIL R2 top products: %', v->'topProducts';
  end if;
  -- two outlets add up; an outlet with no sales answers zeros and empty lists
  if (pos_report_sales(array[v_a, pg_temp.id('other')], '2026-01-05', '2026-01-06')->'current'->>'nettSen')::int <> 10200 then
    raise exception 'FAIL R2 two outlets';
  end if;
  v := pos_report_sales(array[pg_temp.id('other')], '2026-01-05', '2026-01-06');
  if v->'current' <> '{"nettSen": 0, "bills": 0, "pax": 0, "discountSen": 0, "voidSen": 0, "refundSen": 0}'::jsonb
     or v->'daily' <> '[]'::jsonb or v->'topProducts' <> '[]'::jsonb or jsonb_array_length(v->'hourly') <> 24
     or (v->'summary'->>'nettSen')::int <> 0 or (v->'orderTypes'->0->>'bills')::int <> 0 then
    raise exception 'FAIL R2 an outlet with no sales: %', v;
  end if;
end $$;

select 'VERIFY OK' as result;
rollback;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts`
Expected: PASS — including `migration-2026-11-18-pos-reports.sql: every DELETE / UPDATE inside a function has a WHERE` (the file matches the scan's `migration-*-pos-*.sql` glob) and the new `scans the sales reports: …` test.

- [ ] **Step 6: Commit**

```bash
git add supabase/migration-2026-11-18-pos-reports.sql supabase/migration-2026-11-18-pos-reports-verify.sql src/features/pos/sqlSafeUpdate.test.ts
git commit -m "$(cat <<'EOF'
feat(pos): W3 reports SQL — business day, scope, sales report (+ verify)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---
### Task 2: SQL — lines, products, payments and SST

**Files:**
- Modify: `supabase/migration-2026-11-18-pos-reports.sql` (insert section R3 directly before the final `notify pgrst, 'reload schema';`)
- Modify: `supabase/migration-2026-11-18-pos-reports-verify.sql` (insert block R3 directly before the final `select 'VERIFY OK' as result;`)
- Modify: `src/features/pos/sqlSafeUpdate.test.ts` (the two lists in `it('scans the sales reports: …')`)

**Interfaces:**
- Consumes (Task 1): `pos_report_scope`, `pos_report_paid_bills`, `pos_business_day`; verify fixture keys and helpers.
- Produces:
  - `pos_report_lines(p_branch_ids uuid[], p_start timestamptz, p_end timestamptz)` returns table `(item_id uuid, bill_id uuid, branch_id uuid, bill_no text, bday date, order_id uuid, product_id uuid, name text, qty integer, unit_price_sen integer, sst_rate_bp integer, modifiers jsonb, gross_sen integer, catalog_discount_sen integer, item_discount_sen integer, bill_share_sen integer, net_sen integer, sst_base_sen integer)` — internal; Task 3's ledger uses it.
  - `pos_report_products(uuid[], date, date) → jsonb`, `pos_report_payments(uuid[], date, date) → jsonb`, `pos_report_sst(uuid[], date, date) → jsonb` — shapes in File Structure; granted to authenticated.

- [ ] **Step 1: Write the failing test**

In `src/features/pos/sqlSafeUpdate.test.ts`, inside `it('scans the sales reports: …')`, replace the two list lines:

```ts
    const internal = ['pos_business_day', 'pos_report_scope', 'pos_report_paid_bills', 'pos_report_cards']
    const reports = ['pos_report_sales']
```

with:

```ts
    const internal = ['pos_business_day', 'pos_report_scope', 'pos_report_paid_bills', 'pos_report_cards', 'pos_report_lines']
    const reports = ['pos_report_sales', 'pos_report_products', 'pos_report_payments', 'pos_report_sst']
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts`
Expected: FAIL in `scans the sales reports: …` — the function list lacks `pos_report_lines`, `pos_report_payments`, `pos_report_products`, `pos_report_sst`.

- [ ] **Step 3: Add section R3 to the migration**

In `supabase/migration-2026-11-18-pos-reports.sql`, insert directly before the line `notify pgrst, 'reload schema';`:

```sql
-- ── R3. The lines of the sales (spec §4) ────────────────────────────────────
-- One row per live line of the paid bills in the bounds, with its discounts and its net after discounts
-- as frozen in bills.totals.lines (a bill without them: price × qty, no discount). sst_base_sen is what
-- its SST was charged on: the net, plus a takeaway line's fee (pos_compute_bill). Internal.
create or replace function pos_report_lines(p_branch_ids uuid[], p_start timestamptz, p_end timestamptz)
returns table (item_id uuid, bill_id uuid, branch_id uuid, bill_no text, bday date, order_id uuid, product_id uuid,
               name text, qty integer, unit_price_sen integer, sst_rate_bp integer, modifiers jsonb,
               gross_sen integer, catalog_discount_sen integer, item_discount_sen integer, bill_share_sen integer,
               net_sen integer, sst_base_sen integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select oi.id, b.id, b.branch_id, b.bill_no, pos_business_day(b.closed_at), oi.order_id, oi.product_id,
         oi.name_snapshot, oi.qty, oi.unit_price_sen, oi.sst_rate_bp, oi.modifiers_snapshot,
         oi.unit_price_sen * oi.qty,
         coalesce((l.v->>'catalogDiscountSen')::integer, 0),
         coalesce((l.v->>'itemDiscountSen')::integer, 0),
         coalesce((l.v->>'billShareSen')::integer, 0),
         coalesce((l.v->>'netSen')::integer, oi.unit_price_sen * oi.qty),
         coalesce((l.v->>'netSen')::integer, oi.unit_price_sen * oi.qty)
           + case when coalesce(oi.order_type, b.order_type) = 'takeaway' then oi.takeaway_fee_sen * oi.qty else 0 end
    from pos_report_paid_bills(p_branch_ids, p_start, p_end) b
    join order_items oi on oi.bill_id = b.id and oi.voided_at is null
    left join lateral (
      select x.v from jsonb_array_elements(coalesce(b.totals->'lines', '[]'::jsonb)) as x(v)
       where x.v->>'id' = oi.id::text) l on true
$$;
revoke all on function pos_report_lines(uuid[], timestamptz, timestamptz) from public, anon, authenticated;

-- ── R3. Products, add-ons and categories (spec §5.5) ────────────────────────
-- Per product (today's name and category): quantity, gross (price × qty), discounts (gross − net), net.
-- Add-ons: per option name on the lines, count = units, value = priceDeltaSen × qty.
create or replace function pos_report_products(p_branch_ids uuid[], p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s     record;
  v_out jsonb;
begin
  select * into s from pos_report_scope(p_branch_ids, p_from, p_to);
  with ln as (
    select x.*, p.name as product_name, c.id as category_id, c.name as category
      from pos_report_lines(p_branch_ids, s.start_at, s.end_at) x
      left join menu_products p on p.id = x.product_id
      left join menu_categories c on c.id = p.category_id),
  per_product as (
    select coalesce(min(ln.product_name), min(ln.name)) as name, min(ln.category) as category,
           sum(ln.qty)::integer as qty, sum(ln.gross_sen) as gross, sum(ln.net_sen) as net
      from ln
     group by coalesce(ln.product_id::text, ln.name)),
  add_ons as (
    select coalesce(m.v->>'name', 'Add-on') as name, sum(ln.qty)::integer as n,
           sum(coalesce((m.v->>'priceDeltaSen')::integer, 0) * ln.qty) as val
      from ln
      cross join jsonb_array_elements(coalesce(ln.modifiers, '[]'::jsonb)) as m(v)
     group by coalesce(m.v->>'name', 'Add-on')),
  per_category as (
    select min(ln.category) as category, sum(ln.qty)::integer as qty, sum(ln.net_sen) as net
      from ln
     group by ln.category_id)
  select jsonb_build_object(
    'products', coalesce((
      select jsonb_agg(jsonb_build_object('name', x.name, 'category', x.category, 'qty', x.qty, 'grossSen', x.gross,
                                          'discountSen', x.gross - x.net, 'netSen', x.net)
                       order by x.qty desc, x.net desc, x.name)
        from per_product x), '[]'::jsonb),
    'addOns', coalesce((
      select jsonb_agg(jsonb_build_object('name', x.name, 'count', x.n, 'valueSen', x.val)
                       order by x.n desc, x.val desc, x.name)
        from add_ons x), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('category', x.category, 'qty', x.qty, 'netSen', x.net)
                       order by x.net desc, x.category nulls last)
        from per_category x), '[]'::jsonb))
    into v_out;
  return v_out;
end $$;
revoke all on function pos_report_products(uuid[], date, date) from public, anon;
grant execute on function pos_report_products(uuid[], date, date) to authenticated;

-- ── R3. Payments (spec §5.6) ────────────────────────────────────────────────
-- The payments of the bills sold in the range (a part payment is a payment like any other), so the total
-- equals Nett sales; refunds by their own time. Methods by name and kind across outlets.
create or replace function pos_report_payments(p_branch_ids uuid[], p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s     record;
  v_out jsonb;
begin
  select * into s from pos_report_scope(p_branch_ids, p_from, p_to);
  with pm as (
    select p.method_name as name, p.kind, count(*)::integer as n, sum(p.amount_sen) as amt
      from payments p
      join pos_report_paid_bills(p_branch_ids, s.start_at, s.end_at) b on b.id = p.bill_id
     group by p.method_name, p.kind),
  rm as (
    select r.method_name as name, coalesce(r.kind, 'other') as kind, count(*)::integer as n, sum(r.amount_sen) as amt
      from refunds r
     where r.branch_id = any (p_branch_ids) and r.created_at >= s.start_at and r.created_at < s.end_at
     group by r.method_name, coalesce(r.kind, 'other'))
  select jsonb_build_object('methods', coalesce((
    select jsonb_agg(jsonb_build_object(
             'name', coalesce(pm.name, rm.name), 'kind', coalesce(pm.kind, rm.kind),
             'count', coalesce(pm.n, 0), 'amountSen', coalesce(pm.amt, 0),
             'refundCount', coalesce(rm.n, 0), 'refundSen', coalesce(rm.amt, 0),
             'netSen', coalesce(pm.amt, 0) - coalesce(rm.amt, 0))
           order by coalesce(pm.name, rm.name), coalesce(pm.kind, rm.kind))
      from pm full join rm on rm.name = pm.name and rm.kind = pm.kind), '[]'::jsonb))
    into v_out;
  return v_out;
end $$;
revoke all on function pos_report_payments(uuid[], date, date) from public, anon;
grant execute on function pos_report_payments(uuid[], date, date) to authenticated;

-- ── R3. SST (spec §5.7) ─────────────────────────────────────────────────────
-- Per rate: taxable base and SST from the bills' totals.sstGroups (as charged; service charge carries no
-- SST). Exempt: the net of the 0% lines. Then one row per month of the business days (SST-02).
create or replace function pos_report_sst(p_branch_ids uuid[], p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s     record;
  v_out jsonb;
begin
  select * into s from pos_report_scope(p_branch_ids, p_from, p_to);
  with grp as (
    select to_char(pos_business_day(b.closed_at), 'YYYY-MM') as ym, (g.v->>'rateBp')::integer as rate_bp,
           (g.v->>'baseSen')::bigint as base, (g.v->>'amountSen')::bigint as amt
      from pos_report_paid_bills(p_branch_ids, s.start_at, s.end_at) b
      cross join jsonb_array_elements(coalesce(b.totals->'sstGroups', '[]'::jsonb)) as g(v)),
  ex as (
    select to_char(ln.bday, 'YYYY-MM') as ym, sum(ln.net_sen) as exempt
      from pos_report_lines(p_branch_ids, s.start_at, s.end_at) ln
     where ln.sst_rate_bp = 0
     group by to_char(ln.bday, 'YYYY-MM')),
  months as (select grp.ym from grp union select ex.ym from ex)
  select jsonb_build_object(
    'rates', coalesce((
      select jsonb_agg(jsonb_build_object('rateBp', x.rate_bp, 'baseSen', x.base, 'sstSen', x.amt) order by x.rate_bp)
        from (select grp.rate_bp, sum(grp.base) as base, sum(grp.amt) as amt from grp group by grp.rate_bp) x), '[]'::jsonb),
    'exemptSen', coalesce((select sum(ex.exempt) from ex), 0),
    'months', coalesce((
      select jsonb_agg(jsonb_build_object(
               'month', m.ym,
               'rates', coalesce((
                 select jsonb_agg(jsonb_build_object('rateBp', x.rate_bp, 'baseSen', x.base, 'sstSen', x.amt) order by x.rate_bp)
                   from (select grp.rate_bp, sum(grp.base) as base, sum(grp.amt) as amt
                           from grp where grp.ym = m.ym group by grp.rate_bp) x), '[]'::jsonb),
               'exemptSen', coalesce((select ex.exempt from ex where ex.ym = m.ym), 0))
             order by m.ym)
        from months m), '[]'::jsonb))
    into v_out;
  return v_out;
end $$;
revoke all on function pos_report_sst(uuid[], date, date) from public, anon;
grant execute on function pos_report_sst(uuid[], date, date) to authenticated;

```

- [ ] **Step 4: Add block R3 to the verify script**

In `supabase/migration-2026-11-18-pos-reports-verify.sql`, insert directly before the line `select 'VERIFY OK' as result;`:

```sql
-- ── R3. Products, payments and SST (spec §4, §5.5–5.7) ───────────────────────
do $$
declare
  v_a uuid := pg_temp.id('branch');
  v   jsonb;
  r   record;
begin
  for r in select f from unnest(array['pos_report_products(uuid[],date,date)', 'pos_report_payments(uuid[],date,date)',
                                      'pos_report_sst(uuid[],date,date)']) f loop
    if not has_function_privilege('authenticated', r.f, 'execute') or has_function_privilege('anon', r.f, 'execute') then
      raise exception 'FAIL R3 grants: %', r.f;
    end if;
  end loop;
  if has_function_privilege('authenticated', 'pos_report_lines(uuid[],timestamptz,timestamptz)', 'execute') then
    raise exception 'FAIL R3 grants: pos_report_lines is internal';
  end if;
  perform pg_temp.act(pg_temp.id('mgr'));
  for r in select f from unnest(array['pos_report_products', 'pos_report_payments', 'pos_report_sst']) f loop
    perform pg_temp.expect_error(format('select %s(%L, %L, %L)', r.f, array[v_a], '2026-01-05', '2026-01-06'),
      'You cannot see reports for this outlet.', 'R3 ' || r.f || ' of another outlet');
  end loop;
  perform pg_temp.act(pg_temp.id('owner'));

  -- products: today's name and category; net after every discount (B's RM 2.00 sits on its Latte)
  v := pos_report_products(array[v_a], '2026-01-05', '2026-01-06');
  if v->'products' <> '[
       {"name": "Verify R Latte",  "category": "VERIFY R DRINKS", "qty": 5, "grossSen": 5000, "discountSen": 200, "netSen": 4800},
       {"name": "Verify R Cake",   "category": "VERIFY R FOOD",   "qty": 3, "grossSen": 2400, "discountSen": 80,  "netSen": 2320},
       {"name": "Verify R Muffin", "category": "VERIFY R FOOD",   "qty": 2, "grossSen": 2040, "discountSen": 0,   "netSen": 2040},
       {"name": "Verify R Water",  "category": "VERIFY R DRINKS", "qty": 2, "grossSen": 400,  "discountSen": 0,   "netSen": 400}]'::jsonb then
    raise exception 'FAIL R3 products: %', v->'products';
  end if;
  -- add-ons: the options on the live lines, priceDeltaSen × qty (A's and E's Latte; B's two Lattes)
  if v->'addOns' <> '[{"name": "Oat milk", "count": 2, "valueSen": 300}, {"name": "Extra shot", "count": 2, "valueSen": 200}]'::jsonb then
    raise exception 'FAIL R3 add-ons: %', v->'addOns';
  end if;
  if v->'categories' <> '[{"category": "VERIFY R DRINKS", "qty": 7, "netSen": 5200},
                          {"category": "VERIFY R FOOD", "qty": 5, "netSen": 4360}]'::jsonb then
    raise exception 'FAIL R3 categories: %', v->'categories';
  end if;

  -- payments of the bills sold in the range (E's part is a payment like any other); refunds by their own
  -- time; the amounts add up to Nett sales (102.00)
  v := pos_report_payments(array[v_a], '2026-01-05', '2026-01-06');
  if v <> '{"methods": [
       {"name": "R Card", "kind": "card", "count": 4, "amountSen": 4300, "refundCount": 0, "refundSen": 0, "netSen": 4300},
       {"name": "R Cash", "kind": "cash", "count": 3, "amountSen": 5900, "refundCount": 1, "refundSen": 300, "netSen": 5600}]}'::jsonb then
    raise exception 'FAIL R3 payments: %', v;
  end if;

  -- SST from the bills' sstGroups: 6% on 10.00 + 18.00 + 10.00 + 10.00; 8% on 7.20 + 28.40 + 8.00;
  -- exempt = the 0% lines' net (the Water of A and of D')
  v := pos_report_sst(array[v_a], '2026-01-05', '2026-01-06');
  if v <> '{"rates": [{"rateBp": 600, "baseSen": 4800, "sstSen": 288}, {"rateBp": 800, "baseSen": 4360, "sstSen": 349}],
            "exemptSen": 400,
            "months": [{"month": "2026-01",
                        "rates": [{"rateBp": 600, "baseSen": 4800, "sstSen": 288}, {"rateBp": 800, "baseSen": 4360, "sstSen": 349}],
                        "exemptSen": 400}]}'::jsonb then
    raise exception 'FAIL R3 SST: %', v;
  end if;

  -- an outlet with no sales
  if pos_report_products(array[pg_temp.id('other')], '2026-01-05', '2026-01-06') <> '{"products": [], "addOns": [], "categories": []}'::jsonb
     or pos_report_payments(array[pg_temp.id('other')], '2026-01-05', '2026-01-06') <> '{"methods": []}'::jsonb
     or pos_report_sst(array[pg_temp.id('other')], '2026-01-05', '2026-01-06') <> '{"rates": [], "exemptSen": 0, "months": []}'::jsonb then
    raise exception 'FAIL R3 an outlet with no sales';
  end if;
end $$;

```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add supabase/migration-2026-11-18-pos-reports.sql supabase/migration-2026-11-18-pos-reports-verify.sql src/features/pos/sqlSafeUpdate.test.ts
git commit -m "$(cat <<'EOF'
feat(pos): W3 reports SQL — lines, products, payments, SST (+ verify)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: SQL — discounts, voids, refunds, cash drawer and ledger

**Files:**
- Modify: `supabase/migration-2026-11-18-pos-reports.sql` (insert section R4 directly before the final `notify pgrst, 'reload schema';`)
- Modify: `supabase/migration-2026-11-18-pos-reports-verify.sql` (insert block R4 directly before the final `select 'VERIFY OK' as result;`)
- Modify: `src/features/pos/sqlSafeUpdate.test.ts` (the `reports` list in `it('scans the sales reports: …')`)

**Interfaces:**
- Consumes (Tasks 1–2): `pos_report_scope`, `pos_report_paid_bills`, `pos_report_lines`, `pos_business_day`; `pos_shift_expected_cash(uuid)` (live); verify fixture.
- Produces: `pos_report_audit(uuid[], date, date) → jsonb`, `pos_report_drawer(uuid[], date, date) → jsonb`, `pos_report_ledger(uuid[], date, date) → jsonb` — shapes in File Structure; granted to authenticated.

- [ ] **Step 1: Write the failing test**

In `src/features/pos/sqlSafeUpdate.test.ts`, inside `it('scans the sales reports: …')`, replace:

```ts
    const reports = ['pos_report_sales', 'pos_report_products', 'pos_report_payments', 'pos_report_sst']
```

with:

```ts
    const reports = ['pos_report_sales', 'pos_report_products', 'pos_report_payments', 'pos_report_sst',
                     'pos_report_audit', 'pos_report_drawer', 'pos_report_ledger']
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts`
Expected: FAIL in `scans the sales reports: …` — `pos_report_audit`, `pos_report_drawer`, `pos_report_ledger` are missing.

- [ ] **Step 3: Add section R4 to the migration**

In `supabase/migration-2026-11-18-pos-reports.sql`, insert directly before the line `notify pgrst, 'reload schema';`:

```sql
-- ── R4. Discounts, voids and refunds (spec §5.8–5.10) ───────────────────────
-- discounts: every row of pos_discount_log in the range (set, clear — which keeps what it cleared —
-- and split), oldest first; discountTotals: the discounts of the bills sold, as the Z report counts them.
-- voidItems: items voided in the range (a voided bill's items too); voidBills: bills voided in the range,
-- valued at their items. refunds: by their own time.
create or replace function pos_report_audit(p_branch_ids uuid[], p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s     record;
  v_out jsonb;
begin
  select * into s from pos_report_scope(p_branch_ids, p_from, p_to);
  with pb as (select b.* from pos_report_paid_bills(p_branch_ids, s.start_at, s.end_at) b),
  dl as (
    select d.* from pos_discount_log d
     where d.branch_id = any (p_branch_ids) and d.created_at >= s.start_at and d.created_at < s.end_at),
  vi as (
    select oi.*, b.bill_no, b.branch_id from order_items oi join bills b on b.id = oi.bill_id
     where b.branch_id = any (p_branch_ids) and oi.voided_at >= s.start_at and oi.voided_at < s.end_at),
  vb as (
    select b.* from bills b
     where b.branch_id = any (p_branch_ids) and b.status = 'voided' and b.closed_at >= s.start_at and b.closed_at < s.end_at),
  rf as (
    select r.* from refunds r
     where r.branch_id = any (p_branch_ids) and r.created_at >= s.start_at and r.created_at < s.end_at)
  select jsonb_build_object(
    'discounts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'at', to_char(dl.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'outlet', (select br.name from branches br where br.id = dl.branch_id),
               'billNo', (select b.bill_no from bills b where b.id = dl.bill_id),
               'item', (select oi.name_snapshot from order_items oi where oi.id = dl.order_item_id),
               'action', dl.action, 'kind', dl.kind, 'value', dl.value, 'reason', dl.reason,
               'by', (select st.name from staff st where st.id = dl.actor),
               'approvedBy', (select st.name from staff st where st.id = dl.approved_by))
             order by dl.created_at, dl.id)
        from dl), '[]'::jsonb),
    'discountTotals', (
      select jsonb_build_object(
               'catalogSen', coalesce(sum(coalesce((pb.totals->>'catalogDiscountSen')::integer, 0)), 0),
               'catalogBills', (count(*) filter (where coalesce((pb.totals->>'catalogDiscountSen')::integer, 0) > 0))::integer,
               'itemSen', coalesce(sum(coalesce((pb.totals->>'itemDiscountSen')::integer, 0)), 0),
               'itemCount', (select count(*)::integer
                               from pb p2, jsonb_array_elements(coalesce(p2.totals->'lines', '[]'::jsonb)) as x(l)
                              where coalesce((x.l->>'itemDiscountSen')::integer, 0) > 0),
               'billSen', coalesce(sum(coalesce((pb.totals->>'billDiscountSen')::integer, 0)), 0),
               'billCount', (count(*) filter (where coalesce((pb.totals->>'billDiscountSen')::integer, 0) > 0))::integer)
        from pb),
    'voidItems', coalesce((
      select jsonb_agg(jsonb_build_object(
               'at', to_char(vi.voided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'outlet', (select br.name from branches br where br.id = vi.branch_id),
               'billNo', vi.bill_no, 'name', vi.name_snapshot, 'qty', vi.qty,
               'valueSen', vi.unit_price_sen * vi.qty, 'reason', vi.void_reason,
               'by', (select st.name from staff st where st.id = vi.voided_by),
               'approvedBy', (select st.name from staff st where st.id = vi.void_approved_by))
             order by vi.voided_at, vi.id)
        from vi), '[]'::jsonb),
    'voidBills', coalesce((
      select jsonb_agg(jsonb_build_object(
               'at', to_char(vb.closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'outlet', (select br.name from branches br where br.id = vb.branch_id),
               'billNo', vb.bill_no,
               'valueSen', (select coalesce(sum(oi.unit_price_sen * oi.qty), 0) from order_items oi where oi.bill_id = vb.id),
               'reason', vb.void_reason,
               'by', (select st.name from staff st where st.id = vb.closed_by),
               'approvedBy', (select st.name from staff st where st.id = vb.void_approved_by))
             order by vb.closed_at, vb.id)
        from vb), '[]'::jsonb),
    'refunds', coalesce((
      select jsonb_agg(jsonb_build_object(
               'at', to_char(rf.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'outlet', (select br.name from branches br where br.id = rf.branch_id),
               'billNo', (select b.bill_no from bills b where b.id = rf.bill_id),
               'method', rf.method_name, 'amountSen', rf.amount_sen, 'reason', rf.reason,
               'approvedBy', (select st.name from staff st where st.id = rf.approved_by))
             order by rf.created_at, rf.id)
        from rf), '[]'::jsonb))
    into v_out;
  return v_out;
end $$;
revoke all on function pos_report_audit(uuid[], date, date) from public, anon;
grant execute on function pos_report_audit(uuid[], date, date) to authenticated;

-- ── R4. Cash drawer (spec §5.11) ────────────────────────────────────────────
-- One row per shift whose close (or open, for a shift still open) falls in the range; the cash as the
-- Z report counts it; expected = the frozen figure, or the live one for an open shift.
create or replace function pos_report_drawer(p_branch_ids uuid[], p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s     record;
  v_out jsonb;
begin
  select * into s from pos_report_scope(p_branch_ids, p_from, p_to);
  select jsonb_build_object('shifts', coalesce((
    select jsonb_agg(jsonb_build_object(
             'outlet', br.name,
             'openedAt', to_char(sh.opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'closedAt', to_char(sh.closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'openedBy', (select st.name from staff st where st.id = sh.opened_by),
             'closedBy', (select st.name from staff st where st.id = sh.closed_by),
             'floatSen', sh.opening_float_sen,
             'cashSalesSen', coalesce((select sum(p.amount_sen) from payments p where p.shift_id = sh.id and p.kind = 'cash'), 0),
             'cashRefundSen', coalesce((select sum(r.amount_sen) from refunds r where r.shift_id = sh.id and r.kind = 'cash'), 0),
             'payInSen', coalesce((select sum(m.amount_sen) from pos_cash_moves m where m.shift_id = sh.id and m.kind = 'pay_in'), 0),
             'payOutSen', coalesce((select sum(m.amount_sen) from pos_cash_moves m where m.shift_id = sh.id and m.kind = 'pay_out'), 0),
             'expectedSen', coalesce(sh.expected_cash_sen, pos_shift_expected_cash(sh.id)),
             'countedSen', sh.counted_cash_sen,
             'varianceSen', sh.variance_sen,
             'reason', sh.variance_reason)
           order by sh.opened_at, sh.id)
      from pos_shifts sh
      join branches br on br.id = sh.branch_id
     where sh.branch_id = any (p_branch_ids)
       and coalesce(sh.closed_at, sh.opened_at) >= s.start_at
       and coalesce(sh.closed_at, sh.opened_at) < s.end_at), '[]'::jsonb))
    into v_out;
  return v_out;
end $$;
revoke all on function pos_report_drawer(uuid[], date, date) from public, anon;
grant execute on function pos_report_drawer(uuid[], date, date) to authenticated;

-- ── R4. Ledger export (spec §5.12) ──────────────────────────────────────────
-- bills: one row per paid bill. lines: one row per live line; its SST is its share of the bill's group
-- of the same rate, by largest remainder on the SST base (floors first, the sen left to the largest
-- remainders, ties by order item id), so the lines add up to the bill's group. payments: one row per
-- payment of those bills, with the part number of a part payment.
create or replace function pos_report_ledger(p_branch_ids uuid[], p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s     record;
  v_out jsonb;
begin
  select * into s from pos_report_scope(p_branch_ids, p_from, p_to);
  with pb as (select b.* from pos_report_paid_bills(p_branch_ids, s.start_at, s.end_at) b),
  grp as (
    select pb.id as bill_id, (g.v->>'rateBp')::integer as rate_bp, (g.v->>'amountSen')::bigint as amt
      from pb cross join jsonb_array_elements(coalesce(pb.totals->'sstGroups', '[]'::jsonb)) as g(v)),
  w as (
    select ln.*, coalesce(grp.amt, 0) as amt,
           sum(ln.sst_base_sen) over (partition by ln.bill_id, ln.sst_rate_bp) as base_total
      from pos_report_lines(p_branch_ids, s.start_at, s.end_at) ln
      left join grp on grp.bill_id = ln.bill_id and grp.rate_bp = ln.sst_rate_bp),
  fl as (
    select w.*,
           case when w.amt > 0 and w.base_total > 0 then (w.amt * w.sst_base_sen) / w.base_total else 0 end as floor_sst,
           case when w.amt > 0 and w.base_total > 0 then (w.amt * w.sst_base_sen) % w.base_total else 0 end as rem
      from w),
  shares as (
    select fl.*,
           fl.amt - sum(fl.floor_sst) over (partition by fl.bill_id, fl.sst_rate_bp) as left_over,
           row_number() over (partition by fl.bill_id, fl.sst_rate_bp order by fl.rem desc, fl.item_id) as rk
      from fl)
  select jsonb_build_object(
    'bills', coalesce((
      select jsonb_agg(jsonb_build_object(
               'outlet', br.name, 'businessDate', to_char(pos_business_day(pb.closed_at), 'YYYY-MM-DD'),
               'closedAt', to_char(pb.closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'billNo', pb.bill_no, 'orderType', pb.order_type, 'table', t.label, 'pax', pb.pax,
               'grossSen', coalesce((pb.totals->>'grossSen')::integer, pb.subtotal_sen),
               'discountSen', coalesce((pb.totals->>'catalogDiscountSen')::integer, 0)
                              + coalesce((pb.totals->>'itemDiscountSen')::integer, 0)
                              + coalesce((pb.totals->>'billDiscountSen')::integer, 0),
               'takeawayFeeSen', pb.takeaway_fee_sen, 'serviceChargeSen', pb.service_charge_sen,
               'sstSen', pb.sst_sen, 'roundingSen', pb.rounding_sen, 'totalSen', pb.total_sen,
               'refundedSen', pb.refunded_sen)
             order by pb.closed_at, pb.id)
        from pb
        join branches br on br.id = pb.branch_id
        left join dining_tables t on t.id = pb.table_id), '[]'::jsonb),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'outlet', br.name, 'billNo', x.bill_no, 'item', x.name, 'qty', x.qty, 'unitPriceSen', x.unit_price_sen,
               'catalogDiscountSen', x.catalog_discount_sen, 'itemDiscountSen', x.item_discount_sen,
               'billShareSen', x.bill_share_sen, 'netSen', x.net_sen, 'sstRateBp', x.sst_rate_bp,
               'sstSen', x.floor_sst + case when x.rk <= x.left_over then 1 else 0 end)
             order by pb.closed_at, x.bill_id, x.item_id)
        from shares x
        join pb on pb.id = x.bill_id
        join branches br on br.id = x.branch_id), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'outlet', br.name, 'billNo', pb.bill_no, 'partNo', bp.part_no, 'method', p.method_name, 'kind', p.kind,
               'amountSen', p.amount_sen, 'tenderedSen', p.tendered_sen, 'changeSen', p.change_sen,
               'reference', p.reference,
               'takenAt', to_char(p.taken_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
             order by pb.closed_at, pb.id, p.taken_at, p.line_no, p.id)
        from payments p
        join pb on pb.id = p.bill_id
        join branches br on br.id = pb.branch_id
        left join bill_parts bp on bp.id = p.part_id), '[]'::jsonb))
    into v_out;
  return v_out;
end $$;
revoke all on function pos_report_ledger(uuid[], date, date) from public, anon;
grant execute on function pos_report_ledger(uuid[], date, date) to authenticated;

```

- [ ] **Step 4: Add block R4 to the verify script**

In `supabase/migration-2026-11-18-pos-reports-verify.sql`, insert directly before the line `select 'VERIFY OK' as result;`:

```sql
-- ── R4. Discounts, voids, refunds, the cash drawer and the ledger (spec §5.8–5.12) ─
do $$
declare
  v_a    uuid := pg_temp.id('branch');
  v_no_a text := (select bill_no from bills where id = pg_temp.id('A'));
  v_no_b text := (select bill_no from bills where id = pg_temp.id('B'));
  v_no_c text := (select bill_no from bills where id = pg_temp.id('C'));
  v_no_e text := (select bill_no from bills where id = pg_temp.id('E'));
  v_no_g text := (select bill_no from bills where id = pg_temp.id('G'));
  v      jsonb;
  r      record;
begin
  for r in select f from unnest(array['pos_report_audit(uuid[],date,date)', 'pos_report_drawer(uuid[],date,date)',
                                      'pos_report_ledger(uuid[],date,date)']) f loop
    if not has_function_privilege('authenticated', r.f, 'execute') or has_function_privilege('anon', r.f, 'execute') then
      raise exception 'FAIL R4 grants: %', r.f;
    end if;
  end loop;
  perform pg_temp.act(pg_temp.id('mgr'));
  for r in select f from unnest(array['pos_report_audit', 'pos_report_drawer', 'pos_report_ledger']) f loop
    perform pg_temp.expect_error(format('select %s(%L, %L, %L)', r.f, array[v_a], '2026-01-05', '2026-01-06'),
      'You cannot see reports for this outlet.', 'R4 ' || r.f || ' of another outlet');
  end loop;
  perform pg_temp.act(pg_temp.id('owner'));

  -- discounts: every one set and cleared, oldest first; a clear keeps what it cleared and has no approver
  v := pos_report_audit(array[v_a], '2026-01-05', '2026-01-06');
  if v->'discounts' <> jsonb_build_array(
       jsonb_build_object('at', '2026-01-05T03:40:00.000Z', 'outlet', 'VERIFY R', 'billNo', v_no_a, 'item', null,
                          'action', 'set', 'kind', 'amount', 'value', 100, 'reason', 'Regular',
                          'by', 'Verify R Cashier', 'approvedBy', 'Verify R Supervisor'),
       jsonb_build_object('at', '2026-01-05T03:45:00.000Z', 'outlet', 'VERIFY R', 'billNo', v_no_a, 'item', null,
                          'action', 'clear', 'kind', 'amount', 'value', 100, 'reason', 'Regular',
                          'by', 'Verify R Cashier', 'approvedBy', null),
       jsonb_build_object('at', '2026-01-05T03:50:00.000Z', 'outlet', 'VERIFY R', 'billNo', v_no_a, 'item', 'Verify R Cake',
                          'action', 'set', 'kind', 'percent', 'value', 1000, 'reason', 'Regular',
                          'by', 'Verify R Cashier', 'approvedBy', 'Verify R Supervisor'),
       jsonb_build_object('at', '2026-01-05T05:05:00.000Z', 'outlet', 'VERIFY R', 'billNo', v_no_b, 'item', null,
                          'action', 'set', 'kind', 'amount', 'value', 200, 'reason', 'Regular',
                          'by', 'Verify R Cashier', 'approvedBy', 'Verify R Supervisor')) then
    raise exception 'FAIL R4 discounts: %', v->'discounts';
  end if;
  if v->'discountTotals' <> '{"catalogSen": 0, "catalogBills": 0, "itemSen": 80, "itemCount": 1, "billSen": 200, "billCount": 1}'::jsonb then
    raise exception 'FAIL R4 discount totals: %', v->'discountTotals';
  end if;
  -- voids: B's Water, and G's Water voided with its bill
  if v->'voidItems' <> jsonb_build_array(
       jsonb_build_object('at', '2026-01-05T05:00:00.000Z', 'outlet', 'VERIFY R', 'billNo', v_no_b, 'name', 'Verify R Water',
                          'qty', 1, 'valueSen', 200, 'reason', 'Wrong item keyed',
                          'by', 'Verify R Cashier', 'approvedBy', 'Verify R Supervisor'),
       jsonb_build_object('at', '2026-01-06T07:00:00.000Z', 'outlet', 'VERIFY R', 'billNo', v_no_g, 'name', 'Verify R Water',
                          'qty', 1, 'valueSen', 200, 'reason', 'Guest left',
                          'by', 'Verify R Cashier', 'approvedBy', 'Verify R Supervisor'))
     or v->'voidBills' <> jsonb_build_array(
       jsonb_build_object('at', '2026-01-06T07:00:00.000Z', 'outlet', 'VERIFY R', 'billNo', v_no_g, 'valueSen', 200,
                          'reason', 'Guest left', 'by', 'Verify R Cashier', 'approvedBy', 'Verify R Supervisor')) then
    raise exception 'FAIL R4 voids: % %', v->'voidItems', v->'voidBills';
  end if;
  if v->'refunds' <> jsonb_build_array(
       jsonb_build_object('at', '2026-01-06T02:30:00.000Z', 'outlet', 'VERIFY R', 'billNo', v_no_c, 'method', 'R Cash',
                          'amountSen', 300, 'reason', 'Cold cake', 'approvedBy', 'Verify R Supervisor')) then
    raise exception 'FAIL R4 refunds: %', v->'refunds';
  end if;

  -- the cash drawer: S1 by its close (D2 22:00), the open shift by its open (D2 20:00)
  v := pos_report_drawer(array[v_a], '2026-01-05', '2026-01-06');
  if v <> jsonb_build_object('shifts', jsonb_build_array(
       jsonb_build_object('outlet', 'VERIFY R', 'openedAt', '2026-01-06T00:00:00.000Z', 'closedAt', '2026-01-06T14:00:00.000Z',
                          'openedBy', 'Verify R Cashier', 'closedBy', 'Verify R Cashier', 'floatSen', 10000,
                          'cashSalesSen', 3990, 'cashRefundSen', 300, 'payInSen', 2000, 'payOutSen', 500,
                          'expectedSen', 15190, 'countedSen', 15150, 'varianceSen', -40, 'reason', 'Short at close'),
       jsonb_build_object('outlet', 'VERIFY R', 'openedAt', '2026-01-06T12:00:00.000Z', 'closedAt', null,
                          'openedBy', 'Verify R Cashier', 'closedBy', null, 'floatSen', 10000,
                          'cashSalesSen', 1910, 'cashRefundSen', 0, 'payInSen', 0, 'payOutSen', 0,
                          'expectedSen', 11910, 'countedSen', null, 'varianceSen', null, 'reason', null))) then
    raise exception 'FAIL R4 drawer: %', v;
  end if;

  -- the ledger
  v := pos_report_ledger(array[v_a], '2026-01-05', '2026-01-06');
  -- bills.csv: the six paid bills by closing time
  if (select jsonb_agg(x.b->>'billNo' order by x.o) from jsonb_array_elements(v->'bills') with ordinality as x(b, o))
     <> (select jsonb_agg(bill_no order by closed_at) from bills
          where id in (pg_temp.id('A'), pg_temp.id('B'), pg_temp.id('C'), pg_temp.id('Dpart'), pg_temp.id('D'), pg_temp.id('E')))
     or v->'bills'->0 <> jsonb_build_object('outlet', 'VERIFY R', 'businessDate', '2026-01-05', 'closedAt', '2026-01-05T04:00:00.000Z',
                          'billNo', v_no_a, 'orderType', 'dine_in', 'table', 'R1', 'pax', 2, 'grossSen', 2000, 'discountSen', 80,
                          'takeawayFeeSen', 0, 'serviceChargeSen', 0, 'sstSen', 118, 'roundingSen', 2, 'totalSen', 2040,
                          'refundedSen', 0)
     or v->'bills'->2 <> jsonb_build_object('outlet', 'VERIFY R', 'businessDate', '2026-01-06', 'closedAt', '2026-01-06T02:00:00.000Z',
                          'billNo', v_no_c, 'orderType', 'takeaway', 'table', null, 'pax', null, 'grossSen', 2840, 'discountSen', 0,
                          'takeawayFeeSen', 0, 'serviceChargeSen', 0, 'sstSen', 227, 'roundingSen', -2, 'totalSen', 3065,
                          'refundedSen', 300) then
    raise exception 'FAIL R4 ledger bills: %', v->'bills';
  end if;
  -- lines.csv: 11 live lines; each bill's line SST adds up to its rate group
  if jsonb_array_length(v->'lines') <> 11
     or (select sum((l->>'sstSen')::int) from jsonb_array_elements(v->'lines') l) <> 637
     or exists (
          select 1
            from (select l->>'billNo' as bill_no, (l->>'sstRateBp')::int as rate_bp, sum((l->>'sstSen')::int) as sst
                    from jsonb_array_elements(v->'lines') l group by 1, 2) x
            join bills b on b.branch_id = v_a and b.bill_no = x.bill_no
            left join lateral (select (g->>'amountSen')::int as amt from jsonb_array_elements(b.totals->'sstGroups') g
                                where (g->>'rateBp')::int = x.rate_bp) g on true
           where x.sst <> coalesce(g.amt, 0)) then
    raise exception 'FAIL R4 ledger lines do not add up: %', v->'lines';
  end if;
  -- largest remainder: C's 8% group of 227 sen on 8.00 + 10.20 + 10.20 is 63.94 / 81.53 / 81.53 sen → 64, 82, 81
  -- (rounding each line would give 64 + 82 + 82 = 228)
  if (select jsonb_agg((l->>'sstSen')::int order by (l->>'sstSen')::int) from jsonb_array_elements(v->'lines') l
       where l->>'billNo' = v_no_c) <> '[64, 81, 82]'::jsonb then
    raise exception 'FAIL R4 ledger largest remainder';
  end if;
  if (select l from jsonb_array_elements(v->'lines') l where l->>'billNo' = v_no_a and l->>'item' = 'Verify R Cake')
       <> jsonb_build_object('outlet', 'VERIFY R', 'billNo', v_no_a, 'item', 'Verify R Cake', 'qty', 1, 'unitPriceSen', 800,
                             'catalogDiscountSen', 0, 'itemDiscountSen', 80, 'billShareSen', 0, 'netSen', 720,
                             'sstRateBp', 800, 'sstSen', 58)
     or (select l from jsonb_array_elements(v->'lines') l where l->>'billNo' = v_no_b)
       <> jsonb_build_object('outlet', 'VERIFY R', 'billNo', v_no_b, 'item', 'Verify R Latte', 'qty', 2, 'unitPriceSen', 1000,
                             'catalogDiscountSen', 0, 'itemDiscountSen', 0, 'billShareSen', 200, 'netSen', 1800,
                             'sstRateBp', 600, 'sstSen', 108) then
    raise exception 'FAIL R4 ledger line values';
  end if;
  -- payments.csv: 7 payments adding up to Nett sales; E's part keeps its part number
  if jsonb_array_length(v->'payments') <> 7
     or (select sum((p->>'amountSen')::int) from jsonb_array_elements(v->'payments') p) <> 10200
     or (select jsonb_agg(p) from jsonb_array_elements(v->'payments') p where p->'partNo' <> 'null'::jsonb)
        <> jsonb_build_array(jsonb_build_object('outlet', 'VERIFY R', 'billNo', v_no_e, 'partNo', 1, 'method', 'R Card',
                             'kind', 'card', 'amountSen', 1000, 'tenderedSen', null, 'changeSen', 0, 'reference', null,
                             'takenAt', '2026-01-06T05:50:00.000Z'))
     or (select p from jsonb_array_elements(v->'payments') p where p->>'billNo' = v_no_c)
        <> jsonb_build_object('outlet', 'VERIFY R', 'billNo', v_no_c, 'partNo', null, 'method', 'R Cash', 'kind', 'cash',
                              'amountSen', 3065, 'tenderedSen', 5000, 'changeSen', 1935, 'reference', null,
                              'takenAt', '2026-01-06T02:00:00.000Z') then
    raise exception 'FAIL R4 ledger payments: %', v->'payments';
  end if;

  -- an outlet with no sales
  if pos_report_audit(array[pg_temp.id('other')], '2026-01-05', '2026-01-06')
       <> '{"discounts": [], "discountTotals": {"catalogSen": 0, "catalogBills": 0, "itemSen": 0, "itemCount": 0, "billSen": 0, "billCount": 0},
            "voidItems": [], "voidBills": [], "refunds": []}'::jsonb
     or pos_report_drawer(array[pg_temp.id('other')], '2026-01-05', '2026-01-06') <> '{"shifts": []}'::jsonb
     or pos_report_ledger(array[pg_temp.id('other')], '2026-01-05', '2026-01-06') <> '{"bills": [], "lines": [], "payments": []}'::jsonb then
    raise exception 'FAIL R4 an outlet with no sales';
  end if;
end $$;

```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add supabase/migration-2026-11-18-pos-reports.sql supabase/migration-2026-11-18-pos-reports-verify.sql src/features/pos/sqlSafeUpdate.test.ts
git commit -m "$(cat <<'EOF'
feat(pos): W3 reports SQL — discounts, voids, refunds, cash drawer, ledger (+ verify)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Client — range, URL filter, CSV and display helpers (pure)

**Files:**
- Create: `src/features/pos/reports/reportRange.ts`, `src/features/pos/reports/reportRange.test.ts`
- Create: `src/features/pos/reports/csv.ts`, `src/features/pos/reports/csv.test.ts`
- Create: `src/features/pos/reports/reportView.ts`, `src/features/pos/reports/reportView.test.ts`
- Create: `src/features/pos/reports/columns.ts`, `src/features/pos/reports/columns.test.ts`

**Interfaces:**
- Consumes: `formatSen(sen: number): string` from `src/features/pos/order/cart.ts` (`RM 12.30`, `RM -0.80`).
- Produces:
  - `reportRange.ts`: types `Preset = 'today' | 'yesterday' | 'this_week' | 'this_month' | 'last_month'`, `ReportTab = 'overview' | 'summary' | 'daily' | 'hourly' | 'products' | 'payments' | 'sst' | 'discounts' | 'voids' | 'refunds' | 'drawer' | 'ledger'`, `DateRange { from: string; to: string }`, `ReportFilter extends DateRange { outlets: string[]; tab: ReportTab }`, `OutletChoice { id: string; isHome: boolean }`; constants `MAX_DAYS = 366`, `PRESETS: { id: Preset; label: string }[]`, `TABS: { id: ReportTab; label: string }[]`; functions `isDay(s): boolean`, `addDays(day, n): string`, `dayCount(r): number`, `daysIn(r): string[]`, `businessDay(at: Date): string`, `presetRange(p, now: Date): DateRange`, `presetOf(r, now): Preset | 'custom'`, `previousRange(r): DateRange`, `rangeProblem(r): string | null`, `defaultOutlets(outlets, isHq): string[]`, `readFilter(params: URLSearchParams, outlets: OutletChoice[], isHq: boolean, now: Date): ReportFilter`, `filterParams(f: ReportFilter): URLSearchParams`.
  - `csv.ts`: `type Cell = string | number | null`, `csvCell(c): string`, `toCsv(header: string[], rows: Cell[][]): string`, `ringgit(sen): string`, `csvTime(iso): string`, `csvFileName(report, from, to): string`, `downloadCsv(fileName, text): void`.
  - `reportView.ts`: `ORDER_TYPE_LABELS`, `SOURCE_LABELS`, `PAYMENT_KIND_LABELS`, `DISCOUNT_ACTION_LABELS` (`Record<string, string>`), `changeText(current, previous): string`, `average(totalSen, count): number`, `rateLabel(bp): string`, `discountValueText(kind: string | null, value: number | null): string`, `dayLabel(day): string`, `dayShort(day): string`, `reportTime(iso): string`, `hourLabel(hour): string`, `rangeText(r: DateRange): string`, `dailySeries(rows: { day: string; nettSen: number }[], r: DateRange): { day: string; nettSen: number }[]`, `barPercents(values: number[]): number[]`.
  - `columns.ts`: `interface Column<R> { label: string; show: (r: R) => string; csv: (r: R) => Cell; numeric: boolean }`, `columnsFor<R>()` → `{ text(label, get: (r) => string | null), day(label, get: (r) => string), time(label, get: (r) => string | null, none = '—'), count(label, get: (r) => number | null), money(label, get: (r) => number | null) }`, `tableCsv<R>(columns: Column<R>[], rows: R[]): string`.

- [ ] **Step 1: Write the failing tests**

Create `src/features/pos/reports/reportRange.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  MAX_DAYS, PRESETS, TABS, addDays, businessDay, dayCount, daysIn, defaultOutlets, filterParams, isDay,
  presetOf, presetRange, previousRange, rangeProblem, readFilter,
} from './reportRange'

const at = (iso: string) => new Date(iso)
const NOW = at('2026-11-18T03:00:00Z')                                 // Wed 18 Nov 2026, 11:00 in Malaysia

describe('businessDay', () => {
  it('runs from 06:00 to 05:59 the next morning, Malaysia time', () => {
    expect(businessDay(at('2026-01-05T22:00:00Z'))).toBe('2026-01-06')   // 6 Jan 06:00
    expect(businessDay(at('2026-01-05T21:59:59Z'))).toBe('2026-01-05')   // 6 Jan 05:59:59
    expect(businessDay(at('2026-01-05T17:30:00Z'))).toBe('2026-01-05')   // 6 Jan 01:30 counts to 5 Jan
    expect(businessDay(at('2026-01-04T22:00:00Z'))).toBe('2026-01-05')   // 5 Jan 06:00
  })
})

describe('days', () => {
  it('isDay takes real dates only; addDays, dayCount and daysIn count whole days', () => {
    expect(isDay('2026-02-28')).toBe(true)
    expect(isDay('2026-02-30')).toBe(false)
    expect(isDay('2026-1-5')).toBe(false)
    expect(isDay('')).toBe(false)
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(dayCount({ from: '2026-01-05', to: '2026-01-06' })).toBe(2)
    expect(dayCount({ from: '2026-01-01', to: '2027-01-01' })).toBe(366)
    expect(daysIn({ from: '2026-01-30', to: '2026-02-02' })).toEqual(['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02'])
    expect(daysIn({ from: '2026-01-06', to: '2026-01-05' })).toEqual([])
  })
})

describe('presetRange', () => {
  it('Today, Yesterday, This week (Mon–Sun), This month, Last month', () => {
    expect(PRESETS.map((p) => p.label)).toEqual(['Today', 'Yesterday', 'This week', 'This month', 'Last month'])
    expect(presetRange('today', NOW)).toEqual({ from: '2026-11-18', to: '2026-11-18' })
    expect(presetRange('yesterday', NOW)).toEqual({ from: '2026-11-17', to: '2026-11-17' })
    expect(presetRange('this_week', NOW)).toEqual({ from: '2026-11-16', to: '2026-11-22' })
    expect(presetRange('this_month', NOW)).toEqual({ from: '2026-11-01', to: '2026-11-30' })
    expect(presetRange('last_month', NOW)).toEqual({ from: '2026-10-01', to: '2026-10-31' })
  })
  it('before 06:00 it is still the business day before', () => {
    expect(presetRange('today', at('2026-11-17T21:59:00Z'))).toEqual({ from: '2026-11-17', to: '2026-11-17' })
    expect(presetRange('today', at('2026-11-17T22:00:00Z'))).toEqual({ from: '2026-11-18', to: '2026-11-18' })
  })
  it('a Sunday ends its week; January looks back to December; February has 28 days', () => {
    expect(presetRange('this_week', at('2026-11-22T03:00:00Z'))).toEqual({ from: '2026-11-16', to: '2026-11-22' })
    expect(presetRange('last_month', at('2026-01-10T03:00:00Z'))).toEqual({ from: '2025-12-01', to: '2025-12-31' })
    expect(presetRange('this_month', at('2026-02-10T03:00:00Z'))).toEqual({ from: '2026-02-01', to: '2026-02-28' })
  })
})

describe('presetOf', () => {
  it('names the preset a range equals, else custom', () => {
    expect(presetOf({ from: '2026-11-16', to: '2026-11-22' }, NOW)).toBe('this_week')
    expect(presetOf({ from: '2026-10-01', to: '2026-10-31' }, NOW)).toBe('last_month')
    expect(presetOf({ from: '2026-11-02', to: '2026-11-03' }, NOW)).toBe('custom')
  })
})

describe('previousRange', () => {
  it('is the period of the same length just before', () => {
    expect(previousRange({ from: '2026-01-05', to: '2026-01-06' })).toEqual({ from: '2026-01-03', to: '2026-01-04' })
    expect(previousRange({ from: '2026-11-01', to: '2026-11-30' })).toEqual({ from: '2026-10-02', to: '2026-10-31' })
    expect(previousRange({ from: '2026-01-05', to: '2026-01-05' })).toEqual({ from: '2026-01-04', to: '2026-01-04' })
  })
})

describe('rangeProblem', () => {
  it('uses the server\'s words', () => {
    expect(rangeProblem({ from: '2026-01-05', to: '2026-01-06' })).toBeNull()
    expect(rangeProblem({ from: '2026-01-06', to: '2026-01-05' })).toBe('The start date is after the end date.')
    expect(rangeProblem({ from: '2026-01-01', to: '2027-01-01' })).toBeNull()
    expect(rangeProblem({ from: '2026-01-01', to: '2027-01-02' })).toBe(`Choose at most ${MAX_DAYS} days.`)
    expect(rangeProblem({ from: '', to: '2026-01-06' })).toBe('Choose a valid date range.')
    expect(rangeProblem({ from: '2026-02-30', to: '2026-03-01' })).toBe('Choose a valid date range.')
  })
})

describe('the filter in the URL', () => {
  const OUTLETS = [{ id: 'b1', isHome: false }, { id: 'b2', isHome: true }, { id: 'b3', isHome: false }]
  const params = (s: string) => new URLSearchParams(s)

  it('defaults: a manager their home outlet, HQ every outlet, today, Overview', () => {
    expect(readFilter(params(''), OUTLETS, false, NOW)).toEqual({ outlets: ['b2'], from: '2026-11-18', to: '2026-11-18', tab: 'overview' })
    expect(readFilter(params(''), OUTLETS, true, NOW).outlets).toEqual(['b1', 'b2', 'b3'])
    expect(defaultOutlets([{ id: 'x', isHome: false }, { id: 'y', isHome: false }], false)).toEqual(['x'])
    expect(defaultOutlets([], false)).toEqual([])
  })
  it('keeps only the caller\'s outlets, once each; a bad range or tab falls back', () => {
    expect(readFilter(params('outlets=b3,zz,b1,b3&from=2026-01-05&to=2026-01-06&tab=sst'), OUTLETS, false, NOW))
      .toEqual({ outlets: ['b3', 'b1'], from: '2026-01-05', to: '2026-01-06', tab: 'sst' })
    expect(readFilter(params('outlets=zz&from=2026-01-06&to=2026-01-05&tab=nope'), OUTLETS, false, NOW))
      .toEqual({ outlets: ['b2'], from: '2026-11-18', to: '2026-11-18', tab: 'overview' })
  })
  it('writes outlets, from, to and tab, and reads them back', () => {
    const f = { outlets: ['b1', 'b3'], from: '2026-01-05', to: '2026-01-06', tab: 'ledger' as const }
    expect(filterParams(f).toString()).toBe('outlets=b1%2Cb3&from=2026-01-05&to=2026-01-06&tab=ledger')
    expect(readFilter(filterParams(f), OUTLETS, false, NOW)).toEqual(f)
  })
  it('lists the twelve tabs in the spec\'s order', () => {
    expect(TABS.map((t) => t.label)).toEqual([
      'Overview', 'Sales summary', 'Daily sales', 'Hourly sales', 'Products', 'Payments', 'SST', 'Discounts', 'Voids',
      'Refunds', 'Cash drawer', 'Ledger export',
    ])
  })
})
```

Create `src/features/pos/reports/csv.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { csvCell, csvFileName, csvTime, downloadCsv, ringgit, toCsv } from './csv'

describe('csvCell', () => {
  it('quotes only what needs it and doubles quotes', () => {
    expect(csvCell('Latte')).toBe('Latte')
    expect(csvCell('Muffin, large')).toBe('"Muffin, large"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
    expect(csvCell(' padded')).toBe('" padded"')
    expect(csvCell(null)).toBe('')
    expect(csvCell(12)).toBe('12')
    expect(csvCell(-3)).toBe('-3')
  })
})

describe('toCsv', () => {
  it('UTF-8 BOM first, comma separated, CRLF after every row', () => {
    expect(toCsv(['A', 'B'], [['x', 1], [null, 'y,z']])).toBe('﻿A,B\r\nx,1\r\n,"y,z"\r\n')
  })
})

describe('ringgit', () => {
  it('two decimals, no RM, exact for every sen', () => {
    expect(ringgit(0)).toBe('0.00')
    expect(ringgit(5)).toBe('0.05')
    expect(ringgit(1230)).toBe('12.30')
    expect(ringgit(-2)).toBe('-0.02')
    expect(ringgit(-300)).toBe('-3.00')
    expect(ringgit(123456789)).toBe('1234567.89')
  })
})

describe('csvTime and csvFileName', () => {
  it('Malaysia time to the minute; report_from_to.csv', () => {
    expect(csvTime('2026-01-05T17:30:00.000Z')).toBe('2026-01-06 01:30')
    expect(csvFileName('daily-sales', '2026-01-05', '2026-01-06')).toBe('daily-sales_2026-01-05_2026-01-06.csv')
  })
})

describe('downloadCsv', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
  it('saves the text as a UTF-8 file with the given name, then frees the URL', () => {
    vi.useFakeTimers()
    const blobs: Blob[] = []
    const names: string[] = []
    const revoke = vi.fn()
    Object.assign(URL, { createObjectURL: (b: Blob) => { blobs.push(b); return 'blob:report' }, revokeObjectURL: revoke })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download) })
    downloadCsv('daily-sales_2026-01-05_2026-01-06.csv', '﻿A\r\n')
    expect(names).toEqual(['daily-sales_2026-01-05_2026-01-06.csv'])
    expect(blobs[0].type).toBe('text/csv;charset=utf-8')
    expect(blobs[0].size).toBe(6)                                        // BOM (3 bytes) + "A" + CRLF
    expect(document.querySelector('a')).toBeNull()                       // the link is removed again
    vi.runAllTimers()
    expect(revoke).toHaveBeenCalledWith('blob:report')
  })
})
```

Create `src/features/pos/reports/reportView.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  average, barPercents, changeText, dailySeries, dayLabel, dayShort, discountValueText, hourLabel, rangeText,
  rateLabel, reportTime,
} from './reportView'

describe('changeText', () => {
  it('against the previous period: +12%, -10%, 0%, — when the previous period is 0', () => {
    expect(changeText(10200, 1060)).toBe('+862%')
    expect(changeText(90, 100)).toBe('-10%')
    expect(changeText(100, 100)).toBe('0%')
    expect(changeText(5, 0)).toBe('—')
    expect(changeText(0, 0)).toBe('—')
  })
})

describe('numbers and words', () => {
  it('average rounds to the sen and is 0 with nothing to share', () => {
    expect(average(10200, 7)).toBe(1457)
    expect(average(1260, 2)).toBe(630)
    expect(average(0, 0)).toBe(0)
  })
  it('rates and discount values', () => {
    expect(rateLabel(600)).toBe('6%')
    expect(rateLabel(650)).toBe('6.5%')
    expect(rateLabel(0)).toBe('0%')
    expect(discountValueText('percent', 1000)).toBe('10%')
    expect(discountValueText('amount', 200)).toBe('RM 2.00')
    expect(discountValueText(null, null)).toBe('—')
  })
  it('days, times and hours in Malaysia time', () => {
    expect(dayLabel('2026-01-05')).toBe('Mon 5 Jan 2026')
    expect(dayShort('2026-01-05')).toBe('Mon 5 Jan')
    expect(reportTime('2026-01-05T17:30:00.000Z')).toBe('6 Jan 2026, 01:30')
    expect(hourLabel(9)).toBe('09:00–09:59')
    expect(rangeText({ from: '2026-01-05', to: '2026-01-05' })).toBe('Mon 5 Jan 2026')
    expect(rangeText({ from: '2026-01-05', to: '2026-01-06' })).toBe('Mon 5 Jan 2026 – Tue 6 Jan 2026')
  })
})

describe('bars', () => {
  it('dailySeries: every day of the range, outlets of one day added up, empty days 0', () => {
    expect(dailySeries([{ day: '2026-01-05', nettSen: 100 }, { day: '2026-01-05', nettSen: 50 }, { day: '2026-01-07', nettSen: 10 }],
      { from: '2026-01-05', to: '2026-01-07' }))
      .toEqual([{ day: '2026-01-05', nettSen: 150 }, { day: '2026-01-06', nettSen: 0 }, { day: '2026-01-07', nettSen: 10 }])
  })
  it('barPercents: against the largest, one decimal, never below 0', () => {
    expect(barPercents([3950, 6250])).toEqual([63.2, 100])
    expect(barPercents([0, 0])).toEqual([0, 0])
    expect(barPercents([-5, 10])).toEqual([0, 100])
    expect(barPercents([])).toEqual([])
  })
})
```

Create `src/features/pos/reports/columns.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { columnsFor, tableCsv } from './columns'

interface Row { name: string | null; day: string; at: string | null; n: number | null; sen: number | null }
const c = columnsFor<Row>()
const cols = [
  c.text('Name', (r) => r.name), c.day('Day', (r) => r.day), c.time('At', (r) => r.at, 'Still open'),
  c.count('N', (r) => r.n), c.money('Sen', (r) => r.sen),
]
const row: Row = { name: 'Latte', day: '2026-01-05', at: '2026-01-05T04:00:00.000Z', n: 3, sen: -80 }
const empty: Row = { name: null, day: '2026-01-06', at: null, n: null, sen: null }

describe('columns', () => {
  it('the screen shows RM, days and Malaysia times; the CSV holds plain values', () => {
    expect(cols.map((x) => x.show(row))).toEqual(['Latte', 'Mon 5 Jan 2026', '5 Jan 2026, 12:00', '3', 'RM -0.80'])
    expect(cols.map((x) => x.csv(row))).toEqual(['Latte', '2026-01-05', '2026-01-05 12:00', 3, '-0.80'])
    expect(cols.map((x) => x.numeric)).toEqual([false, false, false, true, true])
  })
  it('a missing value shows a dash (or the column\'s own words) and leaves the CSV cell empty', () => {
    expect(cols.map((x) => x.show(empty))).toEqual(['—', 'Tue 6 Jan 2026', 'Still open', '—', '—'])
    expect(cols.map((x) => x.csv(empty))).toEqual([null, '2026-01-06', null, null, null])
  })
  it('tableCsv: the labels, then one row per row', () => {
    expect(tableCsv(cols, [row, empty])).toBe('﻿Name,Day,At,N,Sen\r\nLatte,2026-01-05,2026-01-05 12:00,3,-0.80\r\n,2026-01-06,,,\r\n')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/pos/reports`
Expected: FAIL — four test files, each "Failed to resolve import" (`./reportRange`, `./csv`, `./reportView`, `./columns` do not exist).

- [ ] **Step 3: Write the four modules**

Create `src/features/pos/reports/reportRange.ts`:

```ts
// POS → Reports: the business days asked for and the filter kept in the page URL (spec §3). Pure.
// A business day runs from 06:00 to 05:59 the next morning, Malaysia time (UTC+8, no daylight saving),
// so the business day of an instant is the UTC calendar date of that instant plus 2 hours.

export type Preset = 'today' | 'yesterday' | 'this_week' | 'this_month' | 'last_month'
export type ReportTab =
  | 'overview' | 'summary' | 'daily' | 'hourly' | 'products' | 'payments'
  | 'sst' | 'discounts' | 'voids' | 'refunds' | 'drawer' | 'ledger'

/** Whole business days, both counted: 'YYYY-MM-DD'. */
export interface DateRange {
  from: string
  to: string
}
export interface ReportFilter extends DateRange {
  outlets: string[]
  tab: ReportTab
}
/** What the filter needs of my_outlets(). */
export interface OutletChoice {
  id: string
  isHome: boolean
}

export const MAX_DAYS = 366

export const PRESETS: { id: Preset; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'this_week', label: 'This week' },
  { id: 'this_month', label: 'This month' },
  { id: 'last_month', label: 'Last month' },
]

export const TABS: { id: ReportTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'summary', label: 'Sales summary' },
  { id: 'daily', label: 'Daily sales' },
  { id: 'hourly', label: 'Hourly sales' },
  { id: 'products', label: 'Products' },
  { id: 'payments', label: 'Payments' },
  { id: 'sst', label: 'SST' },
  { id: 'discounts', label: 'Discounts' },
  { id: 'voids', label: 'Voids' },
  { id: 'refunds', label: 'Refunds' },
  { id: 'drawer', label: 'Cash drawer' },
  { id: 'ledger', label: 'Ledger export' },
]

const DAY_MS = 86_400_000
const toTime = (day: string) => Date.parse(`${day}T00:00:00Z`)
const toDay = (t: number) => new Date(t).toISOString().slice(0, 10)

/** 'YYYY-MM-DD' naming a real date. */
export function isDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const t = toTime(s)
  return !Number.isNaN(t) && toDay(t) === s
}

export function addDays(day: string, n: number): string {
  return toDay(toTime(day) + n * DAY_MS)
}

/** Whole days from `from` to `to`, both counted. */
export function dayCount(r: DateRange): number {
  return Math.round((toTime(r.to) - toTime(r.from)) / DAY_MS) + 1
}

export function daysIn(r: DateRange): string[] {
  return Array.from({ length: Math.max(0, dayCount(r)) }, (_, i) => addDays(r.from, i))
}

/** The business day an instant belongs to. */
export function businessDay(at: Date): string {
  return toDay(at.getTime() + 2 * 3_600_000)
}

function lastDayOfMonth(first: string): string {
  const d = new Date(toTime(first))
  return toDay(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
}

export function presetRange(p: Preset, now: Date): DateRange {
  const today = businessDay(now)
  const firstOfMonth = `${today.slice(0, 7)}-01`
  switch (p) {
    case 'today':
      return { from: today, to: today }
    case 'yesterday': {
      const y = addDays(today, -1)
      return { from: y, to: y }
    }
    case 'this_week': {
      const monday = addDays(today, -((new Date(toTime(today)).getUTCDay() + 6) % 7))
      return { from: monday, to: addDays(monday, 6) }
    }
    case 'this_month':
      return { from: firstOfMonth, to: lastDayOfMonth(firstOfMonth) }
    case 'last_month': {
      const first = `${addDays(firstOfMonth, -1).slice(0, 7)}-01`
      return { from: first, to: lastDayOfMonth(first) }
    }
  }
}

/** The preset a range is, or 'custom'. */
export function presetOf(r: DateRange, now: Date): Preset | 'custom' {
  const hit = PRESETS.find((p) => {
    const x = presetRange(p.id, now)
    return x.from === r.from && x.to === r.to
  })
  return hit ? hit.id : 'custom'
}

/** The period of the same length just before (the Overview's comparison). */
export function previousRange(r: DateRange): DateRange {
  const n = dayCount(r)
  return { from: addDays(r.from, -n), to: addDays(r.from, -1) }
}

/** Why a range cannot be asked for — the server's words — or null. */
export function rangeProblem(r: DateRange): string | null {
  if (!isDay(r.from) || !isDay(r.to)) return 'Choose a valid date range.'
  if (r.from > r.to) return 'The start date is after the end date.'
  if (dayCount(r) > MAX_DAYS) return `Choose at most ${MAX_DAYS} days.`
  return null
}

/** HQ (all_branches) starts on every outlet; anyone else on their home outlet, or their first. */
export function defaultOutlets(outlets: OutletChoice[], isHq: boolean): string[] {
  if (isHq) return outlets.map((o) => o.id)
  const home = outlets.find((o) => o.isHome) ?? outlets[0]
  return home ? [home.id] : []
}

/** The filter of the page URL: unknown outlets dropped, a bad range → today, a bad tab → Overview. */
export function readFilter(params: URLSearchParams, outlets: OutletChoice[], isHq: boolean, now: Date): ReportFilter {
  const known = new Set(outlets.map((o) => o.id))
  const asked = [...new Set((params.get('outlets') ?? '').split(',').filter((id) => known.has(id)))]
  const range = { from: params.get('from') ?? '', to: params.get('to') ?? '' }
  const { from, to } = rangeProblem(range) === null ? range : presetRange('today', now)
  const tab = TABS.find((t) => t.id === params.get('tab'))?.id ?? 'overview'
  return { outlets: asked.length > 0 ? asked : defaultOutlets(outlets, isHq), from, to, tab }
}

export function filterParams(f: ReportFilter): URLSearchParams {
  return new URLSearchParams({ outlets: f.outlets.join(','), from: f.from, to: f.to, tab: f.tab })
}
```

Create `src/features/pos/reports/csv.ts`:

```ts
// CSV files for the accountant (spec §5): UTF-8 with a BOM (Excel then reads it as UTF-8), comma separated,
// CRLF line ends, ringgit with two decimals and no "RM", dates YYYY-MM-DD, times YYYY-MM-DD HH:MM in
// Malaysia time.

export type Cell = string | number | null

export function csvCell(c: Cell): string {
  const s = c === null ? '' : String(c)
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(header: string[], rows: Cell[][]): string {
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

/** 1230 → '12.30', -2 → '-0.02'. Integer arithmetic: exact for every sen. */
export function ringgit(sen: number): string {
  const a = Math.abs(sen)
  return `${sen < 0 ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`
}

/** An ISO time as 'YYYY-MM-DD HH:MM', Malaysia time. */
export function csvTime(iso: string): string {
  return new Date(Date.parse(iso) + 8 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')
}

export function csvFileName(report: string, from: string, to: string): string {
  return `${report}_${from}_${to}.csv`
}

/** Saves the text as a file through a temporary link. */
export function downloadCsv(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
```

Create `src/features/pos/reports/reportView.ts`:

```ts
// POS → Reports: words and numbers as the screen shows them (spec §5). Pure.
import { formatSen } from '../order/cart'
import { daysIn, type DateRange } from './reportRange'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number) => String(n).padStart(2, '0')

export const ORDER_TYPE_LABELS: Record<string, string> = { dine_in: 'Dine-in', takeaway: 'Takeaway' }
export const SOURCE_LABELS: Record<string, string> = { counter: 'Counter', qr: 'QR' }
export const PAYMENT_KIND_LABELS: Record<string, string> = {
  cash: 'Cash', card: 'Card', duitnow: 'DuitNow', ewallet: 'E-wallet', other: 'Other',
}
export const DISCOUNT_ACTION_LABELS: Record<string, string> = { set: 'Set', clear: 'Cleared', split: 'Split' }

/** '+12%', '-10%', '0%' against the previous period; '—' when the previous period is 0. */
export function changeText(current: number, previous: number): string {
  if (previous === 0) return '—'
  const pct = Math.round(((current - previous) / Math.abs(previous)) * 100)
  return `${pct > 0 ? '+' : ''}${pct}%`
}

export function average(totalSen: number, count: number): number {
  return count > 0 ? Math.round(totalSen / count) : 0
}

/** 600 → '6%'. */
export function rateLabel(bp: number): string {
  return `${bp / 100}%`
}

/** A discount as logged: a percent in basis points, an amount in sen. */
export function discountValueText(kind: string | null, value: number | null): string {
  if (value === null) return '—'
  if (kind === 'percent') return rateLabel(value)
  if (kind === 'amount') return formatSen(value)
  return '—'
}

/** '2026-01-05' → 'Mon 5 Jan 2026'. */
export function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`)
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/** '2026-01-05' → 'Mon 5 Jan'. */
export function dayShort(day: string): string {
  const d = new Date(`${day}T00:00:00Z`)
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

/** An ISO time as '6 Jan 2026, 01:30', Malaysia time. */
export function reportTime(iso: string): string {
  const d = new Date(Date.parse(iso) + 8 * 3_600_000)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/** 9 → '09:00–09:59'. */
export function hourLabel(hour: number): string {
  return `${pad(hour)}:00–${pad(hour)}:59`
}

export function rangeText(r: DateRange): string {
  return r.from === r.to ? dayLabel(r.from) : `${dayLabel(r.from)} – ${dayLabel(r.to)}`
}

/** Nett sales per business day of the range, every day present, the outlets of one day added up. */
export function dailySeries(rows: { day: string; nettSen: number }[], r: DateRange): { day: string; nettSen: number }[] {
  const byDay = new Map<string, number>()
  for (const row of rows) byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.nettSen)
  return daysIn(r).map((day) => ({ day, nettSen: byDay.get(day) ?? 0 }))
}

/** Bar heights in percent of the largest value, one decimal; a negative value draws no bar. */
export function barPercents(values: number[]): number[] {
  const max = Math.max(0, ...values)
  return values.map((v) => (max > 0 ? Math.round((Math.max(0, v) / max) * 1000) / 10 : 0))
}
```

Create `src/features/pos/reports/columns.ts`:

```ts
// One column of a report table: what the screen shows and what the CSV holds (spec §5: ringgit without
// "RM", dates YYYY-MM-DD, times in Malaysia time).
import { formatSen } from '../order/cart'
import { csvTime, ringgit, toCsv, type Cell } from './csv'
import { dayLabel, reportTime } from './reportView'

export interface Column<R> {
  label: string
  show: (r: R) => string
  csv: (r: R) => Cell
  numeric: boolean
}

/** Column builders for rows of type R. A missing value shows '—' and leaves the CSV cell empty. */
export function columnsFor<R>() {
  return {
    text: (label: string, get: (r: R) => string | null): Column<R> => ({
      label, numeric: false, show: (r) => get(r) ?? '—', csv: get,
    }),
    day: (label: string, get: (r: R) => string): Column<R> => ({
      label, numeric: false, show: (r) => dayLabel(get(r)), csv: get,
    }),
    time: (label: string, get: (r: R) => string | null, none = '—'): Column<R> => ({
      label,
      numeric: false,
      show: (r) => {
        const v = get(r)
        return v === null ? none : reportTime(v)
      },
      csv: (r) => {
        const v = get(r)
        return v === null ? null : csvTime(v)
      },
    }),
    count: (label: string, get: (r: R) => number | null): Column<R> => ({
      label,
      numeric: true,
      show: (r) => {
        const v = get(r)
        return v === null ? '—' : String(v)
      },
      csv: get,
    }),
    money: (label: string, get: (r: R) => number | null): Column<R> => ({
      label,
      numeric: true,
      show: (r) => {
        const v = get(r)
        return v === null ? '—' : formatSen(v)
      },
      csv: (r) => {
        const v = get(r)
        return v === null ? null : ringgit(v)
      },
    }),
  }
}

export function tableCsv<R>(columns: Column<R>[], rows: R[]): string {
  return toCsv(columns.map((c) => c.label), rows.map((r) => columns.map((c) => c.csv(r))))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/features/pos/reports`
Expected: PASS — 4 files.

Run: `npx tsc -b`
Expected: exits 0, no output.

- [ ] **Step 5: Commit**

```bash
git add src/features/pos/reports/reportRange.ts src/features/pos/reports/reportRange.test.ts \
        src/features/pos/reports/csv.ts src/features/pos/reports/csv.test.ts \
        src/features/pos/reports/reportView.ts src/features/pos/reports/reportView.test.ts \
        src/features/pos/reports/columns.ts src/features/pos/reports/columns.test.ts
git commit -m "$(cat <<'EOF'
feat(pos): W3 reports — business days, URL filter, CSV and display helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Client — report RPCs and their parsers

**Files:**
- Create: `src/features/pos/reports/reportsApi.ts`
- Create: `src/features/pos/reports/testReports.ts` (typed fixtures shared by the tests of Tasks 5–8; the numbers are the verify script's, the names short)
- Test: `src/features/pos/reports/reportsApi.test.ts`

**Interfaces:**
- Consumes: `supabase` from `src/shared/lib/supabase.ts`; the JSON shapes of Tasks 1–3 (File Structure).
- Produces (from `reportsApi.ts`):
  - `interface ReportQuery { outlets: string[]; from: string; to: string }`
  - Types `PeriodCards`, `DailyRow`, `HourlyRow`, `SalesSummary`, `OrderTypeRow`, `SourceRow`, `TopProduct`, `SalesReport`, `ProductRow`, `AddOnRow`, `CategoryRow`, `ProductsReport`, `PaymentRow`, `PaymentsReport`, `SstRate`, `SstMonth`, `SstReport`, `DiscountLogRow`, `DiscountTotals`, `VoidItemRow`, `VoidBillRow`, `RefundRow`, `AuditReport`, `DrawerRow`, `DrawerReport`, `LedgerBill`, `LedgerLine`, `LedgerPayment`, `LedgerReport` (fields = the JSON keys).
  - `fetchSalesReport(q): Promise<SalesReport>`, `fetchProductsReport(q): Promise<ProductsReport>`, `fetchPaymentsReport(q): Promise<PaymentsReport>`, `fetchSstReport(q): Promise<SstReport>`, `fetchAuditReport(q): Promise<AuditReport>`, `fetchDrawerReport(q): Promise<DrawerReport>`, `fetchLedgerReport(q): Promise<LedgerReport>` — each calls `supabase.rpc(fn, { p_branch_ids: q.outlets, p_from: q.from, p_to: q.to })`; a refusal throws the server's words; a wrong shape throws `Unexpected reply from the server`.
  - `parseSalesReport`, `parseProductsReport`, `parsePaymentsReport`, `parseSstReport`, `parseAuditReport`, `parseDrawerReport`, `parseLedgerReport` (`(data: unknown) => …Report`).
- Produces (from `testReports.ts`): `Q: ReportQuery` (`{ outlets: ['b1'], from: '2026-01-05', to: '2026-01-06' }`), `SALES`, `PRODUCTS`, `PAYMENTS`, `SST`, `AUDIT`, `EMPTY_AUDIT`, `DRAWER`, `LEDGER`.

- [ ] **Step 1: Write the fixtures and the failing test**

Create `src/features/pos/reports/testReports.ts`:

```ts
// Test data for the report tabs: the verify script's numbers (outlet "Cheras", bills CH-0001…), typed
// against reportsApi. Imported by tests only.
import type {
  AuditReport, DrawerReport, LedgerReport, PaymentsReport, ProductsReport, ReportQuery, SalesReport, SstReport,
} from './reportsApi'

export const Q: ReportQuery = { outlets: ['b1'], from: '2026-01-05', to: '2026-01-06' }

const HOURS: Record<number, [number, number]> = { 1: [1, 1910], 10: [1, 3065], 12: [1, 2040], 13: [2, 1260], 14: [1, 1925] }

export const SALES: SalesReport = {
  current: { nettSen: 10200, bills: 6, pax: 7, discountSen: 280, voidSen: 400, refundSen: 300 },
  previous: { nettSen: 1060, bills: 1, pax: 2, discountSen: 0, voidSen: 0, refundSen: 0 },
  daily: [
    { branchId: 'b1', outlet: 'Cheras', day: '2026-01-05', bills: 2, pax: 3, grossSen: 4000, discountSen: 280, takeawayFeeSen: 0,
      serviceChargeSen: 0, sstSen: 226, roundingSen: 4, nettSen: 3950, refundSen: 0 },
    { branchId: 'b1', outlet: 'Cheras', day: '2026-01-06', bills: 4, pax: 4, grossSen: 5840, discountSen: 0, takeawayFeeSen: 0,
      serviceChargeSen: 0, sstSen: 411, roundingSen: -1, nettSen: 6250, refundSen: 300 },
  ],
  hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, bills: HOURS[hour]?.[0] ?? 0, nettSen: HOURS[hour]?.[1] ?? 0 })),
  summary: {
    beforeDiscountsSen: 9840, catalogDiscountSen: 0, itemDiscountSen: 80, billDiscountSen: 200, grossSen: 9560,
    takeawayFeeSen: 0, serviceChargeSen: 0, sstSen: 637, roundingSen: 3, nettSen: 10200,
  },
  orderTypes: [{ orderType: 'dine_in', bills: 5, nettSen: 7135 }, { orderType: 'takeaway', bills: 1, nettSen: 3065 }],
  sources: [{ source: 'counter', orders: 4, itemSen: 8040 }, { source: 'qr', orders: 1, itemSen: 1800 }],
  topProducts: [
    { name: 'Latte', qty: 5, valueSen: 5000 }, { name: 'Cake', qty: 3, valueSen: 2400 },
    { name: 'Muffin', qty: 2, valueSen: 2040 }, { name: 'Water', qty: 2, valueSen: 400 },
  ],
}

export const PRODUCTS: ProductsReport = {
  products: [
    { name: 'Latte', category: 'Drinks', qty: 5, grossSen: 5000, discountSen: 200, netSen: 4800 },
    { name: 'Cake', category: 'Food', qty: 3, grossSen: 2400, discountSen: 80, netSen: 2320 },
    { name: 'Muffin', category: 'Food', qty: 2, grossSen: 2040, discountSen: 0, netSen: 2040 },
    { name: 'Water', category: null, qty: 2, grossSen: 400, discountSen: 0, netSen: 400 },
  ],
  addOns: [{ name: 'Oat milk', count: 2, valueSen: 300 }, { name: 'Extra shot', count: 2, valueSen: 200 }],
  categories: [
    { category: 'Drinks', qty: 5, netSen: 4800 }, { category: 'Food', qty: 5, netSen: 4360 }, { category: null, qty: 2, netSen: 400 },
  ],
}

export const PAYMENTS: PaymentsReport = {
  methods: [
    { name: 'Card', kind: 'card', count: 4, amountSen: 4300, refundCount: 0, refundSen: 0, netSen: 4300 },
    { name: 'Cash', kind: 'cash', count: 3, amountSen: 5900, refundCount: 1, refundSen: 300, netSen: 5600 },
  ],
}

export const SST: SstReport = {
  rates: [{ rateBp: 600, baseSen: 4800, sstSen: 288 }, { rateBp: 800, baseSen: 4360, sstSen: 349 }],
  exemptSen: 400,
  months: [
    { month: '2025-12', rates: [{ rateBp: 600, baseSen: 1000, sstSen: 60 }], exemptSen: 0 },
    { month: '2026-01', rates: [{ rateBp: 600, baseSen: 3800, sstSen: 228 }, { rateBp: 800, baseSen: 4360, sstSen: 349 }], exemptSen: 400 },
  ],
}

export const AUDIT: AuditReport = {
  discounts: [
    { at: '2026-01-05T03:40:00.000Z', outlet: 'Cheras', billNo: 'CH-0001', item: null, action: 'set', kind: 'amount', value: 100,
      reason: 'Regular', by: 'Aina', approvedBy: 'Ben' },
    { at: '2026-01-05T03:45:00.000Z', outlet: 'Cheras', billNo: 'CH-0001', item: null, action: 'clear', kind: 'amount', value: 100,
      reason: 'Regular', by: 'Aina', approvedBy: null },
    { at: '2026-01-05T03:50:00.000Z', outlet: 'Cheras', billNo: 'CH-0001', item: 'Cake', action: 'set', kind: 'percent', value: 1000,
      reason: 'Regular', by: 'Aina', approvedBy: 'Ben' },
    { at: '2026-01-05T05:05:00.000Z', outlet: 'Cheras', billNo: 'CH-0002', item: null, action: 'set', kind: 'amount', value: 200,
      reason: 'Regular', by: 'Aina', approvedBy: 'Ben' },
  ],
  discountTotals: { catalogSen: 0, catalogBills: 0, itemSen: 80, itemCount: 1, billSen: 200, billCount: 1 },
  voidItems: [
    { at: '2026-01-05T05:00:00.000Z', outlet: 'Cheras', billNo: 'CH-0002', name: 'Water', qty: 1, valueSen: 200,
      reason: 'Wrong item keyed', by: 'Aina', approvedBy: 'Ben' },
    { at: '2026-01-06T07:00:00.000Z', outlet: 'Cheras', billNo: 'CH-0008', name: 'Water', qty: 1, valueSen: 200,
      reason: 'Guest left', by: 'Aina', approvedBy: 'Ben' },
  ],
  voidBills: [
    { at: '2026-01-06T07:00:00.000Z', outlet: 'Cheras', billNo: 'CH-0008', valueSen: 200, reason: 'Guest left', by: 'Aina', approvedBy: 'Ben' },
  ],
  refunds: [
    { at: '2026-01-06T02:30:00.000Z', outlet: 'Cheras', billNo: 'CH-0003', method: 'Cash', amountSen: 300, reason: 'Cold cake', approvedBy: 'Ben' },
  ],
}

export const EMPTY_AUDIT: AuditReport = {
  discounts: [],
  discountTotals: { catalogSen: 0, catalogBills: 0, itemSen: 0, itemCount: 0, billSen: 0, billCount: 0 },
  voidItems: [],
  voidBills: [],
  refunds: [],
}

export const DRAWER: DrawerReport = {
  shifts: [
    { outlet: 'Cheras', openedAt: '2026-01-06T00:00:00.000Z', closedAt: '2026-01-06T14:00:00.000Z', openedBy: 'Aina', closedBy: 'Aina',
      floatSen: 10000, cashSalesSen: 3990, cashRefundSen: 300, payInSen: 2000, payOutSen: 500, expectedSen: 15190,
      countedSen: 15150, varianceSen: -40, reason: 'Short at close' },
    { outlet: 'Cheras', openedAt: '2026-01-06T12:00:00.000Z', closedAt: null, openedBy: 'Aina', closedBy: null,
      floatSen: 10000, cashSalesSen: 1910, cashRefundSen: 0, payInSen: 0, payOutSen: 0, expectedSen: 11910,
      countedSen: null, varianceSen: null, reason: null },
  ],
}

export const LEDGER: LedgerReport = {
  bills: [
    { outlet: 'Cheras', businessDate: '2026-01-05', closedAt: '2026-01-05T04:00:00.000Z', billNo: 'CH-0001', orderType: 'dine_in',
      table: 'T1', pax: 2, grossSen: 2000, discountSen: 80, takeawayFeeSen: 0, serviceChargeSen: 0, sstSen: 118, roundingSen: 2,
      totalSen: 2040, refundedSen: 0 },
    { outlet: 'Cheras', businessDate: '2026-01-06', closedAt: '2026-01-06T02:00:00.000Z', billNo: 'CH-0003', orderType: 'takeaway',
      table: null, pax: null, grossSen: 2840, discountSen: 0, takeawayFeeSen: 0, serviceChargeSen: 0, sstSen: 227, roundingSen: -2,
      totalSen: 3065, refundedSen: 300 },
  ],
  lines: [
    { outlet: 'Cheras', billNo: 'CH-0001', item: 'Cake', qty: 1, unitPriceSen: 800, catalogDiscountSen: 0, itemDiscountSen: 80,
      billShareSen: 0, netSen: 720, sstRateBp: 800, sstSen: 58 },
    { outlet: 'Cheras', billNo: 'CH-0003', item: 'Muffin, large', qty: 1, unitPriceSen: 1020, catalogDiscountSen: 0, itemDiscountSen: 0,
      billShareSen: 0, netSen: 1020, sstRateBp: 800, sstSen: 82 },
  ],
  payments: [
    { outlet: 'Cheras', billNo: 'CH-0003', partNo: null, method: 'Cash', kind: 'cash', amountSen: 3065, tenderedSen: 5000,
      changeSen: 1935, reference: null, takenAt: '2026-01-06T02:00:00.000Z' },
    { outlet: 'Cheras', billNo: 'CH-0005', partNo: 1, method: 'Card', kind: 'card', amountSen: 1000, tenderedSen: null,
      changeSen: 0, reference: 'APP 123', takenAt: '2026-01-06T05:50:00.000Z' },
  ],
}
```

Create `src/features/pos/reports/reportsApi.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../../../shared/lib/supabase', () => ({ supabase: { rpc: h.rpc } }))

import {
  fetchAuditReport, fetchDrawerReport, fetchLedgerReport, fetchPaymentsReport, fetchProductsReport, fetchSalesReport,
  fetchSstReport, parseAuditReport, parseDrawerReport, parseLedgerReport, parseSalesReport, type ReportQuery,
} from './reportsApi'
import { AUDIT, DRAWER, LEDGER, PAYMENTS, PRODUCTS, Q, SALES, SST } from './testReports'

/** The reply as it comes over the wire. */
const wire = (x: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(x)) as Record<string, unknown>

beforeEach(() => { h.rpc.mockReset() })

describe('report RPCs', () => {
  it('each report calls its function with the outlets and business days and reads its reply', async () => {
    const cases: [string, (q: ReportQuery) => Promise<unknown>, unknown][] = [
      ['pos_report_sales', fetchSalesReport, SALES],
      ['pos_report_products', fetchProductsReport, PRODUCTS],
      ['pos_report_payments', fetchPaymentsReport, PAYMENTS],
      ['pos_report_sst', fetchSstReport, SST],
      ['pos_report_audit', fetchAuditReport, AUDIT],
      ['pos_report_drawer', fetchDrawerReport, DRAWER],
      ['pos_report_ledger', fetchLedgerReport, LEDGER],
    ]
    for (const [fn, fetch, data] of cases) {
      h.rpc.mockResolvedValueOnce({ data: wire(data), error: null })
      expect(await fetch(Q)).toEqual(data)
      expect(h.rpc).toHaveBeenLastCalledWith(fn, { p_branch_ids: ['b1'], p_from: '2026-01-05', p_to: '2026-01-06' })
    }
  })

  it('a refusal reaches the tab in the server\'s words', async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { message: 'You cannot see reports for this outlet.' } })
    await expect(fetchSalesReport(Q)).rejects.toThrow('You cannot see reports for this outlet.')
  })
})

describe('parsers', () => {
  it('refuse a reply of the wrong shape', () => {
    expect(() => parseSalesReport(null)).toThrow('Unexpected reply from the server')
    expect(() => parseSalesReport({ ...wire(SALES), current: { ...SALES.current, nettSen: '102.00' } }))
      .toThrow('Unexpected reply from the server')
    const noHourly = wire(SALES)
    delete noHourly.hourly
    expect(() => parseSalesReport(noHourly)).toThrow('Unexpected reply from the server')
    const badBill = wire(LEDGER)
    ;(badBill.bills as Record<string, unknown>[])[0].billNo = null
    expect(() => parseLedgerReport(badBill)).toThrow('Unexpected reply from the server')
  })

  it('keep the nulls the reports may carry', () => {
    expect(parseDrawerReport(wire(DRAWER)).shifts[1]).toMatchObject({ closedAt: null, closedBy: null, countedSen: null, varianceSen: null, reason: null })
    expect(parseLedgerReport(wire(LEDGER)).payments[0]).toMatchObject({ partNo: null, reference: null })
    expect(parseLedgerReport(wire(LEDGER)).payments[1].tenderedSen).toBeNull()
    expect(parseAuditReport(wire(AUDIT)).discounts[1]).toMatchObject({ item: null, approvedBy: null })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/features/pos/reports/reportsApi.test.ts`
Expected: FAIL — `Failed to resolve import "./reportsApi"`.

- [ ] **Step 3: Write `reportsApi.ts`**

Create `src/features/pos/reports/reportsApi.ts`:

```ts
// src/features/pos/reports/reportsApi.ts — POS → Reports (spec §6): one RPC per report group, every reply
// checked before a tab draws it. Money in sen; times ISO (UTC); days 'YYYY-MM-DD'; months 'YYYY-MM'.
import { supabase } from '../../../shared/lib/supabase'

/** The outlets and business days asked for (the filter bar without its tab). */
export interface ReportQuery {
  outlets: string[]
  from: string
  to: string
}

export interface PeriodCards {
  nettSen: number
  bills: number
  pax: number
  discountSen: number
  voidSen: number
  refundSen: number
}
export interface DailyRow {
  branchId: string
  outlet: string
  day: string
  bills: number
  pax: number
  grossSen: number          // before discounts
  discountSen: number
  takeawayFeeSen: number
  serviceChargeSen: number
  sstSen: number
  roundingSen: number
  nettSen: number
  refundSen: number
}
export interface HourlyRow {
  hour: number
  bills: number
  nettSen: number
}
export interface SalesSummary {
  beforeDiscountsSen: number
  catalogDiscountSen: number  // Staff Meal
  itemDiscountSen: number
  billDiscountSen: number
  grossSen: number
  takeawayFeeSen: number
  serviceChargeSen: number
  sstSen: number
  roundingSen: number
  nettSen: number
}
export interface OrderTypeRow {
  orderType: string
  bills: number
  nettSen: number
}
export interface SourceRow {
  source: string
  orders: number
  itemSen: number
}
export interface TopProduct {
  name: string
  qty: number
  valueSen: number
}
export interface SalesReport {
  current: PeriodCards
  previous: PeriodCards
  daily: DailyRow[]
  hourly: HourlyRow[]
  summary: SalesSummary
  orderTypes: OrderTypeRow[]
  sources: SourceRow[]
  topProducts: TopProduct[]
}

export interface ProductRow {
  name: string
  category: string | null
  qty: number
  grossSen: number
  discountSen: number
  netSen: number
}
export interface AddOnRow {
  name: string
  count: number
  valueSen: number
}
export interface CategoryRow {
  category: string | null
  qty: number
  netSen: number
}
export interface ProductsReport {
  products: ProductRow[]
  addOns: AddOnRow[]
  categories: CategoryRow[]
}

export interface PaymentRow {
  name: string
  kind: string
  count: number
  amountSen: number
  refundCount: number
  refundSen: number
  netSen: number
}
export interface PaymentsReport {
  methods: PaymentRow[]
}

export interface SstRate {
  rateBp: number
  baseSen: number
  sstSen: number
}
export interface SstMonth {
  month: string
  rates: SstRate[]
  exemptSen: number
}
export interface SstReport {
  rates: SstRate[]
  exemptSen: number
  months: SstMonth[]
}

export interface DiscountLogRow {
  at: string
  outlet: string
  billNo: string
  item: string | null       // null = the bill discount
  action: string            // 'set' | 'clear' | 'split'
  kind: string | null       // 'amount' (sen) | 'percent' (basis points)
  value: number | null
  reason: string | null
  by: string | null
  approvedBy: string | null
}
export interface DiscountTotals {
  catalogSen: number
  catalogBills: number
  itemSen: number
  itemCount: number
  billSen: number
  billCount: number
}
export interface VoidItemRow {
  at: string
  outlet: string
  billNo: string
  name: string
  qty: number
  valueSen: number
  reason: string | null
  by: string | null
  approvedBy: string | null
}
export interface VoidBillRow {
  at: string
  outlet: string
  billNo: string
  valueSen: number
  reason: string | null
  by: string | null
  approvedBy: string | null
}
export interface RefundRow {
  at: string
  outlet: string
  billNo: string
  method: string
  amountSen: number
  reason: string | null
  approvedBy: string | null
}
export interface AuditReport {
  discounts: DiscountLogRow[]
  discountTotals: DiscountTotals
  voidItems: VoidItemRow[]
  voidBills: VoidBillRow[]
  refunds: RefundRow[]
}

export interface DrawerRow {
  outlet: string
  openedAt: string
  closedAt: string | null   // null = still open
  openedBy: string | null
  closedBy: string | null
  floatSen: number
  cashSalesSen: number
  cashRefundSen: number
  payInSen: number
  payOutSen: number
  expectedSen: number
  countedSen: number | null
  varianceSen: number | null
  reason: string | null
}
export interface DrawerReport {
  shifts: DrawerRow[]
}

export interface LedgerBill {
  outlet: string
  businessDate: string
  closedAt: string
  billNo: string
  orderType: string
  table: string | null
  pax: number | null
  grossSen: number
  discountSen: number
  takeawayFeeSen: number
  serviceChargeSen: number
  sstSen: number
  roundingSen: number
  totalSen: number
  refundedSen: number
}
export interface LedgerLine {
  outlet: string
  billNo: string
  item: string
  qty: number
  unitPriceSen: number
  catalogDiscountSen: number
  itemDiscountSen: number
  billShareSen: number
  netSen: number
  sstRateBp: number
  sstSen: number
}
export interface LedgerPayment {
  outlet: string
  billNo: string
  partNo: number | null
  method: string
  kind: string
  amountSen: number
  tenderedSen: number | null
  changeSen: number
  reference: string | null
  takenAt: string
}
export interface LedgerReport {
  bills: LedgerBill[]
  lines: LedgerLine[]
  payments: LedgerPayment[]
}

// ── reading a reply ──────────────────────────────────────────────────────────
type Obj = Record<string, unknown>
const bad = (): never => { throw new Error('Unexpected reply from the server') }
const obj = (x: unknown): Obj => (typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Obj) : bad())
const rows = <T>(x: unknown, read: (r: Obj) => T): T[] => (Array.isArray(x) ? x.map((e) => read(obj(e))) : bad())
const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : bad())
const str = (x: unknown): string => (typeof x === 'string' ? x : bad())
const optNum = (x: unknown): number | null => (x === null || x === undefined ? null : num(x))
const optStr = (x: unknown): string | null => (x === null || x === undefined ? null : str(x))
function nums<K extends string>(o: Obj, keys: readonly K[]): Record<K, number> {
  const out = {} as Record<K, number>
  for (const k of keys) out[k] = num(o[k])
  return out
}

const CARD_KEYS = ['nettSen', 'bills', 'pax', 'discountSen', 'voidSen', 'refundSen'] as const
const DAILY_KEYS = ['bills', 'pax', 'grossSen', 'discountSen', 'takeawayFeeSen', 'serviceChargeSen', 'sstSen', 'roundingSen',
  'nettSen', 'refundSen'] as const
const SUMMARY_KEYS = ['beforeDiscountsSen', 'catalogDiscountSen', 'itemDiscountSen', 'billDiscountSen', 'grossSen',
  'takeawayFeeSen', 'serviceChargeSen', 'sstSen', 'roundingSen', 'nettSen'] as const
const SST_KEYS = ['rateBp', 'baseSen', 'sstSen'] as const
const DRAWER_KEYS = ['floatSen', 'cashSalesSen', 'cashRefundSen', 'payInSen', 'payOutSen', 'expectedSen'] as const
const LEDGER_BILL_KEYS = ['grossSen', 'discountSen', 'takeawayFeeSen', 'serviceChargeSen', 'sstSen', 'roundingSen', 'totalSen',
  'refundedSen'] as const
const LEDGER_LINE_KEYS = ['qty', 'unitPriceSen', 'catalogDiscountSen', 'itemDiscountSen', 'billShareSen', 'netSen', 'sstRateBp',
  'sstSen'] as const

export function parseSalesReport(data: unknown): SalesReport {
  const o = obj(data)
  return {
    current: nums(obj(o.current), CARD_KEYS),
    previous: nums(obj(o.previous), CARD_KEYS),
    daily: rows(o.daily, (r) => ({ branchId: str(r.branchId), outlet: str(r.outlet), day: str(r.day), ...nums(r, DAILY_KEYS) })),
    hourly: rows(o.hourly, (r) => nums(r, ['hour', 'bills', 'nettSen'] as const)),
    summary: nums(obj(o.summary), SUMMARY_KEYS),
    orderTypes: rows(o.orderTypes, (r) => ({ orderType: str(r.orderType), ...nums(r, ['bills', 'nettSen'] as const) })),
    sources: rows(o.sources, (r) => ({ source: str(r.source), ...nums(r, ['orders', 'itemSen'] as const) })),
    topProducts: rows(o.topProducts, (r) => ({ name: str(r.name), ...nums(r, ['qty', 'valueSen'] as const) })),
  }
}

export function parseProductsReport(data: unknown): ProductsReport {
  const o = obj(data)
  return {
    products: rows(o.products, (r) => ({
      name: str(r.name), category: optStr(r.category), ...nums(r, ['qty', 'grossSen', 'discountSen', 'netSen'] as const),
    })),
    addOns: rows(o.addOns, (r) => ({ name: str(r.name), ...nums(r, ['count', 'valueSen'] as const) })),
    categories: rows(o.categories, (r) => ({ category: optStr(r.category), ...nums(r, ['qty', 'netSen'] as const) })),
  }
}

export function parsePaymentsReport(data: unknown): PaymentsReport {
  return {
    methods: rows(obj(data).methods, (r) => ({
      name: str(r.name), kind: str(r.kind),
      ...nums(r, ['count', 'amountSen', 'refundCount', 'refundSen', 'netSen'] as const),
    })),
  }
}

export function parseSstReport(data: unknown): SstReport {
  const o = obj(data)
  return {
    rates: rows(o.rates, (r) => nums(r, SST_KEYS)),
    exemptSen: num(o.exemptSen),
    months: rows(o.months, (m) => ({ month: str(m.month), rates: rows(m.rates, (r) => nums(r, SST_KEYS)), exemptSen: num(m.exemptSen) })),
  }
}

export function parseAuditReport(data: unknown): AuditReport {
  const o = obj(data)
  return {
    discounts: rows(o.discounts, (r) => ({
      at: str(r.at), outlet: str(r.outlet), billNo: str(r.billNo), item: optStr(r.item), action: str(r.action),
      kind: optStr(r.kind), value: optNum(r.value), reason: optStr(r.reason), by: optStr(r.by), approvedBy: optStr(r.approvedBy),
    })),
    discountTotals: nums(obj(o.discountTotals), ['catalogSen', 'catalogBills', 'itemSen', 'itemCount', 'billSen', 'billCount'] as const),
    voidItems: rows(o.voidItems, (r) => ({
      at: str(r.at), outlet: str(r.outlet), billNo: str(r.billNo), name: str(r.name), qty: num(r.qty), valueSen: num(r.valueSen),
      reason: optStr(r.reason), by: optStr(r.by), approvedBy: optStr(r.approvedBy),
    })),
    voidBills: rows(o.voidBills, (r) => ({
      at: str(r.at), outlet: str(r.outlet), billNo: str(r.billNo), valueSen: num(r.valueSen),
      reason: optStr(r.reason), by: optStr(r.by), approvedBy: optStr(r.approvedBy),
    })),
    refunds: rows(o.refunds, (r) => ({
      at: str(r.at), outlet: str(r.outlet), billNo: str(r.billNo), method: str(r.method), amountSen: num(r.amountSen),
      reason: optStr(r.reason), approvedBy: optStr(r.approvedBy),
    })),
  }
}

export function parseDrawerReport(data: unknown): DrawerReport {
  return {
    shifts: rows(obj(data).shifts, (r) => ({
      outlet: str(r.outlet), openedAt: str(r.openedAt), closedAt: optStr(r.closedAt),
      openedBy: optStr(r.openedBy), closedBy: optStr(r.closedBy), ...nums(r, DRAWER_KEYS),
      countedSen: optNum(r.countedSen), varianceSen: optNum(r.varianceSen), reason: optStr(r.reason),
    })),
  }
}

export function parseLedgerReport(data: unknown): LedgerReport {
  const o = obj(data)
  return {
    bills: rows(o.bills, (r) => ({
      outlet: str(r.outlet), businessDate: str(r.businessDate), closedAt: str(r.closedAt), billNo: str(r.billNo),
      orderType: str(r.orderType), table: optStr(r.table), pax: optNum(r.pax), ...nums(r, LEDGER_BILL_KEYS),
    })),
    lines: rows(o.lines, (r) => ({ outlet: str(r.outlet), billNo: str(r.billNo), item: str(r.item), ...nums(r, LEDGER_LINE_KEYS) })),
    payments: rows(o.payments, (r) => ({
      outlet: str(r.outlet), billNo: str(r.billNo), partNo: optNum(r.partNo), method: str(r.method), kind: str(r.kind),
      amountSen: num(r.amountSen), tenderedSen: optNum(r.tenderedSen), changeSen: num(r.changeSen),
      reference: optStr(r.reference), takenAt: str(r.takenAt),
    })),
  }
}

// ── the RPCs ─────────────────────────────────────────────────────────────────
function fail(error: { message: string } | null): never {
  throw new Error(error?.message ?? 'Unknown error')
}

async function report(fn: string, q: ReportQuery): Promise<unknown> {
  const { data, error } = await supabase.rpc(fn, { p_branch_ids: q.outlets, p_from: q.from, p_to: q.to })
  if (error) fail(error)
  return data
}

export async function fetchSalesReport(q: ReportQuery): Promise<SalesReport> {
  return parseSalesReport(await report('pos_report_sales', q))
}
export async function fetchProductsReport(q: ReportQuery): Promise<ProductsReport> {
  return parseProductsReport(await report('pos_report_products', q))
}
export async function fetchPaymentsReport(q: ReportQuery): Promise<PaymentsReport> {
  return parsePaymentsReport(await report('pos_report_payments', q))
}
export async function fetchSstReport(q: ReportQuery): Promise<SstReport> {
  return parseSstReport(await report('pos_report_sst', q))
}
export async function fetchAuditReport(q: ReportQuery): Promise<AuditReport> {
  return parseAuditReport(await report('pos_report_audit', q))
}
export async function fetchDrawerReport(q: ReportQuery): Promise<DrawerReport> {
  return parseDrawerReport(await report('pos_report_drawer', q))
}
export async function fetchLedgerReport(q: ReportQuery): Promise<LedgerReport> {
  return parseLedgerReport(await report('pos_report_ledger', q))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/features/pos/reports/reportsApi.test.ts`
Expected: PASS.

Run: `npx tsc -b`
Expected: exits 0, no output.

- [ ] **Step 5: Commit**

```bash
git add src/features/pos/reports/reportsApi.ts src/features/pos/reports/testReports.ts src/features/pos/reports/reportsApi.test.ts
git commit -m "$(cat <<'EOF'
feat(pos): W3 reports — report RPCs and checked parsers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Client — the page: filter bar, tabs, route, nav, Overview with bars

**Files:**
- Create: `src/features/pos/reports/useReport.ts`
- Create: `src/features/pos/reports/ReportBody.tsx`
- Create: `src/features/pos/reports/ReportTable.tsx`
- Create: `src/features/pos/reports/Bars.tsx`
- Create: `src/features/pos/reports/FilterBar.tsx`
- Create: `src/features/pos/reports/OverviewTab.tsx`
- Create: `src/features/pos/reports/ReportsPage.tsx`
- Test: `src/features/pos/reports/OverviewTab.test.tsx`, `src/features/pos/reports/ReportsPage.test.tsx`
- Modify: `src/App.tsx` (import after `import DevicesPage …` line 26; a route before the `/pos/settings` route)
- Modify: `src/shared/lib/nav.ts` (POS group, after `pos-register`)
- Modify: `src/shared/lib/nav.test.ts` (the POS test; one `activeEntry` test)
- Modify: `src/shared/components/Sidebar.tsx` (icon import and `ICONS`)

**Interfaces:**
- Consumes: Task 4 (`reportRange`, `reportView`, `columns`, `csv`), Task 5 (`ReportQuery`, `SalesReport`, `TopProduct`, `fetchSalesReport`, fixtures); `fetchMyOutlets(): Promise<Outlet[]>` (`src/features/pos/outlets/outletsApi.ts`), `Outlet` (`src/features/pos/outlets/outlet.ts`), `useCan()` (`src/shared/lib/permissions.ts`, `can(cap)`), `readableError(e): string` (`src/features/pos/checkout/rpcResult.ts`).
- Produces:
  - `useReport<T>(fetcher: (q: ReportQuery) => Promise<T>, query: ReportQuery): { load: ReportLoad<T>; retry: () => void }`, `type ReportLoad<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: T }`.
  - `ReportBody<T>({ load, retry, children: (data: T) => ReactNode })` (default export) and `NoSales()` (named) from `ReportBody.tsx`.
  - `ReportTable<R>({ title, columns: Column<R>[], rows: R[], fileName, empty? = 'No sales in this range.' })` (default export): an `h2` title, a **Download CSV** button (disabled with no rows), the table or the empty words.
  - `Bars({ title, bars: { label: string; valueSen: number }[] })` (default export): `role="list"` named by the title, one `role="listitem"` per bar named `"<label>: RM x.xx"`, its first child's `style.height` = the bar's percent.
  - `FilterBar({ outlets: Outlet[], filter: ReportFilter, now: Date, onChange: (f: ReportFilter) => void })`.
  - `OverviewTab({ query: ReportQuery })`; `ReportsPage()` (default export) with a local `TabBody({ tab, query })` that Tasks 7 and 8 extend.
  - Every later tab component has the signature `({ query }: { query: ReportQuery }) => JSX.Element` and is rendered by `TabBody`.

- [ ] **Step 1: Write the failing tests**

Create `src/features/pos/reports/OverviewTab.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Q, SALES } from './testReports'

const h = vi.hoisted(() => ({ sales: vi.fn() }))
vi.mock('./reportsApi', () => ({ fetchSalesReport: (q: unknown) => h.sales(q) }))

import OverviewTab from './OverviewTab'

const settle = async () => {
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
const card = (label: string) => within(screen.getByRole('listitem', { name: label }))

beforeEach(() => { h.sales.mockReset().mockResolvedValue(SALES) })
afterEach(cleanup)

describe('OverviewTab', () => {
  it('reads the sales of the outlets and business days asked for', async () => {
    render(<OverviewTab query={Q} />)
    await settle()
    expect(h.sales).toHaveBeenCalledWith(Q)
  })

  it('cards with the change against the previous period of the same length', async () => {
    render(<OverviewTab query={Q} />)
    await settle()
    expect(screen.getByText('Change against Sat 3 Jan 2026 – Sun 4 Jan 2026.')).toBeTruthy()
    expect(card('Nett sales').getByText('RM 102.00')).toBeTruthy()
    expect(card('Nett sales').getByText('+862%')).toBeTruthy()
    expect(card('Bills').getByText('6')).toBeTruthy()
    expect(card('Bills').getByText('+500%')).toBeTruthy()
    expect(card('Pax').getByText('+250%')).toBeTruthy()
    expect(card('Average per bill').getByText('RM 17.00')).toBeTruthy()
    expect(card('Average per bill').getByText('+60%')).toBeTruthy()
    expect(card('Average per pax').getByText('RM 14.57')).toBeTruthy()
    expect(card('Average per pax').getByText('+175%')).toBeTruthy()
    expect(card('Discounts').getByText('RM 2.80')).toBeTruthy()
    expect(card('Discounts').getByText('—')).toBeTruthy()
    expect(card('Voids').getByText('RM 4.00')).toBeTruthy()
    expect(card('Refunds').getByText('RM 3.00')).toBeTruthy()
    expect(card('Nett after refunds').getByText('RM 99.00')).toBeTruthy()
    expect(card('Nett after refunds').getByText('+834%')).toBeTruthy()
  })

  it('bars: daily nett sales over every day of the range, hourly over 24 hours', async () => {
    render(<OverviewTab query={Q} />)
    await settle()
    const daily = within(screen.getByRole('list', { name: 'Daily nett sales' })).getAllByRole('listitem')
    expect(daily.map((b) => b.getAttribute('aria-label'))).toEqual(['Mon 5 Jan: RM 39.50', 'Tue 6 Jan: RM 62.50'])
    expect(daily.map((b) => (b.firstElementChild as HTMLElement).style.height)).toEqual(['63.2%', '100%'])
    const hourly = within(screen.getByRole('list', { name: 'Hourly nett sales' })).getAllByRole('listitem')
    expect(hourly).toHaveLength(24)
    expect(hourly[13].getAttribute('aria-label')).toBe('13: RM 12.60')
  })

  it('top 10 products by quantity', async () => {
    render(<OverviewTab query={Q} />)
    await settle()
    const section = screen.getByRole('heading', { name: 'Top 10 products' }).closest('section') as HTMLElement
    expect(within(section).getAllByRole('row').map((r) => r.textContent))
      .toEqual(['ProductQtyValue', 'Latte5RM 50.00', 'Cake3RM 24.00', 'Muffin2RM 20.40', 'Water2RM 4.00'])
  })

  it('no bills: No sales in this range.', async () => {
    h.sales.mockResolvedValue({ ...SALES, current: { ...SALES.current, nettSen: 0, bills: 0, pax: 0 } })
    render(<OverviewTab query={Q} />)
    await settle()
    expect(screen.getByText('No sales in this range.')).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Totals' })).toBeNull()
  })

  it('a failed read shows the reason; Retry reads again', async () => {
    h.sales.mockRejectedValueOnce(new Error('You cannot see reports for this outlet.'))
    render(<OverviewTab query={Q} />)
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('Could not load the report: You cannot see reports for this outlet.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await settle()
    expect(h.sales).toHaveBeenCalledTimes(2)
    expect(card('Nett sales').getByText('RM 102.00')).toBeTruthy()
  })

  it('no reply reads as plain words, never the browser\'s', async () => {
    h.sales.mockRejectedValueOnce(new TypeError('Load failed'))
    render(<OverviewTab query={Q} />)
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('No reply from the server. Check the internet connection and try again.')
  })
})
```

Create `src/features/pos/reports/ReportsPage.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { Outlet } from '../outlets/outlet'
import { AUDIT, DRAWER, LEDGER, PAYMENTS, PRODUCTS, SALES, SST } from './testReports'

const h = vi.hoisted(() => ({
  caps: [] as string[],
  outlets: vi.fn(),
  sales: vi.fn(), products: vi.fn(), payments: vi.fn(), sst: vi.fn(), audit: vi.fn(), drawer: vi.fn(), ledger: vi.fn(),
}))
vi.mock('../../../shared/lib/permissions', () => ({ useCan: () => ({ can: (c: string) => h.caps.includes(c) }) }))
vi.mock('../outlets/outletsApi', () => ({ fetchMyOutlets: () => h.outlets() }))
vi.mock('./reportsApi', () => ({
  fetchSalesReport: (q: unknown) => h.sales(q),
  fetchProductsReport: (q: unknown) => h.products(q),
  fetchPaymentsReport: (q: unknown) => h.payments(q),
  fetchSstReport: (q: unknown) => h.sst(q),
  fetchAuditReport: (q: unknown) => h.audit(q),
  fetchDrawerReport: (q: unknown) => h.drawer(q),
  fetchLedgerReport: (q: unknown) => h.ledger(q),
}))

import ReportsPage from './ReportsPage'

const OUTLETS: Outlet[] = [
  { id: 'b1', name: 'Cheras', kind: 'branch', opensOn: null, closesOn: null, billPrefix: 'CH', isActive: true, isHome: true, openNow: true },
  { id: 'b2', name: 'Kepong', kind: 'branch', opensOn: null, closesOn: null, billPrefix: 'KP', isActive: true, isHome: false, openNow: true },
]

function Where() {
  return <output data-testid="where">{useLocation().search}</output>
}
const where = () => screen.getByTestId('where').textContent
const settle = async () => {
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
function renderAt(url: string) {
  render(<MemoryRouter initialEntries={[url]}><ReportsPage /><Where /></MemoryRouter>)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-06T03:00:00Z'))                   // Tue 6 Jan 2026, 11:00 in Malaysia
  h.caps = ['access_settings']
  h.outlets.mockReset().mockResolvedValue(OUTLETS)
  h.sales.mockReset().mockResolvedValue(SALES)
  h.products.mockReset().mockResolvedValue(PRODUCTS)
  h.payments.mockReset().mockResolvedValue(PAYMENTS)
  h.sst.mockReset().mockResolvedValue(SST)
  h.audit.mockReset().mockResolvedValue(AUDIT)
  h.drawer.mockReset().mockResolvedValue(DRAWER)
  h.ledger.mockReset().mockResolvedValue(LEDGER)
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('ReportsPage', () => {
  it('a manager starts on their home outlet, today, Overview', async () => {
    renderAt('/pos/reports')
    await settle()
    expect(h.sales).toHaveBeenCalledWith({ outlets: ['b1'], from: '2026-01-06', to: '2026-01-06' })
    expect((screen.getByRole('checkbox', { name: 'Cheras' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: 'Kepong' }) as HTMLInputElement).checked).toBe(false)
    expect(screen.getByRole('button', { name: 'Today' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('Tue 6 Jan 2026. A business day runs from 06:00 to 05:59 the next morning, Malaysia time.')).toBeTruthy()
  })

  it('HQ starts on every outlet', async () => {
    h.caps = ['access_settings', 'all_branches']
    renderAt('/pos/reports')
    await settle()
    expect(h.sales).toHaveBeenCalledWith({ outlets: ['b1', 'b2'], from: '2026-01-06', to: '2026-01-06' })
  })

  it('the filter is read from the URL and every change is written back', async () => {
    renderAt('/pos/reports?outlets=b2&from=2026-01-05&to=2026-01-06&tab=overview')
    await settle()
    expect(h.sales).toHaveBeenLastCalledWith({ outlets: ['b2'], from: '2026-01-05', to: '2026-01-06' })
    expect(screen.getByRole('button', { name: 'Custom' }).getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('2026-01-05')
    fireEvent.click(screen.getByRole('button', { name: 'Yesterday' }))
    await settle()
    expect(where()).toBe('?outlets=b2&from=2026-01-05&to=2026-01-05&tab=overview')
    expect(h.sales).toHaveBeenLastCalledWith({ outlets: ['b2'], from: '2026-01-05', to: '2026-01-05' })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Cheras' }))
    await settle()
    expect(where()).toBe('?outlets=b1%2Cb2&from=2026-01-05&to=2026-01-05&tab=overview')
    fireEvent.click(screen.getByRole('tab', { name: 'Sales summary' }))
    await settle()
    expect(where()).toBe('?outlets=b1%2Cb2&from=2026-01-05&to=2026-01-05&tab=summary')
    expect(screen.getByRole('tab', { name: 'Sales summary' }).getAttribute('aria-selected')).toBe('true')
  })

  it('a custom range of more than 366 days is refused before asking the server', async () => {
    renderAt('/pos/reports')
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }))
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2025-01-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(screen.getByRole('alert').textContent).toBe('Choose at most 366 days.')
    expect(where()).toBe('')
    expect(h.sales).toHaveBeenCalledTimes(1)
  })

  it('the last outlet cannot be unticked', async () => {
    renderAt('/pos/reports')
    await settle()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Cheras' }))
    expect(screen.getByRole('alert').textContent).toBe('Choose at least one outlet.')
    expect(where()).toBe('')
  })

  it('the outlets fail to load: the reason and Retry', async () => {
    h.outlets.mockRejectedValueOnce(new TypeError('Load failed'))
    renderAt('/pos/reports')
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('Could not load your outlets: No reply from the server.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await settle()
    expect(screen.getByRole('checkbox', { name: 'Cheras' })).toBeTruthy()
  })

  it('no outlets: says so', async () => {
    h.outlets.mockResolvedValue([])
    renderAt('/pos/reports')
    await settle()
    expect(screen.getByText('You have no outlets to report on.')).toBeTruthy()
  })
})
```

In `src/shared/lib/nav.test.ts`, replace the whole test `it('POS groups the register, menu, POS settings and devices; staff see only the register', () => { … })` with:

```ts
  it('POS groups the register, reports, menu, POS settings and devices; staff see only the register', () => {
    const pos = (can: (c: Capability) => boolean) => {
      const g = visibleNav(can).find(e => e.id === 'pos')
      return g && isGroup(g) ? g.children.map(c => c.id) : []
    }
    expect(pos(canWith())).toEqual(['pos-register'])
    expect(pos(canWith('access_settings'))).toEqual(['pos-register', 'pos-reports', 'pos-settings', 'pos-devices'])
    expect(pos(canWith('manage_menu'))).toEqual(['pos-register', 'menu'])
    expect(pos(canWith('access_settings', 'manage_menu'))).toEqual(['pos-register', 'pos-reports', 'menu', 'pos-settings', 'pos-devices'])
  })
```

and add inside `describe('activeEntry', …)`, after `it('/team/projects 命中 Projects,不会误点亮 Directory', …)`:

```ts
  it('/pos/reports lights Reports, not the Register (longest prefix wins)', () => {
    expect(activeEntry(full, '/pos/reports')).toEqual({ leafId: 'pos-reports', groupId: 'pos' })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/pos/reports/OverviewTab.test.tsx src/features/pos/reports/ReportsPage.test.tsx src/shared/lib/nav.test.ts`
Expected: FAIL — `Failed to resolve import "./OverviewTab"` and `"./ReportsPage"`; in `nav.test.ts` the POS test and the `/pos/reports` test fail (no `pos-reports` leaf).

- [ ] **Step 3: Write the hook and the shared pieces**

Create `src/features/pos/reports/useReport.ts`:

```ts
// One report tab's read (spec §6 Errors): each tab loads on its own; a reply for an earlier filter is
// dropped; Retry reads again.
import { useCallback, useEffect, useRef, useState } from 'react'
import { readableError } from '../checkout/rpcResult'
import type { ReportQuery } from './reportsApi'

export type ReportLoad<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: T }

export function useReport<T>(fetcher: (q: ReportQuery) => Promise<T>, query: ReportQuery): { load: ReportLoad<T>; retry: () => void } {
  const [load, setLoad] = useState<ReportLoad<T>>({ status: 'loading' })
  const seq = useRef(0)
  const key = `${query.outlets.join(',')}|${query.from}|${query.to}`
  const run = useCallback(() => {
    const id = ++seq.current
    setLoad({ status: 'loading' })
    fetcher(query).then(
      (data) => { if (id === seq.current) setLoad({ status: 'ready', data }) },
      (e: unknown) => { if (id === seq.current) setLoad({ status: 'error', message: readableError(e) }) },
    )
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps -- the query is its key; fetcher is a module function
  useEffect(() => { run() }, [run])
  return { load, retry: run }
}
```

Create `src/features/pos/reports/ReportBody.tsx`:

```tsx
import type { ReactNode } from 'react'
import type { ReportLoad } from './useReport'

/** A tab's body: loading, the reason with Retry, or the report. */
export default function ReportBody<T>({ load, retry, children }: {
  load: ReportLoad<T>
  retry: () => void
  children: (data: T) => ReactNode
}) {
  if (load.status === 'loading') return <p className="text-sm text-brown-muted">Loading…</p>
  if (load.status === 'error') {
    return (
      <div role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">
        Could not load the report: {load.message}
        <button type="button" onClick={retry} className="ml-3 underline">Retry</button>
      </div>
    )
  }
  return <>{children(load.data)}</>
}

export function NoSales() {
  return <p className="text-sm text-brown-muted">No sales in this range.</p>
}
```

Create `src/features/pos/reports/ReportTable.tsx`:

```tsx
import { tableCsv, type Column } from './columns'
import { downloadCsv } from './csv'

/** One report table: its title, Download CSV (the same columns, CSV values) and the rows. */
export default function ReportTable<R>({ title, columns, rows, fileName, empty = 'No sales in this range.' }: {
  title: string
  columns: Column<R>[]
  rows: R[]
  fileName: string
  empty?: string
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">{title}</h2>
        <button type="button" disabled={rows.length === 0} onClick={() => downloadCsv(fileName, tableCsv(columns, rows))}
                className="text-xs underline disabled:opacity-50">Download CSV</button>
      </div>
      {rows.length === 0 ? <p className="mt-2 text-sm text-brown-muted">{empty}</p> : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-brown-muted">
                {columns.map((c) => <th key={c.label} className={`px-2 py-1 ${c.numeric ? 'text-right' : ''}`}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-border">
                  {columns.map((c) => (
                    <td key={c.label} className={`px-2 py-1 ${c.numeric ? 'text-right tabular-nums' : ''}`}>{c.show(r)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
```

Create `src/features/pos/reports/Bars.tsx`:

```tsx
import { formatSen } from '../order/cart'
import { barPercents } from './reportView'

export interface Bar {
  label: string
  valueSen: number
}

/** A plain CSS bar chart (no chart library): one column per bar, heights against the largest. */
export default function Bars({ title, bars }: { title: string; bars: Bar[] }) {
  const pct = barPercents(bars.map((b) => b.valueSen))
  const every = bars.length > 31 ? Math.ceil(bars.length / 12) : 1           // at most ~12 labels under a long range
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="font-semibold">{title}</h2>
      <div role="list" aria-label={title} className="mt-3 flex h-40 items-end gap-px">
        {bars.map((b, i) => (
          <div key={i} role="listitem" aria-label={`${b.label}: ${formatSen(b.valueSen)}`} title={`${b.label}: ${formatSen(b.valueSen)}`}
               className="flex h-full min-w-0 flex-1 flex-col justify-end">
            <div className="rounded-t bg-brown-btn" style={{ height: `${pct[i]}%` }} />
          </div>
        ))}
      </div>
      <div aria-hidden="true" className="mt-1 flex gap-px text-[10px] text-brown-muted">
        {bars.map((b, i) => <span key={i} className="min-w-0 flex-1 truncate text-center">{i % every === 0 ? b.label : ''}</span>)}
      </div>
    </section>
  )
}
```

Create `src/features/pos/reports/FilterBar.tsx`:

```tsx
import { useEffect, useState } from 'react'
import type { Outlet } from '../outlets/outlet'
import { PRESETS, presetOf, presetRange, rangeProblem, type DateRange, type Preset, type ReportFilter } from './reportRange'
import { rangeText } from './reportView'

const chip = (on: boolean) => `rounded px-3 py-1 text-sm ${on ? 'bg-brown-btn text-white' : 'border border-border'}`

/** The one filter bar of POS → Reports (spec §3): outlets, then a preset or a custom range of business days. */
export default function FilterBar({ outlets, filter, now, onChange }: {
  outlets: Outlet[]
  filter: ReportFilter
  now: Date
  onChange: (f: ReportFilter) => void
}) {
  const preset = presetOf(filter, now)
  const [customOpen, setCustomOpen] = useState(false)
  const [draft, setDraft] = useState<DateRange>({ from: filter.from, to: filter.to })
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => { setDraft({ from: filter.from, to: filter.to }) }, [filter.from, filter.to])
  const custom = customOpen || preset === 'custom'

  const toggle = (id: string) => {
    const on = !filter.outlets.includes(id)
    const next = outlets.map((o) => o.id).filter((x) => (x === id ? on : filter.outlets.includes(x)))
    if (next.length === 0) { setProblem('Choose at least one outlet.'); return }
    setProblem(null)
    onChange({ ...filter, outlets: next })
  }
  const choose = (p: Preset) => {
    setCustomOpen(false)
    setProblem(null)
    onChange({ ...filter, ...presetRange(p, now) })
  }
  const show = () => {
    const why = rangeProblem(draft)
    setProblem(why)
    if (!why) onChange({ ...filter, from: draft.from, to: draft.to })
  }

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <fieldset className="flex flex-wrap items-center gap-3">
        <legend className="mb-1 text-xs text-brown-muted">Outlets</legend>
        {outlets.map((o) => (
          <label key={o.id} className="inline-flex items-center gap-1 text-sm">
            <input type="checkbox" checked={filter.outlets.includes(o.id)} onChange={() => toggle(o.id)} />
            {o.name}
          </label>
        ))}
      </fieldset>
      <div role="group" aria-label="Dates" className="flex flex-wrap items-center gap-2">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" aria-pressed={!custom && preset === p.id} onClick={() => choose(p.id)}
                  className={chip(!custom && preset === p.id)}>{p.label}</button>
        ))}
        <button type="button" aria-pressed={custom} onClick={() => setCustomOpen(true)} className={chip(custom)}>Custom</button>
      </div>
      {custom && (
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <label className="flex flex-col">From
            <input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })}
                   className="rounded border border-border p-1" />
          </label>
          <label className="flex flex-col">To
            <input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })}
                   className="rounded border border-border p-1" />
          </label>
          <button type="button" onClick={show} className="rounded bg-brown-btn px-3 py-1 text-white">Show</button>
        </div>
      )}
      <p className="text-xs text-brown-muted">{rangeText(filter)}. A business day runs from 06:00 to 05:59 the next morning, Malaysia time.</p>
      {problem && <p role="alert" className="text-sm text-red-700">{problem}</p>}
    </div>
  )
}
```

- [ ] **Step 4: Write the Overview tab and the page**

Create `src/features/pos/reports/OverviewTab.tsx`:

```tsx
import { formatSen } from '../order/cart'
import Bars from './Bars'
import ReportBody, { NoSales } from './ReportBody'
import ReportTable from './ReportTable'
import { columnsFor } from './columns'
import { csvFileName } from './csv'
import { previousRange } from './reportRange'
import { average, changeText, dailySeries, dayShort, rangeText } from './reportView'
import { fetchSalesReport, type ReportQuery, type SalesReport, type TopProduct } from './reportsApi'
import { useReport } from './useReport'

const top = columnsFor<TopProduct>()
const TOP_COLUMNS = [top.text('Product', (r) => r.name), top.count('Qty', (r) => r.qty), top.money('Value', (r) => r.valueSen)]

interface Card {
  label: string
  value: string
  change: string
}

/** Spec §5.1: each card with its change against the previous period of the same length. */
function cards(r: SalesReport): Card[] {
  const cur = r.current
  const prev = r.previous
  const money = (label: string, a: number, b: number): Card => ({ label, value: formatSen(a), change: changeText(a, b) })
  const count = (label: string, a: number, b: number): Card => ({ label, value: String(a), change: changeText(a, b) })
  return [
    money('Nett sales', cur.nettSen, prev.nettSen),
    count('Bills', cur.bills, prev.bills),
    count('Pax', cur.pax, prev.pax),
    money('Average per bill', average(cur.nettSen, cur.bills), average(prev.nettSen, prev.bills)),
    money('Average per pax', average(cur.nettSen, cur.pax), average(prev.nettSen, prev.pax)),
    money('Discounts', cur.discountSen, prev.discountSen),
    money('Voids', cur.voidSen, prev.voidSen),
    money('Refunds', cur.refundSen, prev.refundSen),
    money('Nett after refunds', cur.nettSen - cur.refundSen, prev.nettSen - prev.refundSen),
  ]
}

export default function OverviewTab({ query }: { query: ReportQuery }) {
  const { load, retry } = useReport(fetchSalesReport, query)
  return (
    <ReportBody load={load} retry={retry}>
      {(r) => (r.current.bills === 0 ? <NoSales /> : (
        <div className="space-y-4">
          <p className="text-xs text-brown-muted">Change against {rangeText(previousRange(query))}.</p>
          <ul aria-label="Totals" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {cards(r).map((c) => (
              <li key={c.label} aria-label={c.label} className="rounded-xl border border-border bg-card p-3">
                <div className="text-xs text-brown-muted">{c.label}</div>
                <div className="text-lg font-semibold tabular-nums">{c.value}</div>
                <div className="text-xs text-brown-muted">{c.change}</div>
              </li>
            ))}
          </ul>
          <Bars title="Daily nett sales"
                bars={dailySeries(r.daily, query).map((d) => ({ label: dayShort(d.day), valueSen: d.nettSen }))} />
          <Bars title="Hourly nett sales"
                bars={r.hourly.map((x) => ({ label: String(x.hour).padStart(2, '0'), valueSen: x.nettSen }))} />
          <ReportTable title="Top 10 products" columns={TOP_COLUMNS} rows={r.topProducts}
                       fileName={csvFileName('top-products', query.from, query.to)} />
        </div>
      ))}
    </ReportBody>
  )
}
```

Create `src/features/pos/reports/ReportsPage.tsx`:

```tsx
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useCan } from '../../../shared/lib/permissions'
import { readableError } from '../checkout/rpcResult'
import type { Outlet } from '../outlets/outlet'
import { fetchMyOutlets } from '../outlets/outletsApi'
import FilterBar from './FilterBar'
import OverviewTab from './OverviewTab'
import { TABS, filterParams, readFilter, type ReportFilter, type ReportTab } from './reportRange'
import type { ReportQuery } from './reportsApi'

const tabClass = (on: boolean) => `rounded px-3 py-1 text-sm ${on ? 'bg-brown-btn text-white' : 'border border-border bg-card'}`

/** POS → Reports (spec §2): sales, payments, SST and the cash drawer of the caller's outlets. */
export default function ReportsPage() {
  const { can } = useCan()
  const isHq = can('all_branches')
  const [params, setParams] = useSearchParams()
  const [outlets, setOutlets] = useState<Outlet[] | null>(null)        // null while loading
  const [error, setError] = useState<string | null>(null)
  const [now] = useState(() => new Date())
  const loadOutlets = useCallback(() => {
    setError(null)
    fetchMyOutlets().then(setOutlets, (e: unknown) => setError(readableError(e)))
  }, [])
  useEffect(() => { loadOutlets() }, [loadOutlets])

  let body: ReactNode
  if (error) {
    body = (
      <div role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">
        Could not load your outlets: {error}
        <button type="button" onClick={loadOutlets} className="ml-3 underline">Retry</button>
      </div>
    )
  } else if (!outlets) {
    body = <p className="text-sm text-brown-muted">Loading…</p>
  } else if (outlets.length === 0) {
    body = <p className="text-sm text-brown-muted">You have no outlets to report on.</p>
  } else {
    const filter = readFilter(params, outlets, isHq, now)
    const change = (f: ReportFilter) => setParams(filterParams(f), { replace: true })
    const query: ReportQuery = { outlets: filter.outlets, from: filter.from, to: filter.to }
    body = (
      <>
        <FilterBar outlets={outlets} filter={filter} now={now} onChange={change} />
        <div role="tablist" aria-label="Reports" className="flex flex-wrap gap-1">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={filter.tab === t.id}
                    onClick={() => change({ ...filter, tab: t.id })} className={tabClass(filter.tab === t.id)}>{t.label}</button>
          ))}
        </div>
        <div role="tabpanel" aria-label={TABS.find((t) => t.id === filter.tab)?.label}>
          <TabBody tab={filter.tab} query={query} />
        </div>
      </>
    )
  }
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <h1 className="text-2xl font-semibold">Reports</h1>
      {body}
    </div>
  )
}

function TabBody({ tab, query }: { tab: ReportTab; query: ReportQuery }) {
  switch (tab) {
    case 'overview': return <OverviewTab query={query} />
    default: return null
  }
}
```

- [ ] **Step 5: Wire the route, the nav leaf and its icon**

In `src/App.tsx`, after the line `import DevicesPage from './features/pos/devices/DevicesPage'` add:

```tsx
import ReportsPage from './features/pos/reports/ReportsPage'
```

and directly before the `/pos/settings` route (`<Route\n        path="/pos/settings"`) add:

```tsx
      <Route
        path="/pos/reports"
        element={
          <ProtectedRoute requireCap="access_settings">
            <AppLayout><ReportsPage /></AppLayout>
          </ProtectedRoute>
        }
      />

```

In `src/shared/lib/nav.ts`, in the POS group, after the `pos-register` leaf add:

```ts
      { id: 'pos-reports',  label: 'Reports',           to: '/pos/reports', cap: 'access_settings' },
```

In `src/shared/components/Sidebar.tsx`, add `ChartColumn` to the `lucide-react` import (after `Printer`):

```tsx
  CalendarCheck, Wallet, Palmtree, Receipt, CalendarDays, UtensilsCrossed, Store, MonitorSmartphone, Printer, ChartColumn,
```

and in `ICONS`, after `'pos-register': MonitorSmartphone,` add:

```tsx
  'pos-reports': ChartColumn,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/features/pos/reports src/shared/lib/nav.test.ts src/shared/components/Sidebar.test.tsx`
Expected: PASS.

Run: `npx tsc -b`
Expected: exits 0, no output.

- [ ] **Step 7: Commit**

```bash
git add src/features/pos/reports/useReport.ts src/features/pos/reports/ReportBody.tsx src/features/pos/reports/ReportTable.tsx \
        src/features/pos/reports/Bars.tsx src/features/pos/reports/FilterBar.tsx src/features/pos/reports/OverviewTab.tsx \
        src/features/pos/reports/ReportsPage.tsx src/features/pos/reports/OverviewTab.test.tsx \
        src/features/pos/reports/ReportsPage.test.tsx src/App.tsx src/shared/lib/nav.ts src/shared/lib/nav.test.ts \
        src/shared/components/Sidebar.tsx
git commit -m "$(cat <<'EOF'
feat(pos): W3 reports page — filter bar in the URL, tabs, Overview with bars; POS → Reports nav

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Client — Sales summary, Daily, Hourly, Products, Payments and SST tabs

**Files:**
- Create: `src/features/pos/reports/SummaryTab.tsx`, `DailyTab.tsx`, `HourlyTab.tsx`, `ProductsTab.tsx`, `PaymentsTab.tsx`, `SstTab.tsx` (all in `src/features/pos/reports/`)
- Test: `src/features/pos/reports/salesTabs.test.tsx`
- Modify: `src/features/pos/reports/ReportsPage.tsx` (imports; `TabBody`)

**Interfaces:**
- Consumes: Task 5 (`fetchSalesReport`, `fetchProductsReport`, `fetchPaymentsReport`, `fetchSstReport` and their row types; fixtures `Q`, `SALES`, `PRODUCTS`, `PAYMENTS`, `SST`), Task 6 (`useReport`, `ReportBody`, `NoSales`, `ReportTable`), Task 4 (`columnsFor`, `csvFileName`, `ORDER_TYPE_LABELS`, `SOURCE_LABELS`, `PAYMENT_KIND_LABELS`, `average`, `hourLabel`, `rateLabel`).
- Produces: default exports `SummaryTab`, `DailyTab`, `HourlyTab`, `ProductsTab`, `PaymentsTab`, `SstTab`, each `({ query }: { query: ReportQuery })`. Table titles and CSV names: Sales summary (`sales-summary`), By order type (`order-types`), By source (`sources`), Daily sales (`daily-sales`), Hourly sales (`hourly-sales`), Products (`products`), Add-ons (`add-ons`), Categories (`categories`), Payments (`payments`), SST by rate (`sst-by-rate`), SST by month (`sst-by-month`).

- [ ] **Step 1: Write the failing test**

Create `src/features/pos/reports/salesTabs.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { PAYMENTS, PRODUCTS, Q, SALES, SST } from './testReports'

const h = vi.hoisted(() => ({ sales: vi.fn(), products: vi.fn(), payments: vi.fn(), sst: vi.fn(), download: vi.fn() }))
vi.mock('./reportsApi', () => ({
  fetchSalesReport: (q: unknown) => h.sales(q),
  fetchProductsReport: (q: unknown) => h.products(q),
  fetchPaymentsReport: (q: unknown) => h.payments(q),
  fetchSstReport: (q: unknown) => h.sst(q),
}))
vi.mock('./csv', async (importOriginal) => ({ ...(await importOriginal<typeof import('./csv')>()), downloadCsv: h.download }))

import DailyTab from './DailyTab'
import HourlyTab from './HourlyTab'
import PaymentsTab from './PaymentsTab'
import ProductsTab from './ProductsTab'
import SstTab from './SstTab'
import SummaryTab from './SummaryTab'

const settle = async () => {
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
const section = (title: string) => screen.getByRole('heading', { name: title }).closest('section') as HTMLElement
/** The cells of the row of a table whose first cell reads `first`. */
function rowOf(table: HTMLElement, first: string): string[] {
  const td = within(table).getAllByText(first).find((e) => e.tagName === 'TD')
  if (!td) throw new Error(`no row "${first}"`)
  return [...(td.closest('tr') as HTMLElement).querySelectorAll('td')].map((c) => c.textContent ?? '')
}
const headers = (table: HTMLElement) => [...table.querySelectorAll('th')].map((c) => c.textContent)

beforeEach(() => {
  h.sales.mockReset().mockResolvedValue(SALES)
  h.products.mockReset().mockResolvedValue(PRODUCTS)
  h.payments.mockReset().mockResolvedValue(PAYMENTS)
  h.sst.mockReset().mockResolvedValue(SST)
  h.download.mockReset()
})
afterEach(cleanup)

describe('SummaryTab', () => {
  it('Feedme\'s order, then order types and sources', async () => {
    render(<SummaryTab query={Q} />)
    await settle()
    const s = section('Sales summary')
    expect([...s.querySelectorAll('tbody tr')].map((r) => r.querySelector('td')?.textContent)).toEqual([
      'Gross before discounts', 'Staff Meal', 'Item discounts', 'Bill discounts', 'Gross sales', 'Takeaway fee',
      'Service charge', 'SST', 'Rounding', 'Nett sales',
    ])
    expect(rowOf(s, 'Gross before discounts')).toEqual(['Gross before discounts', 'RM 98.40'])
    expect(rowOf(s, 'Item discounts')).toEqual(['Item discounts', 'RM -0.80'])
    expect(rowOf(s, 'Gross sales')).toEqual(['Gross sales', 'RM 95.60'])
    expect(rowOf(s, 'Rounding')).toEqual(['Rounding', 'RM 0.03'])
    expect(rowOf(s, 'Nett sales')).toEqual(['Nett sales', 'RM 102.00'])
    expect(rowOf(section('By order type'), 'Dine-in')).toEqual(['Dine-in', '5', 'RM 71.35'])
    expect(rowOf(section('By source'), 'QR')).toEqual(['QR', '1', 'RM 18.00'])
  })
  it('no bills: No sales in this range.', async () => {
    h.sales.mockResolvedValue({ ...SALES, current: { ...SALES.current, bills: 0 } })
    render(<SummaryTab query={Q} />)
    await settle()
    expect(screen.getByText('No sales in this range.')).toBeTruthy()
  })
})

describe('DailyTab', () => {
  it('one row per outlet and business day; the CSV holds the same in ringgit', async () => {
    render(<DailyTab query={Q} />)
    await settle()
    const s = section('Daily sales')
    expect(rowOf(s, 'Cheras')).toEqual(['Cheras', 'Mon 5 Jan 2026', '2', '3', 'RM 40.00', 'RM 2.80', 'RM 0.00', 'RM 0.00',
      'RM 2.26', 'RM 0.04', 'RM 39.50', 'RM 0.00'])
    fireEvent.click(within(s).getByRole('button', { name: 'Download CSV' }))
    expect(h.download).toHaveBeenCalledWith('daily-sales_2026-01-05_2026-01-06.csv',
      '﻿Outlet,Business day,Bills,Pax,Gross,Discounts,Takeaway fee,Service charge,SST,Rounding,Nett,Refunds\r\n'
      + 'Cheras,2026-01-05,2,3,40.00,2.80,0.00,0.00,2.26,0.04,39.50,0.00\r\n'
      + 'Cheras,2026-01-06,4,4,58.40,0.00,0.00,0.00,4.11,-0.01,62.50,3.00\r\n')
  })
  it('no rows: No sales in this range., and nothing to download', async () => {
    h.sales.mockResolvedValue({ ...SALES, daily: [] })
    render(<DailyTab query={Q} />)
    await settle()
    expect(screen.getByText('No sales in this range.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Download CSV' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('HourlyTab', () => {
  it('24 rows with the average per bill', async () => {
    render(<HourlyTab query={Q} />)
    await settle()
    const s = section('Hourly sales')
    expect(s.querySelectorAll('tbody tr')).toHaveLength(24)
    expect(rowOf(s, '13:00–13:59')).toEqual(['13:00–13:59', '2', 'RM 12.60', 'RM 6.30'])
    expect(rowOf(s, '00:00–00:59')).toEqual(['00:00–00:59', '0', 'RM 0.00', 'RM 0.00'])
  })
})

describe('ProductsTab', () => {
  it('products, add-ons and categories; no category reads as such', async () => {
    render(<ProductsTab query={Q} />)
    await settle()
    expect(rowOf(section('Products'), 'Latte')).toEqual(['Latte', 'Drinks', '5', 'RM 50.00', 'RM 2.00', 'RM 48.00'])
    expect(rowOf(section('Products'), 'Water')).toEqual(['Water', 'No category', '2', 'RM 4.00', 'RM 0.00', 'RM 4.00'])
    expect(rowOf(section('Add-ons'), 'Oat milk')).toEqual(['Oat milk', '2', 'RM 3.00'])
    expect(rowOf(section('Categories'), 'No category')).toEqual(['No category', '2', 'RM 4.00'])
  })
  it('no add-ons: says so', async () => {
    h.products.mockResolvedValue({ ...PRODUCTS, addOns: [] })
    render(<ProductsTab query={Q} />)
    await settle()
    expect(within(section('Add-ons')).getByText('No add-ons in this range.')).toBeTruthy()
  })
})

describe('PaymentsTab', () => {
  it('per method: payments, refunds and net', async () => {
    render(<PaymentsTab query={Q} />)
    await settle()
    const s = section('Payments')
    expect(headers(s)).toEqual(['Method', 'Kind', 'Payments', 'Amount', 'Refunds', 'Refunded', 'Net'])
    expect(rowOf(s, 'Cash')).toEqual(['Cash', 'Cash', '3', 'RM 59.00', '1', 'RM 3.00', 'RM 56.00'])
  })
})

describe('SstTab', () => {
  it('per rate with exempt; per month with a column pair for every rate', async () => {
    render(<SstTab query={Q} />)
    await settle()
    const rates = section('SST by rate')
    expect(rowOf(rates, 'SST 6%')).toEqual(['SST 6%', 'RM 48.00', 'RM 2.88'])
    expect(rowOf(rates, 'Exempt (0%)')).toEqual(['Exempt (0%)', 'RM 4.00', '—'])
    const months = section('SST by month')
    expect(headers(months)).toEqual(['Month', 'Taxable 6%', 'SST 6%', 'Taxable 8%', 'SST 8%', 'Exempt'])
    expect(rowOf(months, '2025-12')).toEqual(['2025-12', 'RM 10.00', 'RM 0.60', 'RM 0.00', 'RM 0.00', 'RM 0.00'])
    expect(rowOf(months, '2026-01')).toEqual(['2026-01', 'RM 38.00', 'RM 2.28', 'RM 43.60', 'RM 3.49', 'RM 4.00'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/features/pos/reports/salesTabs.test.tsx`
Expected: FAIL — `Failed to resolve import "./DailyTab"`.

- [ ] **Step 3: Write the six tabs**

Create `src/features/pos/reports/SummaryTab.tsx`:

```tsx
import ReportBody, { NoSales } from './ReportBody'
import ReportTable from './ReportTable'
import { columnsFor } from './columns'
import { csvFileName } from './csv'
import { ORDER_TYPE_LABELS, SOURCE_LABELS } from './reportView'
import { fetchSalesReport, type OrderTypeRow, type ReportQuery, type SalesSummary, type SourceRow } from './reportsApi'
import { useReport } from './useReport'

interface Line {
  label: string
  sen: number
}

/** Feedme's order (spec §5.2): gross before discounts → discounts → gross sales → charges → nett. */
function summaryLines(s: SalesSummary): Line[] {
  return [
    { label: 'Gross before discounts', sen: s.beforeDiscountsSen },
    { label: 'Staff Meal', sen: -s.catalogDiscountSen },
    { label: 'Item discounts', sen: -s.itemDiscountSen },
    { label: 'Bill discounts', sen: -s.billDiscountSen },
    { label: 'Gross sales', sen: s.grossSen },
    { label: 'Takeaway fee', sen: s.takeawayFeeSen },
    { label: 'Service charge', sen: s.serviceChargeSen },
    { label: 'SST', sen: s.sstSen },
    { label: 'Rounding', sen: s.roundingSen },
    { label: 'Nett sales', sen: s.nettSen },
  ]
}

const l = columnsFor<Line>()
const LINE_COLUMNS = [l.text('Item', (r) => r.label), l.money('Amount', (r) => r.sen)]
const t = columnsFor<OrderTypeRow>()
const TYPE_COLUMNS = [
  t.text('Order type', (r) => ORDER_TYPE_LABELS[r.orderType] ?? r.orderType), t.count('Bills', (r) => r.bills),
  t.money('Nett sales', (r) => r.nettSen),
]
const s = columnsFor<SourceRow>()
const SOURCE_COLUMNS = [
  s.text('Source', (r) => SOURCE_LABELS[r.source] ?? r.source), s.count('Orders', (r) => r.orders),
  s.money('Item value', (r) => r.itemSen),
]

export default function SummaryTab({ query }: { query: ReportQuery }) {
  const { load, retry } = useReport(fetchSalesReport, query)
  return (
    <ReportBody load={load} retry={retry}>
      {(r) => (r.current.bills === 0 ? <NoSales /> : (
        <div className="space-y-4">
          <ReportTable title="Sales summary" columns={LINE_COLUMNS} rows={summaryLines(r.summary)}
                       fileName={csvFileName('sales-summary', query.from, query.to)} />
          <ReportTable title="By order type" columns={TYPE_COLUMNS} rows={r.orderTypes}
                       fileName={csvFileName('order-types', query.from, query.to)} />
          <ReportTable title="By source" columns={SOURCE_COLUMNS} rows={r.sources}
                       fileName={csvFileName('sources', query.from, query.to)} />
          <p className="text-xs text-brown-muted">Refunds are listed in the Refunds tab and are not taken off these sales.</p>
        </div>
      ))}
    </ReportBody>
  )
}
```

Create `src/features/pos/reports/DailyTab.tsx`:

```tsx
import ReportBody from './ReportBody'
import ReportTable from './ReportTable'
import { columnsFor } from './columns'
import { csvFileName } from './csv'
import { fetchSalesReport, type DailyRow, type ReportQuery } from './reportsApi'
import { useReport } from './useReport'

const c = columnsFor<DailyRow>()
const COLUMNS = [
  c.text('Outlet', (r) => r.outlet), c.day('Business day', (r) => r.day), c.count('Bills', (r) => r.bills),
  c.count('Pax', (r) => r.pax), c.money('Gross', (r) => r.grossSen), c.money('Discounts', (r) => r.discountSen),
  c.money('Takeaway fee', (r) => r.takeawayFeeSen), c.money('Service charge', (r) => r.serviceChargeSen),
  c.money('SST', (r) => r.sstSen), c.money('Rounding', (r) => r.roundingSen), c.money('Nett', (r) => r.nettSen),
  c.money('Refunds', (r) => r.refundSen),
]

/** Spec §5.3: one row per outlet per business day. Gross is before discounts; refunds are not taken off. */
export default function DailyTab({ query }: { query: ReportQuery }) {
  const { load, retry } = useReport(fetchSalesReport, query)
  return (
    <ReportBody load={load} retry={retry}>
      {(r) => <ReportTable title="Daily sales" columns={COLUMNS} rows={r.daily} fileName={csvFileName('daily-sales', query.from, query.to)} />}
    </ReportBody>
  )
}
```

Create `src/features/pos/reports/HourlyTab.tsx`:

```tsx
import ReportBody, { NoSales } from './ReportBody'
import ReportTable from './ReportTable'
import { columnsFor } from './columns'
import { csvFileName } from './csv'
import { average, hourLabel } from './reportView'
import { fetchSalesReport, type HourlyRow, type ReportQuery } from './reportsApi'
import { useReport } from './useReport'

const c = columnsFor<HourlyRow>()
const COLUMNS = [
  c.text('Hour', (r) => hourLabel(r.hour)), c.count('Bills', (r) => r.bills), c.money('Nett sales', (r) => r.nettSen),
  c.money('Average per bill', (r) => average(r.nettSen, r.bills)),
]

/** Spec §5.4: one row per hour 0–23 over the range, by the Malaysia hour a bill was paid. */
export default function HourlyTab({ query }: { query: ReportQuery }) {
  const { load, retry } = useReport(fetchSalesReport, query)
  return (
    <ReportBody load={load} retry={retry}>
      {(r) => (r.current.bills === 0 ? <NoSales /> : (
        <ReportTable title="Hourly sales" columns={COLUMNS} rows={r.hourly} fileName={csvFileName('hourly-sales', query.from, query.to)} />
      ))}
    </ReportBody>
  )
}
```

Create `src/features/pos/reports/ProductsTab.tsx`:

```tsx
import ReportBody, { NoSales } from './ReportBody'
import ReportTable from './ReportTable'
import { columnsFor } from './columns'
import { csvFileName } from './csv'
import { fetchProductsReport, type AddOnRow, type CategoryRow, type ProductRow, type ReportQuery } from './reportsApi'
import { useReport } from './useReport'

const p = columnsFor<ProductRow>()
const PRODUCT_COLUMNS = [
  p.text('Product', (r) => r.name), p.text('Category', (r) => r.category ?? 'No category'), p.count('Qty', (r) => r.qty),
  p.money('Gross', (r) => r.grossSen), p.money('Discounts', (r) => r.discountSen), p.money('Net', (r) => r.netSen),
]
const a = columnsFor<AddOnRow>()
const ADD_ON_COLUMNS = [a.text('Add-on', (r) => r.name), a.count('Count', (r) => r.count), a.money('Value', (r) => r.valueSen)]
const k = columnsFor<CategoryRow>()
const CATEGORY_COLUMNS = [
  k.text('Category', (r) => r.category ?? 'No category'), k.count('Qty', (r) => r.qty), k.money('Net', (r) => r.netSen),
]

/** Spec §5.5: per product (gross = price × qty, net after every discount), add-ons, categories (today's). */
export default function ProductsTab({ query }: { query: ReportQuery }) {
  const { load, retry } = useReport(fetchProductsReport, query)
  const file = (name: string) => csvFileName(name, query.from, query.to)
  return (
    <ReportBody load={load} retry={retry}>
      {(r) => (r.products.length === 0 ? <NoSales /> : (
        <div className="space-y-4">
          <ReportTable title="Products" columns={PRODUCT_COLUMNS} rows={r.products} fileName={file('products')} />
          <ReportTable title="Add-ons" columns={ADD_ON_COLUMNS} rows={r.addOns} fileName={file('add-ons')}
                       empty="No add-ons in this range." />
          <ReportTable title="Categories" columns={CATEGORY_COLUMNS} rows={r.categories} fileName={file('categories')} />
          <p className="text-xs text-brown-muted">A product's category is its category today.</p>
        </div>
      ))}
    </ReportBody>
  )
}
```

Create `src/features/pos/reports/PaymentsTab.tsx`:

```tsx
import ReportBody, { NoSales } from './ReportBody'
import ReportTable from './ReportTable'
import { columnsFor } from './columns'
import { csvFileName } from './csv'
import { PAYMENT_KIND_LABELS } from './reportView'
import { fetchPaymentsReport, type PaymentRow, type ReportQuery } from './reportsApi'
import { useReport } from './useReport'

const c = columnsFor<PaymentRow>()
const COLUMNS = [
  c.text('Method', (r) => r.name), c.text('Kind', (r) => PAYMENT_KIND_LABELS[r.kind] ?? r.kind),
  c.count('Payments', (r) => r.count), c.money('Amount', (r) => r.amountSen), c.count('Refunds', (r) => r.refundCount),
  c.money('Refunded', (r) => r.refundSen), c.money('Net', (r) => r.netSen),
]

/** Spec §5.6: per method; part payments are payments like any other. */
export default function PaymentsTab({ query }: { query: ReportQuery }) {
  const { load, retry } = useReport(fetchPaymentsReport, query)
  return (
    <ReportBody load={load} retry={retry}>
      {(r) => (r.methods.length === 0 ? <NoSales /> : (
        <div className="space-y-2">
          <ReportTable title="Payments" columns={COLUMNS} rows={r.methods} fileName={csvFileName('payments', query.from, query.to)} />
          <p className="text-xs text-brown-muted">The payments of the bills sold in this range; refunds by the day they were made.</p>
        </div>
      ))}
    </ReportBody>
  )
}
```

Create `src/features/pos/reports/SstTab.tsx`:

```tsx
import ReportBody, { NoSales } from './ReportBody'
import ReportTable from './ReportTable'
import { columnsFor, type Column } from './columns'
import { csvFileName } from './csv'
import { rateLabel } from './reportView'
import { fetchSstReport, type ReportQuery, type SstMonth } from './reportsApi'
import { useReport } from './useReport'

interface RateRow {
  label: string
  baseSen: number
  sstSen: number | null
}

const c = columnsFor<RateRow>()
const RATE_COLUMNS = [c.text('Rate', (r) => r.label), c.money('Taxable', (r) => r.baseSen), c.money('SST', (r) => r.sstSen)]

/** One row per month: taxable and SST at every rate seen in the range, then exempt (for SST-02). */
function monthColumns(rates: number[]): Column<SstMonth>[] {
  const m = columnsFor<SstMonth>()
  return [
    m.text('Month', (r) => r.month),
    ...rates.flatMap((bp) => [
      m.money(`Taxable ${rateLabel(bp)}`, (r) => r.rates.find((x) => x.rateBp === bp)?.baseSen ?? 0),
      m.money(`SST ${rateLabel(bp)}`, (r) => r.rates.find((x) => x.rateBp === bp)?.sstSen ?? 0),
    ]),
    m.money('Exempt', (r) => r.exemptSen),
  ]
}

/** Spec §5.7: SST as charged on the bills, per rate and per month; refunds are listed apart. */
export default function SstTab({ query }: { query: ReportQuery }) {
  const { load, retry } = useReport(fetchSstReport, query)
  const file = (name: string) => csvFileName(name, query.from, query.to)
  return (
    <ReportBody load={load} retry={retry}>
      {(r) => {
        if (r.rates.length === 0 && r.exemptSen === 0) return <NoSales />
        const rows: RateRow[] = [
          ...r.rates.map((x) => ({ label: `SST ${rateLabel(x.rateBp)}`, baseSen: x.baseSen, sstSen: x.sstSen })),
          { label: 'Exempt (0%)', baseSen: r.exemptSen, sstSen: null },
        ]
        const rates = [...new Set(r.months.flatMap((m) => m.rates.map((x) => x.rateBp)))].sort((x, y) => x - y)
        return (
          <div className="space-y-4">
            <ReportTable title="SST by rate" columns={RATE_COLUMNS} rows={rows} fileName={file('sst-by-rate')} />
            <ReportTable title="SST by month" columns={monthColumns(rates)} rows={r.months} fileName={file('sst-by-month')} />
            <p className="text-xs text-brown-muted">
              SST as charged on the bills. Service charge carries no SST. Refunds are not taken off (see Refunds).
            </p>
          </div>
        )
      }}
    </ReportBody>
  )
}
```

- [ ] **Step 4: Show the six tabs on the page**

In `src/features/pos/reports/ReportsPage.tsx`, replace the line `import OverviewTab from './OverviewTab'` with:

```tsx
import DailyTab from './DailyTab'
import HourlyTab from './HourlyTab'
import OverviewTab from './OverviewTab'
import PaymentsTab from './PaymentsTab'
import ProductsTab from './ProductsTab'
import SstTab from './SstTab'
import SummaryTab from './SummaryTab'
```

and replace the whole `function TabBody(…) { … }` with:

```tsx
function TabBody({ tab, query }: { tab: ReportTab; query: ReportQuery }) {
  switch (tab) {
    case 'overview': return <OverviewTab query={query} />
    case 'summary': return <SummaryTab query={query} />
    case 'daily': return <DailyTab query={query} />
    case 'hourly': return <HourlyTab query={query} />
    case 'products': return <ProductsTab query={query} />
    case 'payments': return <PaymentsTab query={query} />
    case 'sst': return <SstTab query={query} />
    default: return null
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/features/pos/reports`
Expected: PASS (all files of the folder, `ReportsPage.test.tsx` included).

Run: `npx tsc -b`
Expected: exits 0, no output.

- [ ] **Step 6: Commit**

```bash
git add src/features/pos/reports/SummaryTab.tsx src/features/pos/reports/DailyTab.tsx src/features/pos/reports/HourlyTab.tsx \
        src/features/pos/reports/ProductsTab.tsx src/features/pos/reports/PaymentsTab.tsx src/features/pos/reports/SstTab.tsx \
        src/features/pos/reports/salesTabs.test.tsx src/features/pos/reports/ReportsPage.tsx
git commit -m "$(cat <<'EOF'
feat(pos): W3 reports — Sales summary, Daily, Hourly, Products, Payments and SST tabs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Client — Discounts, Voids, Refunds, Cash drawer and Ledger export tabs

**Files:**
- Create: `src/features/pos/reports/ledgerCsv.ts`, `src/features/pos/reports/ledgerCsv.test.ts`
- Create: `src/features/pos/reports/DiscountsTab.tsx`, `VoidsTab.tsx`, `RefundsTab.tsx`, `DrawerTab.tsx`, `LedgerTab.tsx` (all in `src/features/pos/reports/`)
- Test: `src/features/pos/reports/auditTabs.test.tsx`
- Modify: `src/features/pos/reports/ReportsPage.tsx` (imports; `TabBody`), `src/features/pos/reports/ReportsPage.test.tsx` (one test)

**Interfaces:**
- Consumes: Task 5 (`fetchAuditReport`, `fetchDrawerReport`, `fetchLedgerReport`, their row types; fixtures `Q`, `AUDIT`, `EMPTY_AUDIT`, `DRAWER`, `LEDGER`), Task 6 (`useReport`, `ReportBody`, `NoSales`, `ReportTable`), Task 4 (`columnsFor`, `tableCsv`, `csvFileName`, `downloadCsv`, `reportTime`, `discountValueText`, `DISCOUNT_ACTION_LABELS`, `ORDER_TYPE_LABELS`, `TABS`).
- Produces: `billsCsv(rows: LedgerBill[]): string`, `linesCsv(rows: LedgerLine[]): string`, `paymentsCsv(rows: LedgerPayment[]): string`; default exports `DiscountsTab`, `VoidsTab`, `RefundsTab`, `DrawerTab`, `LedgerTab`, each `({ query }: { query: ReportQuery })`. CSV names: `discounts`, `discount-totals`, `voided-items`, `voided-bills`, `refunds`, `cash-drawer`, and the ledger's `bills`, `lines`, `payments` (`<name>_<from>_<to>.csv`).

- [ ] **Step 1: Write the failing tests**

Create `src/features/pos/reports/ledgerCsv.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { billsCsv, linesCsv, paymentsCsv } from './ledgerCsv'
import { LEDGER } from './testReports'

describe('the ledger export (spec §5.12)', () => {
  it('bills.csv: one row per paid bill', () => {
    expect(billsCsv(LEDGER.bills)).toBe(
      '﻿Outlet,Business date,Closed at,Bill no,Order type,Table,Pax,Gross,Discounts,Takeaway fee,Service charge,SST,Rounding,Total,Refunded\r\n'
      + 'Cheras,2026-01-05,2026-01-05 12:00,CH-0001,Dine-in,T1,2,20.00,0.80,0.00,0.00,1.18,0.02,20.40,0.00\r\n'
      + 'Cheras,2026-01-06,2026-01-06 10:00,CH-0003,Takeaway,,,28.40,0.00,0.00,0.00,2.27,-0.02,30.65,3.00\r\n')
  })
  it('lines.csv: one row per live line, its SST share', () => {
    expect(linesCsv(LEDGER.lines)).toBe(
      '﻿Outlet,Bill no,Item,Qty,Unit price,Catalog discount,Item discount,Bill discount share,Net,SST rate (%),SST\r\n'
      + 'Cheras,CH-0001,Cake,1,8.00,0.00,0.80,0.00,7.20,8,0.58\r\n'
      + 'Cheras,CH-0003,"Muffin, large",1,10.20,0.00,0.00,0.00,10.20,8,0.82\r\n')
  })
  it('payments.csv: one row per payment, the part number of a part payment', () => {
    expect(paymentsCsv(LEDGER.payments)).toBe(
      '﻿Outlet,Bill no,Part no,Method,Kind,Amount,Tendered,Change,Reference,Taken at\r\n'
      + 'Cheras,CH-0003,,Cash,cash,30.65,50.00,19.35,,2026-01-06 10:00\r\n'
      + 'Cheras,CH-0005,1,Card,card,10.00,,0.00,APP 123,2026-01-06 13:50\r\n')
  })
})
```

Create `src/features/pos/reports/auditTabs.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { AUDIT, DRAWER, EMPTY_AUDIT, LEDGER, Q } from './testReports'

const h = vi.hoisted(() => ({ audit: vi.fn(), drawer: vi.fn(), ledger: vi.fn(), download: vi.fn() }))
vi.mock('./reportsApi', () => ({
  fetchAuditReport: (q: unknown) => h.audit(q),
  fetchDrawerReport: (q: unknown) => h.drawer(q),
  fetchLedgerReport: (q: unknown) => h.ledger(q),
}))
vi.mock('./csv', async (importOriginal) => ({ ...(await importOriginal<typeof import('./csv')>()), downloadCsv: h.download }))

import DiscountsTab from './DiscountsTab'
import DrawerTab from './DrawerTab'
import LedgerTab from './LedgerTab'
import RefundsTab from './RefundsTab'
import VoidsTab from './VoidsTab'
import { billsCsv, linesCsv } from './ledgerCsv'

const settle = async () => {
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
const section = (title: string) => screen.getByRole('heading', { name: title }).closest('section') as HTMLElement
const bodyRows = (table: HTMLElement) =>
  [...table.querySelectorAll('tbody tr')].map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent ?? ''))

beforeEach(() => {
  h.audit.mockReset().mockResolvedValue(AUDIT)
  h.drawer.mockReset().mockResolvedValue(DRAWER)
  h.ledger.mockReset().mockResolvedValue(LEDGER)
  h.download.mockReset()
})
afterEach(cleanup)

describe('DiscountsTab', () => {
  it('every discount set and cleared, Malaysia time; the totals by kind', async () => {
    render(<DiscountsTab query={Q} />)
    await settle()
    const log = bodyRows(section('Discounts'))
    expect(log).toHaveLength(4)
    expect(log[1]).toEqual(['5 Jan 2026, 11:45', 'Cheras', 'CH-0001', 'Bill', 'Cleared', 'RM 1.00', 'Regular', 'Aina', '—'])
    expect(log[2]).toEqual(['5 Jan 2026, 11:50', 'Cheras', 'CH-0001', 'Cake', 'Set', '10%', 'Regular', 'Aina', 'Ben'])
    expect(bodyRows(section('Discount totals'))).toEqual([
      ['Staff Meal', '0', 'RM 0.00'], ['Item discounts', '1', 'RM 0.80'], ['Bill discounts', '1', 'RM 2.00'],
    ])
  })
  it('none in the range: says so', async () => {
    h.audit.mockResolvedValue(EMPTY_AUDIT)
    render(<DiscountsTab query={Q} />)
    await settle()
    expect(within(section('Discounts')).getByText('No discounts in this range.')).toBeTruthy()
  })
})

describe('VoidsTab', () => {
  it('voided items and voided bills', async () => {
    render(<VoidsTab query={Q} />)
    await settle()
    expect(bodyRows(section('Voided items'))[0])
      .toEqual(['5 Jan 2026, 13:00', 'Cheras', 'CH-0002', 'Water', '1', 'RM 2.00', 'Wrong item keyed', 'Aina', 'Ben'])
    expect(bodyRows(section('Voided bills')))
      .toEqual([['6 Jan 2026, 15:00', 'Cheras', 'CH-0008', 'RM 2.00', 'Guest left', 'Aina', 'Ben']])
  })
  it('none: says so for each', async () => {
    h.audit.mockResolvedValue(EMPTY_AUDIT)
    render(<VoidsTab query={Q} />)
    await settle()
    expect(within(section('Voided items')).getByText('No voided items in this range.')).toBeTruthy()
    expect(within(section('Voided bills')).getByText('No voided bills in this range.')).toBeTruthy()
  })
})

describe('RefundsTab', () => {
  it('time, bill, method, amount, reason, approved by', async () => {
    render(<RefundsTab query={Q} />)
    await settle()
    expect(bodyRows(section('Refunds'))).toEqual([['6 Jan 2026, 10:30', 'Cheras', 'CH-0003', 'Cash', 'RM 3.00', 'Cold cake', 'Ben']])
  })
  it('none: says so', async () => {
    h.audit.mockResolvedValue(EMPTY_AUDIT)
    render(<RefundsTab query={Q} />)
    await settle()
    expect(screen.getByText('No refunds in this range.')).toBeTruthy()
  })
})

describe('DrawerTab', () => {
  it('one row per shift; a shift still open says so', async () => {
    render(<DrawerTab query={Q} />)
    await settle()
    expect(bodyRows(section('Cash drawer'))).toEqual([
      ['Cheras', '6 Jan 2026, 08:00', '6 Jan 2026, 22:00', 'Aina', 'Aina', 'RM 100.00', 'RM 39.90', 'RM 3.00', 'RM 20.00',
       'RM 5.00', 'RM 151.90', 'RM 151.50', 'RM -0.40', 'Short at close'],
      ['Cheras', '6 Jan 2026, 20:00', 'Still open', 'Aina', '—', 'RM 100.00', 'RM 19.10', 'RM 0.00', 'RM 0.00',
       'RM 0.00', 'RM 119.10', '—', '—', '—'],
    ])
  })
  it('none: says so', async () => {
    h.drawer.mockResolvedValue({ shifts: [] })
    render(<DrawerTab query={Q} />)
    await settle()
    expect(screen.getByText('No shifts in this range.')).toBeTruthy()
  })
})

describe('LedgerTab', () => {
  it('three files for the range, each with its row count', async () => {
    render(<LedgerTab query={Q} />)
    await settle()
    expect(screen.getByText('bills.csv').parentElement?.textContent).toContain('2 rows')
    fireEvent.click(screen.getByRole('button', { name: 'Download lines.csv' }))
    expect(h.download).toHaveBeenLastCalledWith('lines_2026-01-05_2026-01-06.csv', linesCsv(LEDGER.lines))
    fireEvent.click(screen.getByRole('button', { name: 'Download bills.csv' }))
    expect(h.download).toHaveBeenLastCalledWith('bills_2026-01-05_2026-01-06.csv', billsCsv(LEDGER.bills))
    expect(screen.getByRole('button', { name: 'Download payments.csv' })).toBeTruthy()
  })
  it('no paid bills: No sales in this range.', async () => {
    h.ledger.mockResolvedValue({ bills: [], lines: [], payments: [] })
    render(<LedgerTab query={Q} />)
    await settle()
    expect(screen.getByText('No sales in this range.')).toBeTruthy()
  })
})
```

In `src/features/pos/reports/ReportsPage.test.tsx`, add `import { TABS } from './reportRange'` after the `import ReportsPage from './ReportsPage'` line, and add this test at the end of `describe('ReportsPage', …)`:

```tsx
  it('every tab opens and reads its own report', async () => {
    renderAt('/pos/reports?outlets=b1&from=2026-01-05&to=2026-01-06')
    await settle()
    for (const t of TABS) {
      fireEvent.click(screen.getByRole('tab', { name: t.label }))
      await settle()
      expect(screen.getByRole('tab', { name: t.label }).getAttribute('aria-selected')).toBe('true')
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.getByRole('tabpanel').textContent).not.toBe('')
    }
    const q = { outlets: ['b1'], from: '2026-01-05', to: '2026-01-06' }
    for (const f of [h.sales, h.products, h.payments, h.sst, h.audit, h.drawer, h.ledger]) expect(f).toHaveBeenCalledWith(q)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/pos/reports/ledgerCsv.test.ts src/features/pos/reports/auditTabs.test.tsx src/features/pos/reports/ReportsPage.test.tsx`
Expected: FAIL — `Failed to resolve import "./ledgerCsv"` and `"./DiscountsTab"`; in `ReportsPage.test.tsx` the new test fails at the Discounts tab (empty tab panel).

- [ ] **Step 3: Write `ledgerCsv.ts` and the five tabs**

Create `src/features/pos/reports/ledgerCsv.ts`:

```ts
// The ledger export (spec §5.12): three CSV files for the accountant and the future Accounting module.
// Outlet first in every file (bill numbers are unique per outlet only); money in ringgit, times in
// Malaysia time, SST rate in percent.
import { columnsFor, tableCsv } from './columns'
import { ORDER_TYPE_LABELS } from './reportView'
import type { LedgerBill, LedgerLine, LedgerPayment } from './reportsApi'

const b = columnsFor<LedgerBill>()
const BILL_COLUMNS = [
  b.text('Outlet', (r) => r.outlet), b.day('Business date', (r) => r.businessDate), b.time('Closed at', (r) => r.closedAt),
  b.text('Bill no', (r) => r.billNo), b.text('Order type', (r) => ORDER_TYPE_LABELS[r.orderType] ?? r.orderType),
  b.text('Table', (r) => r.table), b.count('Pax', (r) => r.pax), b.money('Gross', (r) => r.grossSen),
  b.money('Discounts', (r) => r.discountSen), b.money('Takeaway fee', (r) => r.takeawayFeeSen),
  b.money('Service charge', (r) => r.serviceChargeSen), b.money('SST', (r) => r.sstSen), b.money('Rounding', (r) => r.roundingSen),
  b.money('Total', (r) => r.totalSen), b.money('Refunded', (r) => r.refundedSen),
]

const l = columnsFor<LedgerLine>()
const LINE_COLUMNS = [
  l.text('Outlet', (r) => r.outlet), l.text('Bill no', (r) => r.billNo), l.text('Item', (r) => r.item), l.count('Qty', (r) => r.qty),
  l.money('Unit price', (r) => r.unitPriceSen), l.money('Catalog discount', (r) => r.catalogDiscountSen),
  l.money('Item discount', (r) => r.itemDiscountSen), l.money('Bill discount share', (r) => r.billShareSen),
  l.money('Net', (r) => r.netSen), l.count('SST rate (%)', (r) => r.sstRateBp / 100), l.money('SST', (r) => r.sstSen),
]

const p = columnsFor<LedgerPayment>()
const PAYMENT_COLUMNS = [
  p.text('Outlet', (r) => r.outlet), p.text('Bill no', (r) => r.billNo), p.count('Part no', (r) => r.partNo),
  p.text('Method', (r) => r.method), p.text('Kind', (r) => r.kind), p.money('Amount', (r) => r.amountSen),
  p.money('Tendered', (r) => r.tenderedSen), p.money('Change', (r) => r.changeSen), p.text('Reference', (r) => r.reference),
  p.time('Taken at', (r) => r.takenAt),
]

export const billsCsv = (rows: LedgerBill[]): string => tableCsv(BILL_COLUMNS, rows)
export const linesCsv = (rows: LedgerLine[]): string => tableCsv(LINE_COLUMNS, rows)
export const paymentsCsv = (rows: LedgerPayment[]): string => tableCsv(PAYMENT_COLUMNS, rows)
```

Create `src/features/pos/reports/DiscountsTab.tsx`:

```tsx
import ReportBody from './ReportBody'
import ReportTable from './ReportTable'
import { columnsFor } from './columns'
import { csvFileName } from './csv'
import { DISCOUNT_ACTION_LABELS, discountValueText } from './reportView'
import { fetchAuditReport, type DiscountLogRow, type DiscountTotals, type ReportQuery } from './reportsApi'
import { useReport } from './useReport'

const d = columnsFor<DiscountLogRow>()
const LOG_COLUMNS = [
  d.time('Time', (r) => r.at), d.text('Outlet', (r) => r.outlet), d.text('Bill', (r) => r.billNo),
  d.text('On', (r) => r.item ?? 'Bill'), d.text('Action', (r) => DISCOUNT_ACTION_LABELS[r.action] ?? r.action),
  d.text('Discount', (r) => discountValueText(r.kind, r.value)), d.text('Reason', (r) => r.reason),
  d.text('By', (r) => r.by), d.text('Approved by', (r) => r.approvedBy),
]

interface TotalRow {
  label: string
  count: number
  sen: number
}
const t = columnsFor<TotalRow>()
const TOTAL_COLUMNS = [t.text('Kind', (r) => r.label), t.count('Count', (r) => r.count), t.money('Amount', (r) => r.sen)]
const totalRows = (x: DiscountTotals): TotalRow[] => [
  { label: 'Staff Meal', count: x.catalogBills, sen: x.catalogSen },
  { label: 'Item discounts', count: x.itemCount, sen: x.itemSen },
  { label: 'Bill discounts', count: x.billCount, sen: x.billSen },
]

/** Spec §5.8: every discount set and cleared (pos_discount_log), and the discount totals of the bills sold. */
export default function DiscountsTab({ query }: { query: ReportQuery }) {
  const { load, retry } = useReport(fetchAuditReport, query)
  const file = (name: string) => csvFileName(name, query.from, query.to)
  return (
    <ReportBody load={load} retry={retry}>
      {(r) => (
        <div className="space-y-4">
          <ReportTable title="Discounts" columns={LOG_COLUMNS} rows={r.discounts} fileName={file('discounts')}
                       empty="No discounts in this range." />
          <ReportTable title="Discount totals" columns={TOTAL_COLUMNS} rows={totalRows(r.discountTotals)} fileName={file('discount-totals')} />
          <p className="text-xs text-brown-muted">
            Staff Meal and bill discounts count bills; item discounts count lines. A cleared discount shows what was cleared.
          </p>
        </div>
      )}
    </ReportBody>
  )
}
```

Create `src/features/pos/reports/VoidsTab.tsx`:

```tsx
import ReportBody from './ReportBody'
import ReportTable from './ReportTable'
import { columnsFor } from './columns'
import { csvFileName } from './csv'
import { fetchAuditReport, type ReportQuery, type VoidBillRow, type VoidItemRow } from './reportsApi'
import { useReport } from './useReport'

const i = columnsFor<VoidItemRow>()
const ITEM_COLUMNS = [
  i.time('Time', (r) => r.at), i.text('Outlet', (r) => r.outlet), i.text('Bill', (r) => r.billNo), i.text('Item', (r) => r.name),
  i.count('Qty', (r) => r.qty), i.money('Value', (r) => r.valueSen), i.text('Reason', (r) => r.reason),
  i.text('By', (r) => r.by), i.text('Approved by', (r) => r.approvedBy),
]
const b = columnsFor<VoidBillRow>()
const BILL_COLUMNS = [
  b.time('Time', (r) => r.at), b.text('Outlet', (r) => r.outlet), b.text('Bill', (r) => r.billNo),
  b.money('Value', (r) => r.valueSen), b.text('Reason', (r) => r.reason), b.text('By', (r) => r.by),
  b.text('Approved by', (r) => r.approvedBy),
]

/** Spec §5.9: voided items (a voided bill's items too) and voided bills. */
export default function VoidsTab({ query }: { query: ReportQuery }) {
  const { load, retry } = useReport(fetchAuditReport, query)
  const file = (name: string) => csvFileName(name, query.from, query.to)
  return (
    <ReportBody load={load} retry={retry}>
      {(r) => (
        <div className="space-y-4">
          <ReportTable title="Voided items" columns={ITEM_COLUMNS} rows={r.voidItems} fileName={file('voided-items')}
                       empty="No voided items in this range." />
          <ReportTable title="Voided bills" columns={BILL_COLUMNS} rows={r.voidBills} fileName={file('voided-bills')}
                       empty="No voided bills in this range." />
        </div>
      )}
    </ReportBody>
  )
}
```

Create `src/features/pos/reports/RefundsTab.tsx`:

```tsx
import ReportBody from './ReportBody'
import ReportTable from './ReportTable'
import { columnsFor } from './columns'
import { csvFileName } from './csv'
import { fetchAuditReport, type RefundRow, type ReportQuery } from './reportsApi'
import { useReport } from './useReport'

const c = columnsFor<RefundRow>()
const COLUMNS = [
  c.time('Time', (r) => r.at), c.text('Outlet', (r) => r.outlet), c.text('Bill', (r) => r.billNo),
  c.text('Method', (r) => r.method), c.money('Amount', (r) => r.amountSen), c.text('Reason', (r) => r.reason),
  c.text('Approved by', (r) => r.approvedBy),
]

/** Spec §5.10: refunds, listed apart — never taken out of sales or SST. */
export default function RefundsTab({ query }: { query: ReportQuery }) {
  const { load, retry } = useReport(fetchAuditReport, query)
  return (
    <ReportBody load={load} retry={retry}>
      {(r) => (
        <div className="space-y-2">
          <ReportTable title="Refunds" columns={COLUMNS} rows={r.refunds} fileName={csvFileName('refunds', query.from, query.to)}
                       empty="No refunds in this range." />
          <p className="text-xs text-brown-muted">Refunds carry an amount and a method only; they are not taken out of sales or SST.</p>
        </div>
      )}
    </ReportBody>
  )
}
```

Create `src/features/pos/reports/DrawerTab.tsx`:

```tsx
import ReportBody from './ReportBody'
import ReportTable from './ReportTable'
import { columnsFor } from './columns'
import { csvFileName } from './csv'
import { fetchDrawerReport, type DrawerRow, type ReportQuery } from './reportsApi'
import { useReport } from './useReport'

const c = columnsFor<DrawerRow>()
const COLUMNS = [
  c.text('Outlet', (r) => r.outlet), c.time('Opened', (r) => r.openedAt), c.time('Closed', (r) => r.closedAt, 'Still open'),
  c.text('Opened by', (r) => r.openedBy), c.text('Closed by', (r) => r.closedBy), c.money('Float', (r) => r.floatSen),
  c.money('Cash sales', (r) => r.cashSalesSen), c.money('Cash refunds', (r) => r.cashRefundSen), c.money('Pay in', (r) => r.payInSen),
  c.money('Pay out', (r) => r.payOutSen), c.money('Expected', (r) => r.expectedSen), c.money('Counted', (r) => r.countedSen),
  c.money('Variance', (r) => r.varianceSen), c.text('Reason', (r) => r.reason),
]

/** Spec §5.11: one row per shift whose close (or open, for a shift still open) falls in the range. */
export default function DrawerTab({ query }: { query: ReportQuery }) {
  const { load, retry } = useReport(fetchDrawerReport, query)
  return (
    <ReportBody load={load} retry={retry}>
      {(r) => (
        <ReportTable title="Cash drawer" columns={COLUMNS} rows={r.shifts} fileName={csvFileName('cash-drawer', query.from, query.to)}
                     empty="No shifts in this range." />
      )}
    </ReportBody>
  )
}
```

Create `src/features/pos/reports/LedgerTab.tsx`:

```tsx
import ReportBody, { NoSales } from './ReportBody'
import { csvFileName, downloadCsv } from './csv'
import { billsCsv, linesCsv, paymentsCsv } from './ledgerCsv'
import { fetchLedgerReport, type ReportQuery } from './reportsApi'
import { useReport } from './useReport'

/** Spec §5.12: bills.csv, lines.csv and payments.csv for the range. */
export default function LedgerTab({ query }: { query: ReportQuery }) {
  const { load, retry } = useReport(fetchLedgerReport, query)
  return (
    <ReportBody load={load} retry={retry}>
      {(r) => {
        if (r.bills.length === 0) return <NoSales />
        const files = [
          { name: 'bills.csv', rows: r.bills.length, save: () => downloadCsv(csvFileName('bills', query.from, query.to), billsCsv(r.bills)) },
          { name: 'lines.csv', rows: r.lines.length, save: () => downloadCsv(csvFileName('lines', query.from, query.to), linesCsv(r.lines)) },
          { name: 'payments.csv', rows: r.payments.length,
            save: () => downloadCsv(csvFileName('payments', query.from, query.to), paymentsCsv(r.payments)) },
        ]
        return (
          <section className="rounded-xl border border-border bg-card p-4">
            <h2 className="font-semibold">Ledger export</h2>
            <p className="text-xs text-brown-muted">
              For the accountant: one row per paid bill, per line (with its share of the bill's SST) and per payment.
              Refunds are in the Refunds tab.
            </p>
            <ul className="mt-3 space-y-2 text-sm">
              {files.map((f) => (
                <li key={f.name} className="flex items-center gap-3">
                  <span className="w-28 font-mono">{f.name}</span>
                  <span className="text-brown-muted">{f.rows} rows</span>
                  <button type="button" onClick={f.save} className="text-xs underline">Download {f.name}</button>
                </li>
              ))}
            </ul>
          </section>
        )
      }}
    </ReportBody>
  )
}
```

- [ ] **Step 4: Show the five tabs on the page**

In `src/features/pos/reports/ReportsPage.tsx`, replace the import block of the tabs (from `import DailyTab from './DailyTab'` to `import SummaryTab from './SummaryTab'`) with:

```tsx
import DailyTab from './DailyTab'
import DiscountsTab from './DiscountsTab'
import DrawerTab from './DrawerTab'
import HourlyTab from './HourlyTab'
import LedgerTab from './LedgerTab'
import OverviewTab from './OverviewTab'
import PaymentsTab from './PaymentsTab'
import ProductsTab from './ProductsTab'
import RefundsTab from './RefundsTab'
import SstTab from './SstTab'
import SummaryTab from './SummaryTab'
import VoidsTab from './VoidsTab'
```

and replace the whole `function TabBody(…) { … }` with:

```tsx
function TabBody({ tab, query }: { tab: ReportTab; query: ReportQuery }) {
  switch (tab) {
    case 'overview': return <OverviewTab query={query} />
    case 'summary': return <SummaryTab query={query} />
    case 'daily': return <DailyTab query={query} />
    case 'hourly': return <HourlyTab query={query} />
    case 'products': return <ProductsTab query={query} />
    case 'payments': return <PaymentsTab query={query} />
    case 'sst': return <SstTab query={query} />
    case 'discounts': return <DiscountsTab query={query} />
    case 'voids': return <VoidsTab query={query} />
    case 'refunds': return <RefundsTab query={query} />
    case 'drawer': return <DrawerTab query={query} />
    case 'ledger': return <LedgerTab query={query} />
  }
}
```

- [ ] **Step 5: Run the tests, the type check and both builds**

Run: `npx vitest run src/features/pos/reports src/shared/lib/nav.test.ts src/features/pos/sqlSafeUpdate.test.ts`
Expected: PASS.

Run: `npx vitest run`
Expected: every test passes.

Run: `npx tsc -b` then `npm run build` then `npm run build:pos`
Expected: `tsc -b` exits 0; both builds succeed.

- [ ] **Step 6: Commit**

```bash
git add src/features/pos/reports/ledgerCsv.ts src/features/pos/reports/ledgerCsv.test.ts \
        src/features/pos/reports/DiscountsTab.tsx src/features/pos/reports/VoidsTab.tsx src/features/pos/reports/RefundsTab.tsx \
        src/features/pos/reports/DrawerTab.tsx src/features/pos/reports/LedgerTab.tsx src/features/pos/reports/auditTabs.test.tsx \
        src/features/pos/reports/ReportsPage.tsx src/features/pos/reports/ReportsPage.test.tsx
git commit -m "$(cat <<'EOF'
feat(pos): W3 reports — Discounts, Voids, Refunds, Cash drawer and the three-file ledger export

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Dev SQL, browser check and docs (controller)

Run by the controller, not an implementer. A fix found here goes back to the task that owns the file, with its own commit, and this task starts again from Step 1.

**Files:**
- Modify: `docs/pos/2026-10-29-feedme-replacement-readiness.md` (§2 W3; §4 the rollout chain)

**Interfaces:**
- Consumes: everything above; the dev SQL how-to `/private/tmp/claude-502/-Users-USER-Desktop-Craft-OS/61468934-8271-4d57-a865-7622f45e3055/scratchpad/dev-sql-howto.md` (Supabase SQL editor in the owner's Chrome, project `egznnbjmicebbhwasloy` only).
- Produces: the migration live on craft-os-dev, a `VERIFY OK`, a browser-checked page, the docs, the branch pushed.

- [ ] **Step 1: Full test run, type check and both builds**

Run: `npx vitest run`, then `npx tsc -b`, then `npm run build`, then `npm run build:pos`
Expected: every test passes; `tsc -b` exits 0; both builds succeed.

- [ ] **Step 2: Run the migration on craft-os-dev**

Follow the dev SQL how-to. Check the editor URL holds `egznnbjmicebbhwasloy` (never `yfsoesxzurzjdwstszru`), load `supabase/migration-2026-11-18-pos-reports.sql` into the editor, Run.
Expected: one result row `pos reports applied`. A `STOP: run migration-2026-11-17-menu-picks.sql first …` means dev lacks the chain: stop and report.

- [ ] **Step 3: Run the verify on craft-os-dev**

Load `supabase/migration-2026-11-18-pos-reports-verify.sql`, Run.
Expected: one result row `VERIFY OK` (everything rolled back). An `ERROR: FAIL <section> …` names the failing check: fix the SQL in the owning task's file (Task 1, 2 or 3), commit, re-run Step 2 and this step.

- [ ] **Step 4: Start this worktree's dev server against craft-os-dev**

Start the `craft-os-dev` entry of **this worktree's** `.claude/launch.json` (`npm run dev` in `/Users/USER/Desktop/Craft_OS/.claude/worktrees/pos-demo`; its `.env.local` points to `egznnbjmicebbhwasloy`). Never use the main checkout's dev server. In the browser check that a network request's host is `egznnbjmicebbhwasloy.supabase.co`; stop if it is `yfsoesxzurzjdwstszru`.

- [ ] **Step 5: Browser — every tab on the Demo outlet**

Signed in as the dev test login (owner), open the sidebar: POS shows Register, **Reports**, Menu, POS Settings, Devices; Reports lights up on `/pos/reports`. On the page:
1. Filter: all outlets ticked (HQ); untick all but **Demo** → the URL holds `outlets=<Demo id>`; choose **This week** → `from`/`to` are this Monday–Sunday; reload the page → the same filter and tab come back.
2. **Overview**: the cards show this week's numbers with a change against last week (`—` where last week is 0); the daily bars have seven columns; the hourly bars 24; Top 10 products lists this week's test items.
3. **Sales summary**: the lines add up (Gross before discounts − discounts = Gross sales; + charges + rounding = Nett sales, equal to the Overview's Nett sales); order types and sources show.
4. **Daily sales** and **Hourly sales**: the Nett column adds up to the Overview's Nett sales.
5. **Products**: Add-ons and Categories under it. **Payments**: the Amount column adds up to Nett sales. **SST**: per rate, Exempt, and one row per month.
6. **Discounts**, **Voids**, **Refunds**: this week's test discounts, voids and refunds (or their empty words). **Cash drawer**: this week's shifts; an open shift reads `Still open`.
7. **Ledger export**: the three Download buttons save `bills_…csv`, `lines_…csv`, `payments_…csv`; open each in a spreadsheet app: the columns are named, ringgit has two decimals, dates are `YYYY-MM-DD`; in `lines.csv` the SST of one bill's lines adds up to that bill's SST in `bills.csv`.
8. One **Download CSV** of any other tab opens cleanly too (no garbled characters).
9. **Custom**: from 1 Jan 2025 to today → `Choose at most 366 days.` and nothing changes; untick the last outlet → `Choose at least one outlet.`
10. Errors: in DevTools block the request URL `rpc/pos_report_sales`, reload → Overview shows `Could not load the report: …` with Retry; unblock, Retry → the cards come back.

Take one screenshot of Overview and one of the SST tab for the owner.

- [ ] **Step 6: Docs — the rollout chain and W3**

In `docs/pos/2026-10-29-feedme-replacement-readiness.md` §4, replace:

```
      (`migration-2026-11-16-pos-split-bill.sql`) → bill parts (`migration-2026-11-17-pos-bill-parts.sql`) → menu
      picks (`migration-2026-11-17-menu-picks.sql`, which drops and re-creates `pos_picks_rules()` on a re-run)),
      each with its `-verify.sql`, after the prod menu import.
```

with:

```
      (`migration-2026-11-16-pos-split-bill.sql`) → bill parts (`migration-2026-11-17-pos-bill-parts.sql`) → menu
      picks (`migration-2026-11-17-menu-picks.sql`, which drops and re-creates `pos_picks_rules()` on a re-run) → sales
      reports (`migration-2026-11-18-pos-reports.sql`)), each with its `-verify.sql`, after the prod menu import.
```

In §2, replace:

```
- [ ] **W3 Sales reports** — at least: daily sales, hourly sales, product and add-on sales, category sales, payment
      methods, discounts, voids, refunds, cash drawer, SST by rate (6% / 8% / exempt), per outlet and date range.
```

with:

```
- [x] **W3 Sales reports** — at least: daily sales, hourly sales, product and add-on sales, category sales, payment
      methods, discounts, voids, refunds, cash drawer, SST by rate (6% / 8% / exempt), per outlet and date range.
      Built on dev 2026-11-18 (plan docs/superpowers/plans/2026-11-18-pos-sales-reports.md): Craft OS → POS → Reports,
      twelve tabs over business days of 06:00–05:59, CSV on every table and a three-file ledger export (bills, lines,
      payments); prod runs with the POS chain (step 4).
```

- [ ] **Step 7: Commit and push**

```bash
git add docs/pos/2026-10-29-feedme-replacement-readiness.md
git commit -m "$(cat <<'EOF'
docs(pos): W3 sales reports live on dev — rollout chain and readiness

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
git push origin feature/pos-demo
```

Expected: the push succeeds. Report: the test count, both builds, `pos reports applied` and `VERIFY OK` on dev, the browser checks 1–10, the two screenshots. Prod is untouched (the migration runs there with the POS chain).

---

## Self-review

**Spec coverage**

| Spec | Task |
|---|---|
| §1 goal; out of scope (inventory, members, vouchers, delivery, KDS, email, templates, refunds apportioned) | 1–8; nothing out of scope is built |
| §2 page `/pos/reports`, POS nav after Register, `access_settings`; outlets of `my_outlets()`; `pos_manages_outlet` on every outlet with the exact refusal; tablet Report menu unchanged | 6 (route, nav, sidebar); 1 (`pos_report_scope`, verify R1: manager of another outlet, mixed outlets, cashier, tablet session); no POS app file is touched |
| §3 outlets multi-select (home / HQ all); presets and Custom, ≤ 366 days; business day 06:00–05:59 on each record's own time; filter in the URL | 4 (`reportRange`), 6 (`FilterBar`, `ReportsPage`), 1 (`pos_business_day`, `pos_report_scope`); verify R1/R2 (01:30 → day before; 05:59 / 06:00 bounds); `reportRange.test.ts`, `ReportsPage.test.tsx` |
| §4 sales = paid bills, split part its own bill, voided / merged excluded; frozen totals; Nett = `total_sen`; refunds apart; line net from `totals.lines`; SST rate snapshot; today's category; add-ons from `modifiers_snapshot` | 1 (`pos_report_paid_bills`), 2 (`pos_report_lines`, products); verify R2–R3 (D' split part, G voided, refunds never subtracted) |
| §5 every table has Download CSV (BOM, comma, ringgit, `YYYY-MM-DD`) | 4 (`csv`, `columns`), 6 (`ReportTable`); `csv.test.ts`, `columns.test.ts`, `salesTabs.test.tsx` |
| §5.1 Overview: nine cards with change (`—` at 0), daily and hourly bars, top 10 | 1 (`current`/`previous`/`topProducts`), 6 (`OverviewTab`, `Bars`) |
| §5.2 Sales summary in Feedme's order; order types; sources (orders, item value) | 1, 7 (`SummaryTab`) |
| §5.3 Daily; §5.4 Hourly | 1, 7 (`DailyTab`, `HourlyTab`) |
| §5.5 Products, Add-ons, Categories | 2, 7 (`ProductsTab`) |
| §5.6 Payments per method, parts as payments | 2, 7 (`PaymentsTab`); verify R3 (E's part) |
| §5.7 SST per rate, Exempt, per month (SST-02); service charge untaxed | 2, 7 (`SstTab`) |
| §5.8 Discounts log + totals by kind; §5.9 voided items and bills; §5.10 refunds | 3, 8 (`DiscountsTab`, `VoidsTab`, `RefundsTab`) |
| §5.11 Cash drawer, by close (or open while open) | 3, 8 (`DrawerTab`); verify R4 (closed S1 and the open shift) |
| §5.12 Ledger: `bills.csv`, `lines.csv` (largest-remainder SST share), `payments.csv` | 3, 8 (`ledgerCsv`, `LedgerTab`); verify R4 (C's 64 / 82 / 81, every bill's lines add up) |
| §6 one migration + verify; `pos_report_scope` and the seven functions, `stable security definer`, authenticated only; index on `pos_discount_log(branch_id, created_at)`; after menu picks | 1–3; `sqlSafeUpdate.test.ts`; STOP guard; Task 9 rollout chain |
| §6 client files: `reportsApi`, `reportRange`, `csv`, `ReportsPage`, one component per tab, `Bars`; English; `formatSen` | 4–8 |
| §6 errors: each tab on its own, reason + Retry, plain words for no reply, `No sales in this range.` | 6 (`useReport`, `ReportBody`, `NoSales`); `OverviewTab.test.tsx` |
| §7 known limits shown | 7–8 notes under Products ("category today"), SST and Refunds |
| §8 verify SQL (two business days, 01:30 case, 6% / 8% / 0%, discount, void, refund, split part, part payment, shift, every report by hand, another outlet's manager refused); unit tests (presets, business day, previous period, CSV escaping, parsers, each tab from a fixture); browser on dev | 1–3 (verify), 4–8 (tests), 9 (browser) |

**Placeholder scan:** every code step carries its full code; no step says "add error handling" or "similar to"; the only open values are the dev ids looked up at run time in Task 9.

**Type consistency:** the JSON keys of Tasks 1–3 match the interfaces of Task 5 field for field (File Structure lists them once); `ReportQuery` is the one argument of every fetcher, `useReport` and every tab; `columnsFor` / `tableCsv` / `ReportTable` take `Column<R>` everywhere; the fixtures of `testReports.ts` are typed against Task 5, so a renamed field breaks `tsc -b`.
