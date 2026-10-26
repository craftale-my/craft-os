// src/features/pos/order/OrderScreen.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Search } from 'lucide-react'
import {
  fetchBillItems, fetchBranchCatalogs, fetchPadProductInfo, fetchPosMenu, setSoldOut, setTablePaused,
  type BillItemRow, type OpenBillRow, type TableRow,
} from './posApi'
import { defaultLine, findProduct, formatSen, validateLine, type OrderLine, type PosMenu, type PosProduct } from './cart'
import { defaultCatalogProblem, noCatalogMessage, selectableCatalogs, SWITCH_CATALOG_CONFIRM, type BranchCatalogs } from './catalogs'
import { newQueuedOrder, type QueuedOrder } from '../offline/orderQueue'
import type { SubmitResult } from './useOrderQueue'
import { usePadWindows } from './usePadWindows'
import ProductTiles from './ProductTiles'
import ModifierSheet from './ModifierSheet'
import BillColumn from './BillColumn'
import BillActionsOverlay from './BillActionsOverlay'
import MoveToGrid from './MoveToGrid'
import { billActions, type BillAction } from './billActions'
import { billView, discardQuestion, draftsDiscarded, NO_SHIFT_PAY, payGate, sendFirstQuestion, type DraftRow, type SentRow } from './billView'
import { moveTargets, type MoveTarget } from './moveTargets'
import { shownPax, takesNewItems, TAKEAWAY_ONE_ORDER, targetBill, targetOrderType, targetTitle, type OrderTarget } from './orderTarget'
import { withPhotos, type PadProductInfo } from './padInfo'
import type { BillSummary } from './billSummaries'
import { mergeBills, moveBill, openTable, setBillPax, voidBill, voidItem, type BillingConfig } from '../checkout/checkoutApi'
import ApprovalDialog from '../checkout/ApprovalDialog'
import PickerSheet from '../checkout/BillPickers'
import ConfirmDialog, { type ConfirmRequest } from '../shell/ConfirmDialog'
import PaxDialog from '../shell/PaxDialog'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const BILL_GONE = 'This bill is no longer open.'

type Dialog =
  | { kind: 'void_item'; row: SentRow }
  | { kind: 'void_bill' }
  | { kind: 'actions' }
  | { kind: 'move' }
  | { kind: 'pax'; purpose: 'set' | 'open_qr' }
  | { kind: 'catalog' }
  | null

/** The order screen (spec §2): categories | product tiles | bill, replacing the old BillPanel and
 *  OrderPad. Everything OrderPad did is here unchanged — one catalog per order (the type's default,
 *  or an additional one; switching clears the cart, an edited order no longer offered carries what
 *  the new catalog sells), sold-out mode, time-slot greying and the pre-send slot check, the queue
 *  (enqueue then send; a rejection keeps the cart) — and every bill action BillPanel had: void item
 *  and void bill with approval, close an empty bill, move, merge, pause QR, open for QR. */
