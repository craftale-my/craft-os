import { describe, expect, it } from 'vitest'
import { renderZReportLines, signedMoney, type ZReport, type ZReportPayload } from './zreport'
import { jobLabel, renderJobLines } from './printJob'

// The first shift of the shifts verify script (supabase/migration-2026-10-24-pos-shifts-verify.sql,
// section F) with real-looking names and times: the numbers are the ones the SQL checks.
const shiftOne: ZReport = {
  branch: 'Craft Cafe – Cheras',
  openedAt: '2026-10-24T01:02:00.000Z', openedBy: 'Aina',
  closedAt: '2026-10-24T14:31:00.000Z', closedBy: 'Aina',
  summary: { billCount: 3, pax: 4, nettSen: 7565, avgPerBillSen: 2522, avgPerPaxSen: 1891, voidBillCount: 1, voidSen: 3100, refundSen: 1300 },
  sales: { grossSen: 7100, takeawayFeeSen: 100, serviceChargeSen: 0, sstSen: 366, roundingSen: -1, nettSen: 7565 },
  payments: [
    { name: 'Card', kind: 'card', count: 2, amountSen: 2550, refundCount: 1, refundSen: 300, netSen: 2250 },
    { name: 'Cash', kind: 'cash', count: 2, amountSen: 5015, refundCount: 1, refundSen: 1000, netSen: 4015 },
  ],
  orderTypes: [{ orderType: 'dine_in', bills: 2, nettSen: 4790 }, { orderType: 'takeaway', bills: 1, nettSen: 2775 }],
  sources: [{ source: 'counter', orders: 3, itemSen: 6550 }, { source: 'qr', orders: 1, itemSen: 550 }],
  cash: {
    openingFloatSen: 10000, cashSalesSen: 5015, cashRefundSen: 1000,
    moves: [
      { kind: 'pay_in', amountSen: 2000, reason: 'Float top-up', by: 'Aina', approvedBy: null, at: '2026-10-24T03:00:00.000Z' },
      { kind: 'pay_out', amountSen: 1500, reason: 'Ice', by: 'Aina', approvedBy: 'Hafiz', at: '2026-10-24T05:00:00.000Z' },
    ],
    payInSen: 2000, payOutSen: 1500, expectedSen: 14515, firstCountSen: 14000, firstVarianceSen: -515, countedSen: 13900, varianceSen: -615,
    varianceReason: 'Short — till miscount', varianceApprovedBy: 'Hafiz',
  },
  voids: {
    items: [
      { at: '2026-10-24T04:00:00.000Z', billNo: '261024-001', name: 'Iced Tea', qty: 1, valueSen: 550, reason: 'Wrong item keyed', by: 'Aina', approvedBy: 'Hafiz' },
      { at: '2026-10-24T04:10:00.000Z', billNo: '261024-004', name: 'Chicken Chop', qty: 1, valueSen: 2000, reason: 'Wrong item keyed', by: 'Aina', approvedBy: 'Hafiz' },
    ],
    bills: [{ at: '2026-10-24T04:20:00.000Z', billNo: '261024-005', reason: 'Customer left', by: 'Aina', approvedBy: 'Hafiz' }],
  },
  refunds: [
    { at: '2026-10-24T06:00:00.000Z', billNo: '261024-002', amountSen: 300, method: 'Card', reason: 'Cold food', approvedBy: 'Hafiz' },
    { at: '2026-10-24T06:05:00.000Z', billNo: '261024-001', amountSen: 1000, method: 'Cash', reason: 'Cold food', approvedBy: 'Hafiz' },
  ],
  products: [{ name: 'Chicken Chop', qty: 3, valueSen: 6000 }, { name: 'Iced Tea', qty: 2, valueSen: 1100 }],
}

const payload = (report: ZReport, reprint = false): ZReportPayload => ({ kind: 'zreport', route: 'Bar', reprint, report })

