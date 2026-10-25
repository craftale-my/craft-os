import { describe, expect, it } from 'vitest'
import {
  allocate, billLines, buildDocument, dayLines, documentTotals, GENERAL_PUBLIC,
  type BillTotals, type DocInput, type Party,
} from './ubl.ts'

const supplier: Party = {
  name: 'Craftale Sdn Bhd', tin: 'C1234567890', idType: 'BRN', idValue: '202001234567',
  sstNo: 'W10-1234-56789012', msicCode: '56101', activity: 'Restaurants',
  address: { line: 'Taman Connaught', city: 'Kuala Lumpur', postcode: '56000', stateCode: '14', countryCode: 'MYS' },
  phone: '+60123456789',
}

const totals = (t: Partial<BillTotals>): BillTotals => ({
  subtotalSen: 0, serviceChargeSen: 0, sstSen: 0, takeawayFeeSen: 0, roundingSen: 0, totalSen: 0, sstGroups: [], ...t,
})

const doc = (over: Partial<DocInput>): DocInput => ({
  kind: 'invoice', codeNumber: 'INV-261026-ABC123', issuedAt: new Date('2026-10-26T04:05:06Z'),
  supplier, buyer: GENERAL_PUBLIC, lines: [], docChargeSen: 0, roundingSen: 0, ...over,
})

const invoice = (d: Record<string, unknown>) => (d.Invoice as Record<string, any>[])[0]

describe('allocate', () => {
  it('adds back to the total, largest remainder first', () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33])
    expect(allocate(7, [300, 700])).toEqual([2, 5])
    expect(allocate(0, [5, 5])).toEqual([0, 0])
  })
  it('puts everything on the first part when weights are zero', () => {
    expect(allocate(3, [0, 0])).toEqual([3, 0])
  })
})

describe('billLines', () => {
  // Dine-in: 2 × Latte RM 12.00 at 6 %, 1 × Keychain RM 15.00 at 0 %, 10 % service charge.
  const items = [
    { name: 'Coffee Latte (COLD)', qty: 2, unitPriceSen: 1200, sstRateBp: 600 },
    { name: 'Keychain', qty: 1, unitPriceSen: 1500, sstRateBp: 0 },
  ]
  const dineIn = totals({
    subtotalSen: 3900, serviceChargeSen: 390, sstSen: 144, roundingSen: 1, totalSen: 4435,
    sstGroups: [{ rateBp: 600, baseSen: 2400, amountSen: 144 }],
  })

  it('taxes the 6 % items with the group SST and leaves the 0 % item untaxed', () => {
    const { lines, docChargeSen, roundingSen } = billLines(items, dineIn)
    expect(lines.map((l) => [l.description, l.taxes[0].rateBp, l.taxes[0].taxSen])).toEqual([
      ['Coffee Latte (COLD)', 600, 144],
      ['Keychain', 0, 0],
    ])
    expect(docChargeSen).toBe(390)
    expect(roundingSen).toBe(1)
  })

  it('makes the packaging fee its own line at the items’ rate on a takeaway bill', () => {
    const t = totals({
      subtotalSen: 2400, takeawayFeeSen: 200, sstSen: 156, totalSen: 2756,
      sstGroups: [{ rateBp: 600, baseSen: 2600, amountSen: 156 }],
    })
    const { lines } = billLines([items[0]], t)
    expect(lines.map((l) => [l.description, l.qty * l.unitPriceSen, l.taxes[0].taxSen])).toEqual([
      ['Coffee Latte (COLD)', 2400, 144],
      ['Takeaway packaging', 200, 12],
    ])
  })

  it('treats every item as untaxed when the branch charged no SST', () => {
    const t = totals({ subtotalSen: 3900, takeawayFeeSen: 100, totalSen: 4000 })
    const { lines } = billLines(items, t)
    expect(lines.every((l) => l.taxes[0].rateBp === 0 && l.taxes[0].taxSen === 0)).toBe(true)
    expect(lines.at(-1)?.description).toBe('Takeaway packaging')
  })

  it('refuses a bill whose items do not match its totals', () => {
    expect(() => billLines(items, totals({ subtotalSen: 9999, sstGroups: [] }))).toThrow(/add up/)
  })

  it('builds a document whose payable equals the receipt total', () => {
    const parts = billLines(items, dineIn)
    const input = doc({ lines: parts.lines, docChargeSen: parts.docChargeSen, roundingSen: parts.roundingSen })
    expect(documentTotals(input).payable).toBe(dineIn.totalSen)

    const inv = invoice(buildDocument(input))
    expect(inv.LegalMonetaryTotal[0].PayableAmount[0]._).toBe(44.35)
    expect(inv.LegalMonetaryTotal[0].ChargeTotalAmount[0]._).toBe(3.9)
    expect(inv.TaxTotal[0].TaxAmount[0]._).toBe(1.44)
    // Untaxed slice = the Keychain + the service charge.
    expect(inv.TaxTotal[0].TaxSubtotal.map((s: any) => [s.TaxCategory[0].ID[0]._, s.TaxableAmount[0]._]))
      .toEqual([['06', 18.9], ['02', 24]])
    expect(inv.IssueDate[0]._).toBe('2026-10-26')
    expect(inv.IssueTime[0]._).toBe('04:05:06Z')
    expect(inv.InvoiceTypeCode[0]).toEqual({ _: '01', listVersionID: '1.0' })
  })
})

