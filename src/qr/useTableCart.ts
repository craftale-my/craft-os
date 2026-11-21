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
interface Owned { owner: CartApi | null; cart: CartState | null; status: CartStatus }

export interface TableCart {
  cart: CartState | null
  status: CartStatus
  refresh(): Promise<void>
  add(guest: Guest, line: OrderLine): Promise<void>
  replace(guest: Guest, lineId: string, line: OrderLine): Promise<void>
  remove(guestId: string, lineId: string): Promise<void>
  rename(guest: Guest): Promise<void>
  /** sends the cart `version` (what the sender saw; default: the cart this phone last read);
   *  'changed' = it was not that cart any more, nothing was sent */
  send(pax: number | null, skip: string[], clientOrderId: string, version?: string): Promise<'sent' | 'changed'>
}

/** `api` and `signal` must be stable between renders (e.g. from `useMemo`): the effect that reads and
 *  listens depends on them, and a new identity is treated as a different table. */
export function useTableCart(
  api: CartApi | null, signal: CartSignal | null,
  onChange?: (before: CartState | null, after: CartState) => void,
): TableCart {
  // the state remembers which api it belongs to: a render under another api derives "loading" from it
  const [state, setState] = useState<Owned>(() => ({ owner: api, cart: null, status: 'loading' }))
  const cartRef = useRef<{ owner: CartApi; cart: CartState } | null>(null)
  const bound = useRef<CartApi | null>(null)   // the api the effect is currently bound to
  const seq = useRef(0)                       // an older reply never lands after a newer one
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange })

  const refresh = useCallback(async () => {
    if (!api || bound.current !== api) return   // a read for an api we left never starts
    const mine = ++seq.current
    const patch = (p: Partial<Owned>) => setState((s) => {
      const base: Owned = s.owner === api ? s : { owner: api, cart: null, status: 'loading' }
      return { ...base, ...p }
    })
    let next: CartState
    try {
      next = await api.state()
    } catch {
      if (mine === seq.current && bound.current === api) patch({ status: 'offline' })
      return
    }
    if (mine !== seq.current || bound.current !== api) return
    const held = cartRef.current
    const before = held && held.owner === api ? held.cart : null
    // nothing new (same version and same last order): keep the object, say nothing
    if (before && before.version === next.version && (before.lastOrder ?? null) === (next.lastOrder ?? null)) {
      patch({ status: 'ready' }); return
    }
    cartRef.current = { owner: api, cart: next }
    patch({ cart: next, status: 'ready' })
    // a throwing consumer is its own problem: it must neither read as "offline" nor make the write look failed
    try { onChangeRef.current?.(before, next) } catch (e) { console.error(e) }
  }, [api])

  // bound to the api only: a different api is a different table, a new signal is not
  useEffect(() => {
    bound.current = api
    cartRef.current = null
    setState((s) => (s.owner === api && s.cart === null && s.status === 'loading'
      ? s : { owner: api, cart: null, status: 'loading' }))
    if (!api) return () => { bound.current = null }
    void refresh()
    const tick = () => { if (document.visibilityState === 'visible') void refresh() }
    const timer = window.setInterval(tick, CART_SWEEP_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      bound.current = null
      seq.current++                           // a read in flight now never lands
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [api, refresh])

  useEffect(() => {
    if (!api) return
    return signal?.subscribe(() => { void refresh() })
  }, [api, signal, refresh])

  const mine = state.owner === api
  const cart = mine ? state.cart : null
  const status: CartStatus = mine ? state.status : 'loading'

  const wrote = useCallback(async () => { signal?.ping(); await refresh() }, [signal, refresh])
  const need = (): CartApi => { if (!api) throw new Error('The order is still loading.'); return api }

  return {
    cart, status, refresh,
    add: async (guest, line) => { await need().put(guest, line, null); await wrote() },
    replace: async (guest, lineId, line) => { await need().put(guest, line, lineId); await wrote() },
    remove: async (guestId, lineId) => { await need().remove(guestId, lineId); await wrote() },
    rename: async (guest) => { await need().rename(guest); await wrote() },
    send: async (pax, skip, clientOrderId, seenVersion) => {
      const held = cartRef.current
      const version = seenVersion ?? (held && held.owner === api ? held.cart.version : undefined)
      if (version === undefined) throw new Error('The order is still loading.')
      const result = await need().send(pax, version, skip, clientOrderId)
      await wrote()
      return result
    },
  }
}
