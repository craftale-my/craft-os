// src/features/pos/order/PosTill.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchBranchCatalogs, fetchOpenBillSummaries, fetchOpenBills, fetchOrderBillId, fetchTables,
  type OpenBillRow, type TableRow,
} from './posApi'
import type { BillSummary } from './billSummaries'
import { usePosRealtime, type OrderInsert } from './usePosRealtime'
import type { OrderLine } from './cart'
import type { BranchCatalogs } from './catalogs'
import { padFromRejected } from './rejectedOrder'
import type { QueuedOrder } from '../offline/orderQueue'
import { useOrderQueue } from './useOrderQueue'
import { discardQuestion } from './billView'
import { billTitle, targetBill, targetKey, targetTitle, type OrderTarget } from './orderTarget'
import { deadline, onSession, payOutcome, retarget, settleReload, SEND_PAY_WAIT_MS, type Screen } from './posScreen'
import HomeScreen from './HomeScreen'
import QueueStrip from './QueueStrip'
import OrderScreen from './OrderScreen'
import { fetchBillingConfig, fetchProductNames, type BillingConfig } from '../checkout/checkoutApi'
import MyPinDialog from '../checkout/MyPinDialog'
import PaymentScreen from '../checkout/PaymentScreen'
import TransactionScreen from '../checkout/TransactionScreen'
import ShiftsDrawer from '../shift/ShiftsDrawer'
import { useShiftOpen } from '../shift/useShiftOpen'
import BottomBar from '../shell/BottomBar'
import GridMenu from '../shell/GridMenu'
import StaffPanel from '../shell/StaffPanel'
import ConfirmDialog, { type ConfirmRequest } from '../shell/ConfirmDialog'
import PaxDialog from '../shell/PaxDialog'
import { menuItems, type MenuItem } from '../shell/shellMenu'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export interface TillProps {
  branchId: string
  branchName: string
  /** The signed-in person on a POS tablet: queued orders carry it (spec §2 "Offline queue").
   *  Null for a Craft OS login, whose orders the server records as the caller's. */
  staffId: string | null
  staffName: string
  can: { manageMenu: boolean; supervise: boolean; settings: boolean }
  /** This device prints the outlet's tickets (the POS app: the printing tablet only). */
  prints: boolean
  /** The tablet is locked (POS app): an open Payment goes home and the panels close. Unsent
   *  items stay for whoever signs in and presses Send (spec §2 "What locking keeps"). */
  locked: boolean
  /** Craft OS: Menu and Setting open its back-office pages. */
  onBackOffice?: (path: '/menu' | '/pos/settings') => void
  /** Craft OS: Exit POS, after asking about unsent items. */
  onExit?: () => void
  /** Craft OS: My PIN. */
  myPin?: boolean
  /** The POS app: Lock. */
  onLock?: () => void
  /** The POS app, for a manager of this outlet: Unpair this device. */
  onUnpair?: () => void
  /** The POS app: every change of the order screen's unsent items (an update waits for none). */
  onDraftCount?: (n: number) => void
  /** The POS app: its one print host, mounted above the till so it prints on the lock screen too.
   *  The staff panel shows it in `slot`; `problems` is its count for the bottom bar's badge.
   *  Without it (Craft OS) the staff panel runs its own. */
  printHost?: { slot: HTMLElement; problems: number }
}

/** The till — the Feedme-layout POS (docs/superpowers/specs/2026-10-26-pos-feedme-frontend-design.md),
 *  run by Craft OS's /pos (PosPage) and by the POS app. Owns the data every screen shares (tables,
 *  open bills and their summaries, billing config, catalogs, the offline queue, realtime, the shift)
 *  and which screen is up. */
