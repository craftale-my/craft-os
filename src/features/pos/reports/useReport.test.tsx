// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useReport, type ReportLoad } from './useReport'
import type { ReportQuery } from './reportsApi'

const q = (from: string): ReportQuery => ({ outlets: ['b1'], from, to: from })
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

afterEach(cleanup)

describe('useReport', () => {
  it('a reply for an earlier filter that arrives after a newer one is dropped', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { result, rerender } = renderHook(({ query }) => useReport<string>(fetcher, query), { initialProps: { query: q('2026-01-05') } })
    rerender({ query: q('2026-01-06') })
    second.resolve('new')
    await settle()
    expect(result.current.load).toEqual({ status: 'ready', data: 'new' })
    first.resolve('old')
    await settle()
    expect(result.current.load).toEqual({ status: 'ready', data: 'new' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('a changed filter never renders the old data, not even for one frame', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const frames: { from: string; load: ReportLoad<string> }[] = []
    const { rerender } = renderHook(({ query }) => {
      const r = useReport<string>(fetcher, query)
      frames.push({ from: query.from, load: r.load })
      return r
    }, { initialProps: { query: q('2026-01-05') } })
    first.resolve('one')
    await settle()
    rerender({ query: q('2026-01-06') })
    second.resolve('two')
    await settle()
    const forSecond = frames.filter((f) => f.from === '2026-01-06').map((f) => f.load)
    expect(forSecond[0]).toEqual({ status: 'loading' })
    expect(forSecond.some((l) => l.status === 'ready' && l.data === 'one')).toBe(false)
    expect(forSecond[forSecond.length - 1]).toEqual({ status: 'ready', data: 'two' })
  })

  it('a failure shows the reason; retry reads again', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('You cannot see reports for this outlet.')).mockResolvedValueOnce('ok')
    const { result } = renderHook(() => useReport<string>(fetcher, q('2026-01-05')))
    await settle()
    expect(result.current.load).toEqual({ status: 'error', message: 'You cannot see reports for this outlet.' })
    act(() => result.current.retry())
    await settle()
    expect(result.current.load).toEqual({ status: 'ready', data: 'ok' })
  })
})
