// @vitest-environment jsdom
// The print host reports its problem count up (the bottom bar's badge) and, inside the staff panel,
// lays its list out in the panel instead of a dropdown that the panel would clip.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const api = vi.hoisted(() => ({
  fetchRoutes: vi.fn(), fetchMenuRoutes: vi.fn(), fetchPrintJobs: vi.fn(),
  claimJob: vi.fn(), finishJob: vi.fn(), insertTestPrint: vi.fn(), requeueJob: vi.fn(),
  handlers: null as null | { onSweep?: () => void; onPrintJob?: (row: unknown) => void },
  printFromBrowser: vi.fn(),
}))
vi.mock('../print/adapter', () => ({ printFromBrowser: api.printFromBrowser }))
vi.mock('./posApi', () => ({
  fetchRoutes: api.fetchRoutes, fetchMenuRoutes: api.fetchMenuRoutes, fetchPrintJobs: api.fetchPrintJobs,
  claimJob: api.claimJob, finishJob: api.finishJob, insertTestPrint: api.insertTestPrint, requeueJob: api.requeueJob,
}))
vi.mock('./usePosRealtime', () => ({
  usePosRealtime: (_b: string, h: { onSweep?: () => void; onPrintJob?: (row: unknown) => void }) => { api.handlers = h; return 'live' },
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
  api.claimJob.mockReset()
  api.claimJob.mockResolvedValue(true)
  api.finishJob.mockResolvedValue(undefined)
  api.printFromBrowser.mockReset()
  api.printFromBrowser.mockResolvedValue(undefined)
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

  describe('print queue (browser routes)', () => {
    const browserRoutes = [
      { route: 'kitchen', kind: 'epson', address: 'k' }, { route: 'bar', kind: 'epson', address: 'b' },
    ]
    const ticket = (id: string, route: string, extra: Record<string, unknown> = {}) => ({
      id, branch_id: 'br', route, status: 'pending', attempts: 0, last_error: null, claimed_at: null,
      created_at: new Date().toISOString(), payload: { kind: 'order', orderNo: id, tableLabel: 'T1', lines: [] }, ...extra,
    })
    const hear = async (row: unknown) => { await act(async () => { api.handlers?.onPrintJob?.(row) }); await flush() }
    const deferred = () => { let done!: () => void; const p = new Promise<void>((r) => { done = r }); return { p, done } }

    beforeEach(() => { api.fetchRoutes.mockResolvedValue(browserRoutes) })

    it('two jobs on the same route print one at a time, in arrival order', async () => {
      const first = deferred()
      api.printFromBrowser.mockImplementationOnce(() => first.p)
      render(<PrintHostPanel branchId="br" />)
      await flush()
      await hear(ticket('a', 'kitchen'))
      await hear(ticket('b', 'kitchen'))
      expect(api.printFromBrowser).toHaveBeenCalledTimes(1)
      await act(async () => { first.done() })
      await flush()
      expect(api.printFromBrowser).toHaveBeenCalledTimes(2)
    })

    it('a pending job on one route does not hold another route', async () => {
      api.printFromBrowser.mockImplementationOnce(() => new Promise<void>(() => undefined))
      render(<PrintHostPanel branchId="br" />)
      await flush()
      await hear(ticket('a', 'kitchen'))
      await hear(ticket('b', 'bar'))
      expect(api.printFromBrowser).toHaveBeenCalledTimes(2)
    })

    it('a drawer kick older than 2 minutes is not printed', async () => {
      render(<PrintHostPanel branchId="br" />)
      await flush()
      const old = new Date(Date.now() - 3 * 60_000).toISOString()
      await hear(ticket('d', 'bar', { created_at: old, payload: { kind: 'drawer', reason: 'Sale' } }))
      expect(api.claimJob).not.toHaveBeenCalled()
      expect(api.printFromBrowser).not.toHaveBeenCalled()
      await hear(ticket('d2', 'bar', { payload: { kind: 'drawer', reason: 'Sale' } }))
      expect(api.printFromBrowser).toHaveBeenCalledTimes(1)
    })

    it('a failed drawer job offers no Reprint', async () => {
      api.fetchPrintJobs.mockResolvedValue([{ ...failed, id: 'dj', route: 'bar', payload: { kind: 'drawer', reason: 'Sale' } }])
      render(<PrintHostPanel branchId="br" inline />)
      await flush()
      await sweep()
      expect(screen.getByText('Printer offline · 2 attempts')).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Reprint' })).toBeNull()
    })
  })
})
