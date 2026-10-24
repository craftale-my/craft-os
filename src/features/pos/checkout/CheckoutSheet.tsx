import { useEffect, useRef, useState } from 'react'
import { formatSen } from '../order/cart'
import type { OpenBillRow } from '../order/posApi'
import type { BillTotals } from './bill'
import { checkoutBill, fetchCheckoutState, fetchPaymentMethods, type CheckoutResult } from './checkoutApi'
import CheckoutTotals from './CheckoutTotals'
import { followBill, type FollowAction } from './follow'
import { CHECKED_OPEN, UNSURE, checkoutIds, linesLocked, newPaySession, nextPay, type PayEvent, type PaySession } from './paySession'
import { looksOffline } from './rpcResult'
import {
  changeSen, lineProblem, parseRinggit, payProblem, quickTenders, remainingSen, toPayments,
  type TenderLine, type TenderMethod,
} from './tender'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export default function CheckoutSheet({ branchId, bill, title, refreshKey, onClose, onPaid }: {
  branchId: string
  bill: OpenBillRow
  title: string                 // "Table T3" or "Takeaway 261024-004"
  refreshKey: number            // bumped on every bills event, order and 15 s sweep: re-read the bill
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
  const [changeNote, setChangeNote] = useState<string | null>(null)   // the bill changed on another iPad
  const [lockNote, setLockNote] = useState<string | null>(null)       // paid, voided or merged on another iPad
  const [result, setResult] = useState<CheckoutResult | null>(null)
  // one id per payment attempt: Pay again after a lost reply can never charge twice (paySession.ts)
  const [session, setSession] = useState<PaySession>(() => newPaySession(crypto.randomUUID()))
  const sessionRef = useRef(session)
  const totalsRef = useRef<BillTotals | null>(null)
  const loadFailed = useRef(false)       // the first read failed: its error shows until a read succeeds
  const readSeq = useRef(0)
  const keySeq = useRef(0)

  // the ref moves at once, so a second tap in the same render sees the new phase
  const step = (e: PayEvent): PaySession => {
    const s = nextPay(sessionRef.current, e)
    sessionRef.current = s
    setSession(s)
    return s
  }
  const apply = (a: FollowAction) => {
    if (a.kind === 'paidHere') setResult(a.result)
    else if (a.kind === 'lock') { setLockNote(a.note); setMethod(null) }
    else if (a.kind === 'reload') {
      totalsRef.current = a.totals
      setTotals(a.totals)
      if (a.note) setChangeNote(a.note)
    }
  }
  // Re-read the bill with every id this sheet used (its own late payment is never "elsewhere");
  // a reply older than the latest read is dropped. A failed read changes nothing — the next
  // event or sweep tries again (a failed first load shows its error until a read succeeds).
  const follow = async () => {
    const seq = ++readSeq.current
    try {
      const state = await fetchCheckoutState(bill.id, checkoutIds(sessionRef.current))
      if (seq !== readSeq.current) return
      apply(followBill(state, totalsRef.current?.totalSen ?? null))
      if (loadFailed.current) { loadFailed.current = false; setError(null) }
    } catch (e) {
      if (seq === readSeq.current && !totalsRef.current) { loadFailed.current = true; setError(msg(e)) }
    }
  }

  useEffect(() => {
    fetchPaymentMethods(branchId, true)
      .then((rows) => setMethods(rows.map((m) => ({ id: m.id, name: m.name, kind: m.kind, needsReference: m.needs_reference }))))
      .catch((e) => setError(msg(e)))
  }, [branchId])
  // the first load, then every bills event, order and sweep — never while a Pay or Check bill is out
  useEffect(() => {
    const phase = sessionRef.current.phase
    if (!result && !lockNote && phase !== 'paying' && phase !== 'checking') void follow()
  }, [bill.id, refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const total = totals?.totalSen ?? 0
  const left = remainingSen(total, lines)
  const locked = linesLocked(session) || lockNote !== null
  const busy = session.phase === 'paying' || session.phase === 'checking'

  const pick = (m: TenderMethod) => {
    setMethod(m); setError(null); setTenderedText(''); setReference('')
    setAmountText((Math.max(0, left) / 100).toFixed(2))
  }

  const add = (tenderedOverride?: number | null) => {
    if (!method || locked) return
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

  // Pay (editing) and Try again (unsure): the same lines under the session's id
  const pay = async () => {
    const s = sessionRef.current
    if (!totals || lockNote || (s.phase !== 'editing' && s.phase !== 'unsure')) return
    if (s.phase === 'editing') {
      const problem = payProblem(total, lines)
      if (problem) { setError(problem); return }
    }
    step({ type: 'send' }); setError(null); setChangeNote(null)
    try {
      setResult(await checkoutBill(bill.id, toPayments(lines), s.checkoutId))
    } catch (e) {
      const m = msg(e)
      if (looksOffline(m)) { step({ type: 'noReply' }); setMethod(null); setError(UNSURE) }
      else { step({ type: 'refused' }); setError(m); void follow() }   // e.g. a QR order arrived meanwhile and the total changed
    }
  }

  // Check bill: paid by this sheet → its result; open → unlock with a new id; else lock
  const checkBill = async () => {
    if (sessionRef.current.phase !== 'unsure') return
    step({ type: 'check' }); setError(null)
    ++readSeq.current                                   // a re-read still on its way is dropped
    try {
      const a = followBill(await fetchCheckoutState(bill.id, checkoutIds(sessionRef.current)), totalsRef.current?.totalSen ?? null)
      apply(a)
      if (a.kind === 'keep' || a.kind === 'reload') { step({ type: 'checkedOpen', newCheckoutId: crypto.randomUUID() }); setError(CHECKED_OPEN) }
      else step({ type: 'checkEnded' })                 // paid here (the result shows) or closed elsewhere (the lock shows)
    } catch (e) {
      step({ type: 'checkEnded' }); setError(`Could not check the bill: ${msg(e)}`)
    }
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
          <button onClick={onClose} disabled={busy} className="rounded-lg border border-border px-3 py-2">{lockNote ? 'Close' : '← Back'}</button>
          <div className="text-lg font-semibold">Checkout · {title} · Bill {bill.bill_no}</div>
        </div>
        {lockNote && <p role="alert" className="mb-3 rounded bg-red-50 p-3 font-semibold text-red-700">{lockNote}</p>}
        <div className="text-xs font-semibold uppercase text-brown-muted">Payment method</div>
        <div className="mt-1 grid grid-cols-3 gap-2">
          {methods.map((m) => (
            <button key={m.id} onClick={() => pick(m)} disabled={left <= 0 || busy || locked}
              className={`min-h-16 rounded-xl border p-3 text-left disabled:opacity-40 ${method?.id === m.id ? 'border-brown-btn bg-brown-btn text-white' : 'border-border bg-card'}`}>
              <div className="font-medium">{m.name}</div>
              <div className="text-xs opacity-75">{m.kind}</div>
            </button>
          ))}
          {methods.length === 0 && <p className="text-sm text-brown-muted">No payment methods — add them in POS settings.</p>}
        </div>
        {method && !locked && (
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
        {error && <p role="alert" className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      </div>

      <div className="flex flex-col border-l border-border bg-card p-4 text-sm">
        <CheckoutTotals totals={totals} />
        {changeNote && <p role="status" className="mt-2 rounded bg-amber-50 p-2 text-amber-800">{changeNote}</p>}
        <div className="mt-4 flex-1 space-y-1 overflow-y-auto">
          {lines.map((l) => (
            <div key={l.key} className="flex items-center justify-between rounded bg-cream p-2">
              <span>{l.method.name}{l.reference ? ` · ${l.reference}` : ''}{l.tenderedSen !== null ? ` · received ${formatSen(l.tenderedSen)}` : ''}</span>
              <span className="flex items-center gap-2">{formatSen(l.amountSen)}
                <button disabled={locked} className="text-xs text-red-700 underline disabled:opacity-40" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>remove</button>
              </span>
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-between"><span>Left to pay</span><b>{formatSen(Math.max(0, left))}</b></div>
        <div className="flex justify-between"><span>Change</span><b>{formatSen(changeSen(lines))}</b></div>
        {lockNote ? (
          <button onClick={onClose} className="mt-3 w-full rounded-xl bg-brown-btn py-4 text-lg text-white hover:bg-brown-btn-hover">Close</button>
        ) : session.phase === 'unsure' || session.phase === 'checking' ? (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button disabled={busy} onClick={() => void pay()} className="rounded-xl bg-brown-btn py-4 text-lg text-white disabled:opacity-40">Try again</button>
            <button disabled={busy} onClick={() => void checkBill()} className="rounded-xl border border-border py-4 text-lg disabled:opacity-40">
              {session.phase === 'checking' ? 'Checking…' : 'Check bill'}
            </button>
          </div>
        ) : (
          <button disabled={busy || !totals || left !== 0} onClick={() => void pay()}
            className="mt-3 w-full rounded-xl bg-brown-btn py-4 text-lg text-white hover:bg-brown-btn-hover disabled:opacity-40">
            {busy ? 'Paying…' : `Pay ${formatSen(total)}`}
          </button>
        )}
      </div>
    </div>
  )
}
