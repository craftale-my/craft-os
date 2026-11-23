import { useEffect, useState, type ReactNode } from 'react'
import { ChevronLeft, X } from 'lucide-react'
import { formatSen, type PosProduct } from '../features/pos/order/cart'
import { isAnimatedPhoto } from '../features/pos/menu/photo'
import { avatarEmoji } from './qrGuest'
import { pickersText, type Picker } from './qrCart'

/** "RM 9.00", or "from RM 9.00" when the product has several sizes. */
export const priceText = (p: PosProduct) =>
  p.variants.length > 1 ? `from ${formatSen(Math.min(...p.variants.map((v) => v.priceSen)))}` : formatSen(p.variants[0].priceSen)

/** What a menu row / tile says to a screen reader: name, price, Popular, units in the table's cart. */
export const productLabel = (p: PosProduct, popular: boolean, units: number, who: readonly Picker[] = []) => {
  const price = priceText(p)
  return p.soldOut ? `${p.name}, ${price}, sold out`
    : `${p.name}, ${price}${popular ? ', Popular' : ''}${units > 0 ? `, ${units} in the cart` : ''}${who.length > 0 ? ` (${pickersText(who)})` : ''}`
}

/** Who picked it: the guests' avatars in small overlapping circles (at most 3, then "+n"), on a menu
 *  tile or row. Decorative — the tile's label names them. */
export function PickerAvatars({ who, className = '' }: { who: readonly Picker[]; className?: string }) {
  if (who.length === 0) return null
  const shown = who.slice(0, 3)
  return (
    <span data-testid="picker-avatars" aria-hidden="true" className={`flex items-center ${className}`}>
      {shown.map((w, i) => (
        <span key={w.guestId} title={w.isMe ? 'You' : w.label}
          className={`flex h-7 w-7 items-center justify-center rounded-full bg-card text-[15px] leading-none shadow ring-2 ${w.isMe ? 'ring-brown-btn' : 'ring-cream'} ${i > 0 ? '-ml-2' : ''}`}>
          {avatarEmoji(w.avatar) || (w.label.trim()[0] ?? '?').toUpperCase()}
        </span>
      ))}
      {who.length > shown.length && (
        <span className="-ml-2 flex h-7 min-w-7 items-center justify-center rounded-full bg-card px-1 text-xs font-semibold text-brown-dark shadow ring-2 ring-cream">+{who.length - shown.length}</span>
      )}
    </span>
  )
}

/** The round count of a product's units in the table's cart, on a menu row or tile. */
export function QtyBadge({ n, className = '' }: { n: number; className?: string }) {
  return (
    <span data-testid="qty-badge" aria-hidden="true"
      className={`flex h-7 min-w-7 items-center justify-center rounded-full bg-brown-btn px-1.5 text-sm font-semibold text-white ring-2 ring-cream ${className}`}>{n}</span>
  )
}

const REDUCE = '(prefers-reduced-motion: reduce)'
const reduceNow = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(REDUCE).matches

/** True while the phone asks for reduced motion; follows a change of the setting. */
function useReducedMotion(): boolean {
  const [on, setOn] = useState(reduceNow)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(REDUCE)
    const sync = () => setOn(mq.matches)
    sync()
    mq.addEventListener?.('change', sync)
    return () => mq.removeEventListener?.('change', sync)
  }, [])
  return on
}

/** A product photo in a menu list (grid tile, list row, pairing card or row), loaded lazily. An animation
 *  (.gif, .anim.webp) plays, except for a guest whose phone asks for reduced motion: they see the quiet
 *  placeholder instead (a first frame would need a second file). The item page's photo always plays. */
export function ProductPhoto({ src, className, placeholderClassName = 'bg-border' }: {
  src: string
  /** size and shape, shared by the photo and the placeholder */
  className: string
  placeholderClassName?: string
}) {
  const reduce = useReducedMotion()
  if (reduce && isAnimatedPhoto(src)) return <div aria-hidden="true" className={`${className} ${placeholderClassName}`} />
  return <img src={src} alt="" loading="lazy" className={`${className} object-cover`} />
}

