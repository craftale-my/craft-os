// src/features/pos/menu/CatalogsPage.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  duplicateCatalog, fetchLookups, reorderCatalogs, saveCatalog, setCatalogActive, type LookupCatalog,
} from './menuEditorApi'
import { catalogUseText, copyName, listNameProblem, reorderedIds } from './listAdmin'
import { cleanName } from './menuForms'
import MenuTabs from './MenuTabs'
import { OutcomeLine, btnCls, errorText, inputCls, linkBtnCls, type Outcome } from './editorUi'

type Editing = { id: string; mode: 'rename' | 'duplicate'; name: string } | null

/** /menu/catalogs — create, rename, duplicate, reorder and switch catalogs on or off.
 *  Each action shows its outcome on its own row; one action runs at a time. */
export default function CatalogsPage() {
  const [catalogs, setCatalogs] = useState<LookupCatalog[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [editing, setEditing] = useState<Editing>(null)
  const [busy, setBusy] = useState(false)
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({})          // by catalog id; 'new' for the create form

  const loadSeq = useRef(0)                                               // an older reply never lands last
  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    let l: Awaited<ReturnType<typeof fetchLookups>>
    try {
      l = await fetchLookups()
    } catch (e) {
      if (seq === loadSeq.current) throw e                                 // an older failing load says nothing
      return
    }
    if (seq !== loadSeq.current) return
    setCatalogs(l.catalogs)
    setLoadError(null)
  }, [])
  useEffect(() => { load().catch((e) => setLoadError(errorText(e))) }, [load])
  // While a load has failed the list on screen may be stale (e.g. after a saved action), so every write is locked.
  const locked = busy || !!loadError

  /** Try again: a successful reload turns a "Saved, but reloading failed" notice into plain "Saved". */
  const retry = () => load().then(
    () => setOutcomes((o) => Object.fromEntries(Object.entries(o).map(([k, v]) =>
      [k, v.kind === 'error' && v.text.startsWith('Saved, but reloading failed') ? { kind: 'ok' as const, text: 'Saved' } : v]))),
    (e) => setLoadError(errorText(e)),
  )

  /** Runs one action, then reloads; the outcome lands on `key`'s row. */
  const run = async (key: string, action: () => Promise<unknown>, ok: string) => {
    if (locked) return
    setBusy(true)
    setOutcomes((o) => { const n = { ...o }; delete n[key]; return n })
    try {
      await action()
      setEditing((cur) => (cur && cur.id === key ? null : cur))
      try {
        await load()
        setOutcomes((o) => ({ ...o, [key]: { kind: 'ok', text: ok } }))
      } catch (e) {
        // the list on screen is now stale: lock every write until a fresh load succeeds
        setLoadError(errorText(e))
        setOutcomes((o) => ({ ...o, [key]: { kind: 'error', text: `Saved, but reloading failed: ${errorText(e)}` } }))
      }
    } catch (e) {
      setOutcomes((o) => ({ ...o, [key]: { kind: 'error', text: errorText(e) } }))
    } finally {
      setBusy(false)
    }
  }
  const fail = (key: string, text: string) => setOutcomes((o) => ({ ...o, [key]: { kind: 'error', text } }))

  const create = () => {
    const problem = listNameProblem('Catalog', newName, catalogs ?? [], null)
    if (problem) return fail('new', problem)
    void run('new', async () => { await saveCatalog(null, cleanName(newName)); setNewName('') }, 'Catalog created — open it to choose its products and prices')
  }
  const confirmEdit = (c: LookupCatalog) => {
    if (!editing) return
    const problem = listNameProblem('Catalog', editing.name, catalogs ?? [], editing.mode === 'rename' ? c.id : null)
    if (problem) return fail(c.id, problem)
    if (editing.mode === 'rename') void run(c.id, () => saveCatalog(c.id, cleanName(editing.name)), 'Renamed')
    else void run(c.id, () => duplicateCatalog(c.id, cleanName(editing.name)), `Copied to ${cleanName(editing.name)}`)
  }
  const move = (index: number, delta: number) => {
    const ids = catalogs && reorderedIds(catalogs, index, delta)
    if (ids) void run(ids[index + delta], () => reorderCatalogs(ids), 'Moved')
  }
  // a catalog a branch prices dine-in, takeaway or QR orders from is refused by the server, in its words
  const toggle = (c: LookupCatalog) =>
    void run(c.id, () => setCatalogActive(c.id, !c.isActive), c.isActive ? 'Switched off' : 'Switched on')

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <MenuTabs />
      <div>
        <h1 className="text-2xl font-semibold">Catalogs</h1>
        <p className="text-sm text-brown-muted">
          A catalog picks products from the menu and sells them at its own prices. Which catalog a branch uses for each
          kind of order is set in POS settings.
        </p>
      </div>
      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" onClick={() => void retry()}>Try again</button>
        </div>
      )}
      <div className="space-y-2 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <input className={`${inputCls} w-64`} placeholder="New catalog name" value={newName} disabled={locked}
            onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
          <button className={btnCls} disabled={locked} onClick={create}>Create catalog</button>
        </div>
        <OutcomeLine outcome={outcomes.new ?? null} />
      </div>
      {catalogs === null && !loadError && <p className="text-sm">Loading…</p>}
      <ul className="space-y-2">
        {catalogs?.map((c, i) => (
          <li key={c.id} className={`space-y-2 rounded-xl border border-border bg-card p-3 ${c.isActive ? '' : 'text-brown-faint'}`}>
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1">
                <Link to={`/menu/catalogs/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
                {!c.isActive && <span className="ml-2 text-xs">(off)</span>}
                <div className="text-xs text-brown-muted">
                  {c.productCount} products · {catalogUseText(c.uses)}{c.feedmeName ? ` · Feedme: ${c.feedmeName}` : ''}
                </div>
                {c.unpricedCount > 0 && (
                  <Link to={`/menu/catalogs/${c.id}`} className="text-xs text-red-700 underline">
                    {c.unpricedCount} product{c.unpricedCount === 1 ? ' has' : 's have'} no price — open to fix
                  </Link>
                )}
              </div>
              <Link to={`/menu/catalogs/${c.id}`} className={linkBtnCls}>Products and prices</Link>
              <button className={linkBtnCls} disabled={locked} onClick={() => setEditing({ id: c.id, mode: 'rename', name: c.name })}>Rename</button>
              <button className={linkBtnCls} disabled={locked}
                onClick={() => setEditing({ id: c.id, mode: 'duplicate', name: copyName(c.name, catalogs) })}>Duplicate</button>
              <button className={linkBtnCls} disabled={locked || i === 0} aria-label="Move up" onClick={() => move(i, -1)}>↑</button>
              <button className={linkBtnCls} disabled={locked || i === catalogs.length - 1} aria-label="Move down" onClick={() => move(i, 1)}>↓</button>
              <button className={linkBtnCls} disabled={locked} onClick={() => toggle(c)}>{c.isActive ? 'Switch off' : 'Switch on'}</button>
            </div>
            {editing?.id === c.id && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm">{editing.mode === 'rename' ? 'New name' : 'Name of the copy'}</span>
                <input className={`${inputCls} w-64`} value={editing.name} autoFocus readOnly={locked}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  onKeyDown={(e) => e.key === 'Enter' && confirmEdit(c)} />
                <button className={btnCls} disabled={locked} onClick={() => confirmEdit(c)}>
                  {editing.mode === 'rename' ? 'Save name' : 'Duplicate with products and prices'}
                </button>
                <button className="text-sm underline" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            )}
            <OutcomeLine outcome={outcomes[c.id] ?? null} />
          </li>
        ))}
      </ul>
    </div>
  )
}
