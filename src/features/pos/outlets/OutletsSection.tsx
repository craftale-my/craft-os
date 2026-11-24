import { useRef, useState } from 'react'
import {
  OUTLET_KINDS, billNoExample, draftFromOutlet, mytDay, outletDates, outletNote, parseOutletDraft,
  type Outlet, type OutletDraft, type OutletKind,
} from './outlet'
import { saveOutlet } from './outletsApi'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const box = 'rounded-xl border border-border bg-card p-4'
const input = 'rounded border border-border p-1'
const kindLabel = (k: OutletKind) => OUTLET_KINDS.find((x) => x.kind === k)?.label ?? k

/** POS settings → Outlets: every outlet in the caller's scope. HQ (all_branches) adds outlets
 *  and sets their kind, a pop-up's days and the bill prefix (save_outlet). */
export default function OutletsSection({ outlets, isHq, onSaved }: {
  outlets: Outlet[]; isHq: boolean; onSaved: (id: string) => Promise<void>
}) {
  const [draft, setDraft] = useState<OutletDraft | null>(null)
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const today = mytDay(new Date())

  const edit = (o: Outlet | null) => { setDraft(draftFromOutlet(o)); setOutcome(null) }
  const change = (d: OutletDraft) => { setDraft(d); setOutcome(null) }
  const save = async () => {
    if (!draft || running.current) return
    const parsed = parseOutletDraft(draft)
    if (!parsed.ok) { setOutcome({ ok: false, text: parsed.problem }); return }
    running.current = true; setBusy(true); setOutcome(null)
    try {
      const id = await saveOutlet(parsed.value)
      setDraft(null)
      setOutcome({ ok: true, text: `${parsed.value.name} saved` })
      await onSaved(id)
    } catch (e) { setOutcome({ ok: false, text: msg(e) }) } finally { running.current = false; setBusy(false) }
  }

  return (
    <section className={box}>
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Outlets</h2>
        {isHq && !draft && <button onClick={() => edit(null)} className="rounded bg-brown-btn px-3 py-1 text-sm text-white">Add outlet</button>}
      </div>
      <p className="text-xs text-brown-muted">
        A branch, a kiosk (a small stall with its own staff and cash drawer) or a pop-up (open between its first and last day).
        Each outlet keeps its own tables, printers, catalogs, payment methods, shifts and reports.{isHq ? '' : ' Only HQ adds outlets or changes their kind, days and bill prefix.'}
      </p>
      <table className="mt-3 w-full text-sm">
        <thead><tr className="text-left text-xs text-brown-muted"><th>Outlet</th><th>Kind</th><th>Days</th><th>Bill numbers</th><th></th></tr></thead>
        <tbody>
          {outlets.map((o) => {
            const note = outletNote(o, today)
            return (
              <tr key={o.id} className="border-t border-border">
                <td className="py-2 font-medium">{o.name}{o.isHome && <span className="ml-2 text-xs text-brown-muted">home</span>}</td>
                <td>{kindLabel(o.kind)}</td>
                <td>{outletDates(o)}{note && <span className="ml-2 text-xs text-amber-700">{note}</span>}</td>
                <td className="font-mono text-xs">{billNoExample(o.billPrefix, new Date())}</td>
                <td className="text-right">{isHq && <button onClick={() => edit(o)} className="text-xs underline">Edit</button>}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {draft && <OutletForm draft={draft} busy={busy} onChange={change} onSave={() => void save()} onCancel={() => { setDraft(null); setOutcome(null) }} />}
      {outcome && (outcome.ok
        ? <p role="status" className="mt-3 rounded bg-green-50 p-3 text-sm text-green-800">{outcome.text}</p>
        : <p role="alert" className="mt-3 rounded bg-red-50 p-3 text-sm text-red-700">{outcome.text}</p>)}
    </section>
  )
}

function OutletForm({ draft, busy, onChange, onSave, onCancel }: {
  draft: OutletDraft; busy: boolean; onChange: (d: OutletDraft) => void; onSave: () => void; onCancel: () => void
}) {
  const prefix = draft.billPrefix.trim().toUpperCase() || null
  return (
    <div className="mt-3 space-y-2 rounded border border-border p-3 text-sm">
      <div className="font-medium">{draft.id ? 'Edit outlet' : 'New outlet'}</div>
      <label className="block">Name
        <input className={`${input} ml-2 w-64`} value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} />
      </label>
      <label className="block">Kind
        <select className={`${input} ml-2`} value={draft.kind} onChange={(e) => onChange({ ...draft, kind: e.target.value as OutletKind })}>
          {OUTLET_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
        </select>
      </label>
      {draft.kind === 'popup' && (
        <div className="flex gap-4">
          <label>First day<input type="date" className={`${input} ml-2`} value={draft.opensOn} onChange={(e) => onChange({ ...draft, opensOn: e.target.value })} /></label>
          <label>Last day<input type="date" className={`${input} ml-2`} value={draft.closesOn} onChange={(e) => onChange({ ...draft, closesOn: e.target.value })} /></label>
        </div>
      )}
      <label className="block">Bill prefix
        <input className={`${input} ml-2 w-20 uppercase`} maxLength={4} value={draft.billPrefix} onChange={(e) => onChange({ ...draft, billPrefix: e.target.value })} />
        <span className="ml-2 text-xs text-brown-muted">Optional, 1–4 letters or digits. Bills read {billNoExample(prefix, new Date())}.</span>
      </label>
      <div className="flex gap-2">
        <button disabled={busy} onClick={onSave} className="rounded bg-brown-btn px-3 py-1 text-white disabled:opacity-50">{busy ? 'Saving…' : 'Save outlet'}</button>
        <button disabled={busy} onClick={onCancel} className="rounded border border-border px-3 py-1">Cancel</button>
      </div>
    </div>
  )
}