describe('renderZReportLines', () => {
  it('lays out the close up report at 48 columns', () => {
    expect(renderZReportLines(payload(shiftOne), 48)).toEqual([
      '              Craft Cafe - Cheras',
      '                CLOSE UP REPORT',
      '',
      'Opened                          24/10/2026 09:02',
      'Opened by                                   Aina',
      'Closed                          24/10/2026 22:31',
      'Closed by                                   Aina',
      '------------------------------------------------',
      'SUMMARY',
      'Bills                                          3',
      'Pax                                            4',
      'Nett sales                                 75.65',
      'Average per bill                           25.22',
      'Average per pax                            18.91',
      'Void bills                                     1',
      'Total void                                 31.00',
      'Total refund                               13.00',
      '------------------------------------------------',
      'SALES SUMMARY',
      'Gross sales                                71.00',
      'Takeaway fee                                1.00',
      'Service charge                              0.00',
      'SST                                         3.66',
      'Rounding                                   -0.01',
      'Nett sales                                 75.65',
      '------------------------------------------------',
      'PAYMENTS',
      'Card (2)                                   25.50',
      '  Refunds (1)                              -3.00',
      '  Net                                      22.50',
      'Cash (2)                                   50.15',
      '  Refunds (1)                             -10.00',
      '  Net                                      40.15',
      '------------------------------------------------',
      'ORDER TYPE',
      'Dine-in (2)                                47.90',
      'Takeaway (1)                               27.75',
      '------------------------------------------------',
      'SOURCE',
      'Counter (3 orders)                         65.50',
      'QR (1 order)                                5.50',
      '------------------------------------------------',
      'CASH DRAWER',
      'Opening float                             100.00',
      'Cash sales                                 50.15',
      'Cash refunds                              -10.00',
      'Pay in: Float top-up                       20.00',
      '  by Aina',
      'Pay out: Ice                              -15.00',
      '  by Aina, approved by Hafiz',
      'Expected cash                             145.15',
      'First count                               140.00',
      '  First variance                           -5.15',
      'Counted cash                              139.00',
      'Variance                                   -6.15',
      '  Reason: Short - till miscount',
      '  Approved by Hafiz',
      '------------------------------------------------',
      'VOIDS',
      '1 Iced Tea                                  5.50',
      '  261024-001, Wrong item keyed, by Aina,',
      '    approved by Hafiz',
      '1 Chicken Chop                             20.00',
      '  261024-004, Wrong item keyed, by Aina,',
      '    approved by Hafiz',
      'Bill 261024-005 voided, Customer left, by Aina,',
      '  approved by Hafiz',
      '------------------------------------------------',
      'REFUNDS',
      '261024-002 Card                             3.00',
      '  Cold food, approved by Hafiz',
      '261024-001 Cash                            10.00',
      '  Cold food, approved by Hafiz',
      '------------------------------------------------',
      'PRODUCT SALES',
      '3 Chicken Chop                             60.00',
      '2 Iced Tea                                 11.00',
      '------------------------------------------------',
      '                 END OF REPORT',
    ])
  })

  it('marks a reprint, hides a first count equal to the final one, and says when a list is empty', () => {
    const quiet: ZReport = {
      ...shiftOne,
      payments: [], refunds: [], products: [], voids: { items: [], bills: [] },
      cash: { ...shiftOne.cash, moves: [], firstCountSen: 14515, countedSen: 14515, varianceSen: 0, varianceReason: null, varianceApprovedBy: null },
    }
    const lines = renderZReportLines(payload(quiet, true), 48)
    expect(lines[0]).toBe('                *** REPRINT ***')
    expect(lines).not.toContain('First count                               145.15')
    expect(lines.some((l) => l.startsWith('  First variance'))).toBe(false)
    expect(lines).toContain('Variance                                    0.00')
    for (const empty of ['No payments', 'No voids', 'No refunds', 'No sales']) expect(lines).toContain(empty)
    expect(lines.some((l) => l.startsWith('  Reason:') || l.startsWith('  Approved by'))).toBe(false)
  })

  it('prints a first count without its variance when the report was frozen before the variance was stored', () => {
    const { firstVarianceSen: _gone, ...oldCash } = shiftOne.cash
    const lines = renderZReportLines(payload({ ...shiftOne, cash: oldCash as ZReport['cash'] }), 48)
    expect(lines).toContain('First count                               140.00')
    expect(lines.some((l) => l.startsWith('  First variance'))).toBe(false)
  })

  it('never prints a line wider than the paper', () => {
    const long: ZReport = { ...shiftOne, products: [{ name: 'Very Long Product Name With Many Words In It', qty: 12, valueSen: 123456 }] }
    for (const cols of [32, 42, 48]) {
      for (const l of renderZReportLines(payload(long), cols)) expect(l.length).toBeLessThanOrEqual(cols)
    }
  })
})

describe('signedMoney', () => {
  it('shows over with a plus and short with a minus', () => {
    expect(signedMoney(50)).toBe('+0.50')
    expect(signedMoney(-615)).toBe('-6.15')
    expect(signedMoney(0)).toBe('0.00')
  })
})

describe('the print hosts know the Z report', () => {
  it('renders it through renderJobLines and names it for the printer-problems list', () => {
    expect(renderJobLines(payload(shiftOne), 48)).toEqual(renderZReportLines(payload(shiftOne), 48))
    expect(jobLabel(payload(shiftOne))).toBe('Z report 24/10/2026 22:31')
    expect(jobLabel(payload(shiftOne, true))).toBe('Z report 24/10/2026 22:31 · REPRINT')
  })
})
