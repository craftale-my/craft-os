// src/features/pos/shell/PaxDialog.tsx
import { useState } from 'react'
import { Minus, Plus } from 'lucide-react'

/** Select pax (spec §1): a 1–20 grid, Feedme style. Asked when an empty table is opened, and by
 *  Pax in the bill actions. W7 spec §5: an optional "Of which children" above the grid (None, 1 … 20);
 *  one tap on the pax still picks — both, the children clamped to the pax. */
export const PAX_CHOICES: number[] = Array.from({ length: 20 }, (_, i) => i + 1)
const MAX_CHILDREN = 20

/** The stepper: None → 1 → … → 20; back down, 1 (or 0) → None. */
export function stepChildren(children: number | null, by: 1 | -1): number | null {
  if (by === 1) return children === null ? 1 : Math.min(MAX_CHILDREN, children + 1)
  return children === null || children <= 1 ? null : children - 1
}

/** Never more children than the pax tapped (the server clamps the same way). */
export const clampChildren = (children: number | null, pax: number): number | null =>
  children === null ? null : Math.min(children, pax)

export default function PaxDialog({ title, current, currentChildren = null, onPick, onClose }: {
  title: string                    // "Table T3"
  current: number | null           // highlighted
  currentChildren?: number | null  // W7: the children already given (null = none)
  onPick: (pax: number, children: number | null) => void
  onClose: () => void
}) {
  const [children, setChildren] = useState<number | null>(currentChildren)
  const step = 'flex h-11 w-11 items-center justify-center rounded-lg border border-border-mid disabled:opacity-40'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Select pax" className="w-full max-w-md rounded-2xl bg-card p-5 shadow-card"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold text-brown-dark">Select pax</h2>
          <span className="text-sm text-brown-muted">{title}</span>
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-brown-dark">Of which children</span>
          <div className="flex items-center gap-2">
            <button type="button" aria-label="Fewer children" disabled={children === null} className={step}
              onClick={() => setChildren((c) => stepChildren(c, -1))}><Minus size={18} /></button>
            <span className="w-12 text-center text-lg tabular-nums" aria-live="polite">{children ?? 'None'}</span>
            <button type="button" aria-label="More children" disabled={children === MAX_CHILDREN} className={step}
              onClick={() => setChildren((c) => stepChildren(c, 1))}><Plus size={18} /></button>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-5 gap-2">
          {PAX_CHOICES.map((n) => (
            <button key={n} type="button" onClick={() => onPick(n, clampChildren(children, n))} aria-pressed={current === n}
              className={`h-14 rounded-xl text-lg font-semibold ${current === n ? 'bg-brown-btn text-white' : 'border border-border-mid bg-canvas text-brown-dark'}`}>
              {n}
            </button>
          ))}
        </div>
        <button type="button" onClick={onClose} className="mt-4 min-h-12 w-full rounded-xl border border-border-mid text-brown-dark">Cancel</button>
      </div>
    </div>
  )
}
