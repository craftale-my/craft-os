// src/features/pos/menu/product/TimeSlotsSection.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchProductExtras, fetchSchedules, setProductSchedules, type ScheduleSummary } from '../slotsApi'
import { windowLabel } from '../timeSlots'
import { OutcomeLine, Section, btnCls, errorText, useUnsavedWarning, type Outcome } from '../editorUi'

const MAX_SCHEDULES = 20

/** Which schedules a saved product follows (Feedme's Scheduler, ticked from the product's
 *  side). Saved on its own by menu_set_product_schedules, with its outcome here. */
export default function TimeSlotsSection({ productId }: { productId: string }) {
  const [schedules, setSchedules] = useState<ScheduleSummary[] | null>(null)
  const [ticked, setTicked] = useState<string[]>([])
  const [loaded, setLoaded] = useState<string[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)                                  // a second click in the same render is refused too
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const loadSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeq.current                                  // a reply to an older load is dropped
    const [list, extras] = await Promise.all([fetchSchedules(), fetchProductExtras(productId)])
    if (seq !== loadSeq.current) return
    setSchedules(list)
    setTicked([...extras.scheduleIds].sort())
    setLoaded([...extras.scheduleIds].sort())
    setLoadError(null)
  }, [productId])
  useEffect(() => { load().catch((e) => setLoadError(errorText(e))) }, [load])

  const dirty = ticked.join() !== loaded.join()
  useUnsavedWarning(dirty && !saving)
  const tick = (id: string, on: boolean) => {
    setTicked((t) => (on ? [...t.filter((x) => x !== id), id].sort() : t.filter((x) => x !== id)))
    setOutcome(null)
  }

  const save = async () => {
    if (savingRef.current || loadError || !dirty) return
    if (ticked.length > MAX_SCHEDULES) { setOutcome({ kind: 'error', text: `Too many schedules (at most ${MAX_SCHEDULES})` }); return }
    savingRef.current = true
    setSaving(true)
    setOutcome(null)
    try {
      await setProductSchedules(productId, ticked)
      try {
        await load()
        setOutcome({ kind: 'ok', text: 'Time slots saved' })
      } catch (e) {
        setLoadError(errorText(e))                                 // locks the ticks until a reload works
        setOutcome({ kind: 'error', text: 'Saved, but reloading failed — try again before changing more.' })
      }
    } catch (e) {
      setOutcome({ kind: 'error', text: errorText(e) })
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const shown = schedules ?? []
  return (
    <Section title="Time slots"
      hint="Tick the schedules this product follows: it sells only inside their windows (hidden on QR, greyed out at the counter outside them). None ticked = sold at any time.">
      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" disabled={saving} onClick={() => { load().catch((e) => setLoadError(errorText(e))) }}>Try again</button>
        </div>
      )}
      {schedules === null && !loadError && <p className="text-sm">Loading…</p>}
      {schedules !== null && shown.length === 0 && (
        <p className="text-sm text-brown-muted">No schedules yet — <Link to="/menu/schedules/new" className="underline">create one</Link>.</p>
      )}
      <fieldset disabled={saving || !!loadError} className="m-0 min-w-0 space-y-1 border-0 p-0">
        {shown.map((s) => (
          <label key={s.id} className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={ticked.includes(s.id)} onChange={(e) => tick(s.id, e.target.checked)} />
            <span>
              <Link to={`/menu/schedules/${s.id}`} className="hover:underline">{s.name}</Link>
              <span className="block text-xs text-brown-muted">{s.windows.map(windowLabel).join('; ')}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <button className={btnCls} disabled={saving || !!loadError || !dirty} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save time slots'}
        </button>
        <OutcomeLine outcome={outcome} />
      </div>
    </Section>
  )
}
