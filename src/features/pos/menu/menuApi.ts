import { supabase } from '../../../shared/lib/supabase'
import { writeOutcome } from '../../../shared/lib/db-write'
import type { CatalogsImport } from './feedmeExport'

export interface MenuVariantRow { id: string; name: string; price_sen: number; is_active: boolean; sort_order: number }
/** A master product as the Products page lists it (menu_product_list). `catalog_ids`
 *  are the catalogs that sell it (availability other than hidden). */
export interface MenuProductRow {
  id: string
  name: string
  is_active: boolean
  is_addon: boolean
  sst_rate_bp: number
  print_route: string | null
  takeaway_fee_sen: number
  sort_order: number
  category_id: string | null
  category: { name: string; sort_order: number } | null
  menu_variants: MenuVariantRow[]
  catalog_ids: string[]
}
export type ProductPatch = Partial<Pick<MenuProductRow, 'sst_rate_bp' | 'print_route'>>

/** Every product, switched-off ones too, in one call (menu_product_list: one JSON
 *  value, so PostgREST's 1000-row cap never cuts the list short). Edit menu only. */
export async function fetchMenu(): Promise<MenuProductRow[]> {
  const { data, error } = await supabase.rpc('menu_product_list')
  if (error) throw new Error(error.message)
  return (data ?? []) as MenuProductRow[]
}

/** One patch for many products (e.g. a whole category's print route), written in
 *  chunks of at most 100 ids so the request URL stays short. A chunk that fails
 *  stops the rest; chunks already written stay written. */
export async function updateProducts(ids: string[], patch: ProductPatch): Promise<void> {
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const res = await supabase
      .from('menu_products')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .in('id', chunk)
      .select('id')
    const outcome = writeOutcome(res)
    if (!outcome.ok) throw new Error(`Menu change failed: ${outcome.reason}`)
    if ((res.data ?? []).length !== chunk.length) throw new Error('Some products were not updated — refresh and try again.')
  }
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
