import { describe, expect, it } from 'vitest'
import {
  billInvoice, OVER_LIMIT_SEN, PlanError, planConsolidated, planConsolidatedCreditNote, planCreditNote, planInvoice,
  type BillSource, type PendingRefund, type PlanCtx,
} from './documents.ts'
import { buildDocument, documentTotals, GENERAL_PUBLIC, type BillTotals, type LedgerLine, type Party } from './ubl.ts'

const supplier: Party = {
  name: 'Craftale Sdn Bhd', tin: 'C1234567890', idType: 'BRN', idValue: '202001234567', sstNo: 'NA', msicCode: '56101',
  activity: 'Restaurants', address: { line: 'Taman Connaught', city: 'Kuala Lumpur', stateCode: '14', countryCode: 'MYS' },
  phone: '+60123456789',
}
const buyer: Party = {
  name: 'Acme Catering Sdn Bhd', tin: 'C9876543210', idType: 'BRN', idValue: '201901012345', sstNo: 'NA',
  address: { line: 'NA', city: 'NA', stateCode: '17', countryCode: 'MYS' }, phone: 'NA',
}
const ctx: PlanCtx = { supplier, issuedAt: new Date('2026-10-31T23:00:00Z') }

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
// EA1 and EA3 of the W5 verify
const a1Lines = [
  line({ name: 'Latte', qty: 2, unitPriceSen: 1000, billShareSen: 182, netSen: 1818, taxRateBp: 600, sstSen: 109 }),
  line({ name: 'Water', qty: 1, unitPriceSen: 200, billShareSen: 18, netSen: 182 }),
]
const a1 = totals({
  subtotalSen: 2200, billDiscountSen: 200, serviceChargeSen: 200, sstSen: 109, roundingSen: 1, totalSen: 2310,
  sstGroups: [{ rateBp: 600, baseSen: 1818, amountSen: 109 }],
})
const a3 = totals({
  subtotalSen: 1800, serviceChargeSen: 100, sstSen: 132, takeawayFeeSen: 100, roundingSen: -2, totalSen: 2130,
  sstGroups: [{ rateBp: 600, baseSen: 1000, amountSen: 60 }, { rateBp: 800, baseSen: 900, amountSen: 72 }],
})
const bigLines = [line({ name: 'Catering', qty: 1, unitPriceSen: 1_100_000 })]
const big = totals({ subtotalSen: 1_100_000, totalSen: 1_100_000 })

const source = (over: Partial<BillSource['bill']> = {}, rest: Partial<Omit<BillSource, 'bill'>> = {}): BillSource => ({
  bill: {
    id: 'b1', branchId: 'o1', billNo: '261005-002', status: 'paid', businessDay: '2026-10-05', totalSen: 2310,
    refundedSen: 0, einvoiceFrom: '2026-10-01', ...over,
  },
  totals: a1, lines: a1Lines, ...rest,
})

const refund = (over: Partial<PendingRefund> = {}): PendingRefund => ({
  refundId: 'r1', billId: 'b1', branchId: 'o1', billNo: '261005-002', amountSen: 300, refundDay: '2026-10-06',
  totals: a1, invoiceCode: 'CON-261101-AAAAAA', invoiceUuid: 'UUID-OCT', invoiceBuyer: null, ...over,
})

