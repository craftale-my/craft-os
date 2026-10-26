import type {
  InventoryBalance, InventoryValuation, Item, ItemDepartment, PurchaseOrder, PurchaseOrderItem, PoStatus, Recipe,
  Staff, Supplier, WastageLog,
} from '../types'
import { WASTAGE_REASONS } from '../types'

/** Purchase units → base units. `1 bag = 2000 g` ⇒ toBaseUnits(3, 2000) = 6000. */
export function toBaseUnits(quantity: number, conversionRate: number): number {
  return quantity * conversionRate
}

/** Base units → purchase units. Guards a zero/absent rate rather than returning Infinity. */
export function toPurchaseUnits(baseQuantity: number, conversionRate: number): number {
  if (!conversionRate) return 0
  return baseQuantity / conversionRate
}

/** Shortfall against what was ordered. Over-delivery is not a negative shortage. */
export function calcShortage(ordered: number, actual: number): number {
  return Math.max(ordered - actual, 0)
}

/**
 * PO status judged from a single delivery against the full ordered quantity.
 *
 * @deprecated A PO can now be received across several deliveries — use
 * {@link deriveCumulativePoStatus} on the cumulative `received_quantity`.
 */
export function derivePoStatus(
  lines: { quantity_ordered: number; actual_quantity: number }[],
): Extract<PoStatus, 'received' | 'partially_received'> {
  const short = lines.some(l => calcShortage(l.quantity_ordered, l.actual_quantity) > 0)
  return short ? 'partially_received' : 'received'
}

interface CumulativeLine {
  quantity_ordered: number
  /** Cumulative across every delivery so far. */
  received_quantity: number
}

/** What is still to come on a PO line. Never negative. */
export function outstandingQty(line: CumulativeLine): number {
  return Math.max(line.quantity_ordered - line.received_quantity, 0)
}

/**
 * PO status from cumulative received quantities: `received` once every line
 * is fully in. An empty PO has nothing received, so it is not `received`.
 */
export function deriveCumulativePoStatus(
  lines: CumulativeLine[],
): Extract<PoStatus, 'received' | 'partially_received'> {
  if (lines.length === 0) return 'partially_received'
  return lines.every(l => outstandingQty(l) === 0) ? 'received' : 'partially_received'
}

/**
 * How much of a delivery is beyond what was outstanding, in purchase units.
 * `3 outstanding, 5 arrived` ⇒ overQty(3, 5) = 2. Never negative.
 */
export function overQty(outstanding: number, actual: number): number {
  return Math.max(actual - outstanding, 0)
}

/** How far a PO line has been received beyond what was ordered. Never negative. */
export function lineOverReceived(line: CumulativeLine): number {
  return Math.max(line.received_quantity - line.quantity_ordered, 0)
}

/**
 * Whether a delivery needs a note: submit_receiving requires p_notes when any
 * line brings in more than is outstanding.
 */
export function deliveryNeedsNote(lines: { outstanding: number; actual: number }[]): boolean {
  return lines.some(l => overQty(l.outstanding, l.actual) > 0)
}

/** Statuses submit_receiving accepts. A closed-short PO can never be received again. */
export function isReceivable(status: PoStatus): boolean {
  return status === 'sent' || status === 'partially_received'
}

/**
 * Whether the viewer may close a PO short: only a partially received PO, and
 * only for users with manage_procurement (mirrors the close_po_short RPC).
 */
export function canCloseShort(status: PoStatus, canManage: boolean): boolean {
  return status === 'partially_received' && canManage
}

/** Lines with something still outstanding — on a closed-short PO, what never arrived. */
export function shortfallLines<T extends CumulativeLine>(lines: T[]): T[] {
  return lines.filter(l => outstandingQty(l) > 0)
}

/**
 * Applies one delivery to the PO lines, returning new lines with cumulative
 * `received_quantity`. Mirrors the submit_receiving RPC's checks so the UI can
 * validate before submitting: throws on an unknown or repeated line or a
 * negative quantity. Over-delivery is allowed — a line may end up with
 * `received_quantity` above `quantity_ordered` (see {@link overQty}). Lines
 * left out of `deliveries` are unchanged.
 */
