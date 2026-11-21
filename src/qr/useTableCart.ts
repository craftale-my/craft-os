// src/qr/useTableCart.ts
/** The table's shared cart on this phone: read on mount, on a ping from another phone, every
 *  CART_SWEEP_MS while in view and when the page comes back into view. Writes go to the server, ping the
 *  others and read again; a failed write throws and shows nothing that the server does not hold. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { OrderLine } from '../features/pos/order/cart'
import type { CartApi, CartSignal } from './qrCartApi'
import type { CartState } from './qrCart'
import type { Guest } from './qrGuest'

/** the fallback read: a missed ping costs at most this (Task 1: 15 s with Broadcast, 4 s without) */
export const CART_SWEEP_MS = 15_000
export type CartStatus = 'loading' | 'ready' | 'offline'

export interface TableCart {
  cart: CartState | null
  status: CartStatus
  refresh(): Promise<void>
  add(guest: Guest, line: OrderLine): Promise<void>
  replace(guest: Guest, lineId: string, line: OrderLine): Promise<void>
  remove(guestId: string, lineId: string): Promise<void>
  rename(guest: Guest): Promise<void>
  /** sends the cart this phone last read; 'changed' = it was not that cart any more, nothing was sent */
  send(pax: number | null, skip: string[], clientOrderId: string): Promise<'sent' | 'changed'>
}

export function useTableCart(
  api: CartApi | null, signal: CartSignal | null,
  onChange?: (before: CartState | null, after: CartState) => void,
): TableCart {
  const [cart, setCart] = useState<CartState | null>(null)
  const [status, setStatus] = useState<CartStatus>('loading')
  const cartRef = useRef<CartState | null>(null)
  const seq = useRef(0)                       // an older reply never lands after a newer one
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange })

  const refresh = useCallback(async () => {
    if (!api) return
    const mine = ++seq.current
    try {
      const next = await api.state()
      if (mine !== seq.current) return
      const before = cartRef.current
      cartRef.current = next
      setCart(next)
      setStatus('ready')
      onChangeRef.current?.(before, next)
    } catch {
      if (mine === seq.current) setStatus('offline')
    }
  }, [api])

  useEffect(() => {
    if (!api) return
    void refresh()
    const off = signal?.subscribe(() => { void refresh() })
    const tick = () => { if (document.visibilityState === 'visible') void refresh() }
    const timer = window.setInterval(tick, CART_SWEEP_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      off?.()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [api, signal, refresh])

  const wrote = useCallback(async () => { signal?.ping(); await refresh() }, [signal, refresh])
  const need = (): CartApi => { if (!api) throw new Error('The order is still loading.'); return api }

  return {
    cart, status, refresh,
    add: async (guest, line) => { await need().put(guest, line, null); await wrote() },
    replace: async (guest, lineId, line) => { await need().put(guest, line, lineId); await wrote() },
    remove: async (guestId, lineId) => { await need().remove(guestId, lineId); await wrote() },
    rename: async (guest) => { await need().rename(guest); await wrote() },
    send: async (pax, skip, clientOrderId) => {
      const version = cartRef.current?.version
      if (version === undefined) throw new Error('The order is still loading.')
      const result = await need().send(pax, version, skip, clientOrderId)
      await wrote()
      return result
    },
  }
}
