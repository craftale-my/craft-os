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
  noSaleOpens: number       // W4: Open drawer presses in the shift
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
const DRAWER_KEYS = ['floatSen', 'cashSalesSen', 'cashRefundSen', 'payInSen', 'payOutSen', 'noSaleOpens', 'expectedSen'] as const
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
  throw new Error(error?.message || 'Unknown error')
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
