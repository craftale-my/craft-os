import { useState } from 'react'
import { defaultLine, formatSen, linePriceSen, validateLine, type OrderLine, type PosProduct } from './cart'

export default function LineSheet({ product, initial, onCancel, onDone }: {
  product: PosProduct
  initial?: OrderLine
  onCancel: () => void
  onDone: (line: OrderLine) => void
}) {
  const [line, setLine] = useState<OrderLine>(initial ?? defaultLine(product))
  const [touched, setTouched] = useState(initial !== undefined)
  const problem = validateLine(product, line)
  const price = linePriceSen(product, line)

  const toggle = (groupMax: number, groupOptionIds: string[], id: string) => {
    setTouched(true)
    setLine((l) => {
      const inGroup = l.optionIds.filter((x) => groupOptionIds.includes(x))
      const others = l.optionIds.filter((x) => !groupOptionIds.includes(x))
      if (groupMax === 1) return { ...l, optionIds: inGroup[0] === id ? others : [...others, id] }
      return { ...l, optionIds: inGroup.includes(id) ? [...others, ...inGroup.filter((x) => x !== id)] : [...others, ...inGroup, id] }
    })
  }

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 sm:items-center" onClick={onCancel}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-card p-4 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">{product.name}</h2>
        {product.description && <p className="text-sm text-brown-muted">{product.description}</p>}

        {product.variants.length > 1 && (
          <div className="mt-3">
            <div className="text-xs font-semibold uppercase text-brown-muted">Choose one</div>
            <div className="mt-1 flex flex-wrap gap-2">
              {product.variants.map((v) => (
                <button key={v.id} onClick={() => setLine({ ...line, variantId: v.id })}
                  className={`rounded-lg border px-3 py-2 text-sm ${line.variantId === v.id ? 'border-brown-btn bg-brown-btn text-white' : 'border-border'}`}>
                  {v.name} · {formatSen(v.priceSen)}
                </button>
              ))}
            </div>
          </div>
        )}

        {product.groups.map((g) => {
          const ids = g.options.map((o) => o.id)
          return (
            <div key={g.id} className="mt-3">
              <div className="text-xs font-semibold uppercase text-brown-muted">
                {g.name} · {g.min > 0 ? `choose ${g.min === g.max ? g.min : `${g.min}–${g.max}`}` : `up to ${g.max}`}
              </div>
              <div className="mt-1 flex flex-wrap gap-2">
                {g.options.map((o) => (
                  <button key={o.id} disabled={!o.available} onClick={() => toggle(g.max, ids, o.id)}
                    className={`rounded-lg border px-3 py-2 text-sm disabled:opacity-40 ${line.optionIds.includes(o.id) ? 'border-brown-btn bg-brown-btn text-white' : 'border-border'}`}>
                    {o.name}{o.priceDeltaSen > 0 && ` +${formatSen(o.priceDeltaSen)}`}{!o.available && ' (sold out)'}
                  </button>
                ))}
              </div>
            </div>
          )
        })}

        <div className="mt-3 flex items-center gap-3">
          <span className="text-sm">Qty</span>
          <button className="h-10 w-10 rounded-lg border border-border text-xl" onClick={() => setLine({ ...line, qty: Math.max(1, line.qty - 1) })}>−</button>
          <span className="w-8 text-center text-lg">{line.qty}</span>
          <button className="h-10 w-10 rounded-lg border border-border text-xl" onClick={() => setLine({ ...line, qty: Math.min(20, line.qty + 1) })}>+</button>
        </div>
        <input className="mt-3 w-full rounded-lg border border-border p-2 text-sm" placeholder="Note for the kitchen (optional)"
          value={line.note ?? ''} onChange={(e) => setLine({ ...line, note: e.target.value || null })} maxLength={120} />

        {touched && problem && <p className="mt-2 text-sm text-red-700">{problem}</p>}
        <div className="mt-4 flex gap-2">
          <button onClick={onCancel} className="flex-1 rounded-xl border border-border py-3">Cancel</button>
          <button disabled={!!problem} onClick={() => onDone(line)}
            className="flex-1 rounded-xl bg-brown-btn py-3 text-white hover:bg-brown-btn-hover disabled:opacity-40">
            Add · {price === null ? '—' : formatSen(price * line.qty)}
          </button>
        </div>
      </div>
    </div>
  )
}
