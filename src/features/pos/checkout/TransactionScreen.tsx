// src/features/pos/checkout/TransactionScreen.tsx
import { useEffect, useRef, useState } from 'react'
import { RefreshCw, Search } from 'lucide-react'
import { formatSen } from '../order/cart'
import { fetchBillItems, type BillItemRow } from '../order/posApi'
import {
  fetchClosedBillDetail, fetchClosedBillsSince, fetchRefundableMethods, refundBill, reprintReceipt,
  type ClosedBillDetail, type ClosedBillRow,
} from './checkoutApi'
import ApprovalDialog from './ApprovalDialog'
import CheckoutTotals from './CheckoutTotals'
import { mytDayStartIso, refundChoices, refundDoneNote, refundableSen, type RefundChoice } from './todayBills'
import { filterTransactions, mytDateLabel, TX_FILTERS, txStatusLabel, txWhere, type TxFilter } from './transactions'
import { parseRinggit } from './tender'
import type { RefundResult } from './rpcResult'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kuala_Lumpur' })

/** Transaction (spec §5), replacing the Today's bills drawer with the same data and actions:
 *  today's closed bills (Malaysia day) on the left with search and a status filter; the chosen bill
 *  on the right with its items, totals, payments and refunds, Reprint receipt and Refund. The
 *  reprint guard and the refund flow (one refund id per dialog, amount and method fixed after the
 *  first Approve, refunds back the way the bill was paid) are the drawer's, unchanged. */
