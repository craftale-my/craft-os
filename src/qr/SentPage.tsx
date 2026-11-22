import { Check, ConciergeBell, ReceiptText } from 'lucide-react'
import { findProduct, lineLabel, linePriceSen, type PosMenu } from '../features/pos/order/cart'
import type { GuestGroup } from './qrCart'
import { GuestLine, ItemLine, PageHeader } from './qrParts'
import Mascot from './Mascot'

/** Order details (reference frames 13, 14), shown to the guest who sent the table's order: what was sent
 *  (the groups the send sheet showed). */
export default function SentPage({ menu, groups, tableLabel, billNo, onAddMore, onViewOrders, earns = false }: {
  menu: PosMenu
  groups: GuestGroup[]
  tableLabel: string
  billNo: string | null
  onAddMore: () => void
  onViewOrders: () => void
  /** members: signed in and this bill is linked to this phone's number */
  earns?: boolean
}) {
  return (
    <div className="pb-28">
      <PageHeader title="Order details" onClose={onAddMore} />
      <div className="px-4 pb-6 pt-8 text-center">
        <div className="flex items-end justify-center gap-2">
          <div aria-hidden="true" className="flex h-16 w-16 items-center justify-center rounded-full bg-brown-btn text-white">
            <Check size={34} strokeWidth={3} />
          </div>
          <Mascot pose="cheer" size={72} className="-mb-1" />
        </div>
        <h2 className="mt-4 text-[24px] font-bold text-brown-dark">Order sent</h2>
        {earns && <p className="mt-2 text-sm text-brown-muted">You'll earn points when this bill is paid at the counter.</p>}
      </div>
      {/* the reference's progress strip: four steps, the first (sent) done — the page tracks no later step */}
      <div aria-hidden="true" className="grid grid-cols-4 gap-1">
        {[0, 1, 2, 3].map((k) => <div key={k} className={`h-1 ${k === 0 ? 'bg-brown-btn' : 'bg-brown-track'}`} />)}
      </div>
      <div data-testid="sent-columns" className={`grid py-6 text-center ${billNo ? 'grid-cols-2' : 'grid-cols-1'}`}>
        <div>
          <div className="text-[17px] font-semibold text-brown-dark">Table</div>
          <div className="mt-2 flex items-center justify-center gap-2 text-[22px] text-brown-dark">
            <ConciergeBell size={22} aria-hidden="true" /><span>{tableLabel}</span>
          </div>
        </div>
        {billNo && (
          <div>
            <div className="text-[17px] font-semibold text-brown-dark">Bill no.</div>
            <div className="mt-2 flex items-center justify-center gap-2 text-[22px] text-brown-dark">
              <ReceiptText size={22} aria-hidden="true" /><span>{billNo}</span>
            </div>
          </div>
        )}
      </div>
      <section aria-labelledby="sent-items" className="border-t-8 border-brown-track px-4 pt-4">
        <h2 id="sent-items" className="text-[19px] font-bold text-brown-dark">Items</h2>
        {groups.map((g) => (
          <div key={g.guestId}>
            <GuestLine avatar={g.avatar} label={g.label} />
            {g.lines.map((l) => {
              const p = findProduct(menu, l.productId)
              if (!p) return null
              const { name, mods } = lineLabel(p, l)
              return <ItemLine key={l.id} qty={l.qty} name={name} mods={mods} note={l.note} priceSen={(linePriceSen(p, l) ?? 0) * l.qty} />
            })}
          </div>
        ))}
      </section>
      <div className="fixed inset-x-0 bottom-0 z-10 mx-auto flex max-w-lg gap-3 bg-cream px-4 pb-4 pt-3">
        <button type="button" onClick={onAddMore}
          className="min-h-14 flex-1 rounded-xl border-2 border-brown-btn text-[17px] font-semibold text-brown-btn">Add more</button>
        <button type="button" onClick={onViewOrders}
          className="flex min-h-14 flex-1 items-center justify-center gap-2 rounded-xl bg-brown-btn text-[17px] font-semibold text-white">
          <ReceiptText size={20} aria-hidden="true" />Orders
        </button>
      </div>
    </div>
  )
}
