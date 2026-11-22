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
})
