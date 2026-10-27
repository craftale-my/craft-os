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
  /**
   * Set on the HQ supplier row: the branch that supplies it. A PO to such a
   * supplier is an internal PO (branch → HQ transfer). Null for real suppliers.
   */
  internal_branch_id?: string | null
}

// ─── Items ────────────────────────────────────────────────────────────────────

/**
 * `semi_finished` is a prep batch made in-house from a recipe (frosting,
 * sponge base). `finished` is allowed by the DB but not used yet.
 */
export type ItemCategory = 'raw' | 'packaging' | 'other' | 'semi_finished' | 'finished'

export const ITEM_CATEGORY_LABELS: Record<ItemCategory, string> = {
  raw:           'Raw',
  packaging:     'Packaging',
  other:         'Other',
  semi_finished: 'Semi-finished',
  finished:      'Finished',
}

/** Categories offered in pickers. 'finished' is left out until it is used. */
export const ITEM_CATEGORIES: ItemCategory[] = ['raw', 'packaging', 'other', 'semi_finished']

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
  /** Legacy column; not shown in the UI. */
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
  /** RM, internal POs only (e.g. Lalamove). Recorded only — never allocated into item cost. */
  delivery_fee?: number | null
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
  /**
   * Internal POs: purchase units shipped by HQ so far. Set only by the
   * ship_internal_po / submit_receiving RPCs — never send it in an insert or update.
   */
  shipped_quantity?: number
  /** Internal POs: purchase units lost in transit (shipped but never arrived). RPC-only. */
  transit_loss_quantity?: number
  item?: Item | null
}

// ─── Receiving ────────────────────────────────────────────────────────────────

export interface Receiving {
  id: string
  po_id: string
  received_by: string | null
  received_at: string
  /** Storage path inside the private 'receiving-photos' bucket, despite the column name. */
  invoice_photo_url: string
  /** Storage path inside the private 'receiving-photos' bucket, despite the column name. */
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
  /** Internal POs: purchase units shipped but not arrived with this receipt. */
  transit_loss?: number
}

/** One line of the submit_receiving RPC payload. */
export interface ReceivingLineInput {
  po_item_id: string
  actual_quantity: number
  unit_price: number
}

// ─── Internal transfers (internal POs to HQ) ──────────────────────────────────

/** One ship_internal_po call. Select-only for clients. */
export interface PoShipment {
  id: string
  po_id: string
  from_branch_id: string
  shipped_by: string | null
  shipped_at: string
  notes: string | null
  shipper?: { id: string; name: string } | null
  items?: PoShipmentItem[]
}

export interface PoShipmentItem {
  id: string
  shipment_id: string
  po_item_id: string
  item_id: string
  /** Purchase units of the PO line. */
  quantity: number
  /** Base units. */
  qty_shipped: number
  /** RM per base unit: HQ's moving-average cost when shipped. */
  unit_cost: number | null
  /** The matching transfer_out row in inventory_transactions. */
  transaction_id: string | null
}

/**
 * Row of the po_transfer_lines view: one per internal PO line. Quantities in
 * the line's purchase unit; values in RM.
 */
export interface PoTransferLine {
  po_item_id: string
  po_id: string
  po_number: string
  po_status: PoStatus
  from_branch_id: string
  to_branch_id: string
  item_id: string
  /** Base units per purchase unit. */
  conversion_rate: number
  quantity_ordered: number
  shipped_quantity: number
  received_quantity: number
  transit_loss_quantity: number
  in_transit_quantity: number
  to_ship_quantity: number
  /** RM per base unit, weighted over the line's shipments. Null before anything shipped. */
  shipped_unit_cost: number | null
  in_transit_value: number | null
  transit_loss_value: number | null
}

/** One line of the ship_internal_po RPC payload. */
export interface ShipLineInput {
  po_item_id: string
  /** Purchase units. Zero lines are skipped by the RPC. */
  quantity: number
}

// ─── Inventory ────────────────────────────────────────────────────────────────

/** Phase 2 will add sales / stocktake. */
export type InventoryTransactionType =
  | 'stock_in' | 'adjustment' | 'wastage' | 'transfer_out' | 'transfer_in'
  | 'production_out' | 'production_in'

