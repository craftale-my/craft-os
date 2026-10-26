// src/features/pos/order/ModifierSheet.tsx
import { useState } from 'react'
import { Minus, Plus, X } from 'lucide-react'
import { defaultLine, formatSen, linePriceSen, validateLine, type OrderLine, type PosProduct } from './cart'
import { groupBadge, toggleOption } from './modifiers'

/** The order screen's modifier sheet, Feedme style (spec §2): each group with a red SELECT n badge
 *  when it is required, options as a two-column grid of name and price, qty and a kitchen note,
 *  Confirm at the bottom. Same rules as LineSheet (which the QR page keeps): validateLine judges
 *  the line, toggleOption is LineSheet's tap rule. A draft being edited also offers Remove. */
export default function ModifierSheet({ product, initial, onCancel, onDone, onRemove }: {
  product: PosProduct
  initial?: OrderLine
  onCancel: () => void
  onDone: (line: OrderLine) => void
  onRemove?: () => void
}) {
  const [line, setLine] = useState<OrderLine>(initial ?? defaultLine(product))
  const [touched, setTouched] = useState(initial !== undefined)
  const problem = validateLine(product, line)
  const price = linePriceSen(product, line)
  const confirm = () => { if (problem) setTouched(true); else onDone(line) }
  const tile = (on: boolean) =>
    `flex min-h-12 items-center justify-between gap-2 rounded-xl border px-3 text-left text-sm disabled:opacity-40 ${on ? 'border-brown-btn bg-brown-btn text-white' : 'border-border-mid bg-canvas text-brown-dark'}`

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4" onClick={onCancel}>
      <div role="dialog" aria-modal="true" aria-label={product.name} onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-card">
        <div className="flex items-start justify-between gap-3 border-b border-border p-4">
          <div>
            <h2 className="text-lg font-semibold text-brown-dark">{product.name}</h2>
            {product.description && <p className="text-sm text-brown-muted">{product.description}</p>}
          </div>
          <button type="button" onClick={onCancel} aria-label="Cancel" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border"><X size={20} /></button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {product.variants.length > 1 && (
            <section>
              <GroupHead name="Choose one" badge={{ text: 'SELECT 1', required: true }} />
              <div className="grid grid-cols-2 gap-2">
                {product.variants.map((v) => (
                  <button key={v.id} type="button" aria-pressed={line.variantId === v.id} className={tile(line.variantId === v.id)}
                    onClick={() => { setTouched(true); setLine({ ...line, variantId: v.id }) }}>
                    <span>{v.name}</span><span className="tabular-nums">{formatSen(v.priceSen)}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
          {product.groups.map((g) => {
            const ids = g.options.map((o) => o.id)
            return (
              <section key={g.id}>
                <GroupHead name={g.name} badge={groupBadge(g)} />
                <div className="grid grid-cols-2 gap-2">
                  {g.options.map((o) => {
                    const on = line.optionIds.includes(o.id)
                    return (
                      <button key={o.id} type="button" disabled={!o.available} aria-pressed={on} className={tile(on)}
                        onClick={() => { setTouched(true); setLine((l) => toggleOption(l, g.max, ids, o.id)) }}>
                        <span>{o.name}{!o.available && ' (sold out)'}</span>
                        <span className="tabular-nums">{o.priceDeltaSen > 0 ? `+${formatSen(o.priceDeltaSen)}` : ''}</span>
                      </button>
                    )
                  })}
                </div>
              </section>
            )
          })}
          <section className="flex items-center gap-3">
            <span className="font-semibold text-brown-dark">Qty</span>
            <button type="button" aria-label="Less" className="flex h-11 w-11 items-center justify-center rounded-lg border border-border-mid"
              onClick={() => setLine({ ...line, qty: Math.max(1, line.qty - 1) })}><Minus size={18} /></button>
            <span className="w-8 text-center text-lg tabular-nums">{line.qty}</span>
            <button type="button" aria-label="More" className="flex h-11 w-11 items-center justify-center rounded-lg border border-border-mid"
              onClick={() => setLine({ ...line, qty: Math.min(20, line.qty + 1) })}><Plus size={18} /></button>
          </section>
          <input className="h-12 w-full rounded-xl border border-border-mid px-3 text-base" placeholder="Note for the kitchen (optional)"
            value={line.note ?? ''} onChange={(e) => setLine({ ...line, note: e.target.value || null })} maxLength={120} />
          {touched && problem && <p role="alert" className="text-sm text-red-700">{problem}</p>}
        </div>
        <div className="flex gap-2 border-t border-border p-4">
          {onRemove && (
            <button type="button" onClick={onRemove} className="min-h-14 rounded-xl border border-red-300 px-6 font-medium text-red-700">Remove</button>
          )}
          <button type="button" onClick={confirm} className="min-h-14 flex-1 rounded-xl bg-brown-btn text-lg font-semibold text-white hover:bg-brown-btn-hover">
            Confirm · {price === null ? '—' : formatSen(price * line.qty)}
          </button>
        </div>
      </div>
    </div>
  )
}

function GroupHead({ name, badge }: { name: string; badge: { text: string; required: boolean } }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="font-semibold text-brown-dark">{name}</span>
      <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${badge.required ? 'bg-red-600 text-white' : 'bg-border text-brown-muted'}`}>{badge.text}</span>
    </div>
  )
}
