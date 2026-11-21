import type { PosProduct } from '../features/pos/order/cart'
import PickPill from '../features/pos/order/PickPill'
import { priceText, productLabel, QtyBadge } from './qrParts'

/** The menu as a grid of two columns: a soft square photo with the name and price under it, no card box.
 *  A tile opens the item page; the badge counts the units of that product in the whole table's cart. */
export default function MenuGrid({ products, popularIds, units, onOpen }: {
  products: PosProduct[]
  popularIds: ReadonlySet<string>
  /** product id → units in the table's cart (available lines) */
  units: ReadonlyMap<string, number>
  onOpen: (product: PosProduct) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-5 px-4 pb-1 pt-1 sm:grid-cols-3">
      {products.filter((p) => p.variants.length > 0).map((p) => {
        const n = units.get(p.id) ?? 0
        const popular = popularIds.has(p.id)
        return (
          <button key={p.id} type="button" disabled={p.soldOut} aria-label={productLabel(p, popular, n)} onClick={() => onOpen(p)}
            className="flex flex-col text-left disabled:opacity-50">
            <div className="relative w-full">
              {p.imageUrl
                ? <img src={p.imageUrl} alt="" loading="lazy" className="aspect-square w-full rounded-xl object-cover" />
                : <div className="aspect-square w-full rounded-xl bg-border" />}
              {n > 0 && <QtyBadge n={n} className="absolute right-2 top-2" />}
            </div>
            {popular && <div className="-ml-1.5 mt-1.5"><PickPill text="Popular" /></div>}
            <div data-testid="tile-name" className="mt-1.5 line-clamp-2 text-[15px] font-semibold leading-snug text-brown-dark">{p.name}</div>
            <div className="mt-0.5 text-[15px] text-brown-dark">{p.soldOut ? `Sold out · ${priceText(p)}` : priceText(p)}</div>
          </button>
        )
      })}
    </div>
  )
}
