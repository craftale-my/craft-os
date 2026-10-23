import { unzipSync } from 'fflate'
import { readXlsx, type Sheet, type Workbook } from './xlsx'

export type Availability = 'all' | 'counter_only' | 'hidden'

export interface ImportVariant { key: string; name: string; priceSen: number; sortOrder: number }
export interface ImportProduct {
  feedmeId: string
  name: string
  internalName: string | null
  description: string | null
  category: string
  availability: Availability
  isAddon: boolean
  takeawayFeeSen: number
  sortOrder: number
  variants: ImportVariant[]
}
export interface ImportOption {
  productFeedmeId: string
  variantKey: string
  name: string
  priceSen: number
  isDefault: boolean
  availability: Availability
  sortOrder: number
}
export interface ImportGroup {
  feedmeId: string
  name: string
  min: number
  max: number
  stackable: boolean
  sortOrder: number
  options: ImportOption[]
}
export interface ImportLink { productFeedmeId: string; groupFeedmeId: string; sortOrder: number }
export interface MenuImport {
  categories: { name: string; sortOrder: number }[]
  products: ImportProduct[]
  groups: ImportGroup[]
  links: ImportLink[]
}
export interface FeedmeFiles { menu: Workbook; addonGroup: Workbook; itemLinkedAddon: Workbook }

/** Feedme's master sheets (every product, default prices, every add-on group). */
export const MASTER_MENU_SHEET = 'Default Catalog'
export const MASTER_ADDON_SHEET = 'Default AddonGroup'

/** One Feedme catalog sheet as menu_import_catalogs takes it: only the products the
 *  catalog sells (base row "Order from" ALL / POS_ONLY), a price for every variant
 *  of the master product, and the add-on prices that differ from the default. */
export interface ImportCatalogProduct {
  feedmeId: string
  availability: 'all' | 'counter_only'
  sortOrder: number
  prices: { key: string; priceSen: number }[]
}
export interface ImportOptionPrice { groupFeedmeId: string; productFeedmeId: string; variantKey: string; priceSen: number }
export interface ImportCatalog { name: string; sortOrder: number; products: ImportCatalogProduct[]; optionPrices: ImportOptionPrice[] }
export interface CatalogsImport extends MenuImport { catalogs: ImportCatalog[] }

const AVAILABILITY: Record<string, Availability> = { ALL: 'all', POS_ONLY: 'counter_only', NONE: 'hidden' }

export const clean = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()

/** "11.5" → 1150. Blank, non-numeric or negative → null. */
export function toSen(raw: string | undefined): number | null {
  const s = clean(raw)
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null
}

/** Column index by header name. Feedme headers carry a hint in brackets,
 *  e.g. "Product ID (For update do not modify, …)", so "Product ID" matches
 *  the header itself or the header followed by " (". */
function columns(header: string[], names: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const name of names) {
    const i = header.findIndex((h) => {
      const c = clean(h)
      return c === name || c.startsWith(`${name} (`)
    })
    if (i < 0) throw new Error(`Column "${name}" not found — is this a Feedme menu export?`)
    out[name] = i
  }
  return out
}

function sheetOf(wb: Workbook, name: string, file: string): Sheet {
  const s = wb[name]
  if (!s || s.length === 0) throw new Error(`Sheet "${name}" not found in ${file}`)
  return s
}

/** Unzips Feedme's "Export" download (books_<date>.zip). */
export function readFeedmeExport(zip: Uint8Array): FeedmeFiles {
  const entries = unzipSync(zip)
  const find = (prefix: string): Workbook => {
    const name = Object.keys(entries).find((n) => {
      const base = n.split('/').pop() ?? n
      return base.startsWith(`${prefix}_`) && base.endsWith('.xlsx')
    })
    if (!name) throw new Error(`The zip has no ${prefix}_….xlsx — is this a Feedme menu export?`)
    return readXlsx(entries[name])
  }
  return { menu: find('menu'), addonGroup: find('addonGroup'), itemLinkedAddon: find('itemLinkedAddon') }
}

/** The master list from one menu sheet and one add-on sheet (by default the sheet of
 *  the same name); add-on links from the link sheets' column named `catalog`. */