export default function PosTill({ branchId, branchName, staffId, staffName, can, prints, locked, onBackOffice, onExit, myPin = false, onLock, onUnpair, onDraftCount, printHost }: TillProps) {
  const [tables, setTables] = useState<TableRow[]>([])
  const [bills, setBills] = useState<OpenBillRow[]>([])
  const [summaries, setSummaries] = useState<Map<string, BillSummary>>(new Map())
  const [newBillIds, setNewBillIds] = useState<Set<string>>(new Set())
  const [refreshKey, setRefreshKey] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [screen, setScreen] = useState<Screen>({ kind: 'home' })
  const [menuOpen, setMenuOpen] = useState(false)
  const [staffOpen, setStaffOpen] = useState(false)
  const [printProblems, setPrintProblems] = useState(0)   // the print host's problem count: the bottom bar's badge
  const [pinOpen, setPinOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [paxFor, setPaxFor] = useState<TableRow | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [stuckNames, setStuckNames] = useState<Map<string, string> | null>(null)
  const [branchCatalogs, setBranchCatalogs] = useState<BranchCatalogs | null>(null)
  const [billing, setBilling] = useState<BillingConfig | null>(null)
  const queue = useOrderQueue()
  const shift = useShiftOpen(refreshKey)
  const reqId = useRef(0)
  const session = useRef(0)
  const screenRef = useRef(screen)                  // late order-screen callbacks check the cashier is still on that session
  screenRef.current = screen
  const lockedRef = useRef(locked)                  // a Send & pay that finishes after the tablet locked must not open Payment
  lockedRef.current = locked
  const draftCount = useRef(0)                      // the order screen's unsent items, for the menu's guard
  const setDrafts = (n: number) => { draftCount.current = n; onDraftCount?.(n) }
  const orderSending = useRef(false)                // the order screen is sending: the menu stays shut until it is done
  const openBillIdRef = useRef<string | null>(null)
  // checkout ids this iPad sent per bill: a reopened Payment re-reads with them, so an unsure payment
  // that lands late shows as paid here. Dropped once the bill is paid or no longer open.
  const checkoutIdsByBill = useRef(new Map<string, string[]>())
  // The rejected original stays in the strip until its edited copy is saved; leaving the order
  // screen without sending keeps it, so nothing the cashier confirmed is ever silently dropped.
  const editingFrom = useRef<string | null>(null)

  /** Tables, open bills and their summaries together; resolves with the bills it read (null on failure).
   *  The summaries are not needed to show the tables (settleReload): a failed read keeps the last ones. */
  const reload = useCallback(async (): Promise<OpenBillRow[] | null> => {
    const id = ++reqId.current
    const [t, b, s] = await Promise.allSettled([fetchTables(branchId), fetchOpenBills(branchId), fetchOpenBillSummaries(branchId)])
    const r = settleReload(t, b, s)
    if (!r.ok) {
      if (id === reqId.current) setError(r.error)
      return null
    }
    if (id === reqId.current) {
      setTables(r.tables); setBills(r.bills); setError(null)
      if (r.summaries) setSummaries(r.summaries)
    }
    return r.bills
  }, [branchId])
  useEffect(() => { void reload() }, [reload])
  const bump = useCallback(() => { setRefreshKey((k) => k + 1); void reload() }, [reload])
  useEffect(() => {
    const open = new Set(bills.map((b) => b.id))
    for (const id of checkoutIdsByBill.current.keys()) if (!open.has(id)) checkoutIdsByBill.current.delete(id)
  }, [bills])
  const loadBilling = useCallback(() => {
    fetchBillingConfig(branchId).then(setBilling, (e) => setError(msg(e)))
  }, [branchId])
  useEffect(() => { loadBilling() }, [loadBilling])
  const hasStuck = queue.stuck.length > 0
  useEffect(() => {
    if (hasStuck && !stuckNames) fetchProductNames().then((rows) => setStuckNames(new Map(rows.map((r) => [r.id, r.name]))), () => undefined)
  }, [hasStuck, stuckNames])
  useEffect(() => {
    fetchBranchCatalogs(branchId).then(setBranchCatalogs, (e) => setError(msg(e)))
  }, [branchId])

  const onOrder = useCallback((row: OrderInsert) => {
    if (row.source === 'qr' && row.bill_id !== openBillIdRef.current) setNewBillIds((s) => new Set(s).add(row.bill_id))
    bump()
  }, [bump])
  // another iPad paid, voided, moved or merged a bill: refresh everything on screen
  const rtStatus = usePosRealtime(branchId, { onOrder, onBill: bump, onSweep: bump })

  const orderBill = screen.kind === 'order' ? targetBill(screen.target, bills) : null
  openBillIdRef.current = orderBill?.id ?? null

  // ── navigation ──
  const goHome = () => { editingFrom.current = null; setDrafts(0); setScreen({ kind: 'home' }) }
  const openOrder = (target: OrderTarget, lines?: OrderLine[], catalogId?: string | null) => {
    setNotice(null)
    editingFrom.current = null                      // editRejected sets it again after opening
    setDrafts(lines?.reduce((n, l) => n + l.qty, 0) ?? 0)
    setScreen({ kind: 'order', session: ++session.current, target, lines, catalogId })
  }
  /** The order screen of `sess` changed target (retarget): a move or merge onto another bill starts it
   *  again there, without the drafts or the rejected order being edited. A late call from a screen
   *  the cashier already left does nothing. */
  const changeTarget = (sess: number, t: OrderTarget) => {
    const { screen: next, restarted } = retarget(screenRef.current, sess, t)
    if (next === screenRef.current) return
    if (restarted) { editingFrom.current = null; setDrafts(0) }
    screenRef.current = next
    setScreen(next)
  }
  /** Back or a finished send from the order screen of `sess`: home, unless the cashier already left it. */
  const homeFrom = (sess: number) => { if (onSession(screenRef.current, sess)) goHome() }
  /** Leave the order screen through the menu or Exit POS: unsent items are asked about first (spec §2). */
  const leave = (go: () => void) => {
    if (screen.kind === 'order' && draftCount.current > 0) {
      setConfirm({ title: discardQuestion(draftCount.current), confirmLabel: 'Discard', danger: true,
        onConfirm: () => { editingFrom.current = null; setDrafts(0); go() } })
      return
    }
    go()
  }
  const pickTable = (tableId: string) => {
    const bill = bills.find((b) => b.table_id === tableId)
    if (bill) {
      setNewBillIds((s) => { const n = new Set(s); n.delete(bill.id); return n })
      openOrder({ kind: 'table', tableId, pax: null })
      return
    }
    setPaxFor(tables.find((t) => t.id === tableId) ?? null)     // an empty table: Select pax first
  }
  const pickMenu = (item: MenuItem) => {
    setMenuOpen(false)
    if (item === 'report') { setReportOpen(true); return }
    leave(() => {
      if (item === 'order') goHome()
      else if (item === 'transaction') { editingFrom.current = null; setDrafts(0); setScreen({ kind: 'transaction' }) }
      else onBackOffice?.(item === 'menu' ? '/menu' : '/pos/settings')
    })
  }

  // ── the lock (POS app) ──
  // Locking closes what the last person had open; an open Payment goes home without taking money.
  useEffect(() => {
    if (!locked) return
    setMenuOpen(false); setStaffOpen(false); setReportOpen(false); setPaxFor(null); setConfirm(null)
    // Payment and Transaction have no drafts to keep; the order screen stays (its own dialogs close via `locked`)
    if (screenRef.current.kind === 'payment' || screenRef.current.kind === 'transaction') goHome()
  }, [locked])
  // a sign-in after the lock, the same person or the next: read everything again (calls made while
  // locked were refused). Craft OS never locks.
  const wasLocked = useRef(locked)
  useEffect(() => {
    const unlocked = wasLocked.current && !locked
    wasLocked.current = locked
    if (!unlocked) return
    bump(); loadBilling()
    // the catalogs list is read once per branch: a read refused while locked would otherwise stay empty
    fetchBranchCatalogs(branchId).then(setBranchCatalogs, (e) => setError(msg(e)))
  }, [locked, bump, loadBilling, branchId])

  // ── the queue ──
  // A rejected order is handed straight back to the order screen (cart intact), so drop the queued
  // copy instead of leaving a duplicate in the strip once the cashier fixes and resends.
  const submit = async (o: QueuedOrder) => {
    const res = await queue.submit(staffId ? { ...o, staffId } : o)
    if (res.rejectedReason) await queue.discard(res.clientOrderId)
    else if (editingFrom.current) {
      // the edited copy is now saved on this iPad, so the rejected original can go
      await queue.discard(editingFrom.current)
      editingFrom.current = null
    }
    return res
  }
  const editRejected = (o: QueuedOrder) => {
    const p = padFromRejected(o)
    openOrder(p.target, p.lines, p.catalogId)
    editingFrom.current = o.clientOrderId
  }

  /** Send & pay: the order reached the server → Payment on the bill it landed on. Still only queued
   *  on this iPad, or the lookup failed (offline) → home with QUEUED_NOT_SENT (payOutcome), so
   *  Payment never opens without the order and the cashier is never left on an empty cart. The
   *  lookup and the reload after it share one ~8 s deadline: a stalled network counts as not found. */
  const sendAndPay = async (clientOrderId: string, target: OrderTarget, sess: number) => {
    const wait = deadline(SEND_PAY_WAIT_MS)
    let billId: string | null = null
    let fresh: OpenBillRow[] | null = null
    try {
      billId = await wait.race(fetchOrderBillId(clientOrderId).catch(() => null), null)
      if (!onSession(screenRef.current, sess)) return            // the cashier left meanwhile: no screen jumps
      if (billId) {
        setRefreshKey((k) => k + 1)
        fresh = await wait.race(reload(), null)
        if (!onSession(screenRef.current, sess)) return
      }
    } finally { wait.clear() }
    const out = payOutcome(billId, fresh, target)
    if (lockedRef.current) { goHome(); return }                  // locked meanwhile: the order is sent or queued, Payment must not open
    if (out.kind === 'home') { goHome(); setNotice(out.notice); return }
    loadBilling()
    setDrafts(0)
    setScreen({ kind: 'payment', bill: out.bill, back: out.back })
  }

  const items = menuItems({ manageMenu: can.manageMenu && !!onBackOffice, supervise: can.supervise, settings: can.settings && !!onBackOffice })
  const title = screen.kind === 'home' ? 'Tables'
    : screen.kind === 'order' ? targetTitle(screen.target, orderBill, tables)
    : screen.kind === 'transaction' ? 'Transaction' : 'Payment'
  const current: MenuItem | null = screen.kind === 'transaction' ? 'transaction' : screen.kind === 'payment' ? null : 'order'
  const banners = (
    <>
      {shift.open === false && (
        <div className="flex items-center justify-between border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          <span>No shift open — orders still go to the kitchen, but payment waits for a shift.</span>
          <button type="button" onClick={() => setStaffOpen(true)} className="min-h-11 rounded-lg bg-brown-btn px-4 font-medium text-white">Open shift</button>
        </div>
      )}
      {notice && (
        <p role="status" className="m-3 rounded bg-amber-50 p-2 text-sm text-amber-800">
          {notice} <button type="button" className="min-h-11 px-2 underline" onClick={() => setNotice(null)}>OK</button>
        </p>
      )}
      <QueueStrip report={queue.report} stuck={queue.stuck} discardError={queue.discardError} tables={tables}
        catalogs={branchCatalogs} productNames={stuckNames} onRetry={() => void queue.flush()} onEdit={editRejected}
        onDiscard={(id) => void queue.discard(id)} />
      {error && (
        <p className="m-3 rounded bg-red-50 p-2 text-sm text-red-700">
          {error} <button type="button" className="min-h-11 px-2 underline" onClick={() => void reload()}>Retry</button>
        </p>
      )}
    </>
  )
  return (
    // locked: nothing under the lock screen takes focus or a tap
    <div className="flex h-dvh flex-col bg-cream text-brown-dark" inert={locked}>
      {screen.kind === 'home' && (
        <HomeScreen tables={tables} bills={bills} summaries={summaries} newBillIds={newBillIds} banners={banners}
          onRefresh={bump} onPickTable={pickTable} onPickBill={(billId) => openOrder({ kind: 'takeaway', billId })}
          onNewTakeaway={() => openOrder({ kind: 'takeaway', billId: null })} />
      )}
      {screen.kind === 'order' && (
        <OrderScreen key={`${screen.session}:${targetKey(screen.target)}`} branchId={branchId} target={screen.target}
          tables={tables} bills={bills} summaries={summaries} refreshKey={refreshKey} billing={billing} shiftOpen={shift.open}
          locked={locked} lastCatalogs={branchCatalogs} initialLines={screen.lines} initialCatalogId={screen.catalogId}
          submit={submit}
          onCatalogs={setBranchCatalogs}
          onTarget={(t) => changeTarget(screen.session, t)}
          onBack={() => homeFrom(screen.session)}
          onSent={() => { homeFrom(screen.session); bump() }}
          onPay={(bill) => { loadBilling(); setScreen({ kind: 'payment', bill, back: screen.target }) }}
          onSendAndPay={(id) => sendAndPay(id, screen.target, screen.session)}
          onChanged={async () => { setRefreshKey((k) => k + 1); await reload() }}
          onDraftCount={setDrafts}
          onSending={(busy) => { orderSending.current = busy }} />
      )}
      {screen.kind === 'transaction' && <TransactionScreen branchId={branchId} />}
      {screen.kind === 'payment' && (
        <PaymentScreen key={screen.bill.id} branchId={branchId} bill={screen.bill} refreshKey={refreshKey}
          title={billTitle(screen.bill.table_id, screen.bill.bill_no, tables)}
          earlierIds={checkoutIdsByBill.current.get(screen.bill.id) ?? []}
          onSendIds={(ids) => checkoutIdsByBill.current.set(screen.bill.id, ids)}
          onClose={() => openOrder(screen.back)}
          onPaid={() => { checkoutIdsByBill.current.delete(screen.bill.id); goHome(); bump() }} />
      )}
      {screen.kind !== 'payment' && (
        <BottomBar title={title} staffName={staffName} printProblems={printHost?.problems ?? printProblems} onMenu={() => { if (!orderSending.current) setMenuOpen(true) }} onStaff={() => setStaffOpen(true)} />
      )}
      {menuOpen && <GridMenu items={items} current={current} onPick={pickMenu} onClose={() => setMenuOpen(false)} />}
      {/* always mounted, hidden when closed: this iPad's shift bar lives in it, and its print host (Craft OS) */}
      <StaffPanel open={staffOpen} branchId={branchId} branchName={branchName} staffName={staffName}
        refreshKey={refreshKey} liveStatus={rtStatus} canSupervise={can.supervise} prints={prints} locked={locked} onShiftChanged={shift.reload}
        onMyPin={myPin ? () => setPinOpen(true) : undefined} onClose={() => setStaffOpen(false)} onPrintProblems={setPrintProblems} printSlot={printHost?.slot}
        signOff={onLock
          ? { label: 'Lock', onClick: () => { setStaffOpen(false); onLock() } }   // unsent items stay (spec §2)
          : { label: 'Exit POS', onClick: () => { if (orderSending.current) return; setStaffOpen(false); leave(() => onExit?.()) } }}
        onUnpair={onUnpair ? () => { setStaffOpen(false); onUnpair() } : undefined} />
      {pinOpen && <MyPinDialog onClose={() => setPinOpen(false)} />}
      {reportOpen && <ShiftsDrawer onClose={() => setReportOpen(false)} />}
      {paxFor && (
        <PaxDialog title={`Table ${paxFor.label}`} current={null} onClose={() => setPaxFor(null)}
          onPick={(n) => { const t = paxFor; setPaxFor(null); openOrder({ kind: 'table', tableId: t.id, pax: n }) }} />
      )}
      {confirm && (
        <ConfirmDialog {...confirm} onCancel={() => setConfirm(null)}
          onConfirm={() => { const c = confirm; setConfirm(null); c.onConfirm() }} />
      )}
    </div>
  )
}
