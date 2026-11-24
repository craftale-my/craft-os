// src/features/pos/menu/productForm.ts
/** The product editor's form: pure, so every rule is tested. The server
 *  (menu_save_product) checks all of it again with the same words; this only lets
 *  the owner see a problem next to its section before pressing Save. */
import type { Availability } from './feedmeExport'
import type { ProductDetail, ProductDetails, ProductPayload } from './menuEditorApi'
import { cleanName, inputToSen, moveItem, nameProblem, nextRef, senToInput } from './menuForms'
import { parseFeeSen } from './productGroups'

/** A variant row. `ref` is the variant id once saved, new-N before. Prices are box text. */
export interface VariantForm { ref: string; id: string | null; name: string; price: string; isActive: boolean }
/** One catalog: availability and the price box of each variant (by ref; blank = none). */
export interface CatalogForm { catalogId: string; availability: Availability; prices: Record<string, string> }
export interface ProductForm {
  id: string | null
  name: string
  internalName: string
  description: string
  categoryId: string | null
  sstRateBp: number
  printRoute: string | null
  takeawayFee: string
  isActive: boolean
  isAddon: boolean
  variants: VariantForm[]
  groupIds: string[]
  catalogs: CatalogForm[]
}
/** The sections this form saves. Photo and Time slots (M3) save on their own (product/PhotoSection.tsx, product/TimeSlotsSection.tsx). */
export type ProductSection = 'details' | 'variants' | 'groups' | 'catalogs'
export interface ProductProblem { section: ProductSection; message: string }

export const MAX_VARIANTS = 30
export const MAX_GROUPS = 30

/** A new product: one active "Regular" variant, in no catalog. */
export function emptyProductForm(catalogIds: string[], categoryId: string | null = null): ProductForm {
  return {
    id: null, name: '', internalName: '', description: '', categoryId, sstRateBp: 600, printRoute: null,
    takeawayFee: '0.00', isActive: true, isAddon: false,
    variants: [{ ref: 'new-1', id: null, name: 'Regular', price: '', isActive: true }],
    groupIds: [],
    catalogs: catalogIds.map((catalogId) => ({ catalogId, availability: 'hidden', prices: {} })),
  }
}

/** The form for a saved product. Catalogs come in `catalogIds` order (the lookups'). */
export function productFormFromDetail(d: ProductDetail, catalogIds: string[]): ProductForm {
  const byCatalog = new Map(d.catalogs.map((c) => [c.catalogId, c]))
  return {
    id: d.id, name: d.name, internalName: d.internalName ?? '', description: d.description ?? '',
    categoryId: d.categoryId, sstRateBp: d.sstRateBp, printRoute: d.printRoute, takeawayFee: senToInput(d.takeawayFeeSen),
    isActive: d.isActive, isAddon: d.isAddon,
    variants: d.variants.map((v) => ({ ref: v.id, id: v.id, name: v.name, price: senToInput(v.priceSen), isActive: v.isActive })),
    groupIds: [...d.groupIds],
    catalogs: catalogIds.map((catalogId) => {
      const c = byCatalog.get(catalogId)
      const prices: Record<string, string> = {}
      for (const v of d.variants) {
        const sen = c?.prices[v.id]
        if (sen !== undefined) prices[v.id] = senToInput(sen)
      }
      return { catalogId, availability: c?.availability ?? 'hidden', prices }
    }),
  }
}

// ── variants ────────────────────────────────────────────────────────────────
export function addVariant(f: ProductForm): ProductForm {
  return { ...f, variants: [...f.variants, { ref: nextRef(f.variants), id: null, name: '', price: '', isActive: true }] }
}

export function updateVariant(f: ProductForm, ref: string, patch: Partial<Pick<VariantForm, 'name' | 'price' | 'isActive'>>): ProductForm {
  return { ...f, variants: f.variants.map((v) => (v.ref === ref ? { ...v, ...patch } : v)) }
}

export function moveVariant(f: ProductForm, index: number, delta: number): ProductForm {
  return { ...f, variants: moveItem(f.variants, index, delta) }
}

/** Only a variant that was never saved can be removed; a saved one is switched off. */
export function removeNewVariant(f: ProductForm, ref: string): ProductForm {
  if (f.variants.find((v) => v.ref === ref)?.id !== null) return f
  return {
    ...f,
    variants: f.variants.filter((v) => v.ref !== ref),
    catalogs: f.catalogs.map((c) => {
      const prices = { ...c.prices }
      delete prices[ref]
      return { ...c, prices }
    }),
  }
}

