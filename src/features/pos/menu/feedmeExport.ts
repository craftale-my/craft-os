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

/** The Feedme catalog whose "Order from" decides the shop's menu (user's choice, 2026-10-22). */
export const FEEDME_CATALOG = 'Craft Cafe'

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

export function buildMenuImport(files: FeedmeFiles, catalog: string): { payload: MenuImport; warnings: string[] } {
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
  const addon = sheetOf(files.addonGroup, catalog, 'the add-on group file')
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