export default function OrderScreen({
  branchId, target, tables, bills, summaries, refreshKey, billing, shiftOpen, lastCatalogs, initialLines, initialCatalogId,
  submit, onCatalogs, onTarget, onBack, onSent, onPay, onSendAndPay, onChanged, onDraftCount,
}: {
  branchId: string
  target: OrderTarget
  tables: TableRow[]
  bills: OpenBillRow[]                       // the branch's open bills (PosPage keeps them fresh)
  summaries: ReadonlyMap<string, BillSummary>
  refreshKey: number                         // bumped on every order, bills event and 15 s sweep
  billing: BillingConfig | null
  shiftOpen: boolean | null
  lastCatalogs: BranchCatalogs | null        // the last catalogs this iPad saw: used when the fresh read fails
  initialLines?: OrderLine[]                 // a rejected order being edited
  initialCatalogId?: string | null           // ...keeps its catalog
  submit: (o: QueuedOrder) => Promise<SubmitResult>
  onCatalogs: (c: BranchCatalogs) => void
  onTarget: (t: OrderTarget) => void         // a move or merge landed elsewhere, or pax was chosen for an empty table
  onBack: () => void
  onSent: () => void                         // the drafts are in the queue: back to the tables
  onPay: (bill: OpenBillRow) => void
  onSendAndPay: (clientOrderId: string) => Promise<void>   // rejects with the words to show
  onChanged: () => Promise<void> | void      // a bill action changed something: reload
  onDraftCount: (n: number) => void          // PosPage guards leaving through the menu
}) {
  const orderType = targetOrderType(target)
  const bill = targetBill(target, bills)
  const table = target.kind === 'table' ? tables.find((t) => t.id === target.tableId) ?? null : null

  // ── catalogs: fetched fresh for this screen; offline, the last list this iPad saw ──
  const [fresh, setFresh] = useState<BranchCatalogs | null>(null)
  const [catalogsError, setCatalogsError] = useState<string | null>(null)
  const [catalogsTry, setCatalogsTry] = useState(0)
  useEffect(() => {
    let live = true
    setCatalogsError(null)
    fetchBranchCatalogs(branchId).then(
      (c) => { if (live) { onCatalogs(c); setFresh(c) } },
      (e) => {
        if (!live) return
        if (lastCatalogs) setFresh(lastCatalogs)
        else setCatalogsError(msg(e))
      },
    )
    return () => { live = false }
  }, [branchId, catalogsTry]) // eslint-disable-line react-hooks/exhaustive-deps
  const catalogs = useMemo(
    () => (fresh ? selectableCatalogs(fresh.assignments, fresh.catalogs, orderType, initialCatalogId ?? null) : null),
    [fresh, orderType, initialCatalogId],
  )
  const defaultProblem = fresh ? defaultCatalogProblem(fresh.assignments, fresh.catalogs, orderType) : null

  // ── the menu and the cart (OrderPad's state, unchanged) ──
  const [catalogId, setCatalogId] = useState<string | null>(initialCatalogId ?? null)
  const [menu, setMenu] = useState<PosMenu | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [category, setCategory] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [lines, setLines] = useState<OrderLine[]>(initialLines ?? [])
  const [sheet, setSheet] = useState<{ product: PosProduct; index: number | null } | null>(null)
  const [soldOutMode, setSoldOutMode] = useState(false)
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)              // synchronous guard: Send and Send & pay never run twice
  const [carry, setCarry] = useState<{ lines: OrderLine[]; to: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [info, setInfo] = useState<ReadonlyMap<string, PadProductInfo>>(new Map())
  const loadSeq = useRef(0)
  const catalogIdRef = useRef(catalogId)
  useEffect(() => { catalogIdRef.current = catalogId }, [catalogId])
  const slots = usePadWindows(catalogId)
  useEffect(() => { setError(null) }, [lines])
  useEffect(() => {
    let live = true
    fetchPadProductInfo().then((m) => { if (live) setInfo(m) }, () => undefined)   // without it: no photos, drafts left out of the totals
    return () => { live = false }
  }, [])

  // Only the order type's default is ever picked for the cashier (OrderPad's rule).
  useEffect(() => {
    if (!catalogs) return
    const def = catalogs.find((c) => c.isDefault)
    if (catalogId !== null && catalogId !== (initialCatalogId ?? null) && lines.length === 0
        && !catalogs.some((c) => c.id === catalogId)) {
      setCatalogId(def?.id ?? null)
      return
    }
    if (catalogId === null && def) setCatalogId(def.id)
  }, [catalogs, catalogId]) // eslint-disable-line react-hooks/exhaustive-deps

  const load = async () => {
    const seq = ++loadSeq.current
    const id = catalogIdRef.current
    if (!id) { setMenu(null); return }
    try {
      const m = await fetchPosMenu(id)
      if (seq === loadSeq.current) { setMenu(m); setError(null) }
    } catch (e) {
      if (seq === loadSeq.current) setError(msg(e))
    }
  }
  useEffect(() => { void load() }, [branchId, catalogId]) // eslint-disable-line react-hooks/exhaustive-deps

  const current = catalogs?.find((c) => c.id === catalogId) ?? null
  const noCatalog = catalogs !== null && catalogId === null && !catalogs.some((c) => c.isDefault)

  const doSwitch = (id: string, carrying: boolean) => {
    setCarry(carrying ? { lines, to: id } : null)
    if (!carrying) setLines([])
    setSheet(null); setMenu(null); setCategory(null); setNotice(null); setCatalogId(id)
  }
  // One order = one catalog: switching starts the cart again (asked first, in the POS's own dialog).
  const switchCatalog = (id: string) => {
    if (!id || id === catalogId) return
    const carrying = lines.length > 0 && !!current && !current.offered
    if (!carrying && lines.length > 0) {
      setConfirm({ title: SWITCH_CATALOG_CONFIRM, message: 'The items not sent yet are removed.', confirmLabel: 'Switch catalog', danger: true,
        onConfirm: () => doSwitch(id, false) })
      return
    }
    doSwitch(id, carrying)
  }
  useEffect(() => {
    if (!carry || !menu || carry.to !== catalogId) return
    const kept = carry.lines.filter((l) => {
      const p = findProduct(menu, l.productId)
      return p !== undefined && validateLine(p, l) === null
    })
    setLines(kept)
    if (kept.length < carry.lines.length) setNotice(`Items not in ${current?.name ?? 'this catalog'} were removed`)
    setCarry(null)
  }, [menu, carry, catalogId]) // eslint-disable-line react-hooks/exhaustive-deps

  const shownMenu = useMemo(() => (menu ? withPhotos(menu, info) : null), [menu, info])
  const products = useMemo(() => {
    if (!shownMenu) return []
    const all = shownMenu.categories.flatMap((c) => c.products.map((p) => ({ ...p, category: c.name })))
    const q = search.trim().toLowerCase()
    return all.filter((p) => (q ? p.name.toLowerCase().includes(q) : !category || p.category === category))
  }, [shownMenu, category, search])

  const tap = async (p: PosProduct, outOfSlot: boolean) => {
    if (soldOutMode) {
      try { await setSoldOut(branchId, p.id, !p.soldOut); await load() } catch (e) { setError(msg(e)) }
      return
    }
    if (!takesNewItems(target)) { setError(TAKEAWAY_ONE_ORDER); return }
    if (p.soldOut || outOfSlot) return
    if (p.variants.length === 1 && p.groups.length === 0) setLines((ls) => [...ls, defaultLine(p)])
    else setSheet({ product: p, index: null })
  }

  // ── the bill: sent items from the server (BillPanel's reads, unchanged) ──
  const [items, setItems] = useState<BillItemRow[] | null>(null)   // null = not loaded yet for this bill
  const [itemsError, setItemsError] = useState<string | null>(null)
  const [localKey, setLocalKey] = useState(0)
  useEffect(() => { setItems(null); setItemsError(null) }, [bill?.id])
  useEffect(() => {
    if (!bill) return
    let alive = true
    fetchBillItems(bill.id).then(
      (rows) => { if (alive) { setItems(rows); setItemsError(null) } },
      (e) => { if (alive) setItemsError(msg(e)) },
    )
    return () => { alive = false }
  }, [bill?.id, refreshKey, localKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const loaded = !bill || (items !== null && !itemsError)            // only then is it known whether the bill is empty

  const view = billView({
    orderType: bill?.order_type ?? orderType,
    tableId: bill ? bill.table_id : target.kind === 'table' ? target.tableId : null,
    items: bill ? items ?? [] : [], lines, menu, info, billing,
  })
  useEffect(() => { onDraftCount(view.draftCount) }, [view.draftCount]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── dialogs and one bill action at a time (BillPanel's run) ──
  const [dialog, setDialog] = useState<Dialog>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  useEffect(() => { setDialog(null); setConfirm(null) }, [bill?.id])
  const run = async (fn: () => Promise<void>, then?: () => void) => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true)
    try {
      try { await fn() } catch (e) { setDialog(null); setError(msg(e)); return }
      setDialog(null); setLocalKey((k) => k + 1)
      await onChanged()
      then?.()
    } finally { busyRef.current = false; setBusy(false) }
  }

  const [paused, setPaused] = useState(table?.qr_paused ?? false)
  useEffect(() => { setPaused(table?.qr_paused ?? false) }, [table?.id, table?.qr_paused])
  const togglePause = async () => {
    if (!table) return
    const next = !paused
    setPaused(next)
    try { await setTablePaused(table.id, next); void onChanged() } catch (e) { setPaused(!next); setError(msg(e)) }
  }

  // ── Send, Send & pay, Payment, back ──
  /** The drafts as one order through the queue; the order's id once it is stored, else null (the error shows). */
  const sendDrafts = async (): Promise<string | null> => {
    if (sendingRef.current || !menu || lines.length === 0) return null
    if (!takesNewItems(target)) { setError(TAKEAWAY_ONE_ORDER); return null }
    if (!catalogId) { setError(noCatalogMessage(orderType)); return null }
    for (const l of lines) {
      const p = findProduct(menu, l.productId)
      const problem = p ? validateLine(p, l) : 'Item is no longer on the menu'
      if (problem) { setError(problem); return null }
    }
    sendingRef.current = true; setSending(true)
    try {
      const late = await slots.check(lines, (id) => findProduct(menu, id)?.name ?? 'An item')
      if (late) { setError(late); return null }                     // the server would refuse it with the same words
      // the pax chosen for an empty table goes with its first order (the server only fills an empty pax)
      const pax = target.kind === 'table' && !bill?.pax ? target.pax : null
      const res = await submit(newQueuedOrder(orderType, target.kind === 'table' ? target.tableId : null, pax, lines,
        Date.now(), crypto.randomUUID(), catalogId))
      // the menu is read again first: a successful load clears the error, the rejection must stay
      if (res.rejectedReason) { await load(); setError(`Rejected: ${res.rejectedReason} — fix the order and send again`); return null }
      setLines([]); setError(null)
      return res.clientOrderId
    } catch (e) {
      setError(`Order NOT saved on this iPad: ${msg(e)}`)
      return null
    } finally { sendingRef.current = false; setSending(false) }
  }
  const send = async () => { if (await sendDrafts()) onSent() }
  const sendAndPay = async () => {
    const id = await sendDrafts()
    if (!id) return
    sendingRef.current = true; setSending(true)
    try { await onSendAndPay(id) } catch (e) { setError(msg(e)) } finally { sendingRef.current = false; setSending(false) }
  }

  const gate = payGate({ shiftOpen, draftCount: view.draftCount, hasBill: !!bill, liveSentCount: view.liveSentCount })
  const pay = () => {
    if (gate === 'send_first') {
      setConfirm({ title: sendFirstQuestion(view.draftCount), message: 'They go to the kitchen, then Payment opens.', confirmLabel: 'Send & pay',
        onConfirm: () => void sendAndPay() })
      return
    }
    if (gate === 'ready' && bill && loaded) onPay(bill)
  }
  const back = () => {
    if (view.draftCount > 0) {
      setConfirm({ title: discardQuestion(view.draftCount), confirmLabel: 'Discard', danger: true, onConfirm: onBack })
      return
    }
    onBack()
  }

  // ── bill actions ──
  const actions = billActions({
    isTable: target.kind === 'table', hasBill: !!bill, loaded, liveSentCount: view.liveSentCount, draftCount: view.draftCount,
    qrPaused: paused, qrRequiresOpenBill: billing?.settings.qrRequiresOpenBill ?? false,
  })
  const pickAction = (a: BillAction) => {
    setDialog(null)
    if (a === 'send') void send()
    else if (a === 'move') setDialog({ kind: 'move' })
    else if (a === 'void_bill') setDialog({ kind: 'void_bill' })
    else if (a === 'close_empty' && bill) {
      setConfirm({ title: `Close bill ${bill.bill_no}?`, message: 'It has nothing on it.', confirmLabel: 'Close bill', danger: true,
        onConfirm: () => void run(() => voidBill(bill.id, { reason: '', approverId: null, pin: null }), () => { if (lines.length === 0) onBack() }) })
    } else if (a === 'pax') setDialog({ kind: 'pax', purpose: 'set' })
    else if (a === 'open_qr') setDialog({ kind: 'pax', purpose: 'open_qr' })
    else if (a === 'pause_qr' || a === 'resume_qr') void togglePause()
  }
  const pickPax = (n: number) => {
    const purpose = dialog?.kind === 'pax' ? dialog.purpose : 'set'
    setDialog(null)
    if (purpose === 'open_qr' && table) { void run(async () => { await openTable(table.id, n) }); return }
    if (bill) { void run(() => setBillPax(bill.id, n)); return }
    if (target.kind === 'table') onTarget({ ...target, pax: n })
  }
  const pickMove = (m: MoveTarget) => {
    if (!bill || busyRef.current || m.kind === 'refused') return
    // the screen starts again on the bill moved or merged to, so unsent drafts are asked about first
    const drafts = view.draftCount
    if (m.kind === 'move') {
      const to = m.tableId
      const go = () => void run(() => moveBill(bill.id, to), () => onTarget({ kind: 'table', tableId: to, pax: null }))
      if (drafts > 0) {
        setConfirm({ title: discardQuestion(drafts), message: `Then bill ${bill.bill_no} moves to ${m.label}.`, confirmLabel: 'Discard & move', danger: true,
          onConfirm: go })
        return
      }
      go()
      return
    }
    // the bill merged into is the target, never the table: a takeaway merge target has no table
    const into = m.tableId !== null ? { kind: 'table' as const, tableId: m.tableId, pax: null } : { kind: 'takeaway' as const, billId: m.intoBillId }
    setConfirm({ title: `Merge into ${m.label}?`,
      message: `Every item of bill ${bill.bill_no} moves onto bill ${m.intoBillNo}, and this bill closes.${drafts > 0 ? ` ${draftsDiscarded(drafts)}` : ''}`,
      confirmLabel: 'Merge', danger: drafts > 0, onConfirm: () => void run(() => mergeBills(bill.id, m.intoBillId), () => onTarget(into)) })
  }
  const tapDraft = (d: DraftRow) => {
    const p = menu ? findProduct(menu, d.line.productId) : undefined
    if (p) { setSheet({ product: p, index: d.index }); return }
    setConfirm({ title: 'Remove this item?', message: 'It is no longer on the menu.', confirmLabel: 'Remove', danger: true,
      onConfirm: () => setLines((ls) => ls.filter((_, k) => k !== d.index)) })
  }

  const title = targetTitle(target, bill, tables)
  const tileNotice = !takesNewItems(target) ? (bill ? TAKEAWAY_ONE_ORDER : BILL_GONE) : null
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border bg-card p-2">
          <button type="button" onClick={back} disabled={sending} aria-label="Back to tables"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border-mid disabled:opacity-40"><ArrowLeft size={20} /></button>
          <label className="relative flex-1">
            <Search size={18} className="pointer-events-none absolute left-3 top-3 text-brown-muted" />
            <input className="h-11 w-full rounded-xl border border-border-mid pl-9 pr-3 text-base" placeholder="Search menu"
              value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <button type="button" onClick={() => setSoldOutMode((v) => !v)} aria-pressed={soldOutMode}
            className={`h-11 shrink-0 rounded-xl px-4 text-sm font-medium ${soldOutMode ? 'bg-red-600 text-white' : 'border border-border-mid text-brown-dark'}`}>
            {soldOutMode ? 'Sold out · Done' : 'Sold out'}
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <nav aria-label="Categories" className="w-[200px] shrink-0 space-y-1 overflow-y-auto border-r border-border bg-card p-2">
            {[null, ...(menu?.categories.map((c) => c.name) ?? [])].map((name) => {
              const on = !search && category === name
              return (
                <button key={name ?? '*'} type="button" onClick={() => { setCategory(name); setSearch('') }}
                  className={`min-h-12 w-full rounded-lg px-3 text-left text-sm font-medium ${on ? 'bg-brown-dark text-cream' : 'text-brown-dark hover:bg-cream'}`}>
                  {name ?? 'All'}
                </button>
              )
            })}
          </nav>
          <div className="flex min-w-0 flex-1 flex-col">
            {soldOutMode && <p className="m-2 rounded bg-red-50 p-2 text-sm text-red-700">Tap items to mark them sold out, or back on sale.</p>}
            {error && <p role="alert" className="m-2 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
            {notice && <p role="status" className="m-2 rounded bg-amber-50 p-2 text-sm text-amber-800">{notice}</p>}
            <div className="grid flex-1 grid-cols-4 content-start gap-2 overflow-y-auto p-3">
              {catalogs === null && catalogsError && (
                <p className="col-span-4 rounded bg-red-50 p-2 text-sm text-red-700">
                  Could not load the menu catalogs: {catalogsError}{' '}
                  <button type="button" className="min-h-11 px-3 underline" onClick={() => setCatalogsTry((n) => n + 1)}>Retry</button>
                </p>
              )}
              {noCatalog && (
                <p className="col-span-4 rounded bg-red-50 p-2 text-sm text-red-700">
                  {defaultProblem ?? noCatalogMessage(orderType)}
                  {catalogs.length > 0 && ' — or choose a catalog on the bill for this order.'}
                </p>
              )}
              {!menu && !error && !noCatalog && !(catalogs === null && catalogsError) && <p className="col-span-4 text-brown-muted">Loading menu…</p>}
              <ProductTiles products={products} windows={slots.windows} now={slots.now} soldOutMode={soldOutMode}
                onTap={(p, outOfSlot) => void tap(p, outOfSlot)} />
            </div>
          </div>
        </div>
      </div>

      <BillColumn
        title={title}
        billNo={bill?.bill_no ?? null}
        pax={shownPax(target, bill)}
        onPax={target.kind === 'table' ? () => setDialog({ kind: 'pax', purpose: 'set' }) : null}
        catalogName={current?.name ?? null}
        catalogIsExtra={!!current && !current.isDefault}
        onCatalog={catalogs && (catalogs.length > 1 || (catalogId === null && catalogs.length > 0)) && !sending && takesNewItems(target) ? () => setDialog({ kind: 'catalog' }) : null}
        view={view}
        loading={!!bill && items === null && !itemsError}
        loadError={itemsError}
        notice={tileNotice}
        onSentTap={(row) => setDialog({ kind: 'void_item', row })}
        onDraftTap={tapDraft}
        onActions={() => setDialog({ kind: 'actions' })}
        onSend={() => void send()}
        sendDisabled={sending || lines.length === 0}
        sending={sending}
        payLabel={view.totals ? `Payment ${formatSen(view.totals.totalSen)}` : 'Payment'}
        payDisabled={sending || gate === 'no_shift' || gate === 'empty' || (gate === 'ready' && !loaded)}
        payHint={gate === 'no_shift' ? NO_SHIFT_PAY : null}
        onPay={pay}
      />

      {sheet && (
        <ModifierSheet product={sheet.product} initial={sheet.index === null ? undefined : lines[sheet.index]}
          onCancel={() => setSheet(null)}
          onRemove={sheet.index === null ? undefined : () => { const i = sheet.index; setLines((ls) => ls.filter((_, k) => k !== i)); setSheet(null) }}
          onDone={(line) => { setLines((ls) => (sheet.index === null ? [...ls, line] : ls.map((x, k) => (k === sheet.index ? line : x)))); setSheet(null) }} />
      )}
      {dialog?.kind === 'actions' && (
        <BillActionsOverlay title={title} actions={actions} disabled={busy || sending} onPick={pickAction} onClose={() => setDialog(null)} />
      )}
      {bill && dialog?.kind === 'move' && (
        <MoveToGrid billNo={bill.bill_no} targets={moveTargets(bill, tables, bills, summaries)} busy={busy}
          onPick={pickMove} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'pax' && (
        <PaxDialog title={title} current={shownPax(target, bill)} onPick={pickPax} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'catalog' && (
        <PickerSheet title="Catalog" hint="This order is priced from the catalog you choose."
          options={(catalogs ?? []).map((c) => ({ id: c.id, label: c.name, detail: c.isDefault ? 'Default' : c.offered ? 'Additional' : 'No longer offered' }))}
          empty="No catalog is set for this branch." onClose={() => setDialog(null)}
          onPick={(id) => { setDialog(null); switchCatalog(id) }} />
      )}
      {bill && dialog?.kind === 'void_item' && (
        <ApprovalDialog branchId={branchId} action="void_item" title="Void item"
          summary={`${dialog.row.qty} × ${dialog.row.name} · ${formatSen(dialog.row.amountSen)} — the kitchen gets a VOID ticket`}
          onApprove={(a) => voidItem(dialog.row.item.id, a)} onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); setLocalKey((k) => k + 1); void onChanged() }} />
      )}
      {bill && dialog?.kind === 'void_bill' && (
        <ApprovalDialog branchId={branchId} action="void_bill" title="Void bill"
          summary={`Bill ${bill.bill_no} · ${view.liveSentCount} item${view.liveSentCount === 1 ? '' : 's'}${summaries.get(bill.id) ? ` · ${formatSen(summaries.get(bill.id)?.totalSen ?? 0)}` : ''} — every item is voided and the table is freed`}
          onApprove={(a) => voidBill(bill.id, a)} onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); void onChanged(); if (lines.length === 0) onBack() }} />
      )}
      {confirm && (
        <ConfirmDialog {...confirm} busy={busy} onCancel={() => setConfirm(null)}
          onConfirm={() => { const c = confirm; setConfirm(null); c.onConfirm() }} />
      )}
    </div>
  )
}