export function buildMenuImport(
  files: FeedmeFiles, catalog: string, addonSheet: string = catalog,
): { payload: MenuImport; warnings: string[] } {
  const warnings: string[] = []

  // ── products and variants ────────────────────────────────────────────────
  const menu = sheetOf(files.menu, catalog, 'the menu file')
  const mc = columns(menu[0], [
    'Product ID', 'Name', 'Internal name', 'Description', 'Variant key', 'Variant Name',
    'Category', 'Order from', 'Selling price', 'Takeaway price',
  ])
  const products = new Map<string, ImportProduct>()
  const basePrice = new Map<string, number>()
  const skipped = new Set<string>()
  const categories: string[] = []

  menu.slice(1).forEach((r, i) => {
    const id = clean(r[mc['Product ID']])
    if (!id || skipped.has(id)) return
    const key = clean(r[mc['Variant key']])
    const rawPrice = clean(r[mc['Selling price']])
    const price = toSen(rawPrice)

    if (!key) {
      const name = clean(r[mc['Name']])
      if (products.has(id)) {
        warnings.push(`${name || id}: second base row for the same Product ID — skipped`)
        return
      }
      if (!name) {
        warnings.push(`Product ${id} has no name — skipped`)
        skipped.add(id)
        return
      }
      if (price === null) {
        warnings.push(`${name}: price "${rawPrice}" is not a number — skipped`)
        skipped.add(id)
        return
      }
      const category = clean(r[mc['Category']]) || 'Uncategorised'
      if (!categories.includes(category)) categories.push(category)
      const orderFrom = clean(r[mc['Order from']]).toUpperCase()
      const availability = AVAILABILITY[orderFrom]
      if (!availability) warnings.push(`${name}: unknown "Order from" value "${orderFrom}" — hidden`)
      basePrice.set(id, price)
      products.set(id, {
        feedmeId: id,
        name,
        internalName: clean(r[mc['Internal name']]) || null,
        description: clean(r[mc['Description']]) || null,
        category,
        availability: availability ?? 'hidden',
        isAddon: category.toUpperCase() === 'ADDON',
        takeawayFeeSen: toSen(r[mc['Takeaway price']]) ?? 0,
        sortOrder: i,
        variants: [],
      })
      return
    }

    const p = products.get(id)
    if (!p) {
      warnings.push(`Variant row for unknown product ${id} — skipped`)
      return
    }
    const variantName = clean(r[mc['Variant Name']]) || key
    if (p.variants.some((v) => v.key === key)) {
      warnings.push(`${p.name} / ${variantName}: duplicate variant key — skipped`)
      return
    }
    if (price === null) {
      warnings.push(`${p.name} / ${variantName}: price "${rawPrice}" is not a number — variant skipped`)
      return
    }
    p.variants.push({ key, name: variantName, priceSen: price, sortOrder: p.variants.length })
  })

  for (const p of products.values()) {
    if (p.variants.length === 0) p.variants.push({ key: '', name: 'Regular', priceSen: basePrice.get(p.feedmeId) ?? 0, sortOrder: 0 })
  }

  // ── modifier groups ──────────────────────────────────────────────────────
  const addon = sheetOf(files.addonGroup, addonSheet, 'the add-on group file')
  const gc = columns(addon[0], [
    'Group ID', 'Group Name', 'Min', 'Max', 'Stackable', 'Item ID', 'Item Name',
    'Item Name Overrider', 'Variant Key', 'Item price', 'Order from', 'isDefault',
  ])
  const groups = new Map<string, ImportGroup>()
  for (const r of addon.slice(1)) {
    const gid = clean(r[gc['Group ID']])
    if (!gid) continue
    let group = groups.get(gid)
    if (!group) {
      const name = clean(r[gc['Group Name']]) || gid
      const min = Number(clean(r[gc['Min']]) || '0')
      const max = Number(clean(r[gc['Max']]) || '1')
      group = {
        feedmeId: gid,
        name,
        min: Number.isInteger(min) && min >= 0 ? min : 0,
        max: Number.isInteger(max) && max >= 1 ? max : 1,
        stackable: clean(r[gc['Stackable']]).toUpperCase() === 'T',
        sortOrder: groups.size,
        options: [],
      }
      if (group.max < group.min) {
        warnings.push(`${name}: max ${group.max} is below min ${group.min} — max set to ${group.min}`)
        group.max = group.min
      }
      groups.set(gid, group)
    }
    const itemId = clean(r[gc['Item ID']])
    const itemName = clean(r[gc['Item Name']])
    const product = products.get(itemId)
    if (!product) {
      warnings.push(`${group.name}: option "${itemName || itemId}" is not in the menu — skipped`)
      continue
    }
    group.options.push({
      productFeedmeId: itemId,
      variantKey: clean(r[gc['Variant Key']]),
      name: clean(r[gc['Item Name Overrider']]) || itemName || product.name,
      priceSen: toSen(r[gc['Item price']]) ?? 0,
      isDefault: clean(r[gc['isDefault']]).toUpperCase() === 'T',
      availability: AVAILABILITY[clean(r[gc['Order from']]).toUpperCase()] ?? 'all',
      sortOrder: group.options.length,
    })
  }

  // ── links (product → group) ──────────────────────────────────────────────
  const links: ImportLink[] = []
  const seen = new Set<string>()
  let warnedFallback = false
  let usableSheets = 0
  for (const sheet of Object.values(files.itemLinkedAddon)) {
    if (sheet.length === 0) continue
    const lc = columns(sheet[0], ['Group ID', 'Item ID'])
    let flag = sheet[0].findIndex((h) => clean(h) === catalog)
    if (flag < 0) {
      flag = sheet[0].findIndex((h) => clean(h) === 'Default Catalog')
      if (flag < 0) continue
      if (!warnedFallback) {
        warnings.push(`Add-on links have no "${catalog}" column — used "Default Catalog" instead`)
        warnedFallback = true
      }
    }
    usableSheets++
    for (const r of sheet.slice(1)) {
      if (clean(r[flag]).toUpperCase() !== 'T') continue
      const gid = clean(r[lc['Group ID']])
      const pid = clean(r[lc['Item ID']])
      const group = groups.get(gid)
      if (!group || !products.has(pid) || seen.has(`${pid}|${gid}`)) continue
      seen.add(`${pid}|${gid}`)
      links.push({ productFeedmeId: pid, groupFeedmeId: gid, sortOrder: group.sortOrder })
    }
  }

  if (groups.size > 0) {
    if (usableSheets === 0) {
      throw new Error(
        `Invalid import file: no add-on link sheet has a "${catalog}" column — importing would remove every add-on link`,
      )
    }
    if (links.length === 0) warnings.push('No product ↔ add-on links found — importing will remove every add-on link')
  }
  for (const g of groups.values()) {
    if (g.options.length === 0) warnings.push(`${g.name}: no usable options — importing will remove all its options`)
  }

  return {
    payload: {
      categories: categories.map((name, sortOrder) => ({ name, sortOrder })),
      products: [...products.values()],
      groups: [...groups.values()],
      links,
    },
    warnings,
  }
}

