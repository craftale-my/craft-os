// src/features/pos/menu/GroupEditorPage.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { fetchGroupDetail, fetchLookups, saveGroup, type GroupDetail, type MenuLookups } from './menuEditorApi'
import { emptyGroupForm, groupFormDirty, groupFormFromDetail, groupPayload, groupProblems, type GroupForm, type GroupSection } from './groupForm'
import OptionsSection from './group/OptionsSection'
import { OutcomeLine, PageHeader, Section, btnCls, errorText, inputCls, useSavedNotice, useUnsavedWarning, type Outcome } from './editorUi'

/** /menu/groups/new and /menu/groups/:id. Saved at once by menu_save_group. */
export default function GroupEditorPage({ groupId }: { groupId: string | null }) {
  const navigate = useNavigate()
  const savedNotice = useSavedNotice()
  const [lookups, setLookups] = useState<MenuLookups | null>(null)
  const [form, setForm] = useState<GroupForm | null>(null)
  const [loaded, setLoaded] = useState<GroupForm | null>(null)
  const [usedBy, setUsedBy] = useState<GroupDetail['usedBy']>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [tried, setTried] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(savedNotice ? { kind: 'ok', text: savedNotice } : null)
  const loadSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    const [l, d] = await Promise.all([fetchLookups(), groupId ? fetchGroupDetail(groupId) : Promise.resolve(null)])
    if (seq !== loadSeq.current) return
    setLookups(l)
    setUsedBy(d?.usedBy ?? [])
    const f = d ? groupFormFromDetail(d) : emptyGroupForm()
    setForm(f)
    setLoaded(f)
    setLoadError(null)
  }, [groupId])
  useEffect(() => { load().catch((e) => setLoadError(errorText(e))) }, [load])

  /** Reload after a failure; a "Saved, but reloading failed" notice becomes plain "Saved". */
  const retryLoad = () => {
    load()
      .then(() => setOutcome((o) => (o?.kind === 'error' && o.text.startsWith('Saved, but') ? { kind: 'ok', text: 'Saved' } : o)))
      .catch((e) => setLoadError(errorText(e)))
  }

  const change = (next: GroupForm) => { setForm(next); setOutcome(null) }
  const catalogName = (id: string) => lookups?.catalogs.find((c) => c.id === id)?.name ?? 'A catalog'
  const problems = form ? groupProblems(form, catalogName) : []
  useUnsavedWarning(!!form && !saving && groupFormDirty(form, loaded))
  const problemOf = (s: GroupSection) => (tried ? problems.find((p) => p.section === s)?.message ?? null : null)

  const save = async () => {
    if (!form || saving || loadError) return
    setTried(true)
    if (problems.length > 0) { setOutcome({ kind: 'error', text: 'Not saved — fix the problems marked above.' }); return }
    setSaving(true)
    setOutcome(null)
    try {
      const id = await saveGroup(groupPayload(form))
      if (!form.id) {
        navigate(`/menu/groups/${id}`, { replace: true, state: { saved: 'Add-on group created' } })
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
      setSaving(false)
    }
  }

  const set = (patch: Partial<GroupForm>) => form && change({ ...form, ...patch })
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <PageHeader title={groupId ? form?.name || 'Add-on group' : 'New add-on group'}>
        <Link to="/menu/groups" className="text-sm underline">Back to add-on groups</Link>
      </PageHeader>
      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" disabled={saving} onClick={() => retryLoad()}>Try again</button>
        </div>
      )}
      {!form || !lookups ? (!loadError && <p className="text-sm">Loading…</p>) : (
        <>
          {/* Locked while saving (the reload would overwrite typing) and while the form is stale after a failed reload. */}
          <fieldset disabled={saving || !!loadError} className="m-0 min-w-0 space-y-4 border-0 p-0">
            <Section title="Group" problem={problemOf('details')}
              hint={usedBy.length === 0 ? 'No product uses this group yet — add it in a product’s editor.'
                : `Used by ${usedBy.length} product${usedBy.length === 1 ? '' : 's'}: ${usedBy.slice(0, 8).map((p) => p.name).join(', ')}${usedBy.length > 8 ? ', …' : ''}`}>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="block text-sm sm:col-span-3">Name
                  <input className={`${inputCls} mt-1 w-full`} value={form.name} onChange={(e) => set({ name: e.target.value })} />
                </label>
                <label className="block text-sm">Choose at least
                  <input className={`${inputCls} mt-1 w-full`} inputMode="numeric" value={form.min} onChange={(e) => set({ min: e.target.value })} />
                </label>
                <label className="block text-sm">Choose at most
                  <input className={`${inputCls} mt-1 w-full`} inputMode="numeric" value={form.max} onChange={(e) => set({ max: e.target.value })} />
                </label>
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={form.isActive} onChange={(e) => set({ isActive: e.target.checked })} />
                  On (a switched-off group is left off every product)
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={form.stackable} onChange={(e) => set({ stackable: e.target.checked })} />
                  Stackable (kept from Feedme; the counter does not use it yet)
                </label>
              </div>
            </Section>
            <OptionsSection form={form} onChange={change} addOns={lookups.addOns} catalogs={lookups.catalogs} problem={problemOf('options')} />
          </fieldset>
          <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-border bg-cream py-3">
            <button className={btnCls} disabled={saving || !!loadError} onClick={() => void save()}>
              {saving ? 'Saving…' : form.id ? 'Save add-on group' : 'Create add-on group'}
            </button>
            <OutcomeLine outcome={outcome} />
          </div>
        </>
      )}
    </div>
  )
}