// ── add-on groups ───────────────────────────────────────────────────────────
export function addGroup(f: ProductForm, groupId: string): ProductForm {
  return f.groupIds.includes(groupId) ? f : { ...f, groupIds: [...f.groupIds, groupId] }
}
export function removeGroup(f: ProductForm, groupId: string): ProductForm {
  return { ...f, groupIds: f.groupIds.filter((g) => g !== groupId) }
}
export function moveGroup(f: ProductForm, index: number, delta: number): ProductForm {
  return { ...f, groupIds: moveItem(f.groupIds, index, delta) }
}

// ── catalogs ────────────────────────────────────────────────────────────────
function patchCatalog(f: ProductForm, catalogId: string, fn: (c: CatalogForm) => CatalogForm): ProductForm {
  return { ...f, catalogs: f.catalogs.map((c) => (c.catalogId === catalogId ? fn(c) : c)) }
}

/** Blank price boxes of active variants take the variant's default price (when it is an amount). */
function fillBlanks(f: ProductForm, c: CatalogForm): CatalogForm {
  const prices = { ...c.prices }
  for (const v of f.variants) {
    const sen = inputToSen(v.price)
    if (v.isActive && (prices[v.ref] ?? '').trim() === '' && sen !== null) prices[v.ref] = senToInput(sen)
  }
  return { ...c, prices }
}

/** Putting a product in a catalog pre-fills its blank prices with the default prices (spec §4). */
export function setCatalogAvailability(f: ProductForm, catalogId: string, availability: Availability): ProductForm {
  return patchCatalog(f, catalogId, (c) => {
    const next = { ...c, availability }
    return c.availability === 'hidden' && availability !== 'hidden' ? fillBlanks(f, next) : next
  })
}

export function setCatalogPrice(f: ProductForm, catalogId: string, ref: string, text: string): ProductForm {
  return patchCatalog(f, catalogId, (c) => ({ ...c, prices: { ...c.prices, [ref]: text } }))
}

/** "Use default prices": fills the catalog's blank boxes (e.g. after a variant was added). */
export function fillCatalogBlanks(f: ProductForm, catalogId: string): ProductForm {
  return patchCatalog(f, catalogId, (c) => fillBlanks(f, c))
}

// ── problems and payload ───────────────────────────────────────────────────
const variantLabel = (v: VariantForm) => cleanName(v.name) || 'the new variant'

/** Every problem that would stop a save, in section order. `catalogName` names a catalog. */
export function productProblems(f: ProductForm, catalogName: (id: string) => string): ProductProblem[] {
  const out: ProductProblem[] = []
  const add = (section: ProductSection, message: string | null) => { if (message) out.push({ section, message }) }

  add('details', nameProblem('Product', f.name, 120))
  if (!f.categoryId) add('details', 'Choose a category')
  if (f.internalName.trim().length > 120) add('details', 'Internal name is too long (at most 120 characters)')
  if (f.description.trim().length > 1000) add('details', 'Description is too long (at most 1000 characters)')
  // the same rule as the Takeaway fees page's bulk bar: no commas, at most RM 10.00 (an empty box is refused, as it always was)
  const fee = parseFeeSen(f.takeawayFee, { allowZero: true })
  if ('problem' in fee) add('details', fee.problem)

  if (f.variants.length > MAX_VARIANTS) add('variants', `Too many variants (at most ${MAX_VARIANTS})`)
  for (const v of f.variants) {
    add('variants', nameProblem('Variant', v.name, 60))
    if (inputToSen(v.price) === null) add('variants', `Enter the default price of ${variantLabel(v)} in RM, e.g. 12.50`)
  }
  const active = f.variants.filter((v) => v.isActive)
  if (active.length === 0) add('variants', 'A product needs at least one active variant')
  const first = new Map<string, string>()                    // lower-case name → the first variant's name
  for (const v of active) {
    const key = cleanName(v.name).toLowerCase()
    if (!key) continue
    if (first.has(key)) add('variants', `Two variants are called ${first.get(key)}`)
    else first.set(key, cleanName(v.name))
  }

  if (f.groupIds.length > MAX_GROUPS) add('groups', `Too many add-on groups (at most ${MAX_GROUPS})`)

  // only boxes the owner can see count: a catalog that sells the product, an active variant
  for (const c of f.catalogs) {
    if (c.availability === 'hidden') continue
    for (const v of active) {
      const text = (c.prices[v.ref] ?? '').trim()
      if (text === '') add('catalogs', `${catalogName(c.catalogId)}: enter a price for ${variantLabel(v)}`)
      else if (inputToSen(text) === null) add('catalogs', `${catalogName(c.catalogId)}: the price of ${variantLabel(v)} is not an amount in RM`)
    }
  }
  return out
}

