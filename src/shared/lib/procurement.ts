import type { Item, PurchaseOrder, PurchaseOrderItem, PoStatus, Supplier } from '../types'

/** Purchase units → base units. `1 包 = 2000 g` ⇒ toBaseUnits(3, 2000) = 6000. */
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
 * PO status after receiving. Phase 1 receives a PO exactly once, so any
 * shortfall closes the order as `partially_received` — it does not stay open
 * for a second delivery.
 */
export function derivePoStatus(
  lines: { quantity_ordered: number; actual_quantity: number }[],
): Extract<PoStatus, 'received' | 'partially_received'> {
  const short = lines.some(l => calcShortage(l.quantity_ordered, l.actual_quantity) > 0)
  return short ? 'partially_received' : 'received'
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
