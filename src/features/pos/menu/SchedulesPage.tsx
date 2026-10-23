// src/features/pos/menu/SchedulesPage.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { deleteSchedule, fetchSchedules, reorderSchedules, type ScheduleSummary } from './slotsApi'
import { reorderedIds } from './listAdmin'
import { windowLabel } from './timeSlots'
import MenuTabs from './MenuTabs'
import { OutcomeLine, btnCls, errorText, linkBtnCls, type Outcome } from './editorUi'

/** /menu/schedules — Feedme's Scheduler: named time slots, each ticked on the products that
 *  follow it. Reorder and delete here (each outcome on its own row — a delete's above the
 *  list — one action at a time); open a schedule to edit its windows and products. Like
 *  Feedme, a schedule has no on/off switch. While the list is not loaded (or a reload after a
 *  save failed) every write is locked: a stale list must never be written. */
export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<ScheduleSummary[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)                                           // a second click in the same render is refused too
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({})  // by schedule id; 'deleted' for a delete

  const loadSeq = useRef(0)                                               // an older reply never lands last
  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    try {
      const list = await fetchSchedules()
      if (seq !== loadSeq.current) return
      setSchedules(list)
      setLoadError(null)
    } catch (e) {
      if (seq !== loadSeq.current) return
      throw e
    }
  }, [])
  /** Try again: a successful reload turns a "Saved, but reloading failed" notice into plain "Saved". */
  const retry = () => load().then(
    () => setOutcomes((o) => Object.fromEntries(Object.entries(o).map(([k, v]) =>
      [k, v.kind === 'error' && v.text.startsWith('Saved, but reloading failed') ? { kind: 'ok' as const, text: 'Saved' } : v]))),
    (e) => setLoadError(errorText(e)),
  )
  useEffect(() => { load().catch((e) => setLoadError(errorText(e))) }, [load])

  const locked = busy || loadError !== null || schedules === null

  const run = async (key: string, action: () => Promise<unknown>, ok: string) => {
    if (busyRef.current || locked) return
    busyRef.current = true
    setBusy(true)
    setOutcomes((o) => { const n = { ...o }; delete n[key]; return n })
    try {
      await action()
      try {
        await load()
        setOutcomes((o) => ({ ...o, [key]: { kind: 'ok', text: ok } }))
      } catch (e) {
        setLoadError(`Saved, but reloading failed: ${errorText(e)}`)       // locks every write until a reload works
        setOutcomes((o) => ({ ...o, [key]: { kind: 'error', text: `Saved, but reloading failed: ${errorText(e)}` } }))
      }
    } catch (e) {
      setOutcomes((o) => ({ ...o, [key]: { kind: 'error', text: errorText(e) } }))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const move = (index: number, delta: number) => {
    const ids = schedules && reorderedIds(schedules, index, delta)
    if (ids) void run(ids[index + delta], () => reorderSchedules(ids), 'Moved')
  }
  /** Feedme's Delete: the schedule, its windows and its product links go (no order refers to them). */
  const remove = (s: ScheduleSummary) => {
    const follow = s.productCount === 0 ? 'No product follows it.'
      : `${s.productCount} product${s.productCount === 1 ? ' follows' : 's follow'} it and then sell${s.productCount === 1 ? 's' : ''} at any time, unless another schedule says otherwise.`
    if (!window.confirm(`Delete ${s.name}? ${follow} This cannot be undone.`)) return
    void run('deleted', () => deleteSchedule(s.id), `Deleted ${s.name}`)
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <MenuTabs />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Schedules</h1>
          <p className="text-sm text-brown-muted">
            A product that follows a schedule sells only inside its time windows: hidden on QR and greyed out at the counter
            outside them. A product that follows none sells at any time.
          </p>
        </div>
        <Link to="/menu/schedules/new" className={btnCls}>New schedule</Link>
      </div>
      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" disabled={busy} onClick={retry}>Try again</button>
        </div>
      )}
      <OutcomeLine outcome={outcomes.deleted ?? null} />
      {schedules === null && !loadError && <p className="text-sm">Loading…</p>}
      {schedules?.length === 0 && <p className="text-sm text-brown-muted">No schedules yet.</p>}
      <ul className="space-y-2">
        {schedules?.map((s, i) => (
          <li key={s.id} className="space-y-2 rounded-xl border border-border bg-card p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex-1">
                <Link to={`/menu/schedules/${s.id}`} className="font-medium hover:underline">{s.name}</Link>
                <span className="ml-2 text-xs text-brown-muted">{s.productCount} product{s.productCount === 1 ? '' : 's'}</span>
                <span className="block text-xs text-brown-muted">{s.windows.map(windowLabel).join('; ')}</span>
              </span>
              <button className={linkBtnCls} disabled={locked || i === 0} aria-label={`Move ${s.name} up`} onClick={() => move(i, -1)}>↑</button>
              <button className={linkBtnCls} disabled={locked || i === schedules.length - 1} aria-label={`Move ${s.name} down`}
                onClick={() => move(i, 1)}>↓</button>
              <button className={linkBtnCls} disabled={locked} aria-label={`Delete ${s.name}`} onClick={() => remove(s)}>Delete</button>
            </div>
            <OutcomeLine outcome={outcomes[s.id] ?? null} />
          </li>
        ))}
      </ul>
    </div>
  )
}
