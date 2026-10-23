// src/features/pos/order/cart.ts
/** Pure order model shared by the staff POS and the customer QR page. The
 *  rules here mirror pos_insert_order (migration-2026-10-24-pos-catalogs-fn.sql)
 *  so a line the client accepts is one the server accepts, with the same words.
 *  Prices here are a preview only — the server re-prices every line. */

export type Availability = 'all' | 'counter_only' | 'hidden'
export type OrderMode = 'counter' | 'qr'

export interface OrderLine {
  productId: string
  variantId: string
  qty: number
  note: string | null
  optionIds: string[]
}

export interface PosVariant { id: string; name: string; priceSen: number; isBase: boolean }
export interface PosOption { id: string; name: string; priceDeltaSen: number; isDefault: boolean; available: boolean }
export interface PosGroup { id: string; name: string; min: number; max: number; options: PosOption[] }
export interface PosProduct {
  id: string
  name: string
  description: string | null
  soldOut: boolean
  variants: PosVariant[]
  groups: PosGroup[]
}
export interface PosCategory { name: string; products: PosProduct[] }
export interface PosMenu { categories: PosCategory[] }

// ── flat rows as posApi.fetchPosMenu returns them ──────────────────────────
/** The master product. Its availability and default prices are not read here:
 *  the order's catalog decides both (CatalogRows). */
export interface ProductRow {
  id: string
  name: string
  description: string | null
  is_addon: boolean
  is_active: boolean
  sort_order: number
  category: { name: string; sort_order: number } | null
  menu_variants: { id: string; name: string; is_active: boolean; sort_order: number; feedme_variant_key: string }[]
}
export interface GroupRow {
  id: string
  name: string
  min_select: number
  max_select: number
  is_active: boolean
  sort_order: number
  modifier_options: { id: string; name: string; price_delta_sen: number; is_default: boolean; availability: Availability; sort_order: number; product_id: string | null }[]
}
export interface LinkRow { product_id: string; group_id: string; sort_order: number }
export interface SoldOutRow { product_id: string; is_sold_out: boolean }
/** One catalog's rows: which products it sells on which channel, in which order,
 *  at which variant prices, and the add-on prices it overrides. */
export interface CatalogProductRow { product_id: string; availability: Availability; sort_order: number }
export interface VariantPriceRow { variant_id: string; price_sen: number }
export interface OptionPriceRow { option_id: string; price_delta_sen: number }
export interface CatalogRows { products: CatalogProductRow[]; prices: VariantPriceRow[]; optionPrices: OptionPriceRow[] }

const allowed = (mode: OrderMode, a: Availability) => a === 'all' || (mode === 'counter' && a === 'counter_only')
const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name)
const bySort = <T extends { sort_order: number; name: string }>(a: T, b: T) => a.sort_order - b.sort_order || byName(a, b)

export function buildPosMenu(
  products: ProductRow[], groups: GroupRow[], links: LinkRow[], soldOut: SoldOutRow[], mode: OrderMode, catalog: CatalogRows,
): PosMenu {
  const soldOutIds = new Set(soldOut.filter((s) => s.is_sold_out).map((s) => s.product_id))
  const inCatalog = new Map(catalog.products.map((c) => [c.product_id, c]))
  const priceOf = new Map(catalog.prices.map((p) => [p.variant_id, p.price_sen]))
  const optionPriceOf = new Map(catalog.optionPrices.map((o) => [o.option_id, o.price_delta_sen]))
  const groupById = new Map(groups.filter((g) => g.is_active).map((g) => [g.id, g]))
  const linksByProduct = new Map<string, LinkRow[]>()
  for (const l of links) linksByProduct.set(l.product_id, [...(linksByProduct.get(l.product_id) ?? []), l])

  // the catalog's products this channel may sell, in the catalog's order (as qr_menu sorts them)
  const visible = products
    .flatMap((row) => {
      const c = inCatalog.get(row.id)
      return c && row.is_active && !row.is_addon && allowed(mode, c.availability) ? [{ row, sort: c.sort_order }] : []
    })
    .sort((a, b) => a.sort - b.sort || a.row.name.localeCompare(b.row.name))
  const cats = new Map<string, { sort: number; products: PosProduct[] }>()
  for (const { row } of visible) {
    // a variant the catalog has no price for is not for sale in it (the server refuses it too)
    const variants = row.menu_variants.filter((v) => v.is_active && priceOf.has(v.id)).sort(bySort)
    if (variants.length === 0) continue
    const posGroups: PosGroup[] = (linksByProduct.get(row.id) ?? [])
      .sort((a, b) => a.sort_order - b.sort_order)
      .flatMap((l) => {
        const g = groupById.get(l.group_id)
        if (!g) return []
        return [{
          id: g.id, name: g.name, min: g.min_select, max: g.max_select,
          options: g.modifier_options
            .filter((o) => o.availability !== 'hidden')
            .sort(bySort)
            .map((o) => ({
              id: o.id, name: o.name.trim(), priceDeltaSen: optionPriceOf.get(o.id) ?? o.price_delta_sen, isDefault: o.is_default,
              available: allowed(mode, o.availability) && !(o.product_id !== null && soldOutIds.has(o.product_id)),
            })),
        }]
      })
    const product: PosProduct = {
      id: row.id, name: row.name.trim(), description: row.description, soldOut: soldOutIds.has(row.id),
      variants: variants.map((v) => ({ id: v.id, name: v.name.trim(), priceSen: priceOf.get(v.id) as number, isBase: v.feedme_variant_key === '' })),
      groups: posGroups,
    }
    const catName = row.category?.name ?? 'Uncategorised'
    const cat = cats.get(catName) ?? { sort: row.category?.sort_order ?? 9999, products: [] }
    cat.products.push(product)
    cats.set(catName, cat)
  }
  // categories by sort then name
  return {
    categories: [...cats.entries()]
      .sort((a, b) => a[1].sort - b[1].sort || a[0].localeCompare(b[0]))
      .map(([name, c]) => ({ name, products: c.products })),
  }
}

