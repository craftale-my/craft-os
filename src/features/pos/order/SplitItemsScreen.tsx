// src/features/pos/order/SplitItemsScreen.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Minus, Plus } from 'lucide-react'
import { formatSen } from './cart'
import type { BillSummary } from './billSummaries'
import { NO_SHIFT_PAY } from './billView'
import MoveToGrid from './MoveToGrid'
import { ITEM_MOVE_HINT, itemMoveTargets, moveTargets, type MoveTarget } from './moveTargets'
import type { OrderTarget } from './orderTarget'
import { fetchBillItems, moveItems, type BillItemRow, type OpenBillRow, type TableRow } from './posApi'
import {
  MOVE_NEEDS_NO_DISCOUNT, SPLIT_OFFLINE, guestLabels, guestPicked, toggleGuest, everythingSelected, movedNotice, ofLabel, pickedUnits, prune, selectAll, setQty,
  splitLines, splitTitle, toSplitItems, type Picked, type SplitItem,
} from './splitSelection'
import { mergeBills, moveBill, splitTotals } from '../checkout/checkoutApi'
import { storedDiscount } from '../checkout/discounts'
import ConfirmDialog, { type ConfirmRequest } from '../shell/ConfirmDialog'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** The footer asks the server this long after the last change. */
export const PREVIEW_DEBOUNCE_MS = 300
const BILL_GONE = 'This bill is no longer open.'

type Preview = { kind: 'none' } | { kind: 'loading' } | { kind: 'total'; sen: number } | { kind: 'error'; message: string }

/** Split / Move items (docs/superpowers/specs/2026-11-16-pos-split-bill-design.md §3.2): every live
 *  line of the bill — a tick box for one unit, a stepper for more — with Select all / Clear, the
 *  part's total from the server after each change (pos_split_totals, debounced), Pay selected and
 *  Move to table. Every unit picked runs the whole-bill flows instead (normal Payment, move / merge). */
