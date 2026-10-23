// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

const fetchMenuWindows = vi.fn()
vi.mock('./posApi', () => ({ fetchMenuWindows: (id: string) => fetchMenuWindows(id) }))

import { usePadWindows } from './usePadWindows'
import { menuWindows, tileSlotLabel } from './padSlots'

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
    // the server is 10 s behind: its next minute starts in 60 s, the tick 250 ms after that
    await act(async () => { vi.advanceTimersByTime(60_250) })
    await flush()
    expect(fetchMenuWindows).toHaveBeenCalledTimes(2)
    expect(result.current.windows.byProduct.get('soup')?.[0].start).toBe('09:00')
  })

  it('keeps the last windows when a read fails', async () => {
    fetchMenuWindows.mockResolvedValueOnce(menuWindows(json('11:00'), Date.now()))
    const { result } = renderHook(() => usePadWindows('cat-a'))
    await flush()
    fetchMenuWindows.mockRejectedValueOnce(new Error('Failed to fetch'))
    await act(async () => { vi.advanceTimersByTime(60_250) })
    await flush()
    expect(fetchMenuWindows).toHaveBeenCalledTimes(2)
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

  it('opens a slot on the server\'s minute when the server is 200 ms behind this iPad', async () => {
    vi.setSystemTime(new Date('2026-10-25T23:59:30.000Z'))                 // this iPad: Mon 07:59:30 in Malaysia
    const breakfast = [{ productId: 'pancake', days: [1, 2, 3, 4, 5, 6, 7], start: '08:00', end: '11:30' }]
    fetchMenuWindows.mockImplementation(() => Promise.resolve(
      menuWindows({ now: new Date(Date.now() - 200).toISOString(), windows: breakfast }, Date.now())))
    const { result } = renderHook(() => usePadWindows('cat-a'))
    await flush()
    expect(result.current.windows.offsetMs).toBe(-200)
    const label = () => tileSlotLabel(result.current.windows, 'pancake', result.current.now)
    expect(label()).toBe('Available 08:00–11:30')
    // the iPad's minute starts at 00:00:00.000Z, the server's 200 ms later; the tick comes 250 ms after that
    await act(async () => { vi.advanceTimersByTime(30_449) })
    await flush()
    expect(label()).toBe('Available 08:00–11:30')
    await act(async () => { vi.advanceTimersByTime(1) })
    await flush()
    expect(result.current.now.toISOString()).toBe('2026-10-26T00:00:00.250Z')
    expect(label()).toBeNull()
    expect(fetchMenuWindows).toHaveBeenCalledTimes(2)                     // the windows are read again on that tick
  })

  it('reads the windows again before refusing a line, and keeps the last answer when that read fails', async () => {
    vi.setSystemTime(new Date('2026-10-26T01:00:10.000Z'))                 // Mon 09:00:10 in Malaysia
    fetchMenuWindows.mockResolvedValueOnce(menuWindows(json('11:00'), Date.now()))
    const { result } = renderHook(() => usePadWindows('cat-a'))
    await flush()
    const names = (id: string) => (id === 'soup' ? 'Soup' : 'Latte')
    // nothing out of its slot: no read
    expect(await result.current.check([{ productId: 'latte' }], names)).toBeNull()
    expect(fetchMenuWindows).toHaveBeenCalledTimes(1)
    let answer: string | null = 'unset'
    // still closed after a fresh read: refused in the server's words
    fetchMenuWindows.mockResolvedValueOnce(menuWindows(json('10:00'), Date.now()))
    await act(async () => { answer = await result.current.check([{ productId: 'soup' }], names) })
    expect(answer).toBe('Soup is not available at this time')
    expect(fetchMenuWindows).toHaveBeenCalledTimes(2)
    // the read fails: the last windows decide
    fetchMenuWindows.mockRejectedValueOnce(new Error('Failed to fetch'))
    await act(async () => { answer = await result.current.check([{ productId: 'soup' }], names) })
    expect(answer).toBe('Soup is not available at this time')
    // the soup's slot was moved to 09:00 a moment ago: the fresh windows let it through, and are kept
    fetchMenuWindows.mockResolvedValueOnce(menuWindows(json('09:00'), Date.now()))
    await act(async () => { answer = await result.current.check([{ productId: 'soup' }], names) })
    expect(answer).toBeNull()
    expect(result.current.windows.byProduct.get('soup')?.[0].start).toBe('09:00')
  })
})
