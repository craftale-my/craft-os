import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  fetchCatalogEntries, fetchCatalogs, fetchMenu, setCatalogAvailability, updateProducts,
  type CatalogEntries, type MenuProductRow, type ProductPatch,
} from './menuApi'
import {
  CATALOG_AVAILABILITY_LABELS, PRINT_ROUTES, SST_CHOICES, catalogAvailability, formatCatalogPrice, formatPrice, groupMenu,
} from './menuView'
import type { Availability } from './feedmeExport'
import type { CatalogRow } from '../order/catalogs'

const select = 'rounded border border-border bg-card px-2 py-1 text-sm'
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export default function MenuPage() {
  const [rows, setRows] = useState<MenuProductRow[] | null>(null)
  const [catalogs, setCatalogs] = useState<CatalogRow[]>([])
  const [catalogId, setCatalogId] = useState<string | null>(null)
  const [entries, setEntries] = useState<CatalogEntries | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [showAddons, setShowAddons] = useState(false)

  const load = useCallback(() => {
    Promise.all([fetchMenu(), fetchCatalogs()])
      .then(([r, c]) => {
        setRows(r)
        setCatalogs(c)
        setCatalogId((cur) => cur ?? c.find((x) => x.is_active)?.id ?? c[0]?.id ?? null)
        setError(null)
      })
      .catch((e) => setError(msg(e)))
  }, [])
  useEffect(() => {
    load()
  }, [load])

  // the catalog currently chosen; a load that resolves after the manager switched away is dropped
  const catalogIdRef = useRef<string | null>(null)
  useEffect(() => {
    catalogIdRef.current = catalogId
  }, [catalogId])
  const loadEntries = useCallback((id: string) => {
    fetchCatalogEntries(id).then(
      (e) => {
        if (catalogIdRef.current === id) setEntries(e)
      },
      (e) => {
        if (catalogIdRef.current === id) setError(msg(e))
      },
    )
  }, [])
  useEffect(() => {
    if (catalogId) loadEntries(catalogId)
  }, [catalogId, loadEntries])

  const sections = useMemo(() => groupMenu(rows ?? [], { showAddons, search }), [rows, showAddons, search])
  // entries of a catalog that is no longer the chosen one are never shown
  const shown = entries && entries.catalogId === catalogId ? entries : null
  const current = catalogs.find((c) => c.id === catalogId) ?? null
  const inCatalog = shown ? [...shown.availability.values()].filter((a) => a !== 'hidden').length : 0

  const save = async (ids: string[], patch: ProductPatch) => {
    const before = rows
    setRows((rs) => rs?.map((r) => (ids.includes(r.id) ? { ...r, ...patch } : r)) ?? rs)
    try {
      await updateProducts(ids, patch)
      setError(null)
    } catch (e) {
      setRows(before)
      setError(msg(e))
    }
  }

  const setAvailability = async (productId: string, availability: Availability) => {
    if (!shown) return
    const writtenTo = shown.catalogId
    const had = shown.availability.has(productId)
    const previous = shown.availability.get(productId)
    const patchRow = (value: Availability | undefined) =>
      setEntries((cur) => {
        if (!cur || cur.catalogId !== writtenTo) return cur
        const next = new Map(cur.availability)
        if (value === undefined) next.delete(productId)
        else next.set(productId, value)
        return { ...cur, availability: next }
      })
    patchRow(availability)
    try {
      await setCatalogAvailability(writtenTo, productId, availability)
      setError(null)
      // a product put in has its prices pre-filled on the server; reload whichever catalog is chosen now
      if (catalogIdRef.current) loadEntries(catalogIdRef.current)
    } catch (e) {
      patchRow(had ? previous : undefined)   // roll back only this product's row
      setError(msg(e))
    }
  }

  if (rows === null && !error) return <p className="p-6 text-sm">Loading menu…</p>

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Menu</h1>
          <p className="text-sm text-gray-500">
            {rows?.length ?? 0} products. Each catalog decides which products it sells and on which channel; SST and print
            route apply in every catalog. Editing names, prices and add-ons here comes in the next menu update — until then
            they change only by importing from Feedme.
          </p>
        </div>
        <Link to="/menu/import" className="rounded bg-brown-btn px-4 py-2 text-sm text-white hover:bg-brown-btn-hover">
          Import from Feedme
        </Link>
      </div>

      {error && <p className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          Catalog
          <select className={select} value={catalogId ?? ''} onChange={(e) => setCatalogId(e.target.value || null)}>
            {catalogs.map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.is_active ? '' : ' (inactive)'}</option>
            ))}
          </select>
        </label>
        {current && shown && <span className="text-sm text-gray-500">{inCatalog} products in {current.name}</span>}
        <input
          className="w-64 rounded border border-border px-3 py-2 text-sm"
          placeholder="Search products"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showAddons} onChange={(e) => setShowAddons(e.target.checked)} />
          Show add-on items
        </label>
      </div>

      {rows?.length === 0 && (
        <p className="rounded border border-border p-6 text-sm">No menu yet — use “Import from Feedme”.</p>
      )}

      {sections.map((section) => (
        <section key={section.title} className="rounded border border-border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
            <h2 className="font-medium">
              {section.title} <span className="text-sm text-gray-500">({section.products.length})</span>
            </h2>
            <label className="flex items-center gap-2 text-sm">
              Print whole category to
              <select
                className={select}
                value=""
                onChange={(e) =>
                  void save(
                    // the whole category, not just the rows the search/add-on filter is showing
                    (rows ?? []).filter((r) => (r.category?.name ?? 'Uncategorised') === section.title).map((p) => p.id),
                    { print_route: e.target.value || null },
                  )
                }
              >
                <option value="" disabled>Choose…</option>
                {PRINT_ROUTES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </label>
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-gray-500">
              <tr>
                <th className="px-4 py-2">Product</th>
                <th className="px-4 py-2">Price{current ? ` in ${current.name}` : ''}</th>
                <th className="px-4 py-2">In {current?.name ?? 'catalog'}</th>
                <th className="px-4 py-2">SST</th>
                <th className="px-4 py-2">Print route</th>
              </tr>
            </thead>
            <tbody>
              {section.products.map((p) => {
                const availability = shown ? catalogAvailability(shown.availability, p.id) : null
                return (
                  <tr key={p.id} className="border-t border-border">
                    <td className="px-4 py-2">
                      {p.name}
                      {p.menu_variants.filter((v) => v.is_active).length > 1 && (
                        <span className="ml-2 text-xs text-gray-500">
                          {p.menu_variants.filter((v) => v.is_active).map((v) => v.name).join(' / ')}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {shown && availability !== 'hidden'
                        ? formatCatalogPrice(p.menu_variants, shown.prices)
                        : <span className="text-gray-400">Default {formatPrice(p.menu_variants)}</span>}
                    </td>
                    <td className="px-4 py-2">
                      <select
                        className={select}
                        disabled={!shown}
                        value={availability ?? 'hidden'}
                        onChange={(e) => void setAvailability(p.id, e.target.value as Availability)}
                      >
                        {(Object.keys(CATALOG_AVAILABILITY_LABELS) as Availability[]).map((a) => (
                          <option key={a} value={a}>{CATALOG_AVAILABILITY_LABELS[a]}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-2">
                      <select
                        className={select}
                        value={p.sst_rate_bp}
                        onChange={(e) => void save([p.id], { sst_rate_bp: Number(e.target.value) })}
                      >
                        {SST_CHOICES.map((c) => (
                          <option key={c.bp} value={c.bp}>{c.label}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-2">
                      <select
                        className={select}
                        value={p.print_route ?? ''}
                        onChange={(e) => void save([p.id], { print_route: e.target.value || null })}
                      >
                        <option value="">Not printed</option>
                        {PRINT_ROUTES.map((r) => (
                          <option key={r} value={r}>{r}</option>
                        ))}
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
