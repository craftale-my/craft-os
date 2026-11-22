import { runSummary, type JobRun } from './einvoice'

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-MY', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kuala_Lumpur' })

/** The last daily runs (spec W5.4, W5.7). */
export function EinvoiceJobRuns({ runs }: { runs: JobRun[] }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="font-semibold">Daily run</h2>
      <p className="text-xs text-brown-muted">
        Every day at 07:00: checks documents waiting for LHDN, sends last month's consolidated e-invoice from the 1st to the 7th,
        and issues credit notes for refunds.
      </p>
      {runs.length === 0 ? (
        <p className="mt-2 text-sm text-brown-muted">No runs yet.</p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm">
          {runs.map((r) => (
            <li key={r.id} className="flex gap-3">
              <span className="w-32 shrink-0 text-brown-muted">{when(r.started_at)}</span>
              <span className={r.outcome === 'errors' ? 'text-red-700' : r.outcome === 'not_set_up' ? 'text-amber-800' : ''}>
                {runSummary(r)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
