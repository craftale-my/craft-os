// src/qr/member/MemberSheet.tsx
/** Join / sign in and the balance (spec 2026-11-22-members-phone-points-design.md §3 "Guest (QR page)"):
 *  1. the number, 2. the six-digit code, 3. "You're in!"; signed in: the balance, the last entries, Sign out. */
import { useEffect, useRef, useState } from 'react'
import Mascot from '../Mascot'
import type { MemberApi, MemberEntry, RequestReason, VerifyReason } from './memberApi'
import type { Member } from './useMember'
import { formatPhone, maskPhone, normalisePhone } from '../../shared/lib/memberPhone'

export const RESEND_SECONDS = 60
const CODE_LENGTH = 6

const REASON_TEXT: Record<RequestReason | VerifyReason, string> = {
  invalid_phone: 'Enter a Malaysian mobile number, like 012-345 6789.',
  rate: 'Too many tries. Please ask our staff to add your number.',
  busy: 'Sign-in is busy right now. Please ask our staff to add your number.',
  unavailable: 'Sign-in is not available yet.',
  wrong: 'That code is not right. Try again.',
  expired: 'That code has expired. Send a new one.',
  locked: 'Too many wrong tries. Send a new code.',
  network: 'No connection. Try again.',
}
export const reasonText = (r: RequestReason | VerifyReason) => REASON_TEXT[r]

const pointsText = (n: number) => `${n.toLocaleString('en-MY')} ${n === 1 ? 'point' : 'points'}`
const rateText = (rate: number) => `${rate} ${rate === 1 ? 'point' : 'points'}`
/** `22 Nov · Craft Cafe Cheras · +42` (Malaysia's calendar day) */
export function entryText(e: MemberEntry): string {
  const d = new Date(e.at)
  const day = Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kuala_Lumpur' })
  const pts = e.points > 0 ? `+${e.points}` : `−${Math.abs(e.points)}`
  return [day, e.branchName, pts].filter(Boolean).join(' · ')
}

type Step = { kind: 'phone' } | { kind: 'code'; phone: string } | { kind: 'done'; phone: string }

const systemNow = () => Date.now()