/** A card of Goes well with your order: square photo, name, price; a tap opens the item page. */
export function PickCard({ product, onOpen }: { product: PosProduct; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="flex w-36 shrink-0 flex-col text-left">
      {product.imageUrl
        ? <ProductPhoto src={product.imageUrl} className="aspect-square w-full rounded-xl" placeholderClassName="bg-brown-track" />
        : <div className="aspect-square w-full rounded-xl bg-brown-track" />}
      <div className="mt-1.5 line-clamp-2 text-[15px] font-semibold leading-snug text-brown-dark">{product.name}</div>
      <div className="mt-0.5 text-[15px] text-brown-dark">{priceText(product)}</div>
    </button>
  )
}

/** The title row of the cart / sent / orders / item views: a back chevron on the left or a close ✕ on the
 *  right, the title centred, a hairline under it. */
export function PageHeader({ title, onBack, backLabel = 'Back to menu', onClose }: {
  title: string
  onBack?: () => void
  backLabel?: string
  onClose?: () => void
}) {
  return (
    <div className="sticky top-0 z-10 grid h-14 grid-cols-[3rem_1fr_3rem] items-center border-b border-border bg-cream px-1">
      {onBack
        ? <button type="button" aria-label={backLabel} onClick={onBack} className="flex h-11 w-11 items-center justify-center text-brown-dark"><ChevronLeft size={28} strokeWidth={2} /></button>
        : <span />}
      <h1 className="text-center text-lg font-semibold text-brown-dark">{title}</h1>
      {onClose
        ? <button type="button" aria-label="Close" onClick={onClose} className="flex h-11 w-11 items-center justify-center justify-self-end text-brown-dark"><X size={24} strokeWidth={2} /></button>
        : <span />}
    </div>
  )
}

/** A guest's line above their items: the avatar in a round chip and the name. */
export function GuestLine({ avatar, label }: { avatar: string | null; label: string }) {
  return (
    <div className="flex items-center gap-2.5 py-2">
      <span aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-full bg-brown-track text-lg">{avatarEmoji(avatar) || '🙂'}</span>
      <span className="text-[15px] font-medium text-brown-muted">{label}</span>
    </div>
  )
}

/** The quantity in a small outlined box (the cart's read-only lines, order details, orders). */
export function QtyBox({ qty, className = '' }: { qty: number; className?: string }) {
  return (
    <span className={`flex h-10 w-12 shrink-0 items-center justify-center rounded-lg border border-border-mid text-base text-brown-dark ${className}`}>{qty}</span>
  )
}

/** One sent item (order details, orders): the quantity box, name with its add-ons under it, the price. */
export function ItemLine({ qty, name, mods, note, priceSen, voided = false }: {
  qty: number; name: string; mods: string[]; note?: string | null; priceSen: number; voided?: boolean
}) {
  return (
    <div data-testid="item-line" className={`flex items-start gap-3 border-b border-border py-3 last:border-0 ${voided ? 'line-through opacity-50' : ''}`}>
      <QtyBox qty={qty} />
      <div className="min-w-0 flex-1 pt-2">
        <div className="text-[15px] font-semibold leading-snug text-brown-dark">{name}</div>
        {mods.length > 0 && <div className="mt-0.5 text-sm text-brown-muted">{mods.join(', ')}</div>}
        {note && <div className="mt-0.5 text-sm text-brown-muted">Remark: {note}</div>}
      </div>
      <div className="shrink-0 pt-2 text-[15px] text-brown-dark">{formatSen(priceSen)}</div>
    </div>
  )
}

/** A screen before the menu (loading, a bad or paused table code): one sentence under the brown header. */
export function Notice({ title, muted = false, children }: { title?: string; muted?: boolean; children: ReactNode }) {
  return <Shell title={title}><p className={`p-6 text-center ${muted ? 'text-brown-muted' : ''}`}>{children}</p></Shell>
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
