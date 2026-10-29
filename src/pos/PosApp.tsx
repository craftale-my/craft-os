import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import PosTill from '../features/pos/order/PosTill'
import PrintHostPanel from '../features/pos/order/PrintHostPanel'
import ConfirmDialog, { type ConfirmRequest } from '../features/pos/shell/ConfirmDialog'
import { createIdbStore } from '../features/pos/offline/idbStore'
import type { QueuedOrder } from '../features/pos/offline/orderQueue'
import { fetchProductNames } from '../features/pos/checkout/checkoutApi'
import { contextCode, type ContextCode } from '../features/pos/deviceErrors'
import ActivationScreen from './ActivationScreen'
import LockScreen from './LockScreen'
import { loadPending, type ActivationState } from './activation'
import {
  clearPendingLock, forgetContext, holdQueued, loadContext, loadProductNames, pendingLock, saveContext,
  saveProductNames, setPendingLock, UNPAIRED_REASON, type LockReason,
} from './deviceStore'
import { CONTEXT_EVENT, supabase } from './posSupabase'
import type { RosterReply } from './roster'
import {
  endSession, fetchRoster, fetchWhoAmI, forgetDevice, hasDeviceSession, unpairThisDevice, type WhoAmI,
} from './sessionApi'
import { useAppUpdate } from './useAppUpdate'
import { useIdleLock } from './useIdleLock'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const ACCESS_CHANGED = 'Your access here has changed. Ask your manager.'
const ROSTER_MS = 60_000

type Phase =
  | { kind: 'boot' }
  | { kind: 'activation'; start: ActivationState; unsent: QueuedOrder[] }
  | { kind: 'device' }

function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])
  return online
}

/** Craft POS (spec §2, §3): activation → lock screen ⇄ the till. The till mounts at the first
 *  sign-in and stays mounted under the lock screen, so unsent items wait for the next person.
 *  The printing tablet's print host runs here, apart from the till: a locked iPad still prints. */
