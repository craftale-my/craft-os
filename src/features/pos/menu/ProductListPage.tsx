// src/features/pos/menu/ProductListPage.tsx
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { updateProducts, type ProductPatch } from './menuApi'
import { fetchProductExtras } from './slotsApi'
import { uploadProductPhoto } from './photoUpload'
import { UNCATEGORISED, type MenuFilter } from './menuView'
import { NO_FILTER, routeChoices, tableReducer, tableRows } from './productTable'
import { useMenuData } from './useMenuData'
import ProductsTable from './ProductsTable'
import BulkBar from './BulkBar'
import { OutcomeLine, PageHeader, btnCls, errorText, inputCls, linkBtnCls, type Outcome } from './editorUi'

/** /menu — every product in one flat table (Feedme's layout): filters and a search, a photo per row
 *  (a click changes it), and a bulk bar for print route, SST, takeaway fee and on/off on the ticked
 *  rows. A row opens the product editor, where variants, add-on groups and catalog prices are edited. */
export default function ProductListPage() {
  const navigate = useNavigate()
  const { rows, setRows, lookups, loadError, load } = useMenuData()
  const [state, dispatch] = useReducer(tableReducer, { filter: NO_FILTER, selected: new Set<string>() })
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)                                           // a second click in the same render is refused too
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [uploadingId, setUploadingId] = useState<string | null>(null)
  const photoInput = useRef<HTMLInputElement>(null)
  const photoFor = useRef<string | null>(null)                           // the product the picker was opened for

  const visible = useMemo(() => tableRows(rows ?? [], state.filter), [rows, state.filter])
  const routes = useMemo(() => routeChoices(rows ?? []), [rows])
  // a reload can hide ticked rows (e.g. switched off by a write that then failed): drop their ticks
  useEffect(() => { dispatch({ type: 'prune', visible: visible.map((r) => r.id) }) }, [visible])
  const set = (patch: Partial<MenuFilter>) => dispatch({ type: 'filter', patch })
  const locked = busy || uploadingId !== null || rows === null

  /** One patch for every ticked product (updateProducts writes 100 at a time), then the list is read
   *  again — after a failure too, since earlier chunks may already be written. */
  const apply = async (patch: ProductPatch, what: string) => {
    const ids = [...state.selected]
    if (ids.length === 0 || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setOutcome(null)
    try {
      await updateProducts(ids, patch)
      dispatch({ type: 'clear' })
      setOutcome({ kind: 'ok', text: `${what} for ${ids.length} product${ids.length === 1 ? '' : 's'}` })
    } catch (e) {
      setOutcome({ kind: 'error', text: `${errorText(e).replace(/[.!?\s]*$/, '')}. Some products may already be changed — check the list.` })
    } finally {
      await load()
      busyRef.current = false
      setBusy(false)
    }
  }

  const pickPhoto = (id: string) => {
    if (busyRef.current) return
    photoFor.current = id
    photoInput.current?.click()
  }
  /** The editor's upload (resized to 800 px WebP); the new photo then shows in its row at once. */
  const uploadPhoto = async (file: File | undefined) => {
    const id = photoFor.current
    if (!file || !id || busyRef.current) return
    busyRef.current = true
    setUploadingId(id)
    setOutcome(null)
    const name = rows?.find((r) => r.id === id)?.name ?? 'the product'
    try {
      const { warning } = await uploadProductPhoto(id, file)
      setOutcome(warning ? { kind: 'error', text: warning } : { kind: 'ok', text: `Photo of ${name} saved` })
      try {
        const x = await fetchProductExtras(id)
        setRows((rs) => rs?.map((r) => (r.id === id ? { ...r, image_path: x.imagePath, image_updated_at: x.imageUpdatedAt } : r)) ?? rs)
      } catch {
        await load()                                                      // the photo is saved: show it from a full reload
      }
    } catch (e) {
      setOutcome({ kind: 'error', text: errorText(e) })
      await load()                                                        // the product may point at the new file after all
    } finally {
      busyRef.current = false
      setUploadingId(null)
    }
  }

  const f = state.filter
  return (
    <div className="space-y-4 p-6">
      <PageHeader title="Products" count={rows?.length}
        hint="SST, print route and takeaway fee apply in every catalog. Open a product to edit its variants, add-on groups and catalog prices.">
        <Link to="/menu/import" className={linkBtnCls}>Import</Link>
        <Link to="/menu/products/new" className={btnCls}>+ Add product</Link>
      </PageHeader>

      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" disabled={busy || uploadingId !== null} onClick={() => void load()}>Try again</button>
        </div>
      )}
      <OutcomeLine outcome={outcome} />

      <div className="flex flex-wrap items-center gap-3">
        <select className={inputCls} aria-label="Category" value={f.categoryId ?? ''} onChange={(e) => set({ categoryId: e.target.value || null })}>
          <option value="">All categories</option>
          <option value={UNCATEGORISED}>Uncategorised</option>
          {lookups?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}{c.isActive ? '' : ' (off)'}</option>)}
        </select>
        <select className={inputCls} aria-label="Catalog" value={f.catalogId ?? ''} onChange={(e) => set({ catalogId: e.target.value || null })}>
          <option value="">All catalogs</option>
          {lookups?.catalogs.map((c) => <option key={c.id} value={c.id}>Sold in {c.name}{c.isActive ? '' : ' (off)'}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.showAddons} onChange={(e) => set({ showAddons: e.target.checked })} /> Show add-ons
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.showInactive} onChange={(e) => set({ showInactive: e.target.checked })} /> Show switched-off
        </label>
        <input className={`${inputCls} w-64 min-[900px]:ml-auto`} type="search" placeholder="Search products" aria-label="Search products"
          value={f.search} onChange={(e) => set({ search: e.target.value })} />
      </div>

      {state.selected.size > 0 && (
        <BulkBar count={state.selected.size} routes={routes} busy={busy || uploadingId !== null}
          onApply={(patch, what) => void apply(patch, what)} onClear={() => dispatch({ type: 'clear' })} />
      )}

      {rows === null && !loadError && <p className="text-sm">Loading menu…</p>}
      {rows?.length === 0 && (
        <p className="rounded border border-border bg-card p-6 text-sm">No menu yet — use “Import” or “+ Add product”.</p>
      )}
      {rows !== null && rows.length > 0 && (
        <ProductsTable rows={visible} catalogs={lookups?.catalogs ?? []} selected={state.selected} locked={locked}
          uploadingId={uploadingId}
          onToggle={(id) => dispatch({ type: 'toggle', id })}
          onToggleAll={() => dispatch({ type: 'toggleAll', visibleIds: visible.map((r) => r.id) })}
          onOpen={(id) => navigate(`/menu/products/${id}`)}
          onPhoto={pickPhoto} />
      )}
      <input ref={photoInput} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-label="Product photo"
        onChange={(e) => { void uploadPhoto(e.target.files?.[0]); e.target.value = '' }} />
    </div>
  )
}
