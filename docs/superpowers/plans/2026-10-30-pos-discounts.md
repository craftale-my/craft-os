# POS Discounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Supervisor-approved item and bill discounts, and an automatic catalog discount (Staff Meal 50%), computed by the server and shown on the order screen, payment screen, transactions, receipt and Z report.

**Architecture:** Discounts are data — `menu_catalogs.discount_bp`, a snapshot on each `order_items` row, item-discount columns on `order_items`, bill-discount columns on `bills` — and `pos_compute_bill` (SQL) and `computeBill` (TypeScript) apply them in one fixed order, proven equal by shared vectors. Four RPCs set and clear discounts with the existing reason and PIN checks and write an append-only log. Screens, receipt and Z report read the extra totals fields.

**Tech Stack:** Supabase Postgres (plpgsql / sql functions, RLS), React + TypeScript + Vite, Vitest, Tailwind.

**Spec:** `docs/superpowers/specs/2026-10-30-pos-discounts-design.md`

## Global Constraints

- All money is integer sen; all rates and percents are basis points (`1000` = 10%). Percents are whole: item, bill and catalog percents are multiples of 100.
- Order of the money (spec "Money rules"): line amount → catalog discount `round(amount × bp / 10000)` → item discount (percent: `round(afterCatalog × bp / 10000)`; amount: `min(value, afterCatalog)`) → subtotal = Σ line nets → bill discount (percent: `round(subtotal × bp / 10000)`; amount: `min(value, subtotal)`) shared pro rata (floor, then leftover sen to the largest net first, ties to the earlier line, never below zero) → service charge on the shared-down nets → SST per rate on the shared-down nets plus the takeaway packaging fee → before rounding = subtotal − bill discount + service charge + SST + fee → 5-sen rounding. `round` is half-up on non-negative numbers.
- The packaging fee is never discounted. With no discounts every existing number stays the same.
- Supervisor PIN through `pos_check_approver`, reason through `pos_check_reason(branch, 'discount', reason)`. Removing a discount needs no PIN and is logged.
- Server words, exactly: `Only an open bill can be discounted` · `Discounts can only change on an open bill` · `A voided item cannot be discounted` · `Remove the bill discount before merging` · `Enter a whole percent from 1 to 100` · `Enter an amount above RM 0.00` · `Choose Amount or Percent` · `Enter a whole percent from 0 to 100` (catalog).
- Front-of-house RPCs use `pos_my_branch()` for the outlet and `pos_actor()` for who acts — never `auth.uid()`. Every `UPDATE` / `DELETE` has a `WHERE` (pg-safeupdate; `src/features/pos/sqlSafeUpdate.test.ts` scans every POS migration).
- SQL runs on **craft-os-dev only** (project ref `egznnbjmicebbhwasloy`). Check the ref in the SQL editor URL before every run. Never run any of it on prod (`yfsoesxzurzjdwstszru`).
- All UI copy in English. No reason or approver name on the printed receipt.
- Another session commits the POS app (Sub-plan C2) to `feature/pos-demo` at the same time. Before each task: `git log --oneline -3` and `git status`; touch only the files your task lists; never `git stash` bare; commit only your own paths.

## File map

| File | Change |
|---|---|
| `src/features/pos/checkout/bill.ts` | discount types, `discountOffSen`, `lineDiscounts`, `shareBillDiscount`, new `computeBill` |
| `src/features/pos/checkout/billVectors.json` | 23 vectors gain the new fields; 9 discount vectors added |
| `src/features/pos/checkout/bill.test.ts` | 32 vectors, verify-file pointer, unit tests |
| `supabase/migration-2026-10-30-pos-discounts.sql` | new: schema, trigger, log, checks, totals, RPCs, merge, receipt, Z report |
| `supabase/migration-2026-10-30-pos-discounts-verify.sql` | new: sections A–E |
| `src/features/pos/sqlSafeUpdate.test.ts` | new RPCs never use `auth.uid()` |
| `src/features/pos/print/receipt.ts` (+ test) | item discount rows, bill discount line |
| `src/features/pos/print/zreport.ts` (+ test) | Gross before discounts / Discounts lines, DISCOUNTS section |
| `src/features/pos/checkout/discounts.ts` (+ test) | parse, validate, labels, rows |
| `src/features/pos/checkout/DiscountRows.tsx` | grey rows under a line |
| `src/features/pos/checkout/DiscountDialog.tsx` (+ test) | Amount / Percent step |
| `src/features/pos/checkout/reasons.ts`, `CheckoutSettings.tsx` | `discount` reason template |
| `src/features/pos/checkout/checkoutApi.ts` | four discount calls; closed bill's discount |
| `src/features/pos/checkout/CheckoutTotals.tsx`, `PaymentScreen.tsx`, `TransactionScreen.tsx` | discount rows and line |
| `src/features/pos/order/posApi.ts`, `catalogs.ts` | new columns read |
| `src/features/pos/order/billView.ts` (+ test) | discount rows, subtotal for the bill dialog, catalog tag |
| `src/features/pos/order/billActions.ts` (+ test) | bill discount actions, item actions |
| `src/features/pos/order/ActionsOverlay.tsx` | new generic overlay |
| `src/features/pos/order/BillActionsOverlay.tsx`, `ItemActionsOverlay.tsx` | thin wrappers |
| `src/features/pos/order/BillColumn.tsx`, `OrderScreen.tsx` | rows, tag, dialogs |
| `src/features/pos/menu/menuEditorApi.ts`, `CatalogsPage.tsx`, `listAdmin.ts` (+ test) | catalog Discount % |

---

### Task 1: Bill math and shared vectors

**Files:**
- Modify: `src/features/pos/checkout/bill.ts` (whole file)
- Modify: `src/features/pos/checkout/billVectors.json`
- Modify: `src/features/pos/checkout/bill.test.ts`
- Create: `supabase/migration-2026-10-30-pos-discounts-verify.sql` (skeleton with section B)

**Interfaces:**
- Produces (used by Tasks 5–6): `type DiscountKind = 'amount' | 'percent'`; `interface DiscountInput { kind: DiscountKind; value: number }`; `interface BillLineTotals { id: string | null; catalogDiscountSen: number; itemDiscountSen: number; billShareSen: number; netSen: number }`; `BillLineInput` gains `id?`, `catalogDiscountBp?`, `discount?`; `BillInput` gains `billDiscount?`; `BillTotals` gains `grossSen`, `catalogDiscountSen`, `itemDiscountSen`, `billDiscountSen`, `lines`; functions `discountOffSen(d, baseSen): number`, `lineDiscounts(l): { grossSen; catalogDiscountSen; itemDiscountSen; netSen }`, `shareBillDiscount(totalSen, nets): number[]`.
- Produces (used by Tasks 2–4): the verify file with marker lines `-- @A`, `-- @FIXTURE`, `-- @C`, `-- @D`, `-- @E`, each on its own line, replaced by later tasks.

- [ ] **Step 1: Add the vectors (they fail until the code exists)**

