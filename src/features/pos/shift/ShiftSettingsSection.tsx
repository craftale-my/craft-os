import { useCallback, useEffect, useRef, useState } from 'react'
import { parseRinggit } from '../checkout/tender'
import { fetchCashVarianceLimit, saveCashVarianceLimit } from './shiftApi'
import { limitProblem, senToText } from './shift'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** POS settings → Shifts: the branch's cash variance limit (access_settings, like the other branch settings). */
export default function ShiftSettingsSection({ branchId }: { branchId: string }) {
  const [text, setText] = useState<string | null>(null)        // null while loading or after a failed load
  const [loadError, setLoadError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const seq = useRef(0)

  const load = useCallback(async () => {
    const id = ++seq.current
    setLoadError(null); setText(null)
    try { const sen = await fetchCashVarianceLimit(branchId); if (id === seq.current) setText(senToText(sen)) }
    catch (e) { if (id === seq.current) setLoadError(msg(e)) }
  }, [branchId])
  useEffect(() => { void load() }, [load])

  const save = async () => {
    if (text === null) return
    const problem = limitProblem(text)
    if (problem) { setOutcome({ ok: false, text: problem }); return }
    if (running.current) return
    running.current = true; setBusy(true); setOutcome(null)
    try {
      const sen = parseRinggit(text) ?? 0
      await saveCashVarianceLimit(branchId, sen)
      setOutcome({ ok: true, text: 'Shift settings saved' })
      setText(senToText(sen))                      // "2" shows as "2.00"; no reload, which would hide the outcome
    } catch (e) { setOutcome({ ok: false, text: msg(e) }) } finally { running.current = false; setBusy(false) }
  }

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="font-semibold">Shifts</h2>
      <p className="text-xs text-brown-muted">
        At close the cashier counts the cash without seeing the expected amount. A count further off than this limit
        needs a supervisor's PIN and a reason.
      </p>
      {loadError && (
        <p role="alert" className="mt-3 rounded bg-red-50 p-3 text-sm text-red-700">
          Could not load the shift settings: {loadError} <button className="underline" onClick={() => void load()}>Try again</button>
        </p>
      )}
      {!loadError && text === null && <p className="mt-2 text-sm text-brown-muted">Loading…</p>}
      {text !== null && (
        <>
          <label className="mt-2 block text-sm">Cash variance limit (RM)
            <input inputMode="decimal" className="ml-2 w-28 rounded border border-border p-1" value={text}
              onChange={(e) => { setText(e.target.value); setOutcome(null) }} />
          </label>
          {outcome && (
            <p role={outcome.ok ? 'status' : 'alert'}
              className={`mt-3 rounded p-3 text-sm ${outcome.ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700'}`}>{outcome.text}</p>
          )}
          <button onClick={() => void save()} disabled={busy} className="mt-3 rounded bg-brown-btn px-3 py-2 text-sm text-white disabled:opacity-40">
            {busy ? 'Saving…' : 'Save shift settings'}
          </button>
        </>
      )}
    </section>
  )
}
