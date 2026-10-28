import { useState } from 'react'
import { qty } from '../../shared/lib/procurement'

/**
 * − / + quantity control sized for thumbs (44 px targets). The middle is a
 * text field so an odd quantity (e.g. 1.5) can still be typed.
 */
export default function Stepper({ value, onChange, min = 0, label, tone = 'normal' }: {
  value: number
  onChange: (next: number) => void
  min?: number
  /** Accessible name, e.g. "Eggs Grade A quantity". */
  label: string
  tone?: 'normal' | 'warn'
}) {
  // What is typed while the field has focus, so "1." can become "1.5".
  const [draft, setDraft] = useState<string | null>(null)
  const border = tone === 'warn' ? 'border-[#B46309]' : 'border-[#E8DDD0]'
  return (
    <div className={`flex items-center rounded-xl border ${border} overflow-hidden bg-[#FDFAF6] shrink-0`}>
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        onClick={() => onChange(Math.max(min, Math.ceil(value) - 1))}
        disabled={value <= min}
        className="w-11 h-11 text-xl font-semibold text-brown-btn active:bg-[#F5EDE0] disabled:opacity-30"
      >
        −
      </button>
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        value={draft ?? qty(value)}
        onChange={e => {
          setDraft(e.target.value)
          const n = Number(e.target.value)
          // An empty field waits for blur, so clearing it to retype doesn't
          // drop the quantity to zero (which would swap the stepper out).
          if (e.target.value !== '' && Number.isFinite(n) && n >= min) onChange(n)
        }}
        onFocus={e => { setDraft(qty(value)); e.target.select() }}
        onBlur={() => { if (draft === '') onChange(min); setDraft(null) }}
        className="w-12 h-11 text-center text-base font-extrabold text-brown-dark bg-transparent focus:outline-none"
      />
      <button
        type="button"
        aria-label={`Increase ${label}`}
        onClick={() => onChange(Math.floor(value) + 1)}
        className="w-11 h-11 text-xl font-semibold text-brown-btn active:bg-[#F5EDE0]"
      >
        +
      </button>
    </div>
  )
}
