// src/features/pos/order/padInfo.ts
/** What the order screen needs of a product beyond pos_menu_rows: its SST rate and packaging fee
 *  (so the bill preview can count unsent items with the server's rules) and its photo (the
 *  Feedme tile). Read from menu_products, the same columns pos_insert_order snapshots. */
import type { PosMenu } from './cart'

export interface PadProductRow {
  id: string
  sst_rate_bp: number
  takeaway_fee_sen: number
  image_path: string | null
  image_updated_at: string | null
}
export interface PadProductInfo { sstRateBp: number; takeawayFeeSen: number; imageUrl: string | null }

/** `photoUrl` turns a photo path (and when it was set) into its URL: productThumbUrl in the app. */
export function padProductInfo(
  rows: PadProductRow[], photoUrl: (path: string, updatedAt: string | null) => string,
): Map<string, PadProductInfo> {
  return new Map(rows.map((r) => [r.id, {
    sstRateBp: r.sst_rate_bp,
    takeawayFeeSen: r.takeaway_fee_sen,
    imageUrl: r.image_path ? photoUrl(r.image_path, r.image_updated_at) : null,
  }]))
}

/** The menu with each product's photo URL (null when it has none or is not in `info`). */
export function withPhotos(menu: PosMenu, info: ReadonlyMap<string, PadProductInfo>): PosMenu {
  return {
    categories: menu.categories.map((c) => ({
      name: c.name,
      products: c.products.map((p) => ({ ...p, imageUrl: info.get(p.id)?.imageUrl ?? null })),
    })),
  }
}
