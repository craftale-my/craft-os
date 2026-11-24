// src/features/pos/menu/ProductsTable.tsx
import type { MouseEvent } from 'react'
import { Link } from 'react-router-dom'
import type { MenuProductRow } from './menuApi'
import type { LookupCatalog } from './menuEditorApi'
import { soldIn } from './menuView'
import { defaultPrice, feeText, headerState, routeText, soldInText, sstText, variantCountText } from './productTable'
import { productThumbUrl } from './photoUpload'
import { numCls, rowCls, tableBoxCls, tableCls, tdCls, thCls, theadCls } from './editorUi'

const stop = (e: MouseEvent) => e.stopPropagation()
/** The tick cell is one label, so a tap anywhere in it ticks the box (and never opens the editor). */
const tickCellCls = 'absolute inset-0 flex h-full w-full cursor-pointer items-center justify-center'
/** The td/th that holds it: no padding, a minimum size, and `relative` so the label fills the whole cell however tall the row is. */
const tickTdCls = 'relative h-12 min-h-12 w-14 min-w-14 p-0 align-middle'
const tickCls = 'h-5 w-5 cursor-pointer'

/** The Products page's one flat table (Feedme's layout). A click on a row opens the product editor;
 *  the tick box and the photo do their own thing instead. */
export default function ProductsTable({ rows, catalogs, selected, locked, uploadingId, onToggle, onToggleAll, onOpen, onPhoto }: {
  rows: MenuProductRow[]
  catalogs: LookupCatalog[]
  selected: ReadonlySet<string>
  locked: boolean
  /** the product whose new photo is uploading */
  uploadingId: string | null
  onToggle: (id: string) => void
  onToggleAll: () => void
  onOpen: (id: string) => void
  /** opens the photo picker for this product */
  onPhoto: (id: string) => void
}) {
  const head = headerState(selected, rows.map((r) => r.id))
  return (
    <div className={tableBoxCls}>
      <table className={tableCls}>
        <thead className={theadCls}>
          <tr>
            <th className="relative h-12 min-h-12 w-14 min-w-14 p-0 font-medium">
              <label className={tickCellCls}>
                <input type="checkbox" className={tickCls} aria-label="Select every product shown" disabled={locked || rows.length === 0}
                  checked={head === 'all'} ref={(el) => { if (el) el.indeterminate = head === 'some' }} onChange={onToggleAll} />
              </label>
            </th>
            <th className={`${thCls} w-16`}>Photo</th>
            <th className={thCls}>Product</th>
            <th className={`${thCls} ${numCls}`}>Price</th>
            <th className={thCls}>SST</th>
            <th className={thCls}>Category</th>
            <th className={thCls}>Sold in</th>
            <th className={thCls}>Print route</th>
            <th className={`${thCls} ${numCls}`}>Takeaway fee</th>
            <th className={thCls}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const names = soldIn(p.catalog_ids, catalogs)
            const variants = variantCountText(p.menu_variants)
            return (
              <tr key={p.id} className={`${rowCls} cursor-pointer ${p.is_active ? '' : 'text-brown-faint'}`} onClick={() => onOpen(p.id)}>
                <td className={tickTdCls} onClick={stop}>
                  <label className={tickCellCls}>
                    <input type="checkbox" className={tickCls} aria-label={`Select ${p.name}`} disabled={locked}
                      checked={selected.has(p.id)} onChange={() => onToggle(p.id)} />
                  </label>
                </td>
                <td className={tdCls} onClick={stop}>
                  <button type="button" disabled={locked} onClick={() => onPhoto(p.id)}
                    aria-label={p.image_path ? `Change the photo of ${p.name}` : `Add a photo of ${p.name}`}
                    className="block h-12 w-12 overflow-hidden rounded border border-border bg-border hover:opacity-80 disabled:cursor-wait">
                    {uploadingId === p.id
                      ? <span className="flex h-full items-center justify-center text-[10px] text-brown-muted">Uploading…</span>
                      : p.image_path && (
                        <img src={productThumbUrl(p.image_path, p.image_updated_at)} alt="" loading="lazy" className="h-full w-full object-cover" />
                      )}
                  </button>
                </td>
                <td className={tdCls}>
                  <Link to={`/menu/products/${p.id}`} onClick={stop} className="font-medium underline-offset-2 hover:underline">{p.name}</Link>
                  {p.is_addon && <span className="ml-2 text-xs text-brown-muted">add-on item</span>}
                  {variants && <span className="block text-xs text-brown-muted">{variants}</span>}
                </td>
                <td className={`${tdCls} ${numCls} whitespace-nowrap`}>{defaultPrice(p.menu_variants)}</td>
                <td className={tdCls}>{sstText(p.sst_rate_bp)}</td>
                <td className={tdCls}>{p.category?.name ?? 'Uncategorised'}</td>
                <td className={`${tdCls} ${names.length === 0 ? 'text-brown-faint' : ''}`} title={names.join(', ')}>{soldInText(names)}</td>
                <td className={tdCls}>{routeText(p.print_route)}</td>
                <td className={`${tdCls} ${numCls} whitespace-nowrap`}>{feeText(p.takeaway_fee_sen)}</td>
                <td className={tdCls}>{p.is_active ? 'On' : 'Off'}</td>
              </tr>
            )
          })}
          {rows.length === 0 && (
            <tr><td colSpan={10} className={`${tdCls} text-brown-muted`}>No products match.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
