import { describe, it, expect, vi } from 'vitest'
import { processJob, type PrintHostDeps, type PrintJob } from './printHost'

const job: PrintJob = {
  id: 'job-1',
  route: 'Bar',
  status: 'pending',
  payload: {
    kind: 'ticket',
    route: 'Bar',
    tableLabel: 'A1',
    orderNo: 'X',
    source: 'qr',
    placedAt: '2026-10-22T03:48:00.000Z',
    lines: [],
  },
}

function deps(overrides: Partial<PrintHostDeps> = {}): PrintHostDeps {
  return {
    claim: vi.fn(async () => true),
    finish: vi.fn(async () => undefined),
    print: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe('processJob', () => {
  it('prints a pending job it managed to claim, then marks it printed', async () => {
    const d = deps()
    expect(await processJob(job, d)).toBe('printed')
    expect(d.print).toHaveBeenCalledWith(job)
    expect(d.finish).toHaveBeenCalledWith('job-1', true, null)
  })

  it('skips a job someone else already claimed', async () => {
    const d = deps({ claim: vi.fn(async () => false) })
    expect(await processJob(job, d)).toBe('skipped')
    expect(d.print).not.toHaveBeenCalled()
    expect(d.finish).not.toHaveBeenCalled()
  })

  it('skips jobs that are not pending without claiming', async () => {
    const d = deps()
    expect(await processJob({ ...job, status: 'printed' }, d)).toBe('skipped')
    expect(d.claim).not.toHaveBeenCalled()
  })

  it('records the error when printing fails', async () => {
    const d = deps({ print: vi.fn(async () => Promise.reject(new Error('Cover open'))) })
    expect(await processJob(job, d)).toBe('failed')
    expect(d.finish).toHaveBeenCalledWith('job-1', false, 'Cover open')
  })

  it('never marks a printed ticket failed when recording success fails', async () => {
    const finish = vi.fn(async (_id: string, ok: boolean) => {
      if (ok) throw new Error('network down')
    })
    const d = deps({ finish })
    await expect(processJob(job, d)).rejects.toThrow('network down')
    expect(d.print).toHaveBeenCalledTimes(1)
    expect(finish).toHaveBeenCalledTimes(1)
    expect(finish).not.toHaveBeenCalledWith('job-1', false, expect.anything())
  })

  it('records a non-Error throw as text', async () => {
    const d = deps({ print: vi.fn(async () => Promise.reject('paper jam')) })
    expect(await processJob(job, d)).toBe('failed')
    expect(d.finish).toHaveBeenCalledWith('job-1', false, 'paper jam')
  })
})
