// src/features/pos/menu/catalog/GridRow.tsx
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Availability } from '../feedmeExport'
import { saveCatalogRow, type GridProduct } from '../menuEditorApi'
import { CATALOG_AVAILABILITY_LABELS } from '../menuView'
import {
  gridProductAfterSave, gridRowDirty, gridRowForm, gridRowPayload, gridRowProblem, setGridAvailability, type GridRowForm,
} from '../catalogGrid'
import { OutcomeLine, errorText, inputCls, linkBtnCls, type Outcome } from '../editorUi'

/** One product in one catalog, saved on its own (menu_save_catalog_row). The outcome
 *  shows on the row; a second tap while it saves does nothing. */
export default function GridRow({ product, catalogId, catalogName, onSaved }: {
  product: GridProduct
  catalogId: string
  catalogName: string
  onSaved: (p: GridProduct) => void
}) {
  const [form, setForm] = useState<GridRowForm>(() => gridRowForm(product))
  const [saving, setSaving] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  useEffect(() => { setForm(gridRowForm(product)) }, [product])   // a saved or reloaded product resets the row

  const dirty = gridRowDirty(form, product)
  const sells = form.availability !== 'hidden'
  // a saved row that breaks the price rule (e.g. after a re-import) says so before anyone edits it
  const standing = useMemo(
    () => (!dirty && sells ? gridRowProblem(form, product, catalogName) : null), [dirty, sells, form, product, catalogName])
  const variants = product.variants.filter((v) => v.isActive)
  const change = (next: GridRowForm) => { setForm(next); setOutcome(null) }

  const save = async () => {
    if (saving) return
    const problem = gridRowProblem(form, product, catalogName)
    if (problem) { setOutcome({ kind: 'error', text: problem }); return }
    setSaving(true)
    try {
      await saveCatalogRow(gridRowPayload(form, product, catalogId))
      onSaved(gridProductAfterSave(product, form))
      setOutcome({ kind: 'ok', text: 'Saved' })
    } catch (e) {
      setOutcome({ kind: 'error', text: errorText(e) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <tr className="border-t border-border align-top">
      <td className="px-3 py-2"><Link to={`/menu/products/${product.id}`} className="hover:underline">{product.name}</Link></td>
      <td className="px-3 py-2">
        <select className={inputCls} value={form.availability} disabled={saving} aria-label={`${product.name} availability`}
          onChange={(e) => change(setGridAvailability(form, product, e.target.value as Availability))}>
          {(Object.keys(CATALOG_AVAILABILITY_LABELS) as Availability[]).map((a) => (
            <option key={a} value={a}>{CATALOG_AVAILABILITY_LABELS[a]}</option>
          ))}
        </select>
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-2">
          {variants.map((v) => (
            <label key={v.id} className="text-xs">{variants.length > 1 ? v.name : 'Price'}
              <input className={`${inputCls} ml-1 w-20`} inputMode="decimal" aria-label={`${product.name}${variants.length > 1 ? ` ${v.name}` : ''} price (RM)`} disabled={!sells || saving}
                placeholder={(v.defaultSen / 100).toFixed(2)} value={form.prices[v.id] ?? ''}
                onChange={(e) => change({ ...form, prices: { ...form.prices, [v.id]: e.target.value } })} />
            </label>
          ))}
        </div>
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-col items-start gap-1">
          <button className={linkBtnCls} disabled={!dirty || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
          <OutcomeLine outcome={outcome ?? (standing ? { kind: 'error', text: `${standing} — the pad and QR leave it out` } : null)} />
        </div>
      </td>
    </tr>
  )
}
