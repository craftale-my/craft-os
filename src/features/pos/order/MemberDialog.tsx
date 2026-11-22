// src/features/pos/order/MemberDialog.tsx
import { useRef, useState, type FormEvent } from 'react'
import { formatPhone, normalisePhone } from '../../../shared/lib/memberPhone'
import { INVALID_PHONE, pointsWord, type BillMember } from './billMember'

export const MEMBER_LOADING = 'Loading…'
export const MEMBER_READ_FAILED = "Couldn't read the member."

/** Bill action Member (members spec §3 "Staff (POS)"): type a number → Attach. No code: staff are trusted and
 *  the server logs who attached. A bill that already has a member opens on it, with Change and Remove member.
 *  Until the bill's member is read the dialog says Loading… (or that the read failed, with Retry): the attach
 *  form is never shown over an unknown state. The server's refusals are shown as they are; a number the
 *  phone rule refuses never reaches it. */
export default function MemberDialog({ billNo, status, current, onRetry, onAttach, onRemove, onClose }: {
  billNo: string
  status: 'loading' | 'ok' | 'error'   // the read of the bill's member
  current: BillMember | null           // meaningful only when status is 'ok'
  onRetry: () => void
  onAttach: (phone: string) => Promise<BillMember>
  onRemove: () => Promise<void>
  onClose: () => void
}) {
  // what this dialog did itself (an attach, Change pressed); until then it follows the read
  const [local, setLocal] = useState<{ member: BillMember | null; editing: boolean } | null>(null)
  const [phone, setPhone] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)                   // synchronous: a double tap never sends twice
  const member = local ? local.member : current
  const editing = local ? local.editing : current === null

  const attach = async (e: FormEvent) => {
    e.preventDefault()
    if (busyRef.current) return
    const e164 = normalisePhone(phone)
    if (!e164) { setError(INVALID_PHONE); return }
    busyRef.current = true; setBusy(true); setError(null)
    try {
      const m = await onAttach(e164)
      setLocal({ member: m, editing: false }); setPhone('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { busyRef.current = false; setBusy(false) }
  }
  const remove = async () => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true); setError(null)
    try {
      await onRemove()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      busyRef.current = false; setBusy(false)
    }
  }

  const btn = 'min-h-12 rounded-xl font-medium disabled:opacity-40'
  const known = local !== null || status === 'ok'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={busy ? undefined : onClose}>
      <div role="dialog" aria-modal="true" aria-label="Member" className="w-full max-w-md rounded-2xl bg-card p-5 shadow-card"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold text-brown-dark">Member</h2>
          <span className="text-sm text-brown-muted">Bill {billNo}</span>
        </div>
        {!known ? (
          <>
            {status === 'error'
              ? <p role="alert" className="mt-4 rounded bg-red-50 p-2 text-sm text-red-700">{MEMBER_READ_FAILED}</p>
              : <p role="status" className="mt-4 text-base text-brown-muted">{MEMBER_LOADING}</p>}
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button type="button" onClick={onClose} className={`${btn} border border-border-mid text-brown-dark`}>Cancel</button>
              <button type="button" disabled={status !== 'error'} onClick={onRetry}
                className={`${btn} bg-brown-btn text-white hover:bg-brown-btn-hover`}>Retry</button>
            </div>
          </>
        ) : !editing && member ? (
          <>
            <p className="mt-4 text-base text-brown-dark" data-testid="member-summary">
              Member {formatPhone(member.phone)} · {pointsWord(member.points)}
              {member.isNew && <span className="ml-2 rounded bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-800">New member</span>}
            </p>
            {error && <p role="alert" className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
            <div className="mt-5 grid grid-cols-3 gap-2">
              <button type="button" disabled={busy} onClick={() => { setLocal({ member, editing: true }); setError(null) }}
                className={`${btn} border border-border-mid text-brown-dark`}>Change</button>
              <button type="button" disabled={busy} onClick={() => void remove()}
                className={`${btn} border border-red-300 text-red-700`}>Remove member</button>
              <button type="button" disabled={busy} onClick={onClose}
                className={`${btn} bg-brown-btn text-white hover:bg-brown-btn-hover`}>Done</button>
            </div>
          </>
        ) : (
          <form onSubmit={(e) => void attach(e)}>
            <label className="mt-4 block text-sm font-medium text-brown-dark">
              Phone number
              <input type="tel" inputMode="tel" autoComplete="off" autoFocus value={phone} placeholder="012-345 6789"
                onChange={(e) => { setPhone(e.target.value); setError(null) }}
                className="mt-1 h-14 w-full rounded-xl border border-border-mid px-4 text-2xl tabular-nums" />
            </label>
            {error && <p role="alert" className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button type="button" disabled={busy} onClick={() => (member ? (setLocal({ member, editing: false }), setError(null)) : onClose())}
                className={`${btn} border border-border-mid text-brown-dark`}>Cancel</button>
              <button type="submit" disabled={busy || phone.trim() === ''}
                className={`${btn} bg-brown-btn text-white hover:bg-brown-btn-hover`}>{busy ? 'Attaching…' : 'Attach'}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