/** A catalog's price boxes as sen, for comparing (a blank or hidden box counts as no price). */
function catalogKey(f: ProductForm, c: CatalogForm | undefined): string {
  if (!c) return ''
  const prices = c.availability === 'hidden' ? [] : f.variants.filter((v) => v.isActive)
    .map((v) => `${v.ref}=${inputToSen((c.prices[v.ref] ?? '').trim()) ?? ''}`)
  return `${c.availability}|${prices.join(',')}`
}

/** The product's own fields as menu_save_product takes them. */
function details(f: ProductForm, feeSen: (text: string) => number): ProductDetails {
  return {
    name: cleanName(f.name),
    internalName: f.internalName.trim() || null,
    description: f.description.trim() || null,
    categoryId: f.categoryId,
    sstRateBp: f.sstRateBp,
    printRoute: f.printRoute,
    takeawayFeeSen: feeSen(f.takeawayFee),
    isActive: f.isActive,
    isAddon: f.isAddon,
  }
}

/** The form differs from the one loaded (the editor then warns before the page is left). */
export function productFormDirty(f: ProductForm, loaded: ProductForm | null): boolean {
  return loaded === null || JSON.stringify(f) !== JSON.stringify(loaded)
}

/** What menu_save_product takes. Call it only when productProblems() is empty.
 *  For a saved product (`loaded` = the form as it was loaded) only the details and the
 *  catalogs the owner changed are sent — plus every catalog when a variant was added or
 *  switched on — so a save never undoes what the Products or catalog page changed
 *  meanwhile. Every variant is always sent. Hidden catalogs and switched-off variants
 *  send no prices (their boxes are not shown). */
export function productPayload(f: ProductForm, loaded: ProductForm | null = null): ProductPayload {
  const sen = (text: string): number => {
    const v = inputToSen(text)
    if (v === null) throw new Error(`"${text}" is not an amount in RM`)
    return v
  }
  const feeSen = (text: string): number => {
    const r = parseFeeSen(text, { allowZero: true })
    if ('problem' in r) throw new Error(`"${text}" is not a valid takeaway fee: ${r.problem}`)
    return r.value
  }
  const isNew = f.id === null || loaded === null
  const mine = details(f, feeSen)
  let changed: Partial<ProductDetails> = mine
  if (!isNew) {
    const before = details(loaded, (t) => {
      const r = parseFeeSen(t, { allowZero: true })
      return 'value' in r ? r.value : -1
    })
    changed = Object.fromEntries((Object.keys(mine) as (keyof ProductDetails)[])
      .filter((k) => mine[k] !== before[k]).map((k) => [k, mine[k]])) as Partial<ProductDetails>
  }
  const wasOn = new Set(loaded?.variants.filter((v) => v.isActive).map((v) => v.ref) ?? [])
  const variantsGrew = f.variants.some((v) => v.isActive && !wasOn.has(v.ref))
  const catalogs = isNew || variantsGrew
    ? f.catalogs
    : f.catalogs.filter((c) => catalogKey(f, c) !== catalogKey(loaded, loaded.catalogs.find((x) => x.catalogId === c.catalogId)))
  return {
    id: f.id,
    ...changed,
    variants: f.variants.map((v) => ({ ref: v.ref, id: v.id, name: cleanName(v.name), priceSen: sen(v.price), isActive: v.isActive })),
    groupIds: [...f.groupIds],
    catalogs: catalogs.map((c) => ({
      catalogId: c.catalogId,
      availability: c.availability,
      prices: c.availability === 'hidden' ? [] : f.variants.flatMap((v) => {
        const text = (c.prices[v.ref] ?? '').trim()
        return !v.isActive || text === '' ? [] : [{ ref: v.ref, priceSen: sen(text) }]
      }),
    })),
  }
}
