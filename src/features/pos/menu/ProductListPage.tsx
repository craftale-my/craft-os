// src/features/pos/menu/ProductListPage.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchMenu, updateProducts, type MenuProductRow, type ProductPatch } from './menuApi'
import { fetchLookups, type MenuLookups } from './menuEditorApi'
import { PRINT_ROUTES, SST_CHOICES, formatPrice, groupMenu, soldIn, type MenuFilter } from './menuView'
import MenuTabs from './MenuTabs'
import { OutcomeLine, btnCls, errorText, inputCls, type Outcome } from './editorUi'

/** /menu — the master product list. Each row opens the product editor; SST and the
 *  print route stay editable here (and the print route for a whole category at once)
 *  because setting them up for 400 imported products one editor at a time is slow.
 *  Which catalogs sell a product, and at what price, is edited in the product editor
 *  or on a catalog's page. */
export default function ProductListPage() {
  const [rows, setRows] = useState<MenuProductRow[] | null>(null)
  const [lookups, setLookups] = useState<MenuLookups | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [filter, setFilter] = useState<MenuFilter>({ search: '', showAddons: false, showInactive: false, categoryId: null, catalogId: null })
  const [busy, setBusy] = useState<Set<string>>(new Set())                    // product ids being saved
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({})       // by section title

  const loadSeq = useRef(0)                                               // an older reply never lands last
  const load = useCallback(() => {
    const seq = ++loadSeq.current
    Promise.all([fetchMenu(), fetchLookups()])
      .then(([r, l]) => { if (seq === loadSeq.current) { setRows(r); setLookups(l); setLoadError(null) } })
      .catch((e) => { if (seq === loadSeq.current) setLoadError(errorText(e)) })
  }, [])
  useEffect(() => { load() }, [load])

  const sections = useMemo(() => groupMenu(rows ?? [], filter), [rows, filter])

  /** A quick edit of one or more products; the outcome shows on the section that made it. */
  const save = async (section: string, ids: string[], patch: ProductPatch) => {
    if (ids.length === 0 || ids.some((id) => busy.has(id))) return
    const before = rows
    setBusy((b) => new Set([...b, ...ids]))
    setRows((rs) => rs?.map((r) => (ids.includes(r.id) ? { ...r, ...patch } : r)) ?? rs)
    try {
      await updateProducts(ids, patch)
      setOutcomes((o) => ({ ...o, [section]: { kind: 'ok', text: ids.length === 1 ? 'Saved' : `Saved for ${ids.length} products` } }))
    } catch (e) {
      setRows(before)
      setOutcomes((o) => ({ ...o, [section]: { kind: 'error', text: errorText(e) } }))
    } finally {
      setBusy((b) => new Set([...b].filter((id) => !ids.includes(id))))
    }
  }

  if (rows === null && !loadError) return <div className="mx-auto max-w-6xl space-y-4 p-6"><MenuTabs /><p className="text-sm">Loading menu…</p></div>

  const set = (patch: Partial<MenuFilter>) => setFilter((f) => ({ ...f, ...patch }))
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <MenuTabs />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Products</h1>
          <p className="text-sm text-brown-muted">
            {rows?.length ?? 0} products. SST and print route apply in every catalog; open a product to edit its
            variants, add-on groups and catalog prices.
          </p>
        </div>
        <Link to="/menu/products/new" className={btnCls}>New product</Link>
      </div>

      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" onClick={load}>Try again</button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <input className={`${inputCls} w-56`} placeholder="Search products" value={filter.search}
          onChange={(e) => set({ search: e.target.value })} />
        <select className={inputCls} value={filter.categoryId ?? ''} onChange={(e) => set({ categoryId: e.target.value || null })}>
          <option value="">All categories</option>
          {lookups?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}{c.isActive ? '' : ' (off)'}</option>)}
        </select>
        <select className={inputCls} value={filter.catalogId ?? ''} onChange={(e) => set({ catalogId: e.target.value || null })}>
          <option value="">Any catalog</option>
          {lookups?.catalogs.map((c) => <option key={c.id} value={c.id}>Sold in {c.name}{c.isActive ? '' : ' (off)'}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={filter.showAddons} onChange={(e) => set({ showAddons: e.target.checked })} />
          Show add-on items
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={filter.showInactive} onChange={(e) => set({ showInactive: e.target.checked })} />
          Show switched-off products
        </label>
      </div>

      {rows?.length === 0 && (
        <p className="rounded border border-border p-6 text-sm">No menu yet — use “Import from Feedme” or “New product”.</p>
      )}

      {sections.map((section) => (
        <section key={section.title} className="rounded border border-border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
            <h2 className="font-medium">
              {section.title} <span className="text-sm text-brown-muted">({section.products.length})</span>
            </h2>
            <label className="flex items-center gap-2 text-sm">
              Print whole category to
              <select className={inputCls} value=""
                onChange={(e) => void save(section.title,
                  // the whole category, not just the rows the filters are showing
                  (rows ?? []).filter((r) => (r.category?.name ?? 'Uncategorised') === section.title).map((p) => p.id),
                  { print_route: e.target.value || null })}>
                <option value="" disabled>Choose…</option>
                {PRINT_ROUTES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
          </div>
          {outcomes[section.title] && <div className="px-4 pt-2"><OutcomeLine outcome={outcomes[section.title]} /></div>}
          <table className="w-full text-sm">
            <thead className="text-left text-brown-muted">
              <tr>
                <th className="px-4 py-2">Product</th>
                <th className="px-4 py-2">Default price</th>
                <th className="px-4 py-2">Sold in</th>
                <th className="px-4 py-2">SST</th>
                <th className="px-4 py-2">Print route</th>
              </tr>
            </thead>
            <tbody>
              {section.products.map((p) => {
                const names = soldIn(p.catalog_ids, lookups?.catalogs ?? [])
                const active = p.menu_variants.filter((v) => v.is_active)
                return (
                  <tr key={p.id} className={`border-t border-border ${p.is_active ? '' : 'text-brown-faint'}`}>
                    <td className="px-4 py-2">
                      <Link to={`/menu/products/${p.id}`} className="underline-offset-2 hover:underline">{p.name}</Link>
                      {!p.is_active && <span className="ml-2 text-xs">(off)</span>}
                      {active.length > 1 && <span className="ml-2 text-xs text-brown-muted">{active.map((v) => v.name).join(' / ')}</span>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2">{formatPrice(p.menu_variants)}</td>
                    <td className="px-4 py-2" title={names.join(', ')}>
                      {names.length === 0 ? <span className="text-brown-faint">No catalog</span>
                        : names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`}
                    </td>
                    <td className="px-4 py-2">
                      <select className={inputCls} value={p.sst_rate_bp} disabled={busy.has(p.id)}
                        onChange={(e) => void save(section.title, [p.id], { sst_rate_bp: Number(e.target.value) })}>
                        {SST_CHOICES.map((c) => <option key={c.bp} value={c.bp}>{c.label}</option>)}
                      </select>
                    </td>
                    <td className="px-4 py-2">
                      <select className={inputCls} value={p.print_route ?? ''} disabled={busy.has(p.id)}
                        onChange={(e) => void save(section.title, [p.id], { print_route: e.target.value || null })}>
                        <option value="">Not printed</option>
                        {PRINT_ROUTES.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  )
}
