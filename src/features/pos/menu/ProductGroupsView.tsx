// src/features/pos/menu/ProductGroupsView.tsx
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { updateProducts, type MenuProductRow, type ProductPatch } from './menuApi'
import type { NewValue, ProductGroup } from './productGroups'
import { productThumbUrl } from './photoUpload'
import { useMenuData } from './useMenuData'
import ProductPicker from './ProductPicker'
import {
  OutcomeLine, PageHeader, btnCls, errorText, inputCls, linkBtnCls, rowCls, tableBoxCls, tableCls, tdCls, thCls, theadCls, type Outcome,
} from './editorUi'

/** One value that lives on each product (the takeaway fee, the print route), shown as a grouped page. */
export interface GroupedValue<V> {
  title: string
  hint: ReactNode
  /** the products by value, the "none" group last (groupByFee / groupByRoute) */
  group: (rows: MenuProductRow[]) => ProductGroup<V>[]
  /** the value that means none (no fee, no ticket): Remove sets it; its group is listed, not edited */
  none: V
  valueOf: (p: MenuProductRow) => V
  patch: (v: V) => ProductPatch
  label: (v: V) => string
  /** the way back from an open group, e.g. "All fees" */
  allLabel: string
  newButton: string
  newPrompt: string
  parseNew: (text: string, rows: MenuProductRow[]) => NewValue<V>
  emptyText: string
  noneNote: string
}

const plural = (n: number) => `${n} product${n === 1 ? '' : 's'}`

/** The Takeaway fees and Print routes pages: one row per value ("RM 1.00 · 97 products"). Open a value
 *  to see its products, Remove one (back to none) or Add products from a picker; "+ New" asks a value
 *  and opens the picker. Every change is one updateProducts call, then the list is read again. */
