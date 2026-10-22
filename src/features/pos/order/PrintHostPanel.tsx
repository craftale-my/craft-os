import { useCallback, useEffect, useRef, useState } from 'react'
import { processJob, type PrintJob } from '../print/printHost'
import { printFromBrowser, type PrintRoute } from '../print/adapter'
import { claimJob, fetchPrintJobs, fetchRoutes, finishJob, insertTestPrint, requeueJob, type PrintJobRow } from './posApi'
import { usePosRealtime } from './usePosRealtime'

const STUCK_MS = 2 * 60_000

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export default function PrintHostPanel({ branchId }: { branchId: string }) {
  const [routes, setRoutes] = useState<PrintRoute[]>([])
  const [problems, setProblems] = useState<PrintJobRow[]>([])
  const [note, setNote] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const sweeping = useRef(false)
  const routesRef = useRef<PrintRoute[]>([])
  routesRef.current = routes

  useEffect(() => { fetchRoutes(branchId).then(setRoutes, (e) => setNote(msg(e))) }, [branchId])

  const handle = useCallback(async (job: PrintJob) => {
    const route = routesRef.current.find((r) => r.route === job.route)
    if (!route || route.kind === 'agent') return            // the Node agent prints these
    try {
      await processJob(job, { claim: claimJob, finish: finishJob, print: (j) => printFromBrowser(route, j.payload) })
    } catch (e) {
      setNote(`${job.route}: printed but could not record it — ${msg(e)}`)
    }
  }, [])

  const sweep = useCallback(async () => {
    if (sweeping.current) return
    sweeping.current = true
    try {
      const jobs = await fetchPrintJobs(branchId, ['pending', 'printing', 'failed'])
      const now = Date.now()
      setProblems(jobs.filter((j) => j.status === 'failed' || (j.status === 'printing' && j.claimed_at && now - Date.parse(j.claimed_at) > STUCK_MS)))
      for (const j of jobs) if (j.status === 'pending') await handle(j)
    } catch (e) { setNote(msg(e)) } finally { sweeping.current = false }
  }, [branchId, handle])

  usePosRealtime(branchId, { onPrintJob: (row) => void handle(row), onSweep: () => void sweep() })

  const reprint = async (job: PrintJobRow) => {
    try {
      await requeueJob(job.id)
      await handle({ ...job, status: 'pending' })
      await sweep()
    } catch (e) { setNote(`Reprint failed — ${msg(e)}`) }
  }

  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)}
        className={`rounded px-3 py-1 text-xs ${problems.length ? 'bg-red-600 text-white' : 'border border-border'}`}>
        Printers{problems.length ? ` · ${problems.length} failed` : ''}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-96 rounded-xl border border-border bg-card p-3 text-sm shadow-lg">
          {note && <p className="mb-2 text-xs text-amber-700">{note}</p>}
          <div className="mb-2 flex flex-wrap gap-2">
            {routes.map((r) => (
              <button key={r.route} onClick={() => insertTestPrint(r.route).catch((e) => setNote(msg(e)))}
                className="rounded border border-border px-2 py-1 text-xs">Test {r.route} ({r.kind})</button>
            ))}
            {routes.length === 0 && <span className="text-xs text-brown-muted">No printers set — see Tables & printers.</span>}
          </div>
          {problems.length === 0 && <p className="text-xs text-brown-muted">All tickets printed.</p>}
          {problems.map((j) => (
            <div key={j.id} className="mb-2 rounded bg-red-50 p-2">
              <div className="font-medium">{j.route} · {j.payload.orderNo}{j.payload.tableLabel ? ` · ${j.payload.tableLabel}` : ' · takeaway'}</div>
              <div className="text-xs text-red-700">{j.status === 'printing' ? 'Stuck while printing — check the printer before reprinting' : j.last_error ?? 'Failed'} · {j.attempts} attempt{j.attempts === 1 ? '' : 's'}</div>
              <button onClick={() => void reprint(j)} className="mt-1 rounded bg-brown-btn px-2 py-1 text-xs text-white">Reprint</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
