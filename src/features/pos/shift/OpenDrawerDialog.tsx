import { useEffect, useRef, useState } from 'react'
import { fetchReasonTemplate } from '../checkout/checkoutApi'
import { defaultTemplate, reasonProblem, type ReasonTemplate } from '../checkout/reasons'
import { openDrawer } from './shiftApi'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Open drawer (W4 spec §5, POS grid menu): the cashier picks a reason — the outlet's open_drawer template,
 *  else Give change / Check the cash / Swap a note, Other allowed — and the receipt printer kicks the drawer.
 *  No supervisor PIN; every open is logged and counted on the Z report. One id per dialog: a retry after a
 *  lost reply never kicks twice. */
export default function OpenDrawerDialog({ branchId, onClose }: { branchId: string; onClose: () => void }) {
  const [template, setTemplate] = useState<ReasonTemplate>(defaultTemplate('open_drawer'))
  const [choice, setChoice] = useState('')            // a listed reason, or '' when typing Other
  const [other, setOther] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const id = useRef(crypto.randomUUID())
  const running = useRef(false)                      // a second tap in the same render must not send twice

  useEffect(() => {
    fetchReasonTemplate(branchId, 'open_drawer').then((t) => { if (t) setTemplate(t) }, (e) => setError(msg(e)))
  }, [branchId])

  const reason = choice || other
  const open = async () => {
    const problem = reasonProblem(template, reason)
    if (problem) { setError(problem); return }
    if (running.current) return
    running.current = true
    setBusy(true)
    setError(null)
    try {
      await openDrawer(id.current, reason.trim())
      setDone(true)
    } catch (e) {
      setError(msg(e))
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40" onClick={busy ? undefined : onClose}>
      <div role="dialog" aria-label="Open drawer" className="w-full max-w-md space-y-3 rounded-2xl bg-card p-5" onClick={(e) => e.stopPropagation()}>
        <div>
          <h2 className="text-lg font-semibold">Open drawer</h2>
          <p className="text-sm text-brown-muted">Opens the cash drawer without a sale. Every open is logged with its reason.</p>
        </div>
        {done ? (
          <>
            <p role="status" className="rounded bg-green-50 p-3 text-sm text-green-800">Drawer opened.</p>
            <button type="button" onClick={onClose} className="min-h-12 w-full rounded-xl bg-brown-btn text-white">Done</button>
          </>
        ) : (
          <>
            <div>
              <div className="text-xs font-semibold uppercase text-brown-muted">Reason{template.compulsory ? '' : ' (optional)'}</div>
              <div className="mt-1 flex flex-wrap gap-2">
                {template.reasons.map((r) => (
                  <button key={r} type="button" onClick={() => { setChoice(r); setOther(''); setError(null) }}
                    className={`min-h-11 rounded-lg border px-3 text-sm ${choice === r ? 'border-brown-btn bg-brown-btn text-white' : 'border-border'}`}>{r}</button>
                ))}
              </div>
              {template.allowOther && (
                <input className="mt-2 min-h-11 w-full rounded border border-border p-2 text-sm" placeholder={template.reasons.length ? 'Other reason' : 'Reason'}
                  aria-label="Reason" value={other} onChange={(e) => { setOther(e.target.value); setChoice(''); setError(null) }} />
              )}
            </div>
            {error && <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
            <div className="flex gap-2">
              <button type="button" onClick={onClose} disabled={busy} className="min-h-12 flex-1 rounded-xl border border-border">Cancel</button>
              <button type="button" onClick={() => void open()} disabled={busy}
                className="min-h-12 flex-1 rounded-xl bg-brown-btn text-white disabled:opacity-40">{busy ? 'Opening…' : 'Open drawer'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
