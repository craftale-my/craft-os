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
