// src/qr/useTableCart.test.tsx
// @vitest-environment jsdom
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { CartApi, CartSignal } from './qrCartApi'
import type { CartLine, CartState } from './qrCart'
import { CART_SWEEP_MS, useTableCart } from './useTableCart'

afterEach(() => { cleanup(); vi.useRealTimers() })

const guest = { id: 'me', name: 'Eric', avatar: 'a1' }
const order = { productId: 'latte', variantId: 'hot', qty: 1, note: null, optionIds: [] }
const line = (id: string): CartLine => ({ id, guestId: 'me', guestLabel: 'Eric', guestAvatar: 'a1', ...order })
const cart = (version: string, ...ids: string[]): CartState => ({ version, lines: ids.map(line) })

function fakes(first: CartState) {
  const server = { cart: first }
  const api: CartApi = {
    state: vi.fn(async () => server.cart),
    put: vi.fn(async () => 'new'),
    remove: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    send: vi.fn(async () => 'sent' as const),
  }
  let onPing: (() => void) | null = null
  const signal: CartSignal & { fire: () => void; pings: number; live: number } = {
    pings: 0,
    live: 0,
    subscribe(h) { onPing = h; this.live++; return () => { onPing = null; this.live-- } },
    ping() { this.pings++ },
    fire: () => onPing?.(),
  }
  return { server, api, signal }
}

