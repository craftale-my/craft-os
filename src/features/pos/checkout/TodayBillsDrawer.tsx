import { useEffect, useRef, useState } from 'react'
import { formatSen } from '../order/cart'
import { fetchClosedBillsSince, fetchRefundableMethods, refundBill, reprintReceipt, type ClosedBillRow } from './checkoutApi'
import ApprovalDialog from './ApprovalDialog'
import { mytDayStartIso, refundChoices, refundDoneNote, refundableSen, STATUS_LABEL, type RefundChoice } from './todayBills'
import { parseRinggit } from './tender'
import type { RefundResult } from './rpcResult'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kuala_Lumpur' })
const where = (b: ClosedBillRow) => (b.dining_tables ? `Table ${b.dining_tables.label}` : b.order_type === 'takeaway' ? 'Takeaway' : '—')

/** Today's closed bills (Malaysia day): reprint a receipt, refund a paid bill. */
export default function TodayBillsDrawer({ branchId, onClose }: { branchId: string; onClose: () => void }) {
  const [bills, setBills] = useState<ClosedBillRow[] | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [refunding, setRefunding] = useState<ClosedBillRow | null>(null)
  const [amountText, setAmountText] = useState('')
  const [methodId, setMethodId] = useState('')
  // Refunds go back the original route: the methods this bill was paid with that
  // still have something left (null while loading).
  const [choices, setChoices] = useState<RefundChoice[] | null>(null)
  const [choicesError, setChoicesError] = useState<string | null>(null)
  const refundId = useRef<string>('')
  // After the first Approve of a refund dialog the amount and method are fixed: a
  // retry after a lost reply resends the SAME refund (same refundId), never a new one.
  const [refundLocked, setRefundLocked] = useState(false)
  const refundResult = useRef<RefundResult | null>(null)
  const reprintingRef = useRef(new Set<string>())   // synchronous guard: a fast double tap must not print twice
  const [reprinting, setReprinting] = useState<ReadonlySet<string>>(new Set())

  const load = async () => {
    try { setBills(await fetchClosedBillsSince(branchId, mytDayStartIso(Date.now()))) } catch (e) { setNote(msg(e)) }
  }
  useEffect(() => { void load() }, [branchId]) // eslint-disable-line react-hooks/exhaustive-deps

  const reprint = async (b: ClosedBillRow) => {
    if (reprintingRef.current.has(b.id)) return
    reprintingRef.current.add(b.id); setReprinting(new Set(reprintingRef.current))
    try { await reprintReceipt(b.id); setNote(`Receipt ${b.bill_no} sent to the printer`) } catch (e) { setNote(msg(e)) }
    finally { reprintingRef.current.delete(b.id); setReprinting(new Set(reprintingRef.current)) }
  }

  const startRefund = (b: ClosedBillRow) => {
    const id = crypto.randomUUID()                  // one id per refund: a retry can never refund twice
    refundId.current = id
    setAmountText('')
    setMethodId('')
    setChoices(null)
    setChoicesError(null)
    setRefundLocked(false)
    refundResult.current = null
    setRefunding(b)
    fetchRefundableMethods(b.id).then((rows) => {
      if (refundId.current !== id) return           // the dialog was closed or reopened meanwhile
      const c = refundChoices(rows, refundableSen(b))
      setChoices(c)
      setMethodId(c[0]?.methodId ?? '')
      setAmountText(c[0] ? (c[0].maxSen / 100).toFixed(2) : '')
    }, (e) => { if (refundId.current === id) setChoicesError(msg(e)) })
  }

  // Before the first Approve, choosing another method resets the amount to what it can take.
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

  return (
    <>
      <div className="fixed inset-0 z-30 flex justify-end bg-black/30" onClick={onClose}>
        <div className="flex h-full w-full max-w-xl flex-col bg-card" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-border p-4">
            <h2 className="text-lg font-semibold">Today's bills</h2>
            <div className="flex gap-2">
              <button onClick={() => void load()} className="rounded border border-border px-3 py-1 text-sm">Refresh</button>
              <button onClick={onClose} className="rounded border border-border px-3 py-1 text-sm">Close</button>
            </div>
          </div>
          {note && <p className="m-3 rounded bg-amber-50 p-2 text-sm text-amber-800">{note}</p>}
          <div className="flex-1 overflow-y-auto p-3 text-sm">
            {bills === null && <p className="text-brown-muted">Loading…</p>}
            {bills?.length === 0 && <p className="text-brown-muted">No closed bills yet today.</p>}
            {bills?.map((b) => (
              <div key={b.id} className="mb-2 flex items-center justify-between rounded-lg border border-border p-2">
                <div>
                  <div className="font-medium">{b.bill_no} · {where(b)}</div>
                  <div className="text-xs text-brown-muted">
                    {time(b.closed_at)} · {STATUS_LABEL[b.status] ?? b.status}
                    {b.total_sen !== null && ` · ${formatSen(b.total_sen)}`}
                    {b.refunded_sen > 0 && ` · refunded ${formatSen(b.refunded_sen)}`}
                  </div>
                </div>
                {b.status === 'paid' && (
                  <div className="flex gap-2">
                    <button onClick={() => void reprint(b)} disabled={reprinting.has(b.id)}
                      className="rounded border border-border px-2 py-1 text-xs disabled:opacity-40">{reprinting.has(b.id) ? 'Printing…' : 'Reprint receipt'}</button>
                    <button onClick={() => startRefund(b)} disabled={refundableSen(b) === 0}
                      className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 disabled:opacity-40">Refund</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
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
                    <select className="ml-2 rounded border border-border p-2 disabled:opacity-60" value={methodId}
                      disabled={refundLocked} onChange={(e) => chooseMethod(e.target.value)}>
                      {choices.map((c) => <option key={c.methodId} value={c.methodId}>{c.label}</option>)}
                    </select>
                  </label>
                  <label className="block">Amount (RM)
                    <input inputMode="decimal" className="ml-2 w-32 rounded border border-border p-2 disabled:opacity-60" value={amountText}
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
            setRefunding(null); void load()
          }} />
      )}
    </>
  )
}