// ── qr_menu jsonb (Task 2) → PosMenu ───────────────────────────────────────
export interface QrMenuJson {
  tableLabel: string
  paused: boolean
  needsPax: boolean
  categories: {
    name: string
    products: {
      id: string; name: string; description: string | null; soldOut: boolean
      variants: { id: string; name: string; priceSen: number; isBase: boolean }[]
      groups: { id: string; name: string; min: number; max: number
        options: { id: string; name: string; priceDeltaSen: number; isDefault: boolean; available: boolean }[] }[]
    }[]
  }[]
}

export function posMenuFromQr(json: QrMenuJson): PosMenu {
  return {
    categories: json.categories.map((c) => ({
      name: c.name,
      products: c.products.map((p) => ({
        id: p.id, name: p.name.trim(), description: p.description, soldOut: p.soldOut,
        variants: p.variants.map((v) => ({ id: v.id, name: v.name.trim(), priceSen: v.priceSen, isBase: v.isBase })),
        groups: p.groups.map((g) => ({ id: g.id, name: g.name, min: g.min, max: g.max,
          options: g.options.map((o) => ({ ...o, name: o.name.trim() })) })),
      })),
    })),
  }
}

// ── lines ───────────────────────────────────────────────────────────────────
export function findProduct(menu: PosMenu, productId: string): PosProduct | undefined {
  for (const c of menu.categories) for (const p of c.products) if (p.id === productId) return p
  return undefined
}

export function defaultLine(p: PosProduct): OrderLine {
  return {
    productId: p.id,
    variantId: p.variants[0]?.id ?? '',
    qty: 1,
    note: null,
    optionIds: p.groups.flatMap((g) => g.options.filter((o) => o.isDefault && o.available).slice(0, g.max).map((o) => o.id)),
  }
}

function optionsOf(p: PosProduct): Map<string, { option: PosOption; group: PosGroup }> {
  const m = new Map<string, { option: PosOption; group: PosGroup }>()
  for (const group of p.groups) for (const option of group.options) m.set(option.id, { option, group })
  return m
}

export function linePriceSen(p: PosProduct, line: OrderLine): number | null {
  const variant = p.variants.find((v) => v.id === line.variantId)
  if (!variant) return null
  const opts = optionsOf(p)
  let delta = 0
  for (const id of line.optionIds) delta += opts.get(id)?.option.priceDeltaSen ?? 0
  return variant.priceSen + delta
}

/** Same checks and messages as pos_insert_order, so the user hears it before sending. */
export function validateLine(p: PosProduct, line: OrderLine): string | null {
  if (p.soldOut) return `Sold out: ${p.name}`
  if (!p.variants.some((v) => v.id === line.variantId)) return `Item is not available: ${p.name}`
  if (!Number.isInteger(line.qty) || line.qty < 1 || line.qty > 20) return 'Invalid quantity'
  if (new Set(line.optionIds).size !== line.optionIds.length) return 'Invalid add-ons'
  const opts = optionsOf(p)
  for (const id of line.optionIds) {
    const hit = opts.get(id)
    if (!hit) return `Add-on is not available for ${p.name}`
    if (!hit.option.available) return `Sold out: ${hit.option.name}`
  }
  for (const g of p.groups) {
    const chosen = line.optionIds.filter((id) => opts.get(id)?.group.id === g.id).length
    if (chosen < g.min) return `Choose at least ${g.min} for ${p.name}: ${g.name}`
    if (chosen > g.max) return `Choose at most ${g.max} for ${p.name}: ${g.name}`
  }
  return null
}

export function lineLabel(p: PosProduct, line: OrderLine): { name: string; mods: string[] } {
  const variant = p.variants.find((v) => v.id === line.variantId)
  return {
    name: variant && !variant.isBase ? `${p.name} (${variant.name})` : p.name,
    // menu order (group, then option), which is the order the server snapshots and prints them in
    mods: p.groups.flatMap((g) => g.options.filter((o) => line.optionIds.includes(o.id)).map((o) => o.name)),
  }
}

export function cartSubtotalSen(menu: PosMenu, lines: OrderLine[]): number {
  let total = 0
  for (const line of lines) {
    const p = findProduct(menu, line.productId)
    const unit = p ? linePriceSen(p, line) : null
    if (unit !== null) total += unit * line.qty
  }
  return total
}

/** Stable identity of a cart: the same lines in the same order give the same key,
 *  which is what the QR page keys its client_order_id on. */
export function cartKey(lines: OrderLine[]): string {
  return JSON.stringify(lines.map((l) => [l.productId, l.variantId, l.qty, l.note ?? '', [...l.optionIds].sort()]))
}

export function formatSen(sen: number): string {
  return `RM ${(sen / 100).toFixed(2)}`
}
