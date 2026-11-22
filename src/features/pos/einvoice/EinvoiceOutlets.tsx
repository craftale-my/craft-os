import { useEffect, useState } from 'react'
import { hasLiveDocument, startDateProblem, type EinvoiceDoc } from './einvoice'
import { fetchOutlets, setOutletStart, type OutletRow } from './einvoiceApi'

/** Per outlet: the first business day this POS reports e-invoices for (spec W5.3). Empty = Feedme still does. */
export function EinvoiceOutlets({ docs }: { docs: EinvoiceDoc[] }) {
  const [outlets, setOutlets] = useState<OutletRow[]>([])
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = async () => {
    try {
      const rows = await fetchOutlets()
      setOutlets(rows)
      setDraft(Object.fromEntries(rows.map((o) => [o.id, o.einvoice_from ?? ''])))
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }
  useEffect(() => { void load() }, [])

  const save = async (o: OutletRow) => {
    const next = draft[o.id] ?? ''
    setSaved(null)
    const problem = startDateProblem(next, o.einvoice_from, hasLiveDocument(docs, o.id))
    if (problem) { setErrors({ ...errors, [o.id]: problem }); return }
    try {
      await setOutletStart(o.id, next || null)
      setErrors({ ...errors, [o.id]: '' })
      setSaved(o.id)
      await load()
    } catch (e) {
      setErrors({ ...errors, [o.id]: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="font-semibold">Report e-invoices from</h2>
      <p className="text-xs text-brown-muted">
        The first business day this POS reports for each outlet. Leave it empty while Feedme still reports the outlet.
        Once e-invoices are sent, the date can only move later.
      </p>
      {loadError && <p className="mt-2 text-sm text-red-700">{loadError}</p>}
      <ul className="mt-2 divide-y divide-border text-sm">
        {outlets.map((o) => (
          <li key={o.id} className="flex flex-wrap items-center gap-3 py-2">
            <span className="min-w-[10rem] font-medium">{o.name}</span>
            <input type="date" aria-label={`Report e-invoices from, ${o.name}`} value={draft[o.id] ?? ''}
              onChange={(e) => setDraft({ ...draft, [o.id]: e.target.value })}
              className="rounded border border-border p-1" />
            <button onClick={() => void save(o)} disabled={(draft[o.id] ?? '') === (o.einvoice_from ?? '')}
              className="rounded bg-brown-btn px-3 py-1 text-xs text-white hover:bg-brown-btn-hover disabled:opacity-50">
              Save
            </button>
            {!o.einvoice_from && <span className="text-xs text-brown-muted">Not reported by us</span>}
            {saved === o.id && <span className="text-xs text-green-700">Saved</span>}
            {errors[o.id] && <span className="w-full text-xs text-red-700">{errors[o.id]}</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}
