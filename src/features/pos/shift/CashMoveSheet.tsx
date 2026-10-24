import { useRef, useState } from 'react'
import { formatSen } from '../order/cart'
import { parseRinggit } from '../checkout/tender'
import ApprovalDialog from '../checkout/ApprovalDialog'
import { recordCashMove } from './shiftApi'
import { cashMoveMayBeRecorded, cashMoveProblem, KIND_LABEL, looksOffline, type CashMoveKind, type CashMoveResult } from './shift'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const KINDS: CashMoveKind[] = ['pay_in', 'pay_out']

/** Pay in / Pay out: cash put into or taken out of the drawer, with a reason. Pay out needs an
 *  approver's PIN. One id per send: once sent, the kind and amount are fixed, so a resend after
 *  a lost reply can never record the money twice; a refusal that recorded nothing ("Open the
 *  shift first", a wrong PIN, …) unlocks the fields and takes a new id. */
export default function CashMoveSheet({ branchId, onClose, onRecorded }: {
  branchId: string
  onClose: () => void
  onRecorded: (note: string) => void
}) {
  const moveId = useRef(crypto.randomUUID())
  const [kind, setKind] = useState<CashMoveKind>('pay_in')
  const [amountText, setAmountText] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [locked, setLocked] = useState(false)
  const [approving, setApproving] = useState(false)
  const running = useRef(false)
  const result = useRef<CashMoveResult | null>(null)

  const amountSen = parseRinggit(amountText) ?? 0
  const done = (r: CashMoveResult) => onRecorded(`${KIND_LABEL[r.kind]} ${formatSen(r.amountSen)} recorded`)
  const send = async (approverId: string | null, pin: string | null) => {
    setLocked(true)
    try {
      return await recordCashMove({ id: moveId.current, kind, amountSen, reason: reason.trim(), approverId, pin })
    } catch (e) {
      if (!cashMoveMayBeRecorded(msg(e))) { moveId.current = crypto.randomUUID(); setLocked(false) }  // nothing was recorded
      throw e
    }
  }

  const submit = async () => {
    const problem = cashMoveProblem(amountText, reason)
    if (problem) { setError(problem); return }
    if (kind === 'pay_out') { setError(null); setApproving(true); return }
    if (running.current) return
    running.current = true; setBusy(true); setError(null)
    try { done(await send(null, null)) } catch (e) {
      const m = msg(e)
      setError(looksOffline(m) ? 'Not sure it was recorded (no reply). Press Record again — it will not be recorded twice.' : m)
    } finally { running.current = false; setBusy(false) }
  }

  return (
    <>
      <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40" onClick={busy ? undefined : onClose}>
        <div className="w-full max-w-sm space-y-3 rounded-2xl bg-card p-5" onClick={(e) => e.stopPropagation()}>
          <h2 className="text-lg font-semibold">Pay in / Pay out</h2>
          <div className="flex gap-2" role="radiogroup" aria-label="Pay in or pay out">
            {KINDS.map((k) => (
              <button key={k} role="radio" aria-checked={kind === k} disabled={locked} onClick={() => { setKind(k); setError(null) }}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm disabled:opacity-60 ${kind === k ? 'border-brown-btn bg-brown-btn text-white' : 'border-border'}`}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <label className="block text-sm">Amount (RM)
            <input inputMode="decimal" className="mt-1 w-full rounded border border-border p-2 disabled:opacity-60" value={amountText}
              disabled={locked} onChange={(e) => { setAmountText(e.target.value); setError(null) }} />
          </label>
          <label className="block text-sm">Reason
            <input className="mt-1 w-full rounded border border-border p-2 disabled:opacity-60" value={reason} maxLength={200}
              disabled={locked} placeholder={kind === 'pay_in' ? 'e.g. Float top-up' : 'e.g. Ice from the shop next door'}
              onChange={(e) => { setReason(e.target.value); setError(null) }} />
          </label>
          {kind === 'pay_out' && <p className="text-xs text-brown-muted">A pay out needs a supervisor's PIN.</p>}
          {locked && <p className="text-xs text-brown-muted">Kind and amount are fixed now. To record another, close and reopen.</p>}
          {error && <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
          <div className="flex gap-2">
            <button onClick={onClose} disabled={busy} className="flex-1 rounded-xl border border-border py-3">Cancel</button>
            <button onClick={() => void submit()} disabled={busy} className="flex-1 rounded-xl bg-brown-btn py-3 text-white disabled:opacity-40">
              {busy ? 'Recording…' : kind === 'pay_out' ? 'Next: approval' : 'Record pay in'}
            </button>
          </div>
        </div>
      </div>
      {approving && (
        <ApprovalDialog branchId={branchId} action={null} askReason={false} title="Approve pay out"
          summary={`Pay out ${formatSen(amountSen)} · ${reason.trim()}`}
          onApprove={async (a) => { result.current = await send(a.approverId, a.pin) }}
          onClose={() => setApproving(false)}
          onDone={() => { if (result.current) done(result.current) }} />
      )}
    </>
  )
}