/** The whole export: the master from the Default sheets plus one catalog per other
 *  sheet of the menu file (every sheet lists every product; verified 2026-10-24). */
export function buildCatalogsImport(files: FeedmeFiles): { payload: CatalogsImport; warnings: string[] } {
  const { payload: master, warnings } = buildMenuImport(files, MASTER_MENU_SHEET, MASTER_ADDON_SHEET)
  const products = new Map(master.products.map((p) => [p.feedmeId, p]))
  const optionDefaults = new Map<string, number>()            // "group|item|variant" → default price
  for (const g of master.groups) for (const o of g.options) optionDefaults.set(`${g.feedmeId}|${o.productFeedmeId}|${o.variantKey}`, o.priceSen)
  const names = Object.keys(files.menu).filter((n) => n !== MASTER_MENU_SHEET)
  if (names.length === 0) throw new Error('The menu file has no catalog sheets — is this a Feedme menu export?')
  const catalogs = names.map((name, sortOrder) => readCatalog(files, name, sortOrder, products, optionDefaults, warnings))
  warnLinkDifferences(files, warnings)
  return { payload: { ...master, catalogs }, warnings }
}

function readCatalog(
  files: FeedmeFiles, name: string, sortOrder: number, products: Map<string, ImportProduct>,
  optionDefaults: Map<string, number>, warnings: string[],
): ImportCatalog {
  const sheet = sheetOf(files.menu, name, 'the menu file')
  const mc = columns(sheet[0], ['Product ID', 'Variant key', 'Order from', 'Selling price'])
  const rows = new Map<string, { orderFrom: string; row: number; prices: Map<string, number | null> }>()
  sheet.slice(1).forEach((r, i) => {
    const id = clean(r[mc['Product ID']])
    if (!id) return
    const key = clean(r[mc['Variant key']])
    const price = toSen(r[mc['Selling price']])
    let entry = rows.get(id)
    if (!key) {
      if (entry) return                                   // a second base row: the master already warned
      entry = { orderFrom: clean(r[mc['Order from']]).toUpperCase(), row: i, prices: new Map() }
      rows.set(id, entry)
    }
    if (!entry) return                                    // a variant row before its base row: the master warned
    if (!entry.prices.has(key)) entry.prices.set(key, price)
  })

  const out: ImportCatalogProduct[] = []
  for (const [id, e] of rows) {
    if (e.orderFrom !== 'ALL' && e.orderFrom !== 'POS_ONLY') continue      // NONE (or blank): not in this catalog
    const p = products.get(id)
    if (!p) continue                                                        // skipped in the master, which said why
    const prices: { key: string; priceSen: number }[] = []
    const missing = p.variants.find((v) => {
      const price = e.prices.get(v.key) ?? null
      if (price !== null) prices.push({ key: v.key, priceSen: price })
      return price === null
    })
    if (missing) {
      warnings.push(`${name}: ${p.name} / ${missing.name} has no price — left out of this catalog`)
      continue
    }
    out.push({ feedmeId: id, availability: e.orderFrom === 'ALL' ? 'all' : 'counter_only', sortOrder: e.row, prices })
  }

  const optionPrices: ImportOptionPrice[] = []
  const addon = files.addonGroup[name]
  if (!addon || addon.length === 0) {
    warnings.push(`${name}: no add-on price sheet — add-ons use their default prices`)
  } else {
    const gc = columns(addon[0], ['Group ID', 'Item ID', 'Variant Key', 'Item price'])
    const seen = new Set<string>()
    for (const r of addon.slice(1)) {
      const groupFeedmeId = clean(r[gc['Group ID']])
      const productFeedmeId = clean(r[gc['Item ID']])
      const variantKey = clean(r[gc['Variant Key']])
      const k = `${groupFeedmeId}|${productFeedmeId}|${variantKey}`
      const def = optionDefaults.get(k)
      if (def === undefined || seen.has(k)) continue
      seen.add(k)
      const priceSen = toSen(r[gc['Item price']]) ?? 0                      // as the master reads it
      if (priceSen !== def) optionPrices.push({ groupFeedmeId, productFeedmeId, variantKey, priceSen })
    }
  }
  return { name, sortOrder, products: out, optionPrices }
}

/** Links stay global (the Default Catalog column). A link sheet that also carries
 *  catalog columns is compared, so the report says where Feedme differed. */
function warnLinkDifferences(files: FeedmeFiles, warnings: string[]): void {
  const diffs = new Map<string, number>()
  for (const sheet of Object.values(files.itemLinkedAddon)) {
    if (sheet.length === 0) continue
    const header = sheet[0].map((h) => clean(h))
    const master = header.indexOf(MASTER_MENU_SHEET)
    if (master < 0) continue
    header.forEach((h, j) => {
      if (j === master || h === '' || h === 'Group ID' || h === 'Item ID' || h === 'Item Name') return
      for (const r of sheet.slice(1)) {
        if (clean(r[j]).toUpperCase() !== clean(r[master]).toUpperCase()) diffs.set(h, (diffs.get(h) ?? 0) + 1)
      }
    })
  }
  for (const [catalog, n] of diffs) {
    warnings.push(`${catalog}: ${n} add-on link${n === 1 ? ' differs' : 's differ'} from the Default Catalog — Craft OS uses the Default Catalog links for every catalog`)
  }
}