describe('useTableCart', () => {
  it('reads the cart on mount', async () => {
    const { api, signal } = fakes(cart('v1', 'l1'))
    const { result } = renderHook(() => useTableCart(api, signal))
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.cart).toEqual(cart('v1', 'l1'))
  })

  it('does nothing without an api', () => {
    const { result } = renderHook(() => useTableCart(null, null))
    expect(result.current.cart).toBeNull()
    expect(result.current.status).toBe('loading')
  })

  it('reads again on a ping and reports before and after', async () => {
    const { api, signal, server } = fakes(cart('v1', 'l1'))
    const onChange = vi.fn()
    const { result } = renderHook(() => useTableCart(api, signal, onChange))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(onChange).toHaveBeenLastCalledWith(null, cart('v1', 'l1'))
    server.cart = cart('v2', 'l1', 'l2')
    act(() => signal.fire())
    await waitFor(() => expect(result.current.cart?.version).toBe('v2'))
    expect(onChange).toHaveBeenLastCalledWith(cart('v1', 'l1'), cart('v2', 'l1', 'l2'))
  })

  it('reads again every CART_SWEEP_MS while the page is in view', async () => {
    vi.useFakeTimers()
    const { api, signal } = fakes(cart('v1'))
    renderHook(() => useTableCart(api, signal))
    await act(async () => { await Promise.resolve() })
    expect(api.state).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(CART_SWEEP_MS) })
    expect(api.state).toHaveBeenCalledTimes(2)
  })

  it('a write pings the others and reads again', async () => {
    const { api, signal, server } = fakes(cart('v1'))
    const { result } = renderHook(() => useTableCart(api, signal))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    server.cart = cart('v2', 'new')
    await act(() => result.current.add(guest, order))
    expect(api.put).toHaveBeenCalledWith(guest, order, null)
    expect(signal.pings).toBe(1)
    expect(result.current.cart?.version).toBe('v2')
    await act(() => result.current.replace(guest, 'new', { ...order, qty: 2 }))
    expect(api.put).toHaveBeenLastCalledWith(guest, { ...order, qty: 2 }, 'new')
    await act(() => result.current.remove('me', 'new'))
    expect(api.remove).toHaveBeenCalledWith('me', 'new')
    await act(() => result.current.rename(guest))
    expect(api.rename).toHaveBeenCalledWith(guest)
    expect(signal.pings).toBe(4)
  })

  it('send passes the version it holds and returns the server\'s status', async () => {
    const { api, signal } = fakes(cart('v7', 'l1'))
    vi.mocked(api.send).mockResolvedValueOnce('changed')
    const { result } = renderHook(() => useTableCart(api, signal))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    let status = ''
    await act(async () => { status = await result.current.send(2, ['l9'], 'order-1') })
    expect(status).toBe('changed')
    expect(api.send).toHaveBeenCalledWith(2, 'v7', ['l9'], 'order-1')
  })

  it('a failed write throws and changes nothing', async () => {
    const { api, signal } = fakes(cart('v1', 'l1'))
    vi.mocked(api.put).mockRejectedValueOnce(new Error('Failed to fetch'))
    const { result } = renderHook(() => useTableCart(api, signal))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await expect(act(() => result.current.add(guest, order))).rejects.toThrow('Failed to fetch')
    expect(signal.pings).toBe(0)
    expect(api.state).toHaveBeenCalledTimes(1)
    expect(result.current.cart).toEqual(cart('v1', 'l1'))
  })

  it('a failed read keeps the last cart and says offline; the next good read recovers', async () => {
    const { api, signal } = fakes(cart('v1', 'l1'))
    const { result } = renderHook(() => useTableCart(api, signal))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    vi.mocked(api.state).mockRejectedValueOnce(new Error('Failed to fetch'))
    act(() => signal.fire())
    await waitFor(() => expect(result.current.status).toBe('offline'))
    expect(result.current.cart).toEqual(cart('v1', 'l1'))
    act(() => signal.fire())
    await waitFor(() => expect(result.current.status).toBe('ready'))
  })

  it('an older reply never lands after a newer one', async () => {
    const { api, signal } = fakes(cart('v1'))
    const { result } = renderHook(() => useTableCart(api, signal))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    let slow: (c: CartState) => void = () => {}
    vi.mocked(api.state)
      .mockImplementationOnce(() => new Promise<CartState>((r) => { slow = r }))
      .mockImplementationOnce(async () => cart('v3'))
    act(() => signal.fire())            // the slow read starts
    act(() => signal.fire())            // a newer one starts and finishes first
    await waitFor(() => expect(result.current.cart?.version).toBe('v3'))
    await act(async () => { slow(cart('v2')) })
    expect(result.current.cart?.version).toBe('v3')
  })

  it('a read still pending at unmount never lands and never calls onChange', async () => {
    const { api, signal } = fakes(cart('v1'))
    let late: (c: CartState) => void = () => {}
    vi.mocked(api.state).mockImplementationOnce(() => new Promise<CartState>((r) => { late = r }))
    const onChange = vi.fn()
    const { unmount } = renderHook(() => useTableCart(api, signal, onChange))
    unmount()
    await act(async () => { late(cart('v1', 'l1')) })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a different api starts clean: no old cart, loading, then (null, newCart)', async () => {
    const a = fakes(cart('a1', 'l1'))
    const b = fakes(cart('b1', 'l2'))
    let release: (c: CartState) => void = () => {}
    vi.mocked(b.api.state).mockImplementationOnce(() => new Promise<CartState>((r) => { release = r }))
    const onChange = vi.fn()
    const { result, rerender } = renderHook(
      ({ api, signal }) => useTableCart(api, signal, onChange),
      { initialProps: { api: a.api, signal: a.signal } },
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.cart).toEqual(cart('a1', 'l1'))
    rerender({ api: b.api, signal: b.signal })
    expect(result.current.cart).toBeNull()
    expect(result.current.status).toBe('loading')
    await act(async () => { release(cart('b1', 'l2')) })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.cart).toEqual(cart('b1', 'l2'))
    expect(onChange).toHaveBeenLastCalledWith(null, cart('b1', 'l2'))
  })

  it('api set to null clears the cart and a late reply from the old api does not land', async () => {
    const { api, signal } = fakes(cart('v1', 'l1'))
    const onChange = vi.fn()
    const { result, rerender } = renderHook(
      ({ a }: { a: CartApi | null }) => useTableCart(a, signal, onChange),
      { initialProps: { a: api as CartApi | null } },
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))
    let late: (c: CartState) => void = () => {}
    vi.mocked(api.state).mockImplementationOnce(() => new Promise<CartState>((r) => { late = r }))
    act(() => signal.fire())
    rerender({ a: null })
    expect(result.current.cart).toBeNull()
    expect(result.current.status).toBe('loading')
    await act(async () => { late(cart('v2', 'l1', 'l2')) })
    expect(result.current.cart).toBeNull()
    expect(result.current.status).toBe('loading')
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('under StrictMode it still ends ready with the cart and one live listener', async () => {
    const { api, signal } = fakes(cart('v1', 'l1'))
    const { result } = renderHook(() => useTableCart(api, signal), { wrapper: StrictMode })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.cart).toEqual(cart('v1', 'l1'))
    expect(signal.live).toBe(1)
  })

  it('an onChange that throws is reported, does not fail the write and does not mark the cart offline', async () => {
    const { api, signal, server } = fakes(cart('v1', 'l1'))
    let calls = 0
    const boom = new Error('boom')
    const onChange = vi.fn(() => { if (++calls === 2) throw boom })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { result } = renderHook(() => useTableCart(api, signal, onChange))
      await waitFor(() => expect(result.current.status).toBe('ready'))
      server.cart = cart('v2', 'l1', 'new')
      await act(() => result.current.add(guest, order))   // resolves: the server took the write
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith(boom)
      expect(result.current.cart).toEqual(cart('v2', 'l1', 'new'))
      expect(result.current.status).toBe('ready')
    } finally { spy.mockRestore() }
  })

  it('a read with the version it already holds changes nothing and reports nothing', async () => {
    const { api, signal, server } = fakes(cart('v1', 'l1'))
    const onChange = vi.fn()
    const { result } = renderHook(() => useTableCart(api, signal, onChange))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    const held = result.current.cart
    server.cart = cart('v1', 'l1')            // a new object, same version
    await act(() => result.current.refresh())
    expect(api.state).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(result.current.cart).toBe(held)
    expect(result.current.status).toBe('ready')
    server.cart = cart('v2', 'l1')
    await act(() => result.current.refresh())
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(result.current.cart?.version).toBe('v2')
  })

  it('a same-version read recovers from offline', async () => {
    const { api, signal } = fakes(cart('v1', 'l1'))
    const { result } = renderHook(() => useTableCart(api, signal))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    vi.mocked(api.state).mockRejectedValueOnce(new Error('Failed to fetch'))
    await act(() => result.current.refresh())
    expect(result.current.status).toBe('offline')
    await act(() => result.current.refresh())
    expect(result.current.status).toBe('ready')
  })

  it('reads on visibilitychange only when the page is visible', async () => {
    vi.useFakeTimers()
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    try {
      const { api, signal } = fakes(cart('v1'))
      renderHook(() => useTableCart(api, signal))
      await act(async () => { await Promise.resolve() })
      expect(api.state).toHaveBeenCalledTimes(1)
      await act(async () => { vi.advanceTimersByTime(CART_SWEEP_MS) })
      expect(api.state).toHaveBeenCalledTimes(1)
      vis.mockReturnValue('visible')
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
      expect(api.state).toHaveBeenCalledTimes(2)
    } finally { vis.mockRestore() }
  })

  it('after unmount a ping or the timer reads nothing', async () => {
    vi.useFakeTimers()
    const { api, signal } = fakes(cart('v1'))
    const { unmount } = renderHook(() => useTableCart(api, signal))
    await act(async () => { await Promise.resolve() })
    expect(api.state).toHaveBeenCalledTimes(1)
    unmount()
    signal.fire()
    vi.advanceTimersByTime(CART_SWEEP_MS * 2)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(api.state).toHaveBeenCalledTimes(1)
    expect(signal.live).toBe(0)
  })

  it('no render returns the previous api\'s cart after an api change', async () => {
    const a = fakes(cart('a1', 'l1'))
    const b = fakes(cart('b1', 'l2'))
    const seen: { cart: CartState | null; status: string }[] = []
    const { result, rerender } = renderHook(
      ({ api, signal }) => {
        const r = useTableCart(api, signal)
        seen.push({ cart: r.cart, status: r.status })
        return r
      },
      { initialProps: { api: a.api, signal: a.signal } },
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))
    const mark = seen.length
    rerender({ api: b.api, signal: b.signal })
    await waitFor(() => expect(result.current.cart).toEqual(cart('b1', 'l2')))
    const after = seen.slice(mark)
    expect(after[0]).toEqual({ cart: null, status: 'loading' })
    expect(after.some((r) => r.cart?.version === 'a1')).toBe(false)
  })

  it('a write that completes after unmount reads nothing and calls no onChange', async () => {
    const { api, signal } = fakes(cart('v1', 'l1'))
    let release: (id: string) => void = () => {}
    vi.mocked(api.put).mockImplementationOnce(() => new Promise<string>((r) => { release = r }))
    const onChange = vi.fn()
    const { result, unmount } = renderHook(() => useTableCart(api, signal, onChange))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    let p: Promise<void> = Promise.resolve()
    act(() => { p = result.current.add(guest, order) })
    unmount()
    await act(async () => { release('new'); await p })
    expect(api.state).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('a write on the old api that completes after an api change never reads or lands', async () => {
    const a = fakes(cart('a1', 'l1'))
    const b = fakes(cart('b1', 'l2'))
    let release: (id: string) => void = () => {}
    vi.mocked(a.api.put).mockImplementationOnce(() => new Promise<string>((r) => { release = r }))
    const { result, rerender } = renderHook(
      ({ api, signal }) => useTableCart(api, signal),
      { initialProps: { api: a.api, signal: a.signal } },
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))
    let p: Promise<void> = Promise.resolve()
    act(() => { p = result.current.add(guest, order) })
    rerender({ api: b.api, signal: b.signal })
    await act(async () => { release('new'); await p })
    await waitFor(() => expect(result.current.cart).toEqual(cart('b1', 'l2')))
    expect(a.api.state).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe('ready')
  })

  it('a signal that arrives after the api re-subscribes without blanking the cart', async () => {
    const { api, signal, server } = fakes(cart('v1', 'l1'))
    const onChange = vi.fn()
    const seen: { cart: CartState | null; status: string }[] = []
    const { result, rerender } = renderHook(
      ({ s }: { s: CartSignal | null }) => {
        const r = useTableCart(api, s, onChange)
        seen.push({ cart: r.cart, status: r.status })
        return r
      },
      { initialProps: { s: null as CartSignal | null } },
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))
    const mark = seen.length
    rerender({ s: signal })
    await act(async () => { await Promise.resolve() })
    expect(seen.slice(mark).every((r) => r.cart !== null && r.status !== 'loading')).toBe(true)
    expect(signal.live).toBe(1)
    const reads = vi.mocked(api.state).mock.calls.length
    server.cart = cart('v2', 'l1', 'l2')
    act(() => signal.fire())
    await waitFor(() => expect(result.current.cart?.version).toBe('v2'))
    expect(vi.mocked(api.state).mock.calls.length).toBeGreaterThan(reads)
    expect(onChange).toHaveBeenLastCalledWith(cart('v1', 'l1'), cart('v2', 'l1', 'l2'))
  })
})
