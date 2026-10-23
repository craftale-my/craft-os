import { useEffect, useRef, useState } from 'react'
import { formatSen } from '../order/cart'
import type { OpenBillRow } from '../order/posApi'
import { formatRate, type BillTotals } from './bill'
import { checkoutBill, fetchBillTotals, fetchPaymentMethods, type CheckoutResult } from './checkoutApi'
import {
  changeSen, lineProblem, parseRinggit, payProblem, quickTenders, remainingSen, toPayments,
  type TenderLine, type TenderMethod,
} from './tender'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const looksOffline = (m: string) => /fetch|network|timeout|abort|signal/i.test(m)

export default function CheckoutSheet({ branchId, bill, title, onClose, onPaid }: {
  branchId: string
  bill: OpenBillRow
  title: string                 // "Table T3" or "Takeaway 261024-004"
  onClose: () => void
  onPaid: () => void            // after the cashier closes the success screen
}) {
  const [totals, setTotals] = useState<BillTotals | null>(null)
  const [methods, setMethods] = useState<TenderMethod[]>([])
  const [lines, setLines] = useState<TenderLine[]>([])
  const [method, setMethod] = useState<TenderMethod | null>(null)
  const [amountText, setAmountText] = useState('')
  const [tenderedText, setTenderedText] = useState('')
  const [reference, setReference] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<CheckoutResult | null>(null)
  // one id for this checkout: pressing Pay again after a lost reply can never charge twice
  const checkoutId = useRef(crypto.randomUUID())
  const keySeq = useRef(0)

  const loadTotals = async () => {
    try { setTotals(await fetchBillTotals(bill.id)) } catch (e) { setError(msg(e)) }
  }
  useEffect(() => {
    void loadTotals()
    fetchPaymentMethods(branchId, true)
      .then((rows) => setMethods(rows.map((m) => ({ id: m.id, name: m.name, kind: m.kind, needsReference: m.needs_reference }))))
      .catch((e) => setError(msg(e)))
  }, [bill.id, branchId]) // eslint-disable-line react-hooks/exhaustive-deps

  const total = totals?.totalSen ?? 0
  const left = remainingSen(total, lines)

  const pick = (m: TenderMethod) => {
    setMethod(m); setError(null); setTenderedText(''); setReference('')
    setAmountText((Math.max(0, left) / 100).toFixed(2))
  }

  const add = (tenderedOverride?: number | null) => {
    if (!method) return
    const amountSen = parseRinggit(amountText)
    if (amountSen === null) { setError('Enter the amount'); return }
    let tenderedSen: number | null = null
    if (method.kind === 'cash') {
      if (tenderedOverride !== undefined) tenderedSen = tenderedOverride
      else if (tenderedText.trim()) {
        tenderedSen = parseRinggit(tenderedText)
        if (tenderedSen === null) { setError('Enter the cash received'); return }
      }
    }
    const line = { method, amountSen, tenderedSen, reference: reference.trim() || null }
    const problem = lineProblem(line, left)
    if (problem) { setError(problem); return }
    setLines((ls) => [...ls, { ...line, key: String(++keySeq.current) }])
    setMethod(null); setAmountText(''); setTenderedText(''); setReference(''); setError(null)
  }

  const pay = async () => {
    if (!totals) return
    const problem = payProblem(total, lines)
    if (problem) { setError(problem); return }
    setBusy(true); setError(null)
    try {
      setResult(await checkoutBill(bill.id, toPayments(lines), checkoutId.current))
    } catch (e) {
      const m = msg(e)
      if (looksOffline(m)) setError('Not sure the payment went through (no reply). Press Pay again — it will not be charged twice.')
      else { setError(m); await loadTotals() }    // e.g. a QR order arrived meanwhile and the total changed
    } finally { setBusy(false) }
  }

  if (result) {
    return (
      <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40">
        <div className="w-full max-w-md rounded-2xl bg-card p-6 text-center">
          <div className="text-sm text-brown-muted">Bill {result.billNo} paid · {formatSen(result.totalSen)}</div>
          <div className="mt-4 text-sm">Change</div>
          <div className="text-5xl font-semibold">{formatSen(result.changeSen)}</div>
          <p className="mt-4 text-sm text-brown-muted">
            {result.receiptQueued ? 'Receipt printing…' : 'No receipt printer is set — choose one in POS settings.'}
          </p>
          <button onClick={onPaid} className="mt-6 w-full rounded-xl bg-brown-btn py-3 text-white hover:bg-brown-btn-hover">Done</button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-30 grid grid-cols-[1fr_400px] bg-cream">
      <div className="flex flex-col overflow-hidden p-4">
        <div className="mb-3 flex items-center gap-3">
          <button onClick={onClose} disabled={busy} className="rounded-lg border border-border px-3 py-2">← Back</button>
          <div className="text-lg font-semibold">Checkout · {title} · Bill {bill.bill_no}</div>
        </div>
        <div className="text-xs font-semibold uppercase text-brown-muted">Payment method</div>
        <div className="mt-1 grid grid-cols-3 gap-2">
          {methods.map((m) => (
            <button key={m.id} onClick={() => pick(m)} disabled={left <= 0 || busy}
              className={`min-h-16 rounded-xl border p-3 text-left disabled:opacity-40 ${method?.id === m.id ? 'border-brown-btn bg-brown-btn text-white' : 'border-border bg-card'}`}>
              <div className="font-medium">{m.name}</div>
              <div className="text-xs opacity-75">{m.kind}</div>
            </button>
          ))}
          {methods.length === 0 && <p className="text-sm text-brown-muted">No payment methods — add them in POS settings.</p>}
        </div>
        {method && (
          <div className="mt-4 space-y-3 rounded-xl border border-border bg-card p-4">
            <label className="block text-sm">Amount (RM)
              <input inputMode="decimal" className="ml-2 w-32 rounded border border-border p-2" value={amountText} onChange={(e) => setAmountText(e.target.value)} />
            </label>
            {method.kind === 'cash' && (
              <>
                <label className="block text-sm">Cash received (RM)
                  <input inputMode="decimal" className="ml-2 w-32 rounded border border-border p-2" placeholder="exact" value={tenderedText} onChange={(e) => setTenderedText(e.target.value)} />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => add(null)} className="rounded-lg border border-border px-4 py-3">Exact</button>
                  {quickTenders(parseRinggit(amountText) ?? left).map((n) => (
                    <button key={n} onClick={() => add(n)} className="rounded-lg border border-border px-4 py-3">RM {n / 100}</button>
                  ))}
                </div>
              </>
            )}
            {method.needsReference && (
              <label className="block text-sm">Reference
                <input className="ml-2 w-48 rounded border border-border p-2" value={reference} onChange={(e) => setReference(e.target.value)} />
              </label>
            )}
            <button onClick={() => add()} className="rounded-lg bg-brown-btn px-4 py-2 text-white">Add {method.name}</button>
          </div>
        )}
        {error && <p className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      </div>

      <div className="flex flex-col border-l border-border bg-card p-4 text-sm">
        {!totals ? <p className="text-brown-muted">Loading totals…</p> : (
          <div className="space-y-1">
            <div className="flex justify-between"><span>Subtotal</span><span>{formatSen(totals.subtotalSen)}</span></div>
            {totals.serviceChargeGroups.map((g) => (
              <div key={`sc${g.rateBp}`} className="flex justify-between"><span>Service charge ({formatRate(g.rateBp)})</span><span>{formatSen(g.amountSen)}</span></div>
            ))}
            {totals.sstGroups.map((g) => (
              <div key={`sst${g.rateBp}`} className="flex justify-between"><span>SST ({formatRate(g.rateBp)})</span><span>{formatSen(g.amountSen)}</span></div>
            ))}
            {totals.takeawayFeeSen > 0 && <div className="flex justify-between"><span>Takeaway packaging</span><span>{formatSen(totals.takeawayFeeSen)}</span></div>}
            <div className="flex justify-between"><span>Rounding</span><span>{formatSen(totals.roundingSen)}</span></div>
            <div className="flex justify-between border-t border-border pt-2 text-lg font-semibold"><span>Total</span><span>{formatSen(total)}</span></div>
          </div>
        )}
        <div className="mt-4 flex-1 space-y-1 overflow-y-auto">
          {lines.map((l) => (
            <div key={l.key} className="flex items-center justify-between rounded bg-cream p-2">
              <span>{l.method.name}{l.reference ? ` · ${l.reference}` : ''}{l.tenderedSen !== null ? ` · received ${formatSen(l.tenderedSen)}` : ''}</span>
              <span className="flex items-center gap-2">{formatSen(l.amountSen)}
                <button disabled={busy} className="text-xs text-red-700 underline" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>remove</button>
              </span>
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-between"><span>Left to pay</span><b>{formatSen(Math.max(0, left))}</b></div>
        <div className="flex justify-between"><span>Change</span><b>{formatSen(changeSen(lines))}</b></div>
        <button disabled={busy || !totals || left !== 0} onClick={() => void pay()}
          className="mt-3 w-full rounded-xl bg-brown-btn py-4 text-lg text-white hover:bg-brown-btn-hover disabled:opacity-40">
          {busy ? 'Paying…' : `Pay ${formatSen(total)}`}
        </button>
      </div>
    </div>
  )
}
