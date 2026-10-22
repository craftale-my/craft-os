import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../../shared/lib/supabase'
import { clockOffsetMs, latencyMs, LATENCY_BUDGET_MS } from './latency'
import { fetchOrderTableLabel, fetchServerNow } from './spikeApi'

interface LiveRow {
  id: string
  source: string
  table: string
  latency: number
}

export default function LiveOrders() {
  const offsetRef = useRef(0)
  const [offset, setOffset] = useState<number | null>(null)
  const [status, setStatus] = useState('connecting')
  const [rows, setRows] = useState<LiveRow[]>([])

  useEffect(() => {
    const sent = Date.now()
    fetchServerNow()
      .then((iso) => {
        offsetRef.current = clockOffsetMs(sent, iso, Date.now())
        setOffset(Math.round(offsetRef.current))
      })
      .catch(() => setOffset(null))
  }, [])

  useEffect(() => {
    const channel = supabase
      .channel('spike-orders')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'spike_orders' }, (p) => {
        const receivedAt = Date.now() // stamp before any further round trip
        const row = p.new as { id: string; source: string; placed_at: string }
        const latency = Math.round(latencyMs(row.placed_at, receivedAt, offsetRef.current))
        void fetchOrderTableLabel(row.id)
          .catch(() => null)
          .then((label) =>
            setRows((r) => [{ id: row.id, source: row.source, table: label ?? 'Takeaway', latency }, ...r].slice(0, 20)),
          )
      })
      .subscribe((s) => setStatus(s))
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [])

  const worst = rows.length ? Math.max(...rows.map((r) => r.latency)) : null

  return (
    <section className="rounded border p-4">
      <h2 className="font-semibold">Spike 2 — live orders</h2>
      <p className="text-sm text-neutral-500">
        Realtime: {status} · clock offset: {offset === null ? 'unknown' : `${offset} ms`} · worst latency:{' '}
        {worst === null ? '—' : `${worst} ms`} (budget {LATENCY_BUDGET_MS} ms)
      </p>
      <table className="mt-2 w-full text-sm">
        <thead>
          <tr className="text-left">
            <th>Order</th>
            <th>Table</th>
            <th>Source</th>
            <th>Latency</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="font-mono">{r.id.slice(0, 6).toUpperCase()}</td>
              <td>{r.table}</td>
              <td>{r.source}</td>
              <td className={r.latency <= LATENCY_BUDGET_MS ? 'text-green-600' : 'font-semibold text-red-600'}>
                {r.latency} ms
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
