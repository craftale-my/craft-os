import { useState } from 'react'
import { setMyPin } from './checkoutApi'

const PIN = /^\d{4,6}$/

/** Every staff member sets their own POS PIN; it is stored only as a bcrypt hash. */
export default function MyPinDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (!PIN.test(next)) { setError('The PIN must be 4 to 6 digits'); return }
    if (next !== again) { setError('The two new PINs are different'); return }
    if (current && !PIN.test(current)) { setError('Your current PIN is 4 to 6 digits'); return }
    setBusy(true); setError(null)
    try { await setMyPin(next, current || null); setDone(true) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  const field = (label: string, value: string, set: (v: string) => void) => (
    <label className="block text-sm">{label}
      <input type="password" inputMode="numeric" autoComplete="off" maxLength={6} className="mt-1 w-full rounded border border-border p-2 tracking-widest"
        value={value} onChange={(e) => { set(e.target.value.replace(/\D/g, '')); setError(null) }} />
    </label>
  )

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-full max-w-sm space-y-3 rounded-2xl bg-card p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">My POS PIN</h2>
        {done ? (
          <>
            <p className="text-sm">PIN saved. Use it when you approve a void or a refund.</p>
            <button onClick={onClose} className="w-full rounded-xl bg-brown-btn py-3 text-white">Done</button>
          </>
        ) : (
          <>
            <p className="text-xs text-brown-muted">Approvers type this PIN on the cashier's iPad. Never share it. Forgot it? A manager can clear it in POS settings.</p>
            {field('Current PIN (leave empty if you never set one)', current, setCurrent)}
            {field('New PIN (4–6 digits)', next, setNext)}
            {field('New PIN again', again, setAgain)}
            {error && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
            <div className="flex gap-2">
              <button onClick={onClose} className="flex-1 rounded-xl border border-border py-3">Cancel</button>
              <button onClick={() => void save()} disabled={busy} className="flex-1 rounded-xl bg-brown-btn py-3 text-white disabled:opacity-40">{busy ? 'Saving…' : 'Save PIN'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
