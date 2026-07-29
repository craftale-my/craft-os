// ─── Procurement & Inventory ──────────────────────────────────────────────────
// Phase 1: suppliers, items, purchase orders, receiving, inventory.
// Kept in its own file — types/index.ts is already large and this module adds a
// fair chunk. Re-exported from index.ts so import paths don't change.

export type ProcurementStatus = 'active' | 'inactive'

// ─── Suppliers ────────────────────────────────────────────────────────────────

export interface Supplier {
  id: string
  name: string
  contact_person: string | null
  phone: string | null
  whatsapp: string | null
  email: string | null
  address: string | null
  payment_terms: string | null
  status: ProcurementStatus
  created_at: string
}

// ─── Items ────────────────────────────────────────────────────────────────────

/** Phase 2 will add finished / semi_finished. */
export type ItemCategory = 'raw' | 'packaging' | 'other'

export const ITEM_CATEGORY_LABELS: Record<ItemCategory, string> = {
  raw:       '原料 Raw',
  packaging: '包装 Packaging',
  other:     '其他 Other',
}

export const ITEM_CATEGORIES: ItemCategory[] = ['raw', 'packaging', 'other']

/** Suggested units — free text is still allowed, these just prefill the picker. */
export const PURCHASE_UNIT_SUGGESTIONS = ['包', '箱', '桶', '瓶', '罐', '条', 'pack', 'carton']
export const BASE_UNIT_SUGGESTIONS = ['g', 'kg', 'ml', 'L', 'pcs']

export interface Item {
  id: string
  name: string
  name_zh: string | null
  category: ItemCategory
  supplier_id: string | null
  /** Unit the item is bought in — 包 / 箱 / 桶. */
  purchase_unit: string
  /** Unit stock is tracked in — g / kg / ml / L / pcs. */
  base_unit: string
  /** 1 purchase_unit = conversion_rate base_units (e.g. 1 包 = 2000 g). */
  conversion_rate: number
  /** Most recent price paid, per purchase_unit. */
  latest_price: number | null
  /** Low-stock threshold, in base units. */
  min_stock_alert: number
  status: ProcurementStatus
  created_at: string
  supplier?: Supplier | null
}

export type PriceSource = 'receiving' | 'manual'

export interface ItemPriceHistory {
  id: string
  item_id: string
  price: number
  recorded_at: string
  source: PriceSource
  receiving_id: string | null
}

// ─── Purchase orders ──────────────────────────────────────────────────────────

export type PoStatus = 'draft' | 'sent' | 'partially_received' | 'received' | 'cancelled'

export const PO_STATUS_LABELS: Record<PoStatus, string> = {
  draft:              'Draft',
  sent:               'Sent',
  partially_received: 'Partially Received',
  received:           'Received',
  cancelled:          'Cancelled',
}

export const PO_STATUS_COLORS: Record<PoStatus, string> = {
  draft:              '#8B7355',
  sent:               '#2E6E9E',
  partially_received: '#C4813A',
  received:           '#3D7A50',
  cancelled:          '#9E4A30',
}

export interface PurchaseOrder {
  id: string
  po_number: string
  supplier_id: string
  branch_id: string
  created_by: string | null
  status: PoStatus
  total_amount: number
  notes: string | null
  created_at: string
  sent_at: string | null
  supplier?: Supplier | null
  branch?: { id: string; name: string } | null
  creator?: { id: string; name: string } | null
  items?: PurchaseOrderItem[]
}

export interface PurchaseOrderItem {
  id: string
  po_id: string
  item_id: string
  /** In purchase units. */
  quantity_ordered: number
  /** Agreed price at order time — NOT overwritten by receiving. */
  unit_price: number
  received_quantity: number
  shortage_quantity: number
  item?: Item | null
}

// ─── Receiving ────────────────────────────────────────────────────────────────

export interface Receiving {
  id: string
  po_id: string
  received_by: string | null
  received_at: string
  invoice_photo_url: string
  goods_photo_url: string | null
  notes: string | null
  has_discrepancy: boolean
  receiver?: { id: string; name: string } | null
  items?: ReceivingItem[]
}

export interface ReceivingItem {
  id: string
  receiving_id: string
  po_item_id: string
  expected_quantity: number
  actual_quantity: number
  shortage: number
  /** Price off this delivery's invoice — may differ from the ordered price. */
  unit_price: number
}

/** One line of the submit_receiving RPC payload. */
export interface ReceivingLineInput {
  po_item_id: string
  actual_quantity: number
  unit_price: number
}

// ─── Inventory ────────────────────────────────────────────────────────────────

/** Phase 2 will add production / sales / wastage / stocktake. */
export type InventoryTransactionType = 'stock_in' | 'adjustment'

export const TRANSACTION_TYPE_LABELS: Record<InventoryTransactionType, string> = {
  stock_in:   'Stock In',
  adjustment: 'Adjustment',
}

export interface InventoryTransaction {
  id: string
  item_id: string
  branch_id: string
  transaction_type: InventoryTransactionType
  /** Base units. Positive = in, negative = out. */
  quantity: number
  reference_type: string | null
  reference_id: string | null
  created_by: string | null
  created_at: string
  notes: string | null
  item?: Item | null
  creator?: { id: string; name: string } | null
}

/** Row of the inventory_balances view (item × branch, incl. zero-stock rows). */
export interface InventoryBalance {
  item_id: string
  branch_id: string
  balance: number
}
