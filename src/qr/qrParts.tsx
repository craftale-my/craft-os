import type { ReactNode } from 'react'
import { formatSen, type PosProduct } from '../features/pos/order/cart'

/** "RM 9.00", or "from RM 9.00" when the product has several sizes. */
export const priceText = (p: PosProduct) =>
  p.variants.length > 1 ? `from ${formatSen(Math.min(...p.variants.map((v) => v.priceSen)))}` : formatSen(p.variants[0].priceSen)

/** A card of Popular here and Goes well with: photo, name, price; a tap opens the item sheet. */
export function PickCard({ product, onOpen }: { product: PosProduct; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen}
      className="flex w-28 shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card text-left">
      {product.imageUrl
        ? <img src={product.imageUrl} alt="" loading="lazy" className="h-20 w-full object-cover" />
        : <div className="h-20 w-full bg-border" />}
      <div className="p-2">
        <div className="line-clamp-2 text-xs font-medium">{product.name}</div>
        <div className="mt-0.5 text-xs text-brown-muted">{priceText(product)}</div>
      </div>
    </button>
  )
}

/** The sub-header of the cart / sent / orders views: a back button and the title. */
export function PageHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-1 px-2 py-2">
      <button type="button" aria-label="Back to menu" onClick={onBack} className="h-11 w-11 shrink-0 text-xl">←</button>
      <h1 className="text-lg font-semibold text-brown-dark">{title}</h1>
    </div>
  )
}

export function Shell({ title, right, children }: { title?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-cream">
      <header className="flex items-center justify-between gap-3 bg-brown-header px-4 py-3 text-white">
        <div>
          <div className="text-xs opacity-80">Craft Cafe</div>
          <div className="text-lg font-semibold">{title ?? 'Order'}</div>
        </div>
        {right}
      </header>
      {children}
    </div>
  )
}