Run from the worktree root. It extends the 23 existing vectors with the new fields (no discounts: gross = subtotal, nets = line amounts), appends the 9 discount vectors, rewrites `billVectors.json` one vector per line (Python's default `", "` / `": "` separators, as the file has today), and writes the verify skeleton with the same vectors.

```bash
python3 - <<'PY'
import json, pathlib
p = pathlib.Path('src/features/pos/checkout/billVectors.json')
v = json.loads(p.read_text())
assert len(v) == 23, len(v)
for x in v:
    live = [l for l in x['input']['lines'] if not l['voided']]
    x['expected'].update({
        'grossSen': x['expected']['subtotalSen'], 'catalogDiscountSen': 0, 'itemDiscountSen': 0, 'billDiscountSen': 0,
        'lines': [{'id': None, 'catalogDiscountSen': 0, 'itemDiscountSen': 0, 'billShareSen': 0,
                   'netSen': l['unitPriceSen'] * l['qty']} for l in live]})
R10 = [{"rateBp": 1000, "orderTypes": ["dine_in"], "tableIds": None, "productIds": None}]
def line(i, price, qty=1, sst=600, fee=0, voided=False, cat=None, disc=None):
    l = {"id": i, "productId": "p-" + i, "unitPriceSen": price, "qty": qty, "sstRateBp": sst, "takeawayFeeSen": fee, "voided": voided}
    if cat is not None: l["catalogDiscountBp"] = cat
    if disc is not None: l["discount"] = {"kind": disc[0], "value": disc[1]}
    return l
def inp(order_type, table, rules, lines, bill=None, rounding="nearest_5_sen"):
    d = {"orderType": order_type, "tableId": table, "sstRegistered": True, "cashRounding": rounding, "rules": rules, "lines": lines}
    if bill is not None: d["billDiscount"] = {"kind": bill[0], "value": bill[1]}
    return d
def g(rate, base, amt): return {"rateBp": rate, "baseSen": base, "amountSen": amt}
def ln(i, cat, item, share, net): return {"id": i, "catalogDiscountSen": cat, "itemDiscountSen": item, "billShareSen": share, "netSen": net}
def exp(sub, sc, sst, fee, before, rnd, total, sstg, scg, gross, cat, item, bill, lines):
    return {"subtotalSen": sub, "serviceChargeSen": sc, "sstSen": sst, "takeawayFeeSen": fee, "beforeRoundingSen": before,
            "roundingSen": rnd, "totalSen": total, "sstGroups": sstg, "serviceChargeGroups": scg, "grossSen": gross,
            "catalogDiscountSen": cat, "itemDiscountSen": item, "billDiscountSen": bill, "lines": lines}
new = [
  {"name": "staff meal: a 50% catalog discount halves each line before service charge and SST",
   "input": inp("dine_in", "t-1", R10, [line("i-1", 4300, cat=5000), line("i-2", 1300, qty=2, cat=5000)]),
   "expected": exp(3450, 345, 207, 0, 4002, -2, 4000, [g(600, 3450, 207)], [g(1000, 3450, 345)], 6900, 3450, 0, 0,
                   [ln("i-1", 2150, 0, 0, 2150), ln("i-2", 1300, 0, 0, 1300)])},
  {"name": "item amount and item percent, then a 10% bill discount shared pro rata",
   "input": inp("dine_in", "t-2", R10, [line("i-1", 2000, disc=("amount", 500)), line("i-2", 1500, qty=2, disc=("percent", 1000)), line("i-3", 800)],
                bill=("percent", 1000)),
   "expected": exp(5000, 450, 270, 0, 5220, 0, 5220, [g(600, 4500, 270)], [g(1000, 4500, 450)], 5800, 0, 800, 500,
                   [ln("i-1", 0, 500, 150, 1350), ln("i-2", 0, 300, 270, 2430), ln("i-3", 0, 0, 80, 720)])},
  {"name": "a bill discount over two SST rates: each rate is taxed on its shared-down base",
   "input": inp("takeaway", None, R10, [line("i-1", 3000, sst=600), line("i-2", 1000, sst=800), line("i-3", 500, sst=0)], bill=("amount", 1000)),
   "expected": exp(4500, 0, 202, 0, 3702, -2, 3700, [g(600, 2333, 140), g(800, 778, 62)], [], 4500, 0, 0, 1000,
                   [ln("i-1", 0, 0, 667, 2333), ln("i-2", 0, 0, 222, 778), ln("i-3", 0, 0, 111, 389)])},
  {"name": "an amount bill discount is capped at what is left after an item is voided",
   "input": inp("dine_in", "t-3", [], [line("i-1", 1000, sst=0, voided=True), line("i-2", 600, sst=0)], bill=("amount", 1000)),
   "expected": exp(600, 0, 0, 0, 0, 0, 0, [], [], 600, 0, 0, 600, [ln("i-2", 0, 0, 600, 0)])},
  {"name": "an item amount discount larger than the line stops at the line",
   "input": inp("dine_in", "t-4", [], [line("i-1", 900, disc=("amount", 1500)), line("i-2", 1100)]),
   "expected": exp(1100, 0, 66, 0, 1166, -1, 1165, [g(600, 1100, 66)], [], 2000, 0, 900, 0,
                   [ln("i-1", 0, 900, 0, 0), ln("i-2", 0, 0, 0, 1100)])},
  {"name": "takeaway: the packaging fee is never discounted",
   "input": inp("takeaway", None, [{"rateBp": 500, "orderTypes": ["takeaway"], "tableIds": None, "productIds": None}],
                [line("i-1", 1300, qty=2, fee=100)], bill=("percent", 5000)),
   "expected": exp(2600, 65, 90, 200, 1655, 0, 1655, [g(600, 1500, 90)], [g(500, 1300, 65)], 2600, 0, 0, 1300,
                   [ln("i-1", 0, 0, 1300, 1300)])},
  {"name": "leftover sen of a bill discount: a tie goes to the earlier line",
   "input": inp("dine_in", "t-5", [], [line("i-1", 100, sst=0), line("i-2", 100, sst=0), line("i-3", 100, sst=0)], bill=("amount", 100)),
   "expected": exp(300, 0, 0, 0, 200, 0, 200, [], [], 300, 0, 0, 100,
                   [ln("i-1", 0, 0, 34, 66), ln("i-2", 0, 0, 33, 67), ln("i-3", 0, 0, 33, 67)])},
  {"name": "leftover sen on a tiny bill: the largest line runs out of room and the next takes the rest",
   "input": inp("dine_in", "t-6", [], [line("i-1", 1, sst=0), line("i-2", 1, sst=0), line("i-3", 1, sst=0)], bill=("amount", 2), rounding="none"),
   "expected": exp(3, 0, 0, 0, 1, 0, 1, [], [], 3, 0, 0, 2, [ln("i-1", 0, 0, 1, 0), ln("i-2", 0, 0, 1, 0), ln("i-3", 0, 0, 0, 1)])},
  {"name": "staff meal 50%, a 10% item discount and an amount bill discount, rounded up",
   "input": inp("dine_in", "t-7", R10, [line("i-1", 2500, cat=5000, disc=("percent", 1000)), line("i-2", 1890, cat=5000)], bill=("amount", 300)),
   "expected": exp(2070, 177, 106, 0, 2053, 2, 2055, [g(600, 1770, 106)], [g(1000, 1770, 177)], 4390, 2195, 125, 300,
                   [ln("i-1", 1250, 125, 164, 961), ln("i-2", 945, 0, 136, 809)])},
]
v += new
text = "[\n" + ",\n".join("  " + json.dumps(x) for x in v) + "\n]\n"
p.write_text(text)
sql = f"""-- Self-check for POS discounts. Run on craft-os-dev after
-- migration-2026-10-30-pos-discounts.sql. Everything is rolled back. Success = a result row
-- "VERIFY OK". Sections: A schema and grants; B the shared bill vectors; C the catalog discount
-- copied at order time; D item and bill discounts; E receipt and Z report.
-- The vectors below are a copy of src/features/pos/checkout/billVectors.json (bill.test.ts fails
-- if the two differ). They replace the totals checks of migration-2026-10-24-pos-checkout-verify.sql
-- and migration-2026-10-25-pos-hardening-verify.sql: those compare whole totals objects, which now
-- carry the discount fields, so re-running them reports a totals failure.
begin;

-- expect_error(sql, message, label): runs sql and insists it raises exactly message.
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

-- act(user id): the next calls run as this signed-in user (a staff login or a POS device)
create function pg_temp.act(p_user uuid) returns void
language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

do $$
declare
  v_vectors jsonb := $vectors$
{text}$vectors$;
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_cash  uuid := 'eeeeeeee-0000-0000-0000-0000000000a1';   -- cashier of VERIFY D
  v_sup   uuid := 'eeeeeeee-0000-0000-0000-0000000000a2';   -- supervisor of VERIFY D (approves)
  v_dev   uuid := 'eeeeeeee-0000-0000-0000-0000000000a3';   -- a tablet of VERIFY D
  v_a uuid; v_t1 uuid; v_t2 uuid; v_cat uuid; v_catalog uuid; v_plate uuid; v_plate_v uuid; v_card uuid;
  v_items jsonb; v_order uuid; v_order2 uuid; v_bill uuid; v_bill2 uuid; v_item uuid; v_item2 uuid; v_shift uuid;
  v_res jsonb; v_tot jsonb; r record;
begin
-- @A

  -- ── B. totals: the shared vectors ─────────────────────────────────────────
  if jsonb_array_length(v_vectors) <> 32 then raise exception 'FAIL vectors: expected 32, got %', jsonb_array_length(v_vectors); end if;
  for r in select v from jsonb_array_elements(v_vectors) v loop
    if pos_compute_bill(r.v->'input') <> r.v->'expected' then
      raise exception 'FAIL vector "%": got %', r.v->>'name', pos_compute_bill(r.v->'input');
    end if;
  end loop;

-- @FIXTURE
-- @C
-- @D
-- @E
  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;
rollback;
"""
pathlib.Path('supabase/migration-2026-10-30-pos-discounts-verify.sql').write_text(sql)
print(len(v), 'vectors')
PY
```

Expected output: `32 vectors`.

- [ ] **Step 2: Point the test at the new verify file and add unit tests**

In `src/features/pos/checkout/bill.test.ts`:

Replace the import line with:

```ts
import { computeBill, discountOffSen, formatRate, lineDiscounts, roundingDeltaSen, shareBillDiscount, type BillInput, type BillOrderType, type BillTotals } from './bill'
```

Replace `expect(all).toHaveLength(23)` with `expect(all).toHaveLength(32)`.

Replace `'../../../../supabase/migration-2026-10-24-pos-checkout-verify.sql'` with `'../../../../supabase/migration-2026-10-30-pos-discounts-verify.sql'`.

Append at the end of the file:

```ts
describe('discountOffSen', () => {
  it('a percent rounds half up; an amount stops at the base; nothing off a zero base', () => {
    expect(discountOffSen({ kind: 'percent', value: 1000 }, 1125)).toBe(113) // 112.5 → 113
    expect(discountOffSen({ kind: 'amount', value: 1500 }, 900)).toBe(900)
    expect(discountOffSen({ kind: 'amount', value: 500 }, 0)).toBe(0)
    expect(discountOffSen(null, 900)).toBe(0)
  })
})

describe('lineDiscounts', () => {
  it('the catalog discount first, then the item discount on what is left', () => {
    expect(lineDiscounts({ unitPriceSen: 2500, qty: 1, catalogDiscountBp: 5000, discount: { kind: 'percent', value: 1000 } }))
      .toEqual({ grossSen: 2500, catalogDiscountSen: 1250, itemDiscountSen: 125, netSen: 1125 })
  })
})

describe('shareBillDiscount', () => {
  it('rounds each share down and gives the leftover to the largest line first', () => {
    expect(shareBillDiscount(1000, [3000, 1000, 500])).toEqual([667, 222, 111])
  })
  it('never takes a line below zero', () => {
    expect(shareBillDiscount(2, [1, 1, 1])).toEqual([1, 1, 0])
  })
  it('nothing to share', () => {
    expect(shareBillDiscount(0, [100, 200])).toEqual([0, 0])
    expect(shareBillDiscount(100, [0, 0])).toEqual([0, 0])
  })
})
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run src/features/pos/checkout/bill.test.ts`
Expected: FAIL — `discountOffSen is not a function` (and the 32 vector cases fail on the missing fields).

- [ ] **Step 4: Replace `src/features/pos/checkout/bill.ts`**

```ts
/** Bill totals — the TypeScript mirror of the SQL function pos_compute_bill
 *  (supabase/migration-2026-10-30-pos-discounts.sql). Both take the same
 *  input shape and are tested against the same vectors (billVectors.json, and
 *  the copy inside supabase/migration-2026-10-30-pos-discounts-verify.sql).
 *  The server's result is the truth; this one is for instant display.
 *  All money is integer sen; all rates are basis points (600 = 6%). */

export type BillOrderType = 'dine_in' | 'takeaway'
export type CashRounding = 'none' | 'nearest_5_sen'
export type DiscountKind = 'amount' | 'percent'

/** A discount as stored: an amount in sen, or a whole percent in basis points (1000 = 10%). */
export interface DiscountInput {
  kind: DiscountKind
  value: number
}

export interface BillLineInput {
  id?: string // order_items.id: names the line in BillTotals.lines (an unsent draft has none)
  productId: string | null
  unitPriceSen: number // variant + modifiers, already
  qty: number
  sstRateBp: number
  takeawayFeeSen: number // snapshotted on the order item; counted only on takeaway lines, taxed at the line's SST rate
  voided: boolean
  /** The order type the item was ordered under (order_items.order_type): a takeaway merged into
   *  a table's bill keeps 'takeaway' (owner, 2026-10-25). Absent = the bill's order type. */
  orderType?: BillOrderType
  catalogDiscountBp?: number // order_items.catalog_discount_bp: its catalog's discount when ordered (absent = none)
  discount?: DiscountInput | null // the item discount
}

export interface ServiceChargeRuleInput {
  rateBp: number
  orderTypes: BillOrderType[]
  tableIds: string[] | null // null = every table
  productIds: string[] | null // null = every product
}

export interface BillInput {
  orderType: BillOrderType
  tableId: string | null
  sstRegistered: boolean
  cashRounding: CashRounding
  rules: ServiceChargeRuleInput[] // already in sort_order: the first match wins
  lines: BillLineInput[]
  billDiscount?: DiscountInput | null
}

export interface ChargeGroup {
  rateBp: number
  baseSen: number
  amountSen: number
}

export interface BillLineTotals {
  id: string | null
  catalogDiscountSen: number
  itemDiscountSen: number
  billShareSen: number // its share of the bill discount
  netSen: number // what its service charge and SST are charged on (the packaging fee apart)
}

export interface BillTotals {
  subtotalSen: number // after catalog and item discounts, before the bill discount
  serviceChargeSen: number
  sstSen: number
  takeawayFeeSen: number
  beforeRoundingSen: number
  roundingSen: number
  totalSen: number
  sstGroups: ChargeGroup[] // one per non-zero SST rate, ascending
  serviceChargeGroups: ChargeGroup[] // one per non-zero service-charge rate, ascending
  grossSen: number // the live lines at their prices, before any discount
  catalogDiscountSen: number
  itemDiscountSen: number
  billDiscountSen: number
  lines: BillLineTotals[] // one per live line, in input order
}

/** Whole bill to the nearest 5 sen: …1,2 down; …3,4 up; …6,7 down; …8,9 up. Returns the delta (−2…+2). */
export function roundingDeltaSen(sen: number): number {
  const r = ((sen % 5) + 5) % 5
  if (r === 0) return 0
  return r <= 2 ? -r : 5 - r
}

function groups(bases: Map<number, number>): ChargeGroup[] {
  return [...bases.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rateBp, baseSen]) => ({ rateBp, baseSen, amountSen: Math.round((baseSen * rateBp) / 10000) }))
}

const lineType = (input: BillInput, line: BillLineInput): BillOrderType => line.orderType ?? input.orderType

/** A takeaway line matches no table-limited rule: on its own bill it had no table. */
function ruleFor(input: BillInput, line: BillLineInput): ServiceChargeRuleInput | undefined {
  const type = lineType(input, line)
  return input.rules.find(
    (r) =>
      r.orderTypes.includes(type) &&
      (r.tableIds === null || (type === 'dine_in' && input.tableId !== null && r.tableIds.includes(input.tableId))) &&
      (r.productIds === null || (line.productId !== null && r.productIds.includes(line.productId))),
  )
}

/** What a discount takes off baseSen: a percent rounds half up, an amount stops at the base. */
export function discountOffSen(d: DiscountInput | null | undefined, baseSen: number): number {
  if (!d || baseSen <= 0) return 0
  return d.kind === 'percent' ? Math.round((baseSen * d.value) / 10000) : Math.min(d.value, baseSen)
}

/** One line's discounts: its catalog's percent of its amount, then the item discount on what is left. */
export function lineDiscounts(l: Pick<BillLineInput, 'unitPriceSen' | 'qty' | 'catalogDiscountBp' | 'discount'>): {
  grossSen: number; catalogDiscountSen: number; itemDiscountSen: number; netSen: number
} {
  const grossSen = l.unitPriceSen * l.qty
  const catalogDiscountSen = Math.round((grossSen * (l.catalogDiscountBp ?? 0)) / 10000)
  const itemDiscountSen = discountOffSen(l.discount, grossSen - catalogDiscountSen)
  return { grossSen, catalogDiscountSen, itemDiscountSen, netSen: grossSen - catalogDiscountSen - itemDiscountSen }
}

/** The bill discount over the lines' nets: each share rounded down, then the leftover sen to the
 *  largest net first (ties: the earlier line), never more than a line has left. */
export function shareBillDiscount(totalSen: number, nets: number[]): number[] {
  const sum = nets.reduce((n, x) => n + x, 0)
  if (totalSen <= 0 || sum <= 0) return nets.map(() => 0)
  const shares = nets.map((x) => Math.floor((totalSen * x) / sum))
  let left = totalSen - shares.reduce((n, x) => n + x, 0)
  const order = nets.map((_, i) => i).sort((a, b) => nets[b] - nets[a] || a - b)
  for (const i of order) {
    if (left === 0) break
    const take = Math.min(left, nets[i] - shares[i])
    shares[i] += take
    left -= take
  }
  return shares
}

export function computeBill(input: BillInput): BillTotals {
  const live = input.lines.filter((l) => !l.voided)
  const parts = live.map((l) => lineDiscounts(l))
  const subtotalSen = parts.reduce((n, p) => n + p.netSen, 0)
  const billDiscountSen = discountOffSen(input.billDiscount, subtotalSen)
  const shares = shareBillDiscount(billDiscountSen, parts.map((p) => p.netSen))
  const net = parts.map((p, i) => p.netSen - shares[i]) // what each line is charged on

  const scBases = new Map<number, number>()
  live.forEach((l, i) => {
    const rule = ruleFor(input, l)
    if (rule && rule.rateBp > 0) scBases.set(rule.rateBp, (scBases.get(rule.rateBp) ?? 0) + net[i])
  })
  const serviceChargeGroups = groups(scBases)

  // SST base per rate: the line's net plus, on a takeaway line, its packaging fee (owner, 2026-10-24;
  // a takeaway merged into a table keeps its fee — owner, 2026-10-25). The fee is never discounted.
  const fee = (l: BillLineInput) => (lineType(input, l) === 'takeaway' ? l.takeawayFeeSen * l.qty : 0)
  const sstBases = new Map<number, number>()
  if (input.sstRegistered) {
    live.forEach((l, i) => {
      if (l.sstRateBp > 0) sstBases.set(l.sstRateBp, (sstBases.get(l.sstRateBp) ?? 0) + net[i] + fee(l))
    })
  }
  const sstGroups = groups(sstBases)

  const serviceChargeSen = serviceChargeGroups.reduce((n, g) => n + g.amountSen, 0)
  const sstSen = sstGroups.reduce((n, g) => n + g.amountSen, 0)
  const takeawayFeeSen = live.reduce((n, l) => n + fee(l), 0)
  const beforeRoundingSen = subtotalSen - billDiscountSen + serviceChargeSen + sstSen + takeawayFeeSen
  const roundingSen = input.cashRounding === 'nearest_5_sen' ? roundingDeltaSen(beforeRoundingSen) : 0
  return {
    subtotalSen,
    serviceChargeSen,
    sstSen,
    takeawayFeeSen,
    beforeRoundingSen,
    roundingSen,
    totalSen: beforeRoundingSen + roundingSen,
    sstGroups,
    serviceChargeGroups,
    grossSen: parts.reduce((n, p) => n + p.grossSen, 0),
    catalogDiscountSen: parts.reduce((n, p) => n + p.catalogDiscountSen, 0),
    itemDiscountSen: parts.reduce((n, p) => n + p.itemDiscountSen, 0),
    billDiscountSen,
    lines: live.map((l, i) => ({
      id: l.id ?? null, catalogDiscountSen: parts[i].catalogDiscountSen, itemDiscountSen: parts[i].itemDiscountSen,
      billShareSen: shares[i], netSen: net[i],
    })),
  }
}

/** 600 → "6%", 650 → "6.5%", 1000 → "10%". */
export function formatRate(bp: number): string {
  return `${Number((bp / 100).toFixed(2))}%`
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run src/features/pos/checkout/bill.test.ts`
Expected: PASS, 32 vector cases plus the unit tests.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit -p tsconfig.app.json` (if the project has no `tsconfig.app.json`, run `npx tsc --noEmit`)
Expected: no errors. `BillTotals` gained required fields; any object literal typed `BillTotals` in a test fixture is reported — add `grossSen: <its subtotalSen>, catalogDiscountSen: 0, itemDiscountSen: 0, billDiscountSen: 0, lines: []` to each one the compiler names.

- [ ] **Step 7: Commit**

```bash
git add src/features/pos/checkout/bill.ts src/features/pos/checkout/billVectors.json src/features/pos/checkout/bill.test.ts supabase/migration-2026-10-30-pos-discounts-verify.sql
git commit -m "feat(pos): bill math for catalog, item and bill discounts, with shared vectors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Add any fixture file Step 6 changed to the `git add`.)

---

### Task 2: Schema, catalog snapshot and server totals

**Files:**
- Create: `supabase/migration-2026-10-30-pos-discounts.sql`
- Modify: `supabase/migration-2026-10-30-pos-discounts-verify.sql` (markers `-- @A`, `-- @FIXTURE`, `-- @C`)

**Interfaces:**
- Consumes: the vector input shape of Task 1 (`lines[].id`, `catalogDiscountBp`, `discount {kind,value}`, `billDiscount`).
- Produces: columns `menu_catalogs.discount_bp`; `order_items.catalog_discount_bp`, `catalog_discount_name`, `discount_kind`, `discount_value`, `discount_reason`, `discount_approved_by`, `discount_by`, `discount_at`; the same six `discount_*` columns on `bills`; table `pos_discount_log`; functions `pos_check_discount(text, integer)`, `menu_set_catalog_discount(uuid, integer)`, `pos_compute_bill(jsonb)` and `pos_bill_totals(uuid)` returning the new fields.

- [ ] **Step 1: Write verify sections A, fixture and C**

In `supabase/migration-2026-10-30-pos-discounts-verify.sql` replace the line `-- @A` with:

```sql
  -- ── A. schema and grants ──────────────────────────────────────────────────
  for r in select t, c from (values
      ('menu_catalogs', 'discount_bp'), ('order_items', 'catalog_discount_bp'), ('order_items', 'catalog_discount_name'),
      ('order_items', 'discount_kind'), ('order_items', 'discount_value'), ('order_items', 'discount_reason'),
      ('order_items', 'discount_approved_by'), ('order_items', 'discount_by'), ('order_items', 'discount_at'),
      ('bills', 'discount_kind'), ('bills', 'discount_value'), ('bills', 'discount_reason'),
      ('bills', 'discount_approved_by'), ('bills', 'discount_by'), ('bills', 'discount_at')) as x(t, c) loop
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = r.t and column_name = r.c) then
      raise exception 'FAIL schema: %.% is missing', r.t, r.c;
    end if;
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'menu_catalogs_discount_bp_check')
     or not exists (select 1 from pg_constraint where conname = 'order_items_discount_check')
     or not exists (select 1 from pg_constraint where conname = 'bills_discount_check')
     or not exists (select 1 from pg_trigger where tgname = 'order_items_catalog_discount' and tgrelid = 'order_items'::regclass) then
    raise exception 'FAIL schema: a discount check or the catalog-discount trigger is missing';
  end if;
  if not (select relrowsecurity from pg_class where relname = 'pos_discount_log' and relnamespace = 'public'::regnamespace)
     or has_table_privilege('authenticated', 'pos_discount_log', 'insert') then
    raise exception 'FAIL rls: pos_discount_log must have RLS on and no client writes';
  end if;
  if has_function_privilege('authenticated', 'pos_check_discount(text,integer)', 'execute') then
    raise exception 'FAIL grants: pos_check_discount is internal';
  end if;
  begin
    insert into reason_templates(branch_id, action) values ((select id from branches limit 1), 'discount');
  exception when unique_violation then null;   -- the branch already has one: the action is allowed
  end;
```

Replace the line `-- @FIXTURE` with:

```sql
  -- ── fixture: outlet VERIFY D, two tables, a 43.00 plate, a card method, a cashier and a supervisor
  --    with PINs, one tablet with the cashier signed in and a shift open ──
  update system_role_permissions set permissions = permissions - 'pos_login' - 'all_branches' - 'access_settings' - 'pos_supervise'
   where true;                                                                         -- code defaults
  insert into branches(name, address) values ('VERIFY D', 'd') returning id into v_a;
  insert into dining_tables(branch_id, label, sort_order) values (v_a, 'D1', 1) returning id into v_t1;
  insert into dining_tables(branch_id, label, sort_order) values (v_a, 'D2', 2) returning id into v_t2;
  insert into print_routes(branch_id, name, kind, address) values (v_a, 'Bar', 'agent', '127.0.0.1:9100');
  insert into branch_pos_settings(branch_id, receipt_route) values (v_a, 'Bar');
  insert into service_charge_rules(branch_id, rate_bp, order_types, sort_order) values (v_a, 1000, array['dine_in'], 1);
  insert into menu_categories(name, sort_order) values ('VERIFY D FOOD', 900) returning id into v_cat;
  insert into menu_products(name, category_id, sst_rate_bp) values ('Verify D Plate', v_cat, 600) returning id into v_plate;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_plate, '', 'Regular', 4300) returning id into v_plate_v;
  insert into menu_catalogs(name, sort_order) values ('VERIFY D STAFF MEAL', 900) returning id into v_catalog;
  insert into catalog_products(catalog_id, product_id, availability) values (v_catalog, v_plate, 'all');
  insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (v_catalog, v_plate_v, 4300);
  insert into branch_catalogs(branch_id, role, catalog_id) values (v_a, 'dine_in', v_catalog), (v_a, 'takeaway', v_catalog), (v_a, 'qr', v_catalog);
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_a, 'D Card', 'card', 1) returning id into v_card;
  v_items := jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_v));
  update staff set branch_id = v_a where id = v_owner;
  perform pg_temp.act(v_owner);
  insert into auth.users (id) values (v_cash), (v_sup), (v_dev);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_cash, 'Verify D Cashier',    'trainee', true, current_date, 'staff', v_a),
    (v_sup,  'Verify D Supervisor', 'trainee', true, current_date, 'staff', v_a);
  update staff set system_role = 'supervisor' where id = v_sup;
  for r in select * from (values (v_cash, '1111'), (v_sup, '2222')) as x(id, pin) loop
    perform pg_temp.act(r.id);
    if not coalesce((set_my_pos_pin(r.pin, null)->>'ok')::boolean, false) then raise exception 'FAIL fixture: PIN of %', r.id; end if;
  end loop;
  insert into pos_devices(id, branch_id, kind, name, platform, prints, approved_by) values (v_dev, v_a, 'pos', 'D Counter', 'ipad', true, v_owner);
  perform pg_temp.act(v_dev);
  v_res := pos_start_session(v_cash, '1111');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: cashier sign-in: %', v_res; end if;
  v_res := open_shift(10000);
  v_shift := (v_res->'shift'->>'id')::uuid;
```

Replace the line `-- @C` with:

```sql
  -- ── C. the catalog discount is copied onto each item when it is ordered ───
  perform pg_temp.act(v_owner);
  perform pg_temp.expect_error(format('select menu_set_catalog_discount(%L, 5050)', v_catalog),
    'Enter a whole percent from 0 to 100', 'C a percent with a fraction');
  perform menu_set_catalog_discount(v_catalog, 5000);
  perform pg_temp.act(v_dev);
  v_order := place_counter_order(v_t1, 'dine_in', 2, v_items, gen_random_uuid());
  v_bill := (select bill_id from orders where id = v_order);
  v_item := (select id from order_items where order_id = v_order);
  if (select catalog_discount_bp from order_items where id = v_item) is distinct from 5000
     or (select catalog_discount_name from order_items where id = v_item) is distinct from 'VERIFY D STAFF MEAL' then
    raise exception 'FAIL C: the catalog discount was not copied onto the item';
  end if;
  perform pg_temp.act(v_owner);
  perform menu_set_catalog_discount(v_catalog, 0);
  perform pg_temp.act(v_dev);
  v_order2 := place_counter_order(v_t1, 'dine_in', null, v_items, gen_random_uuid());
  v_item2 := (select id from order_items where order_id = v_order2);
  if (select bill_id from orders where id = v_order2) is distinct from v_bill
     or (select catalog_discount_bp from order_items where id = v_item) is distinct from 5000
     or (select catalog_discount_bp from order_items where id = v_item2) is distinct from 0
     or (select catalog_discount_name from order_items where id = v_item2) is not null then
    raise exception 'FAIL C: a later catalog change touched an ordered item, or a 0%% catalog left a name';
  end if;
  -- 43.00 at 50% + 43.00 = 64.50; service charge 10% 6.45; SST 6% 3.87; 74.82 → 74.80
  v_tot := pos_bill_totals(v_bill);
  if (v_tot->>'grossSen')::int is distinct from 8600 or (v_tot->>'catalogDiscountSen')::int is distinct from 2150
     or (v_tot->>'subtotalSen')::int is distinct from 6450 or (v_tot->>'totalSen')::int is distinct from 7480
     or jsonb_array_length(v_tot->'lines') <> 2
     or not exists (select 1 from jsonb_array_elements(v_tot->'lines') l where l->>'id' = v_item::text and (l->>'netSen')::int = 2150) then
    raise exception 'FAIL C totals: %', v_tot;
  end if;
```

- [ ] **Step 2: Write the migration (part 1)**

Create `supabase/migration-2026-10-30-pos-discounts.sql`:

```sql
-- ============================================================================
-- Craft OS — POS discounts (2026-10-30). Run on craft-os-dev after
-- migration-2026-10-29-pos-device-till.sql. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-30-pos-discounts.md
-- Design: docs/superpowers/specs/2026-10-30-pos-discounts-design.md
--
-- D1  Schema: menu_catalogs.discount_bp (Staff Meal = 5000); order_items keeps the catalog's
--     discount and name from when it was ordered (trigger order_items_catalog_discount) and its
--     item discount; bills keep the bill discount; pos_discount_log records every set and clear;
--     reason_templates gains the 'discount' action.
-- D2  Totals: pos_compute_bill applies catalog → item → bill (shared pro rata) discounts before
--     service charge and SST and returns grossSen, catalogDiscountSen, itemDiscountSen,
--     billDiscountSen and lines[]; mirrored by computeBill (src/features/pos/checkout/bill.ts),
--     both pass billVectors.json. pos_bill_totals passes the discounts and each item's id.
-- D3  RPCs: set_item_discount, clear_item_discount, set_bill_discount, clear_bill_discount;
--     merge_bills refuses a source bill with a bill discount.
-- D4  Receipt and Z report: discount rows under items, the bill discount line, a Discounts section.
-- Re-run hazards: re-running migration-2026-10-25-pos-hardening.sql puts back the old
-- pos_compute_bill, pos_bill_totals and pos_shift_report; migration-2026-10-24-pos-checkout-fn.sql
-- the old pos_receipt_payload; migration-2026-10-29-pos-device-till.sql the old merge_bills —
-- re-run this file after any of them.
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_actor()') is null or to_regprocedure('pos_current_device()') is null then
    raise exception 'STOP: run migration-2026-10-29-pos-device-till.sql first (pos_actor is missing)';
  end if;
end $$;

-- ── D1. Schema ──────────────────────────────────────────────────────────────
alter table menu_catalogs add column if not exists discount_bp integer not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'menu_catalogs_discount_bp_check') then
    alter table menu_catalogs add constraint menu_catalogs_discount_bp_check
      check (discount_bp between 0 and 10000 and discount_bp % 100 = 0);
  end if;
end $$;

alter table order_items
  add column if not exists catalog_discount_bp   integer not null default 0,
  add column if not exists catalog_discount_name text,
  add column if not exists discount_kind         text,
  add column if not exists discount_value        integer,
  add column if not exists discount_reason       text,
  add column if not exists discount_approved_by  uuid,
  add column if not exists discount_by           uuid,
  add column if not exists discount_at           timestamptz;
alter table bills
  add column if not exists discount_kind         text,
  add column if not exists discount_value        integer,
  add column if not exists discount_reason       text,
  add column if not exists discount_approved_by  uuid,
  add column if not exists discount_by           uuid,
  add column if not exists discount_at           timestamptz;
-- a discount is all there or all gone; the reason may be empty when the template does not ask for one
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'order_items_discount_check') then
    alter table order_items add constraint order_items_discount_check check (
      (discount_kind is null and discount_value is null and discount_reason is null
         and discount_approved_by is null and discount_by is null and discount_at is null)
      or (discount_approved_by is not null and discount_by is not null and discount_at is not null
          and ((discount_kind = 'amount' and discount_value > 0)
               or (discount_kind = 'percent' and discount_value between 100 and 10000 and discount_value % 100 = 0))));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bills_discount_check') then
    alter table bills add constraint bills_discount_check check (
      (discount_kind is null and discount_value is null and discount_reason is null
         and discount_approved_by is null and discount_by is null and discount_at is null)
      or (discount_approved_by is not null and discount_by is not null and discount_at is not null
          and ((discount_kind = 'amount' and discount_value > 0)
               or (discount_kind = 'percent' and discount_value between 100 and 10000 and discount_value % 100 = 0))));
  end if;
end $$;

-- the order's catalog discount and name, fixed when the item is ordered
create or replace function order_items_catalog_discount() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  select c.discount_bp, case when c.discount_bp > 0 then c.name end
    into new.catalog_discount_bp, new.catalog_discount_name
    from orders o join menu_catalogs c on c.id = o.catalog_id
   where o.id = new.order_id;
  new.catalog_discount_bp := coalesce(new.catalog_discount_bp, 0);
  return new;
end $$;
revoke all on function order_items_catalog_discount() from public, anon, authenticated;
drop trigger if exists order_items_catalog_discount on order_items;
create trigger order_items_catalog_discount before insert on order_items
  for each row execute function order_items_catalog_discount();

-- every discount set or cleared (written only by the D3 RPCs; read by the outlet, like its bills)
create table if not exists pos_discount_log (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  bill_id       uuid not null references bills(id),
  order_item_id uuid references order_items(id),          -- null = the bill discount
  action        text not null check (action in ('set', 'clear')),
  kind          text check (kind in ('amount', 'percent')),
  value         integer,
  reason        text,
  approved_by   uuid,                                      -- null on a clear (no PIN)
  actor         uuid,
  device_id     uuid default pos_current_device(),
  created_at    timestamptz not null default now()
);
alter table pos_discount_log enable row level security;
revoke all on pos_discount_log from public, anon, authenticated;
grant select on pos_discount_log to authenticated;
drop policy if exists pos_read on pos_discount_log;
create policy pos_read on pos_discount_log for select to authenticated
  using (branch_id in (select pos_readable_branches()));

alter table reason_templates drop constraint if exists reason_templates_action_check;
alter table reason_templates add constraint reason_templates_action_check
  check (action in ('void_item', 'void_bill', 'refund', 'discount'));

-- A discount's kind and value as the cashier sent them (the same words as discountProblem in
-- src/features/pos/checkout/discounts.ts). Internal.
create or replace function pos_check_discount(p_kind text, p_value integer) returns void
language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if p_kind = 'percent' then
    if p_value is null or p_value < 100 or p_value > 10000 or p_value % 100 <> 0 then
      raise exception 'Enter a whole percent from 1 to 100';
    end if;
  elsif p_kind = 'amount' then
    if p_value is null or p_value <= 0 then raise exception 'Enter an amount above RM 0.00'; end if;
  else
    raise exception 'Choose Amount or Percent';
  end if;
end $$;
revoke all on function pos_check_discount(text, integer) from public, anon, authenticated;

-- Catalogs → Discount %: a whole percent 0–100 of every item ordered from the catalog
create or replace function menu_set_catalog_discount(p_id uuid, p_bp integer) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform menu_require_editor();
  if p_bp is null or p_bp < 0 or p_bp > 10000 or p_bp % 100 <> 0 then
    raise exception 'Enter a whole percent from 0 to 100';
  end if;
  update menu_catalogs set discount_bp = p_bp where id = p_id;
  if not found then raise exception 'Catalog not found — refresh and try again'; end if;
end $$;
revoke all on function menu_set_catalog_discount(uuid, integer) from public, anon;
grant execute on function menu_set_catalog_discount(uuid, integer) to authenticated;

-- ── D2. Totals ──────────────────────────────────────────────────────────────
-- The live text of migration-2026-10-25-pos-hardening.sql (H4) with the lines marked D added:
-- live lines in input order → catalog discount → item discount → subtotal → bill discount,
-- shared pro rata (floor, then the leftover sen to the largest net first, ties to the earlier
-- line, never below zero) → service charge and SST on the shared-down nets.
create or replace function pos_compute_bill(p_input jsonb) returns jsonb
language sql immutable security invoker set search_path = public, pg_temp as $$
  with raw as (                                                                       -- D
    select x.ord, x.l, (x.l->>'unitPriceSen')::bigint * (x.l->>'qty')::bigint as gross
      from jsonb_array_elements(coalesce(p_input->'lines', '[]'::jsonb)) with ordinality as x(l, ord)
     where not coalesce((x.l->>'voided')::boolean, false)
  ),
  cat as (                                                                            -- D
    select r.*, round(r.gross * coalesce((r.l->>'catalogDiscountBp')::integer, 0) / 10000.0)::bigint as cat_off
      from raw r
  ),
  itm as (                                                                            -- D
    select c.*,
           case when coalesce(jsonb_typeof(c.l->'discount'), 'null') <> 'object' or c.gross - c.cat_off <= 0 then 0
                when c.l->'discount'->>'kind' = 'percent'
                  then round((c.gross - c.cat_off) * (c.l->'discount'->>'value')::bigint / 10000.0)::bigint
                else least((c.l->'discount'->>'value')::bigint, c.gross - c.cat_off) end as item_off
      from cat c
  ),
  nets as (select i.*, i.gross - i.cat_off - i.item_off as net from itm i),          -- D
  bd as (                                                                             -- D
    select s.subtotal,
           case when coalesce(jsonb_typeof(p_input->'billDiscount'), 'null') <> 'object' or s.subtotal <= 0 then 0
                when p_input->'billDiscount'->>'kind' = 'percent'
                  then round(s.subtotal * (p_input->'billDiscount'->>'value')::bigint / 10000.0)::bigint
                else least((p_input->'billDiscount'->>'value')::bigint, s.subtotal) end as bill_off
      from (select coalesce(sum(net), 0)::bigint as subtotal from nets) s
  ),
  fl as (                                                                             -- D
    select n.*, case when bd.bill_off > 0 then floor(bd.bill_off::numeric * n.net / bd.subtotal)::bigint else 0 end as floor_share
      from nets n, bd
  ),
  lo as (select bd.bill_off - coalesce((select sum(floor_share) from fl), 0) as left_over from bd),   -- D
  rm as (                                                                             -- D
    select fl.*,
           coalesce(sum(fl.net - fl.floor_share) over (order by fl.net desc, fl.ord
                                                       rows between unbounded preceding and 1 preceding), 0) as room_before
      from fl
  ),
  sh as (                                                                             -- D
    select rm.*, rm.floor_share + least(rm.net - rm.floor_share, greatest(0, lo.left_over - rm.room_before)) as share
      from rm, lo
  ),
  lines as (
    select sh.ord, sh.l->'id' as id, sh.gross, sh.cat_off, sh.item_off, sh.share,     -- D
           sh.net - sh.share as amount,                                               -- D: what it is charged on
           (sh.l->>'productId') as product_id,
           (sh.l->>'sstRateBp')::integer as sst_bp,
           coalesce((sh.l->>'takeawayFeeSen')::bigint, 0) * (sh.l->>'qty')::bigint as fee,
           coalesce(sh.l->>'orderType', p_input->>'orderType') as order_type          -- H4: the line's own order type
      from sh
  ),
  rated as (
    select ln.*,
           (select (rr.rule->>'rateBp')::integer
              from jsonb_array_elements(coalesce(p_input->'rules', '[]'::jsonb)) with ordinality as rr(rule, ord)
             where (rr.rule->'orderTypes') ? ln.order_type                                   -- H4
               and (jsonb_typeof(rr.rule->'tableIds') is distinct from 'array'
                    or (ln.order_type = 'dine_in'                                              -- H4: a takeaway line has no table
                        and p_input->>'tableId' is not null and (rr.rule->'tableIds') ? (p_input->>'tableId')))
               and (jsonb_typeof(rr.rule->'productIds') is distinct from 'array'
                    or (ln.product_id is not null and (rr.rule->'productIds') ? ln.product_id))
             order by rr.ord
             limit 1) as sc_bp
      from lines ln
  ),
  sc as (
    select sc_bp as rate_bp, sum(amount) as base, round(sum(amount) * sc_bp / 10000.0) as amt
      from rated where sc_bp > 0 group by sc_bp
  ),
  taxed as (
    select sst_bp, amount + case when order_type = 'takeaway' then fee else 0 end as base_part   -- H4
      from lines
  ),
  sst as (
    select sst_bp as rate_bp, sum(base_part) as base, round(sum(base_part) * sst_bp / 10000.0) as amt
      from taxed
     where sst_bp > 0 and coalesce((p_input->>'sstRegistered')::boolean, true)
     group by sst_bp
  ),
  t as (
    select bd.subtotal, bd.bill_off,                                                  -- D
           coalesce((select sum(gross) from lines), 0) as gross_total,               -- D
           coalesce((select sum(cat_off) from lines), 0) as cat_total,               -- D
           coalesce((select sum(item_off) from lines), 0) as item_total,             -- D
           coalesce((select sum(amt) from sc), 0) as sc_total,
           coalesce((select sum(amt) from sst), 0) as sst_total,
           coalesce((select sum(fee) from lines where order_type = 'takeaway'), 0) as fee_total             -- H4
      from bd
  ),
  b as (
    select t.*, t.subtotal - t.bill_off + t.sc_total + t.sst_total + t.fee_total as before_rounding from t   -- D: − bill_off
  ),
  m as (
    -- remainder normalised to 0..4 so a negative amount rounds like roundingDeltaSen (bill.ts)
    select b.*, ((b.before_rounding % 5) + 5) % 5 as r5 from b
  ),
  fin as (
    select m.*,
           case when coalesce(p_input->>'cashRounding', 'nearest_5_sen') <> 'nearest_5_sen' then 0
                when m.r5 in (1, 2) then -m.r5         -- …1, …2 → down
                when m.r5 in (3, 4) then 5 - m.r5      -- …3, …4 → up
                else 0 end as rounding
      from m
  )
  select jsonb_build_object(
    'subtotalSen', fin.subtotal, 'serviceChargeSen', fin.sc_total, 'sstSen', fin.sst_total,
    'takeawayFeeSen', fin.fee_total, 'beforeRoundingSen', fin.before_rounding, 'roundingSen', fin.rounding,
    'totalSen', fin.before_rounding + fin.rounding,
    'sstGroups', coalesce((select jsonb_agg(jsonb_build_object('rateBp', rate_bp, 'baseSen', base, 'amountSen', amt) order by rate_bp) from sst), '[]'::jsonb),
    'serviceChargeGroups', coalesce((select jsonb_agg(jsonb_build_object('rateBp', rate_bp, 'baseSen', base, 'amountSen', amt) order by rate_bp) from sc), '[]'::jsonb),
    'grossSen', fin.gross_total, 'catalogDiscountSen', fin.cat_total,                                   -- D
    'itemDiscountSen', fin.item_total, 'billDiscountSen', fin.bill_off,                                -- D
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'catalogDiscountSen', cat_off,  -- D
                                                           'itemDiscountSen', item_off, 'billShareSen', share,
                                                           'netSen', amount) order by ord) from lines), '[]'::jsonb))
  from fin
$$;
revoke all on function pos_compute_bill(jsonb) from public, anon;
grant execute on function pos_compute_bill(jsonb) to authenticated;

-- The live text of migration-2026-10-25-pos-hardening.sql with the lines marked D added. Lines go
-- in order item id order: computeBill gets them in the same order (billView), so a bill
-- discount's leftover sen lands on the same line on both sides.
create or replace function pos_bill_totals(p_bill_id uuid) returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select pos_compute_bill(jsonb_build_object(
    'orderType', b.order_type,
    'tableId', b.table_id,
    'sstRegistered', coalesce(s.sst_registered, true),
    'cashRounding', coalesce(s.cash_rounding, 'nearest_5_sen'),
    'rules', coalesce((
      select jsonb_agg(jsonb_build_object('rateBp', r.rate_bp, 'orderTypes', to_jsonb(r.order_types),
                                          'tableIds', to_jsonb(r.table_ids), 'productIds', to_jsonb(r.product_ids))
                       order by r.sort_order, r.created_at, r.id)
        from service_charge_rules r where r.branch_id = b.branch_id and r.is_active), '[]'::jsonb),
    'billDiscount', case when b.discount_kind is null then null                                         -- D
                         else jsonb_build_object('kind', b.discount_kind, 'value', b.discount_value) end,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object('id', oi.id,                                                  -- D
                                          'productId', oi.product_id, 'unitPriceSen', oi.unit_price_sen, 'qty', oi.qty,
                                          'sstRateBp', oi.sst_rate_bp, 'takeawayFeeSen', oi.takeaway_fee_sen,
                                          'voided', oi.voided_at is not null,
                                          'orderType', oi.order_type,                                   -- H4
                                          'catalogDiscountBp', oi.catalog_discount_bp,                  -- D
                                          'discount', case when oi.discount_kind is null then null      -- D
                                                           else jsonb_build_object('kind', oi.discount_kind, 'value', oi.discount_value) end)
                       order by oi.id)
        from order_items oi where oi.bill_id = b.id), '[]'::jsonb)))
  from bills b
  left join branch_pos_settings s on s.branch_id = b.branch_id
  where b.id = p_bill_id
$$;
revoke all on function pos_bill_totals(uuid) from public, anon;
grant execute on function pos_bill_totals(uuid) to authenticated;
```

- [ ] **Step 3: Run the guard test**

Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts src/features/pos/checkout/bill.test.ts`
Expected: PASS (the new migration's UPDATEs all have a WHERE).

- [ ] **Step 4: Run the migration and the verify on craft-os-dev**

Open the Supabase SQL editor of **craft-os-dev**. Confirm the URL contains `egznnbjmicebbhwasloy` (stop if it shows `yfsoesxzurzjdwstszru`). Paste and run the whole `supabase/migration-2026-10-30-pos-discounts.sql`, then the whole `supabase/migration-2026-10-30-pos-discounts-verify.sql`.
Expected: the verify returns one row `VERIFY OK`. A `FAIL …` error names the check; fix the migration, re-run both.

- [ ] **Step 5: Commit**

```bash
git add supabase/migration-2026-10-30-pos-discounts.sql supabase/migration-2026-10-30-pos-discounts-verify.sql
git commit -m "feat(db): discount columns, catalog discount snapshot, discount log, totals with discounts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Discount RPCs and the merge rule

**Files:**
- Modify: `supabase/migration-2026-10-30-pos-discounts.sql` (append)
- Modify: `supabase/migration-2026-10-30-pos-discounts-verify.sql` (marker `-- @D`)
- Modify: `src/features/pos/sqlSafeUpdate.test.ts`

**Interfaces:**
- Consumes: Task 2 columns, `pos_discount_log`, `pos_check_discount`.
- Produces (called by Task 5's `checkoutApi.ts`): `set_item_discount(p_item_id uuid, p_kind text, p_value integer, p_reason text, p_approver_id uuid, p_pin text) returns jsonb`; `clear_item_discount(p_item_id uuid) returns jsonb`; `set_bill_discount(p_bill_id uuid, p_kind text, p_value integer, p_reason text, p_approver_id uuid, p_pin text) returns jsonb`; `clear_bill_discount(p_bill_id uuid) returns jsonb`. Each returns `{ok: true}` or `{ok: false, error}` (wrong PIN), and raises the Global Constraints words otherwise.

- [ ] **Step 1: Add the guard test**

In `src/features/pos/sqlSafeUpdate.test.ts`, append inside the file (after the last `describe` block):

```ts
describe('the discount RPCs act as the POS session, never auth.uid()', () => {
  it('migration-2026-10-30-pos-discounts.sql', () => {
    const sql = readFileSync(new URL('migration-2026-10-30-pos-discounts.sql', SUPABASE), 'utf8')
    const bodies = functionBodies(sql)
    expect(bodies.map((b) => b.name)).toEqual(expect.arrayContaining([
      'set_item_discount', 'clear_item_discount', 'set_bill_discount', 'clear_bill_discount', 'merge_bills',
    ]))
    for (const { name, body } of bodies) {
      if (/(set_item_discount|clear_item_discount|set_bill_discount|clear_bill_discount|merge_bills)$/i.test(name)) {
        expect(body, name).not.toMatch(/auth\.uid\(\)/)
      }
    }
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts`
Expected: FAIL — the array does not contain `set_item_discount`.

- [ ] **Step 3: Append the RPCs to the migration**

Append to `supabase/migration-2026-10-30-pos-discounts.sql`:

```sql
-- ── D3. Discounts on an open bill ───────────────────────────────────────────
-- Like void_order_item: the bill row locked, the item read again under the lock, the reason
-- and the supervisor's PIN checked, the change logged, bills.updated_at bumped so the other
-- tablets hear of it at once. Setting again replaces; it never stacks.
create or replace function set_item_discount(p_item_id uuid, p_kind text, p_value integer, p_reason text,
                                             p_approver_id uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_item   order_items;
  v_bill   bills;
  v_reason text;
  v_err    text;
begin
  perform pos_check_discount(p_kind, p_value);
  select * into v_item from order_items where id = p_item_id;
  if not found then raise exception 'Item not found'; end if;
  select * into v_bill from bills where id = v_item.bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Item not found'; end if;
  select * into v_item from order_items where id = p_item_id;            -- again, under the bill lock
  if v_item.bill_id <> v_bill.id then raise exception 'The bill just changed — please try again'; end if;
  if v_bill.status <> 'open' then raise exception 'Only an open bill can be discounted'; end if;
  if v_item.voided_at is not null then raise exception 'A voided item cannot be discounted'; end if;
  v_reason := pos_check_reason(v_branch, 'discount', p_reason);
  v_err := pos_check_approver(v_branch, p_approver_id, p_pin);
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  update order_items
     set discount_kind = p_kind, discount_value = p_value, discount_reason = v_reason,
         discount_approved_by = p_approver_id, discount_by = pos_actor(), discount_at = now()
   where id = p_item_id;
  insert into pos_discount_log(branch_id, bill_id, order_item_id, action, kind, value, reason, approved_by, actor)
  values (v_branch, v_bill.id, p_item_id, 'set', p_kind, p_value, v_reason, p_approver_id, pos_actor());
  update bills set updated_at = now() where id = v_bill.id;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function set_item_discount(uuid, text, integer, text, uuid, text) from public, anon;
grant execute on function set_item_discount(uuid, text, integer, text, uuid, text) to authenticated;

-- No PIN: removing a discount only raises the price. Logged with who removed it.
create or replace function clear_item_discount(p_item_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_item   order_items;
  v_bill   bills;
begin
  select * into v_item from order_items where id = p_item_id;
  if not found then raise exception 'Item not found'; end if;
  select * into v_bill from bills where id = v_item.bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Item not found'; end if;
  select * into v_item from order_items where id = p_item_id;            -- again, under the bill lock
  if v_item.bill_id <> v_bill.id then raise exception 'The bill just changed — please try again'; end if;
  if v_bill.status <> 'open' then raise exception 'Discounts can only change on an open bill'; end if;
  if v_item.discount_kind is null then return jsonb_build_object('ok', true); end if;   -- a retry
  update order_items
     set discount_kind = null, discount_value = null, discount_reason = null,
         discount_approved_by = null, discount_by = null, discount_at = null
   where id = p_item_id;
  insert into pos_discount_log(branch_id, bill_id, order_item_id, action, kind, value, reason, actor)
  values (v_branch, v_bill.id, p_item_id, 'clear', v_item.discount_kind, v_item.discount_value, v_item.discount_reason, pos_actor());
  update bills set updated_at = now() where id = v_bill.id;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function clear_item_discount(uuid) from public, anon;
grant execute on function clear_item_discount(uuid) to authenticated;

create or replace function set_bill_discount(p_bill_id uuid, p_kind text, p_value integer, p_reason text,
                                             p_approver_id uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_bill   bills;
  v_reason text;
  v_err    text;
begin
  perform pos_check_discount(p_kind, p_value);
  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  if v_bill.status <> 'open' then raise exception 'Only an open bill can be discounted'; end if;
  v_reason := pos_check_reason(v_branch, 'discount', p_reason);
  v_err := pos_check_approver(v_branch, p_approver_id, p_pin);
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  update bills
     set discount_kind = p_kind, discount_value = p_value, discount_reason = v_reason,
         discount_approved_by = p_approver_id, discount_by = pos_actor(), discount_at = now(), updated_at = now()
   where id = p_bill_id;
  insert into pos_discount_log(branch_id, bill_id, action, kind, value, reason, approved_by, actor)
  values (v_branch, p_bill_id, 'set', p_kind, p_value, v_reason, p_approver_id, pos_actor());
  return jsonb_build_object('ok', true);
end $$;
revoke all on function set_bill_discount(uuid, text, integer, text, uuid, text) from public, anon;
grant execute on function set_bill_discount(uuid, text, integer, text, uuid, text) to authenticated;

create or replace function clear_bill_discount(p_bill_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_bill   bills;
begin
  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  if v_bill.status <> 'open' then raise exception 'Discounts can only change on an open bill'; end if;
  if v_bill.discount_kind is null then return jsonb_build_object('ok', true); end if;   -- a retry
  update bills
     set discount_kind = null, discount_value = null, discount_reason = null,
         discount_approved_by = null, discount_by = null, discount_at = null, updated_at = now()
   where id = p_bill_id;
  insert into pos_discount_log(branch_id, bill_id, action, kind, value, reason, actor)
  values (v_branch, p_bill_id, 'clear', v_bill.discount_kind, v_bill.discount_value, v_bill.discount_reason, pos_actor());
  return jsonb_build_object('ok', true);
end $$;
revoke all on function clear_bill_discount(uuid) from public, anon;
grant execute on function clear_bill_discount(uuid) to authenticated;

-- merge_bills: the live text of migration-2026-10-29-pos-device-till.sql with the line marked D
-- added — a bill discount does not move with its items, so the source bill must drop it first.
CREATE OR REPLACE FUNCTION merge_bills(p_from_bill uuid, p_into_bill uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch uuid := pos_my_branch();
  v_from   bills;
  v_into   bills;
begin
  if p_from_bill is null or p_into_bill is null or p_from_bill = p_into_bill then
    raise exception 'Choose two different bills';
  end if;
  -- lock both in one fixed order, so two iPads merging the same pair cannot deadlock
  perform 1 from bills where id in (p_from_bill, p_into_bill) order by id for update;
  select * into v_from from bills where id = p_from_bill and branch_id = v_branch;
  select * into v_into from bills where id = p_into_bill and branch_id = v_branch;
  if v_from.id is null or v_into.id is null then raise exception 'Bill not found'; end if;
  if v_from.status <> 'open' or v_into.status <> 'open' then raise exception 'Only open bills can be merged'; end if;
  if v_from.discount_kind is not null then raise exception 'Remove the bill discount before merging'; end if;   -- D
  if v_from.order_type = 'dine_in' and v_into.order_type = 'takeaway' then
    raise exception 'Merge the takeaway bill into the table''s bill, not the other way round';
  end if;
  update orders set bill_id = v_into.id where bill_id = v_from.id;
  update order_items set bill_id = v_into.id where bill_id = v_from.id;
  update bills
     set pax = case when v_into.pax is null and v_from.pax is null then null
                    else least(99, coalesce(v_into.pax, 0) + coalesce(v_from.pax, 0)) end
   where id = v_into.id;
  update bills
     set status = 'merged', merged_into = v_into.id, closed_at = now(), closed_by = pos_actor(), closed_device_id = pos_current_device()
   where id = v_from.id;
end $function$;
```

Before pasting `merge_bills`, diff it against the live text in `supabase/migration-2026-10-29-pos-device-till.sql` (the block after `-- merge_bills: re-created`): the only difference must be the `-- D` line. If that file changed since this plan was written, copy its current text and add the `-- D` line after the `'Only open bills can be merged'` check.

- [ ] **Step 4: Write verify section D**

Replace the line `-- @D` in the verify file with:

```sql
  -- ── D. item and bill discounts: value, reason, PIN, open bills only, logged; merge rule ──
  perform pg_temp.act(v_dev);
  perform pg_temp.expect_error(format('select set_item_discount(%L, %L, 150, %L, %L, %L)', v_item2, 'percent', 'Regular', v_sup, '2222'),
    'Enter a whole percent from 1 to 100', 'D percent with a fraction');
  perform pg_temp.expect_error(format('select set_item_discount(%L, %L, 0, %L, %L, %L)', v_item2, 'amount', 'Regular', v_sup, '2222'),
    'Enter an amount above RM 0.00', 'D zero amount');
  perform pg_temp.expect_error(format('select set_item_discount(%L, %L, 1000, %L, %L, %L)', v_item2, 'percent', '', v_sup, '2222'),
    'Choose a reason', 'D no reason');
  v_res := set_item_discount(v_item2, 'percent', 1000, 'Regular', v_sup, '9999');
  if coalesce((v_res->>'ok')::boolean, true) then raise exception 'FAIL D: a wrong PIN was accepted: %', v_res; end if;
  v_res := set_item_discount(v_item2, 'percent', 1000, 'Regular', v_cash, '1111');
  if coalesce((v_res->>'ok')::boolean, true) then raise exception 'FAIL D: a cashier without pos_supervise approved: %', v_res; end if;
  v_res := set_item_discount(v_item2, 'percent', 1000, 'Regular', v_sup, '2222');
  if not coalesce((v_res->>'ok')::boolean, false)
     or (select discount_kind || ':' || discount_value || ':' || discount_reason from order_items where id = v_item2) is distinct from 'percent:1000:Regular'
     or (select discount_approved_by from order_items where id = v_item2) is distinct from v_sup
     or (select discount_by from order_items where id = v_item2) is distinct from v_cash then
    raise exception 'FAIL D: the item discount: %', v_res;
  end if;
  v_res := set_item_discount(v_item2, 'amount', 500, 'Regular', v_sup, '2222');   -- set again: replaces
  if (select discount_kind || ':' || discount_value from order_items where id = v_item2) is distinct from 'amount:500' then
    raise exception 'FAIL D: setting again did not replace the item discount';
  end if;
  -- 21.50 + (43.00 − 5.00) = 59.50; a 10% bill discount = 5.95
  v_res := set_bill_discount(v_bill, 'percent', 1000, 'Regular', v_sup, '2222');
  v_tot := pos_bill_totals(v_bill);
  if not coalesce((v_res->>'ok')::boolean, false) or (v_tot->>'itemDiscountSen')::int is distinct from 500
     or (v_tot->>'subtotalSen')::int is distinct from 5950 or (v_tot->>'billDiscountSen')::int is distinct from 595 then
    raise exception 'FAIL D: the bill discount: % %', v_res, v_tot;
  end if;
  v_order := place_counter_order(v_t2, 'dine_in', 1, v_items, gen_random_uuid());
  v_bill2 := (select bill_id from orders where id = v_order);
  perform pg_temp.expect_error(format('select merge_bills(%L, %L)', v_bill, v_bill2),
    'Remove the bill discount before merging', 'D merge with a bill discount');
  v_res := clear_bill_discount(v_bill);                                               -- no PIN
  if not coalesce((v_res->>'ok')::boolean, false) or (select discount_kind from bills where id = v_bill) is not null then
    raise exception 'FAIL D: clearing the bill discount: %', v_res;
  end if;
  v_res := clear_bill_discount(v_bill);                                               -- a retry
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL D: clearing twice: %', v_res; end if;
  if (select count(*) from pos_discount_log where bill_id = v_bill) <> 4                -- item set ×2, bill set, bill clear
     or (select count(*) from pos_discount_log where bill_id = v_bill and action = 'clear' and actor = v_cash and approved_by is null) <> 1 then
    raise exception 'FAIL D: the discount log';
  end if;
  perform merge_bills(v_bill, v_bill2);                                               -- the item discount travels
  if (select bill_id from order_items where id = v_item2) is distinct from v_bill2
     or (select discount_kind from order_items where id = v_item2) is distinct from 'amount' then
    raise exception 'FAIL D: the item discount did not travel with its item';
  end if;
  -- 21.50 + 38.00 + 43.00 = 102.50; RM 10.00 off shared 2.09 / 3.70 / 4.21 (the 2 leftover sen to 43.00);
  -- 92.50 + service charge 9.25 + SST 5.55 = 107.30
  v_res := set_bill_discount(v_bill2, 'amount', 1000, 'Regular', v_sup, '2222');
  v_tot := pos_bill_totals(v_bill2);
  if (v_tot->>'totalSen')::int is distinct from 10730 then raise exception 'FAIL D: totals after the merge: %', v_tot; end if;
  v_res := checkout_bill(v_bill2, jsonb_build_array(jsonb_build_object('methodId', v_card, 'amountSen', 10730)), gen_random_uuid());
  if (v_res->>'billId')::uuid is distinct from v_bill2 then raise exception 'FAIL D checkout: %', v_res; end if;
  perform pg_temp.expect_error(format('select set_item_discount(%L, %L, 1000, %L, %L, %L)', v_item2, 'percent', 'Regular', v_sup, '2222'),
    'Only an open bill can be discounted', 'D paid bill');
  perform pg_temp.expect_error(format('select clear_bill_discount(%L)', v_bill2),
    'Discounts can only change on an open bill', 'D paid bill clear');
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts`
Expected: PASS.

- [ ] **Step 6: Run on craft-os-dev**

Same as Task 2 Step 4: confirm `egznnbjmicebbhwasloy` in the URL, run the whole migration, then the whole verify.
Expected: `VERIFY OK`.

- [ ] **Step 7: Commit**

```bash
git add supabase/migration-2026-10-30-pos-discounts.sql supabase/migration-2026-10-30-pos-discounts-verify.sql src/features/pos/sqlSafeUpdate.test.ts
git commit -m "feat(db): set and clear item and bill discounts with PIN and log; merge waits for a bill discount's removal

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Receipt and Z report

**Files:**
- Modify: `supabase/migration-2026-10-30-pos-discounts.sql` (append `pos_receipt_payload`, `pos_shift_report`)
- Modify: `supabase/migration-2026-10-30-pos-discounts-verify.sql` (marker `-- @E`)
- Modify: `src/features/pos/print/receipt.ts`, `src/features/pos/print/receipt.test.ts`
- Modify: `src/features/pos/print/zreport.ts`, `src/features/pos/print/zreport.test.ts`

**Interfaces:**
- Consumes: `bills.totals->'lines'` (with `id`, `catalogDiscountSen`, `itemDiscountSen`), `billDiscountSen`, `grossSen`, `catalogDiscountSen`, `itemDiscountSen` from Task 2.
- Produces: `ReceiptItem.discounts?: ReceiptDiscount[]` (`{ label: string; amountSen: number }`), `ReceiptPayload.billDiscountSen?: number`; `ZReport.sales.beforeDiscountsSen?: number`, `ZReport.sales.discountSen?: number`, `ZReport.discounts?: ZReportDiscounts` (`{ catalogSen; catalogBills; itemSen; itemCount; billSen; billCount }`). Optional because receipts queued and Z reports frozen before this change lack them.

- [ ] **Step 1: Write the failing print tests**

Append to `src/features/pos/print/receipt.test.ts` (add `renderReceiptLines` and `type ReceiptPayload` to its import from `./receipt` if they are not imported yet):

```ts
describe('receipt discounts', () => {
  const base: ReceiptPayload = {
    kind: 'receipt', route: 'Bar', reprint: false,
    header: { title: 'Craft Cafe', legalName: null, registrationNo: null, sstNo: null, address: null, phone: null, email: null },
    billNo: 'B0001', closedAt: '2026-10-30T04:00:00.000Z', cashier: 'Ali', tableLabel: 'T1', pax: 2,
    items: [{ qty: 1, name: 'Baked Salmon Steak', unitSen: 4300, amountSen: 4300, mods: [],
              discounts: [{ label: 'Staff Meal 50%', amountSen: 2150 }, { label: 'Discount 10%', amountSen: 215 }] }],
    itemCount: 1, subtotalSen: 1935, billDiscountSen: 500, sstGroups: [], serviceChargeGroups: [],
    takeawayFeeSen: 0, roundingSen: 0, totalSen: 1435, payments: [], changeSen: 0, footer: 'Thank you',
  }
  it('prints each discount under its item and the bill discount under the subtotal', () => {
    const lines = renderReceiptLines(base, 32)
    const staff = lines.findIndex((l) => /^ {3}Staff Meal 50% +-21\.50$/.test(l))
    const own = lines.findIndex((l) => /^ {3}Discount 10% +-2\.15$/.test(l))
    const sub = lines.findIndex((l) => /^Subtotal +19\.35$/.test(l))
    expect(staff).toBeGreaterThan(lines.findIndex((l) => l.startsWith('1 Baked Salmon')))   // under its item (the name may wrap)
    expect(own).toBe(staff + 1)
    expect(sub).toBeGreaterThan(own)
    expect(lines[sub + 1]).toMatch(/^Discount +-5\.00$/)
    expect(lines.every((l) => l.length <= 32)).toBe(true)
  })
  it('a receipt queued before discounts existed prints as before', () => {
    const { billDiscountSen: _b, ...old } = base
    const lines = renderReceiptLines({ ...old, items: [{ ...base.items[0], discounts: undefined }] } as ReceiptPayload, 32)
    expect(lines.some((l) => l.includes('Discount'))).toBe(false)
  })
})
```

Append to `src/features/pos/print/zreport.test.ts` (it already has `shiftOne` and `payload`):

```ts
describe('Z report discounts', () => {
  it('shows Gross before discounts and Discounts above Gross sales, and a DISCOUNTS section', () => {
    const report: ZReport = {
      ...shiftOne,
      sales: { ...shiftOne.sales, beforeDiscountsSen: shiftOne.sales.grossSen + 3650, discountSen: 3650 },
      discounts: { catalogSen: 2150, catalogBills: 1, itemSen: 500, itemCount: 1, billSen: 1000, billCount: 1 },
    }
    const lines = renderZReportLines(payload(report), 48)
    const gross = lines.findIndex((l) => l.startsWith('Gross sales'))
    expect(lines[gross - 2].startsWith('Gross before discounts')).toBe(true)
    expect(lines[gross - 1]).toMatch(/^Discounts\s+-36\.50$/)
    expect(lines).toContain('DISCOUNTS')
    expect(lines.some((l) => /^Staff Meal \(1 bill\)\s+-21\.50$/.test(l))).toBe(true)
    expect(lines.some((l) => /^Item discounts \(1\)\s+-5\.00$/.test(l))).toBe(true)
    expect(lines.some((l) => /^Bill discounts \(1 bill\)\s+-10\.00$/.test(l))).toBe(true)
  })
  it('a shift with none says so; a report frozen before discounts has no section', () => {
    const none = { ...shiftOne, discounts: { catalogSen: 0, catalogBills: 0, itemSen: 0, itemCount: 0, billSen: 0, billCount: 0 } }
    expect(renderZReportLines(payload(none), 48)).toContain('No discounts')
    expect(renderZReportLines(payload(shiftOne), 48)).not.toContain('DISCOUNTS')
  })
})
```

Before relying on `lines).toContain('DISCOUNTS')`, check how `section(title, …)` prints its title in `zreport.ts` (e.g. `'SALES SUMMARY'` on its own line). If it decorates the title, change the two `'DISCOUNTS'` expectations to that exact form.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/features/pos/print/receipt.test.ts src/features/pos/print/zreport.test.ts`
Expected: FAIL — no discount lines.

- [ ] **Step 3: Receipt rendering**

In `src/features/pos/print/receipt.ts`:

Add after `export interface ReceiptItem { … }`'s `mods: string[]` line, inside the interface:

```ts
  discounts?: ReceiptDiscount[] // its catalog and item discounts (absent on receipts queued before discounts)
```

Add above `export interface ReceiptCharge`:

```ts
export interface ReceiptDiscount {
  label: string // "Staff Meal 50%", "Discount 10%", "Discount"
  amountSen: number
}
```

In `ReceiptPayload`, after `subtotalSen: number`, add:

```ts
  billDiscountSen?: number // absent on receipts queued before discounts
```

In `itemLines`, replace the last array entry `...it.mods.flatMap(…),` block so the function returns:

```ts
  return [
    `${parts[0].padEnd(width)} ${amount}`,
    ...parts.slice(1),
    ...it.mods.flatMap((m) => wrap(`+ ${m}`, cols - 3, '  ').map((s) => `   ${s}`)),
    ...(it.discounts ?? []).flatMap((d) => lr(`   ${d.label}`, money(-d.amountSen), cols)),
  ]
```

In `renderReceiptLines`, after the `...lr('Subtotal', money(r.subtotalSen), cols),` line add:

```ts
    ...((r.billDiscountSen ?? 0) > 0 ? lr('Discount', money(-(r.billDiscountSen ?? 0)), cols) : []),
```

- [ ] **Step 4: Z report rendering**

In `src/features/pos/print/zreport.ts`:

Replace the `sales:` line of `interface ZReport` with:

```ts
  sales: {
    grossSen: number; takeawayFeeSen: number; serviceChargeSen: number; sstSen: number; roundingSen: number; nettSen: number
    beforeDiscountsSen?: number // absent on reports frozen before discounts
    discountSen?: number
  }
  discounts?: ZReportDiscounts
```

Add above `export interface ZReport`:

```ts
export interface ZReportDiscounts {
  catalogSen: number // catalog discounts (Staff Meal)
  catalogBills: number
  itemSen: number
  itemCount: number
  billSen: number
  billCount: number
}

function discountLines(d: ZReportDiscounts, cols: number): string[] {
  if (d.catalogSen + d.itemSen + d.billSen === 0) return ['No discounts']
  const bills = (n: number) => `${n} bill${n === 1 ? '' : 's'}`
  return [
    ...lr(`Staff Meal (${bills(d.catalogBills)})`, money(-d.catalogSen), cols),
    ...lr(`Item discounts (${d.itemCount})`, money(-d.itemSen), cols),
    ...lr(`Bill discounts (${bills(d.billCount)})`, money(-d.billSen), cols),
  ]
}
```

Replace the `...section('SALES SUMMARY', [` block's first line `...lr('Gross sales', money(r.sales.grossSen), cols),` with:

```ts
      ...(r.sales.discountSen
        ? [...lr('Gross before discounts', money(r.sales.beforeDiscountsSen ?? 0), cols), ...lr('Discounts', money(-r.sales.discountSen), cols)]
        : []),
      ...lr('Gross sales', money(r.sales.grossSen), cols),
```

and right after the closing `]),` of the SALES SUMMARY section add:

```ts
    ...(r.discounts ? section('DISCOUNTS', discountLines(r.discounts, cols)) : []),
```

Also change the doc comment's "without discount, delivery and member sections" to "without delivery and member sections".

- [ ] **Step 5: Run the print tests**

Run: `npx vitest run src/features/pos/print/`
Expected: PASS (the existing Z report and receipt cases unchanged).

- [ ] **Step 6: Append the receipt and Z report SQL**

Append to `supabase/migration-2026-10-30-pos-discounts.sql`:

```sql
-- ── D4. Receipt: the live text of migration-2026-10-24-pos-checkout-fn.sql with the lines marked D
--    added — each item's catalog and item discounts (amounts from the frozen totals' lines) and
--    the bill discount. Exactly ReceiptPayload (src/features/pos/print/receipt.ts). ─
create or replace function pos_receipt_payload(p_bill_id uuid, p_reprint boolean) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'kind', 'receipt',
    'route', s.receipt_route,
    'reprint', p_reprint,
    'header', jsonb_build_object(
      'title', coalesce(nullif(trim(br.receipt_title), ''), br.name),
      'legalName', nullif(trim(br.legal_name), ''),
      'registrationNo', nullif(trim(br.registration_no), ''),
      'sstNo', nullif(trim(br.sst_no), ''),
      'address', nullif(trim(br.address), ''),
      'phone', nullif(trim(br.phone), ''),
      'email', nullif(trim(br.email), '')),
    'billNo', b.bill_no,
    'closedAt', to_char(b.closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'cashier', (select st.name from staff st where st.id = b.closed_by),
    'tableLabel', t.label,
    'pax', b.pax,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'qty', oi.qty, 'name', oi.name_snapshot, 'unitSen', oi.unit_price_sen,
               'amountSen', oi.unit_price_sen * oi.qty,
               'mods', (select coalesce(jsonb_agg(m->>'name' order by ord), '[]'::jsonb)
                          from jsonb_array_elements(oi.modifiers_snapshot) with ordinality as x(m, ord)),
               'discounts', (select coalesce(jsonb_agg(d.j order by d.k), '[]'::jsonb) from (                -- D
                   select 1 as k, jsonb_build_object(
                            'label', coalesce(oi.catalog_discount_name, 'Catalog') || ' ' || (oi.catalog_discount_bp / 100) || '%',
                            'amountSen', (ln.l->>'catalogDiscountSen')::integer) as j
                    where coalesce((ln.l->>'catalogDiscountSen')::integer, 0) > 0
                   union all
                   select 2, jsonb_build_object(
                            'label', case when oi.discount_kind = 'percent' then 'Discount ' || (oi.discount_value / 100) || '%'
                                          else 'Discount' end,
                            'amountSen', (ln.l->>'itemDiscountSen')::integer)
                    where coalesce((ln.l->>'itemDiscountSen')::integer, 0) > 0) d))
             order by o.placed_at, oi.name_snapshot, oi.id)
        from order_items oi join orders o on o.id = oi.order_id
        left join lateral (select x.l from jsonb_array_elements(coalesce(b.totals->'lines', '[]'::jsonb)) as x(l)  -- D
                            where x.l->>'id' = oi.id::text) ln on true
       where oi.bill_id = b.id and oi.voided_at is null), '[]'::jsonb),
    'itemCount', (select coalesce(sum(oi.qty), 0) from order_items oi where oi.bill_id = b.id and oi.voided_at is null),
    'subtotalSen', b.subtotal_sen,
    'billDiscountSen', coalesce((b.totals->>'billDiscountSen')::integer, 0),                                -- D
    'sstGroups', coalesce(b.totals->'sstGroups', '[]'::jsonb),
    'serviceChargeGroups', coalesce(b.totals->'serviceChargeGroups', '[]'::jsonb),
    'takeawayFeeSen', b.takeaway_fee_sen,
    'roundingSen', b.rounding_sen,
    'totalSen', b.total_sen,
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object('name', p.method_name, 'kind', p.kind, 'amountSen', p.amount_sen,
                                          'tenderedSen', p.tendered_sen, 'reference', p.reference)
                       order by p.line_no, p.id)
        from payments p where p.bill_id = b.id), '[]'::jsonb),
    'changeSen', (select coalesce(sum(p.change_sen), 0) from payments p where p.bill_id = b.id),
    'footer', coalesce(s.receipt_footer, 'This is an official receipt. Thank you for visiting us.'))
  from bills b
  join branches br on br.id = b.branch_id
  left join branch_pos_settings s on s.branch_id = b.branch_id
  left join dining_tables t on t.id = b.table_id
  where b.id = p_bill_id
$$;
revoke all on function pos_receipt_payload(uuid, boolean) from public, anon, authenticated;
```

Before pasting, diff it against the live `pos_receipt_payload` in `supabase/migration-2026-10-24-pos-checkout-fn.sql`; the only differences must be the lines marked `-- D` (and the `left join lateral` line).

Then append `pos_shift_report`: copy the whole live `create or replace function pos_shift_report(p_shift_id uuid) …` through its `revoke all on function pos_shift_report(uuid) from public, anon, authenticated;` line from `supabase/migration-2026-10-25-pos-hardening.sql`, put this comment above it:

```sql
-- ── D4. Z report: the live text of migration-2026-10-25-pos-hardening.sql with the lines marked D
--    changed — gross sales net of bill discounts, Before discounts / Discounts, and a Discounts
--    section. Exactly ZReport in src/features/pos/print/zreport.ts. Internal. ─
```

and make exactly these three edits in the copy:

(a) Replace the whole `t as ( … from sb ),` CTE with:

```sql
  t as (
    select count(*)::integer as bill_count, coalesce(sum(sb.pax), 0)::integer as pax,
           coalesce(sum(sb.subtotal_sen - coalesce((sb.totals->>'billDiscountSen')::integer, 0)), 0)::integer as gross,   -- D
           coalesce(sum(sb.takeaway_fee_sen), 0)::integer as fee,
           coalesce(sum(sb.service_charge_sen), 0)::integer as sc, coalesce(sum(sb.sst_sen), 0)::integer as sst,
           coalesce(sum(sb.rounding_sen), 0)::integer as rounding, coalesce(sum(sb.total_sen), 0)::integer as nett,
           coalesce(sum(coalesce((sb.totals->>'grossSen')::integer, sb.subtotal_sen)), 0)::integer as before_disc,           -- D
           coalesce(sum(coalesce((sb.totals->>'catalogDiscountSen')::integer, 0)), 0)::integer as cat_disc,                  -- D
           coalesce(sum(coalesce((sb.totals->>'itemDiscountSen')::integer, 0)), 0)::integer as item_disc,                    -- D
           coalesce(sum(coalesce((sb.totals->>'billDiscountSen')::integer, 0)), 0)::integer as bill_disc,                    -- D
           (count(*) filter (where coalesce((sb.totals->>'catalogDiscountSen')::integer, 0) > 0))::integer as cat_bills,      -- D
           (count(*) filter (where coalesce((sb.totals->>'billDiscountSen')::integer, 0) > 0))::integer as bill_disc_bills   -- D
      from sb
  ),
```

(b) Replace the `'sales', jsonb_build_object( … ),` entry with:

```sql
    'sales', jsonb_build_object(
      'grossSen', t.gross, 'takeawayFeeSen', t.fee, 'serviceChargeSen', t.sc, 'sstSen', t.sst,
      'roundingSen', t.rounding, 'nettSen', t.nett,
      'beforeDiscountsSen', t.before_disc, 'discountSen', t.cat_disc + t.item_disc + t.bill_disc),                       -- D
    'discounts', jsonb_build_object(                                                                                       -- D
      'catalogSen', t.cat_disc, 'catalogBills', t.cat_bills,
      'itemSen', t.item_disc,
      'itemCount', (select count(*)::integer from sb, jsonb_array_elements(coalesce(sb.totals->'lines', '[]'::jsonb)) as x(l)
                     where coalesce((x.l->>'itemDiscountSen')::integer, 0) > 0),
      'billSen', t.bill_disc, 'billCount', t.bill_disc_bills),
```

(c) Nothing else changes; `'products'` stays at list prices.

- [ ] **Step 7: Write verify section E**

Replace the line `-- @E` in the verify file with:

```sql
  -- ── E. receipt and Z report ───────────────────────────────────────────────
  v_res := pos_receipt_payload(v_bill2, false);
  if (v_res->>'billDiscountSen')::int is distinct from 1000
     or (select count(*) from jsonb_array_elements(v_res->'items') i, jsonb_array_elements(i->'discounts') d) <> 2
     or not exists (select 1 from jsonb_array_elements(v_res->'items') i, jsonb_array_elements(i->'discounts') d
                     where d->>'label' = 'VERIFY D STAFF MEAL 50%' and (d->>'amountSen')::int = 2150)
     or not exists (select 1 from jsonb_array_elements(v_res->'items') i, jsonb_array_elements(i->'discounts') d
                     where d->>'label' = 'Discount' and (d->>'amountSen')::int = 500) then
    raise exception 'FAIL E receipt: %', v_res;
  end if;
  v_res := pos_shift_report(v_shift);
  if v_res->'discounts' is distinct from
       '{"catalogSen": 2150, "catalogBills": 1, "itemSen": 500, "itemCount": 1, "billSen": 1000, "billCount": 1}'::jsonb
     or (v_res->'sales'->>'beforeDiscountsSen')::int is distinct from 12900
     or (v_res->'sales'->>'discountSen')::int is distinct from 3650
     or (v_res->'sales'->>'grossSen')::int is distinct from 9250 then
    raise exception 'FAIL E Z report: % %', v_res->'discounts', v_res->'sales';
  end if;
```

- [ ] **Step 8: Run on craft-os-dev**

Confirm `egznnbjmicebbhwasloy` in the URL; run the whole migration, then the whole verify.
Expected: `VERIFY OK`.

- [ ] **Step 9: Commit**

```bash
git add supabase/migration-2026-10-30-pos-discounts.sql supabase/migration-2026-10-30-pos-discounts-verify.sql src/features/pos/print/receipt.ts src/features/pos/print/receipt.test.ts src/features/pos/print/zreport.ts src/features/pos/print/zreport.test.ts
git commit -m "feat(pos): discounts on the receipt and in the Z report

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Client data — discount helpers, reads, calls and the bill view

**Files:**
- Create: `src/features/pos/checkout/discounts.ts`, `src/features/pos/checkout/discounts.test.ts`, `src/features/pos/checkout/DiscountRows.tsx`
- Modify: `src/features/pos/checkout/reasons.ts`, `src/features/pos/checkout/checkoutApi.ts`
- Modify: `src/features/pos/order/posApi.ts`, `src/features/pos/order/catalogs.ts`
- Modify: `src/features/pos/order/billView.ts`, `src/features/pos/order/billView.test.ts`

**Interfaces:**
- Consumes: Task 1 `DiscountKind`, `DiscountInput`, `discountOffSen`, `lineDiscounts`, `formatRate`; Task 3 RPC names and arguments.
- Produces (used by Tasks 6–7):
  - `discounts.ts`: `QUICK_PERCENTS: readonly [5, 10, 20, 50]`; `interface DiscountRow { label: string; amountSen: number }`; `interface StoredDiscount { kind: DiscountKind; value: number; reason: string | null }`; `discountProblem(kind, text): string | null`; `parseDiscount(kind, text): DiscountInput | null`; `discountLabel(d: StoredDiscount, withReason: boolean): string`; `storedDiscount(row): StoredDiscount | null`; `linesById(t): Map<string, BillLineTotals>`; `lineDiscountRows(item, amounts): DiscountRow[]`; `catalogTag(items): string | null`.
  - `DiscountRows` component `{ rows: DiscountRow[] }`.
  - `checkoutApi.ts`: `setItemDiscount(itemId, d: DiscountInput, a: Approval)`, `clearItemDiscount(itemId)`, `setBillDiscount(billId, d, a)`, `clearBillDiscount(billId)`, all `Promise<void>`; `ClosedBillDetail.billDiscount: StoredDiscount | null`.
  - `BillItemRow` gains `catalog_discount_bp: number; catalog_discount_name: string | null; discount_kind: DiscountKind | null; discount_value: number | null; discount_reason: string | null`. `OpenBillRow` gains `discount_kind`, `discount_value`, `discount_reason` (same types). `CatalogRow` gains `discount_bp: number`.
  - `ReasonAction` includes `'discount'`.
  - `SentRow` gains `discountRows: DiscountRow[]`, `afterCatalogSen: number`; `BillView` gains `sentSubtotalSen: number`, `billDiscount: DiscountRow | null`, `catalogTag: string | null`; `BillViewInput` gains optional `billDiscount?: StoredDiscount | null`, `draftCatalogDiscountBp?: number`.

- [ ] **Step 1: Write the failing helper tests**

Create `src/features/pos/checkout/discounts.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { catalogTag, discountLabel, discountProblem, lineDiscountRows, linesById, parseDiscount, storedDiscount } from './discounts'

const item = { catalog_discount_bp: 5000, catalog_discount_name: 'Staff Meal', discount_kind: 'percent' as const, discount_value: 1000, discount_reason: 'Regular' }

describe('discountProblem / parseDiscount (the server\'s words)', () => {
  it('a whole percent from 1 to 100', () => {
    expect(discountProblem('percent', '')).toBe('Enter a discount')
    expect(discountProblem('percent', '0')).toBe('Enter a whole percent from 1 to 100')
    expect(discountProblem('percent', '12.5')).toBe('Enter a whole percent from 1 to 100')
    expect(discountProblem('percent', '101')).toBe('Enter a whole percent from 1 to 100')
    expect(parseDiscount('percent', '10')).toEqual({ kind: 'percent', value: 1000 })
    expect(parseDiscount('percent', '100')).toEqual({ kind: 'percent', value: 10000 })
  })
  it('an amount in ringgit above 0.00, at most two decimals', () => {
    expect(discountProblem('amount', '0.00')).toBe('Enter an amount above RM 0.00')
    expect(discountProblem('amount', '1.234')).toBe('Enter an amount above RM 0.00')
    expect(parseDiscount('amount', '4.30')).toEqual({ kind: 'amount', value: 430 })
    expect(parseDiscount('amount', '5')).toEqual({ kind: 'amount', value: 500 })
    expect(parseDiscount('amount', 'abc')).toBeNull()
  })
})

describe('labels and rows', () => {
  it('"Discount 10%" or "Discount", with the reason on screens', () => {
    expect(discountLabel({ kind: 'percent', value: 1000, reason: 'Regular' }, true)).toBe('Discount 10% (Regular)')
    expect(discountLabel({ kind: 'amount', value: 500, reason: 'Regular' }, false)).toBe('Discount')
    expect(discountLabel({ kind: 'amount', value: 500, reason: null }, true)).toBe('Discount')
  })
  it('storedDiscount reads the discount_* columns', () => {
    expect(storedDiscount(item)).toEqual({ kind: 'percent', value: 1000, reason: 'Regular' })
    expect(storedDiscount({ discount_kind: null, discount_value: null, discount_reason: null })).toBeNull()
  })
  it('a line shows what actually came off: catalog first, then its own discount', () => {
    expect(lineDiscountRows(item, { catalogDiscountSen: 1250, itemDiscountSen: 125 })).toEqual([
      { label: 'Staff Meal 50%', amountSen: 1250 },
      { label: 'Discount 10% (Regular)', amountSen: 125 },
    ])
    expect(lineDiscountRows(item, { catalogDiscountSen: 0, itemDiscountSen: 0 })).toEqual([])
    expect(lineDiscountRows(item, undefined)).toEqual([])
  })
  it('linesById skips drafts and old totals without lines', () => {
    const t = { lines: [{ id: 'a', catalogDiscountSen: 0, itemDiscountSen: 0, billShareSen: 0, netSen: 1 }, { id: null, catalogDiscountSen: 0, itemDiscountSen: 0, billShareSen: 0, netSen: 2 }] }
    expect([...linesById(t as never).keys()]).toEqual(['a'])
    expect(linesById({} as never).size).toBe(0)
    expect(linesById(null).size).toBe(0)
  })
  it('the bill tag comes from the first live item with a catalog discount', () => {
    expect(catalogTag([{ ...item, voided_at: '2026-10-30T01:00:00Z' }, { ...item, voided_at: null }])).toBe('Staff Meal 50%')
    expect(catalogTag([{ ...item, catalog_discount_bp: 0, voided_at: null }])).toBeNull()
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/features/pos/checkout/discounts.test.ts`
Expected: FAIL — cannot find `./discounts`.

- [ ] **Step 3: Create `src/features/pos/checkout/discounts.ts`**

```ts
// src/features/pos/checkout/discounts.ts
/** Discounts (docs/superpowers/specs/2026-10-30-pos-discounts-design.md): what the cashier types,
 *  the server's words for a bad value, and the grey rows under a discounted line. The money is
 *  computeBill's (bill.ts) and the server's. */
import { formatRate, type BillLineTotals, type BillTotals, type DiscountInput, type DiscountKind } from './bill'

export const QUICK_PERCENTS = [5, 10, 20, 50] as const

export interface DiscountRow { label: string; amountSen: number }
/** A discount as the order_items / bills discount_* columns keep it. */
export interface StoredDiscount { kind: DiscountKind; value: number; reason: string | null }

/** The same words as pos_check_discount; null = fine. */
export function discountProblem(kind: DiscountKind, text: string): string | null {
  const t = text.trim()
  if (t === '') return 'Enter a discount'
  if (kind === 'percent') {
    return /^\d{1,3}$/.test(t) && Number(t) >= 1 && Number(t) <= 100 ? null : 'Enter a whole percent from 1 to 100'
  }
  return /^\d{1,6}(\.\d{1,2})?$/.test(t) && Math.round(Number(t) * 100) > 0 ? null : 'Enter an amount above RM 0.00'
}

/** What the cashier typed, as the server stores it: a percent in basis points, ringgit in sen. */
export function parseDiscount(kind: DiscountKind, text: string): DiscountInput | null {
  if (discountProblem(kind, text) !== null) return null
  const n = Number(text.trim())
  return kind === 'percent' ? { kind, value: n * 100 } : { kind, value: Math.round(n * 100) }
}

/** "Discount 10%" or "Discount"; screens add the reason in brackets (the receipt never does). */
export function discountLabel(d: StoredDiscount, withReason: boolean): string {
  const base = d.kind === 'percent' ? `Discount ${formatRate(d.value)}` : 'Discount'
  return withReason && d.reason ? `${base} (${d.reason})` : base
}

export function storedDiscount(row: { discount_kind: DiscountKind | null; discount_value: number | null; discount_reason: string | null }): StoredDiscount | null {
  return row.discount_kind && row.discount_value !== null ? { kind: row.discount_kind, value: row.discount_value, reason: row.discount_reason } : null
}

/** BillTotals.lines by order item id (drafts have no id; bills paid before discounts have no lines). */
export function linesById(t: BillTotals | null | undefined): Map<string, BillLineTotals> {
  return new Map((t?.lines ?? []).flatMap((l) => (l.id ? [[l.id, l] as const] : [])))
}

/** The grey rows under a line: its catalog discount, then its own — only what actually came off. */
export function lineDiscountRows(
  item: { catalog_discount_bp: number; catalog_discount_name: string | null; discount_kind: DiscountKind | null; discount_value: number | null; discount_reason: string | null },
  amounts: Pick<BillLineTotals, 'catalogDiscountSen' | 'itemDiscountSen'> | undefined,
): DiscountRow[] {
  if (!amounts) return []
  const rows: DiscountRow[] = []
  if (amounts.catalogDiscountSen > 0) {
    rows.push({ label: `${item.catalog_discount_name ?? 'Catalog'} ${formatRate(item.catalog_discount_bp)}`, amountSen: amounts.catalogDiscountSen })
  }
  const d = storedDiscount(item)
  if (d && amounts.itemDiscountSen > 0) rows.push({ label: discountLabel(d, true), amountSen: amounts.itemDiscountSen })
  return rows
}

/** The tag at the top of a bill with a catalog discount: "Staff Meal 50%". */
export function catalogTag(items: { catalog_discount_bp: number; catalog_discount_name: string | null; voided_at: string | null }[]): string | null {
  const it = items.find((i) => i.voided_at === null && i.catalog_discount_bp > 0)
  return it ? `${it.catalog_discount_name ?? 'Catalog'} ${formatRate(it.catalog_discount_bp)}` : null
}
```

Create `src/features/pos/checkout/DiscountRows.tsx`:

```tsx
// src/features/pos/checkout/DiscountRows.tsx
import { formatSen } from '../order/cart'
import type { DiscountRow } from './discounts'

/** The grey rows under a discounted line: "Staff Meal 50% −RM 21.50". */
export default function DiscountRows({ rows }: { rows: DiscountRow[] }) {
  return <>{rows.map((r) => <span key={r.label} className="block pl-4 text-xs text-brown-muted">{r.label} −{formatSen(r.amountSen)}</span>)}</>
}
```

- [ ] **Step 4: Run the helper tests**

Run: `npx vitest run src/features/pos/checkout/discounts.test.ts`
Expected: PASS.

- [ ] **Step 5: Reads, calls and reasons**

`src/features/pos/checkout/reasons.ts`:
- Change the doc comment's first line to `/** Reason templates for voids, refunds and discounts (Feedme's "Reason template").`
- `export type ReasonAction = 'void_item' | 'void_bill' | 'refund' | 'discount'`
- In `ACTION_TITLES` add `discount: 'Discount',` after `refund: 'Refund',`.

`src/features/pos/order/posApi.ts`:
- Add `import type { DiscountKind } from '../checkout/bill'` with the other imports.
- `OpenBillRow` becomes:

```ts
export interface OpenBillRow {
  id: string; bill_no: string; table_id: string | null; order_type: OrderType; pax: number | null; opened_at: string
  discount_kind: DiscountKind | null; discount_value: number | null; discount_reason: string | null   // the bill discount
}
```

- In `BillItemRow`, after `voided_at: string | null`, add:

```ts
  catalog_discount_bp: number           // its catalog's discount when ordered (Staff Meal 5000)
  catalog_discount_name: string | null
  discount_kind: DiscountKind | null    // its item discount
  discount_value: number | null
  discount_reason: string | null
```

- `fetchOpenBills` select: `'id, bill_no, table_id, order_type, pax, opened_at, discount_kind, discount_value, discount_reason'`.
- `fetchBillItems` select: `'id, order_id, product_id, name_snapshot, unit_price_sen, sst_rate_bp, takeaway_fee_sen, order_type, qty, note, modifiers_snapshot, voided_at, ' + 'catalog_discount_bp, catalog_discount_name, discount_kind, discount_value, discount_reason, ' + 'orders!inner(order_no, source, placed_at)'`.
- `fetchBranchCatalogs`: `select('id, name, is_active, sort_order, discount_bp')`.

`src/features/pos/order/catalogs.ts`: `export interface CatalogRow { id: string; name: string; is_active: boolean; sort_order: number; discount_bp: number }`.

`src/features/pos/checkout/checkoutApi.ts`:
- Add `DiscountInput` to the type import from `./bill`, and `import { storedDiscount, type StoredDiscount } from './discounts'`.
- After `voidBill`, add:

```ts
export async function setItemDiscount(itemId: string, d: DiscountInput, a: Approval): Promise<void> {
  const { data, error } = await supabase.rpc('set_item_discount', {
    p_item_id: itemId, p_kind: d.kind, p_value: d.value, p_reason: a.reason, p_approver_id: a.approverId, p_pin: a.pin,
  })
  if (error) fail(error)
  unwrapAction(data)
}

export async function clearItemDiscount(itemId: string): Promise<void> {
  const { data, error } = await supabase.rpc('clear_item_discount', { p_item_id: itemId })
  if (error) fail(error)
  unwrapAction(data)
}

export async function setBillDiscount(billId: string, d: DiscountInput, a: Approval): Promise<void> {
  const { data, error } = await supabase.rpc('set_bill_discount', {
    p_bill_id: billId, p_kind: d.kind, p_value: d.value, p_reason: a.reason, p_approver_id: a.approverId, p_pin: a.pin,
  })
  if (error) fail(error)
  unwrapAction(data)
}

export async function clearBillDiscount(billId: string): Promise<void> {
  const { data, error } = await supabase.rpc('clear_bill_discount', { p_bill_id: billId })
  if (error) fail(error)
  unwrapAction(data)
}
```

- `ClosedBillDetail` becomes `{ totals: BillTotals | null; billDiscount: StoredDiscount | null; mergedIntoBillNo: string | null; payments: PaymentRow[]; refunds: RefundRow[] }`. In `fetchClosedBillDetail`: select `'totals, merged_into, discount_kind, discount_value, discount_reason'`; type the row as `{ totals: BillTotals | null; merged_into: string | null; discount_kind: DiscountKind | null; discount_value: number | null; discount_reason: string | null } | null` (import `DiscountKind` from `./bill`); return `billDiscount: row ? storedDiscount(row) : null` alongside the other fields.

- [ ] **Step 6: Write the failing bill view tests**

In `src/features/pos/order/billView.test.ts`, extend the `item` fixture so it reads:

```ts
const item = (id: string, voided = false, extra: Partial<BillItemRow> = {}): BillItemRow => ({
  id, order_id: 'o-1', product_id: 'p1', name_snapshot: 'Nasi Lemak', unit_price_sen: 1000, sst_rate_bp: 600, takeaway_fee_sen: 0,
  order_type: 'dine_in', qty: 2, note: 'less spicy', modifiers_snapshot: [{ name: 'Egg' }], voided_at: voided ? '2026-10-26T03:00:00Z' : null,
  catalog_discount_bp: 0, catalog_discount_name: null, discount_kind: null, discount_value: null, discount_reason: null,
  orders: { order_no: '1', source: 'counter', placed_at: '2026-10-26T02:00:00Z' },
  ...extra,
})
```

and append:

```ts
describe('billView discounts', () => {
  const staff = { catalog_discount_bp: 5000, catalog_discount_name: 'Staff Meal' }
  it('rows under each discounted line, the subtotal a bill discount applies to, and the catalog tag', () => {
    const v = billView({
      orderType: 'dine_in', tableId: 't1', lines: [], menu, info, billing,
      items: [item('i1', false, staff), item('i2', false, { discount_kind: 'amount', discount_value: 300, discount_reason: 'Regular' })],
      billDiscount: { kind: 'percent', value: 1000, reason: 'Late food' },
    })
    expect(v.sent[0].discountRows).toEqual([{ label: 'Staff Meal 50%', amountSen: 1000 }])
    expect(v.sent[0].afterCatalogSen).toBe(1000)
    expect(v.sent[1].discountRows).toEqual([{ label: 'Discount (Regular)', amountSen: 300 }])
    expect(v.sentSubtotalSen).toBe(2700)                       // 10.00 + 17.00
    expect(v.billDiscount).toEqual({ label: 'Discount 10% (Late food)', amountSen: 270 })
    expect(v.catalogTag).toBe('Staff Meal 50%')
    expect(v.totals?.billDiscountSen).toBe(270)
  })
  it('a draft ordered from a discounted catalog is previewed at its discount', () => {
    const v = billView({ orderType: 'dine_in', tableId: 't1', items: [], lines: [draft], menu, info, billing, draftCatalogDiscountBp: 5000 })
    expect(v.totals?.catalogDiscountSen).toBe(350)              // 7.00 at 50%
  })
  it('a voided line counts for nothing', () => {
    const v = billView({ orderType: 'dine_in', tableId: 't1', items: [item('i1', true, staff)], lines: [], menu, info, billing })
    expect(v.sentSubtotalSen).toBe(0)
    expect(v.catalogTag).toBeNull()
  })
})
```

- [ ] **Step 7: Run them to see them fail**

Run: `npx vitest run src/features/pos/order/billView.test.ts`
Expected: FAIL — `discountRows` undefined.

- [ ] **Step 8: Update `billView`**

In `src/features/pos/order/billView.ts`:

- Imports: `import { computeBill, discountOffSen, lineDiscounts, type BillLineInput, type BillTotals } from '../checkout/bill'` and `import { catalogTag, discountLabel, lineDiscountRows, storedDiscount, type DiscountRow, type StoredDiscount } from '../checkout/discounts'`.
- `SentRow` becomes:

```ts
export interface SentRow {
  item: BillItemRow; qty: number; name: string; mods: string[]; note: string | null; amountSen: number; voided: boolean
  discountRows: DiscountRow[]   // its catalog and item discounts, as they come off now
  afterCatalogSen: number       // what an item discount applies to
}
```

- `BillView` gains, after `totalsIncludeDrafts`:

```ts
  sentSubtotalSen: number          // sent live lines after catalog and item discounts: what a bill discount applies to
  billDiscount: DiscountRow | null // its label (with reason) and what it takes off now
  catalogTag: string | null        // "Staff Meal 50%" when an item has a catalog discount
```

- `BillViewInput` gains:

```ts
  billDiscount?: StoredDiscount | null  // the open bill's discount
  draftCatalogDiscountBp?: number       // the discount of the catalog the drafts are ordered from
```

- Replace the body of `billView` with:

```ts
export function billView(i: BillViewInput): BillView {
  const sent: SentRow[] = i.items.map((it) => {
    const d = lineDiscounts({ unitPriceSen: it.unit_price_sen, qty: it.qty, catalogDiscountBp: it.catalog_discount_bp, discount: storedDiscount(it) })
    return {
      item: it, qty: it.qty, name: it.name_snapshot, mods: it.modifiers_snapshot.map((m) => m.name), note: it.note,
      amountSen: d.grossSen, voided: it.voided_at !== null,
      discountRows: it.voided_at === null ? lineDiscountRows(it, d) : [],
      afterCatalogSen: d.grossSen - d.catalogDiscountSen,
    }
  })
  const drafts: DraftRow[] = i.lines.map((line, index) => {
    const p = i.menu ? findProduct(i.menu, line.productId) : undefined
    if (!p) return { index, line, qty: line.qty, name: 'Unavailable item', mods: [], note: line.note, unitSen: null }
    const { name, mods } = lineLabel(p, line)
    return { index, line, qty: line.qty, name, mods, note: line.note, unitSen: linePriceSen(p, line) }
  })
  // in order item id order, as pos_bill_totals sends them: a bill discount's leftover sen lands on the same line
  const sentLines: BillLineInput[] = [...i.items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((it) => ({
    id: it.id, productId: it.product_id, unitPriceSen: it.unit_price_sen, qty: it.qty, sstRateBp: it.sst_rate_bp,
    takeawayFeeSen: it.takeaway_fee_sen, voided: it.voided_at !== null, orderType: it.order_type,
    catalogDiscountBp: it.catalog_discount_bp, discount: storedDiscount(it),
  }))
  // a draft counts like pos_insert_order will snapshot it: its price, its product's SST rate, the
  // packaging fee on a takeaway order only, and its catalog's discount
  const draftLines: BillLineInput[] = drafts.flatMap((d) => {
    const info = i.info.get(d.line.productId)
    if (d.unitSen === null || !info) return []
    return [{ productId: d.line.productId, unitPriceSen: d.unitSen, qty: d.qty, sstRateBp: info.sstRateBp,
              takeawayFeeSen: i.orderType === 'takeaway' ? info.takeawayFeeSen : 0, voided: false, orderType: i.orderType,
              catalogDiscountBp: i.draftCatalogDiscountBp ?? 0 }]
  })
  const totalsIncludeDrafts = draftLines.length === drafts.length
  const bd = i.billDiscount ?? null
  const totals = i.billing ? computeBill({
    orderType: i.orderType, tableId: i.tableId,
    sstRegistered: i.billing.settings.sstRegistered, cashRounding: i.billing.settings.cashRounding, rules: i.billing.rules,
    lines: totalsIncludeDrafts ? [...sentLines, ...draftLines] : sentLines,
    billDiscount: bd,
  }) : null
  const sentSubtotalSen = sent.filter((s) => !s.voided)
    .reduce((n, s) => n + s.afterCatalogSen - discountOffSen(storedDiscount(s.item), s.afterCatalogSen), 0)
  return {
    sent, drafts, totals, totalsIncludeDrafts, sentSubtotalSen,
    billDiscount: bd ? { label: discountLabel(bd, true), amountSen: totals?.billDiscountSen ?? discountOffSen(bd, sentSubtotalSen) } : null,
    catalogTag: catalogTag(i.items),
    liveSentCount: sent.filter((s) => !s.voided).reduce((n, s) => n + s.qty, 0),
    draftCount: i.lines.reduce((n, l) => n + l.qty, 0),
  }
}
```

(`storedDiscount(it)` returns a `StoredDiscount`, which also satisfies `DiscountInput`; `computeBill` ignores `reason`.)

- [ ] **Step 9: Run the tests and type-check**

Run: `npx vitest run src/features/pos/order/billView.test.ts src/features/pos/checkout/`
Expected: PASS.

Run: `npx tsc --noEmit -p tsconfig.app.json` (or `npx tsc --noEmit`)
Expected: errors only where a test fixture or a hand-built object is typed `BillItemRow`, `OpenBillRow`, `CatalogRow` or `ClosedBillDetail`. Add to each one the compiler names: `catalog_discount_bp: 0, catalog_discount_name: null, discount_kind: null, discount_value: null, discount_reason: null` (items); `discount_kind: null, discount_value: null, discount_reason: null` (bills); `discount_bp: 0` (catalogs); `billDiscount: null` (closed bill detail). Re-run until clean, then run `npx vitest run src/features/pos` — Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/features/pos/checkout/discounts.ts src/features/pos/checkout/discounts.test.ts src/features/pos/checkout/DiscountRows.tsx src/features/pos/checkout/reasons.ts src/features/pos/checkout/checkoutApi.ts src/features/pos/order/posApi.ts src/features/pos/order/catalogs.ts src/features/pos/order/billView.ts src/features/pos/order/billView.test.ts
git commit -m "feat(pos): discount helpers, reads and calls; the bill view carries discount rows

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Add every fixture file Step 9 changed.)

---

### Task 6: Order screen, payment screen and transactions

**Files:**
- Create: `src/features/pos/order/ActionsOverlay.tsx`, `src/features/pos/order/ItemActionsOverlay.tsx`, `src/features/pos/checkout/DiscountDialog.tsx`, `src/features/pos/checkout/DiscountDialog.test.tsx`
- Modify: `src/features/pos/order/billActions.ts`, `src/features/pos/order/billActions.test.ts`, `src/features/pos/order/BillActionsOverlay.tsx`
- Modify: `src/features/pos/order/BillColumn.tsx`, `src/features/pos/order/OrderScreen.tsx`
- Modify: `src/features/pos/checkout/CheckoutTotals.tsx`, `src/features/pos/checkout/PaymentScreen.tsx`, `src/features/pos/checkout/TransactionScreen.tsx`

**Interfaces:**
- Consumes: everything Task 5 produces; `ApprovalDialog` (`action: ReasonAction | null`, `title`, `summary`, `onApprove(a: Approval)`, `onClose`, `onDone`); `ConfirmRequest` (`title`, `message?`, `confirmLabel`, `danger?`, `onConfirm`).
- Produces: `BillAction` gains `'discount_bill' | 'edit_bill_discount' | 'remove_bill_discount'`; `billActions` takes `billDiscount: boolean`; `type ItemAction = 'discount_item' | 'edit_item_discount' | 'remove_item_discount' | 'void_item'`, `ITEM_ACTION_LABEL`, `itemActions({ discounted })`; `CheckoutTotals` takes optional `billDiscountLabel?: string`.

- [ ] **Step 1: Write the failing action tests**

In `src/features/pos/order/billActions.test.ts`: change the import to `import { billActions, itemActions } from './billActions'`; change the `table` fixture to add `billDiscount: false`; update the expectations so a loaded bill with live items offers `discount_bill` right after `move`:

```ts
  it('a table bill with items: Move, Discount bill, Void bill, Pax, Pause QR', () => {
    expect(billActions(table)).toEqual(['move', 'discount_bill', 'void_bill', 'pax', 'pause_qr'])
  })
```

In the existing cases, insert `'discount_bill'` after `'move'` wherever the bill is loaded with `liveSentCount > 0` (the takeaway case becomes `['move', 'discount_bill', 'void_bill']`); the `close_empty` and not-loaded cases stay as they are. Add this case as the last `it` inside `describe('billActions', …)`:

```ts
  it('a bill with a discount offers Edit and Remove instead; Remove stays even when nothing is live', () => {
    expect(billActions({ ...table, billDiscount: true })).toEqual(['move', 'edit_bill_discount', 'remove_bill_discount', 'void_bill', 'pax', 'pause_qr'])
    expect(billActions({ ...table, billDiscount: true, liveSentCount: 0 })).toEqual(['move', 'edit_bill_discount', 'remove_bill_discount', 'close_empty', 'pax', 'pause_qr'])
  })
```

and append at the end of the file:

```ts
describe('itemActions', () => {
  it('Discount item and Void item; a discounted item offers Edit and Remove', () => {
    expect(itemActions({ discounted: false })).toEqual(['discount_item', 'void_item'])
    expect(itemActions({ discounted: true })).toEqual(['edit_item_discount', 'remove_item_discount', 'void_item'])
  })
})
```

Create `src/features/pos/checkout/DiscountDialog.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import DiscountDialog from './DiscountDialog'

describe('DiscountDialog', () => {
  it('a quick percent shows what comes off and hands the discount on', () => {
    const onNext = vi.fn()
    render(<DiscountDialog title="Discount bill" summary="Bill B0001 · RM 43.00" baseSen={4300} initial={null} onNext={onNext} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '10%' }))
    expect(screen.getByRole('status').textContent).toBe('−RM 4.30')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(onNext).toHaveBeenCalledWith({ kind: 'percent', value: 1000 })
  })
  it('an amount stops at the base; a bad value keeps Next off and says why', () => {
    const onNext = vi.fn()
    render(<DiscountDialog title="Discount item" summary="1 × Latte · RM 13.00" baseSen={1300} initial={null} onNext={onNext} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Amount' }))
    fireEvent.change(screen.getByLabelText('Amount (RM)'), { target: { value: '20' } })
    expect(screen.getByRole('status').textContent).toBe('−RM 13.00')
    fireEvent.change(screen.getByLabelText('Amount (RM)'), { target: { value: '0' } })
    expect(screen.getByRole('status').textContent).toBe('Enter an amount above RM 0.00')
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('editing starts from the discount on the bill', () => {
    render(<DiscountDialog title="Discount item" summary="s" baseSen={1000} initial={{ kind: 'amount', value: 250 }} onNext={() => {}} onClose={() => {}} />)
    expect((screen.getByLabelText('Amount (RM)') as HTMLInputElement).value).toBe('2.50')
  })
})
```

If `@testing-library/react` is not how other `*.test.tsx` files in `src/features/pos` render (check `BillColumn.test.tsx`), use that file's helpers instead with the same assertions.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/features/pos/order/billActions.test.ts src/features/pos/checkout/DiscountDialog.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Actions and overlays**

Replace `src/features/pos/order/billActions.ts` with:

```ts
// src/features/pos/order/billActions.ts
/** What the bill's grid button and a tapped sent item offer (spec §3, Feedme style). */

export type BillAction = 'send' | 'move' | 'discount_bill' | 'edit_bill_discount' | 'remove_bill_discount'
  | 'void_bill' | 'close_empty' | 'pax' | 'pause_qr' | 'resume_qr' | 'open_qr'

export const BILL_ACTION_LABEL: Record<BillAction, string> = {
  send: 'Send', move: 'Move', discount_bill: 'Discount bill', edit_bill_discount: 'Edit discount',
  remove_bill_discount: 'Remove discount', void_bill: 'Void bill', close_empty: 'Close empty bill', pax: 'Pax',
  pause_qr: 'Pause QR', resume_qr: 'Resume QR', open_qr: 'Open for QR',
}

/** Send with drafts; Move with a bill; once its items are loaded: Discount bill when it has live items
 *  (Edit and Remove discount when it has one), then Void bill when it has live items, Close empty
 *  bill when it has none; on a table: Pax, Pause or Resume QR, and Open for QR while it has no bill
 *  and the branch makes QR wait for an open bill (today's BillPanel). */
export function billActions(p: {
  isTable: boolean; hasBill: boolean; loaded: boolean; liveSentCount: number; draftCount: number
  qrPaused: boolean; qrRequiresOpenBill: boolean; billDiscount: boolean
}): BillAction[] {
  const out: BillAction[] = []
  if (p.draftCount > 0) out.push('send')
  if (p.hasBill) out.push('move')
  if (p.hasBill && p.loaded) {
    if (p.billDiscount) out.push('edit_bill_discount', 'remove_bill_discount')
    else if (p.liveSentCount > 0) out.push('discount_bill')
    out.push(p.liveSentCount > 0 ? 'void_bill' : 'close_empty')
  }
  if (p.isTable) {
    out.push('pax', p.qrPaused ? 'resume_qr' : 'pause_qr')
    if (!p.hasBill && p.qrRequiresOpenBill) out.push('open_qr')
  }
  return out
}

export type ItemAction = 'discount_item' | 'edit_item_discount' | 'remove_item_discount' | 'void_item'

export const ITEM_ACTION_LABEL: Record<ItemAction, string> = {
  discount_item: 'Discount item', edit_item_discount: 'Edit discount', remove_item_discount: 'Remove discount', void_item: 'Void item',
}

export function itemActions(p: { discounted: boolean }): ItemAction[] {
  return p.discounted ? ['edit_item_discount', 'remove_item_discount', 'void_item'] : ['discount_item', 'void_item']
}
```

(Keep the file's existing header comment if it differs; only the exports above must match.)

Create `src/features/pos/order/ActionsOverlay.tsx`:

```tsx
// src/features/pos/order/ActionsOverlay.tsx
import type { ComponentType } from 'react'
import { X } from 'lucide-react'

export interface OverlayAction<A extends string> {
  id: A
  label: string
  icon: ComponentType<{ size?: number }>
  danger?: boolean
}

/** The dark overlay of round action buttons (spec §3, Feedme style) that the bill's grid button and
 *  a tapped sent item open. Danger actions are red. */
export default function ActionsOverlay<A extends string>({ title, menuLabel, empty, actions, disabled, onPick, onClose }: {
  title: string
  menuLabel: string             // "Bill actions"
  empty: string                 // shown when there is nothing to offer
  actions: OverlayAction<A>[]
  disabled: boolean             // an action is already running
  onPick: (a: A) => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-30 flex flex-col items-center justify-center bg-brown-dark/90 p-6" onClick={onClose}>
      <h2 className="mb-8 text-xl font-semibold text-cream">{title}</h2>
      <div role="menu" aria-label={menuLabel} className="flex max-w-3xl flex-wrap justify-center gap-6" onClick={(e) => e.stopPropagation()}>
        {actions.map(({ id, label, icon: Icon, danger }) => (
          <button key={id} type="button" role="menuitem" disabled={disabled} onClick={() => onPick(id)}
            className="flex w-24 flex-col items-center gap-2 text-cream disabled:opacity-40">
            <span className={`flex h-20 w-20 items-center justify-center rounded-full ${danger ? 'bg-red-700 text-white' : 'bg-cream text-brown-dark'}`}><Icon size={30} /></span>
            <span className="text-center text-sm font-medium">{label}</span>
          </button>
        ))}
        {actions.length === 0 && <p className="text-cream">{empty}</p>}
      </div>
      <button type="button" onClick={onClose} aria-label={`Close ${menuLabel.toLowerCase()}`}
        className="mt-10 flex h-14 w-14 items-center justify-center rounded-full border border-cream/50 text-cream"><X size={26} /></button>
    </div>
  )
}
```

Replace `src/features/pos/order/BillActionsOverlay.tsx` with:

```tsx
// src/features/pos/order/BillActionsOverlay.tsx
import type { ComponentType } from 'react'
import { ArrowRightLeft, Ban, CircleX, Pause, Percent, Play, QrCode, Send, Undo2, Users } from 'lucide-react'
import ActionsOverlay from './ActionsOverlay'
import { BILL_ACTION_LABEL, type BillAction } from './billActions'

const ICON: Record<BillAction, ComponentType<{ size?: number }>> = {
  send: Send, move: ArrowRightLeft, discount_bill: Percent, edit_bill_discount: Percent, remove_bill_discount: Undo2,
  void_bill: Ban, close_empty: CircleX, pax: Users, pause_qr: Pause, resume_qr: Play, open_qr: QrCode,
}

/** The bill's actions (billActions()); Void bill and Close empty bill are red. */
export default function BillActionsOverlay({ title, actions, disabled, onPick, onClose }: {
  title: string
  actions: BillAction[]
  disabled: boolean             // a bill action is already running
  onPick: (a: BillAction) => void
  onClose: () => void
}) {
  return (
    <ActionsOverlay title={title} menuLabel="Bill actions" empty="Nothing to do on this bill yet." disabled={disabled}
      onPick={onPick} onClose={onClose}
      actions={actions.map((a) => ({ id: a, label: BILL_ACTION_LABEL[a], icon: ICON[a], danger: a === 'void_bill' || a === 'close_empty' }))} />
  )
}
```

Create `src/features/pos/order/ItemActionsOverlay.tsx`:

```tsx
// src/features/pos/order/ItemActionsOverlay.tsx
import type { ComponentType } from 'react'
import { Ban, Percent, Undo2 } from 'lucide-react'
import ActionsOverlay from './ActionsOverlay'
import { ITEM_ACTION_LABEL, type ItemAction } from './billActions'

const ICON: Record<ItemAction, ComponentType<{ size?: number }>> = {
  discount_item: Percent, edit_item_discount: Percent, remove_item_discount: Undo2, void_item: Ban,
}

/** What a tapped sent item offers: discount it (or edit / remove its discount) and void it (red). */
export default function ItemActionsOverlay({ title, actions, disabled, onPick, onClose }: {
  title: string
  actions: ItemAction[]
  disabled: boolean
  onPick: (a: ItemAction) => void
  onClose: () => void
}) {
  return (
    <ActionsOverlay title={title} menuLabel="Item actions" empty="Nothing to do on this item." disabled={disabled}
      onPick={onPick} onClose={onClose}
      actions={actions.map((a) => ({ id: a, label: ITEM_ACTION_LABEL[a], icon: ICON[a], danger: a === 'void_item' }))} />
  )
}
```

- [ ] **Step 4: The discount dialog**

Create `src/features/pos/checkout/DiscountDialog.tsx`:

```tsx
// src/features/pos/checkout/DiscountDialog.tsx
import { useState } from 'react'
import { formatSen } from '../order/cart'
import { discountOffSen, type DiscountInput, type DiscountKind } from './bill'
import { QUICK_PERCENTS, discountProblem, parseDiscount } from './discounts'

const asText = (d: DiscountInput | null): string =>
  !d ? '' : d.kind === 'percent' ? String(d.value / 100) : (d.value / 100).toFixed(2)

/** Step 1 of a discount (spec "Screens"): Amount | Percent, quick percents 5 / 10 / 20 / 50, the
 *  value (the iPad's number keyboard) and what comes off. Next hands the discount to ApprovalDialog
 *  (reason, then supervisor and PIN). */
export default function DiscountDialog({ title, summary, baseSen, initial, onNext, onClose }: {
  title: string                 // "Discount item" / "Discount bill"
  summary: string               // "2 × Coffee Latte · RM 26.00"
  baseSen: number               // what it applies to: the line after its catalog discount, or the bill's subtotal
  initial: DiscountInput | null // editing: the discount there now
  onNext: (d: DiscountInput) => void
  onClose: () => void
}) {
  const [kind, setKind] = useState<DiscountKind>(initial?.kind ?? 'percent')
  const [text, setText] = useState(asText(initial))
  const parsed = parseDiscount(kind, text)
  const problem = text.trim() === '' ? null : discountProblem(kind, text)
  const label = kind === 'amount' ? 'Amount (RM)' : 'Percent'
  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-brown-dark">{title}</h2>
        <p className="mt-1 text-sm text-brown-muted">{summary}</p>
        <div role="radiogroup" aria-label="Discount type" className="mt-4 grid grid-cols-2 gap-2">
          {(['amount', 'percent'] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => { setKind(k); setText('') }}
              className={`min-h-11 rounded-lg border text-sm font-medium ${kind === k ? 'border-brown-btn bg-brown-btn text-white' : 'border-border-mid text-brown-dark'}`}>
              {k === 'amount' ? 'Amount' : 'Percent'}
            </button>
          ))}
        </div>
        {kind === 'percent' && (
          <div className="mt-3 grid grid-cols-4 gap-2">
            {QUICK_PERCENTS.map((p) => (
              <button key={p} type="button" onClick={() => setText(String(p))}
                className={`min-h-11 rounded-lg border text-sm ${text === String(p) ? 'border-brown-btn font-semibold' : 'border-border-mid'}`}>{p}%</button>
            ))}
          </div>
        )}
        <label className="mt-3 block text-sm">
          {label}
          <input inputMode="decimal" autoFocus value={text} onChange={(e) => setText(e.target.value)}
            className="mt-1 w-full rounded-lg border border-border-mid px-3 py-2 text-lg tabular-nums" />
        </label>
        <p role="status" className="mt-2 min-h-5 text-sm">
          {problem ? <span className="text-red-700">{problem}</span>
            : parsed ? <span className="font-semibold">−{formatSen(discountOffSen(parsed, baseSen))}</span> : null}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-4 text-sm">Cancel</button>
          <button type="button" disabled={!parsed} onClick={() => parsed && onNext(parsed)}
            className="min-h-11 rounded-lg bg-brown-btn px-5 text-sm font-semibold text-white disabled:opacity-40">Next</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Run the new tests**

Run: `npx vitest run src/features/pos/order/billActions.test.ts src/features/pos/checkout/DiscountDialog.test.tsx`
Expected: PASS.

- [ ] **Step 6: Totals and line rows on every bill display**

`src/features/pos/checkout/CheckoutTotals.tsx` — the signature becomes `export default function CheckoutTotals({ totals, billDiscountLabel }: { totals: BillTotals | null; billDiscountLabel?: string })`, and after the Subtotal row add:

```tsx
      {(totals.billDiscountSen ?? 0) > 0 && (
        <div className="flex justify-between"><span>{billDiscountLabel ?? 'Discount'}</span><span>−{formatSen(totals.billDiscountSen)}</span></div>
      )}
```

`src/features/pos/order/BillColumn.tsx`:
- Add `import DiscountRows from '../checkout/DiscountRows'`.
- In the sent-line button, change `<LineText qty={s.qty} name={s.name} mods={s.mods} note={s.note} />` to:

```tsx
                <span>
                  <LineText qty={s.qty} name={s.name} mods={s.mods} note={s.note} />
                  <DiscountRows rows={s.discountRows} />
                </span>
```

- In the header, inside the `<div className="mt-1 flex items-center justify-between gap-2 text-xs text-brown-muted">`, change `<span>{p.billNo ? `Bill ${p.billNo}` : 'No bill yet'}</span>` to:

```tsx
          <span>
            {p.billNo ? `Bill ${p.billNo}` : 'No bill yet'}
            {view.catalogTag && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800">{view.catalogTag}</span>}
          </span>
```

- Change `{view.totals && <Totals t={view.totals} />}` to `{view.totals && <Totals t={view.totals} billDiscountLabel={view.billDiscount?.label} />}`, and `Totals` becomes:

```tsx
function Totals({ t, billDiscountLabel }: { t: BillTotals; billDiscountLabel?: string }) {
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between"><span>Subtotal</span><span className="tabular-nums">{formatSen(t.subtotalSen)}</span></div>
      {t.billDiscountSen > 0 && (
        <div className="flex justify-between text-brown-muted"><span>{billDiscountLabel ?? 'Discount'}</span><span className="tabular-nums">−{formatSen(t.billDiscountSen)}</span></div>
      )}
      {t.serviceChargeGroups.map((g) => (
        <div key={`sc${g.rateBp}`} className="flex justify-between text-brown-muted"><span>Service charge ({formatRate(g.rateBp)})</span><span className="tabular-nums">{formatSen(g.amountSen)}</span></div>
      ))}
      {t.sstGroups.map((g) => (
        <div key={`sst${g.rateBp}`} className="flex justify-between text-brown-muted"><span>SST ({formatRate(g.rateBp)})</span><span className="tabular-nums">{formatSen(g.amountSen)}</span></div>
      ))}
      {t.takeawayFeeSen > 0 && <div className="flex justify-between text-brown-muted"><span>Takeaway packaging</span><span className="tabular-nums">{formatSen(t.takeawayFeeSen)}</span></div>}
      {t.roundingSen !== 0 && <div className="flex justify-between text-brown-muted"><span>Rounding</span><span className="tabular-nums">{formatSen(t.roundingSen)}</span></div>}
      <div className="flex justify-between text-base font-semibold"><span>Total</span><span className="tabular-nums">{formatSen(t.totalSen)}</span></div>
    </div>
  )
}
```

`src/features/pos/checkout/PaymentScreen.tsx`:
- Add `import DiscountRows from './DiscountRows'` and `import { discountLabel, lineDiscountRows, linesById, storedDiscount } from './discounts'`.
- Before the `return (`, add `const lineTotals = linesById(totals)` and `const billDisc = storedDiscount(bill)`.
- In the item row, after the modifiers line, add `<DiscountRows rows={lineDiscountRows(i, lineTotals.get(i.id))} />`.
- `<CheckoutTotals totals={totals} />` becomes `<CheckoutTotals totals={totals} billDiscountLabel={billDisc ? discountLabel(billDisc, true) : undefined} />`.

`src/features/pos/checkout/TransactionScreen.tsx`:
- Same two imports.
- In the item row, after the note line, add `{!i.voided_at && <DiscountRows rows={lineDiscountRows(i, linesById(detail.d.totals).get(i.id))} />}`.
- `<CheckoutTotals totals={detail.d.totals} />` becomes `<CheckoutTotals totals={detail.d.totals} billDiscountLabel={detail.d.billDiscount ? discountLabel(detail.d.billDiscount, true) : undefined} />`.

- [ ] **Step 7: Wire the order screen**

In `src/features/pos/order/OrderScreen.tsx`:

- Imports: add `clearBillDiscount, clearItemDiscount, setBillDiscount, setItemDiscount` to the `../checkout/checkoutApi` import; add `import DiscountDialog from '../checkout/DiscountDialog'`, `import ItemActionsOverlay from './ItemActionsOverlay'`, `import { discountOffSen, type DiscountInput } from '../checkout/bill'`, `import { discountLabel, storedDiscount } from '../checkout/discounts'`; add `itemActions, type ItemAction` to the `./billActions` import.
- `type Dialog` gains:

```ts
  | { kind: 'item_actions'; row: SentRow }
  | { kind: 'discount_item'; row: SentRow }
  | { kind: 'approve_item_discount'; row: SentRow; discount: DiscountInput }
  | { kind: 'discount_bill' }
  | { kind: 'approve_bill_discount'; discount: DiscountInput }
```

- Above `const view = billView({`, add `const billDisc = bill ? storedDiscount(bill) : null`, and give `billView` two more fields:

```ts
    billDiscount: billDisc,
    draftCatalogDiscountBp: fresh?.catalogs.find((c) => c.id === catalogId)?.discount_bp ?? 0,
```

- `billActions({ … })` gains `billDiscount: billDisc !== null`.
- In `pickAction`, before `else if (a === 'close_empty' && bill) {`, add:

```ts
    else if (a === 'discount_bill' || a === 'edit_bill_discount') setDialog({ kind: 'discount_bill' })
    else if (a === 'remove_bill_discount' && bill) {
      setConfirm({ title: 'Remove this discount?', confirmLabel: 'Remove discount', onConfirm: () => void run(() => clearBillDiscount(bill.id)) })
    }
```

- After `pickAction`, add:

```ts
  const pickItemAction = (row: SentRow, a: ItemAction) => {
    if (a === 'void_item') setDialog({ kind: 'void_item', row })
    else if (a === 'discount_item' || a === 'edit_item_discount') setDialog({ kind: 'discount_item', row })
    else {
      setDialog(null)
      setConfirm({ title: 'Remove this discount?', confirmLabel: 'Remove discount', onConfirm: () => void run(() => clearItemDiscount(row.item.id)) })
    }
  }
```

- `onSentTap={(row) => setDialog({ kind: 'void_item', row })}` becomes `onSentTap={(row) => setDialog({ kind: 'item_actions', row })}`.
- Next to the existing `void_item` and `void_bill` dialogs, render:

```tsx
      {bill && dialog?.kind === 'item_actions' && (
        <ItemActionsOverlay title={`${dialog.row.qty} × ${dialog.row.name}`}
          actions={itemActions({ discounted: storedDiscount(dialog.row.item) !== null })}
          disabled={busy || sending} onPick={(a) => pickItemAction(dialog.row, a)} onClose={() => setDialog(null)} />
      )}
      {bill && dialog?.kind === 'discount_item' && (
        <DiscountDialog title="Discount item" summary={`${dialog.row.qty} × ${dialog.row.name} · ${formatSen(dialog.row.afterCatalogSen)}`}
          baseSen={dialog.row.afterCatalogSen} initial={storedDiscount(dialog.row.item)}
          onNext={(d) => setDialog({ kind: 'approve_item_discount', row: dialog.row, discount: d })} onClose={() => setDialog(null)} />
      )}
      {bill && dialog?.kind === 'approve_item_discount' && (
        <ApprovalDialog branchId={branchId} action="discount" title="Discount item"
          summary={`${discountLabel({ ...dialog.discount, reason: null }, false)} on ${dialog.row.qty} × ${dialog.row.name} · −${formatSen(discountOffSen(dialog.discount, dialog.row.afterCatalogSen))}`}
          onApprove={(a) => setItemDiscount(dialog.row.item.id, dialog.discount, a)} onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); setLocalKey((k) => k + 1); void onChanged() }} />
      )}
      {bill && dialog?.kind === 'discount_bill' && (
        <DiscountDialog title="Discount bill" summary={`Bill ${bill.bill_no} · ${formatSen(view.sentSubtotalSen)}`}
          baseSen={view.sentSubtotalSen} initial={billDisc}
          onNext={(d) => setDialog({ kind: 'approve_bill_discount', discount: d })} onClose={() => setDialog(null)} />
      )}
      {bill && dialog?.kind === 'approve_bill_discount' && (
        <ApprovalDialog branchId={branchId} action="discount" title="Discount bill"
          summary={`${discountLabel({ ...dialog.discount, reason: null }, false)} on bill ${bill.bill_no} · −${formatSen(discountOffSen(dialog.discount, view.sentSubtotalSen))}`}
          onApprove={(a) => setBillDiscount(bill.id, dialog.discount, a)} onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); setLocalKey((k) => k + 1); void onChanged() }} />
      )}
```

The lock effect (`if (locked) { … setDialog(null) … }`) already closes these dialogs.

- [ ] **Step 8: Type-check and run the POS tests**

Run: `npx tsc --noEmit -p tsconfig.app.json` (or `npx tsc --noEmit`)
Expected: no errors.

Run: `npx vitest run src/features/pos`
Expected: PASS. If `BillColumn.test.tsx` builds a `BillView` by hand, add `sentSubtotalSen: 0, billDiscount: null, catalogTag: null` to it and `discountRows: [], afterCatalogSen: <amountSen>` to each `SentRow` it builds.

- [ ] **Step 9: Commit**

```bash
git add src/features/pos/order/ActionsOverlay.tsx src/features/pos/order/ItemActionsOverlay.tsx src/features/pos/order/BillActionsOverlay.tsx src/features/pos/order/billActions.ts src/features/pos/order/billActions.test.ts src/features/pos/order/BillColumn.tsx src/features/pos/order/OrderScreen.tsx src/features/pos/checkout/DiscountDialog.tsx src/features/pos/checkout/DiscountDialog.test.tsx src/features/pos/checkout/CheckoutTotals.tsx src/features/pos/checkout/PaymentScreen.tsx src/features/pos/checkout/TransactionScreen.tsx
git commit -m "feat(pos): discount item and bill from the order screen; discounts on every bill display

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Back office — catalog Discount % and Discount reasons

**Files:**
- Modify: `src/features/pos/menu/menuEditorApi.ts`, `src/features/pos/menu/CatalogsPage.tsx`
- Modify: `src/features/pos/menu/listAdmin.ts`, `src/features/pos/menu/listAdmin.test.ts`
- Modify: `src/features/pos/checkout/CheckoutSettings.tsx`

**Interfaces:**
- Consumes: `menu_set_catalog_discount(p_id, p_bp)` (Task 2); `ReasonAction` with `'discount'` (Task 5).
- Produces: `catalogDiscountBp(text: string): number | null`; `fetchCatalogDiscounts(): Promise<Map<string, number>>`; `setCatalogDiscount(id: string, bp: number): Promise<null>`.

- [ ] **Step 1: Write the failing parser test**

Append to `src/features/pos/menu/listAdmin.test.ts` (add `catalogDiscountBp` to its import from `./listAdmin`):

```ts
describe('catalogDiscountBp', () => {
  it('a whole percent 0–100 as basis points; anything else is null', () => {
    expect(catalogDiscountBp('50')).toBe(5000)
    expect(catalogDiscountBp(' 0 ')).toBe(0)
    expect(catalogDiscountBp('100')).toBe(10000)
    expect(catalogDiscountBp('101')).toBeNull()
    expect(catalogDiscountBp('12.5')).toBeNull()
    expect(catalogDiscountBp('')).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/features/pos/menu/listAdmin.test.ts`
Expected: FAIL — `catalogDiscountBp` is not exported.

- [ ] **Step 3: Implement**

Append to `src/features/pos/menu/listAdmin.ts`:

```ts
/** Catalogs → Discount %: a whole percent 0–100 as basis points; null = not valid
 *  (menu_set_catalog_discount: "Enter a whole percent from 0 to 100"). */
export function catalogDiscountBp(text: string): number | null {
  const t = text.trim()
  if (!/^\d{1,3}$/.test(t) || Number(t) > 100) return null
  return Number(t) * 100
}
```

Append to `src/features/pos/menu/menuEditorApi.ts` (after `setCatalogActive`):

```ts
/** Each catalog's discount in basis points (Staff Meal 5000); read apart from menu_editor_lookups. */
export async function fetchCatalogDiscounts(): Promise<Map<string, number>> {
  const { data, error } = await supabase.from('menu_catalogs').select('id, discount_bp')
  if (error) throw new Error(error.message)
  return new Map(((data ?? []) as { id: string; discount_bp: number }[]).map((r) => [r.id, r.discount_bp]))
}
export const setCatalogDiscount = (id: string, bp: number) => call<null>('menu_set_catalog_discount', { p_id: id, p_bp: bp })
```

In `src/features/pos/menu/CatalogsPage.tsx`:
- Import `fetchCatalogDiscounts, setCatalogDiscount` from `./menuEditorApi` and `catalogDiscountBp` from `./listAdmin`.
- `type Editing = { id: string; mode: 'rename' | 'duplicate' | 'discount'; name: string } | null` (in `discount` mode `name` holds the typed percent).
- State: `const [discounts, setDiscounts] = useState<Map<string, number>>(new Map())`.
- In `load`, replace `l = await fetchLookups()` with:

```ts
      const [lookups, d] = await Promise.all([fetchLookups(), fetchCatalogDiscounts()])
      l = lookups
      if (seq === loadSeq.current) setDiscounts(d)
```

- `confirmEdit` becomes:

```ts
  const confirmEdit = (c: LookupCatalog) => {
    if (!editing) return
    if (editing.mode === 'discount') {
      const bp = catalogDiscountBp(editing.name)
      if (bp === null) return fail(c.id, 'Enter a whole percent from 0 to 100')
      void run(c.id, () => setCatalogDiscount(c.id, bp), bp === 0 ? 'No discount' : `Sells at ${bp / 100}% off`)
      return
    }
    const problem = listNameProblem('Catalog', editing.name, catalogs ?? [], editing.mode === 'rename' ? c.id : null)
    if (problem) return fail(c.id, problem)
    if (editing.mode === 'rename') void run(c.id, () => saveCatalog(c.id, cleanName(editing.name)), 'Renamed')
    else void run(c.id, () => duplicateCatalog(c.id, cleanName(editing.name)), `Copied to ${cleanName(editing.name)}`)
  }
```

- In the row's info line, after `{c.feedmeName ? ` · Feedme: ${c.feedmeName}` : ''}`, add `{(discounts.get(c.id) ?? 0) > 0 ? ` · ${(discounts.get(c.id) ?? 0) / 100}% off` : ''}`.
- After the Duplicate button, add:

```tsx
              <button className={linkBtnCls} disabled={locked}
                onClick={() => setEditing({ id: c.id, mode: 'discount', name: String((discounts.get(c.id) ?? 0) / 100) })}>Discount %</button>
```

- In the editing row, the label becomes `{editing.mode === 'rename' ? 'New name' : editing.mode === 'duplicate' ? 'Name of the copy' : 'Discount % on every item (0 = none)'}`, the input gets `inputMode={editing.mode === 'discount' ? 'numeric' : undefined}`, and the button text becomes `{editing.mode === 'rename' ? 'Save name' : editing.mode === 'duplicate' ? 'Duplicate with products and prices' : 'Save discount'}`.
- The page hint gains one sentence at the end: `A catalog with a discount (e.g. Staff Meal 50%) takes it off every item ordered from it.`

In `src/features/pos/checkout/CheckoutSettings.tsx`:
- `const ACTIONS: ReasonAction[] = ['void_item', 'void_bill', 'refund', 'discount']`.
- In `ReasonsSection`'s initial drafts add `discount: { text: '', compulsory: true, allowOther: true },`.
- Heading: `Reasons for voids, refunds and discounts`; grid `grid-cols-3` → `grid-cols-4`.

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run src/features/pos/menu src/features/pos/checkout`
Expected: PASS.

Run: `npx tsc --noEmit -p tsconfig.app.json` (or `npx tsc --noEmit`)
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/features/pos/menu/menuEditorApi.ts src/features/pos/menu/CatalogsPage.tsx src/features/pos/menu/listAdmin.ts src/features/pos/menu/listAdmin.test.ts src/features/pos/checkout/CheckoutSettings.tsx
git commit -m "feat(menu): catalog Discount % and Discount reason templates

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Check it on dev and tick the readiness list

**Files:**
- Modify: `docs/pos/2026-10-29-feedme-replacement-readiness.md`

- [ ] **Step 1: Full test run and build**

Run: `npx vitest run` then `npm run build`
Expected: all tests pass; the build succeeds.

- [ ] **Step 2: Browser check on craft-os-dev**

Start the dev server of this worktree (the `.claude/launch.json` entry that serves this worktree; never the `craft-os-dev` entry of the main checkout on port 3000, which points to prod). In the browser, run `document.documentElement.outerHTML.includes('egznnbjmicebbhwasloy')` or check a network request's host: it must be `egznnbjmicebbhwasloy.supabase.co`. Stop if it is `yfsoesxzurzjdwstszru`.

Using a dev test outlet (never real outlet data), check:
1. Back office → Catalogs → a test catalog → Discount % 50 → "Sells at 50% off".
2. POS settings → Reasons: a Discount column; add "Regular".
3. Order screen, test catalog switched to the 50% catalog: a draft shows the catalog discount in the totals; after Send, the line shows "<catalog> 50% −RM x" and the bill shows the tag.
4. Tap a sent line → Discount item → 10% → Next → reason → supervisor PIN → the line shows "Discount 10% (Regular)".
5. Bill actions → Discount bill → Amount 5 → approve → totals show "Discount (Regular) −RM 5.00" before Service charge.
6. Bill actions → Merge into another bill (Move → merge) is refused with "Remove the bill discount before merging"; Remove discount → confirm → gone.
7. Payment screen shows the same rows and totals; pay; the receipt print job's payload has `discounts` and `billDiscountSen`.
8. Transactions → the paid bill shows the rows and the Discount line.
9. Close the test shift: the Z report has the DISCOUNTS section.

Take a screenshot of the order screen with both discounts for the owner.

- [ ] **Step 3: Tick W2 in the readiness list**

In `docs/pos/2026-10-29-feedme-replacement-readiness.md`, change `- [ ] **W2 Bill discount**` to `- [x] **W2 Bill discount**` and append to that item: ` Built on dev 2026-10-30 (plan docs/superpowers/plans/2026-10-30-pos-discounts.md); prod runs with the POS chain (step 4).`

- [ ] **Step 4: Commit**

```bash
git add docs/pos/2026-10-29-feedme-replacement-readiness.md
git commit -m "docs(pos): discounts built on dev

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Do not push unless the owner asks.
