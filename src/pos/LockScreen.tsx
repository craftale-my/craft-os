import { useState } from 'react'
import { closedMessage, malaysiaToday, rosterPeople, type RosterPerson, type RosterReply } from './roster'
import { startSession } from './sessionApi'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const OFFLINE = "You're offline — nobody can sign in until the network is back."

/** The lock screen (spec §2 "PIN login and staff sessions", §5 "Messages"): the outlet and
 *  device, who may sign in here, and a PIN keypad. It covers the till, which stays underneath
 *  with any unsent items. */
export default function LockScreen({ roster, note, offline, loadError, onSignedIn, onRefresh }: {
  roster: RosterReply | null
  note: string | null              // why the last session ended, e.g. access_changed
  offline: boolean
  loadError: string | null
  onSignedIn: () => void
  onRefresh: () => void            // read the roster again (e.g. the outlet closed meanwhile)
}) {
  const [person, setPerson] = useState<RosterPerson | null>(null)
  const [pin, setPin] = useState('')
  const [pinError, setPinError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [screenNote, setScreenNote] = useState<string | null>(null)

  const closed = roster ? closedMessage(roster.outlet, malaysiaToday()) : null
  const people = roster && !closed ? rosterPeople(roster.staff) : []
  const shown = screenNote ?? note

  const close = () => { setPerson(null); setPin(''); setPinError(null) }
  const press = (k: string) => {
    setPinError(null)
    if (k === 'clear') setPin('')
    else if (k === 'back') setPin((p) => p.slice(0, -1))
    else setPin((p) => (p.length < 6 ? p + k : p))
  }
  const submit = async () => {
    if (!person || pin.length < 4 || busy) return
    setBusy(true)
    try {
      const r = await startSession(person.id, pin)
      if (r.ok) { close(); setScreenNote(null); onSignedIn(); return }
      setPin('')
      if (r.code === 'wrong_pin') { setPinError(r.error); return }
      close()
      setScreenNote(r.error)
      if (r.code === 'outlet_closed' || r.code === 'not_allowed') onRefresh()
    } catch (e) {
      setPinError(offline ? OFFLINE : msg(e))
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-cream text-brown-dark" data-testid="lock-screen">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <div className="text-xl font-semibold">{roster?.outlet.name ?? 'Craft POS'}</div>
          <div className="text-sm text-brown-muted">{roster?.device.name ?? ''}</div>
        </div>
        <button type="button" onClick={onRefresh} className="min-h-11 rounded-lg border border-border px-4 text-sm">Refresh</button>
      </header>
      <main className="flex-1 overflow-y-auto p-6">
        {offline && <p role="status" className="mb-4 rounded-lg bg-amber-50 p-3 text-amber-900">{OFFLINE}</p>}
        {shown && <p role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-red-800">{shown}</p>}
        {loadError && !offline && <p className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{loadError}</p>}
        {closed && <p className="mb-4 rounded-lg bg-amber-50 p-3 text-lg text-amber-900">{closed}</p>}
        {!closed && roster && <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-brown-muted">Tap your name</h2>}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {people.map((p) => (
            <button key={p.id} type="button" disabled={!p.canSignIn} onClick={() => { setScreenNote(null); setPerson(p) }}
              className="min-h-20 rounded-xl border border-border-mid bg-card px-4 text-left disabled:opacity-50">
              <div className="font-medium">{p.name}</div>
              {p.note && <div className="text-xs text-brown-muted">{p.note}</div>}
            </button>
          ))}
        </div>
      </main>
      {person && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={close}>
          <div role="dialog" aria-label={`PIN for ${person.name}`} className="w-full max-w-xs rounded-2xl bg-card p-5 shadow-card"
            onClick={(e) => e.stopPropagation()}>
            <div className="text-center text-lg font-semibold">{person.name}</div>
            <div className="my-3 text-center font-mono text-3xl tracking-[0.5em]" aria-label="PIN entered">{'•'.repeat(pin.length) || ' '}</div>
            {pinError && <p role="alert" className="mb-2 text-center text-sm text-red-700">{pinError}</p>}
            <div className="grid grid-cols-3 gap-2">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'].map((k) => (
                <button key={k} type="button" onClick={() => press(k)} disabled={busy}
                  className="min-h-14 rounded-xl border border-border-mid text-xl">
                  {k === 'clear' ? 'Clear' : k === 'back' ? '⌫' : k}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => void submit()} disabled={busy || pin.length < 4}
              className="mt-3 min-h-12 w-full rounded-xl bg-brown-btn font-medium text-white disabled:opacity-40">Sign in</button>
          </div>
        </div>
      )}
    </div>
  )
}
