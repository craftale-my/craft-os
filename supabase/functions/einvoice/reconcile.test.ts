import { describe, expect, it } from 'vitest'
import { reconcile, type ReconcileBill, type ReconcileSource } from './reconcile.ts'
import type { BillTotals, LedgerLine } from './ubl.ts'

const totals = (t: Partial<BillTotals>): BillTotals => ({
  subtotalSen: 0, serviceChargeSen: 0, sstSen: 0, takeawayFeeSen: 0, roundingSen: 0, totalSen: 0, sstGroups: [], ...t,
})
const line = (l: Partial<LedgerLine> & Pick<LedgerLine, 'name' | 'qty' | 'unitPriceSen'>): LedgerLine => {
  const gross = l.qty * l.unitPriceSen
  const net = l.netSen ?? gross
  const fee = l.takeawayFeeSen ?? 0
  return {
    itemId: l.name, grossSen: gross, catalogDiscountSen: 0, itemDiscountSen: 0, billShareSen: 0, netSen: net,
    takeawayFeeSen: fee, sstBaseSen: net + fee, taxRateBp: 0, sstSen: 0, ...l,
  }
}
// EA1, EA3 and EA6 of the W5 verify
const a1Lines = [
  line({ name: 'Latte', qty: 2, unitPriceSen: 1000, billShareSen: 182, netSen: 1818, taxRateBp: 600, sstSen: 109 }),
  line({ name: 'Water', qty: 1, unitPriceSen: 200, billShareSen: 18, netSen: 182 }),
]
const a1 = totals({
  subtotalSen: 2200, billDiscountSen: 200, serviceChargeSen: 200, sstSen: 109, roundingSen: 1, totalSen: 2310,
  sstGroups: [{ rateBp: 600, baseSen: 1818, amountSen: 109 }],
})
const a3Lines = [
  line({ name: 'Latte', qty: 1, unitPriceSen: 1000, taxRateBp: 600, sstSen: 60 }),
  line({ name: 'Cake', qty: 1, unitPriceSen: 800, takeawayFeeSen: 100, taxRateBp: 800, sstSen: 72 }),
]
const a3 = totals({
  subtotalSen: 1800, serviceChargeSen: 100, sstSen: 132, takeawayFeeSen: 100, roundingSen: -2, totalSen: 2130,
  sstGroups: [{ rateBp: 600, baseSen: 1000, amountSen: 60 }, { rateBp: 800, baseSen: 900, amountSen: 72 }],
})
const big = totals({ subtotalSen: 1_100_000, totalSen: 1_100_000 })
const bigLines = [line({ name: 'Catering', qty: 1, unitPriceSen: 1_100_000 })]

const bills = (): ReconcileBill[] => [
  { id: 'b1', branchId: 'o1', billNo: '261005-002', day: '2026-10-05', totalSen: 2310, totals: a1, lines: a1Lines },
  { id: 'b3', branchId: 'o1', billNo: '261031-001', day: '2026-10-31', totalSen: 2130, totals: a3, lines: a3Lines },
  { id: 'b6', branchId: 'o1', billNo: '261010-001', day: '2026-10-10', totalSen: 1_100_000, totals: big, lines: bigLines },
  { id: 'b9', branchId: 'o2', billNo: '261101-001', day: '2026-11-01', totalSen: 2310, totals: a1, lines: a1Lines },
]
const source = (b = bills(), octOverview = 1_104_440): ReconcileSource => ({
  bills: b,
  months: [{ branchId: 'o1', month: '2026-10', overviewSen: octOverview }, { branchId: 'o2', month: '2026-11', overviewSen: 2310 }],
})

describe('reconcile', () => {
  it('builds every bill and every outlet-month, and agrees with the bills and Reports → Overview', () => {
    const r = reconcile(source())
    expect(r).toMatchObject({ ok: true, bills: 4, singleOk: 4, singleProblems: [] })
    expect(r.months).toEqual([
      { branchId: 'o1', month: '2026-10', bills: 3, billsSen: 1_104_440, consolidatedSen: 4440, overLimitSen: 1_100_000, overviewSen: 1_104_440, ok: true },
      { branchId: 'o2', month: '2026-11', bills: 1, billsSen: 2310, consolidatedSen: 2310, overLimitSen: 0, overviewSen: 2310, ok: true },
    ])
  })

  it('names a bill whose document does not add up, and its month', () => {
    const b = bills()
    b[1] = { ...b[1], totalSen: 2135 }
    const r = reconcile(source(b, 1_104_445))
    expect(r.ok).toBe(false)
    expect(r.singleProblems).toEqual([{ branchId: 'o1', billNo: '261031-001', problem: 'The document adds up to 2130 sen, the bill is 2135 sen' }])
    expect(r.months[0]).toMatchObject({ ok: false, problem: 'The document adds up to 4440 sen, the bills are 4445 sen' })
  })

  it('names a month whose bills differ from Reports → Overview', () => {
    const r = reconcile(source(bills(), 1_104_000))
    expect(r.months[0]).toMatchObject({ ok: false, problem: 'Reports → Overview says 1104000 sen, the bills 1104440 sen' })
  })

  it('names a bill without checkout totals', () => {
    const b = bills()
    b[3] = { ...b[3], totals: null }
    const r = reconcile(source(b))
    expect(r.singleProblems).toEqual([{ branchId: 'o2', billNo: '261101-001', problem: 'This bill has no checkout totals' }])
    expect(r.months[1]).toMatchObject({ ok: false, problem: 'Bill 261101-001 has no checkout totals' })
  })
})
