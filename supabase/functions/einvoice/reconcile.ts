// The reconciliation run (spec W5.9): build — never submit — every paid bill's own e-invoice and every outlet-month's
// consolidated invoice, and compare them with the bills and Reports → Overview. Pure; index.ts feeds it
// einvoice_reconcile_source (supabase/migration-2026-11-23-einvoice-w5.sql E6).

import { billInvoice, OVER_LIMIT_SEN, planConsolidated, type PlanCtx } from './documents.ts'
import { monthEnd } from './job.ts'
import { buildDocument, documentTotals, type BillTotals, type LedgerLine, type Party } from './ubl.ts'

/** A stand-in seller: the company details may not be filled in, and nothing is sent. */
export const RECONCILE_SUPPLIER: Party = {
  name: 'Reconciliation only', tin: 'C0000000000', idType: 'BRN', idValue: '000000000000', sstNo: 'NA', ttxNo: 'NA',
  msicCode: '56101', activity: 'Reconciliation', address: { line: 'NA', city: 'NA', stateCode: '17', countryCode: 'MYS' },
  phone: 'NA',
}

export interface ReconcileBill {
  id: string; branchId: string; billNo: string; day: string; totalSen: number; totals: BillTotals | null; lines: LedgerLine[]
}
export interface ReconcileMonthIn { branchId: string; month: string; overviewSen: number }
export interface ReconcileSource { bills: ReconcileBill[]; months: ReconcileMonthIn[] }

export interface MonthCheck {
  branchId: string
  month: string
  bills: number
  billsSen: number
  consolidatedSen: number
  overLimitSen: number
  overviewSen: number | null
  ok: boolean
  problem?: string
}
export interface ReconcileReport {
  bills: number
  singleOk: number
  singleProblems: { branchId: string; billNo: string; problem: string }[]
  months: MonthCheck[]
  ok: boolean
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function reconcile(src: ReconcileSource, issuedAt = new Date('2026-01-01T00:00:00Z')): ReconcileReport {
  const ctx: PlanCtx = { supplier: RECONCILE_SUPPLIER, issuedAt }

  const singleProblems: ReconcileReport['singleProblems'] = []
  let singleOk = 0
  for (const b of src.bills) {
    try {
      buildDocument(billInvoice(b.lines, b.totals, b.totalSen, ctx, null).build('RECONCILE'))
      singleOk++
    } catch (e) {
      singleProblems.push({ branchId: b.branchId, billNo: b.billNo, problem: message(e) })
    }
  }

  const groups = new Map<string, ReconcileBill[]>()
  for (const b of src.bills) {
    const k = `${b.branchId}|${b.day.slice(0, 7)}`
    groups.set(k, [...(groups.get(k) ?? []), b])
  }
  const overview = new Map(src.months.map((m) => [`${m.branchId}|${m.month}`, m.overviewSen]))

  const months = [...groups.keys()].sort().map((k): MonthCheck => {
    const list = groups.get(k)!
    const [branchId, month] = k.split('|')
    const billsSen = list.reduce((a, b) => a + b.totalSen, 0)
    const small = list.filter((b) => b.totalSen <= OVER_LIMIT_SEN)
    const overLimitSen = billsSen - small.reduce((a, b) => a + b.totalSen, 0)
    const overviewSen = overview.get(k) ?? null
    let consolidatedSen = 0
    let problem: string | undefined
    try {
      if (small.length > 0) {
        const p = planConsolidated(
          small.map((b) => ({ id: b.id, billNo: b.billNo, day: b.day, totalSen: b.totalSen, totals: b.totals })),
          { start: `${month}-01`, end: monthEnd(month) }, ctx)
        const input = p.build('RECONCILE')
        buildDocument(input)
        consolidatedSen = documentTotals(input).payable
      }
    } catch (e) {
      problem = message(e)
    }
    if (!problem && consolidatedSen + overLimitSen !== billsSen) {
      problem = `Consolidated ${consolidatedSen} sen + over RM 10,000 ${overLimitSen} sen is not the bills' ${billsSen} sen`
    }
    if (!problem && overviewSen !== billsSen) problem = `Reports → Overview says ${overviewSen} sen, the bills ${billsSen} sen`
    return { branchId, month, bills: list.length, billsSen, consolidatedSen, overLimitSen, overviewSen, ok: !problem, ...(problem ? { problem } : {}) }
  })

  return { bills: src.bills.length, singleOk, singleProblems, months, ok: singleProblems.length === 0 && months.every((m) => m.ok) }
}
