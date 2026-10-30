import { formatSen } from '../order/cart'
import { formatRate, type BillTotals } from './bill'

/** The server's totals of the bill being paid (pos_checkout_state), as the checkout sheet shows them.
 *  A bill paid before discounts has no billDiscountSen in its stored totals. */
export default function CheckoutTotals({ totals, billDiscountLabel }: { totals: BillTotals | null; billDiscountLabel?: string }) {
  if (!totals) return <p className="text-brown-muted">Loading totals…</p>
  return (
    <div className="space-y-1">
      <div className="flex justify-between"><span>Subtotal</span><span>{formatSen(totals.subtotalSen)}</span></div>
      {(totals.billDiscountSen ?? 0) > 0 && (
        <div className="flex justify-between"><span>{billDiscountLabel ?? 'Discount'}</span><span>−{formatSen(totals.billDiscountSen)}</span></div>
      )}
      {totals.serviceChargeGroups.map((g) => (
        <div key={`sc${g.rateBp}`} className="flex justify-between"><span>Service charge ({formatRate(g.rateBp)})</span><span>{formatSen(g.amountSen)}</span></div>
      ))}
      {totals.sstGroups.map((g) => (
        <div key={`sst${g.rateBp}`} className="flex justify-between"><span>SST ({formatRate(g.rateBp)})</span><span>{formatSen(g.amountSen)}</span></div>
      ))}
      {totals.takeawayFeeSen > 0 && <div className="flex justify-between"><span>Takeaway packaging</span><span>{formatSen(totals.takeawayFeeSen)}</span></div>}
      <div className="flex justify-between"><span>Rounding</span><span>{formatSen(totals.roundingSen)}</span></div>
      <div className="flex justify-between border-t border-border pt-2 text-lg font-semibold"><span>Total</span><span>{formatSen(totals.totalSen)}</span></div>
    </div>
  )
}
