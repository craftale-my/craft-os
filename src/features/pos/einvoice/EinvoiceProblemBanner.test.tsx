// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { EinvoiceDoc } from './einvoice'

const api = vi.hoisted(() => ({
  fetchDocuments: vi.fn(),
  fetchStoppedAttempts: vi.fn(),
  fetchLargeBills: vi.fn(),
  fetchJobRuns: vi.fn(),
  fetchUnreportedMonths: vi.fn(),
  fetchOutlets: vi.fn(),
}))
vi.mock('./einvoiceApi', () => api)
const caps = vi.hoisted(() => ({ allowed: true }))
vi.mock('../../../shared/lib/permissions', () => ({ useCan: () => ({ can: () => caps.allowed }) }))

import { EinvoiceProblemBanner } from './EinvoiceProblemBanner'

const rejected: EinvoiceDoc = {
  id: 'd1', kind: 'consolidated_invoice', environment: 'sandbox', branch_id: 'b1', code_number: 'CON-1',
  bill_id: null, period_start: '2026-10-01', period_end: '2026-10-31', buyer: null, total_sen: 100,
  status: 'rejected', errors: null, created_at: '2026-11-01T00:00:00Z', lhdn_uuid: null, long_id: null,
}

const show = (path = '/') => render(<MemoryRouter initialEntries={[path]}><EinvoiceProblemBanner /></MemoryRouter>)

beforeEach(() => {
  caps.allowed = true
  api.fetchDocuments.mockResolvedValue([])
  api.fetchStoppedAttempts.mockResolvedValue([])
  api.fetchLargeBills.mockResolvedValue([])
  api.fetchJobRuns.mockResolvedValue([])
  api.fetchUnreportedMonths.mockResolvedValue([])
  api.fetchOutlets.mockResolvedValue([])
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('EinvoiceProblemBanner', () => {
  it('says nothing when all is well', async () => {
    show()
    await waitFor(() => expect(api.fetchJobRuns).toHaveBeenCalled())
    expect(screen.queryByText('Open E-invoice')).toBeNull()
  })

  it('lists every case that needs the owner, with the way to the screen', async () => {
    api.fetchDocuments.mockResolvedValue([rejected])
    api.fetchLargeBills.mockResolvedValue([{ id: 'x', branch_id: 'b1', bill_no: '261010-001', day: '2026-10-10', total_sen: 1100000 }])
    show()
    expect(await screen.findByText(/LHDN did not accept an e-invoice\./)).toBeTruthy()
    expect(screen.getByText(/A bill over RM 10,000 needs the buyer's details/)).toBeTruthy()
    expect(screen.getByText('Open E-invoice').getAttribute('href')).toBe('/pos/einvoice')
  })

  it('adds the needs-checking case for a draft whose send has an unknown answer', async () => {
    api.fetchDocuments.mockResolvedValue([{ ...rejected, status: 'draft', needs_check: true, errors: 'unknown' }])
    show()
    expect(await screen.findByText(/An e-invoice needs checking in the MyInvois portal\./)).toBeTruthy()
    expect(screen.queryByText(/did not accept/)).toBeNull()
  })

  it('says when a closed month has not been reported, and when the daily run has not run for 2 days', async () => {
    api.fetchOutlets.mockResolvedValue([{ id: 'b1', name: 'Kepong', einvoice_from: '2026-10-01' }])
    api.fetchUnreportedMonths.mockResolvedValue([{ branch_id: 'b1', month: '2026-10-01', bills: 3, total_sen: 3000 }])
    api.fetchJobRuns.mockResolvedValue([{ id: 'j', started_at: '2026-11-01T23:00:00Z', environment: 'sandbox', outcome: 'ok', report: {} }])
    show()
    expect(await screen.findByText(/Some months' sales have not been reported to LHDN yet\./)).toBeTruthy()
    expect(screen.getByText(/The daily e-invoice run has not run for 2 days\./)).toBeTruthy()
  })

  it('stays quiet when a read fails (tables not on this database yet)', async () => {
    api.fetchDocuments.mockResolvedValue([rejected])
    api.fetchStoppedAttempts.mockRejectedValue(new Error('relation does not exist'))
    show()
    expect(await screen.findByText(/LHDN did not accept an e-invoice\./)).toBeTruthy()
  })

  it('is not shown without Access Settings, nor on the E-invoice screen itself', async () => {
    api.fetchDocuments.mockResolvedValue([rejected])
    caps.allowed = false
    show()
    expect(api.fetchDocuments).not.toHaveBeenCalled()
    cleanup()
    caps.allowed = true
    show('/pos/einvoice')
    await waitFor(() => expect(api.fetchDocuments).toHaveBeenCalled())
    expect(screen.queryByText('Open E-invoice')).toBeNull()
  })
})
