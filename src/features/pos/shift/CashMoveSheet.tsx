import { useRef, useState } from 'react'
import { formatSen } from '../order/cart'
import { parseRinggit } from '../checkout/tender'
import ApprovalDialog from '../checkout/ApprovalDialog'
import { recordCashMove } from './shiftApi'
import {
  cashMoveProblem, KIND_LABEL, LOST_MOVE_NOTE, moveRefusal, resumeMove, type CashMoveKind, type CashMoveResult, type PendingMove,
} from './shift'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const KINDS: CashMoveKind[] = ['pay_in', 'pay_out']

/** Pay in / Pay out: cash put into or taken out of the drawer, with a reason. Pay out needs an
 *  approver's PIN. One id per send: once sent, the kind and amount are fixed, so a resend after
 *  a lost reply can never record the money twice; a refusal that recorded nothing ("Open the
 *  shift first", a wrong PIN, …) unlocks the fields and takes a new id. A send with no reply is
 *  handed to the parent (`onPending`), which passes it back as `pending` when the sheet is
 *  reopened: Cancel and reopen resume the same id and fields until the server answers. */
export default function CashMoveSheet({ branchId, pending, onPending, onClose, onRecorded }: {
  branchId: string
  pending: PendingMove | null
  onPending: (p: PendingMove | null) => void
  onClose: () => void
  onRecorded: (note: string) => void
}) {
  const [start] = useState(() => resumeMove(pending, crypto.randomUUID()))
  const moveId = useRef(start.id)
  const [kind, setKind] = useState<CashMoveKind>(start.kind)
  const [amountText, setAmountText] = useState(start.amountText)
  const [reason, setReason] = useState(start.reason)
  const [error, setError] = useState<string | null>(start.note)
  const [busy, setBusy] = useState(false)
  const [locked, setLocked] = useState(start.unsure)
  const [unsure, setUnsure] = useState(start.unsure)     // sent with no reply: kept by the parent
  const [approving, setApproving] = useState(false)
  const running = useRef(false)
  const result = useRef<CashMoveResult | null>(null)

  const amountSen = parseRinggit(amountText) ?? 0
  const done = (r: CashMoveResult) => onRecorded(`${KIND_LABEL[r.kind]} ${formatSen(r.amountSen)} recorded`)
  const send = async (approverId: string | null, pin: string | null) => {
    setLocked(true)
    const id = moveId.current
    try {
      const r = await recordCashMove({ id, kind, amountSen, reason: reason.trim(), approverId, pin })
      onPending(null); setUnsure(false)
      return r
    } catch (e) {
      const m = msg(e)
      const what = moveRefusal(m)
      setUnsure(what === 'unsure')
      if (what === 'unsure') onPending({ id, kind, amountText, reason })    // a reopen resumes this id
      else onPending(null)
      if (what === 'nothing') { moveId.current = crypto.randomUUID(); setLocked(false) }  // nothing was recorded
      throw new Error(what === 'unsure' ? LOST_MOVE_NOTE[kind] : m)
    }
  }

  const submit = async () => {
    const problem = cashMoveProblem(amountText, reason)
    if (problem) { setError(problem); return }
    if (kind === 'pay_out') { setError(null); setApproving(true); return }
    if (running.current) return
    running.current = true; setBusy(true); setError(null)
    try { done(await send(null, null)) } catch (e) { setError(msg(e)) } finally { running.current = false; setBusy(false) }
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
          {locked && (
            <p className="text-xs text-brown-muted">
              {unsure ? 'Kind, amount and reason stay fixed until the server answers — closing this keeps them.'
                : 'Kind and amount are fixed now. To record another, close and reopen.'}
            </p>
          )}
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
