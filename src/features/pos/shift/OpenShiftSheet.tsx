import { useRef, useState } from 'react'
import { parseRinggit } from '../checkout/tender'
import { openShift } from './shiftApi'
import { floatProblem, senToText, type ShiftStatus } from './shift'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Open shift: the opening float, prefilled with the last shift's. Any live POS staff of the branch. */
export default function OpenShiftSheet({ lastFloatSen, onClose, onOpened }: {
  lastFloatSen: number | null
  onClose: () => void
  onOpened: (status: ShiftStatus) => void
}) {
  const [text, setText] = useState(lastFloatSen === null ? '' : senToText(lastFloatSen))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)

  const submit = async () => {
    const problem = floatProblem(text)
    if (problem) { setError(problem); return }
    if (running.current) return
    running.current = true; setBusy(true); setError(null)
    try { onOpened(await openShift(parseRinggit(text) ?? 0)) } catch (e) { setError(msg(e)) } finally { running.current = false; setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40" onClick={busy ? undefined : onClose}>
      <div className="w-full max-w-sm space-y-3 rounded-2xl bg-card p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">Open shift</h2>
        <p className="text-xs text-brown-muted">Count the cash in the drawer before the first sale. Checkout, refunds and pay in / pay out need an open shift.</p>
        <label className="block text-sm">Opening float (RM)
          <input inputMode="decimal" autoFocus className="mt-1 w-full rounded border border-border p-2" value={text}
            onChange={(e) => { setText(e.target.value); setError(null) }} />
        </label>
        {error && <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
        <div className="flex gap-2">
          <button onClick={onClose} disabled={busy} className="flex-1 rounded-xl border border-border py-3">Cancel</button>
          <button onClick={() => void submit()} disabled={busy} className="flex-1 rounded-xl bg-brown-btn py-3 text-white disabled:opacity-40">
            {busy ? 'Opening…' : 'Open shift'}
          </button>
        </div>
      </div>
    </div>
  )
}