describe('dayLines', () => {
  const bill = (billNo: string, day: string, t: Partial<BillTotals>) => ({ billNo, day, totals: totals(t) })
  const bills = [
    bill('261001-002', '2026-10-01', {
      subtotalSen: 1000, serviceChargeSen: 100, sstSen: 60, roundingSen: 0, totalSen: 1160,
      sstGroups: [{ rateBp: 600, baseSen: 1000, amountSen: 60 }],
    }),
    bill('261001-001', '2026-10-01', {
      subtotalSen: 2000, takeawayFeeSen: 100, sstSen: 102, roundingSen: -2, totalSen: 2200,
      sstGroups: [{ rateBp: 600, baseSen: 1700, amountSen: 102 }],
    }),
    bill('261002-001', '2026-10-02', { subtotalSen: 500, totalSen: 500 }),
  ]

  it('makes one line per day with the receipt range and the day’s service charge', () => {
    const { lines, roundingSen } = dayLines(bills)
    expect(lines.map((l) => l.description)).toEqual([
      'Receipts 261001-001 – 261001-002 (2)',
      'Receipts 261002-001 – 261002-001 (1)',
    ])
    expect(lines[0]).toMatchObject({ unitPriceSen: 3100, chargeSen: 100, classification: '004' })
    expect(lines[0].taxes).toEqual([
      { rateBp: 0, baseSen: 500, taxSen: 0 },
      { rateBp: 600, baseSen: 2700, taxSen: 162 },
    ])
    expect(roundingSen).toBe(-2)
  })

  it('builds a consolidated document whose payable equals the bills’ totals', () => {
    const { lines, roundingSen } = dayLines(bills)
    const input = doc({
      kind: 'consolidated_invoice', lines, roundingSen,
      period: { start: '2026-10-01', end: '2026-10-31' },
    })
    expect(documentTotals(input).payable).toBe(1160 + 2200 + 500)
    const inv = invoice(buildDocument(input))
    expect(inv.InvoicePeriod[0].Description[0]._).toBe('Monthly')
    expect(inv.AccountingCustomerParty[0].Party[0].PartyIdentification[0].ID[0]._).toBe('EI00000000010')
    expect(inv.InvoiceLine[0].AllowanceCharge[0].Amount[0]._).toBe(1)
  })
})

describe('buildDocument', () => {
  it('refuses an empty document and a line whose tax bases do not cover it', () => {
    expect(() => buildDocument(doc({}))).toThrow(/at least one line/)
    expect(() => buildDocument(doc({
      lines: [{ description: 'x', classification: '022', qty: 1, unitPriceSen: 100, chargeSen: 0,
                taxes: [{ rateBp: 600, baseSen: 50, taxSen: 3 }] }],
    }))).toThrow(/do not cover/)
  })
})
