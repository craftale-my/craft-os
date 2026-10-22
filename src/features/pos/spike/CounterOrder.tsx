import { useCallback, useEffect, useRef, useState } from 'react'
import { createIdbStore } from '../offline/idbStore'
import { enqueue, flushQueue, newQueuedOrder, type CartLine, type FlushReport } from '../offline/orderQueue'
import {
  countOrdersWithClientId, fetchMenu, fetchTables, sendCounterOrder,
  type SpikeMenuItem, type SpikeTable,
} from './spikeApi'

const store = createIdbStore()

/** Shows the last good copy at once, then refreshes from the server. Offline,
 *  the cached copy is all there is — which is the point. */
function cachedLoad<T>(key: string, load: () => Promise<T>, set: (v: T) => void): void {
  try {
    const raw = localStorage.getItem(key)
    if (raw) set(JSON.parse(raw) as T)
  } catch {
    // storage unavailable — fall through to the network
  }
  load()
    .then((v) => {
      set(v)
      try {
        localStorage.setItem(key, JSON.stringify(v))
      } catch {
        // ignore
      }
    })
    .catch(() => undefined)
}

export default function CounterOrder() {
  const [tables, setTables] = useState<SpikeTable[]>([])
  const [menu, setMenu] = useState<SpikeMenuItem[]>([])
  const [tableId, setTableId] = useState('') // '' = takeaway
  const [cart, setCart] = useState<CartLine[]>([])
  const [online, setOnline] = useState(navigator.onLine)
  const [report, setReport] = useState<FlushReport | null>(null)
  const [dupResult, setDupResult] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const inFlight = useRef<Promise<void> | null>(null)
  const again = useRef(false)

  const flush = useCallback((): Promise<void> => {
    // One flush at a time — overlapping flushes would send the same order twice.
    // A call that arrives mid-flush may have enqueued after that flush read the
    // store, so it asks for exactly one follow-up pass and awaits that.
    if (inFlight.current) {
      again.current = true
      return inFlight.current
    }
    const run = async (): Promise<void> => {
      try {
        do {
          again.current = false
          try {
            setReport(await flushQueue(store, sendCounterOrder))
          } catch {
            // a failed flush just leaves the queue for the next tick
          }
        } while (again.current)
      } finally {
        inFlight.current = null
      }
    }
    inFlight.current = run()
    return inFlight.current
  }, [])

  useEffect(() => {
    cachedLoad('pos-spike:tables', fetchTables, setTables)
    cachedLoad('pos-spike:menu', fetchMenu, setMenu)
    void navigator.storage?.persist?.()?.catch(() => undefined)
    void flush()
    const goOnline = () => {
      setOnline(true)
      void flush()
    }
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    const timer = window.setInterval(() => void flush(), 15_000)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
      window.clearInterval(timer)
    }
  }, [flush])

  const add = (menuItemId: string) =>
    setCart((c) =>
      c.some((l) => l.menuItemId === menuItemId)
        ? c.map((l) => (l.menuItemId === menuItemId ? { ...l, qty: l.qty + 1 } : l))
        : [...c, { menuItemId, qty: 1, note: null }],
    )

  const submit = async () => {
    if (saving) return
    setSaving(true)
    setSaveError(null)
    try {
      await enqueue(store, newQueuedOrder(tableId || null, cart)) // on disk before anything else
    } catch (e) {
      // not on disk: keep the cart so the order can be retried, and say so loudly
      setSaveError(`Order NOT saved on this iPad: ${e instanceof Error ? e.message : String(e)}`)
      setSaving(false)
      return
    }
    setCart([])
    setSaving(false)
    await flush()
  }

  const duplicateTest = async () => {
    try {
      const order = newQueuedOrder(tableId || null, [{ menuItemId: menu[0].id, qty: 1, note: 'duplicate test' }])
      const first = await sendCounterOrder(order)
      const second = await sendCounterOrder(order) // simulates a resend after a lost reply
      const rows = await countOrdersWithClientId(order.clientOrderId)
      setDupResult(
        first.ok && second.ok && rows === 1
          ? 'PASS — sent twice, stored once'
          : `FAIL — first ${first.ok ? 'ok' : 'error'}, second ${second.ok ? 'ok' : 'error'}, rows ${rows}`,
      )
    } catch (e) {
      setDupResult(`FAIL — ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const nameOf = (id: string) => menu.find((m) => m.id === id)?.name ?? id
  const stuck = report?.stuck ?? 0

  return (
    <section className="rounded border p-4">
      <h2 className="font-semibold">Spike 3 — counter orders</h2>
      <p className="text-sm text-neutral-500">
        {online ? 'Online' : 'OFFLINE'} · queued: {report?.pending ?? '…'} · rejected: {report?.stuck ?? '…'} · sent in
        last flush: {report?.sent ?? '…'}
      </p>
      {stuck > 0 && (
        <p className="mt-1 text-sm font-semibold text-red-600">
          {stuck} order{stuck === 1 ? '' : 's'} rejected by the server and stuck on this iPad
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <select className="rounded border p-2" value={tableId} onChange={(e) => setTableId(e.target.value)}>
          <option value="">Takeaway</option>
          {tables.map((t) => (
            <option key={t.id} value={t.id}>
              Table {t.label}
            </option>
          ))}
        </select>
        {menu.map((m) => (
          <button key={m.id} className="rounded border px-3 py-2" onClick={() => add(m.id)}>
            {m.name}
          </button>
        ))}
      </div>
      <ul className="mt-2 text-sm">
        {cart.map((l) => (
          <li key={l.menuItemId}>
            {l.qty} x {nameOf(l.menuItemId)}
          </li>
        ))}
      </ul>
      {saveError && <p className="mt-2 text-sm font-semibold text-red-600">{saveError}</p>}
      <div className="mt-2 flex gap-2">
        <button
          className="rounded bg-neutral-900 px-4 py-2 text-white disabled:opacity-40"
          disabled={cart.length === 0 || saving}
          onClick={() => void submit()}
        >
          Submit order
        </button>
        <button className="rounded border px-4 py-2" onClick={() => void flush()}>
          Retry now
        </button>
        <button className="rounded border px-4 py-2" disabled={menu.length === 0} onClick={() => void duplicateTest()}>
          Duplicate test (creates a real order)
        </button>
      </div>
      {dupResult && <p className="mt-2 text-sm">{dupResult}</p>}
    </section>
  )
}
