// src/features/pos/menu/ProductPicker.tsx
import { useState } from 'react'
import type { MenuProductRow } from './menuApi'
import type { LookupCategory } from './menuEditorApi'
import { NO_FILTER, tableRows } from './productTable'
import { btnCls, inputCls } from './editorUi'

/** "Add products": a search and a category filter, tick several, add them all at once. Add-on items
 *  and the products already in the group are not offered; `current` says where each one is now. */
export default function ProductPicker({ rows, categories, exclude, current, busy, onAdd, onClose }: {
  rows: MenuProductRow[]
  categories: LookupCategory[]
  exclude: (p: MenuProductRow) => boolean
  current: (p: MenuProductRow) => string
  busy: boolean
  onAdd: (ids: string[]) => void
  onClose: () => void
}) {
  const [search, setSearch] = useState('')
  const [categoryId, setCategoryId] = useState<string | null>(null)
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const shown = tableRows(rows, { ...NO_FILTER, showInactive: true, search, categoryId }).filter((p) => !exclude(p))
  // only ticks that are still on screen count: after a reload a ticked product may have moved into the
  // group or gone, and a filter change clears the ticks (as on the Products page)
  const ids = shown.filter((p) => ticked.has(p.id)).map((p) => p.id)
  const toggle = (id: string) => setTicked((t) => {
    const next = new Set(t)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-semibold">Add products</h3>
        <input className={`${inputCls} w-56`} type="search" placeholder="Search products" aria-label="Search products to add"
          value={search} onChange={(e) => { setSearch(e.target.value); setTicked(new Set()) }} />
        <select className={inputCls} aria-label="Category" value={categoryId ?? ''} onChange={(e) => { setCategoryId(e.target.value || null); setTicked(new Set()) }}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}{c.isActive ? '' : ' (off)'}</option>)}
        </select>
      </div>
      <ul className="max-h-80 space-y-1 overflow-y-auto text-sm">
        {shown.map((p) => (
          <li key={p.id}>
            <label className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-cream">
              <input type="checkbox" checked={ids.includes(p.id)} onChange={() => toggle(p.id)} />
              <span className="flex-1">{p.name}{p.is_active ? '' : ' (off)'}</span>
              <span className="text-xs text-brown-muted">{p.category?.name ?? 'Uncategorised'} · now {current(p)}</span>
            </label>
          </li>
        ))}
        {shown.length === 0 && <li className="text-brown-muted">No products match.</li>}
      </ul>
      <div className="flex items-center gap-2">
        <button className={btnCls} disabled={busy || ids.length === 0} onClick={() => onAdd(ids)}>
          Add {ids.length} product{ids.length === 1 ? '' : 's'}
        </button>
        <button className="text-sm underline" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </div>
  )
}