export default function TransactionScreen({ branchId }: { branchId: string }) {
  const [bills, setBills] = useState<ClosedBillRow[] | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [filter, setFilter] = useState<TxFilter>('all')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ items: BillItemRow[]; d: ClosedBillDetail } | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailKey, setDetailKey] = useState(0)
  const detailSeq = useRef(0)
  // ── the drawer's refund and reprint state, unchanged ──
  const [refunding, setRefunding] = useState<ClosedBillRow | null>(null)
  const [amountText, setAmountText] = useState('')
  const [methodId, setMethodId] = useState('')
  const [choices, setChoices] = useState<RefundChoice[] | null>(null)
  const [choicesError, setChoicesError] = useState<string | null>(null)
  const refundId = useRef<string>('')
  const [refundLocked, setRefundLocked] = useState(false)
  const refundResult = useRef<RefundResult | null>(null)
  const reprintingRef = useRef(new Set<string>())
  const [reprinting, setReprinting] = useState<ReadonlySet<string>>(new Set())

  const load = async () => {
    try { setBills(await fetchClosedBillsSince(branchId, mytDayStartIso(Date.now()))) } catch (e) { setNote(msg(e)) }
  }
  useEffect(() => { void load() }, [branchId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedId) return
    const id = ++detailSeq.current                  // a slow reply for a bill no longer chosen is dropped
    setDetail(null); setDetailError(null)
    Promise.all([fetchBillItems(selectedId), fetchClosedBillDetail(selectedId)]).then(
      ([items, d]) => { if (id === detailSeq.current) setDetail({ items, d }) },
      (e) => { if (id === detailSeq.current) setDetailError(msg(e)) },
    )
  }, [selectedId, detailKey])

  const reprint = async (b: ClosedBillRow) => {
    if (reprintingRef.current.has(b.id)) return
    reprintingRef.current.add(b.id); setReprinting(new Set(reprintingRef.current))
    try { await reprintReceipt(b.id); setNote(`Receipt ${b.bill_no} sent to the printer`) } catch (e) { setNote(msg(e)) }
    finally { reprintingRef.current.delete(b.id); setReprinting(new Set(reprintingRef.current)) }
  }

  const startRefund = (b: ClosedBillRow) => {
    const id = crypto.randomUUID()                  // one id per refund: a retry can never refund twice
    refundId.current = id
    setAmountText(''); setMethodId(''); setChoices(null); setChoicesError(null); setRefundLocked(false)
    refundResult.current = null
    setRefunding(b)
    fetchRefundableMethods(b.id).then((rows) => {
      if (refundId.current !== id) return
      const c = refundChoices(rows, refundableSen(b))
      setChoices(c)
      setMethodId(c[0]?.methodId ?? '')
      setAmountText(c[0] ? (c[0].maxSen / 100).toFixed(2) : '')
    }, (e) => { if (refundId.current === id) setChoicesError(msg(e)) })
  }
  const chooseMethod = (id: string) => {
    if (refundLocked) return
    setMethodId(id)
    const c = choices?.find((x) => x.methodId === id)
    if (c) setAmountText((c.maxSen / 100).toFixed(2))
  }
  const chosen = choices?.find((c) => c.methodId === methodId) ?? null
  const amountSen = parseRinggit(amountText)
  const refundProblem = !refunding ? null
    : choicesError ? `Could not load how this bill was paid: ${choicesError}`
    : choices === null ? 'Loading how this bill was paid…'
    : choices.length === 0 ? 'Nothing left to refund on this bill.'
    : !chosen ? 'Choose how the money goes back'
    : amountSen === null || amountSen <= 0 ? 'Enter the refund amount'
    : amountSen > chosen.maxSen ? `At most ${formatSen(chosen.maxSen)} can go back this way`
    : null

  const shown = bills ? filterTransactions(bills, filter, search) : []
  const selected = bills?.find((b) => b.id === selectedId) ?? null
  return (
    <div className="flex min-h-0 flex-1">
      <section aria-label="Bills" className="flex w-[440px] shrink-0 flex-col border-r border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border p-2">
          <label className="relative flex-1">
            <Search size={18} className="pointer-events-none absolute left-3 top-3 text-brown-muted" />
            <input className="h-11 w-full rounded-xl border border-border-mid pl-9 pr-3" placeholder="Bill no or table"
              value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <button type="button" onClick={() => void load()} aria-label="Refresh"
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-border-mid"><RefreshCw size={18} /></button>
        </div>
        <div className="flex items-center justify-between px-3 pt-2 text-sm">
          <span className="font-semibold text-brown-dark">Today · {mytDateLabel(Date.now())}</span>
        </div>
        <div className="flex gap-1 overflow-x-auto p-2">
          {TX_FILTERS.map((f) => (
            <button key={f.id} type="button" onClick={() => setFilter(f.id)} aria-pressed={filter === f.id}
              className={`min-h-11 whitespace-nowrap rounded-lg px-3 text-sm ${filter === f.id ? 'bg-brown-dark text-cream' : 'border border-border-mid text-brown-dark'}`}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto p-2 text-sm">
          {bills === null && <p className="text-brown-muted">Loading…</p>}
          {bills !== null && shown.length === 0 && <p className="text-brown-muted">No bills.</p>}
          {shown.map((b) => (
            <button key={b.id} type="button" onClick={() => setSelectedId(b.id)}
              className={`mb-1 flex min-h-14 w-full items-center justify-between rounded-lg px-3 text-left ${selectedId === b.id ? 'bg-brown-btn text-white' : 'hover:bg-cream'}`}>
              <span>
                <span className="block font-medium">{b.bill_no} · {txWhere(b)}</span>
                <span className="block text-xs opacity-80">{time(b.closed_at)} · {txStatusLabel(b)}</span>
              </span>
              <span className="tabular-nums">{b.total_sen !== null ? formatSen(b.total_sen) : '—'}</span>
            </button>
          ))}
        </div>
      </section>

      <section aria-label="Bill detail" className="flex min-w-0 flex-1 flex-col p-4 text-sm">
        {note && <p className="mb-3 rounded bg-amber-50 p-2 text-amber-800">{note}</p>}
        {!selected && <p className="text-brown-muted">Choose a bill on the left.</p>}
        {selected && (
          <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-brown-dark">{selected.bill_no} · {txWhere(selected)}</div>
                <div className="text-xs text-brown-muted">{time(selected.closed_at)} · {txStatusLabel(selected)}</div>
              </div>
              {selected.status === 'paid' && (
                <div className="flex gap-2">
                  <button type="button" onClick={() => void reprint(selected)} disabled={reprinting.has(selected.id)}
                    className="min-h-12 rounded-xl border border-border-mid px-4 disabled:opacity-40">{reprinting.has(selected.id) ? 'Printing…' : 'Reprint receipt'}</button>
                  <button type="button" onClick={() => startRefund(selected)} disabled={refundableSen(selected) === 0}
                    className="min-h-12 rounded-xl border border-red-300 px-4 text-red-700 disabled:opacity-40">Refund</button>
                </div>
              )}
            </div>
            <div className="mt-3 flex-1 overflow-y-auto rounded-xl bg-card p-3">
              {detailError && <p role="alert" className="rounded bg-red-50 p-2 text-red-700">{detailError} <button type="button" className="min-h-11 px-2 underline" onClick={() => setDetailKey((k) => k + 1)}>Try again</button></p>}
              {!detail && !detailError && <p className="text-brown-muted">Loading…</p>}
              {detail && (
                <div className="space-y-3">
                  {detail.d.mergedIntoBillNo && <p className="text-brown-muted">Merged into bill {detail.d.mergedIntoBillNo}.</p>}
                  <div className="space-y-1">
                    {detail.items.map((i) => (
                      <div key={i.id} className={`flex justify-between gap-2 ${i.voided_at ? 'line-through opacity-50' : ''}`}>
                        <span>
                          {i.qty} × {i.name_snapshot}
                          {i.modifiers_snapshot.map((m, k) => <span key={k} className="block pl-4 text-xs text-brown-muted">+ {m.name}</span>)}
                          {i.note && <span className="block pl-4 text-xs italic text-brown-muted">* {i.note}</span>}
                        </span>
                        <span className="tabular-nums">{formatSen(i.unit_price_sen * i.qty)}</span>
                      </div>
                    ))}
                    {detail.items.length === 0 && <p className="text-brown-muted">No items on this bill.</p>}
                  </div>
                  {detail.d.totals && <div className="border-t border-border pt-3"><CheckoutTotals totals={detail.d.totals} /></div>}
                  {detail.d.payments.length > 0 && (
                    <div className="border-t border-border pt-3">
                      <div className="mb-1 text-xs font-semibold uppercase text-brown-muted">Payments</div>
                      {detail.d.payments.map((p) => (
                        <div key={p.id} className="flex justify-between">
                          <span>{p.method_name}{p.reference ? ` · ${p.reference}` : ''}{p.tendered_sen !== null ? ` · received ${formatSen(p.tendered_sen)}, change ${formatSen(p.change_sen)}` : ''}</span>
                          <span className="tabular-nums">{formatSen(p.amount_sen)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {detail.d.refunds.length > 0 && (
                    <div className="border-t border-border pt-3">
                      <div className="mb-1 text-xs font-semibold uppercase text-brown-muted">Refunds</div>
                      {detail.d.refunds.map((r) => (
                        <div key={r.id} className="flex justify-between text-red-700">
                          <span>{time(r.created_at)} · {r.method_name}{r.reason ? ` · ${r.reason}` : ''}</span>
                          <span className="tabular-nums">−{formatSen(r.amount_sen)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </section>

      {refunding && (
        <ApprovalDialog branchId={branchId} action="refund" title={`Refund bill ${refunding.bill_no}`}
          summary={`Paid ${formatSen(refunding.total_sen ?? 0)}${refunding.refunded_sen ? `, already refunded ${formatSen(refunding.refunded_sen)}` : ''}`}
          extra={
            <div className="space-y-2 text-sm">
              {choicesError && <p className="rounded bg-red-50 p-2 text-red-700">Could not load how this bill was paid: {choicesError}</p>}
              {!choicesError && choices === null && <p className="text-brown-muted">Loading how this bill was paid…</p>}
              {choices?.length === 0 && <p className="rounded bg-amber-50 p-2 text-amber-800">Nothing left to refund on this bill.</p>}
              {choices && choices.length > 0 && (
                <>
                  <label className="block">Paid back by
                    <select className="ml-2 min-h-11 rounded border border-border p-2 disabled:opacity-60" value={methodId}
                      disabled={refundLocked} onChange={(e) => chooseMethod(e.target.value)}>
                      {choices.map((c) => <option key={c.methodId} value={c.methodId}>{c.label}</option>)}
                    </select>
                  </label>
                  <label className="block">Amount (RM)
                    <input inputMode="decimal" className="ml-2 min-h-11 w-32 rounded border border-border p-2 disabled:opacity-60" value={amountText}
                      disabled={refundLocked} onChange={(e) => setAmountText(e.target.value)} />
                  </label>
                  <p className="text-xs text-brown-muted">Refunds go back the way the bill was paid.</p>
                </>
              )}
              {refundLocked && <p className="text-xs text-brown-muted">Amount and method are fixed for this refund. To refund a different amount, close and reopen.</p>}
            </div>
          }
          extraProblem={refundProblem}
          approveDisabled={!refundLocked && (choices === null || choices.length === 0)}
          onApprove={async (a) => {
            setRefundLocked(true)
            refundResult.current = await refundBill(refundId.current, refunding.id, amountSen ?? 0, methodId, a)
          }}
          onClose={() => { refundId.current = ''; setRefunding(null) }}
          onDone={() => {
            const r = refundResult.current
            setNote(r ? refundDoneNote(r, refunding.bill_no) : `Refund on ${refunding.bill_no} done`)
            setRefunding(null); setDetailKey((k) => k + 1); void load()
          }} />
      )}
    </div>
  )
}
