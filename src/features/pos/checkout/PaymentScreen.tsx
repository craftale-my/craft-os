// src/features/pos/checkout/PaymentScreen.tsx
import { useEffect, useRef, useState } from 'react'
import { formatSen } from '../order/cart'
import { fetchBillItems, type BillItemRow, type OpenBillRow } from '../order/posApi'
import type { BillTotals } from './bill'
import { checkoutBill, fetchCheckoutState, fetchPaymentMethods, type CheckoutResult } from './checkoutApi'
import CheckoutTotals from './CheckoutTotals'
import DiscountRows from './DiscountRows'
import { catalogTag, discountLabel, lineDiscountRows, linesById, storedDiscount } from './discounts'
import { billChangedAtPay, followBill, type FollowAction } from './follow'
import { CHECKED_OPEN, UNSURE, checkoutIds, linesLocked, newPaySession, nextPay, type PayEvent, type PaySession } from './paySession'
import { looksOffline } from './rpcResult'
import {
  changeSen, lineProblem, parseRinggit, payProblem, quickTenders, remainingSen, toPayments,
  type TenderLine, type TenderMethod,
} from './tender'
import { NUMPAD_KEYS, liveChangeSen, numpadPress, payTabs, singleLines, type PayTab } from './payTabs'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const money = (sen: number) => (Math.max(0, sen) / 100).toFixed(2)

/** Full-screen Payment (spec §4), replacing the Checkout sheet. Its logic is the sheet's, unchanged:
 *  the server's totals (pos_checkout_state, re-read on every bills event and sweep), one checkout id
 *  per attempt (paySession: Try again after a lost reply never charges twice, Check bill), the
 *  follow rules (paid / voided / merged on another iPad locks the screen) and tender.ts' checks.
 *  New is only the layout: the bill on the left; the amount, method tabs, quick tender and number
 *  pad on the right; Split payment for several payments. */
