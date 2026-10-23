import { useCallback, useEffect, useRef, useState } from 'react'
import { processJob, type PrintJob } from '../print/printHost'
import { printFromBrowser, type PrintRoute } from '../print/adapter'
import { jobLabel } from '../print/printJob'
import { claimJob, fetchMenuRoutes, fetchPrintJobs, fetchRoutes, finishJob, insertTestPrint, requeueJob, type PrintJobRow } from './posApi'
import { usePosRealtime } from './usePosRealtime'
import { classifyJobs, formatAge, routesWithoutPrinter, type PrintProblem } from './printProblems'

const STUCK_MS = 2 * 60_000
const WAIT_MS = 45_000

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export default function PrintHostPanel({ branchId }: { branchId: string }) {
  const [routes, setRoutes] = useState<PrintRoute[]>([])
  const [problems, setProblems] = useState<PrintProblem[]>([])
  const [missing, setMissing] = useState<string[]>([])
  const [note, setNote] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const sweeping = useRef(false)
  const routesRef = useRef<PrintRoute[]>([])
  routesRef.current = routes

  useEffect(() => {
    Promise.all([fetchRoutes(branchId), fetchMenuRoutes()]).then(([r, m]) => {
      setRoutes(r)
      setMissing(routesWithoutPrinter(m, r.map((x) => x.route)))
    }, (e) => setNote(msg(e)))
  }, [branchId])

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
      setProblems(classifyJobs(jobs, now, STUCK_MS, WAIT_MS))
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

  // A waiting ticket nobody needs any more (e.g. an old one the agent skipped): close it as
  // failed with a reason, so it leaves the list and can still be reprinted on purpose.
  const dismiss = async (job: PrintJobRow) => {
    try {
      if (!(await claimJob(job.id))) { setNote(`${job.route}: that ticket is printing right now`); return }
      await finishJob(job.id, false, 'Marked not needed — not printed')
      await sweep()
    } catch (e) { setNote(`Could not clear the ticket — ${msg(e)}`) }
  }

  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)}
        className={`rounded px-3 py-1 text-xs ${problems.length ? 'bg-red-600 text-white' : 'border border-border'}`}>
        Printers{problems.length ? ` · ${problems.length} problem${problems.length === 1 ? '' : 's'}` : ''}
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
          {missing.length > 0 && <p className="mb-2 text-xs text-amber-700">No printer set for route(s): {missing.join(', ')} — set them in Tables &amp; printers.</p>}
          {problems.length === 0 && <p className="text-xs text-brown-muted">All tickets printed.</p>}
          {problems.map(({ job: j, kind, ageMs }) => (
            <div key={j.id} className="mb-2 rounded bg-red-50 p-2">
              <div className="font-medium">{j.route} · {jobLabel(j.payload)}</div>
              {kind === 'waiting' ? (
                <>
                  <div className="text-xs text-red-700">Waiting — no printer is picking this up (route {j.route}). Is the print agent running? · {formatAge(ageMs)}</div>
                  <button onClick={() => void dismiss(j)} className="mt-1 rounded border border-border px-2 py-1 text-xs">Not needed</button>
                </>
              ) : (
                <>
                  <div className="text-xs text-red-700">{kind === 'stuck' ? 'Stuck while printing — check the printer before reprinting' : j.last_error ?? 'Failed'} · {j.attempts} attempt{j.attempts === 1 ? '' : 's'}</div>
                  <button onClick={() => void reprint(j)} className="mt-1 rounded bg-brown-btn px-2 py-1 text-xs text-white">Reprint</button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
