import type { PosProduct } from '../features/pos/order/cart'
import PickPill from '../features/pos/order/PickPill'
import { PickerAvatars, priceText, ProductPhoto, productLabel, QtyBadge } from './qrParts'
import type { Picker } from './qrCart'

/** The menu as flat rows (reference frames 03–05): name, description and price on the left, a square
 *  photo on the right when there is one, a hairline between rows. A row opens the item page; the badge
 *  counts the units of that product in the whole table's cart. */
export default function MenuList({ products, popularIds, units, pickers, onOpen }: {
  products: PosProduct[]
  popularIds: ReadonlySet<string>
  /** product id → units in the table's cart (available lines) */
  units: ReadonlyMap<string, number>
  /** product id → who has it in the table's cart (their avatars sit on the photo) */
  pickers?: ReadonlyMap<string, readonly Picker[]>
  onOpen: (product: PosProduct) => void
}) {
  return (
    <ul className="px-4">
      {products.filter((p) => p.variants.length > 0).map((p) => {
        const n = units.get(p.id) ?? 0
        const w = pickers?.get(p.id) ?? []
        const popular = popularIds.has(p.id)
        return (
          <li key={p.id} className="border-b border-border last:border-0">
            <button type="button" disabled={p.soldOut} aria-label={productLabel(p, popular, n, w)} onClick={() => onOpen(p)}
              className="flex w-full items-start gap-4 py-4 text-left disabled:opacity-50">
              <div className="min-w-0 flex-1">
                <div className="text-[17px] font-semibold leading-snug text-brown-dark">{p.name}</div>
                {p.description && <div className="mt-1 line-clamp-2 text-[15px] leading-snug text-brown-muted">{p.description}</div>}
                <div className="mt-1.5 text-[17px] text-brown-dark">{p.soldOut ? `Sold out · ${priceText(p)}` : priceText(p)}</div>
                {popular && <div className="-ml-1.5 mt-1"><PickPill text="Popular" /></div>}
              </div>
              {p.imageUrl ? (
                <div className="relative shrink-0">
                  <ProductPhoto src={p.imageUrl} className="h-24 w-24 rounded-lg" />
                  {n > 0 && <QtyBadge n={n} className="absolute -right-1.5 -top-1.5" />}
                  <PickerAvatars who={w} className="absolute bottom-1 left-1" />
                </div>
              ) : n > 0 && <span className="mt-0.5 flex shrink-0 items-center gap-1.5"><PickerAvatars who={w} /><QtyBadge n={n} /></span>}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
