// src/features/pos/shell/PaxDialog.tsx
/** Select pax (spec §1): a 1–20 grid, Feedme style. Asked when an empty table is opened, and by
 *  Pax in the bill actions. */
export const PAX_CHOICES: number[] = Array.from({ length: 20 }, (_, i) => i + 1)

export default function PaxDialog({ title, current, onPick, onClose }: {
  title: string                 // "Table T3"
  current: number | null        // highlighted
  onPick: (pax: number) => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Select pax" className="w-full max-w-md rounded-2xl bg-card p-5 shadow-card"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold text-brown-dark">Select pax</h2>
          <span className="text-sm text-brown-muted">{title}</span>
        </div>
        <div className="mt-4 grid grid-cols-5 gap-2">
          {PAX_CHOICES.map((n) => (
            <button key={n} type="button" onClick={() => onPick(n)} aria-pressed={current === n}
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
