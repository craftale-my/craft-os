// src/features/pos/order/MemberDialog.tsx
import { useState, type FormEvent } from 'react'
import { formatPhone, normalisePhone } from '../../../shared/lib/memberPhone'
import { INVALID_PHONE, pointsWord, type BillMember } from './billMember'

/** Bill action Member (members spec §3 "Staff (POS)"): type a number → Attach. No code: staff are trusted and
 *  the server logs who attached. A bill that already has a member opens on it, with Change and Remove member.
 *  The server's refusals are shown as they are; a number the phone rule refuses never reaches it. */
export default function MemberDialog({ billNo, current, onAttach, onRemove, onClose }: {
  billNo: string
  current: BillMember | null
  onAttach: (phone: string) => Promise<BillMember>
  onRemove: () => Promise<void>
  onClose: () => void
}) {
  const [member, setMember] = useState<BillMember | null>(current)
  const [editing, setEditing] = useState(current === null)
  const [phone, setPhone] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const attach = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    const e164 = normalisePhone(phone)
    if (!e164) { setError(INVALID_PHONE); return }
    setBusy(true); setError(null)
    try {
      const m = await onAttach(e164)
      setMember(m); setEditing(false); setPhone('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }
  const remove = async () => {
    if (busy) return
    setBusy(true); setError(null)
    try {
      await onRemove()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const btn = 'min-h-12 rounded-xl font-medium disabled:opacity-40'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={busy ? undefined : onClose}>
      <div role="dialog" aria-modal="true" aria-label="Member" className="w-full max-w-md rounded-2xl bg-card p-5 shadow-card"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold text-brown-dark">Member</h2>
          <span className="text-sm text-brown-muted">Bill {billNo}</span>
        </div>
        {!editing && member ? (
          <>
            <p className="mt-4 text-base text-brown-dark" data-testid="member-summary">
              Member {formatPhone(member.phone)} · {pointsWord(member.points)}
              {member.isNew && <span className="ml-2 rounded bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-800">New member</span>}
            </p>
            {error && <p role="alert" className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
            <div className="mt-5 grid grid-cols-3 gap-2">
              <button type="button" disabled={busy} onClick={() => { setEditing(true); setError(null) }}
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
              <button type="button" disabled={busy} onClick={() => (member ? (setEditing(false), setError(null)) : onClose())}
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
