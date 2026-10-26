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
  raw:       'Raw',
  packaging: 'Packaging',
  other:     'Other',
}

export const ITEM_CATEGORIES: ItemCategory[] = ['raw', 'packaging', 'other']

/** Which part of the operation uses the item. Null = not assigned yet. */
export type ItemDepartment = 'cafe_bar' | 'bakery' | 'kitchen'

export const ITEM_DEPARTMENTS: ItemDepartment[] = ['cafe_bar', 'bakery', 'kitchen']

export const ITEM_DEPARTMENT_LABELS: Record<ItemDepartment, string> = {
  cafe_bar: 'Cafe & Bar',
  bakery:   'Bakery',
  kitchen:  'Kitchen',
}

/** Suggested units — free text is still allowed, these just prefill the picker. */
export const PURCHASE_UNIT_SUGGESTIONS = ['bag', 'box', 'tub', 'bottle', 'can', 'bar', 'pack', 'carton']
export const BASE_UNIT_SUGGESTIONS = ['g', 'kg', 'ml', 'L', 'pcs']

export interface Item {
  id: string
  name: string
  name_zh: string | null
  category: ItemCategory
  department: ItemDepartment | null
  supplier_id: string | null
  /** Unit the item is bought in — bag / box / tub. */
  purchase_unit: string
  /** Unit stock is tracked in — g / kg / ml / L / pcs. */
  base_unit: string
  /** 1 purchase_unit = conversion_rate base_units (e.g. 1 bag = 2000 g). */
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

/** `closed_short`: a partially received PO ended early via close_po_short. */
export type PoStatus = 'draft' | 'sent' | 'partially_received' | 'received' | 'cancelled' | 'closed_short'

export const PO_STATUS_LABELS: Record<PoStatus, string> = {
  draft:              'Draft',
  sent:               'Sent',
  partially_received: 'Partially Received',
  received:           'Received',
  cancelled:          'Cancelled',
  closed_short:       'Closed Short',
}

export const PO_STATUS_COLORS: Record<PoStatus, string> = {
  draft:              '#8B7355',
  sent:               '#2E6E9E',
  partially_received: '#C4813A',
  received:           '#3D7A50',
  cancelled:          '#9E4A30',
  closed_short:       '#6B5B4B',
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
  /** Set by close_po_short: who ended the PO short, when, and why. */
  closed_by: string | null
  closed_at: string | null
  close_reason: string | null
  supplier?: Supplier | null
  branch?: { id: string; name: string } | null
  creator?: { id: string; name: string } | null
  closer?: { id: string; name: string } | null
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
  /** Pack size (base units per purchase unit) stamped when the line was created; frozen. */
  conversion_rate_used: number | null
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
  /** Something is still short after this delivery. */
  has_discrepancy: boolean
  /** At least one line brought in more than was outstanding. */
  has_over_delivery: boolean
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
  /** Pack size the delivery was converted with (the PO line's stamped rate). */
  conversion_rate_used: number | null
  /** Purchase units beyond what was outstanding when this delivery arrived (>= 0). */
  over_quantity: number
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
  /** RM per base unit, stamped at write time. */
  unit_cost: number | null
  item?: Item | null
  creator?: { id: string; name: string } | null
}

/** Row of the inventory_balances view (item × branch, incl. zero-stock rows). */
export interface InventoryBalance {
  item_id: string
  branch_id: string
  balance: number
}

/**
 * Row of the inventory_valuation view — same rows as inventory_balances, plus
 * the ledger value (sum of quantity × stamped unit_cost).
 */
export interface InventoryValuation {
  item_id: string
  branch_id: string
  balance: number
  /** RM. */
  stock_value: number
  /** RM per base unit. Null when balance <= 0. */
  avg_unit_cost: number | null
  uncosted_rows: number
}
