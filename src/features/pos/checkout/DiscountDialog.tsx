// src/features/pos/checkout/DiscountDialog.tsx
import { useState } from 'react'
import { formatSen } from '../order/cart'
import { discountOffSen, type DiscountInput, type DiscountKind } from './bill'
import { QUICK_PERCENTS, discountProblem, parseDiscount } from './discounts'

const asText = (d: DiscountInput | null): string =>
  !d ? '' : d.kind === 'percent' ? String(d.value / 100) : (d.value / 100).toFixed(2)

/** Step 1 of a discount (spec "Screens"): Amount | Percent, quick percents 5 / 10 / 20 / 50, the
 *  value (the iPad's number keyboard) and what comes off. Next hands the discount to ApprovalDialog
 *  (reason, then supervisor and PIN). */
export default function DiscountDialog({ title, summary, baseSen, initial, onNext, onClose }: {
  title: string                 // "Discount item" / "Discount bill"
  summary: string               // "2 × Coffee Latte · RM 26.00"
  baseSen: number               // what it applies to: the line after its catalog discount, or the bill's subtotal
  initial: DiscountInput | null // editing: the discount there now
  onNext: (d: DiscountInput) => void
  onClose: () => void
}) {
  const [kind, setKind] = useState<DiscountKind>(initial?.kind ?? 'percent')
  const [text, setText] = useState(asText(initial))
  const parsed = parseDiscount(kind, text)
  const problem = text.trim() === '' ? null : discountProblem(kind, text)
  const label = kind === 'amount' ? 'Amount (RM)' : 'Percent'
  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-brown-dark">{title}</h2>
        <p className="mt-1 text-sm text-brown-muted">{summary}</p>
        <div role="radiogroup" aria-label="Discount type" className="mt-4 grid grid-cols-2 gap-2">
          {(['amount', 'percent'] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => { if (k !== kind) { setKind(k); setText('') } }}
              className={`min-h-11 rounded-lg border text-sm font-medium ${kind === k ? 'border-brown-btn bg-brown-btn text-white' : 'border-border-mid text-brown-dark'}`}>
              {k === 'amount' ? 'Amount' : 'Percent'}
            </button>
          ))}
        </div>
        {kind === 'percent' && (
          <div className="mt-3 grid grid-cols-4 gap-2">
            {QUICK_PERCENTS.map((p) => (
              <button key={p} type="button" onClick={() => setText(String(p))}
                className={`min-h-11 rounded-lg border text-sm ${text === String(p) ? 'border-brown-btn font-semibold' : 'border-border-mid'}`}>{p}%</button>
            ))}
          </div>
        )}
        <label className="mt-3 block text-sm">
          {label}
          <input inputMode={kind === 'amount' ? 'decimal' : 'numeric'} autoFocus value={text} onChange={(e) => setText(e.target.value)}
            className="mt-1 w-full rounded-lg border border-border-mid px-3 py-2 text-lg tabular-nums" />
        </label>
        <p role="status" className="mt-2 min-h-5 text-sm">
          {problem ? <span className="text-red-700">{problem}</span>
            : parsed ? <span className="font-semibold">−{formatSen(discountOffSen(parsed, baseSen))}</span> : null}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-4 text-sm">Cancel</button>
          <button type="button" disabled={!parsed} onClick={() => parsed && onNext(parsed)}
            className="min-h-11 rounded-lg bg-brown-btn px-5 text-sm font-semibold text-white disabled:opacity-40">Next</button>
        </div>
      </div>
    </div>
  )
}
