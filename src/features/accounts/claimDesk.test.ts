import { describe, expect, it } from 'vitest'
import {
  ascii, buildAutoCountCsv, monthRange, normaliseTaobao, slicePlan, suggestVoucher, supplierKey, taobaoTotals,
  type AccountDoc,
} from './claimDesk'

const doc = (over: Partial<AccountDoc>): AccountDoc => ({
  id: 'x', source: 'paper', doc_type: 'Supplier Invoice', platform: null, supplier: 'ABC', supplier_ref: 'INV1',
  doc_date: '2026-10-05', currency: 'MYR', amount: 10, rate: null, amount_myr: 10, sst: null, description: null,
  gl_account: 'Packaging Materials', tax_treatment: null, payment: 'Paid by company', claimant: null,
  self_billed: 'Not required', self_billed_uuid: null, voucher_no: null, status: 'Draft', notes: null, items: [],
  files: [], einvoice_uuid: null, einvoice: null, claim_id: null, created_at: '', updated_at: '', ...over,
})

describe('suggestVoucher', () => {
  it('picks the prefix from document type and payment', () => {
    expect(suggestVoucher({ payment: 'Staff-paid (Reimbursement)', doc_date: '2026-10-20' }, [])).toBe('EC-2610-001')
    expect(suggestVoucher({ payment: 'Paid by company', doc_date: '2026-10-20' }, [])).toBe('PV-2610-001')
    expect(suggestVoucher({ payment: 'Unpaid (Accounts Payable)', doc_date: '2026-09-02' }, [])).toBe('PI-2609-001')
    expect(suggestVoucher({ doc_type: 'Credit Note', payment: 'Paid by company', doc_date: '2026-10-01' }, [])).toBe('CN-2610-001')
  })
  it('continues after the highest number of the same prefix and month', () => {
    expect(suggestVoucher({ payment: 'Paid by company', doc_date: '2026-10-20' },
      ['PV-2610-002', 'PV-2610-010', 'PV-2609-099', 'EC-2610-050', null])).toBe('PV-2610-011')
  })
})

describe('buildAutoCountCsv', () => {
  it('quotes cells, adds account codes, skips cancelled rows and counts gaps', () => {
    const r = buildAutoCountCsv([
      doc({ supplier: 'Kedai "Ah Seng", KL', voucher_no: 'PV-2610-001' }),
      doc({ status: 'Cancelled' }),
      doc({ gl_account: null, amount_myr: null }),
    ], [{ name: 'Packaging Materials', code: '610-100' }])
    expect(r.rows).toBe(2)
    expect(r.missing).toBe(1)
    expect(r.csv.startsWith('﻿Voucher No,Doc Type')).toBe(true)
    const line = r.csv.split('\r\n')[1]
    expect(line).toContain('"Kedai ""Ah Seng"", KL"')
    expect(line).toContain(',610-100,Packaging Materials,')
  })
})

describe('taobao', () => {
  it('normalises a loose model reply', () => {
    const r = normaliseTaobao({ orders: [{ orderNo: 123, orderDate: '2026/10/01', items: [{ descEn: 'Cup', qty: '2', amountCny: '1,000.50' }] }] })
    expect(r.orders[0].orderNo).toBe('123')
    expect(r.orders[0].orderDate).toBe('')
    expect(r.orders[0].items[0]).toMatchObject({ qty: 2, amountCny: 1000.5 })
    expect(normaliseTaobao(null).orders).toEqual([])
  })
  it('uses the paid totals when every order shows one', () => {
    expect(taobaoTotals([
      { items: [{ amountCny: 50 }], shippingCny: 5, totalPaidCny: 52 },
      { items: [{ amountCny: 20 }], totalPaidCny: 20 },
    ]).total).toBe(72)
  })
  it('falls back to items + shipping − discount', () => {
    expect(taobaoTotals([{ items: [{ amountCny: 50 }, { amountCny: 10.1 }], shippingCny: 5, discountCny: 3 }]))
      .toEqual({ items: 60.1, shipping: 5, discount: 3, total: 62.1 })
  })
})

describe('helpers', () => {
  it('supplierKey ignores case and punctuation', () => {
    expect(supplierKey('Lalamove (M) Sdn. Bhd.')).toBe('lalamove m sdn bhd')
  })
  it('monthRange knows month lengths', () => {
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(monthRange('2028-02').to).toBe('2028-02-29')
  })
  it('ascii keeps the PDF to Latin-1', () => {
    expect(ascii('Café – 杯子 ≤ 2×')).toBe('Cafe -  <= 2x')
  })
  it('slicePlan keeps normal photos whole and cuts long screenshots into overlapping bands', () => {
    expect(slicePlan(3000, 4000)).toHaveLength(1)
    const bands = slicePlan(1080, 6000)
    expect(bands.length).toBeGreaterThan(2)
    expect(bands[0].sy).toBe(0)
    const last = bands[bands.length - 1]
    expect(last.sy + last.sh).toBe(6000)
    for (let i = 1; i < bands.length; i++) expect(bands[i].sy).toBeLessThan(bands[i - 1].sy + bands[i - 1].sh)
  })
})
