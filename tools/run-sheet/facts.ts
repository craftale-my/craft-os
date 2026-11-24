// The Demo branch's facts (tools/run-sheet/facts.sql, saved as JSON) and the money helpers of
// figures.ts. Every price and total comes from the menu facts and bill.ts's computeBill.
import { readFileSync } from 'node:fs'
import { computeBill, type BillTotals, type CashRounding, type ServiceChargeRuleInput } from '../../src/features/pos/checkout/bill.ts'

export interface Product {
  name: string
  nameSnapshot: string
  productId: string
  sstRateBp: number
  takeawayFeeSen: number
  printRoute: string | null
  dineInSen: number
  takeawaySen: number | null
  qrSen: number | null
  required: { group: string; minSelect: number; option: { name: string; deltaSen: number } }[]
}
export interface Facts {
  branchId: string
  settings: { sstRegistered: boolean; cashRounding: CashRounding; receiptRoute: string | null; cashVarianceLimitSen: number } | null
  rules: ServiceChargeRuleInput[]
  tables: Record<string, string>
  methods: { name: string; kind: string }[]
  openShift: boolean
  lastClose: string | null
  openBills: number
  earlierVoids: { items: number; valueSen: number }
  earlierVoidBills: number
  candidates: Partial<Record<'plain' | 'fee' | 'zero' | 'set', Product[]>>
}
export type Where = 'dine_in' | 'takeaway' | 'qr'
export interface Item { p: Product; qty: number; where: Where; voided?: boolean }

export function readFacts(path: string): Facts {
  return JSON.parse(readFileSync(path, 'utf8')) as Facts
}

/** The i-th candidate of a bucket of facts.sql; none → stop: the controller chooses another product. */
export function pickProduct(facts: Facts, bucket: 'plain' | 'fee' | 'zero' | 'set', i: number, what: string): Product {
  const p = facts.candidates[bucket]?.[i]
  if (!p) throw new Error(`The Demo menu has no ${what} (bucket "${bucket}", #${i + 1}) — ask the controller to choose one`)
  return p
}

/** The first active payment method of one of these kinds. */
export function methodName(facts: Facts, kinds: string[], what: string): string {
  const m = facts.methods.find((x) => kinds.includes(x.kind))
  if (!m) throw new Error(`The Demo branch has no ${what} payment method`)
  return m.name
}

export const money = (sen: number) => `${sen < 0 ? '-' : ''}${(Math.abs(sen) / 100).toFixed(2)}`
export const rm = (sen: number) => `RM ${money(sen)}`
export const md = (s: string) => s.replace(/\|/g, '\\|')
export const optionDelta = (p: Product) => p.required.reduce((n, r) => n + r.option.deltaSen, 0)

/** One unit as the bill snapshots it: the catalog price of where it is ordered, plus its set choices. */
export function unitSen(i: Item): number {
  const base = i.where === 'takeaway' ? i.p.takeawaySen : i.where === 'qr' ? i.p.qrSen : i.p.dineInSen
  if (base === null) throw new Error(`${i.p.name} has no ${i.where} price`)
  return base + optionDelta(i.p)
}

export function branchSettings(facts: Facts) {
  return facts.settings ?? { sstRegistered: true, cashRounding: 'nearest_5_sen' as CashRounding, receiptRoute: null, cashVarianceLimitSen: 500 }
}

/** A bill of these items at this table (null = takeaway), totalled by the POS's own rules. */
export function billOf(facts: Facts, orderType: 'dine_in' | 'takeaway', table: string | null, items: Item[]): BillTotals {
  const tableId = table === null ? null : facts.tables[table]
  if (tableId === undefined) throw new Error(`The Demo branch has no table ${table}`)
  const settings = branchSettings(facts)
  return computeBill({
    orderType, tableId, sstRegistered: settings.sstRegistered, cashRounding: settings.cashRounding, rules: facts.rules,
    lines: items.map((i) => ({
      productId: i.p.productId, unitPriceSen: unitSen(i), qty: i.qty, sstRateBp: i.p.sstRateBp,
      takeawayFeeSen: i.where === 'takeaway' ? i.p.takeawayFeeSen : 0, voided: i.voided ?? false,
      orderType: i.where === 'takeaway' ? 'takeaway' as const : 'dine_in' as const,
    })),
  })
}