export default function PosApp() {
  const [phase, setPhase] = useState<Phase>({ kind: 'boot' })
  const [roster, setRoster] = useState<RosterReply | null>(null)
  const [who, setWho] = useState<WhoAmI | null>(null)          // null: locked
  const [till, setTill] = useState<WhoAmI | null>(null)        // the last signed-in context: keeps the till mounted
  const [lockNote, setLockNote] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [drafts, setDrafts] = useState(0)                      // the till's unsent items: an update waits for none
  const [printProblems, setPrintProblems] = useState(0)
  const [printSlot] = useState(() => document.createElement('div'))   // the staff panel shows the print host in it
  const online = useOnline()
  const updateReady = useAppUpdate()
  const whoRef = useRef(who)
  whoRef.current = who
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const leavingRef = useRef(false)      // toActivation has started: until the next activation, nothing else leaves or loads
  const seq = useRef(0)                 // the latest refresh: an older one that finishes late changes nothing
  const loadedOnce = useRef(false)      // a context was shown in this page: a failed read keeps it instead of the cache

  const signedIn = (w: WhoAmI | null) => {
    setWho(w)
    if (w) { setTill(w); setLockNote(null) }
  }

  /** The roster and, when someone is signed in, who it is. A Lock that could not reach the
   *  server is finished first. A tablet that boots offline opens the last context it saved;
   *  a refusal (a coded error) never signs anyone in. */
  const refresh = useCallback(async () => {
    const id = ++seq.current
    const current = () => id === seq.current && !leavingRef.current
    let r: RosterReply
    try {
      r = await fetchRoster()
      const pending = pendingLock(localStorage)
      if (pending && r.session) { await endSession(pending); r = await fetchRoster() }
    } catch (e) {
      if (!current()) return
      const c = !loadedOnce.current && !contextCode(msg(e)) ? loadContext(localStorage) : null
      if (c) {
        loadedOnce.current = true
        setRoster(c.roster)
        if (!pendingLock(localStorage)) signedIn(c.who)
      }
      setLoadError(msg(e))
      return
    }
    if (!current()) return
    clearPendingLock(localStorage)
    let w: WhoAmI | null = null
    let error: string | null = null
    if (r.session) {
      // outlet_closed, no_session…: the lock screen, which says why from the roster
      try { w = await fetchWhoAmI() } catch (e) {
        if (!contextCode(msg(e))) {
          // a network blip (refresh runs on every 'online') keeps whoever is signed in here
          if (whoRef.current?.staffId === r.session.staffId) w = whoRef.current
          else error = msg(e)
        }
      }
      if (!current()) return
    }
    loadedOnce.current = true
    setRoster(r); signedIn(w); setLoadError(error)
    saveContext(localStorage, { roster: r, who: w })
  }, [])

  const toActivation = useCallback(async (start: ActivationState, hold: boolean) => {
    if (leavingRef.current) return
    leavingRef.current = true                                         // once, whichever signal comes first
    const before = phaseRef.current
    phaseRef.current = { kind: 'activation', start, unsent: [] }
    let switched = false
    try {
      setConfirm(null); setLoadError(null); setLockNote(null)
      const unsent = hold ? await holdQueued(createIdbStore()).catch(() => []) : []
      await forgetDevice().catch(() => undefined)
      forgetContext(localStorage)
      setWho(null); setTill(null); setRoster(null); setDrafts(0)
      setPhase({ kind: 'activation', start, unsent })
      switched = true
    } finally {
      // something threw before the switch: the next signal may try again
      if (!switched) { leavingRef.current = false; phaseRef.current = before }
    }
  }, [])

  // boot
  useEffect(() => {
    void (async () => {
      if (!hasDeviceSession()) {
        const p = loadPending(localStorage)
        // orders held back when this tablet was unpaired stay listed until it is activated again
        const unsent = (await createIdbStore().all().catch(() => [] as QueuedOrder[]))
          .filter((o) => o.failedReason === UNPAIRED_REASON).sort((a, b) => a.queuedAt - b.queuedAt)
        setPhase({ kind: 'activation', start: p ? { kind: 'waiting', pending: p, note: null } : { kind: 'choose' }, unsent })
        return
      }
      phaseRef.current = { kind: 'device' }
      setPhase({ kind: 'device' })
      await refresh()
    })()
  }, [refresh])

  const lock = useCallback(async (reason: LockReason, note: string | null = null) => {
    // before any await: parallel refusals start one Lock, and a read in flight cannot sign them back in
    whoRef.current = null; seq.current++
    setWho(null); setLockNote(note); setConfirm(null)                 // e.g. "Unpair this device?" must not stay above the lock
    setPendingLock(localStorage, reason)
    try { await endSession(reason); clearPendingLock(localStorage) } catch { /* offline: ended on the next roster read */ }
    await refresh()
  }, [refresh])

  // a coded error from any call (posSupabase.ts)
  useEffect(() => {
    const on = (e: Event) => {
      const code = (e as CustomEvent<ContextCode>).detail
      if (code === 'device_unpaired') {
        if (phaseRef.current.kind === 'device' && !leavingRef.current) void toActivation({ kind: 'ended', reason: 'unpaired' }, true)
      } else if (code === 'access_changed') {
        if (whoRef.current) void lock('access_changed', ACCESS_CHANGED)
      } else if (whoRef.current) {                                    // no_session, outlet_closed: back to the lock screen
        setWho(null)
        void refresh()
      }
    }
    window.addEventListener(CONTEXT_EVENT, on)
    return () => window.removeEventListener(CONTEXT_EVENT, on)
  }, [lock, refresh, toActivation])

  // an unpaired device's token can no longer refresh: Supabase signs it out
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT' && phaseRef.current.kind === 'device' && !leavingRef.current) void toActivation({ kind: 'ended', reason: 'unpaired' }, true)
    })
    return () => data.subscription.unsubscribe()
  }, [toActivation])

  // while locked: the roster stays fresh; back online: the session token too
  useEffect(() => {
    if (phase.kind !== 'device' || who) return
    const timer = window.setInterval(() => void refresh(), ROSTER_MS)
    return () => window.clearInterval(timer)
  }, [phase.kind, who, refresh])
  useEffect(() => {
    if (!online || phase.kind !== 'device') return
    void supabase.auth.getSession().then(() => refresh())
  }, [online, phase.kind, refresh])

  // product names for the unpaired screen's list
  const whoId = who?.staffId
  useEffect(() => {
    if (whoId) fetchProductNames().then((rows) => saveProductNames(localStorage, rows), () => undefined)
  }, [whoId])

  // a downloaded update opens on the lock screen only, never mid-order or over unsent items
  useEffect(() => {
    if (updateReady && !who && drafts === 0) window.location.reload()
  }, [updateReady, who, drafts])

  useIdleLock(roster?.idleLockMinutes ?? 10, who !== null, () => void lock('idle'))

  if (phase.kind === 'boot') return <div className="flex min-h-dvh items-center justify-center bg-cream text-brown-muted">Craft POS</div>
  if (phase.kind === 'activation') {
    return <ActivationScreen start={phase.start} unsent={phase.unsent} names={loadProductNames(localStorage)}
      onActivated={() => {
        leavingRef.current = false
        loadedOnce.current = false                                    // nothing is shown yet for the new device
        phaseRef.current = { kind: 'device' }
        setPhase({ kind: 'device' }); void refresh()
      }} />
  }

  const requestLock = () => {
    if (online) { void lock('locked'); return }
    setConfirm({ title: "You're offline — nobody can sign in until the network is back.", confirmLabel: 'Lock anyway',
      onConfirm: () => void lock('locked') })
  }
  const requestUnpair = () => setConfirm({
    title: 'Unpair this device?', message: 'It stops working until HQ activates it again.', confirmLabel: 'Unpair', danger: true,
    onConfirm: async () => {
      // its waiting orders are held back, as for an unpair from HQ
      try { await unpairThisDevice(); await toActivation({ kind: 'choose' }, true) }
      catch (e) { setConfirm({ title: 'Could not unpair this device', message: msg(e), confirmLabel: 'OK', onConfirm: () => undefined }) }
    },
  })

  // the printing tablet prints whether or not anyone is signed in (pos_print_branch() needs no session)
  const printing = roster?.device.prints ?? false
  return (
    <>
      {printing && roster && createPortal(<PrintHostPanel branchId={roster.outlet.id} inline onProblems={setPrintProblems} />, printSlot)}
      {till && (
        <PosTill branchId={till.outletId} branchName={till.outletName} staffId={who?.staffId ?? till.staffId}
          staffName={who?.staffName ?? till.staffName}
          can={{ manageMenu: false, supervise: who?.canSupervise ?? false, settings: false }}
          prints={printing} locked={who === null} printHost={printing ? { slot: printSlot, problems: printProblems } : undefined}
          onLock={requestLock} onUnpair={who?.canUnpair ? requestUnpair : undefined} onDraftCount={setDrafts} />
      )}
      {!who && (
        <LockScreen roster={roster} note={lockNote} offline={!online} loadError={loadError}
          onSignedIn={() => void refresh()} onRefresh={() => void refresh()} />
      )}
      {confirm && (
        <ConfirmDialog {...confirm} onCancel={() => setConfirm(null)}
          onConfirm={() => { const c = confirm; setConfirm(null); c.onConfirm() }} />
      )}
    </>
  )
}
