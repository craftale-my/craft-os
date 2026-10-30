// src/features/pos/menu/menuEditorApi.ts
/** The menu editor's server calls (supabase/migration-2026-10-24-pos-menu-editor-fn.sql).
 *  Every read is one RPC that returns one JSON value, so PostgREST's 1000-row cap
 *  never cuts it short; every write is one RPC that validates everything and answers
 *  in the words the editor shows. All of them need Edit menu (manage_menu). */
import { supabase } from '../../../shared/lib/supabase'
import type { Availability } from './feedmeExport'

export type CatalogRole = 'dine_in' | 'takeaway' | 'qr' | 'additional'

export interface LookupCategory { id: string; name: string; isActive: boolean; sortOrder: number; productCount: number }
export interface LookupCatalog {
  id: string
  name: string
  isActive: boolean
  sortOrder: number
  feedmeName: string | null
  productCount: number
  /** products it sells with an active variant it has no price for (the pad and QR leave them out) */
  unpricedCount: number
  uses: { branch: string; role: CatalogRole }[]
}
export interface LookupGroup {
  id: string
  name: string
  isActive: boolean
  min: number
  max: number
  optionCount: number
  productCount: number
}
export interface LookupAddOn { id: string; name: string; isActive: boolean }
/** menu_editor_lookups: everything the pickers and the list pages need. */
export interface MenuLookups {
  categories: LookupCategory[]
  catalogs: LookupCatalog[]
  groups: LookupGroup[]
  addOns: LookupAddOn[]
}

/** menu_product_detail. `catalogs` has one entry per catalog; prices are by variant id. */
export interface ProductDetail {
  id: string
  name: string
  internalName: string | null
  description: string | null
  categoryId: string | null
  sstRateBp: number
  printRoute: string | null
  takeawayFeeSen: number
  isActive: boolean
  isAddon: boolean
  feedmeProductId: string | null
  variants: { id: string; name: string; priceSen: number; isActive: boolean }[]
  groupIds: string[]
  catalogs: { catalogId: string; availability: Availability; prices: Record<string, number> }[]
}
/** The product's own fields. menu_save_product keeps a stored value whose key is left out
 *  (an existing product only), so the editor sends only what the owner changed. */
export interface ProductDetails {
  name: string
  internalName: string | null
  description: string | null
  categoryId: string | null
  sstRateBp: number
  printRoute: string | null
  takeawayFeeSen: number
  isActive: boolean
  isAddon: boolean
}
/** menu_save_product. A variant's `ref` is its id when it exists, any other string when new.
 *  Every variant is always sent; catalogs left out are not touched. */
export interface ProductPayload extends Partial<ProductDetails> {
  id: string | null
  variants: { ref: string; id: string | null; name: string; priceSen: number; isActive: boolean }[]
  groupIds: string[]
  catalogs: { catalogId: string; availability: Availability; prices: { ref: string; priceSen: number }[] }[]
}

/** menu_group_detail. `catalogPrices` holds only the catalogs that override the price. */
export interface GroupDetail {
  id: string
  name: string
  min: number
  max: number
  stackable: boolean
  isActive: boolean
  feedmeGroupId: string | null
  options: {
    id: string
    name: string
    priceDeltaSen: number
    productId: string | null
    isDefault: boolean
    availability: Availability
    catalogPrices: Record<string, number>
  }[]
  usedBy: { id: string; name: string }[]
}
/** menu_save_group. `catalogPrices` is the whole set of overrides the group keeps. */
export interface GroupPayload {
  id: string | null
  name: string
  min: number
  max: number
  stackable: boolean
  isActive: boolean
  options: {
    ref: string
    id: string | null
    name: string
    priceDeltaSen: number
    productId: string | null
    isDefault: boolean
    availability: Availability
  }[]
  catalogPrices: { catalogId: string; ref: string; priceDeltaSen: number }[]
}

/** menu_catalog_grid: every active product that is not an add-on item. */
export interface GridVariant { id: string; name: string; isActive: boolean; defaultSen: number; priceSen: number | null }
export interface GridProduct {
  id: string
  name: string
  category: string
  categorySort: number
  availability: Availability
  variants: GridVariant[]
}
export interface CatalogGrid { catalog: { id: string; name: string; isActive: boolean }; products: GridProduct[] }
/** menu_save_catalog_row */
export interface CatalogRowPayload {
  catalogId: string
  productId: string
  availability: Availability
  prices: { variantId: string; priceSen: number }[]
}

async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data as T
}

export const fetchLookups = () => call<MenuLookups>('menu_editor_lookups')
export const fetchProductDetail = (id: string) => call<ProductDetail>('menu_product_detail', { p_product_id: id })
export const saveProduct = (p: ProductPayload) => call<string>('menu_save_product', { p })
export const fetchGroupDetail = (id: string) => call<GroupDetail>('menu_group_detail', { p_group_id: id })
export const saveGroup = (p: GroupPayload) => call<string>('menu_save_group', { p })
export const saveCatalog = (id: string | null, name: string) => call<string>('menu_save_catalog', { p_id: id, p_name: name })
export const duplicateCatalog = (sourceId: string, name: string) =>
  call<string>('menu_duplicate_catalog', { p_source_id: sourceId, p_name: name })
export const reorderCatalogs = (ids: string[]) => call<null>('menu_reorder_catalogs', { p_ids: ids })
export const setCatalogActive = (id: string, active: boolean) => call<null>('menu_set_catalog_active', { p_id: id, p_active: active })
/** Each catalog's discount in basis points (Staff Meal 5000); read apart from menu_editor_lookups. */
export async function fetchCatalogDiscounts(): Promise<Map<string, number>> {
  const { data, error } = await supabase.from('menu_catalogs').select('id, discount_bp')
  if (error) throw new Error(error.message)
  return new Map(((data ?? []) as { id: string; discount_bp: number }[]).map((r) => [r.id, r.discount_bp]))
}
export const setCatalogDiscount = (id: string, bp: number) => call<null>('menu_set_catalog_discount', { p_id: id, p_bp: bp })
export const fetchCatalogGrid = (id: string) => call<CatalogGrid>('menu_catalog_grid', { p_catalog_id: id })
export const saveCatalogRow = (p: CatalogRowPayload) => call<null>('menu_save_catalog_row', { p })
export const saveCategory = (id: string | null, name: string) => call<string>('menu_save_category', { p_id: id, p_name: name })
export const reorderCategories = (ids: string[]) => call<null>('menu_reorder_categories', { p_ids: ids })
export const setCategoryActive = (id: string, active: boolean) => call<null>('menu_set_category_active', { p_id: id, p_active: active })
