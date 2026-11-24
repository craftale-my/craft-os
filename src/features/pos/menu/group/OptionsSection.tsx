// src/features/pos/menu/group/OptionsSection.tsx
import { Fragment, useState } from 'react'
import type { Availability } from '../feedmeExport'
import type { LookupAddOn, LookupCatalog } from '../menuEditorApi'
import {
  MAX_OPTIONS, OPTION_AVAILABILITY_LABELS, addOption, moveOption, removeNewOption, setOptionCatalogPrice, updateOption,
  type GroupForm,
} from '../groupForm'
import { Section, inputCls, linkBtnCls } from '../editorUi'

/** The options in their order, each with its own price and, behind "Catalog prices",
 *  a price per catalog (blank = the option's own price). */
export default function OptionsSection({ form, onChange, addOns, catalogs, problem }: {
  form: GroupForm
  onChange: (f: GroupForm) => void
  addOns: LookupAddOn[]
  catalogs: LookupCatalog[]
  problem: string | null
}) {
  const [open, setOpen] = useState<string | null>(null)                    // the option showing its catalog prices
  const addOnName = new Map(addOns.map((a) => [a.id, a.name]))
  return (
    <Section title="Options"
      hint="An add-on item links the option to a product: its sold-out switch and print route then apply. A saved option cannot be deleted — switch it off."
      problem={problem}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-brown-muted">
            <tr>
              <th className="py-1 pr-2">Name</th><th className="py-1 pr-2">Add-on item</th><th className="py-1 pr-2">Price (RM)</th>
              <th className="py-1 pr-2">Default</th><th className="py-1 pr-2">Offered</th><th />
            </tr>
          </thead>
          <tbody>
            {form.options.map((o, i) => (
              <Fragment key={o.ref}>
                <tr className="border-t border-border">
                  <td className="py-1 pr-2">
                    <input className={`${inputCls} w-full`} aria-label={`Option ${i + 1} name`} value={o.name}
                      onChange={(e) => onChange(updateOption(form, o.ref, { name: e.target.value }))} />
                  </td>
                  <td className="py-1 pr-2">
                    <select className={inputCls} aria-label={`Option ${i + 1} add-on item`} value={o.productId ?? ''}
                      onChange={(e) => onChange(updateOption(form, o.ref, { productId: e.target.value || null }))}>
                      <option value="">None</option>
                      {o.productId && !addOnName.has(o.productId) && <option value={o.productId}>(not an add-on item)</option>}
                      {addOns.map((a) => <option key={a.id} value={a.id}>{a.name}{a.isActive ? '' : ' (off)'}</option>)}
                    </select>
                  </td>
                  <td className="py-1 pr-2">
                    <input className={`${inputCls} w-20`} inputMode="decimal" aria-label={`Option ${i + 1} price (RM)`} value={o.price}
                      onChange={(e) => onChange(updateOption(form, o.ref, { price: e.target.value }))} />
                  </td>
                  <td className="py-1 pr-2">
                    <input type="checkbox" aria-label={`${o.name || 'Option'} is a default`} checked={o.isDefault}
                      onChange={(e) => onChange(updateOption(form, o.ref, { isDefault: e.target.checked }))} />
                  </td>
                  <td className="py-1 pr-2">
                    <select className={inputCls} aria-label={`Option ${i + 1} offered`} value={o.availability}
                      onChange={(e) => onChange(updateOption(form, o.ref, { availability: e.target.value as Availability }))}>
                      {(Object.keys(OPTION_AVAILABILITY_LABELS) as Availability[]).map((a) => (
                        <option key={a} value={a}>{OPTION_AVAILABILITY_LABELS[a]}</option>
                      ))}
                    </select>
                  </td>
                  <td className="whitespace-nowrap py-1 text-right">
                    <button type="button" className={linkBtnCls} onClick={() => setOpen(open === o.ref ? null : o.ref)}>
                      Catalog prices{Object.values(o.catalogPrices).some((t) => t.trim() !== '') ? ' •' : ''}
                    </button>{' '}
                    <button type="button" className={linkBtnCls} disabled={i === 0} aria-label={`Move option ${i + 1} up`}
                      onClick={() => onChange(moveOption(form, i, -1))}>↑</button>{' '}
                    <button type="button" className={linkBtnCls} disabled={i === form.options.length - 1} aria-label={`Move option ${i + 1} down`}
                      onClick={() => onChange(moveOption(form, i, 1))}>↓</button>{' '}
                    {o.id === null && (
                      <button type="button" className={linkBtnCls} onClick={() => onChange(removeNewOption(form, o.ref))}>Remove</button>
                    )}
                  </td>
                </tr>
                {open === o.ref && (
                  <tr>
                    <td colSpan={6} className="bg-cream px-3 py-2">
                      <div className="text-xs text-brown-muted">Price in each catalog — leave blank to charge RM {o.price || '…'}</div>
                      <div className="mt-1 flex flex-wrap gap-3">
                        {catalogs.map((c) => (
                          <label key={c.id} className="text-xs">{c.name}{c.isActive ? '' : ' (off)'}
                            <input className={`${inputCls} ml-1 w-20`} inputMode="decimal" aria-label={`Option ${i + 1} ${c.name} price (RM)`} value={o.catalogPrices[c.id] ?? ''}
                              onChange={(e) => onChange(setOptionCatalogPrice(form, o.ref, c.id, e.target.value))} />
                          </label>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={linkBtnCls} disabled={form.options.length >= MAX_OPTIONS}
          onClick={() => onChange(addOption(form))}>Add option</button>
        <select className={inputCls} value="" disabled={form.options.length >= MAX_OPTIONS}
          onChange={(e) => {
            const a = addOns.find((x) => x.id === e.target.value)
            if (a) onChange(addOption(form, { id: a.id, name: a.name }))
          }}>
          <option value="">Add an add-on item as an option…</option>
          {addOns.filter((a) => a.isActive).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
    </Section>
  )
}
