// src/features/pos/menu/CatalogGridPage.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchCatalogGrid, type CatalogGrid, type GridProduct } from './menuEditorApi'
import { gridSections, type GridShow } from './catalogGrid'
import MenuTabs from './MenuTabs'
import GridRow from './catalog/GridRow'
import { OutcomeLine, errorText, inputCls } from './editorUi'

/** /menu/catalogs/:id — every product with this catalog's availability and prices,
 *  one row saved at a time. The route remounts this page per catalog (MenuRoutes keys it). */
export default function CatalogGridPage({ catalogId }: { catalogId: string }) {
  const [grid, setGrid] = useState<CatalogGrid | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [show, setShow] = useState<GridShow>('all')
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set())   // saved rows stay listed until the filter changes
  const loadSeq = useRef(0)

  const load = useCallback(() => {
    const seq = ++loadSeq.current
    fetchCatalogGrid(catalogId).then(
      (g) => { if (seq === loadSeq.current) { setGrid(g); setLoadError(null) } },
      (e) => { if (seq === loadSeq.current) setLoadError(errorText(e)) },
    )
  }, [catalogId])
  useEffect(() => { load() }, [load])

  const sections = useMemo(() => gridSections(grid?.products ?? [], search, show, kept), [grid, search, show, kept])
  const sold = grid?.products.filter((p) => p.availability !== 'hidden').length ?? 0
  const onSaved = useCallback((p: GridProduct) => {
    setGrid((g) => (g ? { ...g, products: g.products.map((x) => (x.id === p.id ? p : x)) } : g))
    setKept((k) => new Set(k).add(p.id))
  }, [])

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <MenuTabs />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">{grid?.catalog.name ?? 'Catalog'}{grid && !grid.catalog.isActive ? ' (off)' : ''}</h1>
          {grid && <p className="text-sm text-brown-muted">Sells {sold} of {grid.products.length} products. Grey prices are the default prices.</p>}
        </div>
        <Link to="/menu/catalogs" className="text-sm underline">Back to catalogs</Link>
      </div>
      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" onClick={load}>Try again</button>
        </div>
      )}
      {!grid ? (!loadError && <p className="text-sm">Loading…</p>) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <input className={`${inputCls} w-56`} placeholder="Search products" value={search} onChange={(e) => setSearch(e.target.value)} />
            <select className={inputCls} value={show} onChange={(e) => { setShow(e.target.value as GridShow); setKept(new Set()) }}>
              <option value="all">All products</option>
              <option value="in">In this catalog</option>
              <option value="out">Not in this catalog</option>
            </select>
          </div>
          {sections.map((s) => (
            <section key={s.title} className="rounded border border-border bg-card">
              <h2 className="border-b border-border px-3 py-2 font-medium">{s.title}</h2>
              <table className="w-full text-sm">
                <thead className="text-left text-brown-muted">
                  <tr><th className="px-3 py-1">Product</th><th className="px-3 py-1">In {grid.catalog.name}</th><th className="px-3 py-1">Prices (RM)</th><th /></tr>
                </thead>
                <tbody>
                  {s.products.map((p) => (
                    <GridRow key={p.id} product={p} catalogId={grid.catalog.id} catalogName={grid.catalog.name} onSaved={onSaved} />
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </>
      )}
    </div>
  )
}
