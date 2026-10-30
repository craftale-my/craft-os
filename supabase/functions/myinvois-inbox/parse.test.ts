import { describe, expect, it } from 'vitest'
import { monthWindow, mytDate, parseRawDocument, registerFields, supplierKey } from './parse'

describe('monthWindow', () => {
  it('turns a Malaysian calendar month into a UTC window', () => {
    expect(monthWindow('2026-09', new Date('2026-12-01T00:00:00Z'))).toEqual({
      from: '2026-08-31T16:00:00Z',
      to: '2026-09-30T15:59:59Z',
    })
  })
  it('stops at now for the current month', () => {
    const w = monthWindow('2026-10', new Date('2026-10-15T10:00:00Z'))
    expect(w.to).toBe('2026-10-15T09:59:00Z')
  })
  it('rejects bad input and future months', () => {
    expect(() => monthWindow('2026-13')).toThrow()
    expect(() => monthWindow('2026/10')).toThrow()
    expect(() => monthWindow('2027-01', new Date('2026-10-15T00:00:00Z'))).toThrow(/future/)
  })
})

describe('mytDate', () => {
  it('moves a late-evening UTC timestamp to the next Malaysian day', () => {
    expect(mytDate('2026-10-31T17:30:00Z')).toBe('2026-11-01')
    expect(mytDate('2026-10-31T15:30:00Z')).toBe('2026-10-31')
    expect(mytDate(null)).toBeNull()
  })
})

describe('supplierKey', () => {
  it('ignores case and punctuation', () => {
    expect(supplierKey('LALAMOVE (M) Sdn. Bhd.')).toBe('lalamove m sdn bhd')
    expect(supplierKey('  Lalamove  m sdn bhd ')).toBe('lalamove m sdn bhd')
  })
})

describe('registerFields', () => {
  it('maps a received invoice with SST', () => {
    const f = registerFields({
      uuid: 'U1', internalId: 'INV-9', typeName: 'Invoice', supplierName: 'Maybank',
      dateTimeIssued: '2026-10-05T02:00:00Z', netAmount: 100, total: 106, status: 'Valid',
    })
    expect(f).toMatchObject({ doc_type: 'Validated e-Invoice', supplier: 'Maybank', supplier_ref: 'INV-9', doc_date: '2026-10-05', amount_myr: 106, sst: 6 })
  })
  it('recognises credit notes and leaves sst empty when there is none', () => {
    const f = registerFields({ uuid: 'U2', typeName: 'Credit Note', issuerName: 'Shopee', dateTimeIssued: '2026-10-05T02:00:00Z', netAmount: 10, total: 10 })
    expect(f.doc_type).toBe('Credit Note')
    expect(f.supplier).toBe('Shopee')
    expect(f.sst).toBeNull()
  })
})

describe('parseRawDocument', () => {
  it('reads UBL JSON', () => {
    const doc = JSON.stringify({
      Invoice: [{
        DocumentCurrencyCode: [{ _: 'MYR' }],
        TaxTotal: [{ TaxAmount: [{ _: 6, currencyID: 'MYR' }] }],
        InvoiceLine: [
          { InvoicedQuantity: [{ _: 2 }], LineExtensionAmount: [{ _: 100 }], Item: [{ Description: [{ _: 'Delivery fee' }] }] },
        ],
      }],
    })
    expect(parseRawDocument(doc)).toEqual({ currency: 'MYR', tax: 6, items: [{ descEn: 'Delivery fee', qty: 2, amount: 100 }] })
  })
  it('reads UBL XML and does not take a line tax as the document tax', () => {
    const xml = `<Invoice><cbc:DocumentCurrencyCode>MYR</cbc:DocumentCurrencyCode>
      <cac:InvoiceLine><cbc:InvoicedQuantity unitCode="C62">1</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="MYR">50.00</cbc:LineExtensionAmount>
      <cac:TaxTotal><cbc:TaxAmount currencyID="MYR">1.00</cbc:TaxAmount></cac:TaxTotal><cac:Item><cbc:Description>Milk &amp; cream</cbc:Description></cac:Item></cac:InvoiceLine>
      <cac:TaxTotal><cbc:TaxAmount currencyID="MYR">3.00</cbc:TaxAmount></cac:TaxTotal></Invoice>`
    expect(parseRawDocument(xml)).toEqual({ currency: 'MYR', tax: 3, items: [{ descEn: 'Milk & cream', qty: 1, amount: 50 }] })
  })
})
