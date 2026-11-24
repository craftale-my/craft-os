/** Small pickers for "Move table" and "Merge another bill into this one". */
export interface PickOption { id: string; label: string; detail?: string }

export default function PickerSheet({ title, hint, options, empty, onPick, onClose }: {
  title: string
  hint: string
  options: PickOption[]
  empty: string
  onPick: (id: string) => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-card p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-brown-muted">{hint}</p>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {options.map((o) => (
            <button key={o.id} onClick={() => onPick(o.id)} className="rounded-xl border border-border p-3 text-left">
              <div className="font-semibold">{o.label}</div>
              {o.detail && <div className="text-xs text-brown-muted">{o.detail}</div>}
            </button>
          ))}
        </div>
        {options.length === 0 && <p className="mt-3 text-sm text-brown-muted">{empty}</p>}
        <button onClick={onClose} className="mt-4 w-full rounded-xl border border-border py-2">Cancel</button>
      </div>
    </div>
  )
}
