import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../../shared/lib/supabase'
import { clockOffsetMs, latencyMs, LATENCY_BUDGET_MS } from './latency'
import { fetchOrderTableLabel, fetchServerNow } from './spikeApi'

/** ms = a real figure; offset-unknown = the clock offset had never been
 *  measured when the order arrived; unparsed = placed_at could not be read. */
type Latency = { kind: 'ms'; ms: number } | { kind: 'offset-unknown' } | { kind: 'unparsed' }

interface LiveRow {
  id: string
  source: string
  table: string
  latency: Latency
}

export default function LiveOrders() {
  const offsetRef = useRef<number | null>(null) // null until a measurement has succeeded
  const [offset, setOffset] = useState<number | null>(null)
  const [measuredAt, setMeasuredAt] = useState<number | null>(null) // when the offset in use was measured
  const [lastTryFailed, setLastTryFailed] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [status, setStatus] = useState('connecting')
  const [rows, setRows] = useState<LiveRow[]>([])

  useEffect(() => {
    const measure = () => {
      const sent = Date.now()
      fetchServerNow()
        .then((iso) => {
          const received = Date.now()
          const next = clockOffsetMs(sent, iso, received)
          if (Number.isNaN(next)) throw new Error('unparseable server time')
          offsetRef.current = next
          setOffset(Math.round(next))
          setMeasuredAt(received)
          setLastTryFailed(false)
        })
        // keep the last good offset; only the label changes
        .catch(() => setLastTryFailed(true))
    }
    measure()
    const timer = window.setInterval(measure, 60_000)
    const clock = window.setInterval(() => setNow(Date.now()), 1000)
    return () => {
      window.clearInterval(timer)
      window.clearInterval(clock)
    }
  }, [])

  useEffect(() => {
    // unique topic per run: supabase.channel() reuses a same-named channel that is still being removed
    const channel = supabase
      .channel(`spike-orders-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'spike_orders' }, (p) => {
        const receivedAt = Date.now() // stamp before any further round trip
        const row = p.new as { id: string; source: string; placed_at: string }
        let latency: Latency
        if (offsetRef.current === null) {
          latency = { kind: 'offset-unknown' }
        } else {
          const ms = Math.round(latencyMs(row.placed_at, receivedAt, offsetRef.current))
          latency = Number.isNaN(ms) ? { kind: 'unparsed' } : { kind: 'ms', ms }
        }
        void fetchOrderTableLabel(row.id)
          .catch(() => 'Unknown')
          .then((label) =>
            setRows((r) => [{ id: row.id, source: row.source, table: label ?? 'Takeaway', latency }, ...r].slice(0, 20)),
          )
      })
      .subscribe((s) => setStatus(s))
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [])

  // Rows without a real figure are left out of the worst-case number.
  const figures = rows.flatMap((r) => (r.latency.kind === 'ms' ? [r.latency.ms] : []))
  const worst = figures.length ? Math.max(...figures) : null
  const excluded = rows.length - figures.length

  const offsetLabel =
    offset === null
      ? 'unknown'
      : lastTryFailed && measuredAt !== null
        ? `${offset} ms (last measured ${Math.round((now - measuredAt) / 1000)} s ago)`
        : `${offset} ms`

  return (
    <section className="rounded border p-4">
      <h2 className="font-semibold">Spike 2 — live orders</h2>
      <p className="text-sm text-neutral-500">
        Realtime: {status} · clock offset: {offsetLabel} · worst latency: {worst === null ? '—' : `${worst} ms`} (budget{' '}
        {LATENCY_BUDGET_MS} ms)
        {excluded > 0 && ` · ${excluded} row${excluded === 1 ? '' : 's'} without a figure not counted`}
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
              {r.latency.kind === 'ms' ? (
                <td className={r.latency.ms <= LATENCY_BUDGET_MS ? 'text-green-600' : 'font-semibold text-red-600'}>
                  {r.latency.ms} ms
                </td>
              ) : (
                <td className="text-amber-700">{r.latency.kind === 'unparsed' ? 'unparsed' : 'offset unknown'}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
