import { useState } from 'react'
import { ChevronDown, Trash2 } from 'lucide-react'
import { findProduct, formatSen, lineLabel, linePriceSen, type PosMenu, type PosProduct } from '../features/pos/order/cart'
import { lineAvailable, type CartLine, type GuestGroup } from './qrCart'
import { GuestLine, PageHeader, PickCard } from './qrParts'
import AiPickCard from './AiPickCard'
import Mascot from './Mascot'

/** The table's cart, on its own page (reference frames 11, 12). No fetching in here: the page that owns
 *  the state passes it in. */
export default function CartPage({ menu, me, mine, others, pairs, subtotalSen, sendable, status, error, closed = null, aiPick = null, aiBusy = false, onAiAdd, onAiHide, onBack, onEdit, onRemove, onQty, onOpenProduct, onPlace }: {
  menu: PosMenu
  /** this phone's guest: the line under Your items */
  me: { name: string; avatar: string }
  mine: CartLine[]
  others: GuestGroup[]
  /** Goes well with your order (cartPairs) */
  pairs: PosProduct[]
  subtotalSen: number
  /** at least one available line */
  sendable: boolean
  status: 'loading' | 'ready' | 'offline'
  /** a removal or quantity change that failed */
  error: string | null
  /** W7 spec §3: past the outlet's last-order time — this sentence shows and Place order is off */
  closed?: string | null
  /** spec 2026-11-22-qr-ai-pick-mascot-design.md: the AI Pick (null = none, or hidden for this visit) */
  aiPick?: { product: PosProduct; sentence: string } | null
  /** an Add from the AI Pick card is being written */
  aiBusy?: boolean
  onAiAdd?: (product: PosProduct) => void
  onAiHide?: () => void
  onBack: () => void
  onEdit: (product: PosProduct, lineId: string) => void
  onRemove: (lineId: string) => void
  /** the quantity select: the same server write as an edit; resolves when done (failures are reported in `error`) */
  onQty: (lineId: string, qty: number) => Promise<void>
  onOpenProduct: (product: PosProduct) => void
  onPlace: () => void
}) {
  if (mine.length === 0 && others.length === 0) {
    return (
      <div>
        <PageHeader title="Cart" onBack={onBack} />
        <div className="flex flex-col items-center p-6 pt-10 text-center">
          <Mascot pose="sleepy" size={96} />
          <p className="mt-3 text-brown-muted">Your cart is empty.</p>
          <button type="button" onClick={onBack} className="mt-3 min-h-11 rounded-xl bg-brown-btn px-5 text-white">Back to menu</button>
        </div>
      </div>
    )
  }
  // the AI Pick shows while ordering is open and the cart is live; its product leaves the pairing strip
  const pick = aiPick && !closed && status === 'ready' && onAiAdd && onAiHide ? aiPick : null
  const strip = pick ? pairs.filter((p) => p.id !== pick.product.id) : pairs
  return (
    <div className="pb-28">
      <PageHeader title="Cart" onBack={onBack} />
      {mine.length > 0 && (
        <section aria-labelledby="cart-mine" className="px-4 pt-4">
          <h2 id="cart-mine" className="text-[22px] font-bold text-brown-dark">Your items</h2>
          <GuestLine avatar={me.avatar} label={me.name} />
          <ul>{mine.map((l) => (
            <Row key={l.id} menu={menu} line={l} onEdit={(p) => onEdit(p, l.id)} onRemove={() => onRemove(l.id)} onQty={(n) => onQty(l.id, n)} noMore={!!closed} />
          ))}</ul>
        </section>
      )}
      {others.length > 0 && (
        <section aria-labelledby="cart-others" className={`px-4 pt-4 ${mine.length > 0 ? 'mt-1 border-t-8 border-brown-track' : ''}`}>
          <h2 id="cart-others" className="text-[22px] font-bold text-brown-dark">Others at this table</h2>
          {others.map((g) => (
            <div key={g.guestId}>
              <GuestLine avatar={g.avatar} label={g.label} />
              <ul>{g.lines.map((l) => <Row key={l.id} menu={menu} line={l} />)}</ul>
            </div>
          ))}
        </section>
      )}
      <div className="px-4">
        {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
        {closed && <p role="status" className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{closed}</p>}
      </div>
      {pick && onAiAdd && onAiHide && (
        <AiPickCard product={pick.product} sentence={pick.sentence} busy={aiBusy}
          onAdd={onAiAdd} onOpen={onOpenProduct} onHide={onAiHide} />
      )}
      {strip.length > 0 && (
        <section aria-labelledby="cart-pairs" className="mt-2 border-t-8 border-brown-track pt-4">
          <h2 id="cart-pairs" className="px-4 text-[19px] font-bold text-brown-dark">Goes well with your order</h2>
          <div className="mt-3 flex gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {strip.map((p) => <PickCard key={p.id} product={p} onOpen={() => onOpenProduct(p)} />)}
          </div>
        </section>
      )}
      <div className="mt-4 border-t-8 border-brown-track px-4 pt-4">
        <div className="flex justify-between text-[17px] font-bold text-brown-dark"><span>Subtotal</span><span>{formatSen(subtotalSen)}</span></div>
        <p className="mt-1 text-sm text-brown-muted">Before service charge and tax.</p>
      </div>
      <div className="fixed inset-x-0 bottom-0 z-10 mx-auto max-w-lg bg-gradient-to-t from-cream via-cream to-cream/0 px-4 pb-4 pt-3">
        <button type="button" disabled={!sendable || status !== 'ready' || !!closed} onClick={onPlace}
          className="min-h-14 w-full rounded-xl bg-brown-btn text-[17px] font-semibold text-white shadow-md disabled:opacity-40">
          {status === 'offline' ? 'Reconnecting…' : 'Place order'}
        </button>
      </div>
    </div>
  )
}

const QTYS = Array.from({ length: 20 }, (_, i) => i + 1)

/** One line of the cart: quantity on the left, name / options / remark / Edit in the middle, price and bin
 *  on the right. With onEdit / onRemove / onQty it is the guest's own; without, someone else's (read-only).
 *  A line the menu no longer offers is struck through and says so; its owner can still remove it. */
function Row({ menu, line, onEdit, onRemove, onQty, noMore = false }: {
  menu: PosMenu
  line: CartLine
  onEdit?: (product: PosProduct) => void
  onRemove?: () => void
  onQty?: (qty: number) => Promise<void>
  noMore?: boolean                            // past last order: the quantity can only go down
}) {
  const [pendingQty, setPendingQty] = useState<number | null>(null)
  const p = findProduct(menu, line.productId)
  const ok = lineAvailable(menu, line)
  const label = p && ok ? lineLabel(p, line) : { name: p?.name ?? 'Unavailable item', mods: [] as string[] }
  const changeQty = async (n: number) => {
    if (!onQty || n === line.qty) return
    setPendingQty(n)
    try { await onQty(n) } finally { setPendingQty(null) }
  }
  return (
    <li className="flex gap-3 border-b border-border py-4 last:border-0">
      {onQty && ok ? (
        <div className="relative h-11 w-14 shrink-0">
          <select aria-label={`Quantity of ${label.name}`} value={pendingQty ?? line.qty} disabled={pendingQty !== null}
            onChange={(e) => void changeQty(Number(e.target.value))}
            className="h-full w-full appearance-none rounded-lg border border-border-mid bg-card pl-3 pr-6 text-base text-brown-dark disabled:opacity-60">
            {QTYS.filter((n) => !noMore || n <= line.qty).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <ChevronDown size={16} aria-hidden="true" className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-brown-dark" />
        </div>
      ) : (
        <span data-testid="qty-box" className="flex h-11 w-14 shrink-0 items-center rounded-lg border border-border-mid pl-3 text-base text-brown-dark">{line.qty}</span>
      )}
      <div className="min-w-0 flex-1 pt-1.5">
        <div className={`text-[16px] font-semibold leading-snug text-brown-dark ${ok ? '' : 'line-through opacity-60'}`}>{label.name}</div>
        {label.mods.length > 0 && <div className="mt-0.5 text-sm text-brown-muted">{label.mods.join(', ')}</div>}
        {ok && line.note && <div className="mt-0.5 text-sm text-brown-muted">Remark: {line.note}</div>}
        {!ok && <div className="mt-0.5 text-sm text-red-700">Not available now</div>}
        {onEdit && p && ok && (
          <button type="button" aria-label={`Edit ${label.name}`} onClick={() => onEdit(p)}
            className="-ml-1 mt-1 min-h-9 px-1 text-[15px] font-semibold text-brown-brand">Edit</button>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end justify-between pt-1.5">
        <span className="text-[16px] text-brown-dark">{p && ok ? formatSen((linePriceSen(p, line) ?? 0) * line.qty) : ''}</span>
        {onRemove && (
          <button type="button" aria-label={`Remove ${label.name}`} onClick={onRemove}
            className="-mr-2 mt-2 flex h-10 w-10 items-center justify-center text-brown-muted"><Trash2 size={20} /></button>
        )}
      </div>
    </li>
  )
}