export default function SplitItemsScreen({
  bill, title, tables, bills, summaries, refreshKey, online, shiftOpen, initialPicked,
  onBack, onPay, onPayWhole, onMoved, onWholeMoved,
}: {
  bill: OpenBillRow
  title: string                              // "Table T5", "Takeaway 261116-004"
  tables: TableRow[]
  bills: OpenBillRow[]                       // the branch's open bills (PosTill keeps them fresh)
  summaries: ReadonlyMap<string, BillSummary>
  refreshKey: number                         // bumped on every bills event, order and 15 s sweep
  online: boolean
  shiftOpen: boolean | null
  initialPicked?: Picked                     // the selection Payment's Cancel kept
  onBack: () => void
  onPay: (items: SplitItem[], picked: Picked) => void
  onPayWhole: () => void
  onMoved: (notice: string) => void
  onWholeMoved: (to: OrderTarget) => void
}) {
  const [items, setItems] = useState<BillItemRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [localKey, setLocalKey] = useState(0)
  const [picked, setPicked] = useState<Picked>(initialPicked ?? {})
  const [preview, setPreview] = useState<Preview>({ kind: 'none' })
  const [moving, setMoving] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const previewSeq = useRef(0)
  const previewKey = useRef<string | null>(null)   // the selection the footer currently shows or is fetching

  useEffect(() => {
    let live = true
    fetchBillItems(bill.id).then(
      (rows) => { if (live) { setItems(rows); setLoadError(null) } },
      (e) => { if (live) setLoadError(msg(e)) },
    )
    return () => { live = false }
  }, [bill.id, refreshKey, localKey])
  const lines = useMemo(() => splitLines(items ?? []), [items])
  const guests = useMemo(() => guestLabels(lines), [lines])
  useEffect(() => { if (items) setPicked((p) => prune(p, lines)) }, [items, lines])

  const current = bills.find((b) => b.id === bill.id) ?? null
  const gone = current === null
  const hasDiscount = storedDiscount(current ?? bill) !== null
  const units = pickedUnits(picked)
  const all = everythingSelected(picked, lines)
  const chosen = useMemo(() => toSplitItems(picked, lines), [picked, lines])
  const chosenKey = JSON.stringify(chosen)

  useEffect(() => {
    const seq = ++previewSeq.current
    if (chosen.length === 0 || all || !online) { previewKey.current = null; setPreview({ kind: 'none' }); return }
    // Only a bills event / sweep (refreshKey) re-asks for the same selection: keep the total on screen and
    // Pay enabled meanwhile, so a tap is not lost. A changed selection shows "…" and turns Pay off.
    const key = `${bill.id}|${chosenKey}`
    if (previewKey.current !== key) { previewKey.current = key; setPreview({ kind: 'loading' }) }
    const timer = setTimeout(() => {
      splitTotals(bill.id, chosen).then(
        (t) => { if (seq === previewSeq.current) setPreview({ kind: 'total', sen: t.totalSen }) },
        (e) => { if (seq === previewSeq.current) setPreview({ kind: 'error', message: msg(e) }) },
      )
    }, PREVIEW_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [bill.id, chosenKey, all, online, refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true); setError(null)
    try { await fn() } catch (e) { setError(msg(e)); setMoving(false); setLocalKey((k) => k + 1) } finally { busyRef.current = false; setBusy(false) }
  }

  const pay = () => { if (all) onPayWhole(); else onPay(chosen, picked) }

  const targets = all
    ? moveTargets(current ?? bill, tables, bills, summaries, hasDiscount)
    : itemMoveTargets(current ?? bill, tables, bills, summaries)
  const pickTarget = (t: MoveTarget) => {
    if (t.kind === 'refused' || busyRef.current) return
    const label = t.label
    if (!all) {
      const tableId = t.tableId
      if (tableId === null) return
      void run(async () => {
        const r = await moveItems(bill.id, chosen, tableId)
        onMoved(movedNotice(r.movedUnits, label))
      })
      return
    }
    if (t.kind === 'move') {
      const to = t.tableId
      void run(async () => { await moveBill(bill.id, to); onWholeMoved({ kind: 'table', tableId: to, pax: null }) })
      return
    }
    const intoBillId = t.intoBillId
    const into: OrderTarget = t.tableId !== null ? { kind: 'table', tableId: t.tableId, pax: null } : { kind: 'takeaway', billId: intoBillId }
    setMoving(false)
    setConfirm({
      title: `Merge into ${label}?`,
      message: `Every item of bill ${bill.bill_no} moves onto bill ${t.intoBillNo}, and this bill closes.`,
      confirmLabel: 'Merge',
      onConfirm: () => void run(async () => { await mergeBills(bill.id, intoBillId); onWholeMoved(into) }),
    })
  }

  const wholeSen = summaries.get(bill.id)?.totalSen
  const footer = units === 0 ? '—'
    : all ? (wholeSen === undefined ? '…' : formatSen(wholeSen))
    : preview.kind === 'total' ? formatSen(preview.sen)
    : preview.kind === 'error' ? '' : '…'
  const blocked = units === 0 || gone || busy || !online
  const payDisabled = blocked || shiftOpen !== true || (!all && preview.kind !== 'total')
  const moveDisabled = blocked || hasDiscount
  const stepBtn = 'flex h-11 w-11 items-center justify-center rounded-lg border border-border-mid disabled:opacity-40'

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-cream">
      <header className="flex items-center gap-3 border-b border-border bg-card p-3">
        <button type="button" onClick={onBack} disabled={busy} aria-label="Back to the bill" className={stepBtn}><ArrowLeft size={20} /></button>
        <h2 className="flex-1 truncate text-lg font-semibold text-brown-dark">{splitTitle(title)}</h2>
        <span className="text-sm text-brown-muted">Bill {bill.bill_no}</span>
        <button type="button" onClick={() => setPicked(selectAll(lines))} disabled={busy || lines.length === 0}
          className="min-h-11 rounded-xl border border-border-mid px-4 text-sm font-medium text-brown-dark disabled:opacity-40">Select all</button>
        <button type="button" onClick={() => setPicked({})} disabled={busy || units === 0}
          className="min-h-11 rounded-xl border border-border-mid px-4 text-sm font-medium text-brown-dark disabled:opacity-40">Clear</button>
      </header>
      {guests.length >= 2 && (
        <div role="group" aria-label="Pick by guest" className="flex gap-2 overflow-x-auto border-b border-border bg-card px-3 py-2">
          {guests.map((g) => {
            const on = guestPicked(picked, lines, g)
            return (
              <button key={g} type="button" aria-pressed={on} disabled={busy}
                onClick={() => setPicked((p) => toggleGuest(p, lines, g))}
                className={`min-h-11 shrink-0 rounded-full border-2 px-4 text-sm font-medium disabled:opacity-40 ${on ? 'border-brown-btn bg-brown-btn text-white' : 'border-border-mid text-brown-dark'}`}>
                {g}
              </button>
            )
          })}
        </div>
      )}
      {gone && <p role="alert" className="m-3 rounded bg-red-50 p-2 text-sm text-red-700">{BILL_GONE}</p>}
      {loadError && <p role="alert" className="m-3 rounded bg-red-50 p-2 text-sm text-red-700">{loadError}</p>}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {items === null && !loadError && <p className="text-brown-muted">Loading…</p>}
        {lines.map((l) => {
          const k = picked[l.id] ?? 0
          return (
            <div key={l.id} className={`flex items-center gap-3 rounded-xl border-2 bg-card p-3 ${k > 0 ? 'border-brown-btn' : 'border-border'}`}>
              {l.qty === 1 ? (
                <input type="checkbox" aria-label={l.name} className="h-7 w-7" checked={k === 1} disabled={busy}
                  onChange={() => setPicked((p) => setQty(p, lines, l.id, k === 1 ? 0 : 1))} />
              ) : (
                <div className="flex items-center gap-2">
                  <button type="button" aria-label={`Fewer ${l.name}`} disabled={busy || k === 0} className={stepBtn}
                    onClick={() => setPicked((p) => setQty(p, lines, l.id, k - 1))}><Minus size={18} /></button>
                  <span className="w-16 text-center text-sm font-medium tabular-nums">{ofLabel(k, l.qty)}</span>
                  <button type="button" aria-label={`More ${l.name}`} disabled={busy || k === l.qty} className={stepBtn}
                    onClick={() => setPicked((p) => setQty(p, lines, l.id, k + 1))}><Plus size={18} /></button>
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="font-medium text-brown-dark">{l.qty} × {l.name}</div>
                {l.mods.map((m, i) => <div key={i} className="pl-4 text-xs text-brown-muted">+ {m}</div>)}
                {l.note && <div className="pl-4 text-xs italic text-brown-muted">{l.note}</div>}
              </div>
              <span className="tabular-nums">{formatSen(l.amountSen)}</span>
            </div>
          )
        })}
      </div>
      <footer className="border-t border-border bg-card p-3">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-brown-muted">Selected · {units} item{units === 1 ? '' : 's'}</span>
          <span aria-label="Selected total" className="text-2xl font-semibold tabular-nums text-brown-dark">{footer}</span>
        </div>
        {preview.kind === 'error' && <p role="alert" className="mt-2 rounded bg-red-50 p-2 text-sm text-red-700">{preview.message}</p>}
        {error && <p role="alert" className="mt-2 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
        {!online && <p className="mt-2 text-sm text-amber-800">{SPLIT_OFFLINE}</p>}
        {online && shiftOpen !== true && <p className="mt-2 text-sm text-amber-800">{NO_SHIFT_PAY}</p>}
        {hasDiscount && <p className="mt-2 text-sm text-amber-800">{MOVE_NEEDS_NO_DISCOUNT}</p>}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setMoving(true)} disabled={moveDisabled}
            className="min-h-16 rounded-xl border border-border-mid text-lg font-semibold text-brown-dark disabled:opacity-40">Move to table</button>
          <button type="button" onClick={pay} disabled={payDisabled}
            className="min-h-16 rounded-xl bg-brown-btn text-lg font-semibold text-white hover:bg-brown-btn-hover disabled:opacity-40">Pay selected</button>
        </div>
      </footer>
      {moving && (
        <MoveToGrid billNo={bill.bill_no} targets={targets} busy={busy} hint={all ? undefined : ITEM_MOVE_HINT}
          onPick={pickTarget} onClose={() => setMoving(false)} />
      )}
      {confirm && (
        <ConfirmDialog {...confirm} busy={busy} onCancel={() => setConfirm(null)}
          onConfirm={() => { const c = confirm; setConfirm(null); c.onConfirm() }} />
      )}
    </div>
  )
}
