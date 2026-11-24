// src/qr/qrCartApi.ts
/** The table cart's server calls (qr_cart_* in supabase/migration-2026-11-22-qr-table-cart.sql) and the
 *  "something changed" ping between the phones at one table. */
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import type { OrderLine } from '../features/pos/order/cart'
import { parseCart, type CartState } from './qrCart'
import type { Guest } from './qrGuest'

export interface CartApi {
  state(): Promise<CartState>
  /** lineId null = a new line; returns the line's id */
  put(guest: Guest, line: OrderLine, lineId: string | null): Promise<string>
  remove(guestId: string, lineId: string): Promise<void>
  rename(guest: Guest): Promise<void>
  send(pax: number | null, version: string, skip: string[], clientOrderId: string): Promise<'sent' | 'changed'>
}
export interface CartSignal {
  /** start listening; the returned function stops this listener */
  subscribe(onPing: () => void): () => void
  /** tell the other phones the cart changed (carries no data) */
  ping(): void
}

const UNEXPECTED = 'Unexpected reply from the server'

export function makeCartApi(client: SupabaseClient, token: string): CartApi {
  const call = async (fn: string, args: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = await client.rpc(fn, { p_token: token, ...args })
    if (error) throw new Error(error.message)
    return data
  }
  return {
    async state() {
      const cart = parseCart(await call('qr_cart_state', {}))
      if (!cart) throw new Error(UNEXPECTED)
      return cart
    },
    async put(guest, line, lineId) {
      // only the order line's own fields go up, whatever else the object carries
      const p_line = { productId: line.productId, variantId: line.variantId, qty: line.qty, note: line.note, optionIds: line.optionIds }
      const id = await call('qr_cart_put', { p_guest: guest, p_line, p_line_id: lineId })
      if (typeof id !== 'string') throw new Error(UNEXPECTED)
      return id
    },
    async remove(guestId, lineId) { await call('qr_cart_remove', { p_guest_id: guestId, p_line_id: lineId }) },
    async rename(guest) { await call('qr_cart_rename', { p_guest: guest }) },
    async send(pax, version, skip, clientOrderId) {
      const data = await call('qr_cart_send', { p_pax: pax, p_version: version, p_skip: skip, p_client_order_id: clientOrderId })
      const status = typeof data === 'object' && data !== null ? (data as { status?: unknown }).status : undefined
      if (status !== 'sent' && status !== 'changed') throw new Error(UNEXPECTED)
      return status
    },
  }
}

/** One channel for the page's life: the topic is shared by every phone at the table, and supabase-js
 *  hands back a same-named channel that is still being torn down (POS Phase 0), so it is never removed
 *  and re-created — unsubscribing only drops the listener. */
export function makeCartSignal(client: SupabaseClient, topic: string): CartSignal {
  let channel: RealtimeChannel | null = null
  let handler: (() => void) | null = null
  return {
    subscribe(onPing) {
      handler = onPing
      if (!channel) {
        channel = client.channel(topic, { config: { broadcast: { self: false } } })
          .on('broadcast', { event: 'changed' }, () => handler?.())
        channel.subscribe()
      }
      return () => { if (handler === onPing) handler = null }
    },
    ping() { void channel?.send({ type: 'broadcast', event: 'changed', payload: {} }) },
  }
}