export default function ProductGroupsView<V extends number | string | null>({ cfg }: { cfg: GroupedValue<V> }) {
  const { rows, lookups, loadError, load } = useMenuData()
  const [open, setOpen] = useState<{ value: V } | null>(null)        // wrapped: null is a value (no ticket)
  const [picking, setPicking] = useState(false)
  const [newText, setNewText] = useState<string | null>(null)        // null = the "+ New" box is closed
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)                                       // a second click in the same render is refused too
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  const groups = useMemo(() => cfg.group(rows ?? []), [cfg, rows])
  const locked = busy || rows === null
  // an open value with no products (a new one, or its last one removed) still shows, empty
  const openGroup: ProductGroup<V> | null = open
    ? groups.find((g) => g.value === open.value) ?? { value: open.value, label: cfg.label(open.value), products: [] }
    : null
  const isNone = openGroup !== null && openGroup.value === cfg.none

  const show = (value: V) => { setOpen({ value }); setPicking(false); setOutcome(null) }
  const back = () => { setOpen(null); setPicking(false); setOutcome(null) }

  const write = async (ids: string[], value: V, ok: string) => {
    if (busyRef.current || ids.length === 0) return
    busyRef.current = true
    setBusy(true)
    setOutcome(null)
    try {
      await updateProducts(ids, cfg.patch(value))
      setPicking(false)
      setOutcome({ kind: 'ok', text: ok })
    } catch (e) {
      setOutcome({ kind: 'error', text: errorText(e) })
    } finally {
      await load()                                                    // after a failure too: earlier chunks may be written
      busyRef.current = false
      setBusy(false)
    }
  }

  const startNew = () => {
    const r = cfg.parseNew(newText ?? '', rows ?? [])
    if ('problem' in r) { setOutcome({ kind: 'error', text: r.problem }); return }
    setNewText(null)
    setOpen({ value: r.value })
    setPicking(true)
    setOutcome(null)
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <PageHeader title={cfg.title} count={rows ? groups.filter((g) => g.value !== cfg.none).length : null} hint={cfg.hint}>
        {!openGroup && newText === null && (
          <button className={btnCls} disabled={locked} onClick={() => { setNewText(''); setOutcome(null) }}>{cfg.newButton}</button>
        )}
      </PageHeader>
      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" disabled={busy} onClick={() => void load()}>Try again</button>
        </div>
      )}
      <OutcomeLine outcome={outcome} />
      {newText !== null && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3 text-sm">
          <label className="flex items-center gap-2">{cfg.newPrompt}
            <input className={`${inputCls} w-40`} value={newText} autoFocus
              onChange={(e) => setNewText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && startNew()} />
          </label>
          <button className={btnCls} disabled={locked} onClick={startNew}>Choose products</button>
          <button className="text-sm underline" onClick={() => setNewText(null)}>Cancel</button>
        </div>
      )}
      {rows === null && !loadError && <p className="text-sm">Loading…</p>}

      {rows && !openGroup && (
        <div className={tableBoxCls}>
          <table className={tableCls}>
            <tbody>
              {groups.map((g) => (
                <tr key={String(g.value)} className={`${rowCls} cursor-pointer first:border-t-0`} onClick={() => show(g.value)}>
                  <td className={tdCls}>
                    <span className="font-medium">{g.label}</span>
                    <span className="text-brown-muted"> · {plural(g.products.length)}</span>
                  </td>
                  <td className={`${tdCls} text-right`}>
                    <button className={linkBtnCls} onClick={(e) => { e.stopPropagation(); show(g.value) }}>Open</button>
                  </td>
                </tr>
              ))}
              {groups.length === 0 && <tr><td className={`${tdCls} text-brown-muted`}>No products yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {rows && openGroup && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <button className="text-sm underline" disabled={busy} onClick={back}>← {cfg.allLabel}</button>
            <h2 className="text-lg font-semibold">{openGroup.label} · {plural(openGroup.products.length)}</h2>
            {!isNone && !picking && (
              <button className={`${btnCls} ml-auto`} disabled={locked} onClick={() => setPicking(true)}>Add products</button>
            )}
          </div>
          {isNone && <p className="text-sm text-brown-muted">{cfg.noneNote}</p>}
          {picking && !isNone && (
            <ProductPicker rows={rows} categories={lookups?.categories ?? []} busy={busy}
              exclude={(p) => cfg.valueOf(p) === openGroup.value} current={(p) => cfg.label(cfg.valueOf(p))}
              onAdd={(ids) => void write(ids, openGroup.value, `Added ${plural(ids.length)} to ${openGroup.label}`)}
              onClose={() => setPicking(false)} />
          )}
          <div className={tableBoxCls}>
            <table className={tableCls}>
              <thead className={theadCls}>
                <tr><th className={`${thCls} w-14`}>Photo</th><th className={thCls}>Product</th><th className={thCls}>Category</th><th className={thCls} /></tr>
              </thead>
              <tbody>
                {openGroup.products.map((p) => (
                  <tr key={p.id} className={`${rowCls} ${p.is_active ? '' : 'text-brown-faint'}`}>
                    <td className={tdCls}>
                      <div className="h-10 w-10 overflow-hidden rounded border border-border bg-border">
                        {p.image_path && (
                          <img src={productThumbUrl(p.image_path, p.image_updated_at)} alt="" loading="lazy" className="h-full w-full object-cover" />
                        )}
                      </div>
                    </td>
                    <td className={tdCls}>
                      <Link to={`/menu/products/${p.id}`} className="hover:underline">{p.name}</Link>{p.is_active ? '' : ' (off)'}
                    </td>
                    <td className={tdCls}>{p.category?.name ?? 'Uncategorised'}</td>
                    <td className={`${tdCls} text-right`}>
                      {!isNone && (
                        <button className={linkBtnCls} disabled={locked} aria-label={`Remove ${p.name}`}
                          onClick={() => void write([p.id], cfg.none, `${p.name} removed from ${openGroup.label}`)}>Remove</button>
                      )}
                    </td>
                  </tr>
                ))}
                {openGroup.products.length === 0 && (
                  <tr><td colSpan={4} className={`${tdCls} text-brown-muted`}>{cfg.emptyText}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
