import { formatSen } from '../features/pos/order/cart'
import { groupOrdered, type OrderedItem } from './qrCart'
import { avatarEmoji } from './qrGuest'
import { PageHeader } from './qrParts'

/** Everything the table has ordered so far, by guest (the counter last). */
export default function OrdersPage({ items, subtotalSen, onBack }: {
  items: OrderedItem[]
  subtotalSen: number
  onBack: () => void
}) {
  if (items.length === 0) {
    return (
      <div>
        <PageHeader title="Orders" onBack={onBack} />
        <div className="p-6 text-center">
          <p className="text-brown-muted">Nothing ordered yet.</p>
          <button type="button" onClick={onBack} className="mt-3 min-h-11 rounded-xl bg-brown-btn px-5 text-white">Back to menu</button>
        </div>
      </div>
    )
  }
  return (
    <div className="pb-8">
      <PageHeader title="Orders" onBack={onBack} />
      <div className="px-3 text-sm">
        {groupOrdered(items).map((g) => (
          <section key={g.label ?? '-counter-'} className="mb-3">
            <h2 className="text-xs font-semibold text-brown-muted">{g.label === null ? 'Ordered at the counter' : `${avatarEmoji(g.avatar)} ${g.label}`.trim()}</h2>
            {g.items.map((i, k) => (
              <div key={k} className={`flex justify-between gap-2 py-1 ${i.voided ? 'line-through opacity-50' : ''}`}>
                <div>
                  <div>{i.qty} × {i.name}</div>
                  {i.mods.length > 0 && <div className="text-xs text-brown-muted">{i.mods.join(', ')}</div>}
                </div>
                <div className="shrink-0">{formatSen(i.unitPriceSen * i.qty)}</div>
              </div>
            ))}
          </section>
        ))}
        <div className="border-t border-border pt-2">
          <div className="flex justify-between font-semibold"><span>Subtotal</span><span>{formatSen(subtotalSen)}</span></div>
          <p className="text-xs text-brown-muted">Before service charge and tax.</p>
        </div>
      </div>
    </div>
  )
}