export function applyDelivery<T extends CumulativeLine & { id: string }>(
  lines: T[],
  deliveries: { po_item_id: string; actual_quantity: number }[],
): T[] {
  const byId = new Map(lines.map(l => [l.id, l]))
  const added = new Map<string, number>()

  for (const d of deliveries) {
    const line = byId.get(d.po_item_id)
    if (!line) throw new Error(`PO line ${d.po_item_id} does not belong to this purchase order`)
    if (added.has(d.po_item_id)) throw new Error(`PO line ${d.po_item_id} appears more than once`)
    if (!Number.isFinite(d.actual_quantity) || d.actual_quantity < 0) {
      throw new Error('Received quantity must be zero or more')
    }
    added.set(d.po_item_id, d.actual_quantity)
  }

  return lines.map(l => {
    const extra = added.get(l.id)
    return extra ? { ...l, received_quantity: l.received_quantity + extra } : l
  })
}

export interface PriceDelta {
  direction: 'up' | 'down' | 'same'
  amount: number       // absolute difference
  percent: number      // signed, relative to the reference price
}

/** Invoice price vs the price agreed when ordering. */
export function priceDelta(orderedPrice: number, actualPrice: number): PriceDelta {
  const diff = actualPrice - orderedPrice
  if (diff === 0) return { direction: 'same', amount: 0, percent: 0 }
  // No reference to compare against — report the move without a percentage.
  const percent = orderedPrice === 0 ? 0 : (diff / orderedPrice) * 100
  return { direction: diff > 0 ? 'up' : 'down', amount: Math.abs(diff), percent }
}

/** Stock at or below the alert threshold. A threshold of 0 never alerts. */
export function isBelowAlert(balance: number, minStockAlert: number): boolean {
  if (minStockAlert <= 0) return false
  return balance <= minStockAlert
}

/**
 * Value of stock held, using the latest price. `latestPrice` is per purchase
 * unit and `balance` is in base units, so the price is scaled down first.
 * Null when there is no price or the conversion rate is unusable.
 *
 * @deprecated Values every unit at the latest price through the LIVE
 * conversion rate, so editing the rate re-prices historical stock. Use the
 * ledger ({@link ledgerValue} / the inventory_valuation view); kept only as a
 * fallback when no ledger value is available.
 */
export function stockValue(balance: number, latestPrice: number | null, conversionRate: number): number | null {
  if (latestPrice == null || !(conversionRate > 0)) return null
  return (latestPrice / conversionRate) * balance
}

/**
 * Cost per base unit from a price per purchase unit. `RM 42 per 250 g bag` ⇒
 * unitCostPerBase(42, 250) = 0.168. Null when there is no price or the rate
 * is not positive.
 */
export function unitCostPerBase(pricePerPurchaseUnit: number | null, conversionRate: number | null): number | null {
  if (pricePerPurchaseUnit == null || conversionRate == null) return null
  const rate = Number(conversionRate)
  if (!(rate > 0)) return null
  return Number(pricePerPurchaseUnit) / rate
}

interface CostedLedgerRow {
  /** Base units. Positive = in, negative = out. */
  quantity: number
  /** RM per base unit, stamped when the row was written. */
  unit_cost: number | null
}

/**
 * Value of a set of ledger rows: sum of quantity × stamped unit_cost. Rows
 * without a cost contribute 0. Never derived from the live conversion rate.
 */
export function ledgerValue(rows: CostedLedgerRow[]): number {
  return rows.reduce(
    (sum, r) => sum + (r.unit_cost == null ? 0 : Number(r.quantity) * Number(r.unit_cost)),
    0,
  )
}

/**
 * Moving weighted average cost per base unit: ledger value / quantity held.
 * Null when nothing is held (sum of quantity <= 0).
 */
export function movingAverageCost(rows: CostedLedgerRow[]): number | null {
  const held = rows.reduce((sum, r) => sum + Number(r.quantity), 0)
  if (!(held > 0)) return null
  return ledgerValue(rows) / held
}

/** Cost per base unit, 4 decimals: `RM 0.0850 / g`. '—' when unknown. */
export function formatUnitCost(n: number | null, baseUnit: string): string {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  return `RM ${Number(n).toFixed(4)} / ${baseUnit}`
}

export type StockDepartmentFilter = 'all' | ItemDepartment | 'unassigned'

export interface StockRow {
  item: Item
  /** Base units. */
  balance: number
  low: boolean
  value: number | null
  /** RM per base unit: value / balance. Null when nothing is held or there is no value. */
  avgCost: number | null
}

