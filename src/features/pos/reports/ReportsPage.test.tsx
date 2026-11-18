// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { Outlet } from '../outlets/outlet'
import { AUDIT, DRAWER, LEDGER, PAYMENTS, PRODUCTS, SALES, SST } from './testReports'

const h = vi.hoisted(() => ({
  caps: [] as string[],
  outlets: vi.fn(),
  sales: vi.fn(), products: vi.fn(), payments: vi.fn(), sst: vi.fn(), audit: vi.fn(), drawer: vi.fn(), ledger: vi.fn(),
}))
vi.mock('../../../shared/lib/permissions', () => ({ useCan: () => ({ can: (c: string) => h.caps.includes(c) }) }))
vi.mock('../outlets/outletsApi', () => ({ fetchMyOutlets: () => h.outlets() }))
vi.mock('./reportsApi', () => ({
  fetchSalesReport: (q: unknown) => h.sales(q),
  fetchProductsReport: (q: unknown) => h.products(q),
  fetchPaymentsReport: (q: unknown) => h.payments(q),
  fetchSstReport: (q: unknown) => h.sst(q),
  fetchAuditReport: (q: unknown) => h.audit(q),
  fetchDrawerReport: (q: unknown) => h.drawer(q),
  fetchLedgerReport: (q: unknown) => h.ledger(q),
}))

import ReportsPage from './ReportsPage'

const OUTLETS: Outlet[] = [
  { id: 'b1', name: 'Cheras', kind: 'branch', opensOn: null, closesOn: null, billPrefix: 'CH', isActive: true, isHome: true, openNow: true },
  { id: 'b2', name: 'Kepong', kind: 'branch', opensOn: null, closesOn: null, billPrefix: 'KP', isActive: true, isHome: false, openNow: true },
]

function Where() {
  return <output data-testid="where">{useLocation().search}</output>
}
const where = () => screen.getByTestId('where').textContent
const settle = async () => {
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
function renderAt(url: string) {
  render(<MemoryRouter initialEntries={[url]}><ReportsPage /><Where /></MemoryRouter>)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-06T03:00:00Z'))                   // Tue 6 Jan 2026, 11:00 in Malaysia
  h.caps = ['access_settings']
  h.outlets.mockReset().mockResolvedValue(OUTLETS)
  h.sales.mockReset().mockResolvedValue(SALES)
  h.products.mockReset().mockResolvedValue(PRODUCTS)
  h.payments.mockReset().mockResolvedValue(PAYMENTS)
  h.sst.mockReset().mockResolvedValue(SST)
  h.audit.mockReset().mockResolvedValue(AUDIT)
  h.drawer.mockReset().mockResolvedValue(DRAWER)
  h.ledger.mockReset().mockResolvedValue(LEDGER)
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('ReportsPage', () => {
  it('a manager starts on their home outlet, today, Overview', async () => {
    renderAt('/pos/reports')
    await settle()
    expect(h.sales).toHaveBeenCalledWith({ outlets: ['b1'], from: '2026-01-06', to: '2026-01-06' })
    expect((screen.getByRole('checkbox', { name: 'Cheras' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: 'Kepong' }) as HTMLInputElement).checked).toBe(false)
    expect(screen.getByRole('button', { name: 'Today' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('Tue 6 Jan 2026. A business day runs from 06:00 to 05:59 the next morning, Malaysia time.')).toBeTruthy()
  })

  it('HQ starts on every outlet', async () => {
    h.caps = ['access_settings', 'all_branches']
    renderAt('/pos/reports')
    await settle()
    expect(h.sales).toHaveBeenCalledWith({ outlets: ['b1', 'b2'], from: '2026-01-06', to: '2026-01-06' })
  })

  it('the filter is read from the URL and every change is written back', async () => {
    renderAt('/pos/reports?outlets=b2&from=2026-01-05&to=2026-01-06&tab=overview')
    await settle()
    expect(h.sales).toHaveBeenLastCalledWith({ outlets: ['b2'], from: '2026-01-05', to: '2026-01-06' })
    expect(screen.getByRole('button', { name: 'Custom' }).getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('2026-01-05')
    fireEvent.click(screen.getByRole('button', { name: 'Yesterday' }))
    await settle()
    expect(where()).toBe('?outlets=b2&from=2026-01-05&to=2026-01-05&tab=overview')
    expect(h.sales).toHaveBeenLastCalledWith({ outlets: ['b2'], from: '2026-01-05', to: '2026-01-05' })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Cheras' }))
    await settle()
    expect(where()).toBe('?outlets=b1%2Cb2&from=2026-01-05&to=2026-01-05&tab=overview')
    fireEvent.click(screen.getByRole('tab', { name: 'Sales summary' }))
    await settle()
    expect(where()).toBe('?outlets=b1%2Cb2&from=2026-01-05&to=2026-01-05&tab=summary')
    expect(screen.getByRole('tab', { name: 'Sales summary' }).getAttribute('aria-selected')).toBe('true')
  })

  it('a custom range of more than 366 days is refused before asking the server', async () => {
    renderAt('/pos/reports')
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }))
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2025-01-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(screen.getByRole('alert').textContent).toBe('Choose at most 366 days.')
    expect(where()).toBe('')
    expect(h.sales).toHaveBeenCalledTimes(1)
  })

  it('the last outlet cannot be unticked', async () => {
    renderAt('/pos/reports')
    await settle()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Cheras' }))
    expect(screen.getByRole('alert').textContent).toBe('Choose at least one outlet.')
    expect(where()).toBe('')
  })

  it('the outlets fail to load: the reason and Retry', async () => {
    h.outlets.mockRejectedValueOnce(new TypeError('Load failed'))
    renderAt('/pos/reports')
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('Could not load your outlets: No reply from the server.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await settle()
    expect(screen.getByRole('checkbox', { name: 'Cheras' })).toBeTruthy()
  })

  it('no outlets: says so', async () => {
    h.outlets.mockResolvedValue([])
    renderAt('/pos/reports')
    await settle()
    expect(screen.getByText('You have no outlets to report on.')).toBeTruthy()
  })
})
