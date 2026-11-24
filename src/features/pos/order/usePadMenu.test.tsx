// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'

const fetchPosMenu = vi.fn()
vi.mock('./posApi', () => ({ fetchPosMenu: (id: string) => fetchPosMenu(id) }))

import { usePadMenu } from './usePadMenu'

const menuOf = (id: string) => ({ catalogId: id, categories: [] }) as never
const flush = () => act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve() })

beforeEach(() => { fetchPosMenu.mockReset() })
afterEach(cleanup)

describe('usePadMenu (readiness W8: a pad opened offline)', () => {
  it('loads the catalog\'s menu', async () => {
    fetchPosMenu.mockResolvedValueOnce(menuOf('a'))
    const { result } = renderHook(() => usePadMenu('a'))
    await flush()
    expect(result.current.menu).toEqual(menuOf('a'))
    expect(result.current.error).toBeNull()
  })

  it('a failed read keeps its own error until Retry loads the menu', async () => {
    fetchPosMenu.mockRejectedValueOnce(new Error('Load failed'))
    const { result } = renderHook(() => usePadMenu('a'))
    await flush()
    expect(result.current.menu).toBeNull()
    expect(result.current.error).toBe('No reply from the server. Check the internet connection and try again.')
    fetchPosMenu.mockResolvedValueOnce(menuOf('a'))
    await act(async () => { await result.current.reload() })
    expect(result.current.menu).toEqual(menuOf('a'))
    expect(result.current.error).toBeNull()
  })

  it('reads the menu again when the iPad comes back online', async () => {
    fetchPosMenu.mockRejectedValueOnce(new Error('Load failed'))
    const { result } = renderHook(() => usePadMenu('a'))
    await flush()
    fetchPosMenu.mockResolvedValueOnce(menuOf('a'))
    await act(async () => { window.dispatchEvent(new Event('online')) })
    await flush()
    expect(fetchPosMenu).toHaveBeenCalledTimes(2)
    expect(result.current.menu).toEqual(menuOf('a'))
    expect(result.current.error).toBeNull()
  })

  it('never shows another catalog\'s menu, and a slow reply for the old catalog is dropped', async () => {
    let answerA: (m: unknown) => void = () => {}
    fetchPosMenu.mockImplementationOnce(() => new Promise((r) => { answerA = r }))
    const { result, rerender } = renderHook(({ id }) => usePadMenu(id), { initialProps: { id: 'a' as string | null } })
    fetchPosMenu.mockResolvedValueOnce(menuOf('b'))
    rerender({ id: 'b' })
    await flush()
    await act(async () => { answerA(menuOf('a')) })
    expect(result.current.menu).toEqual(menuOf('b'))
    rerender({ id: null })
    expect(result.current.menu).toBeNull()
  })

  it('stops listening when the pad closes', async () => {
    fetchPosMenu.mockResolvedValue(menuOf('a'))
    const { unmount } = renderHook(() => usePadMenu('a'))
    await flush()
    unmount()
    window.dispatchEvent(new Event('online'))
    expect(fetchPosMenu).toHaveBeenCalledTimes(1)
  })
})
