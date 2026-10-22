import { supabase } from '../../../shared/lib/supabase'
import { writeOutcome } from '../../../shared/lib/db-write'
import type { Availability, MenuImport } from './feedmeExport'

export interface MenuVariantRow { id: string; name: string; price_sen: number; is_active: boolean; sort_order: number }
export interface MenuProductRow {
  id: string
  name: string
  availability: Availability
  is_addon: boolean
  sst_rate_bp: number
  print_route: string | null
  takeaway_fee_sen: number
  sort_order: number
  category: { name: string; sort_order: number } | null
  menu_variants: MenuVariantRow[]
}
export type ProductPatch = Partial<Pick<MenuProductRow, 'availability' | 'sst_rate_bp' | 'print_route'>>

export async function fetchMenu(): Promise<MenuProductRow[]> {
  const { data, error } = await supabase
    .from('menu_products')
    .select(
      'id, name, availability, is_addon, sst_rate_bp, print_route, takeaway_fee_sen, sort_order, ' +
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
  if (!outcome.ok) throw new Error(`Menu change ${outcome.reason}`)
  if ((res.data ?? []).length !== ids.length) throw new Error('Some products were not updated — refresh and try again.')
}

export async function importMenu(payload: MenuImport): Promise<Record<string, number>> {
  const { data, error } = await supabase.rpc('menu_import', { p_payload: payload })
  if (error) throw new Error(error.message)
  return data as Record<string, number>
}
