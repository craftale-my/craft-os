import { useEffect, useState } from 'react'
import { supabase } from '../../../shared/lib/supabase'

interface QrMenu {
  tableLabel: string
  paused: boolean
  items: { id: string; name: string; priceSen: number; available: boolean }[]
}

const rm = (sen: number) => `RM ${(sen / 100).toFixed(2)}`

export default function QrSpike() {
  const token = new URLSearchParams(window.location.search).get('t') ?? ''
  const [menu, setMenu] = useState<QrMenu | null | undefined>(undefined)
  const [cart, setCart] = useState<Record<string, number>>({})
  // Kept until the server confirms, so tapping "Place order" again after a
  // timeout resends the SAME order instead of creating a second one.
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    void supabase
      .rpc('spike_qr_menu', { p_token: token })
      .then(({ data, error }) => setMenu(error ? null : ((data as QrMenu | null) ?? null)))
  }, [token])

  if (menu === undefined) return <p className="p-6">Loading menu…</p>
  if (menu === null) return <p className="p-6">This table code is not valid. Please ask our staff.</p>

  const change = (id: string, delta: number) => {
    setPendingId(null) // a different cart is a different order
    setCart((c) => ({ ...c, [id]: Math.max(0, (c[id] ?? 0) + delta) }))
  }

  const items = Object.entries(cart)
    .filter(([, qty]) => qty > 0)
    .map(([menuItemId, qty]) => ({ menuItemId, qty, note: null }))

  const place = async () => {
    const id = pendingId ?? crypto.randomUUID()
    setPendingId(id)
    setStatus('Sending…')
    const { error } = await supabase.rpc('spike_place_table_order', {
      p_token: token,
      p_items: items,
      p_client_order_id: id,
    })
    if (error) {
      setStatus(`Not sent: ${error.message} Tap Place order to try again.`)
      return
    }
    setPendingId(null)
    setCart({})
    setStatus(`Order placed at ${new Date().toLocaleTimeString()}`)
  }

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
                <button className="h-9 w-9 rounded border text-lg" onClick={() => change(item.id, -1)}>−</button>
                <span className="w-5 text-center">{cart[item.id] ?? 0}</span>
                <button className="h-9 w-9 rounded border text-lg" onClick={() => change(item.id, 1)}>+</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <button
        className="w-full rounded bg-neutral-900 py-3 text-white disabled:opacity-40"
        disabled={items.length === 0 || menu.paused || status === 'Sending…'}
        onClick={() => void place()}
      >
        Place order
      </button>
      {status && <p className="text-center text-sm">{status}</p>}
    </main>
  )
}
