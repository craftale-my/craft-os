// src/features/pos/menu/catalogGrid.ts
/** One row of a catalog's page: does the catalog sell the product, on which channel, at
 *  what price per variant. Pure; menu_save_catalog_row checks it again in the same words. */
import type { Availability } from './feedmeExport'
import type { CatalogRowPayload, GridProduct } from './menuEditorApi'
import { inputToSen, senToInput } from './menuForms'

/** Price boxes by variant id; blank = no price in this catalog. */
export interface GridRowForm { availability: Availability; prices: Record<string, string> }

export function gridRowForm(p: GridProduct): GridRowForm {
  const prices: Record<string, string> = {}
  for (const v of p.variants) if (v.priceSen !== null) prices[v.id] = senToInput(v.priceSen)
  return { availability: p.availability, prices }
}

const norm = (text: string | undefined) => {
  const t = (text ?? '').trim()
  const sen = inputToSen(t)
  return sen === null ? t : String(sen)
}

/** Changed since it was loaded or last saved ("12" and "12.00" are the same price). */
export function gridRowDirty(form: GridRowForm, p: GridProduct): boolean {
  const base = gridRowForm(p)
  return form.availability !== base.availability || p.variants.some((v) => norm(form.prices[v.id]) !== norm(base.prices[v.id]))
}

/** Putting the product in the catalog pre-fills blank prices of active variants with their default price. */
export function setGridAvailability(form: GridRowForm, p: GridProduct, availability: Availability): GridRowForm {
  if (form.availability !== 'hidden' || availability === 'hidden') return { ...form, availability }
  const prices = { ...form.prices }
  for (const v of p.variants) if (v.isActive && (prices[v.id] ?? '').trim() === '') prices[v.id] = senToInput(v.defaultSen)
  return { availability, prices }
}

/** Only boxes the owner can see count: a row that sells the product, its active variants. */
export function gridRowProblem(form: GridRowForm, p: GridProduct, catalogName: string): string | null {
  if (form.availability === 'hidden') return null
  for (const v of p.variants.filter((x) => x.isActive)) {
    const text = (form.prices[v.id] ?? '').trim()
    if (text === '') return `${catalogName}: enter a price for ${v.name}`
    if (inputToSen(text) === null) return `${catalogName}: the price of ${v.name} is not an amount in RM`
  }
  return null
}

/** What menu_save_catalog_row takes. Call it only when gridRowProblem() is null. A row that
 *  does not sell the product, and a switched-off variant, send no prices (the server keeps them). */
export function gridRowPayload(form: GridRowForm, p: GridProduct, catalogId: string): CatalogRowPayload {
  return {
    catalogId,
    productId: p.id,
    availability: form.availability,
    prices: form.availability === 'hidden' ? [] : p.variants.flatMap((v) => {
      const sen = v.isActive ? inputToSen((form.prices[v.id] ?? '').trim()) : null
      return sen === null ? [] : [{ variantId: v.id, priceSen: sen }]
    }),
  }
}

/** The product as the server now holds it, so the row is clean again without reloading the grid.
 *  Only the prices gridRowPayload sent change (prices are never deleted). */
export function gridProductAfterSave(p: GridProduct, form: GridRowForm): GridProduct {
  const sent = new Map(gridRowPayload(form, p, '').prices.map((x) => [x.variantId, x.priceSen]))
  return { ...p, availability: form.availability, variants: p.variants.map((v) => ({ ...v, priceSen: sent.get(v.id) ?? v.priceSen })) }
}

export type GridShow = 'all' | 'in' | 'out'
export interface GridSection { title: string; products: GridProduct[] }

/** Rows by category in the server's order, filtered by name and by in / out of the catalog. */
export function gridSections(products: GridProduct[], search: string, show: GridShow): GridSection[] {
  const q = search.trim().toLowerCase()
  const out: GridSection[] = []
  for (const p of products) {
    const sells = p.availability !== 'hidden'
    if ((show === 'in' && !sells) || (show === 'out' && sells)) continue
    if (q && !p.name.toLowerCase().includes(q)) continue
    const last = out[out.length - 1]
    if (last && last.title === p.category) last.products.push(p)
    else out.push({ title: p.category, products: [p] })
  }
  return out
}
