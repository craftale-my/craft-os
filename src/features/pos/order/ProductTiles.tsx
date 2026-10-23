// src/features/pos/order/ProductTiles.tsx
import { formatSen, type PosProduct } from './cart'
import { tileSlotLabel, type MenuWindows } from './padSlots'

/** The pad's product tiles. A sold-out product, or one outside its time slots at `now` (the
 *  server's time, moved on every minute by usePadWindows), is greyed out and says why; tapping
 *  it only works in sold-out mode (the pad decides). */
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
        const tappable = soldOutMode || (!p.soldOut && slot === null)     // what the pad's tap() accepts
        const look = p.soldOut ? 'border-red-300 bg-red-50 text-red-700'
          : slot ? 'border-border bg-cream text-brown-faint' : 'border-border bg-card'
        return (
          <button key={p.id} onClick={() => onTap(p, slot !== null)} aria-disabled={!tappable}
            className={`min-h-20 rounded-xl border p-2 text-left text-sm ${look}`}>
            <div className="font-medium">{p.name}</div>
            <div className="text-xs text-brown-muted">{p.variants.length > 1 ? `${formatSen(Math.min(...p.variants.map((v) => v.priceSen)))} –` : formatSen(p.variants[0].priceSen)}{p.soldOut && ' · SOLD OUT'}</div>
            {slot && <div className="text-xs">{slot}</div>}
          </button>
        )
      })}
    </>
  )
}
