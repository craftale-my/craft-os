import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../../shared/lib/supabase'
import { cartItems, cartKey } from './qrCart'

interface QrMenu {
  tableLabel: string
  paused: boolean
  items: { id: string; name: string; priceSen: number; available: boolean }[]
}

type MenuState =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; menu: QrMenu }

const rm = (sen: number) => `RM ${(sen / 100).toFixed(2)}`

export default function QrSpike() {
  const token = new URLSearchParams(window.location.search).get('t') ?? ''
  const [state, setState] = useState<MenuState>({ kind: 'loading' })
  const [cart, setCart] = useState<Record<string, number>>({})
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  // The idempotency key follows the cart contents: resending the same cart
  // (e.g. after a timeout) reuses the id; a different cart gets a new one.
  // Cleared only after the server confirms.
  const pending = useRef<{ id: string; cartKey: string } | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) {
      setState({ kind: 'invalid' })
      return
    }
    setState({ kind: 'loading' })
    const { data, error } = await supabase.rpc('spike_qr_menu', { p_token: token })
    if (error) {
      console.error('spike_qr_menu failed', error)
      setState({ kind: 'error', message: 'Could not load the menu. Check your connection and try again.' })
      return
    }
    const menu = data as QrMenu | null
    setState(menu ? { kind: 'ready', menu } : { kind: 'invalid' })
  }, [token])

  useEffect(() => {
    void load()
  }, [load])

  if (state.kind === 'loading') return <p className="p-6">Loading menu…</p>
  if (state.kind === 'invalid') return <p className="p-6">This table code is not valid. Please ask our staff.</p>
  if (state.kind === 'error') {
    return (
      <div className="space-y-3 p-6">
        <p>{state.message}</p>
        <button type="button" className="rounded border px-4 py-2" onClick={() => void load()}>
          Try again
        </button>
      </div>
    )
  }
  const { menu } = state

  const change = (id: string, delta: number) => {
    setStatus(null)
    setCart((c) => ({ ...c, [id]: Math.max(0, (c[id] ?? 0) + delta) }))
  }

  const items = cartItems(cart)

  const place = async () => {
    if (sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    setStatus('Sending…')
    try {
      const key = cartKey(cart)
      if (pending.current?.cartKey !== key) {
        pending.current = { id: crypto.randomUUID(), cartKey: key }
      }
      const startedAt = performance.now()
      const { error } = await supabase.rpc('spike_place_table_order', {
        p_token: token,
        p_items: items,
        p_client_order_id: pending.current.id,
      })
      const sentInMs = Math.round(performance.now() - startedAt) // the customer's half of the trip
      if (error) {
        setStatus(`Not sent: ${error.message} Tap Place order to try again.`)
        return
      }
      pending.current = null
      setCart({})
      setStatus(`Order placed at ${new Date().toLocaleTimeString()} (sent in ${sentInMs} ms)`)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setStatus(`Not sent: ${message} Tap Place order to try again.`)
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  const editLocked = sending || menu.paused

  return (
    <main className="mx-auto max-w-md space-y-4 p-4">
      <h1 className="text-xl font-semibold">Table {menu.tableLabel}</h1>
      {menu.paused && <p className="rounded bg-amber-100 p-3">Ordering is paused for this table. Please order at the counter.</p>}
      <ul className="divide-y rounded border">
        {menu.items.map((item) => (
          <li key={item.id} className="flex items-center justify-between p-3">
            <div className={item.available ? '' : 'opacity-40'}>
              <div>{item.name}</div>
              <div className="text-sm text-neutral-500">{item.available ? rm(item.priceSen) : 'Sold out'}</div>
            </div>
            {item.available && (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  aria-label={`Remove one ${item.name}`}
                  className="h-9 w-9 rounded border text-lg disabled:opacity-40"
                  disabled={editLocked}
                  onClick={() => change(item.id, -1)}
                >
                  −
                </button>
                <span className="w-5 text-center">{cart[item.id] ?? 0}</span>
                <button
                  type="button"
                  aria-label={`Add one ${item.name}`}
                  className="h-9 w-9 rounded border text-lg disabled:opacity-40"
                  disabled={editLocked}
                  onClick={() => change(item.id, 1)}
                >
                  +
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="w-full rounded bg-neutral-900 py-3 text-white disabled:opacity-40"
        disabled={items.length === 0 || menu.paused || sending}
        onClick={() => void place()}
      >
        Place order
      </button>
      {status && <p className="text-center text-sm">{status}</p>}
    </main>
  )
}
