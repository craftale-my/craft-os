// src/features/pos/menu/testing/menuRow.ts
import type { MenuProductRow } from '../menuApi'

/** One product as menu_product_list returns it: a switched-on TEA drink with no photo, unless `over` says otherwise. */
export function menuRow(over: Partial<MenuProductRow>): MenuProductRow {
  return {
    id: over.name ?? 'x', name: 'x', is_active: true, is_addon: false, sst_rate_bp: 600, print_route: null,
    takeaway_fee_sen: 0, sort_order: 0, category_id: 'tea', category: { name: 'TEA', sort_order: 0 }, image_path: null,
    image_updated_at: null, menu_variants: [], catalog_ids: [], ...over,
  }
}
