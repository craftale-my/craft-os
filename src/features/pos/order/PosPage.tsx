// src/features/pos/order/PosPage.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext'
import { useCan } from '../../../shared/lib/permissions'
import {
  fetchBranchCatalogs, fetchBranchName, fetchOpenBillSummaries, fetchOpenBills, fetchOrderBillId, fetchTables,
  type OpenBillRow, type TableRow,
} from './posApi'
import type { BillSummary } from './billSummaries'
import { usePosRealtime, type OrderInsert } from './usePosRealtime'
import type { OrderLine } from './cart'
import type { BranchCatalogs } from './catalogs'
import { padFromRejected } from './rejectedOrder'
import type { QueuedOrder } from '../offline/orderQueue'
import { useOrderQueue } from './useOrderQueue'
import { discardQuestion, QUEUED_NOT_SENT } from './billView'
import { billTitle, targetBill, targetKey, targetTitle, type OrderTarget } from './orderTarget'
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

/** Which POS screen is up. An order screen is keyed by its session and its table or takeaway bill
 *  (targetKey): Select pax keeps the screen, a move or merge starts it again on the new bill, so
 *  unsent drafts never follow onto another bill; a new session (opened from home, Payment's
 *  Cancel) starts clean. */
type Screen =
  | { kind: 'home' }
  | { kind: 'order'; session: number; target: OrderTarget; lines?: OrderLine[]; catalogId?: string | null }
  | { kind: 'payment'; bill: OpenBillRow; back: OrderTarget }
  | { kind: 'transaction' }

/** /pos — the Feedme-layout POS (docs/superpowers/specs/2026-10-26-pos-feedme-frontend-design.md).
 *  Owns the data every screen shares (tables, open bills and their summaries, billing config,
 *  catalogs, the offline queue, realtime, the shift) and which screen is up. */
