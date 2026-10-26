// @vitest-environment jsdom
// The print host reports its problem count up (the bottom bar's badge) and, inside the staff panel,
// lays its list out in the panel instead of a dropdown that the panel would clip.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const api = vi.hoisted(() => ({
  fetchRoutes: vi.fn(), fetchMenuRoutes: vi.fn(), fetchPrintJobs: vi.fn(),
  claimJob: vi.fn(), finishJob: vi.fn(), insertTestPrint: vi.fn(), requeueJob: vi.fn(),
  handlers: null as null | { onSweep?: () => void },
}))
vi.mock('./posApi', () => ({
  fetchRoutes: api.fetchRoutes, fetchMenuRoutes: api.fetchMenuRoutes, fetchPrintJobs: api.fetchPrintJobs,
  claimJob: api.claimJob, finishJob: api.finishJob, insertTestPrint: api.insertTestPrint, requeueJob: api.requeueJob,
}))
vi.mock('./usePosRealtime', () => ({
  usePosRealtime: (_b: string, h: { onSweep?: () => void }) => { api.handlers = h; return 'live' },
}))

import PrintHostPanel from './PrintHostPanel'

const failed = {
  id: 'j1', branch_id: 'br', route: 'kitchen', status: 'failed', attempts: 2, last_error: 'Printer offline',
  claimed_at: null, created_at: '2026-10-26T02:00:00Z',
  payload: { kind: 'order', orderNo: 'A-001', tableLabel: 'T3', lines: [] },
}
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
const sweep = async () => { await act(async () => { api.handlers?.onSweep?.() }); await flush() }

beforeEach(() => {
  api.fetchRoutes.mockResolvedValue([{ route: 'kitchen', kind: 'agent', address: '' }])
  api.fetchMenuRoutes.mockResolvedValue(['kitchen'])
  api.fetchPrintJobs.mockResolvedValue([])
})
afterEach(cleanup)

describe('PrintHostPanel', () => {
  it('reports its problem count whenever it changes', async () => {
    const onProblems = vi.fn()
    render(<PrintHostPanel branchId="br" onProblems={onProblems} />)
    await flush()
    expect(onProblems).toHaveBeenLastCalledWith(0)
    api.fetchPrintJobs.mockResolvedValue([failed])
    await sweep()
    expect(onProblems).toHaveBeenLastCalledWith(1)
    api.fetchPrintJobs.mockResolvedValue([])
    await sweep()
    expect(onProblems).toHaveBeenLastCalledWith(0)
  })

  it('inline: the list is laid out in place, full width, with no dropdown', async () => {
    api.fetchPrintJobs.mockResolvedValue([failed])
    render(<PrintHostPanel branchId="br" inline />)
    await flush()
    await sweep()
    const list = screen.getByTestId('print-list')
    expect(list.className).not.toContain('absolute')
    expect(list.className).not.toContain('w-96')
    expect(list.className).toContain('w-full')
    expect(screen.getByText('Printer offline · 2 attempts')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reprint' })).toBeTruthy()
  })

  it('elsewhere it stays a dropdown behind the Printers button', async () => {
    api.fetchPrintJobs.mockResolvedValue([failed])
    render(<PrintHostPanel branchId="br" />)
    await flush()
    await sweep()
    expect(screen.queryByTestId('print-list')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Printers · 1 problem' }))
    expect(screen.getByTestId('print-list').className).toContain('absolute')
  })
})
