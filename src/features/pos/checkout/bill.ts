/** Bill totals — the TypeScript mirror of the SQL function pos_compute_bill
 *  (supabase/migration-2026-10-25-pos-hardening.sql). Both take the same
 *  input shape and are tested against the same vectors (billVectors.json, and
 *  the copy inside supabase/migration-2026-10-24-pos-checkout-verify.sql).
 *  The server's result is the truth; this one is for instant display.
 *  All money is integer sen; all rates are basis points (600 = 6%). */

export type BillOrderType = 'dine_in' | 'takeaway'
export type CashRounding = 'none' | 'nearest_5_sen'

export interface BillLineInput {
  productId: string | null
  unitPriceSen: number // variant + modifiers, already
  qty: number
  sstRateBp: number
  takeawayFeeSen: number // snapshotted on the order item; counted only on takeaway lines, taxed at the line's SST rate
  voided: boolean
  /** The order type the item was ordered under (order_items.order_type): a takeaway merged into
   *  a table's bill keeps 'takeaway' (owner, 2026-10-25). Absent = the bill's order type. */
  orderType?: BillOrderType
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
}

export interface ChargeGroup {
  rateBp: number
  baseSen: number
  amountSen: number
}

export interface BillTotals {
  subtotalSen: number
  serviceChargeSen: number
  sstSen: number
  takeawayFeeSen: number
  beforeRoundingSen: number
  roundingSen: number
  totalSen: number
  sstGroups: ChargeGroup[] // one per non-zero SST rate, ascending
  serviceChargeGroups: ChargeGroup[] // one per non-zero service-charge rate, ascending
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

export function computeBill(input: BillInput): BillTotals {
  const live = input.lines.filter((l) => !l.voided)
  const amount = (l: BillLineInput) => l.unitPriceSen * l.qty
  const subtotalSen = live.reduce((n, l) => n + amount(l), 0)

  const scBases = new Map<number, number>()
  for (const l of live) {
    const rule = ruleFor(input, l)
    if (rule && rule.rateBp > 0) scBases.set(rule.rateBp, (scBases.get(rule.rateBp) ?? 0) + amount(l))
  }
  const serviceChargeGroups = groups(scBases)

  // SST base per rate: the line amount plus, on a takeaway line, its packaging fee (owner, 2026-10-24;
  // a takeaway merged into a table keeps its fee — owner, 2026-10-25)
  const fee = (l: BillLineInput) => (lineType(input, l) === 'takeaway' ? l.takeawayFeeSen * l.qty : 0)
  const sstBases = new Map<number, number>()
  if (input.sstRegistered) {
    for (const l of live) if (l.sstRateBp > 0) sstBases.set(l.sstRateBp, (sstBases.get(l.sstRateBp) ?? 0) + amount(l) + fee(l))
  }
  const sstGroups = groups(sstBases)

  const serviceChargeSen = serviceChargeGroups.reduce((n, g) => n + g.amountSen, 0)
  const sstSen = sstGroups.reduce((n, g) => n + g.amountSen, 0)
  const takeawayFeeSen = live.reduce((n, l) => n + fee(l), 0)
  const beforeRoundingSen = subtotalSen + serviceChargeSen + sstSen + takeawayFeeSen
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
  }
}

/** 600 → "6%", 650 → "6.5%", 1000 → "10%". */
export function formatRate(bp: number): string {
  return `${Number((bp / 100).toFixed(2))}%`
}
