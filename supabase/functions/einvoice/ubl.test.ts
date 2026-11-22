import { describe, expect, it } from 'vitest'
import {
  addMix, allocate, billMix, buildDocument, dayLines, documentTotals, GENERAL_PUBLIC, ledgerBillLines, lineAmount, mixLines,
  mixTotal, refundMix, roundingOnly, type BillTotals, type DocInput, type LedgerLine, type Mix, type Party,
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

const line = (l: Partial<LedgerLine> & Pick<LedgerLine, 'name' | 'qty' | 'unitPriceSen'>): LedgerLine => {
  const gross = l.qty * l.unitPriceSen
  const net = l.netSen ?? gross
  const fee = l.takeawayFeeSen ?? 0
  return {
    itemId: l.name, grossSen: gross, catalogDiscountSen: 0, itemDiscountSen: 0, billShareSen: 0, netSen: net,
    takeawayFeeSen: fee, sstBaseSen: net + fee, taxRateBp: 0, sstSen: 0, ...l,
  }
}

const doc = (over: Partial<DocInput>): DocInput => ({
  kind: 'invoice', codeNumber: 'INV-261026-ABC123', issuedAt: new Date('2026-10-26T04:05:06Z'),
  supplier, buyer: GENERAL_PUBLIC, lines: [], docChargeSen: 0, roundingSen: 0, ...over,
})

const invoice = (d: Record<string, unknown>) => (d.Invoice as Record<string, any>[])[0]

// The verify's bills (supabase/migration-2026-11-23-einvoice-w5-verify.sql), priced by pos_compute_bill.
// EA1: dine-in, 2 × Latte 10.00 (6%) and Water 2.00 (0%), RM 2.00 off the bill, 10% service charge → 23.10
const a1Lines = [
  line({ name: 'Latte', qty: 2, unitPriceSen: 1000, billShareSen: 182, netSen: 1818, taxRateBp: 600, sstSen: 109 }),
  line({ name: 'Water', qty: 1, unitPriceSen: 200, billShareSen: 18, netSen: 182 }),
]
const a1 = totals({
  subtotalSen: 2200, billDiscountSen: 200, serviceChargeSen: 200, sstSen: 109, roundingSen: 1, totalSen: 2310,
  sstGroups: [{ rateBp: 600, baseSen: 1818, amountSen: 109 }],
})
// EA2: takeaway Cake 8.00 (8%) with 0.50 packaging → 9.20
const a2 = totals({
  subtotalSen: 800, sstSen: 68, takeawayFeeSen: 50, roundingSen: 2, totalSen: 920,
  sstGroups: [{ rateBp: 800, baseSen: 850, amountSen: 68 }],
})
// EA3: dine-in Latte 10.00 (6%) and a takeaway Cake 8.00 (8%) with 1.00 packaging → 21.30
const a3Lines = [
  line({ name: 'Latte', qty: 1, unitPriceSen: 1000, taxRateBp: 600, sstSen: 60 }),
  line({ name: 'Cake', qty: 1, unitPriceSen: 800, takeawayFeeSen: 100, taxRateBp: 800, sstSen: 72 }),
]
const a3 = totals({
  subtotalSen: 1800, serviceChargeSen: 100, sstSen: 132, takeawayFeeSen: 100, roundingSen: -2, totalSen: 2130,
  sstGroups: [{ rateBp: 600, baseSen: 1000, amountSen: 60 }, { rateBp: 800, baseSen: 900, amountSen: 72 }],
})

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

describe('ledgerBillLines', () => {
  it('makes one line per item: the discount as an allowance, the tax as the ledger split it', () => {
    const { lines, docChargeSen, roundingSen } = ledgerBillLines(a1Lines, a1)
    expect(lines.map((l) => [l.description, l.qty, l.unitPriceSen, l.allowanceSen, l.chargeSen, l.taxes])).toEqual([
      ['Latte', 2, 1000, 182, 0, [{ rateBp: 600, baseSen: 1818, taxSen: 109 }]],
      ['Water', 1, 200, 18, 0, [{ rateBp: 0, baseSen: 182, taxSen: 0 }]],
    ])
    expect(lines.every((l) => l.classification === '022')).toBe(true)
    expect(docChargeSen).toBe(200)
    expect(roundingSen).toBe(1)
    expect(documentTotals(doc({ lines, docChargeSen, roundingSen })).payable).toBe(2310)
  })

  it('carries a takeaway line’s packaging as a charge taxed with the line', () => {
    const parts = ledgerBillLines(a3Lines, a3)
    expect(parts.lines[1]).toMatchObject({ description: 'Cake', chargeSen: 100, taxes: [{ rateBp: 800, baseSen: 900, taxSen: 72 }] })
    expect(lineAmount(parts.lines[1])).toBe(900)
    expect(documentTotals(doc({ lines: parts.lines, docChargeSen: parts.docChargeSen, roundingSen: parts.roundingSen })).payable).toBe(2130)
  })

  it('refuses lines whose SST is not what the bill charged, and a bill with no lines', () => {
    expect(() => ledgerBillLines(a1Lines, { ...a1, sstSen: 110 })).toThrow(/SST adds up to 109 sen, the bill charged 110/)
    expect(() => ledgerBillLines([], a1)).toThrow(/no live lines/)
    expect(() => ledgerBillLines([{ ...a1Lines[0], sstBaseSen: 1 }], a1)).toThrow(/SST base/)
  })

  it('writes the discount and the packaging into the UBL line', () => {
    const a = ledgerBillLines(a1Lines, a1)
    const inv = invoice(buildDocument(doc({ lines: a.lines, docChargeSen: a.docChargeSen, roundingSen: a.roundingSen })))
    expect(inv.InvoiceTypeCode[0]).toEqual({ _: '01', listVersionID: '1.0' })
    expect(inv.InvoiceLine[0].AllowanceCharge).toEqual([
      { ChargeIndicator: [{ _: false }], AllowanceChargeReason: [{ _: 'Discount' }], Amount: [{ _: 1.82, currencyID: 'MYR' }] },
    ])
    expect(inv.InvoiceLine[0].LineExtensionAmount[0]._).toBe(18.18)
    expect(inv.InvoiceLine[0].ItemPriceExtension[0].Amount[0]._).toBe(20)
    expect(inv.LegalMonetaryTotal[0].PayableAmount[0]._).toBe(23.1)
    expect(inv.LegalMonetaryTotal[0].ChargeTotalAmount[0]._).toBe(2)
    // untaxed slice = the Water (1.82) + the service charge (2.00)
    expect(inv.TaxTotal[0].TaxSubtotal.map((s: any) => [s.TaxCategory[0].ID[0]._, s.TaxableAmount[0]._]))
      .toEqual([['06', 3.82], ['02', 18.18]])

    const c = ledgerBillLines(a3Lines, a3)
    const cake = invoice(buildDocument(doc({ lines: c.lines, docChargeSen: c.docChargeSen, roundingSen: c.roundingSen }))).InvoiceLine[1]
    expect(cake.AllowanceCharge).toEqual([
      { ChargeIndicator: [{ _: true }], AllowanceChargeReason: [{ _: 'Takeaway packaging' }], Amount: [{ _: 1, currencyID: 'MYR' }] },
    ])
    expect(cake.LineExtensionAmount[0]._).toBe(9)
  })
})

describe('billMix and refundMix', () => {
  it('splits a bill into SST slices, untaxed goods (after the bill discount), service charge and rounding', () => {
    expect(billMix(a1)).toEqual({ taxed: [{ rateBp: 600, baseSen: 1818, taxSen: 109 }], untaxedSen: 182, serviceChargeSen: 200, roundingSen: 1 })
    expect(mixTotal(billMix(a1))).toBe(2310)
    expect(billMix(a3)).toEqual({
      taxed: [{ rateBp: 600, baseSen: 1000, taxSen: 60 }, { rateBp: 800, baseSen: 900, taxSen: 72 }],
      untaxedSen: 0, serviceChargeSen: 100, roundingSen: -2,
    })
    expect(mixTotal(billMix(a3))).toBe(2130)
  })

  it('refuses SST bases larger than the goods', () => {
    expect(() => billMix(totals({ subtotalSen: 100, sstGroups: [{ rateBp: 600, baseSen: 200, amountSen: 12 }] }))).toThrow(/more than its goods/)
  })

  it('credits a whole refund exactly as the bill was', () => {
    expect(refundMix(billMix(a1), 2310, 0)).toEqual(billMix(a1))
  })

  it('spreads a partial refund over the bill’s mix by largest remainder, tax inside each SST slice', () => {
    const m = refundMix(billMix(a1), 300, 0)
    expect(m).toEqual({ taxed: [{ rateBp: 600, baseSen: 236, taxSen: 14 }], untaxedSen: 24, serviceChargeSen: 26, roundingSen: 0 })
    expect(mixTotal(m)).toBe(300)
  })

  it('never credits more tax than the bill charged', () => {
    const m = refundMix(billMix(a1), 2309, 0)
    expect(m.taxed[0].taxSen).toBeLessThanOrEqual(109)
    expect(mixTotal(m)).toBe(2309)
  })

  it('refuses a refund of nothing or of more than the bill', () => {
    expect(() => refundMix(billMix(a1), 0, 0)).toThrow(/does not fit/)
    expect(() => refundMix(billMix(a1), 2311, 0)).toThrow(/does not fit/)
  })
})

describe('refundMix in pieces', () => {
  const sumTax = (ms: ReturnType<typeof refundMix>[]) =>
    ms[0].taxed.map((_, i) => ms.reduce((a, m) => a + m.taxed[i].taxSen, 0))

  it('credits the bill’s SST exactly when 11 sen and 2299 sen are refunded in turn', () => {
    const bill = billMix(a1)
    const first = refundMix(bill, 11, 0)
    const second = refundMix(bill, 2299, 11)
    expect(sumTax([first, second])).toEqual([109])
    expect(mixTotal(first)).toBe(11)
    expect(mixTotal(second)).toBe(2299)
    expect(addMix(first, second)).toEqual(bill)
  })

  const three: Mix = {
    taxed: [{ rateBp: 600, baseSen: 3489, taxSen: 209 }, { rateBp: 800, baseSen: 3489, taxSen: 279 }, { rateBp: 1000, baseSen: 2337, taxSen: 234 }],
    untaxedSen: 576, serviceChargeSen: 0, roundingSen: -2,
  }
  const fixtures: [string, Mix][] = [['EA1', billMix(a1)], ['EA2', billMix(a2)], ['EA3', billMix(a3)], ['three rates', three]]
  const nonNegative = (m: Mix) => {
    expect(m.untaxedSen).toBeGreaterThanOrEqual(0)
    expect(m.serviceChargeSen).toBeGreaterThanOrEqual(0)
    m.taxed.forEach((p) => { expect(p.baseSen).toBeGreaterThanOrEqual(0); expect(p.taxSen).toBeGreaterThanOrEqual(0) })
  }
  const sequence = (bill: Mix, pieces: number[]) => {
    let before = 0
    const notes = pieces.map((x) => { const m = refundMix(bill, x, before); before += x; return m })
    pieces.forEach((x, i) => { expect(mixTotal(notes[i])).toBe(x); nonNegative(notes[i]) })
    expect(notes.reduce(addMix)).toEqual(bill)
  }

  it('three pieces of every fixture always add back to the bill, every slice non-negative', () => {
    for (const [, bill] of fixtures) {
      const total = mixTotal(bill)
      const step = Math.max(1, Math.floor(total / 25))
      for (let x = 1; x < total - 1; x += x < 8 ? 1 : step) {
        for (let y = 1; x + y < total; y += y < 8 ? 1 : step) sequence(bill, [x, y, total - x - y])
      }
    }
  })

  it('the reviewer’s cases: 512 + 2 + 1796 of EA1 and 3333 + 1 + 7277 of the three-rate bill', () => {
    sequence(billMix(a1), [512, 2, 1796])
    sequence(three, [3333, 1, 7277])
  })

  it('seeded random sequences of pieces', () => {
    let seed = 12345
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (const [, bill] of fixtures) {
      const total = mixTotal(bill)
      for (let k = 0; k < 40; k++) {
        const pieces: number[] = []
        let left = total
        while (left > 0) {
          const x = Math.min(left, 1 + Math.floor(rnd() * rnd() * left))
          pieces.push(x)
          left -= x
        }
        sequence(bill, pieces)
      }
    }
  })

  it('a rounding-only note is one untaxed line, so the document is valid', () => {
    const bill = billMix(a2)
    let found: { before: number; sen: number } | null = null
    for (let before = 0; before < 918 && !found; before++) {
      if (roundingOnly(refundMix(bill, 1, before))) found = { before, sen: 1 }
    }
    expect(found).not.toBeNull()
    const note = refundMix(bill, found!.sen, found!.before)
    expect(roundingOnly(note)).toBe(true)
    const lines = mixLines(note, 'Refund of receipt X', '022')
    expect(lines.map((l) => [l.description, l.unitPriceSen, l.taxes[0].rateBp])).toEqual([['Refund of receipt X, rounding adjustment', 1, 0]])
    const input = doc({ kind: 'credit_note', lines, roundingSen: 0, references: [{ codeNumber: 'INV-1', uuid: 'U' }] })
    expect(documentTotals(input).payable).toBe(1)
    expect(() => buildDocument(input)).not.toThrow()
  })

  it('pieces of 9 sen add up to the bill’s mix', () => {
    const bill = billMix(a1)
    let before = 0
    let acc: ReturnType<typeof refundMix> | null = null
    while (before < 2310) {
      const piece = Math.min(9, 2310 - before)
      const m = refundMix(bill, piece, before)
      acc = acc ? addMix(acc, m) : m
      before += piece
    }
    expect(acc!.taxed[0].taxSen).toBe(109)
    expect(mixTotal(acc!)).toBe(2310)
  })

  it('refuses pieces that together pass the bill', () => {
    expect(() => refundMix(billMix(a1), 300, 2100)).toThrow(/does not fit/)
  })
})

describe('dayLines', () => {
  const entries = [
    { billNo: '261005-002', day: '2026-10-05', mix: billMix(a1) },
    { billNo: '261005-001', day: '2026-10-05', mix: billMix(a2) },
    { billNo: '261031-001', day: '2026-10-31', mix: billMix(a3) },
  ]

  it('makes per business day one line per SST rate, one for untaxed goods and one for the service charge', () => {
    const { lines, roundingSen } = dayLines(entries)
    expect(lines.map((l) => [l.description, l.unitPriceSen, l.taxes[0].rateBp, l.taxes[0].taxSen])).toEqual([
      ['Receipts 261005-001 – 261005-002 (2), SST 6%', 1818, 600, 109],
      ['Receipts 261005-001 – 261005-002 (2), SST 8%', 850, 800, 68],
      ['Receipts 261005-001 – 261005-002 (2), no SST', 182, 0, 0],
      ['Receipts 261005-001 – 261005-002 (2), service charge', 200, 0, 0],
      ['Receipts 261031-001 – 261031-001 (1), SST 6%', 1000, 600, 60],
      ['Receipts 261031-001 – 261031-001 (1), SST 8%', 900, 800, 72],
      ['Receipts 261031-001 – 261031-001 (1), service charge', 100, 0, 0],
    ])
    expect(lines.every((l) => l.classification === '004' && l.qty === 1 && l.allowanceSen === 0 && l.chargeSen === 0)).toBe(true)
    expect(roundingSen).toBe(1)
  })

  it('builds a consolidated document whose payable equals the bills’ totals', () => {
    const { lines, roundingSen } = dayLines(entries)
    const input = doc({ kind: 'consolidated_invoice', lines, roundingSen, period: { start: '2026-10-01', end: '2026-10-31' } })
    expect(documentTotals(input).payable).toBe(2310 + 920 + 2130)
    const inv = invoice(buildDocument(input))
    expect(inv.InvoicePeriod[0].Description[0]._).toBe('Monthly')
    expect(inv.AccountingCustomerParty[0].Party[0].PartyIdentification[0].ID[0]._).toBe('EI00000000010')
    expect(inv.InvoiceLine[0].AllowanceCharge).toBeUndefined()
  })

  it('labels refunds', () => {
    const { lines } = dayLines([{ billNo: '261005-002', day: '2026-10-06', mix: refundMix(billMix(a1), 300, 0) }], 'Refunds of receipts')
    expect(lines[0].description).toBe('Refunds of receipts 261005-002 – 261005-002 (1), SST 6%')
  })
})

describe('credit notes', () => {
  const lines = mixLines(refundMix(billMix(a1), 300, 0), 'Refund of receipt 261005-002', '022')

  it('is type 02 and names the invoice it corrects', () => {
    expect(lines.map((l) => l.description)).toEqual([
      'Refund of receipt 261005-002, SST 6%', 'Refund of receipt 261005-002, no SST', 'Refund of receipt 261005-002, service charge',
    ])
    const inv = invoice(buildDocument(doc({
      kind: 'credit_note', codeNumber: 'CN-261107-AAAAAA', lines,
      references: [{ codeNumber: 'INV-261006-ABC123', uuid: 'F9D425P6DS7D8IU' }],
    })))
    expect(inv.InvoiceTypeCode[0]).toEqual({ _: '02', listVersionID: '1.0' })
    expect(inv.BillingReference).toEqual([
      { InvoiceDocumentReference: [{ ID: [{ _: 'INV-261006-ABC123' }], UUID: [{ _: 'F9D425P6DS7D8IU' }] }] },
    ])
    expect(inv.LegalMonetaryTotal[0].PayableAmount[0]._).toBe(3)
  })

  it('refuses a credit note that names no invoice', () => {
    expect(() => buildDocument(doc({ kind: 'consolidated_credit_note', lines }))).toThrow(/needs the document it corrects/)
  })
})

describe('buildDocument', () => {
  const plain = { description: 'x', classification: '022', qty: 1, unitPriceSen: 100, allowanceSen: 0, chargeSen: 0 }
  it('refuses an empty document and a line whose tax bases do not cover it', () => {
    expect(() => buildDocument(doc({}))).toThrow(/at least one line/)
    expect(() => buildDocument(doc({ lines: [{ ...plain, taxes: [{ rateBp: 600, baseSen: 50, taxSen: 3 }] }] }))).toThrow(/do not cover/)
  })
  it('refuses a credit note whose reference has no UUID', () => {
    const l = { ...plain, taxes: [{ rateBp: 0, baseSen: 100, taxSen: 0 }] }
    expect(() => buildDocument(doc({ kind: 'credit_note', lines: [l], references: [{ codeNumber: 'INV-1', uuid: '' }] })))
      .toThrow(/code number and UUID/)
  })
  it('refuses a discount larger than the line', () => {
    expect(() => buildDocument(doc({ lines: [{ ...plain, allowanceSen: 101, taxes: [{ rateBp: 0, baseSen: -1, taxSen: 0 }] }] })))
      .toThrow(/out of range/)
  })
})
