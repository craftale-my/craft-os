import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../../shared/lib/supabase'
import { printFromBrowser, type PrintRoute } from '../print/adapter'
import { processJob, type PrintJob } from '../print/printHost'
import { claimJob, fetchPendingJobs, fetchRoutes, finishJob, insertTestJob, requeueJob } from './spikeApi'

export default function PrintHostPanel() {
  const [enabled, setEnabled] = useState(true)
  const [routes, setRoutes] = useState<PrintRoute[]>([])
  const [failed, setFailed] = useState<PrintJob[]>([])
  const [log, setLog] = useState<string[]>([])
  const routesRef = useRef<PrintRoute[]>([])

  const note = useCallback(
    (m: string) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${m}`, ...l].slice(0, 30)),
    [],
  )

  /** Never rejects, so callers can safely `void` it. */
  const handle = useCallback(
    async (job: PrintJob): Promise<void> => {
      const route = routesRef.current.find((r) => r.route === job.route)
      if (!route || route.kind === 'agent') return // the Node agent prints these
      let printed = false // per call: set only when the print step itself succeeded
      try {
        const result = await processJob(job, {
          claim: claimJob,
          finish: finishJob,
          print: async (j) => {
            try {
              await printFromBrowser(route, j.payload)
              printed = true
            } catch (e) {
              note(`${j.route} error: ${e instanceof Error ? e.message : String(e)}`)
              throw e
            }
          },
        })
        note(`${job.route} ${job.id.slice(0, 8)} → ${result}`)
        if (result === 'failed') setFailed((f) => [...f, job])
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e)
        if (printed) {
          // The ticket printed but recording it failed. Do NOT offer a reprint:
          // that would produce a duplicate ticket.
          note(`${job.route} ${job.id.slice(0, 8)} printed but could not record it: ${why}`)
        } else {
          note(`${job.route} ${job.id.slice(0, 8)} failed and could not record the failure: ${why}`)
        }
      }
    },
    [note],
  )

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let channel: ReturnType<typeof supabase.channel> | null = null
    let timer: number | undefined
    let sweeping = false

    /** Prints every pending browser-route job. Never rejects; one sweep at a time. */
    const sweep = async (): Promise<void> => {
      if (sweeping || cancelled) return
      sweeping = true
      try {
        const browserRoutes = routesRef.current.filter((r) => r.kind !== 'agent').map((r) => r.route)
        for (const job of await fetchPendingJobs(browserRoutes)) {
          if (cancelled) return
          await handle(job)
        }
      } catch (e) {
        note(`could not sweep pending jobs: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        sweeping = false
      }
    }

    fetchRoutes()
      .then((rs) => {
        if (cancelled) return
        routesRef.current = rs
        setRoutes(rs)
        // Subscribe only now: an INSERT that arrived before routes loaded would be dropped.
        // Unique topic per run: supabase.channel() reuses a same-named channel that is still being removed.
        channel = supabase
          .channel(`spike-print-jobs-${crypto.randomUUID()}`)
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'spike_print_jobs' }, (p) => {
            void handle(p.new as PrintJob)
          })
          .subscribe((status) => {
            if (status === 'SUBSCRIBED') void sweep() // initial subscribe and every reconnect
            else note(`realtime ${status}`)
          })
        timer = window.setInterval(() => void sweep(), 15_000)
        void sweep()
      })
      .catch((e: unknown) => note(`could not load routes: ${e instanceof Error ? e.message : String(e)}`))
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearInterval(timer)
      if (channel) void supabase.removeChannel(channel)
    }
  }, [enabled, handle, note])

  const reprint = async (job: PrintJob) => {
    try {
      await requeueJob(job.id)
    } catch (e) {
      note(`${job.route} ${job.id.slice(0, 8)} could not be requeued: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    setFailed((f) => f.filter((x) => x.id !== job.id))
    await handle({ ...job, status: 'pending' })
  }

  return (
    <section className="rounded border p-4">
      <h2 className="font-semibold">Spike 1 — printing</h2>
      <label className="mt-1 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        This iPad prints browser routes
      </label>
      <div className="mt-2 flex flex-wrap gap-2">
        {routes.map((r) => (
          <button
            key={r.route}
            className="rounded border px-3 py-2"
            onClick={() => void insertTestJob(r.route).catch((e: Error) => note(e.message))}
          >
            Test print {r.route} ({r.kind} · {r.address})
          </button>
        ))}
      </div>
      {failed.length > 0 && (
        <div className="mt-2 rounded bg-red-50 p-2 text-sm text-red-700">
          {failed.map((j) => (
            <div key={j.id} className="flex items-center justify-between">
              <span>
                {j.route} ticket {j.id.slice(0, 8)} did not print
              </span>
              <button className="underline" onClick={() => void reprint(j)}>
                Reprint
              </button>
            </div>
          ))}
        </div>
      )}
      <pre className="mt-2 max-h-48 overflow-auto text-xs">{log.join('\n')}</pre>
    </section>
  )
}