export default function MemberSheet({ member, api, onClose, now = systemNow }: {
  member: Member
  api: Pick<MemberApi, 'requestCode' | 'verifyCode'>
  onClose: () => void
  /** injectable clock for the countdown */
  now?: () => number
}) {
  const [step, setStep] = useState<Step>({ kind: 'phone' })
  const [number, setNumber] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState(false)
  const [sentAt, setSentAt] = useState(0)
  const [tick, setTick] = useState(() => now())
  const busyRef = useRef(false)

  // the countdown for Send again
  useEffect(() => {
    if (step.kind !== 'code') return
    const timer = setInterval(() => setTick(now()), 1000)
    return () => clearInterval(timer)
  }, [step.kind, now])
  const wait = Math.max(0, RESEND_SECONDS - Math.floor((tick - sentAt) / 1000))

  const request = async (phone: string) => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true); setError(null)
    try {
      const r = await api.requestCode(phone)
      if (!r.ok) { setError(reasonText(r.reason)); return }
      const t = now()
      setSentAt(t); setTick(t); setCode(''); setStep({ kind: 'code', phone })
    } finally { busyRef.current = false; setBusy(false) }
  }
  const sendCode = () => {
    const phone = normalisePhone(number)
    if (!phone) { setError(reasonText('invalid_phone')); return }
    void request(phone)
  }
  const confirm = async (value: string) => {
    if (step.kind !== 'code' || busyRef.current || value.length !== CODE_LENGTH) return
    busyRef.current = true; setBusy(true); setError(null)
    try {
      const r = await api.verifyCode(step.phone, value)
      if (!r.ok) { setError(reasonText(r.reason)); if (r.reason === 'wrong') setCode(''); return }
      setStep({ kind: 'done', phone: step.phone })
      await member.signIn(r.token)
    } finally { busyRef.current = false; setBusy(false) }
  }
  const typeCode = (raw: string) => {
    const v = raw.replace(/\D/g, '').slice(0, CODE_LENGTH)
    setCode(v)
    if (v.length === CODE_LENGTH) void confirm(v)                 // fills itself from the SMS or a paste: no tap needed
  }

  const signedIn = member.status === 'in' && member.me && step.kind !== 'done'
  const title = signedIn ? 'Your points' : step.kind === 'code' ? 'Enter the code' : step.kind === 'done' ? "You're in!" : 'Collect points with your phone number'
  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 sm:items-center" onClick={busy ? undefined : onClose}>
      <div role="dialog" aria-label={title}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-card p-4 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        {signedIn && member.me ? (
          <>
            <h2 className="text-lg font-semibold text-brown-dark">Your points</h2>
            <p className="mt-1 text-sm text-brown-muted">{member.me.phoneMasked}</p>
            <p className="mt-3 text-[28px] font-bold text-brown-dark">{pointsText(member.me.points)}</p>
            {member.me.entries.length > 0 && (
              <ul aria-label="Last entries" className="mt-2 divide-y divide-border text-sm text-brown-dark">
                {member.me.entries.slice(0, 5).map((e, i) => <li key={i} className="py-2">{entryText(e)}</li>)}
              </ul>
            )}
            <p className="mt-3 text-sm text-brown-muted">How points work: {rateText(member.rate)} for every RM 1 you pay.</p>
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => { void member.signOut(); onClose() }} className="flex-1 rounded-xl border border-border py-3">Sign out</button>
              <button type="button" onClick={onClose} className="flex-[2] rounded-xl bg-brown-btn py-3 text-white hover:bg-brown-btn-hover">Done</button>
            </div>
          </>
        ) : step.kind === 'done' ? (
          <div className="text-center">
            <Mascot pose="cheer" size={72} className="mx-auto" />
            <p className="mt-2 text-[17px] font-semibold text-brown-dark">You're in! Points from this table's bill go to <span className="whitespace-nowrap">{maskPhone(step.phone)}</span>.</p>
            <p className="mt-2 text-[22px] font-bold text-brown-dark">{member.me ? pointsText(member.me.points) : ' '}</p>
            <button type="button" onClick={onClose} className="mt-4 w-full rounded-xl bg-brown-btn py-3 text-white hover:bg-brown-btn-hover">Done</button>
          </div>
        ) : step.kind === 'code' ? (
          <>
            <h2 className="text-lg font-semibold text-brown-dark">Enter the code we sent to <span className="whitespace-nowrap">{formatPhone(step.phone)}</span></h2>
            <label className="relative mt-4 block">
              <input value={code} onChange={(e) => typeCode(e.target.value)} readOnly={busy}
                inputMode="numeric" autoComplete="one-time-code" maxLength={CODE_LENGTH} autoFocus pattern="[0-9]*"
                aria-label="6-digit code"
                className="absolute inset-0 h-full w-full bg-transparent text-transparent caret-transparent outline-none selection:bg-transparent" />
              <span aria-hidden="true" className="pointer-events-none grid grid-cols-6 gap-2">
                {Array.from({ length: CODE_LENGTH }, (_, i) => (
                  <span key={i} data-testid="code-box"
                    className={`flex h-12 items-center justify-center rounded-lg border-2 text-xl font-semibold text-brown-dark ${i === code.length ? 'border-brown-btn' : 'border-border'}`}>
                    {code[i] ?? ''}
                  </span>
                ))}
              </span>
            </label>
            {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
            <button type="button" onClick={() => void confirm(code)} disabled={busy || code.length !== CODE_LENGTH}
              className="mt-4 w-full rounded-xl bg-brown-btn py-3 text-white hover:bg-brown-btn-hover disabled:opacity-40">
              {busy ? 'Checking…' : 'Confirm'}
            </button>
            <div className="mt-3 flex justify-between text-sm">
              <button type="button" onClick={() => { setError(null); setStep({ kind: 'phone' }) }} disabled={busy}
                className="min-h-10 font-medium text-brown-btn underline disabled:opacity-40">Change number</button>
              <button type="button" onClick={() => void request(step.phone)} disabled={busy || wait > 0}
                className="min-h-10 font-medium text-brown-btn underline disabled:text-brown-muted disabled:no-underline">
                {wait > 0 ? `Send again in ${wait} s` : 'Send again'}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold text-brown-dark">Collect points with your phone number</h2>
            <label className="mt-3 block text-sm">
              <span className="sr-only">Phone number</span>
              <span className="flex items-stretch overflow-hidden rounded-lg border border-border">
                <span className="flex items-center bg-brown-track px-3 text-base text-brown-dark">+60</span>
                <input value={number} onChange={(e) => { setNumber(e.target.value); setError(null) }} disabled={busy}
                  inputMode="numeric" autoComplete="tel-national" type="tel" placeholder="12-345 6789" aria-label="Phone number"
                  onKeyDown={(e) => { if (e.key === 'Enter') sendCode() }}
                  className="min-w-0 flex-1 p-2 text-base outline-none" />
              </span>
            </label>
            {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
            <button type="button" onClick={sendCode} disabled={busy || number.trim() === ''}
              className="mt-3 w-full rounded-xl bg-brown-btn py-3 text-white hover:bg-brown-btn-hover disabled:opacity-40">
              {busy ? 'Sending…' : 'Send code'}
            </button>
            <p className="mt-2 text-sm text-brown-muted">We text you a 6-digit code. We only use your number for your points.</p>
            <button type="button" aria-expanded={notice} onClick={() => setNotice((v) => !v)}
              className="mt-2 min-h-10 text-sm font-medium text-brown-btn underline">How we use your number</button>
            {notice && (
              <div role="note" className="mt-1 rounded-xl bg-cream p-3 text-sm text-brown-dark">
                <p>We store your phone number, your points and your visits to our cafes.</p>
                <p className="mt-1">We use them only to add points for what you pay and to show you your balance.</p>
                <p className="mt-1">To delete your details, ask our staff or email us.</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
