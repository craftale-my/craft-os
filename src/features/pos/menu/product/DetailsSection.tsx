// src/features/pos/menu/product/DetailsSection.tsx
import type { LookupCategory } from '../menuEditorApi'
import type { ProductForm } from '../productForm'
import { PRINT_ROUTES, SST_CHOICES } from '../menuView'
import { Section, inputCls } from '../editorUi'

/** Name, category, on/off, SST, print route and takeaway fee: the same in every catalog. */
export default function DetailsSection({ form, onChange, categories, problem }: {
  form: ProductForm
  onChange: (f: ProductForm) => void
  categories: LookupCategory[]
  problem: string | null
}) {
  const set = (patch: Partial<ProductForm>) => onChange({ ...form, ...patch })
  // active categories, plus the product's own even when it is switched off
  const choices = categories.filter((c) => c.isActive || c.id === form.categoryId)
  const routes: string[] = [...PRINT_ROUTES]
  if (form.printRoute && !routes.includes(form.printRoute)) routes.push(form.printRoute)
  return (
    <Section title="Details" hint="These apply in every catalog." problem={problem}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">Name
          <input className={`${inputCls} mt-1 w-full`} value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="block text-sm">Internal name <span className="text-brown-muted">(optional)</span>
          <input className={`${inputCls} mt-1 w-full`} value={form.internalName} onChange={(e) => set({ internalName: e.target.value })} />
        </label>
        <label className="block text-sm sm:col-span-2">Description <span className="text-brown-muted">(optional, shown on QR)</span>
          <textarea className={`${inputCls} mt-1 w-full`} rows={2} value={form.description}
            onChange={(e) => set({ description: e.target.value })} />
        </label>
        <label className="block text-sm">Category
          <select className={`${inputCls} mt-1 w-full`} value={form.categoryId ?? ''} onChange={(e) => set({ categoryId: e.target.value || null })}>
            <option value="">Choose…</option>
            {choices.map((c) => <option key={c.id} value={c.id}>{c.name}{c.isActive ? '' : ' (off)'}</option>)}
          </select>
        </label>
        <label className="block text-sm">Print route
          <select className={`${inputCls} mt-1 w-full`} value={form.printRoute ?? ''} onChange={(e) => set({ printRoute: e.target.value || null })}>
            <option value="">Not printed</option>
            {routes.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <label className="block text-sm">SST
          <select className={`${inputCls} mt-1 w-full`} value={form.sstRateBp} onChange={(e) => set({ sstRateBp: Number(e.target.value) })}>
            {SST_CHOICES.map((c) => <option key={c.bp} value={c.bp}>{c.label}</option>)}
          </select>
        </label>
        <label className="block text-sm">Takeaway packaging fee (RM)
          <input className={`${inputCls} mt-1 w-full`} inputMode="decimal" value={form.takeawayFee}
            onChange={(e) => set({ takeawayFee: e.target.value })} />
        </label>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.isActive} onChange={(e) => set({ isActive: e.target.checked })} />
          On sale (a switched-off product is hidden in every catalog)
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.isAddon} onChange={(e) => set({ isAddon: e.target.checked })} />
          Add-on item (sold only as an option of an add-on group)
        </label>
      </div>
    </Section>
  )
}
