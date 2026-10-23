import { supabase } from '../../../shared/lib/supabase'
import { writeOutcome } from '../../../shared/lib/db-write'
import type { Availability, CatalogsImport } from './feedmeExport'
import type { CatalogRow } from '../order/catalogs'

export interface MenuVariantRow { id: string; name: string; price_sen: number; is_active: boolean; sort_order: number }
/** A master product. Its own availability is not read any more: each catalog says
 *  whether it sells the product (CatalogEntries). */
export interface MenuProductRow {
  id: string
  name: string
  is_addon: boolean
  sst_rate_bp: number
  print_route: string | null
  takeaway_fee_sen: number
  sort_order: number
  category: { name: string; sort_order: number } | null
  menu_variants: MenuVariantRow[]
}
export type ProductPatch = Partial<Pick<MenuProductRow, 'sst_rate_bp' | 'print_route'>>
/** One catalog on /menu: product id → availability, variant id → price. */
export interface CatalogEntries { catalogId: string; availability: Map<string, Availability>; prices: Map<string, number> }

export async function fetchMenu(): Promise<MenuProductRow[]> {
  const { data, error } = await supabase
    .from('menu_products')
    .select(
      'id, name, is_addon, sst_rate_bp, print_route, takeaway_fee_sen, sort_order, ' +
        'category:menu_categories(name, sort_order), menu_variants(id, name, price_sen, is_active, sort_order)',
    )
    .eq('is_active', true)
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as MenuProductRow[]
}

/** One patch for many products (e.g. a whole category's print route). */
export async function updateProducts(ids: string[], patch: ProductPatch): Promise<void> {
  if (ids.length === 0) return
  const res = await supabase
    .from('menu_products')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .in('id', ids)
    .select('id')
  const outcome = writeOutcome(res)
  if (!outcome.ok) throw new Error(`Menu change failed: ${outcome.reason}`)
  if ((res.data ?? []).length !== ids.length) throw new Error('Some products were not updated — refresh and try again.')
}

export async function fetchCatalogs(): Promise<CatalogRow[]> {
  const { data, error } = await supabase.from('menu_catalogs').select('id, name, is_active, sort_order').order('sort_order').order('name')
  if (error) throw new Error(error.message)
  return (data ?? []) as CatalogRow[]
}

export async function fetchCatalogEntries(catalogId: string): Promise<CatalogEntries> {
  const [p, v] = await Promise.all([
    supabase.from('catalog_products').select('product_id, availability').eq('catalog_id', catalogId),
    supabase.from('catalog_variant_prices').select('variant_id, price_sen').eq('catalog_id', catalogId),
  ])
  if (p.error) throw new Error(p.error.message)
  if (v.error) throw new Error(v.error.message)
  return {
    catalogId,
    availability: new Map((p.data ?? []).map((r) => [r.product_id as string, r.availability as Availability])),
    prices: new Map((v.data ?? []).map((r) => [r.variant_id as string, r.price_sen as number])),
  }
}

/** In or out of a catalog, and on which channel (menu_set_catalog_product: manage_menu;
 *  putting a product in pre-fills its prices from the default price). */
export async function setCatalogAvailability(catalogId: string, productId: string, availability: Availability): Promise<void> {
  const { error } = await supabase.rpc('menu_set_catalog_product', {
    p_catalog_id: catalogId, p_product_id: productId, p_availability: availability,
  })
  if (error) throw new Error(`Catalog change failed: ${error.message}`)
}

/** What menu_import_catalogs answers. */
export interface ImportReport {
  categories: number
  products: number
  variants: number
  groups: number
  options: number
  links: number
  catalogs: { name: string; products: number; prices: number; optionPrices: number }[]
}

/** The whole Feedme export in one transaction (manage_menu). */
export async function importFeedme(payload: CatalogsImport): Promise<ImportReport> {
  const { data, error } = await supabase.rpc('menu_import_catalogs', { p_payload: payload })
  if (error) throw new Error(error.message)
  return data as ImportReport
}

/** How many catalogs exist (a re-import must be confirmed by typing). */
export async function countCatalogs(): Promise<number> {
  const { count, error } = await supabase.from('menu_catalogs').select('id', { count: 'exact', head: true })
  if (error) throw new Error(error.message)
  return count ?? 0
}
