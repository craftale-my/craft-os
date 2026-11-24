// src/features/pos/menu/product/CatalogsSection.tsx
import type { Availability } from '../feedmeExport'
import type { LookupCatalog } from '../menuEditorApi'
import { CATALOG_AVAILABILITY_LABELS } from '../menuView'
import { fillCatalogBlanks, setCatalogAvailability, setCatalogPrice, type ProductForm } from '../productForm'
import { Section, inputCls, linkBtnCls } from '../editorUi'

/** One row per catalog: does it sell the product, on which channel, at what price per
 *  active variant. Putting the product in a catalog pre-fills the default prices. */
export default function CatalogsSection({ form, onChange, catalogs, problem }: {
  form: ProductForm
  onChange: (f: ProductForm) => void
  catalogs: LookupCatalog[]
  problem: string | null
}) {
  const byId = new Map(catalogs.map((c) => [c.id, c]))
  const variants = form.variants.filter((v) => v.isActive)
  return (
    <Section title="Catalogs"
      hint="Each catalog sells the product at its own prices. A catalog that sells it needs a price for every active variant."
      problem={problem}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-brown-muted">
            <tr>
              <th className="py-1 pr-2">Catalog</th>
              <th className="py-1 pr-2">Sells it</th>
              {variants.map((v) => <th key={v.ref} className="py-1 pr-2">{v.name || 'New variant'} (RM)</th>)}
              <th />
            </tr>
          </thead>
          <tbody>
            {form.catalogs.map((c) => {
              const cat = byId.get(c.catalogId)
              const sells = c.availability !== 'hidden'
              const blanks = sells && variants.some((v) => (c.prices[v.ref] ?? '').trim() === '')
              return (
                <tr key={c.catalogId} className={`border-t border-border ${cat?.isActive === false ? 'text-brown-faint' : ''}`}>
                  <td className="py-1 pr-2">{cat?.name ?? 'Unknown catalog'}{cat?.isActive === false ? ' (off)' : ''}</td>
                  <td className="py-1 pr-2">
                    <select className={inputCls} value={c.availability} aria-label={`${cat?.name ?? 'Catalog'} availability`}
                      onChange={(e) => onChange(setCatalogAvailability(form, c.catalogId, e.target.value as Availability))}>
                      {(Object.keys(CATALOG_AVAILABILITY_LABELS) as Availability[]).map((a) => (
                        <option key={a} value={a}>{CATALOG_AVAILABILITY_LABELS[a]}</option>
                      ))}
                    </select>
                  </td>
                  {variants.map((v) => (
                    <td key={v.ref} className="py-1 pr-2">
                      <input className={`${inputCls} w-24`} inputMode="decimal" disabled={!sells}
                        aria-label={`${cat?.name ?? 'Catalog'} price of ${v.name}`}
                        value={c.prices[v.ref] ?? ''}
                        onChange={(e) => onChange(setCatalogPrice(form, c.catalogId, v.ref, e.target.value))} />
                    </td>
                  ))}
                  <td className="py-1 text-right">
                    {blanks && (
                      <button type="button" className={linkBtnCls} onClick={() => onChange(fillCatalogBlanks(form, c.catalogId))}>
                        Use default prices
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Section>
  )
}
