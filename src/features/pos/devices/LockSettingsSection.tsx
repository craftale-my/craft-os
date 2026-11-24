import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchIdleLockMinutes, saveIdleLockMinutes } from './devicesApi'
import { parseLockMinutes } from './devices'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** POS settings → Lock: minutes without a touch before a POS tablet locks (save_lock_settings). */
export default function LockSettingsSection({ branchId }: { branchId: string }) {
  const [text, setText] = useState<string | null>(null)        // null while loading or after a failed load
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const seq = useRef(0)

  const load = useCallback(async () => {
    const id = ++seq.current
    setText(null)
    try { const n = await fetchIdleLockMinutes(branchId); if (id === seq.current) setText(String(n)) }
    catch (e) { if (id === seq.current) setOutcome({ ok: false, text: `Could not load the lock setting: ${msg(e)}` }) }
  }, [branchId])
  useEffect(() => { void load() }, [load])

  const save = async () => {
    if (text === null || running.current) return
    const n = parseLockMinutes(text)
    if (n === null) { setOutcome({ ok: false, text: 'Enter between 1 and 60 minutes' }); return }
    running.current = true; setBusy(true); setOutcome(null)
    try { await saveIdleLockMinutes(branchId, n); setText(String(n)); setOutcome({ ok: true, text: 'Lock setting saved' }) }
    catch (e) { setOutcome({ ok: false, text: msg(e) }) } finally { running.current = false; setBusy(false) }
  }

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="font-semibold">Lock</h2>
      <p className="text-xs text-brown-muted">A POS tablet locks after this many minutes without a touch; the next person signs in with their PIN. While the tablet is offline it does not lock by itself.</p>
      <label className="mt-2 block text-sm">Lock after
        <input className="mx-2 w-16 rounded border border-border p-1" inputMode="numeric" disabled={text === null}
          value={text ?? ''} onChange={(e) => { setText(e.target.value); setOutcome(null) }} />
        minutes
      </label>
      <button disabled={text === null || busy} onClick={() => void save()} className="mt-2 rounded bg-brown-btn px-3 py-1 text-sm text-white disabled:opacity-50">{busy ? 'Saving…' : 'Save lock setting'}</button>
      {outcome && (outcome.ok
        ? <p role="status" className="mt-3 rounded bg-green-50 p-3 text-sm text-green-800">{outcome.text}</p>
        : <p role="alert" className="mt-3 rounded bg-red-50 p-3 text-sm text-red-700">{outcome.text}</p>)}
    </section>
  )
}
