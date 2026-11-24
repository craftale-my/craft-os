// src/features/pos/menu/schedule/ProductsSection.tsx
import { useMemo, useState } from 'react'
import type { MenuProductRow } from '../menuApi'
import { setProduct, type ScheduleForm } from '../scheduleForm'
import { Section, inputCls } from '../editorUi'

/** The products that follow this schedule (Feedme's "Apply product"). Add-on items and
 *  switched-off products are listed only while they are ticked. */
export default function ProductsSection({ form, onChange, products }: {
  form: ScheduleForm
  onChange: (f: ScheduleForm) => void
  products: MenuProductRow[]
}) {
  const [search, setSearch] = useState('')
  const [tickedOnly, setTickedOnly] = useState(false)
  const ticked = useMemo(() => new Set(form.productIds), [form.productIds])
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return products
      .filter((p) => ticked.has(p.id) || (p.is_active && !p.is_addon))
      .filter((p) => !tickedOnly || ticked.has(p.id))
      .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.category?.name ?? '').toLowerCase().includes(q))
      .sort((a, b) => (a.category?.sort_order ?? 9999) - (b.category?.sort_order ?? 9999)
        || (a.category?.name ?? '').localeCompare(b.category?.name ?? '') || a.sort_order - b.sort_order || a.name.localeCompare(b.name))
  }, [products, ticked, tickedOnly, search])
  const n = form.productIds.length
  return (
    <Section title="Products"
      hint={`${n} product${n === 1 ? ' follows' : 's follow'} this schedule: outside its windows they are hidden on QR and greyed out at the counter. A product that follows several schedules sells inside any of their windows.`}>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <input className={`${inputCls} w-64`} placeholder="Search products or categories" aria-label="Search products"
          value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={tickedOnly} onChange={(e) => setTickedOnly(e.target.checked)} /> Ticked only
        </label>
      </div>
      <ul className="max-h-96 space-y-1 overflow-y-auto text-sm">
        {rows.map((p) => (
          <li key={p.id}>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ticked.has(p.id)} onChange={(e) => onChange(setProduct(form, p.id, e.target.checked))} />
              <span className="flex-1">{p.name}{p.is_active ? '' : ' (off)'}{p.is_addon ? ' (add-on item)' : ''}</span>
              <span className="text-xs text-brown-muted">{p.category?.name ?? 'Uncategorised'}</span>
            </label>
          </li>
        ))}
        {rows.length === 0 && <li className="text-brown-muted">No products match.</li>}
      </ul>
    </Section>
  )
}
