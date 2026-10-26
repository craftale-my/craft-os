// src/features/pos/order/ProductTiles.tsx
import { formatSen, type PosProduct } from './cart'
import { tileSlotLabel, type MenuWindows } from './padSlots'
import { tileInitials } from './modifiers'

/** The order screen's product tiles, Feedme style: photo on top (or the first three letters on a
 *  grey block), name and price below. A sold-out product, or one outside its time slots at `now`
 *  (the server's time, moved on every minute by usePadWindows), is greyed out and says why;
 *  tapping it only works in sold-out mode (the screen decides). */
export default function ProductTiles({ products, windows, now, soldOutMode, onTap }: {
  products: PosProduct[]
  windows: MenuWindows
  now: Date
  /** in sold-out mode every tile can be tapped (to mark it sold out or back) */
  soldOutMode: boolean
  onTap: (p: PosProduct, outOfSlot: boolean) => void
}) {
  return (
    <>
      {products.map((p) => {
        const slot = tileSlotLabel(windows, p.id, now)
        const tappable = soldOutMode || (!p.soldOut && slot === null)     // what the screen's tap() accepts
        const dim = p.soldOut || slot !== null
        const price = p.variants.length > 1 ? `${formatSen(Math.min(...p.variants.map((v) => v.priceSen)))} –` : formatSen(p.variants[0].priceSen)
        return (
          <button key={p.id} type="button" onClick={() => onTap(p, slot !== null)} aria-disabled={!tappable}
            className={`flex min-h-36 flex-col overflow-hidden rounded-xl border bg-card text-left ${p.soldOut ? 'border-red-300' : 'border-border'} ${soldOutMode ? 'ring-2 ring-red-200' : ''}`}>
            <div className={`relative h-20 w-full bg-border ${dim ? 'opacity-50 grayscale' : ''}`}>
              {p.imageUrl
                ? <img src={p.imageUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
                : <div className="flex h-full items-center justify-center text-2xl font-semibold text-brown-muted">{tileInitials(p.name)}</div>}
              {p.soldOut && <span className="absolute left-1 top-1 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white">SOLD OUT</span>}
            </div>
            <div className={`flex flex-1 flex-col p-2 ${dim ? 'text-brown-faint' : 'text-brown-dark'}`}>
              <div className="line-clamp-2 text-sm font-medium">{p.name}</div>
              <div className="mt-auto text-xs text-brown-muted">{price}</div>
              {slot && <div className="text-xs">{slot}</div>}
            </div>
          </button>
        )
      })}
    </>
  )
}
