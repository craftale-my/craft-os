// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

const fetchShiftStatus = vi.fn()
vi.mock('./shiftApi', () => ({ fetchShiftStatus: () => fetchShiftStatus() }))

import { useShiftOpen } from './useShiftOpen'

const status = (open: boolean) => ({
  shift: open ? { id: 's1', openedAt: '2026-10-26T01:00:00Z', openedByName: 'Aina', openingFloatSen: 20000 } : null,
  openBillCount: 0, lastFloatSen: null, now: '2026-10-26T02:00:00Z',
})
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

beforeEach(() => { fetchShiftStatus.mockReset() })

describe('useShiftOpen', () => {
  it('is null until the first read, then whether a shift is open', async () => {
    fetchShiftStatus.mockResolvedValueOnce(status(false))
    const { result } = renderHook(({ k }) => useShiftOpen(k), { initialProps: { k: 0 } })
    expect(result.current.open).toBeNull()
    await flush()
    expect(result.current.open).toBe(false)
  })

  it('reads again on a refresh and on reload(); a failed read keeps the last answer', async () => {
    fetchShiftStatus.mockResolvedValueOnce(status(false))
    const { result, rerender } = renderHook(({ k }) => useShiftOpen(k), { initialProps: { k: 0 } })
    await flush()
    fetchShiftStatus.mockResolvedValueOnce(status(true))
    rerender({ k: 1 })
    await flush()
    expect(result.current.open).toBe(true)
    fetchShiftStatus.mockRejectedValueOnce(new Error('Load failed'))
    act(() => result.current.reload())
    await flush()
    expect(result.current.open).toBe(true)
    expect(fetchShiftStatus).toHaveBeenCalledTimes(3)
  })
})
