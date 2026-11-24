// src/features/pos/checkout/discounts.ts
/** Discounts (docs/superpowers/specs/2026-10-30-pos-discounts-design.md): what the cashier types,
 *  the server's words for a bad value, and the grey rows under a discounted line. The money is
 *  computeBill's (bill.ts) and the server's. */
import { formatRate, type BillLineTotals, type BillTotals, type DiscountInput, type DiscountKind } from './bill'

export const QUICK_PERCENTS = [5, 10, 20, 50] as const

export interface DiscountRow { label: string; amountSen: number }
/** A discount as the order_items / bills discount_* columns keep it. */
export interface StoredDiscount { kind: DiscountKind; value: number; reason: string | null }

/** The same words as pos_check_discount; null = fine. */
export function discountProblem(kind: DiscountKind, text: string): string | null {
  const t = text.trim()
  if (t === '') return 'Enter a discount'
  if (kind === 'percent') {
    return /^\d{1,3}$/.test(t) && Number(t) >= 1 && Number(t) <= 100 ? null : 'Enter a whole percent from 1 to 100'
  }
  return /^\d{1,6}(\.\d{1,2})?$/.test(t) && Math.round(Number(t) * 100) > 0 ? null : 'Enter an amount above RM 0.00'
}

/** What the cashier typed, as the server stores it: a percent in basis points, ringgit in sen. */
export function parseDiscount(kind: DiscountKind, text: string): DiscountInput | null {
  if (discountProblem(kind, text) !== null) return null
  const n = Number(text.trim())
  return kind === 'percent' ? { kind, value: n * 100 } : { kind, value: Math.round(n * 100) }
}

/** "Discount 10%" or "Discount"; screens add the reason in brackets (the receipt never does). */
export function discountLabel(d: StoredDiscount, withReason: boolean): string {
  const base = d.kind === 'percent' ? `Discount ${formatRate(d.value)}` : 'Discount'
  return withReason && d.reason ? `${base} (${d.reason})` : base
}

export function storedDiscount(row: { discount_kind: DiscountKind | null; discount_value: number | null; discount_reason: string | null }): StoredDiscount | null {
  return row.discount_kind && row.discount_value !== null ? { kind: row.discount_kind, value: row.discount_value, reason: row.discount_reason } : null
}

/** BillTotals.lines by order item id (drafts have no id; bills paid before discounts have no lines). */
export function linesById(t: BillTotals | null | undefined): Map<string, BillLineTotals> {
  return new Map((t?.lines ?? []).flatMap((l) => (l.id ? [[l.id, l] as const] : [])))
}

/** The grey rows under a line: its catalog discount, then its own — only what actually came off. */
export function lineDiscountRows(
  item: { catalog_discount_bp: number; catalog_discount_name: string | null; discount_kind: DiscountKind | null; discount_value: number | null; discount_reason: string | null },
  amounts: Pick<BillLineTotals, 'catalogDiscountSen' | 'itemDiscountSen'> | undefined,
): DiscountRow[] {
  if (!amounts) return []
  const rows: DiscountRow[] = []
  if (amounts.catalogDiscountSen > 0) {
    rows.push({ label: `${item.catalog_discount_name ?? 'Catalog'} ${formatRate(item.catalog_discount_bp)}`, amountSen: amounts.catalogDiscountSen })
  }
  const d = storedDiscount(item)
  if (d && amounts.itemDiscountSen > 0) rows.push({ label: discountLabel(d, true), amountSen: amounts.itemDiscountSen })
  return rows
}

/** The tag at the top of a bill with a catalog discount: "Staff Meal 50%". */
export function catalogTag(items: { catalog_discount_bp: number; catalog_discount_name: string | null; voided_at: string | null }[]): string | null {
  const it = items.find((i) => i.voided_at === null && i.catalog_discount_bp > 0)
  return it ? `${it.catalog_discount_name ?? 'Catalog'} ${formatRate(it.catalog_discount_bp)}` : null
}
