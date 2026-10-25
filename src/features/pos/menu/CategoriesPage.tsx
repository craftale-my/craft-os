// src/features/pos/menu/CategoriesPage.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchLookups, reorderCategories, saveCategory, setCategoryActive, type LookupCategory } from './menuEditorApi'
import { listNameProblem, reorderedIds } from './listAdmin'
import { cleanName } from './menuForms'
import { OutcomeLine, PageHeader, btnCls, errorText, inputCls, linkBtnCls, type Outcome } from './editorUi'

/** /menu/categories — create, rename, reorder (the order of the pad and QR) and switch
 *  categories on or off. Each action shows its outcome on its own row; one runs at a time.
 *  While the list is not loaded (or a reload after a save failed) every write is locked:
 *  a stale list must never be written. */
export default function CategoriesPage() {
  const [categories, setCategories] = useState<LookupCategory[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)                                           // a second click in the same render is refused too
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({})          // by category id; 'new' for the create form

  // Only a successful and current load sets state; a failed load that is no longer current says nothing.
  const loadSeq = useRef(0)                                               // an older reply never lands last
  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    try {
      const l = await fetchLookups()
      if (seq !== loadSeq.current) return
      setCategories(l.categories)
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

  const locked = busy || loadError !== null || categories === null

  const run = async (key: string, action: () => Promise<unknown>, ok: string) => {
    if (busyRef.current || locked) return
    busyRef.current = true
    setBusy(true)
    setOutcomes((o) => { const n = { ...o }; delete n[key]; return n })
    try {
      await action()
      setRenaming((r) => (r?.id === key ? null : r))                      // only the row being edited closes its editor
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
  const fail = (key: string, text: string) => setOutcomes((o) => ({ ...o, [key]: { kind: 'error', text } }))

  const create = () => {
    if (locked) return
    const problem = listNameProblem('Category', newName, categories ?? [], null)
    if (problem) return fail('new', problem)
    void run('new', async () => { await saveCategory(null, cleanName(newName)); setNewName('') }, 'Category created')
  }
  const rename = (c: LookupCategory) => {
    if (!renaming || locked) return
    const problem = listNameProblem('Category', renaming.name, categories ?? [], c.id)
    if (problem) return fail(c.id, problem)
    void run(c.id, () => saveCategory(c.id, cleanName(renaming.name)), 'Renamed')
  }
  const move = (index: number, delta: number) => {
    const ids = categories && reorderedIds(categories, index, delta)
    if (ids) void run(ids[index + delta], () => reorderCategories(ids), 'Moved')
  }
  const toggle = (c: LookupCategory) => {
    if (c.isActive && c.productCount > 0
        && !window.confirm(`${c.productCount} products in ${c.name} leave the counter and the QR menu until you switch it back on.`)) return
    void run(c.id, () => setCategoryActive(c.id, !c.isActive), c.isActive ? 'Switched off' : 'Switched on')
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <PageHeader title="Categories" count={categories?.length} hint="The order here is the order of the counter and the QR menu." />
      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" disabled={busy} onClick={retry}>Try again</button>
        </div>
      )}
      <div className="space-y-2 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <input className={`${inputCls} w-64`} placeholder="New category name" aria-label="New category name" value={newName} readOnly={locked}
            onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
          <button className={btnCls} disabled={locked} onClick={create}>Create category</button>
        </div>
        <OutcomeLine outcome={outcomes.new ?? null} />
      </div>
      {categories === null && !loadError && <p className="text-sm">Loading…</p>}
      <ul className="space-y-2">
        {categories?.map((c, i) => (
          <li key={c.id} className={`space-y-2 rounded-xl border border-border bg-card p-3 ${c.isActive ? '' : 'text-brown-faint'}`}>
            <div className="flex flex-wrap items-center gap-2">
              {renaming?.id === c.id ? (
                <>
                  <input className={`${inputCls} w-64`} value={renaming.name} autoFocus readOnly={locked} aria-label={`New name for ${c.name}`}
                    onChange={(e) => setRenaming({ id: c.id, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && rename(c)} />
                  <button className={btnCls} disabled={locked} onClick={() => rename(c)}>Save name</button>
                  <button className="text-sm underline" disabled={busy} onClick={() => setRenaming(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <span className="flex-1">
                    <span className="font-medium">{c.name}</span>{c.isActive ? '' : ' (off)'}
                    <span className="ml-2 text-xs text-brown-muted">{c.productCount} product{c.productCount === 1 ? '' : 's'}</span>
                  </span>
                  <button className={linkBtnCls} disabled={locked} onClick={() => setRenaming({ id: c.id, name: c.name })}>Rename</button>
                  <button className={linkBtnCls} disabled={locked || i === 0} aria-label="Move up" onClick={() => move(i, -1)}>↑</button>
                  <button className={linkBtnCls} disabled={locked || i === categories.length - 1} aria-label="Move down" onClick={() => move(i, 1)}>↓</button>
                  <button className={linkBtnCls} disabled={locked} onClick={() => toggle(c)}>{c.isActive ? 'Switch off' : 'Switch on'}</button>
                </>
              )}
            </div>
            <OutcomeLine outcome={outcomes[c.id] ?? null} />
          </li>
        ))}
      </ul>
    </div>
  )
}
