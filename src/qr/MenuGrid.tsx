import type { PosProduct } from '../features/pos/order/cart'
import PickPill from '../features/pos/order/PickPill'
import { priceText } from './qrParts'

/** The menu as a grid of square tiles. A tile opens the item sheet; the badge counts the units of that
 *  product in the whole table's cart. */
export default function MenuGrid({ products, popularIds, units, onOpen }: {
  products: PosProduct[]
  popularIds: ReadonlySet<string>
  /** product id → units in the table's cart (available lines) */
  units: ReadonlyMap<string, number>
  onOpen: (product: PosProduct) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-3 px-3 pb-24 sm:grid-cols-3">
      {products.filter((p) => p.variants.length > 0).map((p) => {
        const n = units.get(p.id) ?? 0
        const price = priceText(p)
        const popular = popularIds.has(p.id)
        const label = p.soldOut ? `${p.name}, ${price}, sold out`
          : `${p.name}, ${price}${popular ? ', Popular' : ''}${n > 0 ? `, ${n} in the cart` : ''}`
        return (
          <button key={p.id} type="button" disabled={p.soldOut} aria-label={label} onClick={() => onOpen(p)}
            className="flex flex-col overflow-hidden rounded-xl border border-border bg-card text-left disabled:opacity-50">
            <div className="relative">
              {p.imageUrl
                ? <img src={p.imageUrl} alt="" loading="lazy" className="aspect-square w-full object-cover" />
                : <div className="aspect-square w-full bg-border" />}
              {n > 0 && (
                <span data-testid="qty-badge" aria-hidden="true"
                  className="absolute right-2 top-2 flex h-7 min-w-7 items-center justify-center rounded-full bg-brown-btn px-1.5 text-sm font-semibold text-white">{n}</span>
              )}
              {p.soldOut && (
                <span className="absolute inset-x-0 bottom-0 bg-black/60 py-1 text-center text-xs font-semibold text-white">Sold out</span>
              )}
            </div>
            <div className="p-2">
              {popular && <div className="-ml-1.5 mb-1"><PickPill text="Popular" /></div>}
              <div data-testid="tile-name" className="line-clamp-2 text-sm font-medium">{p.name}</div>
              <div className="mt-0.5 text-xs text-brown-muted">{price}</div>
            </div>
          </button>
        )
      })}
    </div>
  )
}
