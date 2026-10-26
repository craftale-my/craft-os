import type {
  InventoryBalance, Item, ItemDepartment, PurchaseOrder, PurchaseOrderItem, PoStatus, Supplier,
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

/** Statuses submit_receiving accepts. */
export function isReceivable(status: PoStatus): boolean {
  return status === 'sent' || status === 'partially_received'
}

/**
 * Applies one delivery to the PO lines, returning new lines with cumulative
 * `received_quantity`. Mirrors the submit_receiving RPC's checks so the UI can
 * validate before submitting: throws on an unknown or repeated line, a
 * negative quantity, or more than is outstanding. Lines left out of
 * `deliveries` are unchanged.
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
    const outstanding = outstandingQty(line)
    if (d.actual_quantity > outstanding) {
      throw new Error(
        `Cannot receive ${qty(d.actual_quantity)} on line ${d.po_item_id} — only ${qty(outstanding)} outstanding`,
      )
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
 */
export function stockValue(balance: number, latestPrice: number | null, conversionRate: number): number | null {
  if (latestPrice == null || !(conversionRate > 0)) return null
  return (latestPrice / conversionRate) * balance
}

export type StockDepartmentFilter = 'all' | ItemDepartment | 'unassigned'

export interface StockRow {
  item: Item
  /** Base units. */
  balance: number
  low: boolean
  value: number | null
}

/**
 * Rows for the Stock on Hand page. `branchId` 'all' sums every branch the
 * viewer can see; otherwise only that branch counts. Low stock sorts first,
 * then by name — the point of the screen is surfacing what needs reordering.
 */
export function buildStockRows({ items, balances, branchId, department, search }: {
  items: Item[]
  balances: InventoryBalance[]
  /** A branch id, or 'all'. */
  branchId: string
  department: StockDepartmentFilter
  search: string
}): StockRow[] {
  const totals = new Map<string, number>()
  for (const b of balances) {
    if (branchId !== 'all' && b.branch_id !== branchId) continue
    totals.set(b.item_id, (totals.get(b.item_id) ?? 0) + Number(b.balance))
  }

  const term = search.trim().toLowerCase()
  return items
    .filter(i => department === 'all'
      || (department === 'unassigned' ? i.department == null : i.department === department))
    .filter(i => !term
      || i.name.toLowerCase().includes(term)
      || (i.name_zh ?? '').toLowerCase().includes(term))
    .map(item => {
      const balance = totals.get(item.id) ?? 0
      return {
        item,
        balance,
        low: isBelowAlert(balance, item.min_stock_alert),
        value: stockValue(balance, item.latest_price, item.conversion_rate),
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
  lines: { item: Pick<Item, 'name' | 'name_zh' | 'purchase_unit'>; quantity_ordered: number; unit_price: number }[],
): string {
  const out: string[] = []
  out.push('*PURCHASE ORDER*')
  out.push(po.po_number)
  out.push(`${cafeName} · ${branchName}`)
  out.push(`Supplier: ${supplier?.name ?? '—'}`)
  out.push(`Date: ${formatDate(po.created_at)}`)
  out.push('')

  lines.forEach((l, i) => {
    const name = l.item.name_zh ? `${l.item.name} (${l.item.name_zh})` : l.item.name
    out.push(`${i + 1}. ${name}`)
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
