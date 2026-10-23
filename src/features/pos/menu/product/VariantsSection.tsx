// src/features/pos/menu/product/VariantsSection.tsx
import { MAX_VARIANTS, addVariant, moveVariant, removeNewVariant, updateVariant, type ProductForm } from '../productForm'
import { Section, inputCls, linkBtnCls } from '../editorUi'

/** Variants in their order on the pad. A saved variant is never deleted (orders name
 *  it): it is switched off. The default price pre-fills a catalog's price. */
export default function VariantsSection({ form, onChange, problem }: {
  form: ProductForm
  onChange: (f: ProductForm) => void
  problem: string | null
}) {
  return (
    <Section title="Variants"
      hint="The default price fills in a catalog's price when the product is put in that catalog. A saved variant cannot be deleted — switch it off."
      problem={problem}>
      <table className="w-full text-sm">
        <thead className="text-left text-brown-muted">
          <tr><th className="py-1">Name</th><th className="py-1">Default price (RM)</th><th className="py-1">On</th><th /></tr>
        </thead>
        <tbody>
          {form.variants.map((v, i) => (
            <tr key={v.ref} className="border-t border-border">
              <td className="py-1 pr-2">
                <input className={`${inputCls} w-full`} value={v.name} placeholder="e.g. Hot" aria-label={`Variant ${i + 1} name`}
                  onChange={(e) => onChange(updateVariant(form, v.ref, { name: e.target.value }))} />
              </td>
              <td className="py-1 pr-2">
                <input className={`${inputCls} w-28`} inputMode="decimal" value={v.price} aria-label={`Variant ${i + 1} default price (RM)`}
                  onChange={(e) => onChange(updateVariant(form, v.ref, { price: e.target.value }))} />
              </td>
              <td className="py-1 pr-2">
                <input type="checkbox" aria-label={`${v.name || 'Variant'} on`} checked={v.isActive}
                  onChange={(e) => onChange(updateVariant(form, v.ref, { isActive: e.target.checked }))} />
              </td>
              <td className="whitespace-nowrap py-1 text-right">
                <button type="button" className={linkBtnCls} disabled={i === 0} aria-label="Move up"
                  onClick={() => onChange(moveVariant(form, i, -1))}>↑</button>{' '}
                <button type="button" className={linkBtnCls} disabled={i === form.variants.length - 1} aria-label="Move down"
                  onClick={() => onChange(moveVariant(form, i, 1))}>↓</button>{' '}
                {v.id === null && (
                  <button type="button" className={linkBtnCls} onClick={() => onChange(removeNewVariant(form, v.ref))}>Remove</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className={linkBtnCls} disabled={form.variants.length >= MAX_VARIANTS}
        onClick={() => onChange(addVariant(form))}>Add variant</button>
    </Section>
  )
}
