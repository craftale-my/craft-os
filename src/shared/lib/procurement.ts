import type {
  InventoryBalance, InventoryValuation, Item, ItemDepartment, PurchaseOrder, PurchaseOrderItem, PoStatus, Supplier,
} from '../types'

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
