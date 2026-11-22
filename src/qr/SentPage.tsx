import { findProduct, formatSen, lineLabel, linePriceSen, type PosMenu } from '../features/pos/order/cart'
import type { GuestGroup } from './qrCart'
import { avatarEmoji } from './qrGuest'

/** Shown to the guest who sent the table's order: what was sent (the groups the send sheet showed). */
export default function SentPage({ menu, groups, tableLabel, billNo, onAddMore, onViewOrders }: {
  menu: PosMenu
  groups: GuestGroup[]
  tableLabel: string
  billNo: string | null
  onAddMore: () => void
  onViewOrders: () => void
}) {
  return (
    <div className="px-4 pb-8 pt-6 text-sm">
      <div className="text-center">
        <div aria-hidden="true" className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-green-100 text-3xl text-green-700">✓</div>
        <h1 className="mt-3 text-xl font-semibold text-brown-dark">Order placed</h1>
        <p className="text-brown-muted">Table {tableLabel}{billNo ? ` · Bill ${billNo}` : ''}</p>
        <p className="mt-1">It is on its way.</p>
      </div>
      <div className="mt-5 rounded-xl border border-border bg-card p-3">
        {groups.map((g) => (
          <section key={g.guestId} className="mb-2 last:mb-0">
            <h2 className="text-xs font-semibold text-brown-muted">{avatarEmoji(g.avatar)} {g.label}</h2>
            {g.lines.map((l) => {
              const p = findProduct(menu, l.productId)
              if (!p) return null
              const { name, mods } = lineLabel(p, l)
              return (
                <div key={l.id} className="flex justify-between gap-2 py-1">
                  <div>
                    <div>{l.qty} × {name}</div>
                    {mods.length > 0 && <div className="text-xs text-brown-muted">{mods.join(', ')}</div>}
                  </div>
                  <div className="shrink-0">{formatSen((linePriceSen(p, l) ?? 0) * l.qty)}</div>
                </div>
              )
            })}
          </section>
        ))}
      </div>
      <div className="mt-5 flex gap-2">
        <button type="button" onClick={onAddMore} className="min-h-12 flex-1 rounded-xl border border-border bg-card py-3">Add more</button>
        <button type="button" onClick={onViewOrders} className="min-h-12 flex-1 rounded-xl bg-brown-btn py-3 text-white">View orders</button>
      </div>
    </div>
  )
}