describe('planInvoice', () => {
  it('makes a paid bill after the start date its own e-invoice that adds up to the bill', () => {
    const p = planInvoice(source(), ctx, null)
    expect(p.kind).toBe('invoice')
    expect(p.totalSen).toBe(2310)
    const input = p.build('INV-261101-ABCDEF')
    expect(input.buyer).toBe(GENERAL_PUBLIC)
    expect(input.codeNumber).toBe('INV-261101-ABCDEF')
    expect(input.docChargeReason).toBe('Service charge')
    expect(documentTotals(input).payable).toBe(2310)
    expect(() => buildDocument(input)).not.toThrow()
  })

  it('refuses what we do not report', () => {
    const cases: [Partial<BillSource['bill']>, RegExp][] = [
      [{ status: 'open' }, /Only a paid bill/],
      [{ einvoiceFrom: null }, /not reported by us yet/],
      [{ businessDay: '2026-09-30' }, /Feedme reports it/],
    ]
    for (const [over, msg] of cases) {
      expect(() => planInvoice(source(over), ctx, null)).toThrow(PlanError)
      expect(() => planInvoice(source(over), ctx, null)).toThrow(msg)
    }
  })

  it('needs the buyer for a bill over RM 10,000', () => {
    const src = source({ totalSen: 1_100_000, billNo: '261010-001' }, { totals: big, lines: bigLines })
    expect(1_100_000).toBeGreaterThan(OVER_LIMIT_SEN)
    expect(() => planInvoice(src, ctx, null)).toThrow(/needs the buyer's details/)
    const p = planInvoice(src, ctx, buyer)
    expect(p.build('INV-1').buyer).toBe(buyer)
    expect(p.totalSen).toBe(1_100_000)
  })

  it('refuses a document that does not add up to the bill, before anything is created', () => {
    expect(() => planInvoice(source({ totalSen: 2315 }), ctx, null)).toThrow(/adds up to 2310 sen, the bill is 2315 sen/)
    expect(() => billInvoice(a1Lines, null, 2310, ctx, null)).toThrow(/no checkout totals/)
  })
})

describe('planConsolidated', () => {
  const period = { start: '2026-10-01', end: '2026-10-31' }

  it('adds up to the month’s bills', () => {
    const p = planConsolidated([
      { id: 'b1', billNo: '261005-002', day: '2026-10-05', totalSen: 2310, totals: a1 },
      { id: 'b3', billNo: '261031-001', day: '2026-10-31', totalSen: 2130, totals: a3 },
    ], period, ctx)
    expect(p.kind).toBe('consolidated_invoice')
    expect(p.totalSen).toBe(4440)
    const input = p.build('CON-261101-ABCDEF')
    expect(input.buyer).toBe(GENERAL_PUBLIC)
    expect(input.period).toEqual(period)
    expect(documentTotals(input).payable).toBe(4440)
  })

  it('refuses a bill without totals and an empty month', () => {
    expect(() => planConsolidated([{ id: 'b1', billNo: '261005-002', day: '2026-10-05', totalSen: 2310, totals: null }], period, ctx))
      .toThrow(/261005-002 has no checkout totals/)
    expect(() => planConsolidated([], period, ctx)).toThrow(/No bills/)
  })
})

describe('credit notes', () => {
  it('credits one refund against the invoice, to its buyer', () => {
    const p = planCreditNote(refund({ invoiceCode: 'INV-261006-ABC123', invoiceUuid: 'UUID-INV', invoiceBuyer: buyer }), ctx)
    expect(p.kind).toBe('credit_note')
    expect(p.totalSen).toBe(300)
    const input = p.build('CN-261107-AAAAAA')
    expect(input.buyer).toBe(buyer)
    expect(input.references).toEqual([{ codeNumber: 'INV-261006-ABC123', uuid: 'UUID-INV' }])
    expect(input.lines[0].description).toBe('Refund of receipt 261005-002, SST 6%')
    expect(documentTotals(input).payable).toBe(300)
  })

  it('credits a month’s refunds in one document naming each consolidated invoice once', () => {
    const period = { start: '2026-10-01', end: '2026-10-31' }
    const p = planConsolidatedCreditNote([
      refund(),
      refund({ refundId: 'r2', billId: 'b3', billNo: '261031-001', totals: a3, amountSen: 2130, refundDay: '2026-10-31',
               invoiceCode: 'CON-261201-BBBBBB', invoiceUuid: 'UUID-NOV' }),
      refund({ refundId: 'r3', amountSen: 100 }),
    ], period, ctx)
    expect(p.kind).toBe('consolidated_credit_note')
    expect(p.totalSen).toBe(2530)
    const input = p.build('CCN-261201-CCCCCC')
    expect(input.buyer).toBe(GENERAL_PUBLIC)
    expect(input.period).toEqual(period)
    expect(input.references).toEqual([
      { codeNumber: 'CON-261101-AAAAAA', uuid: 'UUID-OCT' }, { codeNumber: 'CON-261201-BBBBBB', uuid: 'UUID-NOV' },
    ])
    expect(input.lines[0].description).toBe('Refunds of receipts 261005-002 – 261005-002 (2), SST 6%')
    expect(documentTotals(input).payable).toBe(2530)
  })

  it('refuses a refund larger than its bill', () => {
    expect(() => planCreditNote(refund({ amountSen: 9999 }), ctx)).toThrow(PlanError)
    expect(() => planCreditNote(refund({ amountSen: 9999 }), ctx)).toThrow(/does not fit/)
  })
})
