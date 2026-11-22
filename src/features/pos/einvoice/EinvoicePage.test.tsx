// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { EinvoiceDoc } from './einvoice'

const api = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  saveSettings: vi.fn(),
  fetchReceiptDetails: vi.fn(),
  fetchDocuments: vi.fn(),
  fetchBranchNames: vi.fn(),
  callEinvoice: vi.fn(),
  validationLink: () => null,
  fetchOutlets: vi.fn(),
  setOutletStart: vi.fn(),
  fetchJobRuns: vi.fn(),
  fetchStoppedAttempts: vi.fn(),
  fetchLargeBills: vi.fn(),
}))
vi.mock('./einvoiceApi', () => api)
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ staff: { branch_id: 'b1' } }) }))

import EinvoicePage from './EinvoicePage'

const rejected: EinvoiceDoc = {
  id: 'd1', kind: 'consolidated_invoice', environment: 'sandbox', branch_id: 'b1', code_number: 'CON-261001-ABC123',
  bill_id: null, period_start: '2026-09-01', period_end: '2026-09-30', buyer: null, total_sen: 123456,
  status: 'rejected', errors: [{ error: { details: [{ message: 'Supplier TIN is not valid' }] } }],
  created_at: '2026-10-01T01:00:00Z', lhdn_uuid: null, long_id: null,
}

const okStatus = {
  environment: 'sandbox', credentials: { clientId: false, clientSecret: false },
  settingsMissing: ['supplier_tin'], signing: 'not needed in sandbox (v1.0)', token: 'not tried',
}