export default function PaymentScreen({ branchId, bill, title, refreshKey, earlierIds, onSendIds, onClose, onPaid }: {
  branchId: string
  bill: OpenBillRow
  title: string                 // "Table T3" or "Takeaway 261024-004"
  refreshKey: number            // bumped on every bills event, order and 15 s sweep: re-read the bill
  earlierIds: string[]          // checkout ids an earlier Payment of this bill used on this iPad
  onSendIds: (ids: string[]) => void   // every id used so far, at each send: PosPage keeps them per bill
  onClose: () => void           // Cancel payment: back to the bill
  onPaid: () => void            // Done on the success screen: back home
}) {
  const [totals, setTotals] = useState<BillTotals | null>(null)
  const [methods, setMethods] = useState<TenderMethod[]>([])
  const [items, setItems] = useState<BillItemRow[] | null>(null)
  const [lines, setLines] = useState<TenderLine[]>([])
  const [split, setSplit] = useState(false)
  const [tab, setTab] = useState<PayTab | null>(null)
  const [method, setMethod] = useState<TenderMethod | null>(null)
  const [entry, setEntry] = useState('')            // the number pad: cash received (whole bill) or this payment's amount (split)
  const [entryFresh, setEntryFresh] = useState(false) // split: the entry was pre-filled, so the next digit replaces it
  const [tenderedText, setTenderedText] = useState('') // split, cash: cash received for this part ('' = exact)
  const [reference, setReference] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [methodsError, setMethodsError] = useState<string | null>(null)
  const [changeNote, setChangeNote] = useState<string | null>(null)   // the bill changed on another iPad
  const [lockNote, setLockNote] = useState<string | null>(null)       // paid, voided or merged on another iPad
  const [result, setResult] = useState<CheckoutResult | null>(null)
  const [session, setSession] = useState<PaySession>(() => newPaySession(crypto.randomUUID(), earlierIds))
  const sessionRef = useRef(session)
  const totalsRef = useRef<BillTotals | null>(null)
  const loadFailed = useRef(false)
  const [methodsKey, setMethodsKey] = useState(0)    // bumped by Retry after the payment methods failed to load
  const readSeq = useRef(0)
  const keySeq = useRef(0)
  // The total the cashier is paying against with Split off: set by the first load, moved only by a
  // Pay that found the bill changed. Pay never records a total the cashier has not seen (a card run
  // or cash counted for the old total must not be booked as the new one).
  const payingForRef = useRef<number | null>(null)

  // ── the Checkout sheet's follow logic, unchanged ──
  const step = (e: PayEvent): PaySession => {
    const s = nextPay(sessionRef.current, e)
    sessionRef.current = s
    setSession(s)
    if (e.type === 'send') onSendIds(checkoutIds(s))
    return s
  }
  const apply = (a: FollowAction) => {
    if (a.kind === 'paidHere') setResult(a.result)
    else if (a.kind === 'lock') { setLockNote(a.note); setMethod(null); setError(null); setChangeNote(null) }
    else if (a.kind === 'reload') {
      totalsRef.current = a.totals
      if (payingForRef.current === null) payingForRef.current = a.totals.totalSen
      setTotals(a.totals)
      if (a.note) setChangeNote(a.note)
    }
  }
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
    let live = true
    setMethodsError(null)
    fetchPaymentMethods(branchId, true)
      .then((rows) => { if (live) setMethods(rows.map((m) => ({ id: m.id, name: m.name, kind: m.kind, needsReference: m.needs_reference }))) })
      .catch((e) => { if (live) setMethodsError(msg(e)) })
    return () => { live = false }
  }, [branchId, methodsKey])
  useEffect(() => {
    const phase = sessionRef.current.phase
    if (!result && !lockNote && phase !== 'paying' && phase !== 'checking') void follow()
  }, [bill.id, refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let live = true
    fetchBillItems(bill.id).then((rows) => { if (live) setItems(rows) }, () => undefined)   // the list is for reading; the totals are the server's
    return () => { live = false }
  }, [bill.id, refreshKey])

  const total = totals?.totalSen ?? 0
  const left = remainingSen(total, lines)
  const locked = linesLocked(session) || lockNote !== null
  const busy = session.phase === 'paying' || session.phase === 'checking'
  const tabs = payTabs(methods)
  const shownTab = tabs.find((t) => t.tab === tab) ?? tabs[0] ?? null
  const due = split ? left : total

  const pick = (m: TenderMethod) => {
    if (locked) return
    setMethod(m); setError(null); setReference(''); setTenderedText('')
    setEntry(split ? money(left) : ''); setEntryFresh(split)
  }
  // A tab only shows its methods: the cashier taps the method itself before Pay (none is pre-chosen)
  const chooseTab = (t: PayTab) => {
    if (!tabs.some((x) => x.tab === t) || locked) return
    setTab(t); setMethod(null); setError(null); setReference(''); setTenderedText('')
    setEntry(''); setEntryFresh(false)
  }
  const toggleSplit = () => {
    if (locked) return
    const next = !split
    setSplit(next); setLines([]); setError(null); setReference(''); setTenderedText('')
    setEntry(next ? money(total) : ''); setEntryFresh(next)
  }
  const pressKey = (k: string) => {
    setEntry((t) => numpadPress(entryFresh && k !== '⌫' ? '' : t, k)); setEntryFresh(false)
  }

  // Split: add one payment (CheckoutSheet's add, unchanged rules)
  const add = (tenderedOverride?: number | null) => {
    if (!method || locked) return
    const amountSen = parseRinggit(entry)
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
    const next = [...lines, { ...line, key: String(++keySeq.current) }]
    setLines(next); setReference(''); setTenderedText(''); setError(null)
    setEntry(money(remainingSen(total, next))); setEntryFresh(true)
  }

  // Pay (editing) and Try again (unsure): Try again resends the SAME lines under the session's id
  const send = async (toSend: TenderLine[]) => {
    const s = sessionRef.current
    if (!totals || lockNote || (s.phase !== 'editing' && s.phase !== 'unsure')) return
    const sending = s.phase === 'unsure' ? lines : toSend
    if (s.phase === 'editing') {
      const problem = payProblem(total, sending)
      if (problem) { setError(problem); return }
      setLines(sending)
    }
    step({ type: 'send' }); setError(null); setChangeNote(null)
    try {
      setResult(await checkoutBill(bill.id, toPayments(sending), s.checkoutId))
    } catch (e) {
      const m = msg(e)
      if (looksOffline(m)) { step({ type: 'noReply' }); setError(UNSURE); void follow() }
      else {
        step({ type: 'refused' }); setError(m)
        if (!split) setLines([])                         // a refused one-go payment does not linger
        void follow()
      }
    }
  }
  const pay = () => {
    if (session.phase === 'unsure' || split) { void send(lines); return }
    if (payingForRef.current !== null && payingForRef.current !== total) {
      // the bill changed since the cashier started: show it, and take a second, deliberate Pay
      payingForRef.current = total
      setError(billChangedAtPay(method)); setReference(''); setEntry('')
      return
    }
    if (total === 0) { void send([]); return }          // RM 0.00 closes with no payment, as on the Checkout sheet
    if (!method) { setError('Choose how the bill is paid'); return }
    const r = singleLines(method, total, entry, reference)
    if ('problem' in r) { setError(r.problem); return }
    void send(r.lines.map((l) => ({ ...l, key: String(++keySeq.current) })))
  }

  // Check bill: paid by this screen → its result; open → unlock with a new id; else lock
  const checkBill = async () => {
    if (sessionRef.current.phase !== 'unsure') return
    step({ type: 'check' }); setError(null)
    ++readSeq.current
    try {
      const a = followBill(await fetchCheckoutState(bill.id, checkoutIds(sessionRef.current)), totalsRef.current?.totalSen ?? null)
      apply(a)
      if (a.kind === 'keep' || a.kind === 'reload') {
        step({ type: 'checkedOpen', newCheckoutId: crypto.randomUUID() }); setError(CHECKED_OPEN)
        if (!split) setLines([])                         // the one-go payment is rebuilt by the next Pay
      }
      else step({ type: 'checkEnded' })
    } catch (e) {
      step({ type: 'checkEnded' }); setError(`Could not check the bill: ${msg(e)}`)
    }
    void follow()
  }

  if (result) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-cream p-6">
        <div className="w-full max-w-md rounded-2xl bg-card p-8 text-center shadow-card">
          <div className="text-sm text-brown-muted">Bill {result.billNo} paid · {formatSen(result.totalSen)}</div>
          <div className="mt-6 text-sm uppercase tracking-wide text-brown-muted">Change</div>
          <div className="text-6xl font-semibold text-brown-dark tabular-nums">{formatSen(result.changeSen)}</div>
          <p className="mt-6 text-sm text-brown-muted">
            {result.receiptQueued ? 'Receipt printing…' : 'No receipt printer is set — choose one in POS settings.'}
          </p>
          <button type="button" onClick={onPaid} className="mt-8 min-h-14 w-full rounded-xl bg-brown-btn text-lg font-semibold text-white hover:bg-brown-btn-hover">Done</button>
        </div>
      </div>
    )
  }

  const live = (items ?? []).filter((i) => !i.voided_at)
  const itemCount = live.reduce((n, i) => n + i.qty, 0)
  const showPad = !locked && method !== null && (split || method.kind === 'cash')
  const change = !split && method?.kind === 'cash' ? liveChangeSen(total, entry) : null
  const quick = method?.kind === 'cash' ? quickTenders(split ? parseRinggit(entry) ?? left : total) : []
  const key = 'flex h-14 items-center justify-center rounded-xl border border-border-mid bg-card text-xl font-semibold text-brown-dark disabled:opacity-40'
  const lineTotals = linesById(totals)
  const billDisc = storedDiscount(bill)
  const tag = catalogTag(items ?? [])
  return (
    <div className="flex min-h-0 flex-1 bg-cream">
      <section aria-label="Bill" className="flex w-[40%] shrink-0 flex-col border-r border-border bg-card p-4 text-sm">
        <div className="text-lg font-semibold text-brown-dark">{title}</div>
        <div className="text-xs text-brown-muted">
          Bill {bill.bill_no} · {itemCount} item{itemCount === 1 ? '' : 's'}
          {tag && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800">{tag}</span>}
        </div>
        <div className="mt-3 flex-1 space-y-1 overflow-y-auto">
          {items === null && <p className="text-brown-muted">Loading…</p>}
          {live.map((i) => (
            <div key={i.id} className="flex justify-between gap-2">
              <span>
                {i.qty} × {i.name_snapshot}
                {i.modifiers_snapshot.map((m, k) => <span key={k} className="block pl-4 text-xs text-brown-muted">+ {m.name}</span>)}
                <DiscountRows rows={lineDiscountRows(i, lineTotals.get(i.id))} />
              </span>
              <span className="tabular-nums">{formatSen(i.unit_price_sen * i.qty)}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 border-t border-border pt-3"><CheckoutTotals totals={totals} billDiscountLabel={billDisc ? discountLabel(billDisc, true) : undefined} /></div>
        {changeNote && <p role="status" className="mt-2 rounded bg-amber-50 p-2 text-amber-800">{changeNote}</p>}
        <button type="button" onClick={onClose} disabled={busy}
          className="mt-3 min-h-14 rounded-xl border border-border-mid font-medium text-brown-dark disabled:opacity-40">
          {lockNote ? 'Close' : 'Cancel payment'}
        </button>
      </section>

      <section aria-label="Payment" className="flex min-w-0 flex-1 flex-col p-4">
        <div className="flex justify-end">
          <button type="button" onClick={toggleSplit} disabled={locked} aria-pressed={split}
            className={`min-h-11 rounded-xl px-4 text-sm font-medium disabled:opacity-40 ${split ? 'bg-brown-dark text-cream' : 'border border-border-mid text-brown-dark'}`}>
            Split payment
          </button>
        </div>
        {lockNote && <p role="alert" className="mt-3 rounded bg-red-50 p-3 font-semibold text-red-700">{lockNote}</p>}
        <div className="mt-2 text-center">
          <div className="text-sm uppercase tracking-wide text-brown-muted">{split ? 'Left to pay' : 'Amount due'}</div>
          <div className="text-5xl font-semibold text-brown-dark tabular-nums">{totals ? formatSen(due) : '…'}</div>
          {!split && method?.kind === 'cash' && (
            <div className="mt-1 text-sm text-brown-muted">
              Received {entry ? `RM ${entry}` : 'exact'} · Change {change === null ? '—' : formatSen(change)}
            </div>
          )}
          {split && <div className="mt-1 text-sm text-brown-muted">This payment RM {entry || '0'}</div>}
        </div>
        {split && method?.kind === 'cash' && !locked && (
          <label className="mx-auto mt-3 block w-full max-w-sm text-sm">Cash received (RM)
            <input inputMode="decimal" placeholder="exact" className="mt-1 h-12 w-full rounded-xl border border-border-mid px-3 text-base"
              value={tenderedText} onChange={(e) => setTenderedText(e.target.value)} />
          </label>
        )}
        {method?.needsReference && !locked && (
          <label className="mx-auto mt-3 block w-full max-w-sm text-sm">Reference
            <input className="mt-1 h-12 w-full rounded-xl border border-border-mid px-3 text-base" value={reference} onChange={(e) => setReference(e.target.value)} />
          </label>
        )}
        <div className="mt-3 grid grid-cols-3 gap-2">
          {shownTab?.methods.map((m) => (
            <button key={m.id} type="button" onClick={() => pick(m)} disabled={busy || locked} aria-pressed={method?.id === m.id}
              className={`min-h-14 rounded-xl border px-3 text-left font-medium disabled:opacity-40 ${method?.id === m.id ? 'border-brown-btn bg-brown-btn text-white' : 'border-border-mid bg-card text-brown-dark'}`}>
              {m.name}
            </button>
          ))}
          {methods.length === 0 && (methodsError
            ? (
              <p role="alert" className="col-span-3 rounded bg-red-50 p-2 text-sm text-red-700">
                {methodsError} <button type="button" className="min-h-11 px-2 underline" onClick={() => setMethodsKey((k) => k + 1)}>Retry</button>
              </p>
            )
            : <p className="col-span-3 text-sm text-brown-muted">No payment methods — add them in POS settings.</p>)}
        </div>
        {showPad && (
          <div className="mt-3 flex min-h-0 flex-1 gap-3">
            <div className="grid flex-1 grid-cols-3 content-start gap-2">
              {NUMPAD_KEYS.map((k) => (
                <button key={k} type="button" className={key} disabled={busy} onClick={() => pressKey(k)}>{k}</button>
              ))}
            </div>
            <div className="flex w-40 flex-col gap-2">
              {method?.kind === 'cash' && !split && (
                <button type="button" className={key} disabled={busy} onClick={() => setEntry('')}>Exact</button>
              )}
              {quick.map((n) => (
                <button key={n} type="button" className={key} disabled={busy}
                  onClick={() => (split ? add(n) : setEntry((n / 100).toFixed(0)))}>RM {n / 100}</button>
              ))}
              <button type="button" className={key} disabled={busy} onClick={() => { setEntry(''); setEntryFresh(false) }}>C</button>
              {split && (
                <button type="button" onClick={() => add()} disabled={busy}
                  className="min-h-14 rounded-xl bg-brown-dark font-semibold text-cream disabled:opacity-40">Add {method?.name}</button>
              )}
            </div>
          </div>
        )}
        {!showPad && <div className="flex-1" />}
        {split && lines.length > 0 && (
          <div className="mt-3 space-y-1 text-sm">
            {lines.map((l) => (
              <div key={l.key} className="flex items-center justify-between rounded-lg bg-card p-2">
                <span>{l.method.name}{l.reference ? ` · ${l.reference}` : ''}{l.tenderedSen !== null ? ` · received ${formatSen(l.tenderedSen)}` : ''}</span>
                <span className="flex items-center gap-3 tabular-nums">{formatSen(l.amountSen)}
                  <button type="button" disabled={locked} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                    className="min-h-11 px-2 text-xs text-red-700 underline disabled:opacity-40">Remove</button>
                </span>
              </div>
            ))}
            <div className="flex justify-between px-2"><span>Change</span><b className="tabular-nums">{formatSen(changeSen(lines))}</b></div>
          </div>
        )}
        {error && <p role="alert" className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
        {lockNote ? (
          <button type="button" onClick={onClose} disabled={busy} className="mt-3 min-h-16 rounded-xl bg-brown-btn text-lg font-semibold text-white">Close</button>
        ) : session.phase === 'unsure' || session.phase === 'checking' ? (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="button" disabled={busy} onClick={pay} className="min-h-16 rounded-xl bg-brown-btn text-lg font-semibold text-white disabled:opacity-40">Try again</button>
            <button type="button" disabled={busy} onClick={() => void checkBill()} className="min-h-16 rounded-xl border border-border-mid text-lg disabled:opacity-40">
              {session.phase === 'checking' ? 'Checking…' : 'Check bill'}
            </button>
          </div>
        ) : (
          <button type="button" onClick={pay} disabled={busy || !totals || (split ? left !== 0 : !method && total !== 0)}
            className="mt-3 min-h-16 rounded-xl bg-brown-btn text-lg font-semibold text-white hover:bg-brown-btn-hover disabled:opacity-40">
            {busy ? 'Paying…' : `Pay ${formatSen(total)}`}
          </button>
        )}
        {tabs.length > 0 && (
          <div role="tablist" aria-label="Payment type" className="mt-3 grid gap-2" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
            {tabs.map((t) => (
              <button key={t.tab} type="button" role="tab" aria-selected={shownTab?.tab === t.tab} disabled={busy || locked} onClick={() => chooseTab(t.tab)}
                className={`min-h-12 rounded-xl font-medium disabled:opacity-40 ${shownTab?.tab === t.tab ? 'bg-brown-dark text-cream' : 'bg-card text-brown-dark'}`}>
                {t.label}
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
