// src/qr/AiPickCard.tsx
import { Plus, Sparkles, X } from 'lucide-react'
import type { PosProduct } from '../features/pos/order/cart'
import { aiPickOpens } from './aiPick'
import Mascot from './Mascot'
import { ProductPhoto, priceText } from './qrParts'

/** The cart's AI Pick (spec 2026-11-22-qr-ai-pick-mascot-design.md §2; reference frame 12): the mascot and
 *  an `AI Pick` pill over one line, then the suggested product with Add. A product that needs a choice
 *  opens its item page instead of being added. ✕ hides the card for this visit. */
export default function AiPickCard({ product, sentence, busy = false, onAdd, onOpen, onHide }: {
  product: PosProduct
  /** the line to show (the picked sentence; a later source may replace it) */
  sentence: string
  /** an Add from the card is being written */
  busy?: boolean
  onAdd: (product: PosProduct) => void
  onOpen: (product: PosProduct) => void
  onHide: () => void
}) {
  const opens = aiPickOpens(product)
  return (
    <section aria-labelledby="cart-ai-pick" className="mt-2 border-t-8 border-brown-track px-4 pb-1 pt-4">
      <div className="flex items-start gap-3">
        <Mascot pose="pick" size={60} className="-ml-1" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between">
            <span id="cart-ai-pick" className="inline-flex items-center gap-1 rounded-full bg-brown-btn px-2.5 py-0.5 text-[13px] font-semibold text-white">
              <Sparkles size={13} aria-hidden="true" />AI Pick
            </span>
            <button type="button" aria-label="Hide AI Pick" onClick={onHide}
              className="-mr-2 -mt-2 flex h-10 w-10 items-center justify-center text-brown-muted"><X size={18} /></button>
          </div>
          <p className="mt-1.5 text-[16px] font-semibold leading-snug text-brown-dark">{sentence}</p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3 rounded-2xl border border-border bg-card p-2.5">
        <button type="button" onClick={() => onOpen(product)} aria-label={`Open ${product.name}`} className="shrink-0">
          {product.imageUrl
            ? <ProductPhoto src={product.imageUrl} className="h-16 w-16 rounded-xl" placeholderClassName="bg-brown-track" />
            : <div className="h-16 w-16 rounded-xl bg-brown-track" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-[15px] font-semibold leading-snug text-brown-dark">{product.name}</div>
          <div className="mt-0.5 text-[15px] text-brown-dark">{priceText(product)}</div>
        </div>
        <button type="button" disabled={busy} aria-label={`Add ${product.name}`}
          onClick={() => (opens ? onOpen(product) : onAdd(product))}
          className="flex min-h-11 shrink-0 items-center gap-1 rounded-xl bg-brown-btn px-4 text-[15px] font-semibold text-white disabled:opacity-50">
          <Plus size={16} aria-hidden="true" />{busy ? 'Adding…' : 'Add'}
        </button>
      </div>
    </section>
  )
}
