import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchMenu, updateProducts, type MenuProductRow, type ProductPatch } from './menuApi'
import { AVAILABILITY_LABELS, PRINT_ROUTES, SST_CHOICES, formatPrice, groupMenu } from './menuView'
import type { Availability } from './feedmeExport'

const select = 'rounded border border-border bg-card px-2 py-1 text-sm'

export default function MenuPage() {
  const [rows, setRows] = useState<MenuProductRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [showAddons, setShowAddons] = useState(false)

  const load = useCallback(() => {
    fetchMenu()
      .then((r) => {
        setRows(r)
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
  }, [])
  useEffect(() => {
    load()
  }, [load])

  const sections = useMemo(() => groupMenu(rows ?? [], { showAddons, search }), [rows, showAddons, search])

  const save = async (ids: string[], patch: ProductPatch) => {
    const before = rows
    setRows((rs) => rs?.map((r) => (ids.includes(r.id) ? { ...r, ...patch } : r)) ?? rs)
    try {
      await updateProducts(ids, patch)
      setError(null)
    } catch (e) {
      setRows(before)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (rows === null && !error) return <p className="p-6 text-sm">Loading menu…</p>

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Menu</h1>
          <p className="text-sm text-gray-500">
            {rows?.length ?? 0} products. Names, prices, add-ons and availability come from Feedme — importing again resets them. SST and print route are set here and survive a re-import.
          </p>
        </div>
        <Link to="/menu/import" className="rounded bg-brown-btn px-4 py-2 text-sm text-white hover:bg-brown-btn-hover">
          Import from Feedme
        </Link>
      </div>

      {error && <p className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <div className="flex flex-wrap items-center gap-4">
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
                onChange={(e) => void save(section.products.map((p) => p.id), { print_route: e.target.value || null })}
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
                <th className="px-4 py-2">Price</th>
                <th className="px-4 py-2">Availability</th>
                <th className="px-4 py-2">SST</th>
                <th className="px-4 py-2">Print route</th>
              </tr>
            </thead>
            <tbody>
              {section.products.map((p) => (
                <tr key={p.id} className="border-t border-border">
                  <td className="px-4 py-2">
                    {p.name}
                    {p.menu_variants.filter((v) => v.is_active).length > 1 && (
                      <span className="ml-2 text-xs text-gray-500">
                        {p.menu_variants.filter((v) => v.is_active).map((v) => v.name).join(' / ')}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">{formatPrice(p.menu_variants)}</td>
                  <td className="px-4 py-2">
                    <select
                      className={select}
                      value={p.availability}
                      onChange={(e) => void save([p.id], { availability: e.target.value as Availability })}
                    >
                      {(Object.keys(AVAILABILITY_LABELS) as Availability[]).map((a) => (
                        <option key={a} value={a}>{AVAILABILITY_LABELS[a]}</option>
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
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  )
}
