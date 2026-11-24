import { formatSen } from '../features/pos/order/cart'
import { groupOrdered, type OrderedItem } from './qrCart'
import { GuestLine, ItemLine, PageHeader } from './qrParts'

/** Everything the table has ordered so far, by guest (the counter last), in the order-details line shape. */
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
    <div className="pb-28">
      <PageHeader title="Orders" onBack={onBack} />
      <div className="px-4 pt-2">
        {groupOrdered(items).map((g) => (
          <section key={g.label ?? '-counter-'} className="pt-2">
            <GuestLine avatar={g.label === null ? null : g.avatar} label={g.label ?? 'Ordered at the counter'} />
            {g.items.map((i, k) => (
              <ItemLine key={k} qty={i.qty} name={i.name} mods={i.mods} note={i.note} priceSen={i.unitPriceSen * i.qty} voided={i.voided} />
            ))}
          </section>
        ))}
      </div>
      <div className="mt-3 border-t-8 border-brown-track px-4 pt-4">
        <div className="flex justify-between text-[17px] font-bold text-brown-dark"><span>Subtotal</span><span>{formatSen(subtotalSen)}</span></div>
        <p className="mt-1 text-sm text-brown-muted">Before service charge and tax.</p>
      </div>
      <div className="fixed inset-x-0 bottom-0 z-10 mx-auto max-w-lg bg-cream px-4 pb-4 pt-3">
        <button type="button" onClick={onBack} className="min-h-14 w-full rounded-xl bg-brown-btn text-[17px] font-semibold text-white">Back to menu</button>
      </div>
    </div>
  )
}
