import { useEffect, useRef, useState } from 'react'
import { OUTLET_KINDS, type Outlet } from './outlet'
import { fetchMyOutlets, fetchStaffOutlets, setStaffOutlet } from './outletsApi'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Staff profile → POS outlets: the outlets this person may also work at, besides their home
 *  branch. A manager (access_settings) ticks the outlets of their own scope (set_staff_outlet). */
export function ExtraOutletsCard({ staffId, homeBranchId }: { staffId: string; homeBranchId: string | null }) {
  const [outlets, setOutlets] = useState<Outlet[] | null>(null)       // null while loading or after a failed load
  const [extra, setExtra] = useState<Set<string>>(new Set())
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const running = useRef(false)
  const seq = useRef(0)

  useEffect(() => {
    const id = ++seq.current
    setOutlets(null); setOutcome(null)
    Promise.all([fetchMyOutlets(), fetchStaffOutlets(staffId)]).then(([o, s]) => {
      if (id !== seq.current) return
      setOutlets(o); setExtra(new Set(s))
    }, (e) => { if (id === seq.current) setOutcome({ ok: false, text: `Could not load the outlets: ${msg(e)}` }) })
  }, [staffId])

  const toggle = async (o: Outlet, on: boolean) => {
    if (running.current) return
    running.current = true; setBusyId(o.id); setOutcome(null)
    try {
      await setStaffOutlet(staffId, o.id, on)
      setExtra((prev) => { const next = new Set(prev); if (on) next.add(o.id); else next.delete(o.id); return next })
      setOutcome({ ok: true, text: on ? `May now work at ${o.name}` : `No longer works at ${o.name}` })
    } catch (e) { setOutcome({ ok: false, text: msg(e) }) } finally { running.current = false; setBusyId(null) }
  }

  const choices = (outlets ?? []).filter((o) => o.id !== homeBranchId)
  return (
    <div className="bg-white rounded-xl shadow-card p-5">
      <p className="text-xs font-semibold text-brown-muted uppercase tracking-widest mb-1">POS outlets</p>
      <p className="text-xs text-brown-faint mb-3">Besides their home branch, the outlets where this person may sign in to the POS (with the "Sign in to the POS" permission).</p>
      {outlets && choices.length === 0 && <p className="text-sm text-brown-muted">No other outlets in your scope.</p>}
      {choices.map((o) => (
        <label key={o.id} className="flex items-center gap-2 py-1 text-sm">
          <input type="checkbox" checked={extra.has(o.id)} disabled={outlets === null || busyId !== null}
            onChange={(e) => void toggle(o, e.target.checked)} />
          <span>{o.name}</span>
          <span className="text-xs text-brown-faint">{OUTLET_KINDS.find((k) => k.kind === o.kind)?.label}</span>
          {busyId === o.id && <span className="text-xs text-brown-faint">Saving…</span>}
        </label>
      ))}
      {outcome && <p role={outcome.ok ? 'status' : 'alert'} className={`mt-2 text-xs ${outcome.ok ? 'text-[#3D7A50]' : 'text-red-700'}`}>{outcome.text}</p>}
    </div>
  )
}
