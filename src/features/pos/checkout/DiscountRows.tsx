// src/features/pos/checkout/DiscountRows.tsx
import { formatSen } from '../order/cart'
import type { DiscountRow } from './discounts'

/** The grey rows under a discounted line: "Staff Meal 50% −RM 21.50". */
export default function DiscountRows({ rows }: { rows: DiscountRow[] }) {
  return <>{rows.map((r) => <span key={r.label} className="block pl-4 text-xs text-brown-muted">{r.label} −{formatSen(r.amountSen)}</span>)}</>
}
