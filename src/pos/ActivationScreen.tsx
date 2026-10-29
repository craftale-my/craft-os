import { useEffect, useRef, useState } from 'react'
import type { QueuedOrder } from '../features/pos/offline/orderQueue'
import {
  afterPoll, clearPending, detectPlatform, ENDED, isPolling, POLL_MS, savePending, type ActivationState,
} from './activation'
import { pollActivation, requestActivation, signInDevice } from './sessionApi'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const card = 'w-full max-w-md rounded-2xl bg-card p-6 shadow-card'
const primary = 'min-h-12 w-full rounded-xl bg-brown-btn px-4 font-medium text-white hover:bg-brown-btn-hover disabled:opacity-40'

/** "This device isn't activated" (spec §2 "Activation flow", Amendments): the first screen picks
 *  what the device is for (only POS for now), asks for a code, shows it while HQ approves it in
 *  Craft OS → Devices, and signs in as the device with the reply. `unsent` lists the orders an
 *  unpaired device could not send, so staff can enter them again (spec §5). */
export default function ActivationScreen({ start, unsent, names, onActivated }: {
  start: ActivationState
  unsent: QueuedOrder[]
  names: Map<string, string>
  onActivated: () => void
}) {
  const [state, setState] = useState<ActivationState>(start)
  const [name, setName] = useState('')
  const activated = useRef(onActivated)
  activated.current = onActivated

  // poll every 5 s while waiting; a failed poll (network) keeps waiting with a note
  useEffect(() => {
    if (!isPolling(state) || state.kind !== 'waiting') return
    const pending = state.pending
    let stopped = false
    const timer = window.setTimeout(async () => {
      try {
        const next = afterPoll(pending, await pollActivation(pending))
        if (stopped) return
        if (next.kind !== 'waiting') clearPending(localStorage)
        setState(next)
      } catch (e) {
        if (!stopped) setState({ kind: 'waiting', pending, note: `Can't reach the server — still trying. (${msg(e)})` })
      }
    }, POLL_MS)
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [state])

  // approved: sign in as the device, once
  useEffect(() => {
    if (state.kind !== 'signing_in') return
    let stopped = false
    signInDevice(state.email, state.password).then(
      () => { if (!stopped) activated.current() },
      (e) => { if (!stopped) setState({ kind: 'error', message: `Could not sign in as this device (${msg(e)}). Ask HQ to unpair it in Devices and approve a new request.` }) },
    )
    return () => { stopped = true }
  }, [state])

  const request = async () => {
    setState({ kind: 'requesting' })
    try {
      const pending = await requestActivation(name.trim() || null, detectPlatform(navigator.userAgent, navigator.maxTouchPoints))
      savePending(localStorage, pending)
      setState({ kind: 'waiting', pending, note: null })
    } catch (e) {
      setState({ kind: 'error', message: msg(e) })
    }
  }
  const again = () => { clearPending(localStorage); setState({ kind: 'choose' }) }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-cream p-6 text-brown-dark">
      <h1 className="font-display text-3xl">Craft POS</h1>
      {state.kind === 'choose' && (
        <div className={card}>
          <h2 className="text-lg font-semibold">This device isn't activated</h2>
          <p className="mt-1 text-sm text-brown-muted">What is this device for?</p>
          <label className="mt-4 block text-sm">
            Device name (optional)
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="e.g. Counter 1"
              className="mt-1 min-h-12 w-full rounded-xl border border-border-mid bg-white px-3" />
          </label>
          <button type="button" onClick={() => void request()} className={`mt-4 ${primary}`}>POS</button>
        </div>
      )}
      {state.kind === 'requesting' && <div className={card}><p>Asking for a code…</p></div>}
      {state.kind === 'waiting' && (
        <div className={`${card} text-center`}>
          <p className="text-sm text-brown-muted">Activation code</p>
          <p className="my-3 font-mono text-5xl tracking-widest" data-testid="activation-code">{state.pending.code}</p>
          {state.pending.name && <p className="text-sm">{state.pending.name}</p>}
          <p className="mt-3 text-sm">Waiting for approval — ask HQ to approve this code in Craft OS → POS → Devices.</p>
          {state.note && <p className="mt-2 text-xs text-amber-700">{state.note}</p>}
          <button type="button" onClick={again} className="mt-4 min-h-11 text-sm underline">Cancel</button>
        </div>
      )}
      {state.kind === 'signing_in' && <div className={card}><p>Approved — signing in…</p></div>}
      {state.kind === 'ended' && (
        <div className={card}>
          <p className="font-medium">{ENDED[state.reason]}</p>
          <button type="button" onClick={again} className={`mt-4 ${primary}`}>Request again</button>
        </div>
      )}
      {state.kind === 'error' && (
        <div className={card}>
          <p className="text-red-700">{state.message}</p>
          <button type="button" onClick={again} className={`mt-4 ${primary}`}>Start again</button>
        </div>
      )}
      {unsent.length > 0 && (
        <div className={card} data-testid="unsent">
          <h2 className="font-semibold">{unsent.length} order{unsent.length === 1 ? ' was' : 's were'} not sent</h2>
          <p className="text-sm text-brown-muted">Enter them again on a working tablet.</p>
          <ul className="mt-2 space-y-2 text-sm">
            {unsent.map((o) => (
              <li key={o.clientOrderId} className="rounded-lg bg-cream p-2">
                <div className="text-xs text-brown-muted">{new Date(o.queuedAt).toLocaleString()} · {o.orderType === 'takeaway' ? 'Takeaway' : 'Dine in'}</div>
                {o.items.map((l, i) => <div key={i}>{l.qty} × {names.get(l.productId) ?? 'Item'}{l.note ? ` — ${l.note}` : ''}</div>)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