beforeEach(() => {
  api.fetchSettings.mockResolvedValue({ environment: 'sandbox', supplier_name: null, supplier_sst_no: 'NA', supplier_ttx_no: 'NA' })
  api.fetchReceiptDetails.mockResolvedValue({
    legal_name: 'Craftale Sdn Bhd', registration_no: '201901012345', sst_no: null, address: '1 Jalan Kepong', phone: '+60123456789', email: null,
  })
  api.fetchDocuments.mockResolvedValue([rejected])
  api.fetchBranchNames.mockResolvedValue({ b1: 'Kepong' })
  api.callEinvoice.mockImplementation(async (body: { action: string }) =>
    body.action === 'status' ? { ok: true, data: okStatus } : { ok: true, data: { status: 'submitted' } })
  api.saveSettings.mockResolvedValue(undefined)
  api.fetchOutlets.mockResolvedValue([{ id: 'b1', name: 'Kepong', einvoice_from: '2026-09-01' }, { id: 'b2', name: 'Cheras', einvoice_from: null }])
  api.setOutletStart.mockResolvedValue(undefined)
  api.fetchJobRuns.mockResolvedValue([])
  api.fetchStoppedAttempts.mockResolvedValue([])
  api.fetchLargeBills.mockResolvedValue([])
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('EinvoicePage', () => {
  it('starts an empty company form from the branch receipt details', async () => {
    render(<EinvoicePage />)
    expect(await screen.findByDisplayValue('Craftale Sdn Bhd')).toBeTruthy()
    expect(screen.getByDisplayValue('201901012345')).toBeTruthy()
    expect(screen.getByText(/Filled from your branch's receipt details/)).toBeTruthy()
  })

  it('shows the one-time setup steps while the API keys are missing', async () => {
    render(<EinvoicePage />)
    expect(await screen.findByText('One-time setup by the company director')).toBeTruthy()
    expect(screen.getByText(/MYINVOIS_CLIENT_SECRET/)).toBeTruthy()
  })

  it('lists a rejected month with LHDN\'s reason and re-consolidates it on Retry', async () => {
    render(<EinvoicePage />)
    expect(await screen.findByText('Needs attention (1)')).toBeTruthy()
    expect(screen.getByText('Supplier TIN is not valid')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0])
    await waitFor(() => expect(api.callEinvoice).toHaveBeenCalledWith({ action: 'consolidate', branchId: 'b1', month: '2026-09' }))
    expect(await screen.findByText(/sent again — now submitted/)).toBeTruthy()
  })

  it('does not save until the required fields are valid', async () => {
    render(<EinvoicePage />)
    await screen.findByDisplayValue('Craftale Sdn Bhd')
    fireEvent.click(screen.getByRole('button', { name: 'Save company details' }))
    expect(await screen.findByText('Fix the fields marked in red')).toBeTruthy()
    expect(api.saveSettings).not.toHaveBeenCalled()
  })

  it('saves an outlet’s start date, and refuses moving it earlier once e-invoices were sent', async () => {
    render(<EinvoicePage />)
    const cheras = await screen.findByLabelText('Report e-invoices from, Cheras')
    expect(screen.getByText('Not reported by us')).toBeTruthy()
    fireEvent.change(cheras, { target: { value: '2026-12-01' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[1])
    await waitFor(() => expect(api.setOutletStart).toHaveBeenCalledWith('b2', '2026-12-01'))

    // Kepong has a live document (the rejected one is not live, so give it a valid one)
    api.fetchDocuments.mockResolvedValue([rejected, { ...rejected, id: 'd2', status: 'valid', created_at: '2026-10-02T00:00:00Z' }])
    cleanup()
    render(<EinvoicePage />)
    const kepong = await screen.findByLabelText('Report e-invoices from, Kepong')
    await screen.findAllByText('Monthly consolidated')   // the documents have loaded (two rows)
    fireEvent.change(kepong, { target: { value: '2026-08-01' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0])
    expect(await screen.findByText('E-invoices were already sent for this outlet: the start date can only move later.')).toBeTruthy()
    expect(api.setOutletStart).toHaveBeenCalledTimes(1)
  })

  it('lists a run stopped after 3 failures under Needs attention and retries it', async () => {
    api.fetchDocuments.mockResolvedValue([])
    api.fetchStoppedAttempts.mockResolvedValue([{
      key: 'CON|b1|2026-10', kind: 'consolidated_invoice', branch_id: 'b1', period_start: '2026-10-01', refund_id: null,
      failures: 3, last_error: 'The document adds up to 1 sen, the bills are 2 sen', updated_at: '2026-11-03T23:00:00Z',
    }])
    render(<EinvoicePage />)
    expect(await screen.findByText('Needs attention (1)')).toBeTruthy()
    expect(screen.getByText(/Stopped after 3 failed attempts: The document adds up to 1 sen/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(api.callEinvoice).toHaveBeenCalledWith({ action: 'consolidate', branchId: 'b1', month: '2026-10' }))
  })

  it('issues an e-invoice for a bill over RM 10,000 once the buyer’s details are valid', async () => {
    api.fetchLargeBills.mockResolvedValue([{ id: 'big', branch_id: 'b1', bill_no: '261010-001', day: '2026-10-10', total_sen: 1100000 }])
    api.callEinvoice.mockImplementation(async (body: { action: string }) =>
      body.action === 'status' ? { ok: true, data: okStatus } : { ok: true, data: { code_number: 'INV-261110-ABCDEF', status: 'submitted' } })
    render(<EinvoicePage />)
    expect(await screen.findByText('Bills over RM 10,000 (1)')).toBeTruthy()
    expect(screen.getByText(/Bill 261010-001 · 2026-10-10 · RM 11000\.00/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Enter buyer details' }))
    fireEvent.click(screen.getByRole('button', { name: 'Issue e-invoice' }))
    expect(await screen.findAllByText('Required')).toHaveLength(3)
    fireEvent.change(screen.getByLabelText('Buyer name'), { target: { value: 'Acme Catering Sdn Bhd' } })
    fireEvent.change(screen.getByLabelText('Buyer TIN'), { target: { value: 'C9876543210' } })
    fireEvent.change(screen.getByLabelText('ID number'), { target: { value: '201901012345' } })
    fireEvent.click(screen.getByRole('button', { name: 'Issue e-invoice' }))
    await waitFor(() => expect(api.callEinvoice).toHaveBeenCalledWith({
      action: 'submit_bill', billId: 'big',
      buyer: expect.objectContaining({ name: 'Acme Catering Sdn Bhd', tin: 'C9876543210', idType: 'BRN', idValue: '201901012345' }),
    }))
    expect(await screen.findByText(/Bill 261010-001: e-invoice INV-261110-ABCDEF sent — now submitted\./)).toBeTruthy()
  })

  it('shows the daily runs', async () => {
    api.fetchJobRuns.mockResolvedValue([{
      id: 'j1', started_at: '2026-11-01T23:00:05Z', environment: 'sandbox', outcome: 'not_set_up',
      report: { setUp: false, notSetUp: 'MyInvois credentials are not set' },
    }])
    render(<EinvoicePage />)
    expect(await screen.findByText('Not set up — nothing sent (MyInvois credentials are not set)')).toBeTruthy()
  })

  it('shows a needs-check draft with its reason and sends it again', async () => {
    api.fetchDocuments.mockResolvedValue([{
      ...rejected, id: 'd9', status: 'draft', needs_check: true, errors: 'LHDN did not answer', code_number: 'CON-261101-XYZ789',
    }])
    render(<EinvoicePage />)
    expect(await screen.findByText('Check the MyInvois portal for this document. If it is not there, press Send again.')).toBeTruthy()
    expect(screen.getByText('LHDN did not answer')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Send again' }))
    await waitFor(() => expect(api.callEinvoice).toHaveBeenCalledWith({ action: 'resend', documentId: 'd9' }))
  })
})
