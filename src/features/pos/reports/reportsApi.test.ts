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

  it('an error with an empty message still says something', async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { message: '' } })
    await expect(fetchSalesReport(Q)).rejects.toThrow('Unknown error')
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
