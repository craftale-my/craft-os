// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

const fetchMenuWindows = vi.fn()
vi.mock('./posApi', () => ({ fetchMenuWindows: (id: string) => fetchMenuWindows(id) }))

import { usePadWindows } from './usePadWindows'
import { menuWindows } from './padSlots'

const json = (start: string) => ({
  now: '2026-10-26T01:00:00.000Z',
  windows: [{ productId: 'soup', days: [1, 2, 3, 4, 5, 6, 7], start, end: '23:00' }],
})
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-26T01:00:10.000Z'))
  fetchMenuWindows.mockReset()
})
afterEach(() => { vi.useRealTimers() })

describe('usePadWindows', () => {
  it('reads the windows again every minute, so a schedule edit reaches an open pad', async () => {
    fetchMenuWindows.mockResolvedValueOnce(menuWindows(json('11:00'), Date.now()))
    const { result } = renderHook(() => usePadWindows('cat-a'))
    await flush()
    expect(result.current.windows.byProduct.get('soup')?.[0].start).toBe('11:00')
    fetchMenuWindows.mockResolvedValueOnce(menuWindows(json('09:00'), Date.now()))
    await act(async () => { vi.advanceTimersByTime(60_000) })
    await flush()
    expect(fetchMenuWindows).toHaveBeenCalledTimes(2)
    expect(result.current.windows.byProduct.get('soup')?.[0].start).toBe('09:00')
  })

  it('keeps the last windows when a read fails', async () => {
    fetchMenuWindows.mockResolvedValueOnce(menuWindows(json('11:00'), Date.now()))
    const { result } = renderHook(() => usePadWindows('cat-a'))
    await flush()
    fetchMenuWindows.mockRejectedValueOnce(new Error('Failed to fetch'))
    await act(async () => { vi.advanceTimersByTime(60_000) })
    await flush()
    expect(result.current.windows.byProduct.get('soup')?.[0].start).toBe('11:00')
  })

  it('never shows another catalog\'s windows, and none without a catalog', async () => {
    fetchMenuWindows.mockResolvedValueOnce(menuWindows(json('11:00'), Date.now()))
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => usePadWindows(id), { initialProps: { id: 'cat-a' as string | null } })
    await flush()
    fetchMenuWindows.mockReturnValueOnce(new Promise(() => {}))          // cat-b's reply never comes
    rerender({ id: 'cat-b' })
    expect(result.current.windows.byProduct.size).toBe(0)
    rerender({ id: null })
    expect(result.current.windows.byProduct.size).toBe(0)
  })
})