/** The row's ledger value (inventory_valuation row), or null when it carries none. */
function ledgerStockValue(row: InventoryBalance | InventoryValuation): number | null {
  if (!('stock_value' in row)) return null
  const raw = (row as { stock_value: unknown }).stock_value
  if (raw == null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * Rows for the Stock on Hand page. `branchId` 'all' sums every branch the
 * viewer can see; otherwise only that branch counts. Low stock sorts first,
 * then by name — the point of the screen is surfacing what needs reordering.
 *
 * Value comes from the ledger: the sum of `stock_value` over the counted
 * inventory_valuation rows. Only when no counted row carries a `stock_value`
 * (plain inventory_balances rows) does it fall back to the deprecated
 * latest-price {@link stockValue}.
 */
export function buildStockRows({ items, balances, branchId, department, search }: {
  items: Item[]
  balances: (InventoryBalance | InventoryValuation)[]
  /** A branch id, or 'all'. */
  branchId: string
  department: StockDepartmentFilter
  search: string
}): StockRow[] {
  const totals = new Map<string, number>()
  const values = new Map<string, number>()
  for (const b of balances) {
    if (branchId !== 'all' && b.branch_id !== branchId) continue
    totals.set(b.item_id, (totals.get(b.item_id) ?? 0) + Number(b.balance))
    const v = ledgerStockValue(b)
    if (v != null) values.set(b.item_id, (values.get(b.item_id) ?? 0) + v)
  }

  const term = search.trim().toLowerCase()
  return items
    .filter(i => department === 'all'
      || (department === 'unassigned' ? i.department == null : i.department === department))
    .filter(i => !term || i.name.toLowerCase().includes(term))
    .map(item => {
      const balance = totals.get(item.id) ?? 0
      const value = values.size > 0
        ? values.get(item.id) ?? 0
        : stockValue(
          balance,
          item.latest_price == null ? null : Number(item.latest_price),
          Number(item.conversion_rate),
        )
      return {
        item,
        balance,
        low: isBelowAlert(balance, item.min_stock_alert),
        value,
        avgCost: balance > 0 && value != null ? value / balance : null,
      }
    })
    .sort((a, b) => {
      if (a.low !== b.low) return a.low ? -1 : 1
      return a.item.name.localeCompare(b.item.name)
    })
}

// ─── Wastage ──────────────────────────────────────────────────────────────────

/** Asia/Kuala_Lumpur is UTC+8 all year (no DST). */
const MYT_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Monday 00:00 Asia/Kuala_Lumpur of the week containing `now`, as a UTC
 * instant. `Sun 23:30 MYT` belongs to the Monday six days earlier; `Mon 00:00
 * MYT` starts a new week.
 */
export function weekStartMYT(now: Date): Date {
  // Shift into MYT wall-clock time, then read it with the UTC getters.
  const local = new Date(now.getTime() + MYT_OFFSET_MS)
  const sinceMonday = (local.getUTCDay() + 6) % 7
  const localMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())
  return new Date(localMidnight - sinceMonday * DAY_MS - MYT_OFFSET_MS)
}

/**
 * Problem with a wastage entry, or null if it can be submitted. Mirrors the
 * log_wastage RPC's checks (in the same order) so the form can say so before
 * submitting; the RPC stays authoritative. `onHand` null = not known, so the
 * stock check is left to the RPC.
 */
export function validateWastage({ quantity, reason, note, onHand, baseUnit = '' }: {
  /** Base units. NaN when the field is empty or not a number. */
  quantity: number
  reason: string | null
  note: string | null
  onHand: number | null
  baseUnit?: string
}): string | null {
  if (!Number.isFinite(quantity) || quantity <= 0) return 'Quantity must be greater than zero'
  if (!reason) return 'Pick a reason'
  if (!(WASTAGE_REASONS as string[]).includes(reason)) return `Unknown wastage reason: ${reason}`
  if (reason === 'other' && !note?.trim()) return 'A note is required when the reason is Other'
  if (onHand != null && quantity > onHand) {
    const unit = baseUnit ? ` ${baseUnit}` : ''
    return `Cannot log ${qty(quantity)}${unit} of wastage: only ${qty(Math.max(onHand, 0))}${unit} on hand at this branch`
  }
  return null
}

type WastageValueRow = Pick<WastageLog, 'item_id' | 'branch_id' | 'value'>

export interface WastageTotals {
  /** RM. */
  total: number
  /** RM per item id. Items without wastage are absent. */
  byItem: Map<string, number>
}

/**
 * Wastage value of `logs` for the Stock on Hand filters. `branchId` 'all'
 * counts every row; `department` matches {@link buildStockRows}, judged by
 * the item's department in `items`. Logs for items not in `items` (e.g. an
 * item made inactive since) only count under 'all'. Rows without a value
 * (uncosted item) contribute 0.
 */
export function sumWastage(logs: WastageValueRow[], { branchId, department, items }: {
  branchId: string
  department: StockDepartmentFilter
  items: Pick<Item, 'id' | 'department'>[]
}): WastageTotals {
  const deptOf = new Map(items.map(i => [i.id, i.department]))
  const byItem = new Map<string, number>()
  let total = 0
  for (const log of logs) {
    if (branchId !== 'all' && log.branch_id !== branchId) continue
    if (department !== 'all') {
      if (!deptOf.has(log.item_id)) continue
      const d = deptOf.get(log.item_id) ?? null
      if (department === 'unassigned' ? d != null : d !== department) continue
    }
    const v = log.value == null ? 0 : Number(log.value)
    if (!Number.isFinite(v)) continue
    total += v
    byItem.set(log.item_id, (byItem.get(log.item_id) ?? 0) + v)
  }
  return { total, byItem }
}

// ─── Internal transfers ───────────────────────────────────────────────────────
// A PO to the HQ supplier row (suppliers.internal_branch_id set) is an internal
// PO: HQ ships it (ship_internal_po), the branch receives it. Everything below
// mirrors migration-2026-10-27-internal-transfers.sql; the RPCs stay authoritative.
// The supplier-PO helpers above are deliberately untouched by this.

/** Whether the supplier is the HQ row, i.e. a PO to it is an internal transfer. */
export function isInternalSupplier(
  supplier: Pick<Supplier, 'internal_branch_id'> | null | undefined,
): boolean {
  return !!supplier?.internal_branch_id
}

/**
 * Frontend mirror of SQL can_access_branch(): manager-tier and HR roles see
 * every branch, everyone else only their own. UI gate only — RLS decides.
 */
export function canAccessBranch(
  staff: Pick<Staff, 'rank' | 'system_role' | 'branch_id'> | null | undefined,
  branchId: string | null | undefined,
): boolean {
  if (!staff || !branchId) return false
  if (staff.rank === 'manager') return true
  if (['owner', 'admin', 'manager', 'hr'].includes(staff.system_role)) return true
  return staff.branch_id != null && staff.branch_id === branchId
}

/** Quantities of an internal PO line, in purchase units. */
export interface TransferQtyLine {
  quantity_ordered: number
  shipped_quantity?: number | null
  received_quantity: number
  transit_loss_quantity?: number | null
}

function n(v: number | null | undefined): number {
  const x = Number(v ?? 0)
  return Number.isFinite(x) ? x : 0
}

/**
 * A quantity rounded to 6 decimals, so float noise from subtracting
 * (3 − 2.9 − 0.1 = 5.55e-17) reads as 0 like the DB's exact numeric. Never -0.
 */
export function roundQty(x: number): number {
  return Math.round(x * 1e6) / 1e6 + 0
}

/** Shipped but neither received nor recorded lost. Never negative. */
export function inTransitQty(line: TransferQtyLine): number {
  return Math.max(roundQty(n(line.shipped_quantity) - n(line.received_quantity) - n(line.transit_loss_quantity)), 0)
}

/**
 * What HQ can still ship. Lost quantity counts as not shipped (HQ may re-send
 * it). Zero unless the PO is sent / partially received, like the view.
 */
export function toShipQty(line: TransferQtyLine, status: PoStatus): number {
  if (!isReceivable(status)) return 0
  return Math.max(roundQty(n(line.quantity_ordered) - n(line.shipped_quantity) + n(line.transit_loss_quantity)), 0)
}

/**
 * RM value of `quantity` purchase units at a shipped cost per base unit.
 * Null when there is no shipped cost (nothing shipped, or uncosted at HQ).
 */
export function transferValue(
  quantity: number,
  conversionRate: number | null | undefined,
  shippedUnitCost: number | null | undefined,
): number | null {
  if (shippedUnitCost == null) return null
  return n(quantity) * n(conversionRate) * n(shippedUnitCost)
}

/** RM in transit on a line at its shipped cost — po_transfer_lines.in_transit_value. */
export function inTransitValue(
  line: TransferQtyLine,
  conversionRate: number | null | undefined,
  shippedUnitCost: number | null | undefined,
): number | null {
  return transferValue(inTransitQty(line), conversionRate, shippedUnitCost)
}

/** RM lost in transit on a line at its shipped cost — po_transfer_lines.transit_loss_value. */
export function transitLossValue(
  line: TransferQtyLine,
  conversionRate: number | null | undefined,
  shippedUnitCost: number | null | undefined,
): number | null {
  return transferValue(n(line.transit_loss_quantity), conversionRate, shippedUnitCost)
}

/**
 * Weighted shipped cost per base unit over a line's shipments — what the view
 * and receive_internal_po use. Null when no costed shipment exists.
 */
export function shippedUnitCost(shipments: { qty_shipped: number; unit_cost: number | null }[]): number | null {
  const costed = shipments.filter(s => s.unit_cost != null)
  const qtySum = costed.reduce((s, x) => s + n(x.qty_shipped), 0)
  if (!(qtySum > 0)) return null
  return costed.reduce((s, x) => s + n(x.qty_shipped) * n(x.unit_cost), 0) / qtySum
}

/**
 * Problem with a shipment, or null if it can be submitted. Quantities are in
 * purchase units; `quantity` NaN = not a number. Mirrors ship_internal_po's
 * quantity checks; the on-hand check is left to the RPC (and a UI warning).
 */
export function validateShipLines(
  lines: { quantity: number; toShip: number; name?: string; unit?: string }[],
): string | null {
  for (const l of lines) {
    const label = l.name ? ` for ${l.name}` : ''
    if (!Number.isFinite(l.quantity) || l.quantity < 0) return `Enter zero or more${label}`
    if (l.quantity > l.toShip) {
      const unit = l.unit ? ` ${l.unit}` : ''
      return `Cannot ship ${qty(l.quantity)}${unit}${label}: only ${qty(l.toShip)}${unit} left to ship`
    }
  }
  if (!lines.some(l => l.quantity > 0)) return 'Nothing to ship — enter a quantity on at least one line'
  return null
}

/** Purchase units short on a received internal line: in transit − actual. Never negative. */
export function transitShortQty(inTransit: number, actual: number): number {
  return Math.max(roundQty(n(inTransit) - n(actual)), 0)
}

/**
 * Problem with a receipt on an internal PO, or null if it can be submitted.
 * Mirrors receive_internal_po: a delivery photo, actual ≤ in transit, and a
 * note whenever anything is short (recorded as lost in transit).
 */
export function validateInternalReceipt({ lines, note, hasPhoto }: {
  /** Every line with goods in transit, in purchase units. */
  lines: { inTransit: number; actual: number; name?: string }[]
  note: string | null
  hasPhoto: boolean
}): string | null {
  if (lines.length === 0) return 'Nothing is in transit on this purchase order yet'
  for (const l of lines) {
    const label = l.name ? ` for ${l.name}` : ''
    if (!Number.isFinite(l.actual) || l.actual < 0) return `Enter zero or more${label}`
    if (l.actual > l.inTransit) {
      return `Cannot receive ${qty(l.actual)}${label}: only ${qty(l.inTransit)} shipped and not yet received`
    }
  }
  if (!hasPhoto) return 'A delivery photo is required'
  if (lines.some(l => transitShortQty(l.inTransit, l.actual) > 0) && !note?.trim()) {
    return 'A note is required when less arrived than was shipped'
  }
  return null
}

export type TransferStatus =
  | 'draft' | 'cancelled' | 'closed_short'
  | 'awaiting_shipment' | 'in_transit' | 'partly_received' | 'received' | 'received_with_loss'

export const TRANSFER_STATUS_LABELS: Record<TransferStatus, string> = {
  draft:              'Draft',
  cancelled:          'Cancelled',
  closed_short:       'Closed short',
  awaiting_shipment:  'Awaiting shipment',
  in_transit:         'In transit',
  partly_received:    'Partly received',
  received:           'Received',
  received_with_loss: 'Received with loss',
}

/**
 * Where an internal PO stands from the transfer's point of view. Goods on the
 * road win over everything else; a PO whose shipped goods have all been
 * settled with some lost reads "Received with loss" (the lost part can still
 * be re-sent or closed short).
 */
export function transferStatus(status: PoStatus, lines: TransferQtyLine[]): TransferStatus {
  if (status === 'draft' || status === 'cancelled' || status === 'closed_short') return status
  if (lines.some(l => inTransitQty(l) > 0)) return 'in_transit'
  if (!lines.some(l => n(l.shipped_quantity) > 0)) return 'awaiting_shipment'
  if (lines.some(l => n(l.transit_loss_quantity) > 0)) return 'received_with_loss'
  if (lines.every(l => outstandingQty(l) === 0)) return 'received'
  return 'partly_received'
}

export function transferStatusLabel(status: PoStatus, lines: TransferQtyLine[]): string {
  return TRANSFER_STATUS_LABELS[transferStatus(status, lines)]
}

/**
 * Counterpart of a transfer ledger row, from the notes ship_internal_po writes
 * on transfer_out ("To <branch> · <PO number>"). Null when the notes don't
 * follow that shape.
 */
export function parseTransferNote(notes: string | null | undefined): { branch: string; poNumber: string | null } | null {
  const m = /^To (.+?)(?: · (\S+))?$/.exec((notes ?? '').trim())
  if (!m) return null
  return { branch: m[1], poNumber: m[2] ?? null }
}

/** Date and time in Malaysia: `27 Oct 2026, 14:05`. */
export function formatDateTimeMYT(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Asia/Kuala_Lumpur',
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

// ─── Prep-batch recipes & production ──────────────────────────────────────────
// Mirrors migration-2026-10-27-prep-recipes.sql; the RPCs stay authoritative.

/** Business day starts at 05:00 MYT (SQL business_date_of). */
const BUSINESS_DAY_START_MS = 5 * 60 * 60 * 1000

/**
 * Business date of `now` as yyyy-mm-dd: the MYT date of (now − 5 h), so
 * 04:59 MYT still belongs to the previous day. Mirrors SQL business_date_of.
 */
export function businessDateMYT(now: Date): string {
  return new Date(now.getTime() + MYT_OFFSET_MS - BUSINESS_DAY_START_MS).toISOString().slice(0, 10)
}

export type RecipeVersionStatus = 'current' | 'scheduled' | 'superseded' | 'archived' | 'unverified'

export const RECIPE_VERSION_STATUS_LABELS: Record<RecipeVersionStatus, string> = {
  current:    'Current',
  scheduled:  'Scheduled',
  superseded: 'Superseded',
  archived:   'Archived',
  unverified: 'Unverified',
}

type RecipeVersionRow = Pick<Recipe, 'id' | 'version' | 'effective_from' | 'status' | 'verified_at'>

/**
 * The version a run on `businessDate` uses: the active, verified version with
 * the latest effective_from <= that date; on a tie the higher version wins.
 * Null when none applies. Mirrors SQL recipe_for_date. Pass one item's versions.
 */
export function currentRecipe<T extends RecipeVersionRow>(recipes: T[], businessDate: string): T | null {
  let best: T | null = null
  for (const r of recipes) {
    if (r.status !== 'active' || !r.verified_at || r.effective_from > businessDate) continue
    if (!best
      || r.effective_from > best.effective_from
      || (r.effective_from === best.effective_from && r.version > best.version)) best = r
  }
  return best
}

/**
 * Status of every version of one item's recipe on `businessDate`: the one in
 * use is 'current', active verified versions starting later are 'scheduled',
 * the rest of the active verified ones 'superseded'.
 */
export function recipeVersionStatus(
  recipes: RecipeVersionRow[],
  businessDate: string,
): Map<string, RecipeVersionStatus> {
  const current = currentRecipe(recipes, businessDate)
  const out = new Map<string, RecipeVersionStatus>()
  for (const r of recipes) {
    if (r.status === 'archived') out.set(r.id, 'archived')
    else if (!r.verified_at) out.set(r.id, 'unverified')
    else if (r.id === current?.id) out.set(r.id, 'current')
    else if (r.effective_from > businessDate) out.set(r.id, 'scheduled')
    else out.set(r.id, 'superseded')
  }
  return out
}

/**
 * Estimated cost per base unit of an ingredient at a branch, as the
 * recipe_cost_estimate view does: the branch's moving-average cost, else the
 * catalogue price per base unit. Null when neither is known.
 */
export function estimatedUnitCost(
  avgUnitCost: number | null | undefined,
  latestPrice: number | null | undefined,
  conversionRate: number | null | undefined,
): number | null {
  if (avgUnitCost != null && Number.isFinite(Number(avgUnitCost))) return Number(avgUnitCost)
  return unitCostPerBase(latestPrice ?? null, conversionRate ?? null)
}

export interface RecipeCost {
  /** RM for `batches` batches. Uncosted lines contribute 0. */
  total: number
  /** RM per base unit of the output. Null when the output quantity is not positive. */
  unitCost: number | null
  /** Some line has no unit cost, so `total` is understated. */
  missingCost: boolean
}

/** Rolled-up cost of a recipe: lines are per batch, in ingredient base units. */
export function recipeCost(
  lines: { qty_base: number; unit_cost: number | null }[],
  yieldQty: number,
  batches = 1,
): RecipeCost {
  let total = 0
  let missingCost = false
  for (const l of lines) {
    if (l.unit_cost == null || !Number.isFinite(Number(l.unit_cost))) { missingCost = true; continue }
    total += n(l.qty_base) * batches * Number(l.unit_cost)
  }
  const output = n(yieldQty) * batches
  return { total, unitCost: output > 0 ? total / output : null, missingCost }
}

/**
 * Problem with a recipe draft, or null if it can be saved. Mirrors
 * save_recipe_version's checks so the form can say so before submitting.
 * Quantities NaN = empty or not a number.
 */
export function validateRecipeDraft({ yieldQty, effectiveFrom, lines, outputItemId }: {
  /** Output base units per batch. */
  yieldQty: number
  /** yyyy-mm-dd. */
  effectiveFrom: string | null
  lines: { item_id: string | null; qty_base: number; name?: string }[]
  outputItemId: string | null
}): string | null {
  if (!outputItemId) return 'Pick the item this recipe makes'
  if (!Number.isFinite(yieldQty) || yieldQty <= 0) return 'Yield must be greater than zero'
  if (!effectiveFrom || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) return 'Effective-from date is required'
  if (lines.length === 0) return 'A recipe needs at least one ingredient'
  const seen = new Set<string>()
  for (const [i, l] of lines.entries()) {
    const label = l.name ?? `Line ${i + 1}`
    if (!l.item_id) return `Line ${i + 1}: pick an ingredient`
    if (l.item_id === outputItemId) return 'A recipe cannot use its own output as an ingredient'
    if (!Number.isFinite(l.qty_base) || l.qty_base <= 0) return `${label}: quantity must be greater than zero`
    if (seen.has(l.item_id)) return `${label} is listed twice`
    seen.add(l.item_id)
  }
  return null
}

/** Ordered value of a PO line. */
export function lineTotal(line: Pick<PurchaseOrderItem, 'quantity_ordered' | 'unit_price'>): number {
  return line.quantity_ordered * line.unit_price
}

export function poTotal(lines: Pick<PurchaseOrderItem, 'quantity_ordered' | 'unit_price'>[]): number {
  return lines.reduce((sum, l) => sum + lineTotal(l), 0)
}

export function money(n: number): string {
  return `RM ${n.toFixed(2)}`
}

/** Trims trailing zeros so 2000.00 reads as 2000 but 1.5 stays 1.5. */
export function qty(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)))
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

