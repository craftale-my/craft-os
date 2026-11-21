// src/qr/useTableCart.test.tsx
// @vitest-environment jsdom
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
  const signal: CartSignal & { fire: () => void; pings: number } = {
    pings: 0,
    subscribe: (h) => { onPing = h; return () => { onPing = null } },
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
})