export default function PosPage() {
  const { staff } = useAuth()
  const { can } = useCan()
  const navigate = useNavigate()
  const branchId = staff?.branch_id ?? null
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
  const [pinOpen, setPinOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [paxFor, setPaxFor] = useState<TableRow | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [branchName, setBranchName] = useState<string | null>(null)
  const [stuckNames, setStuckNames] = useState<Map<string, string> | null>(null)
  const [branchCatalogs, setBranchCatalogs] = useState<BranchCatalogs | null>(null)
  const [billing, setBilling] = useState<BillingConfig | null>(null)
  const queue = useOrderQueue()
  const shift = useShiftOpen(refreshKey)
  const reqId = useRef(0)
  const session = useRef(0)
  const screenRef = useRef(screen)                  // Send & pay's awaits check the cashier is still on that order screen
  screenRef.current = screen
  const draftCount = useRef(0)                      // the order screen's unsent items, for the menu's guard
  const openBillIdRef = useRef<string | null>(null)
  // checkout ids this iPad sent per bill: a reopened Payment re-reads with them, so an unsure payment
  // that lands late shows as paid here. Dropped once the bill is paid or no longer open.
  const checkoutIdsByBill = useRef(new Map<string, string[]>())
  // The rejected original stays in the strip until its edited copy is saved; leaving the order
  // screen without sending keeps it, so nothing the cashier confirmed is ever silently dropped.
  const editingFrom = useRef<string | null>(null)

  /** Tables, open bills and their summaries together; resolves with the bills it read (null on failure). */
  const reload = useCallback(async (): Promise<OpenBillRow[] | null> => {
    if (!branchId) return null
    const id = ++reqId.current
    try {
      const [t, b, s] = await Promise.all([fetchTables(branchId), fetchOpenBills(branchId), fetchOpenBillSummaries(branchId)])
      if (id === reqId.current) { setTables(t); setBills(b); setSummaries(s); setError(null) }
      return b
    } catch (e) {
      if (id === reqId.current) setError(msg(e))
      return null
    }
  }, [branchId])
  useEffect(() => { void reload() }, [reload])
  const bump = useCallback(() => { setRefreshKey((k) => k + 1); void reload() }, [reload])
  useEffect(() => {
    const open = new Set(bills.map((b) => b.id))
    for (const id of checkoutIdsByBill.current.keys()) if (!open.has(id)) checkoutIdsByBill.current.delete(id)
  }, [bills])
  useEffect(() => {
    if (branchId) fetchBranchName(branchId).then(setBranchName, () => setBranchName(null))
  }, [branchId])
  const loadBilling = useCallback(() => {
    if (branchId) fetchBillingConfig(branchId).then(setBilling, (e) => setError(msg(e)))
  }, [branchId])
  useEffect(() => { loadBilling() }, [loadBilling])
  const hasStuck = queue.stuck.length > 0
  useEffect(() => {
    if (hasStuck && !stuckNames) fetchProductNames().then((rows) => setStuckNames(new Map(rows.map((r) => [r.id, r.name]))), () => undefined)
  }, [hasStuck, stuckNames])
  useEffect(() => {
    if (branchId) fetchBranchCatalogs(branchId).then(setBranchCatalogs, (e) => setError(msg(e)))
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
  const goHome = () => { editingFrom.current = null; draftCount.current = 0; setScreen({ kind: 'home' }) }
  const openOrder = (target: OrderTarget, lines?: OrderLine[], catalogId?: string | null) => {
    setNotice(null)
    draftCount.current = lines?.reduce((n, l) => n + l.qty, 0) ?? 0
    setScreen({ kind: 'order', session: ++session.current, target, lines, catalogId })
  }
  /** The order screen's target changed: the pax chosen for an empty table keeps the screen; a move or
   *  merge onto another bill starts it again there, without the drafts or the rejected order being edited. */
  const changeTarget = (t: OrderTarget) => {
    if (screen.kind !== 'order') return
    if (targetKey(t) === targetKey(screen.target)) { setScreen({ ...screen, target: t }); return }
    editingFrom.current = null; draftCount.current = 0
    setScreen({ kind: 'order', session: screen.session, target: t })
  }
  /** Leave the order screen through the menu: unsent items are asked about first (spec §2). */
  const leave = (go: () => void) => {
    if (screen.kind === 'order' && draftCount.current > 0) {
      setConfirm({ title: discardQuestion(draftCount.current), confirmLabel: 'Discard', danger: true,
        onConfirm: () => { editingFrom.current = null; draftCount.current = 0; go() } })
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
      else if (item === 'transaction') { editingFrom.current = null; draftCount.current = 0; setScreen({ kind: 'transaction' }) }
      else navigate(item === 'menu' ? '/menu' : '/pos/settings')
    })
  }

  // ── the queue ──
  // A rejected order is handed straight back to the order screen (cart intact), so drop the queued
  // copy instead of leaving a duplicate in the strip once the cashier fixes and resends.
  const submit = async (o: QueuedOrder) => {
    const res = await queue.submit(o)
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
   *  on this iPad (offline) → back home with QUEUED_NOT_SENT, so Payment never opens without it. */
  const sendAndPay = async (clientOrderId: string, target: OrderTarget, onSession: number) => {
    const stillHere = () => { const s = screenRef.current; return s.kind === 'order' && s.session === onSession }
    const billId = await fetchOrderBillId(clientOrderId)
    if (!stillHere()) return                                   // the cashier left meanwhile: no screen jumps
    if (!billId) { goHome(); setNotice(QUEUED_NOT_SENT); return }
    setRefreshKey((k) => k + 1)
    const fresh = await reload()
    if (!stillHere()) return
    if (!fresh) throw new Error('Could not load the bill — press Payment again.')
    const bill = fresh.find((b) => b.id === billId)
    if (!bill) throw new Error('This bill is no longer open — check it on the home screen.')
    loadBilling()
    draftCount.current = 0
    setScreen({ kind: 'payment', bill, back: target.kind === 'takeaway' ? { kind: 'takeaway', billId } : target })
  }

  if (!staff) return null
  if (!branchId) {
    return <div className="p-8 text-center">Your account has no branch — ask a manager to set it in Team.</div>
  }
  const items = menuItems({ manageMenu: can('manage_menu'), supervise: can('pos_supervise'), settings: can('access_settings') })
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
    <div className="flex h-dvh flex-col bg-cream text-brown-dark">
      {screen.kind === 'home' && (
        <HomeScreen tables={tables} bills={bills} summaries={summaries} newBillIds={newBillIds} banners={banners}
          onRefresh={bump} onPickTable={pickTable} onPickBill={(billId) => openOrder({ kind: 'takeaway', billId })}
          onNewTakeaway={() => openOrder({ kind: 'takeaway', billId: null })} />
      )}
      {screen.kind === 'order' && (
        <OrderScreen key={`${screen.session}:${targetKey(screen.target)}`} branchId={branchId} target={screen.target}
          tables={tables} bills={bills} summaries={summaries} refreshKey={refreshKey} billing={billing} shiftOpen={shift.open}
          lastCatalogs={branchCatalogs} initialLines={screen.lines} initialCatalogId={screen.catalogId}
          submit={submit}
          onCatalogs={setBranchCatalogs}
          onTarget={changeTarget}
          onBack={goHome}
          onSent={() => { goHome(); bump() }}
          onPay={(bill) => { loadBilling(); setScreen({ kind: 'payment', bill, back: screen.target }) }}
          onSendAndPay={(id) => sendAndPay(id, screen.target, screen.session)}
          onChanged={async () => { setRefreshKey((k) => k + 1); await reload() }}
          onDraftCount={(n) => { draftCount.current = n }} />
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
        <BottomBar title={title} staffName={staff.name} onMenu={() => setMenuOpen(true)} onStaff={() => setStaffOpen(true)} />
      )}
      {menuOpen && <GridMenu items={items} current={current} onPick={pickMenu} onClose={() => setMenuOpen(false)} />}
      {/* always mounted, hidden when closed: the one print host and shift bar of this iPad live in it */}
      <StaffPanel open={staffOpen} branchId={branchId} branchName={branchName ?? staff.branch ?? 'Branch'} staffName={staff.name}
        refreshKey={refreshKey} liveStatus={rtStatus} onShiftChanged={shift.reload}
        onMyPin={() => setPinOpen(true)} onClose={() => setStaffOpen(false)} />
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