export const TRANSACTION_TYPE_LABELS: Record<InventoryTransactionType, string> = {
  stock_in:       'Stock In',
  adjustment:     'Adjustment',
  wastage:        'Wastage',
  transfer_out:   'Transfer out',
  transfer_in:    'Transfer in',
  production_out: 'Used in production',
  production_in:  'Produced',
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
  /** Reason code on wastage / adjustment rows (e.g. a {@link WastageReason}). */
  reason: string | null
  /** transfer_out / transfer_in rows: the po_shipments id that pairs them. */
  transfer_id?: string | null
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

// ─── Wastage ──────────────────────────────────────────────────────────────────

export type WastageReason = 'expired' | 'damaged' | 'production_error' | 'other'

export const WASTAGE_REASONS: WastageReason[] = ['expired', 'damaged', 'production_error', 'other']

export const WASTAGE_REASON_LABELS: Record<WastageReason, string> = {
  expired:          'Expired',
  damaged:          'Damaged',
  production_error: 'Production error',
  other:            'Other',
}

/** Row of wastage_logs — written only through the log_wastage RPC. */
export interface WastageLog {
  id: string
  branch_id: string
  item_id: string
  /** Base units, > 0. */
  quantity: number
  reason: WastageReason
  /** Required when reason is 'other'. */
  note: string | null
  /** Path inside the private 'receiving-photos' bucket (shown via signed URLs). */
  photo_path: string | null
  /** RM per base unit: the branch's moving-average cost when logged. */
  unit_cost: number | null
  /** RM: quantity × unit_cost. Null when the item had no cost. */
  value: number | null
  /** 05:00 MYT cutoff (business_date_of). */
  business_date: string
  /** The matching inventory_transactions row. */
  transaction_id: string | null
  created_by: string | null
  created_at: string
  item?: Pick<Item, 'id' | 'name' | 'base_unit' | 'department'> | null
  creator?: { id: string; name: string } | null
}

// ─── Prep-batch recipes & production ──────────────────────────────────────────

export type RecipeStatus = 'active' | 'archived'

/**
 * One version of a prep-batch recipe for a semi-finished item. Written only
 * through the save_recipe_version RPC. A production run uses the active,
 * verified version with the latest effective_from <= the business date.
 */
export interface Recipe {
  id: string
  /** The semi-finished output item. */
  item_id: string
  version: number
  /** Base units of the output made by one batch. */
  yield_qty: number
  /** Business date (yyyy-mm-dd) the version takes effect. */
  effective_from: string
  status: RecipeStatus
  verified_at: string | null
  verified_by: string | null
  notes: string | null
  created_by: string | null
  created_at: string
  verifier?: { id: string; name: string } | null
  creator?: { id: string; name: string } | null
  lines?: RecipeLine[]
}

export interface RecipeLine {
  id: string
  recipe_id: string
  /** The ingredient. */
  item_id: string
  /** Ingredient base units per batch. */
  qty_base: number
  sort_order: number
  item?: Pick<Item, 'id' | 'name' | 'base_unit' | 'latest_price' | 'conversion_rate'> | null
}

/** One line of the save_recipe_version RPC payload. */
export interface RecipeLineInput {
  item_id: string
  qty_base: number
}

/** One produce_batch call. Select-only for clients. */
export interface ProductionBatch {
  id: string
  recipe_id: string
  item_id: string
  branch_id: string
  batches: number
  /** Base units of the output made. */
  output_qty: number
  /** RM. */
  total_cost: number
  /** RM per base unit of the output. */
  unit_cost: number
  business_date: string
  note: string | null
  /** The production_in row in inventory_transactions. */
  transaction_id: string | null
  created_by: string | null
  created_at: string
  creator?: { id: string; name: string } | null
  recipe?: Pick<Recipe, 'id' | 'version'> | null
  lines?: ProductionBatchLine[]
}

export interface ProductionBatchLine {
  id: string
  batch_id: string
  item_id: string
  /** Ingredient base units used. */
  qty_base: number
  /** RM per base unit: the branch's moving-average cost at the time. */
  unit_cost: number
  line_cost: number
  /** The production_out row in inventory_transactions. */
  transaction_id: string | null
  item?: Pick<Item, 'id' | 'name' | 'base_unit'> | null
}

/** Row of the recipe_cost_estimate view: one per recipe version × active branch. */
export interface RecipeCostEstimate {
  recipe_id: string
  item_id: string
  version: number
  branch_id: string
  yield_qty: number
  /** RM. Uncosted ingredients contribute nothing. */
  batch_cost: number | null
  /** RM per base unit of the output. */
  unit_cost: number | null
  /** Some ingredient has neither an average cost at the branch nor a price. */
  missing_cost: boolean
}

export interface ProductionPreviewLine {
  item_id: string
  name: string
  base_unit: string
  need: number
  on_hand: number
  /** RM per base unit. Null when the branch has no cost for it. */
  unit_cost: number | null
  line_cost: number
  short: boolean
  sort_order: number
}

/** What the preview_production RPC returns. */
export interface ProductionPreview {
  recipe_id: string
  version: number
  effective_from: string
  business_date: string
  yield_qty: number
  batches: number
  output_qty: number
  lines: ProductionPreviewLine[]
  total_cost: number
  unit_cost: number
  /** An ingredient has no cost at the branch; produce_batch refuses it. */
  missing_cost: boolean
  can_produce: boolean
}
