import { useRef, useState } from 'react'
import { formatSen } from '../order/cart'
import { parseRinggit } from '../checkout/tender'
import ApprovalDialog from '../checkout/ApprovalDialog'
import { looksOffline } from '../checkout/rpcResult'
import { closeShift } from './shiftApi'
import ZReportView from './ZReportView'
import {
  approvalNote, closeShiftError, countProblem, openBillsWarning, printedNote, varianceLabel,
  type CloseResult, type OpenShift,
} from './shift'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
type Step = 'warn' | 'count' | 'approve' | 'done'
type NeedsApproval = Extract<CloseResult, { kind: 'needsApproval' }>
type Closed = Extract<CloseResult, { kind: 'closed' }>

/** Close shift: open-bills warning → blind count → (above the limit) expected, variance,
 *  reason and a supervisor's PIN → the Z report. The expected cash is shown only after the
 *  count was submitted. Re-entering a different count is allowed; the first one is kept, and
 *  once it was above the limit the approval stays (close_shift's rule). If the expected cash
 *  changed while the supervisor came over, the server answers with the new figures. */
export default function CloseShiftSheet({ branchId, shift, openBillCount, onClose, onClosed }: {
  branchId: string
  shift: OpenShift
  openBillCount: number
  onClose: () => void
  onClosed: () => void
}) {
  const warning = openBillsWarning(openBillCount)
  const [step, setStep] = useState<Step>(warning ? 'warn' : 'count')
  const [countText, setCountText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [check, setCheck] = useState<NeedsApproval | null>(null)
  const [closed, setClosed] = useState<Closed | null>(null)
  const [approving, setApproving] = useState(false)
  const [changed, setChanged] = useState(false)     // the expected cash moved while approving
  const running = useRef(false)
  const counted = useRef(0)

  const take = (r: CloseResult) => {
    if (r.kind === 'closed') { setClosed(r); setStep('done') } else { setCheck(r); setStep('approve') }
  }

  const submitCount = async () => {
    const problem = countProblem(countText)
    if (problem) { setError(problem); return }
    if (running.current) return
    running.current = true; setBusy(true); setError(null); setChanged(false)
    counted.current = parseRinggit(countText) ?? 0
    try { take(await closeShift(shift.id, counted.current, null, null)) } catch (e) {
      const m = msg(e)
      setError(looksOffline(m) ? 'Not sure the shift closed (no reply). Press Close shift again with the same count.' : closeShiftError(m))
    } finally { running.current = false; setBusy(false) }
  }

  const box = 'w-full max-w-md space-y-3 rounded-2xl bg-card p-5'
  return (
    <>
      <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40" onClick={busy || step === 'done' ? undefined : onClose}>
        <div className={step === 'done' ? `${box} max-w-xl` : box} onClick={(e) => e.stopPropagation()}>
          <h2 className="text-lg font-semibold">Close shift</h2>
          {step === 'warn' && (
            <>
              <p role="status" className="rounded bg-amber-50 p-2 text-sm text-amber-800">{warning}</p>
              <div className="flex gap-2">
                <button onClick={onClose} className="flex-1 rounded-xl border border-border py-3">Cancel</button>
                <button onClick={() => setStep('count')} className="flex-1 rounded-xl bg-brown-btn py-3 text-white">Continue</button>
              </div>
            </>
          )}
          {step === 'count' && (
            <>
              <p className="text-xs text-brown-muted">Count all the cash in the drawer, the float included, and enter the total.</p>
              <label className="block text-sm">Counted cash (RM)
                <input inputMode="decimal" autoFocus className="mt-1 w-full rounded border border-border p-2" value={countText}
                  onChange={(e) => { setCountText(e.target.value); setError(null) }} />
              </label>
              {error && <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
              <div className="flex gap-2">
                <button onClick={onClose} disabled={busy} className="flex-1 rounded-xl border border-border py-3">Cancel</button>
                <button onClick={() => void submitCount()} disabled={busy} className="flex-1 rounded-xl bg-red-700 py-3 text-white disabled:opacity-40">
                  {busy ? 'Closing…' : 'Close shift'}
                </button>
              </div>
            </>
          )}
          {step === 'approve' && check && (
            <>
              <dl className="grid grid-cols-2 gap-1 text-sm">
                <dt>Counted</dt><dd className="text-right">{formatSen(counted.current)}</dd>
                <dt>Expected</dt><dd className="text-right">{formatSen(check.expectedSen)}</dd>
                <dt className="font-semibold">Difference</dt><dd className="text-right font-semibold text-red-700">{varianceLabel(check.varianceSen)}</dd>
              </dl>
              {changed && (
                <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-700">
                  The expected cash changed meanwhile (a sale, refund or pay in / out) — check the new figures and approve again.
                </p>
              )}
              <p className="rounded bg-amber-50 p-2 text-sm text-amber-800">{approvalNote(check)}</p>
              <div className="flex gap-2">
                <button onClick={() => { setCountText(''); setError(null); setStep('count') }} className="flex-1 rounded-xl border border-border py-3">Count again</button>
                <button onClick={() => setApproving(true)} className="flex-1 rounded-xl bg-red-700 py-3 text-white">Approve difference</button>
              </div>
            </>
          )}
          {step === 'done' && closed && (
            <>
              <p role="status" className={`rounded p-2 text-sm ${closed.printed ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'}`}>
                Shift closed. {printedNote(closed.printed)}
              </p>
              <ZReportView report={closed.report} />
              <button onClick={onClosed} className="w-full rounded-xl bg-brown-btn py-3 text-white">Done</button>
            </>
          )}
        </div>
      </div>
      {approving && check && (
        <ApprovalDialog branchId={branchId} action={null} reasonMissing="Enter a reason for the difference" title="Approve cash difference"
          summary={`Counted ${formatSen(counted.current)} · expected ${formatSen(check.expectedSen)} · ${varianceLabel(check.varianceSen)}`}
          onApprove={async (a) => {
            let r: CloseResult
            try { r = await closeShift(shift.id, counted.current, a, check.expectedSen) } catch (e) {
              const m = msg(e)
              throw new Error(looksOffline(m) ? 'Not sure the shift closed (no reply). Press Approve again — it will not close twice.' : closeShiftError(m))
            }
            setChanged(r.kind === 'needsApproval')       // the server's new figures replace the old ones
            take(r)
          }}
          onClose={() => setApproving(false)}
          onDone={() => setApproving(false)} />
      )}
    </>
  )
}
