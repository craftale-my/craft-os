// src/qr/SendSheet.tsx
import { findProduct, formatSen, lineLabel, linePriceSen, type PosMenu } from '../features/pos/order/cart'
import type { GuestGroup } from './qrCart'
import { avatarEmoji } from './qrGuest'

/** "Has everyone ordered?" — what will be sent for the whole table, by guest. The caller passes only
 *  lines that can be ordered now (sendGroups). */
export default function SendSheet({ groups, menu, totalSen, needsPax, pax, onPax, sending, message, error, onSend, onCancel }: {
  groups: GuestGroup[]
  menu: PosMenu
  totalSen: number
  needsPax: boolean
  pax: string
  onPax: (value: string) => void
  sending: boolean
  /** e.g. "The order changed — please check again." */
  message: string | null
  error: string | null
  onSend: () => void
  onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 sm:items-center" onClick={sending ? undefined : onCancel}>
      <div role="dialog" aria-label="Has everyone ordered?"
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-card p-4 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">Has everyone ordered?</h2>
        {message && <p role="status" className="mt-2 rounded bg-amber-50 p-2 text-sm text-amber-900">{message}</p>}
        {groups.map((g) => (
          <section key={g.guestId} className="mt-3">
            <h3 className="text-sm font-semibold text-brown-dark">{avatarEmoji(g.avatar)} {g.label}{g.isMe && ' (you)'}</h3>
            {g.lines.map((l) => {
              const p = findProduct(menu, l.productId)
              if (!p) return null
              const { name, mods } = lineLabel(p, l)
              return (
                <div key={l.id} className="flex justify-between gap-2 py-1 text-sm">
                  <span>
                    <span>{l.qty} × {name}</span>
                    {mods.length > 0 && <span className="text-brown-muted"> · {mods.join(', ')}</span>}
                  </span>
                  <span>{formatSen((linePriceSen(p, l) ?? 0) * l.qty)}</span>
                </div>
              )
            })}
          </section>
        ))}
        <div className="mt-3 flex justify-between border-t border-border pt-2 font-semibold">
          <span>Subtotal</span><span>{formatSen(totalSen)}</span>
        </div>
        {needsPax && (
          <label className="mt-3 block text-sm">
            How many people?
            <input inputMode="numeric" className="ml-2 w-16 rounded border border-border p-1 text-base" value={pax}
              onChange={(e) => onPax(e.target.value)} />
          </label>
        )}
        {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
        <div className="mt-4 flex gap-2">
          <button type="button" onClick={onCancel} disabled={sending} className="flex-1 rounded-xl border border-border py-3 disabled:opacity-40">Not yet</button>
          <button type="button" onClick={onSend} disabled={sending}
            className="flex-[2] rounded-xl bg-brown-btn py-3 text-white hover:bg-brown-btn-hover disabled:opacity-40">
            {sending ? 'Sending…' : 'Send order for the table'}
          </button>
        </div>
      </div>
    </div>
  )
}
