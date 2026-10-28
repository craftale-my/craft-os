import { describe, expect, it } from 'vitest'
import { checkSettings, cleanSettings, errorText, openProblems, retryFor, type EinvoiceDoc, type SettingsForm } from './einvoice'

const filled: SettingsForm = {
  supplier_name: 'Craftale Sdn Bhd', supplier_tin: 'c12345678090', supplier_brn: '2019 0101 2345',
  supplier_sst_no: '', supplier_ttx_no: '', msic_code: '56101', business_activity: 'Cafe',
  address_line: '1 Jalan Kepong', city: 'Kuala Lumpur', postcode: '52100', state_code: '14',
  phone: '+60 12-345 6789', email: '',
}

describe('cleanSettings', () => {
  it('trims, upper-cases the TIN, strips BRN spacing and turns blank SST/TTx into NA', () => {
    const c = cleanSettings(filled)
    expect(c.supplier_tin).toBe('C12345678090')
    expect(c.supplier_brn).toBe('201901012345')
    expect(c.supplier_sst_no).toBe('NA')
    expect(c.supplier_ttx_no).toBe('NA')
    expect(c.phone).toBe('+60123456789')
    expect(c.email).toBeNull()
  })
})

describe('checkSettings', () => {
  it('passes a complete company', () => {
    expect(checkSettings(cleanSettings(filled))).toEqual({})
  })

  it('names every required field that is blank', () => {
    const errs = checkSettings(cleanSettings({ ...filled, supplier_name: ' ', city: '', phone: '' }))
    expect(Object.keys(errs).sort()).toEqual(['city', 'phone', 'supplier_name'])
  })

  it('rejects malformed TIN, BRN, MSIC, state and postcode', () => {
    const errs = checkSettings(cleanSettings({
      ...filled, supplier_tin: '12345', supplier_brn: '1234567-A', msic_code: '5610', state_code: '18', postcode: '521',
    }))
    expect(Object.keys(errs).sort()).toEqual(['msic_code', 'postcode', 'state_code', 'supplier_brn', 'supplier_tin'])
  })
})

const doc = (over: Partial<EinvoiceDoc>): EinvoiceDoc => ({
  id: 'd1', kind: 'consolidated_invoice', environment: 'sandbox', branch_id: 'b1', code_number: 'CON-1',
  bill_id: null, period_start: '2026-09-01', period_end: '2026-09-30', buyer: null, total_sen: 100,
  status: 'valid', errors: null, created_at: '2026-10-01T00:00:00Z', lhdn_uuid: null, long_id: null,
  ...over,
})

describe('openProblems', () => {
  it('flags a rejected document that nothing replaced', () => {
    expect(openProblems([doc({ status: 'rejected' })]).map((d) => d.id)).toEqual(['d1'])
  })

  it('clears a rejected month once a later document for the same branch and month exists', () => {
    const docs = [
      doc({ id: 'old', status: 'rejected', created_at: '2026-10-01T00:00:00Z' }),
      doc({ id: 'new', status: 'submitted', created_at: '2026-10-02T00:00:00Z' }),
    ]
    expect(openProblems(docs)).toEqual([])
  })

  it('keeps branches and months apart', () => {
    const docs = [
      doc({ id: 'a', status: 'invalid' }),
      doc({ id: 'b', branch_id: 'b2', status: 'valid', created_at: '2026-10-05T00:00:00Z' }),
      doc({ id: 'c', period_start: '2026-08-01', status: 'valid', created_at: '2026-10-05T00:00:00Z' }),
    ]
    expect(openProblems(docs).map((d) => d.id)).toEqual(['a'])
  })

  it('groups single invoices by bill', () => {
    const docs = [
      doc({ id: 'x', kind: 'invoice', bill_id: 'bill1', period_start: null, status: 'rejected' }),
      doc({ id: 'y', kind: 'invoice', bill_id: 'bill2', period_start: null, status: 'valid', created_at: '2026-10-09T00:00:00Z' }),
    ]
    expect(openProblems(docs).map((d) => d.id)).toEqual(['x'])
  })

  it('flags a draft that never reached LHDN, but not a fresh draft without errors', () => {
    expect(openProblems([doc({ status: 'draft', errors: { message: 'network' } })])).toHaveLength(1)
    expect(openProblems([doc({ status: 'draft', errors: null })])).toEqual([])
  })
})

describe('retryFor', () => {
  it('resends a draft and asks LHDN about a submitted document', () => {
    expect(retryFor(doc({ status: 'draft' }))).toEqual({ label: 'Resend', body: { action: 'refresh', documentId: 'd1' } })
    expect(retryFor(doc({ status: 'submitted' }))).toEqual({ label: 'Check with LHDN', body: { action: 'refresh', documentId: 'd1' } })
  })

  it('re-consolidates a rejected month for the same branch', () => {
    expect(retryFor(doc({ status: 'rejected' }))).toEqual({
      label: 'Retry', body: { action: 'consolidate', branchId: 'b1', month: '2026-09' },
    })
  })

  it('re-submits a rejected single invoice with its buyer', () => {
    const buyer = { name: 'Acme', tin: 'C1' }
    expect(retryFor(doc({ kind: 'invoice', bill_id: 'bill1', period_start: null, status: 'invalid', buyer }))).toEqual({
      label: 'Retry', body: { action: 'submit_bill', billId: 'bill1', buyer },
    })
  })

  it('offers nothing for a valid or cancelled document, or a credit note', () => {
    expect(retryFor(doc({ status: 'valid' }))).toBeNull()
    expect(retryFor(doc({ status: 'cancelled' }))).toBeNull()
    expect(retryFor(doc({ kind: 'consolidated_credit_note', status: 'rejected' }))).toBeNull()
  })
})

describe('errorText', () => {
  it('pulls readable messages out of nested LHDN errors', () => {
    expect(errorText([{ error: { details: [{ message: 'TIN does not match BRN' }] } }])).toBe('TIN does not match BRN')
    expect(errorText({ message: 'network down' })).toBe('network down')
    expect(errorText(null)).toBe('')
  })
})
