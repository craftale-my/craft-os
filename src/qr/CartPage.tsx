import { findProduct, formatSen, lineLabel, linePriceSen, type PosMenu, type PosProduct } from '../features/pos/order/cart'
import { lineAvailable, type CartLine, type GuestGroup } from './qrCart'
import { avatarEmoji } from './qrGuest'
import { PageHeader, PickCard } from './qrParts'

/** The table's cart, on its own page. No fetching in here: the page that owns the state passes it in. */
export default function CartPage({ menu, mine, others, pairs, subtotalSen, sendable, status, error, onBack, onEdit, onRemove, onOpenProduct, onPlace }: {
  menu: PosMenu
  mine: CartLine[]
  others: GuestGroup[]
  /** Goes well with your order (cartPairs) */
  pairs: PosProduct[]
  subtotalSen: number
  /** at least one available line */
  sendable: boolean
  status: 'loading' | 'ready' | 'offline'
  /** a removal that failed */
  error: string | null
  onBack: () => void
  onEdit: (product: PosProduct, lineId: string) => void
  onRemove: (lineId: string) => void
  onOpenProduct: (product: PosProduct) => void
  onPlace: () => void
}) {
  if (mine.length === 0 && others.length === 0) {
    return (
      <div>
        <PageHeader title="Cart" onBack={onBack} />
        <div className="p-6 text-center">
          <p className="text-brown-muted">Your cart is empty.</p>
          <button type="button" onClick={onBack} className="mt-3 min-h-11 rounded-xl bg-brown-btn px-5 text-white">Back to menu</button>
        </div>
      </div>
    )
  }
  const placeLabel = status === 'offline' ? 'Reconnecting…' : `Place order · ${formatSen(subtotalSen)}`
  return (
    <div className="pb-28">
      <PageHeader title="Cart" onBack={onBack} />
      <div className="px-3 text-sm">
        {mine.length > 0 && (
          <section aria-label="Your items">
            <h2 className="text-xs font-semibold uppercase text-brown-muted">Your items</h2>
            <ul>{mine.map((l) => (
              <Row key={l.id} menu={menu} line={l} onEdit={(p) => onEdit(p, l.id)} onRemove={() => onRemove(l.id)} />
            ))}</ul>
          </section>
        )}
        {others.length > 0 && (
          <section aria-label="Others at this table" className="mt-4">
            <h2 className="text-xs font-semibold uppercase text-brown-muted">Others at this table</h2>
            {others.map((g) => (
              <div key={g.guestId}>
                <h3 className="mt-2 text-xs font-semibold text-brown-dark">{avatarEmoji(g.avatar)} {g.label}</h3>
                <ul>{g.lines.map((l) => <Row key={l.id} menu={menu} line={l} />)}</ul>
              </div>
            ))}
          </section>
        )}
        {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
        {pairs.length > 0 && (
          <section aria-label="Goes well with your order" className="mt-4">
            <h2 className="text-sm font-semibold text-brown-dark">Goes well with your order</h2>
            <div className="mt-1 flex gap-2 overflow-x-auto pb-1">
              {pairs.map((p) => <PickCard key={p.id} product={p} onOpen={() => onOpenProduct(p)} />)}
            </div>
          </section>
        )}
        <div className="mt-4 border-t border-border pt-2">
          <div className="flex justify-between font-semibold"><span>Subtotal</span><span>{formatSen(subtotalSen)}</span></div>
          <p className="text-xs text-brown-muted">Before service charge and tax.</p>
        </div>
      </div>
      <div className="fixed inset-x-0 bottom-0 border-t border-border bg-card p-3 shadow-lg">
        <button type="button" disabled={!sendable || status !== 'ready'} onClick={onPlace}
          className="min-h-12 w-full rounded-xl bg-brown-btn py-3 text-white disabled:opacity-40">{placeLabel}</button>
      </div>
    </div>
  )
}

/** One line of the cart. With onEdit / onRemove it is the guest's own; without, someone else's
 *  (read-only). A line the menu no longer offers is struck through and says so; its owner can still remove it. */
function Row({ menu, line, onEdit, onRemove }: {
  menu: PosMenu
  line: CartLine
  onEdit?: (product: PosProduct) => void
  onRemove?: () => void
}) {
  const p = findProduct(menu, line.productId)
  const ok = lineAvailable(menu, line)
  const label = p && ok ? lineLabel(p, line) : { name: p?.name ?? 'Unavailable item', mods: [] as string[] }
  return (
    <li className="flex justify-between gap-2 border-b border-border py-2 last:border-0">
      <div className="min-w-0">
        <div className={ok ? '' : 'line-through opacity-60'}>{line.qty} × {label.name}</div>
        {label.mods.length > 0 && <div className="text-xs text-brown-muted">{label.mods.join(', ')}</div>}
        {ok && line.note && <div className="text-xs text-brown-muted">{line.note}</div>}
        {!ok && <div className="text-xs text-red-700">Not available now</div>}
        {onRemove && (
          <div className="mt-1 flex gap-4">
            {onEdit && p && ok && (
              <button type="button" aria-label={`Edit ${label.name}`} onClick={() => onEdit(p)} className="min-h-11 text-brown-btn underline">Edit</button>
            )}
            <button type="button" aria-label={`Remove ${label.name}`} onClick={onRemove} className="min-h-11 text-red-700 underline">Remove</button>
          </div>
        )}
      </div>
      <div className="shrink-0">{p && ok ? formatSen((linePriceSen(p, line) ?? 0) * line.qty) : ''}</div>
    </li>
  )
}
