// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import type { AccountDoc } from './claimDesk'

const doc = (over: Partial<AccountDoc>): AccountDoc => ({
  id: 'd1', source: 'einvoice', doc_type: 'Validated e-Invoice', platform: null, supplier: 'Lalamove', supplier_ref: 'INV-1',
  doc_date: '2026-10-05', currency: 'MYR', amount: 30, rate: null, amount_myr: 30, sst: null, description: null,
  gl_account: null, tax_treatment: null, payment: 'Paid by company', claimant: null, self_billed: 'Not required',
  self_billed_uuid: null, voucher_no: null, status: 'Draft', notes: null, items: [], files: [], einvoice_uuid: 'UUID1',
  einvoice: { uuid: 'UUID1', longId: null }, claim_id: null, created_at: '', updated_at: '', ...over,
})

let rows: AccountDoc[] = []
const updates: { table: string; patch: Record<string, unknown>; id?: unknown }[] = []
const upserts: unknown[] = []
let vouchers: string[] = []

function query(table: string) {
  const q: Record<string, unknown> = {}
  const chain = () => q
  Object.assign(q, {
    select: chain, gte: chain, lte: chain, order: chain, eq: chain,
    like: () => Promise.resolve({ data: vouchers.map(v => ({ voucher_no: v })), error: null }),
    update: (patch: Record<string, unknown>) => ({
      eq: (_c: string, id: unknown) => { updates.push({ table, patch, id }); return Promise.resolve({ error: null }) },
    }),
    upsert: (row: unknown) => { upserts.push(row); return Promise.resolve({ error: null }) },
    then: (res: (v: unknown) => void) => res({ data: rows, error: null }),
  })
  return q
}
vi.mock('../../shared/lib/supabase', () => ({ supabase: { from: (t: string) => query(t) } }))

const aiRead = vi.fn()
vi.mock('./api', () => ({
  aiRead: (...a: unknown[]) => aiRead(...a),
  loadAccounts: async () => [{ name: 'Transport & Delivery (Carriage Outwards)', code: '620-100' }, { name: 'Bank Charges', code: '' }],
  inbox: async () => ({ ok: true, data: { configured: false } }),
  fileUrl: async () => null,
  uploadFile: vi.fn(),
}))
const downloadBlob = vi.fn()
vi.mock('./imaging', () => ({ downloadBlob: (...a: unknown[]) => downloadBlob(...a) }))

const { default: ClaimDeskPage } = await import('./ClaimDeskPage')

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-10-20T04:00:00Z'))
})
afterEach(() => {
  cleanup(); vi.useRealTimers(); rows = []; updates.length = 0; upserts.length = 0; vouchers = []
  aiRead.mockReset(); downloadBlob.mockReset()
})

describe('ClaimDeskPage', () => {
  it('lists the month with status totals and exports the AutoCount CSV with account codes', async () => {
    rows = [
      doc({ id: 'a', gl_account: 'Transport & Delivery (Carriage Outwards)', voucher_no: 'PV-2610-001', status: 'Reviewed' }),
      doc({ id: 'b', supplier: 'Maybank', amount_myr: 12.5, amount: 12.5, status: 'Draft' }),
      doc({ id: 'c', supplier: 'Shopee seller', status: 'Cancelled' }),
    ]
    render(<ClaimDeskPage />)
    expect(await screen.findByText('Maybank')).toBeTruthy()
    const reviewed = screen.getAllByRole('button', { pressed: false }).find(b => b.textContent?.startsWith('Reviewed'))!
    expect(within(reviewed).getByText('RM 30.00')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Export AutoCount CSV/ }))
    expect(downloadBlob).toHaveBeenCalledTimes(1)
    const [name, blob] = downloadBlob.mock.calls[0] as [string, Blob]
    expect(name).toBe('AutoCount_2026-10.csv')
    const text = await blob.text()
    expect(text.split('\r\n')).toHaveLength(3) // header + 2 (cancelled left out)
    expect(text).toContain('PV-2610-001,Validated e-Invoice,2026-10-05,Lalamove,INV-1,,620-100,')
    expect(await screen.findByText(/1 document is still missing an account or amount/)).toBeTruthy()
  })

  it('suggests the next voucher number and remembers the supplier → account on save', async () => {
    rows = [doc({ id: 'a', source: 'paper', einvoice_uuid: null, einvoice: null })]
    vouchers = ['PV-2610-004', 'EC-2610-009']
    render(<ClaimDeskPage />)
    fireEvent.click(await screen.findByText('Lalamove'))
    const drawer = await screen.findByRole('complementary', { name: 'Document details' })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Suggest' }))
    await waitFor(() => expect(within(drawer).getByDisplayValue('PV-2610-005')).toBeTruthy())

    const account = within(drawer).getAllByRole('combobox').find(s => within(s).queryByText('Bank Charges'))!
    fireEvent.change(account, { target: { value: 'Transport & Delivery (Carriage Outwards)' } })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updates.some(u => u.table === 'account_docs')).toBe(true))
    const u = updates.find(x => x.table === 'account_docs')!
    expect(u.patch).toMatchObject({ voucher_no: 'PV-2610-005', gl_account: 'Transport & Delivery (Carriage Outwards)', status: 'Draft' })
    await waitFor(() => expect(upserts).toHaveLength(1))
    expect(upserts[0]).toMatchObject({ key: 'lalamove', supplier: 'Lalamove', gl_account: 'Transport & Delivery (Carriage Outwards)' })
  })

  it('asks the AI only for unclassified suppliers and applies answers from the account list', async () => {
    rows = [doc({ id: 'a', supplier: 'Maybank' }), doc({ id: 'b', supplier: 'Lalamove', gl_account: 'Bank Charges' })]
    aiRead.mockResolvedValue({ ok: true, data: [{ supplier: 'Maybank', account: 'Bank Charges', platform: 'Other' }] })
    render(<ClaimDeskPage />)
    await screen.findByText('Maybank')
    fireEvent.click(screen.getByRole('button', { name: /AI: suggest missing accounts/ }))
    await waitFor(() => expect(updates).toHaveLength(1))
    expect(aiRead).toHaveBeenCalledWith('suggest', { suppliers: ['Maybank'] }, expect.arrayContaining(['Bank Charges']))
    expect(updates[0]).toMatchObject({ id: 'a', patch: { gl_account: 'Bank Charges', platform: 'Other' } })
  })
})
