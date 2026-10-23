// src/features/pos/menu/ScheduleEditorPage.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { fetchMenu, type MenuProductRow } from './menuApi'
import { fetchScheduleDetail, fetchSchedules, saveSchedule, type ScheduleSummary } from './slotsApi'
import {
  emptyScheduleForm, scheduleFormDirty, scheduleFormFromDetail, schedulePayload, scheduleProblems, type ScheduleForm, type ScheduleSection,
} from './scheduleForm'
import MenuTabs from './MenuTabs'
import WindowsSection from './schedule/WindowsSection'
import ProductsSection from './schedule/ProductsSection'
import { OutcomeLine, Section, btnCls, errorText, inputCls, useSavedNotice, useUnsavedWarning, type Outcome } from './editorUi'

/** /menu/schedules/new and /menu/schedules/:id — a named schedule (Feedme's Scheduler):
 *  its time windows and the products that follow it, saved at once by menu_save_schedule.
 *  The route remounts this page per schedule (MenuRoutes keys it). */
export default function ScheduleEditorPage({ scheduleId }: { scheduleId: string | null }) {
  const navigate = useNavigate()
  const savedNotice = useSavedNotice()
  const [others, setOthers] = useState<ScheduleSummary[]>([])
  const [products, setProducts] = useState<MenuProductRow[] | null>(null)
  const [form, setForm] = useState<ScheduleForm | null>(null)
  const [loaded, setLoaded] = useState<ScheduleForm | null>(null)    // the form as loaded: a save sends only changes
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)                                    // a second click in the same render is refused too
  const [tried, setTried] = useState(false)                          // problems show after the first Save
  const [outcome, setOutcome] = useState<Outcome | null>(savedNotice ? { kind: 'ok', text: savedNotice } : null)
  const loadSeq = useRef(0)

  /** Loads the schedules (for the twin-name check), the products and this schedule; a reply to an older load is dropped. */
  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    const [list, rows, d] = await Promise.all([
      fetchSchedules(), fetchMenu(), scheduleId ? fetchScheduleDetail(scheduleId) : Promise.resolve(null),
    ])
    if (seq !== loadSeq.current) return
    setOthers(list)
    setProducts(rows)
    const f = d ? scheduleFormFromDetail(d) : emptyScheduleForm()
    setForm(f)
    setLoaded(d ? f : null)
    setLoadError(null)
  }, [scheduleId])
  useEffect(() => { load().catch((e) => setLoadError(errorText(e))) }, [load])

  /** Reload after a failure; a "Saved, but reloading failed" notice becomes plain "Saved". */
  const retryLoad = () => {
    load()
      .then(() => setOutcome((o) => (o?.kind === 'error' && o.text.startsWith('Saved, but') ? { kind: 'ok', text: 'Saved' } : o)))
      .catch((e) => setLoadError(errorText(e)))
  }

  const change = (next: ScheduleForm) => { setForm(next); setOutcome(null) }
  const problems = form ? scheduleProblems(form, others) : []
  useUnsavedWarning(!!form && !saving && scheduleFormDirty(form, loaded) && (loaded !== null || form.name.trim() !== ''))
  const problemOf = (s: ScheduleSection) => (tried ? problems.find((p) => p.section === s)?.message ?? null : null)

  const save = async () => {
    if (!form || savingRef.current || loadError) return
    setTried(true)
    if (problems.length > 0) { setOutcome({ kind: 'error', text: 'Not saved — fix the problems marked above.' }); return }
    savingRef.current = true
    setSaving(true)
    setOutcome(null)
    try {
      const id = await saveSchedule(schedulePayload(form, loaded))
      if (!form.id) {
        navigate(`/menu/schedules/${id}`, { replace: true, state: { saved: 'Schedule created' } })
        return
      }
      try {
        await load()
        setTried(false)
        setOutcome({ kind: 'ok', text: 'Saved' })
      } catch (e) {
        // The form on screen is now stale: lock it until a fresh load succeeds.
        setLoadError(errorText(e))
        setOutcome({ kind: 'error', text: 'Saved, but reloading failed — reload before editing again.' })
      }
    } catch (e) {
      setOutcome({ kind: 'error', text: errorText(e) })
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const set = (patch: Partial<ScheduleForm>) => form && change({ ...form, ...patch })
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <MenuTabs />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">{scheduleId ? form?.name || 'Schedule' : 'New schedule'}</h1>
        <Link to="/menu/schedules" className="text-sm underline">Back to schedules</Link>
      </div>
      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" disabled={saving} onClick={() => retryLoad()}>Try again</button>
        </div>
      )}
      {!form || !products ? (!loadError && <p className="text-sm">Loading…</p>) : (
        <>
          {/* Locked while saving (the reload would overwrite typing) and while the form is stale after a failed reload. */}
          <fieldset disabled={saving || !!loadError} className="m-0 min-w-0 space-y-4 border-0 p-0">
            <Section title="Schedule" problem={problemOf('details')}
              hint="Like Feedme's Scheduler: one schedule (e.g. Breakfast) can be ticked on many products. Delete it on the Schedules page.">
              <label className="block text-sm">Name
                <input className={`${inputCls} mt-1 w-full`} value={form.name} aria-label="Schedule name"
                  onChange={(e) => set({ name: e.target.value })} />
              </label>
            </Section>
            <WindowsSection form={form} onChange={change} problem={problemOf('windows')} />
            <ProductsSection form={form} onChange={change} products={products} />
          </fieldset>
          <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-border bg-cream py-3">
            <button className={btnCls} disabled={saving || !!loadError} onClick={() => void save()}>
              {saving ? 'Saving…' : form.id ? 'Save schedule' : 'Create schedule'}
            </button>
            <OutcomeLine outcome={outcome} />
          </div>
        </>
      )}
    </div>
  )
}
