import { useEffect, useState, type ReactNode } from 'react'
import { fetchApprovers, fetchReasonTemplate, type Approval, type Approver } from './checkoutApi'
import { DEFAULT_TEMPLATE, reasonProblem, type ReasonAction, type ReasonTemplate } from './reasons'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Clear', '0', '⌫']

/** Reason + approver + PIN, for voids and refunds. The PIN is checked by the
 *  protected RPC itself (onApprove), never by a separate call. */
export default function ApprovalDialog({ branchId, action, title, summary, extra, extraProblem, onApprove, onClose, onDone }: {
  branchId: string
  action: ReasonAction
  title: string                         // "Void item"
  summary: string                       // "2 × Coffee Latte (COLD) · RM 26.00"
  extra?: ReactNode                     // refund: amount + method fields
  extraProblem?: string | null          // why the extra fields are not ready
  onApprove: (a: Approval) => Promise<void>
  onClose: () => void
  onDone: () => void
}) {
  const [template, setTemplate] = useState<ReasonTemplate>(DEFAULT_TEMPLATE)
  const [approvers, setApprovers] = useState<Approver[] | null>(null)
  const [choice, setChoice] = useState('')          // a listed reason, or '' when typing Other
  const [other, setOther] = useState('')
  const [approverId, setApproverId] = useState<string | null>(null)
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetchReasonTemplate(branchId, action).then((t) => setTemplate(t ?? DEFAULT_TEMPLATE), (e) => setError(msg(e)))
    fetchApprovers().then((a) => {
      setApprovers(a)
      if (a.length === 1 && a[0].hasPin) setApproverId(a[0].staffId)
    }, (e) => setError(msg(e)))
  }, [branchId, action])

  const reason = choice || other
  const press = (k: string) => {
    setError(null)
    if (k === 'Clear') setPin('')
    else if (k === '⌫') setPin((p) => p.slice(0, -1))
    else setPin((p) => (p.length < 6 ? p + k : p))
  }

  const approve = async () => {
    const problem = extraProblem ?? reasonProblem(template, reason)
      ?? (!approverId ? 'Choose who approves' : null)
      ?? (pin.length < 4 ? 'Enter the approver\'s PIN (4 to 6 digits)' : null)
    if (problem) { setError(problem); return }
    setBusy(true); setError(null)
    try {
      await onApprove({ reason: reason.trim(), approverId, pin })
      onDone()
    } catch (e) {
      setError(msg(e)); setPin('')
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40" onClick={busy ? undefined : onClose}>
      <div className="grid max-h-[92vh] w-full max-w-3xl grid-cols-2 gap-4 overflow-y-auto rounded-2xl bg-card p-5" onClick={(e) => e.stopPropagation()}>
        <div className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">{title}</h2>
            <p className="text-sm text-brown-muted">{summary}</p>
          </div>
          {extra}
          <div>
            <div className="text-xs font-semibold uppercase text-brown-muted">Reason{template.compulsory ? '' : ' (optional)'}</div>
            <div className="mt-1 flex flex-wrap gap-2">
              {template.reasons.map((r) => (
                <button key={r} onClick={() => { setChoice(r); setOther(''); setError(null) }}
                  className={`rounded-lg border px-3 py-2 text-sm ${choice === r ? 'border-brown-btn bg-brown-btn text-white' : 'border-border'}`}>{r}</button>
              ))}
            </div>
            {template.allowOther && (
              <input className="mt-2 w-full rounded border border-border p-2 text-sm" placeholder={template.reasons.length ? 'Other reason' : 'Reason'}
                value={other} onChange={(e) => { setOther(e.target.value); setChoice(''); setError(null) }} />
            )}
          </div>
          <div>
            <div className="text-xs font-semibold uppercase text-brown-muted">Approved by</div>
            {approvers === null && <p className="text-sm text-brown-muted">Loading…</p>}
            {approvers?.length === 0 && <p className="text-sm text-red-700">Nobody at this branch can approve. A manager grants "Approve POS voids &amp; refunds" in Settings → System Roles.</p>}
            <div className="mt-1 flex flex-wrap gap-2">
              {approvers?.map((a) => (
                <button key={a.staffId} disabled={!a.hasPin} onClick={() => { setApproverId(a.staffId); setPin(''); setError(null) }}
                  className={`rounded-lg border px-3 py-2 text-sm disabled:opacity-40 ${approverId === a.staffId ? 'border-brown-btn bg-brown-btn text-white' : 'border-border'}`}>
                  {a.name}{a.hasPin ? '' : ' (no PIN)'}
                </button>
              ))}
            </div>
          </div>
          {error && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
        </div>
        <div className="flex flex-col items-center gap-3">
          <div className="h-10 text-3xl tracking-[0.5em]">{'•'.repeat(pin.length) || <span className="text-base tracking-normal text-brown-muted">PIN</span>}</div>
          <div className="grid grid-cols-3 gap-2">
            {KEYS.map((k) => (
              <button key={k} onClick={() => press(k)} disabled={busy} className="h-16 w-20 rounded-xl border border-border text-xl">{k}</button>
            ))}
          </div>
          <div className="flex w-full gap-2">
            <button onClick={onClose} disabled={busy} className="flex-1 rounded-xl border border-border py-3">Cancel</button>
            <button onClick={() => void approve()} disabled={busy} className="flex-1 rounded-xl bg-red-700 py-3 text-white disabled:opacity-40">
              {busy ? 'Checking…' : 'Approve'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