/**
 * Plain-text PO for pasting into WhatsApp. Deliberately not markdown — WhatsApp
 * renders `*bold*` and nothing else, and suppliers read this on a phone.
 */
export function formatPoText(
  po: Pick<PurchaseOrder, 'po_number' | 'created_at' | 'notes'>,
  supplier: Pick<Supplier, 'name'> | null | undefined,
  branchName: string,
  cafeName: string,
  lines: { item: Pick<Item, 'name' | 'purchase_unit'>; quantity_ordered: number; unit_price: number }[],
): string {
  const out: string[] = []
  out.push('*PURCHASE ORDER*')
  out.push(po.po_number)
  out.push(`${cafeName} · ${branchName}`)
  out.push(`Supplier: ${supplier?.name ?? '—'}`)
  out.push(`Date: ${formatDate(po.created_at)}`)
  out.push('')

  lines.forEach((l, i) => {
    out.push(`${i + 1}. ${l.item.name}`)
    out.push(
      `   ${qty(l.quantity_ordered)} ${l.item.purchase_unit}` +
      ` × ${money(l.unit_price)} = ${money(l.quantity_ordered * l.unit_price)}`,
    )
  })

  out.push('')
  out.push(`*TOTAL: ${money(poTotal(lines))}*`)

  if (po.notes?.trim()) {
    out.push('')
    out.push(`Notes: ${po.notes.trim()}`)
  }

  return out.join('\n')
}
