// src/features/pos/checkout/PaymentScreen.tsx
import { useEffect, useRef, useState } from 'react'
import { formatSen } from '../order/cart'
import { fetchBillItems, type BillItemRow, type OpenBillRow } from '../order/posApi'
import { SPLIT_OFFLINE, canSplit, type SplitItem } from '../order/splitSelection'
import type { BillTotals } from './bill'
import {
  checkoutBill, checkoutItems, fetchCheckoutState, fetchPaymentMethods, partQuote, payBillPart, splitTotals, type CheckoutResult,
} from './checkoutApi'
import CheckoutTotals from './CheckoutTotals'
import DiscountRows from './DiscountRows'
import { catalogTag, discountLabel, lineDiscountRows, linesById, storedDiscount } from './discounts'
import { billChangedAtPay, earlierPartPaid, followBill, type CheckoutState, type FollowAction } from './follow'
import {
  BALANCE_DUE, MAX_WAYS, MIN_WAYS, PERCENT_CHIPS, SPLIT_MODE_LABEL, amountMissing, clampWays, equalPay, fixedWays, paidPartLabel, partPaidNote, partProblem,
  percentChipSen, shareLabel, splitIntoLabel, type BillPart, type PartDone, type PartMode, type PartQuote,
} from './partSplit'
import { CHECKED_OPEN, UNSURE, checkoutIds, linesLocked, newPaySession, nextPay, type PayEvent, type PaySession } from './paySession'
import { looksOffline } from './rpcResult'
import {
  changeSen, lineProblem, parseRinggit, payProblem, quickTenders, remainingSen, toPayments,
  type TenderLine, type TenderMethod,
} from './tender'
import { NUMPAD_KEYS, liveChangeSen, numpadPress, payTabs, singleLines, type PayTab } from './payTabs'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const money = (sen: number) => (Math.max(0, sen) / 100).toFixed(2)
const SPLIT_MODES = ['item', 'equal', 'amount'] as const
/** The bill as read, and for split by item whether its result came from an earlier Payment's id. */
type ReadState = CheckoutState & { earlier?: boolean }

/** Full-screen Payment (spec §4), replacing the Checkout sheet. Its logic is the sheet's, unchanged:
 *  the server's totals (pos_checkout_state, re-read on every bills event and sweep), one checkout id
 *  per attempt (paySession: Try again after a lost reply never charges twice, Check bill), the
 *  follow rules (paid / voided / merged on another iPad locks the screen) and tender.ts' checks.
 *  New is only the layout: the bill on the left; the amount, method tabs, quick tender and number
 *  pad on the right; Split payment for several payments. With `split` (split spec §3.3) only the picked
 *  units are paid: their totals are pos_split_totals', Pay is checkout_items, and the table bill stays
 *  open (the screen still follows it: paid, voided or merged elsewhere locks it).
 *  The Split row (split spec §3.5): By item opens the picker; Equally pays the server's share
 *  (pos_part_quote) and By amount an amount below the balance, each as a part (pay_bill_part, the
 *  attempt's id is the part's id, p_paid_sen the paid parts the screen showed); the last share (the
 *  quote's share is not below its balance), or an amount equal to the balance, is a normal checkout_bill
 *  of the balance, and a balance of RM 0.00 closes with no payment. Offline, Pay for a part is off.
 *  The paid parts and the balance show above the totals. */
export default function PaymentScreen({ branchId, bill, title, refreshKey, earlierIds, split: byItem, online = true, onSplitByItem,
  onSendIds, onClose, onPaid }: {
  branchId: string
  bill: OpenBillRow
  title: string                 // "Table T3", "Takeaway 261024-004", "Table T3 · Split"
  refreshKey: number            // bumped on every bills event, order and 15 s sweep: re-read the bill
  earlierIds: string[]          // checkout ids an earlier Payment of this bill used on this iPad
  split?: { items: SplitItem[] }   // split by item: pay only these units, as their own bill
  online?: boolean              // the server answers: the Split row needs it
  onSplitByItem?: () => void    // Split → By item: the picker (PosTill)
  onSendIds: (ids: string[]) => void   // every id used so far, at each send: PosPage keeps them per bill
                                       // (split: [] once the part's result shows — those ids are spent)
  onClose: () => void           // Cancel payment: back to the bill (split: back to the picker)
  onPaid: () => void            // Done on the success screen: back home (split: back to the bill)
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
  const [resultEarlier, setResultEarlier] = useState(false)   // split: the result is an earlier Pay selected's, not this one's
  const [session, setSession] = useState<PaySession>(() => newPaySession(crypto.randomUUID(), earlierIds))
  // part payments (split spec §3.5)
  const [paidSen, setPaidSen] = useState(0)
  const [parts, setParts] = useState<BillPart[]>([])
  const [partMode, setPartMode] = useState<PartMode>('none')
  const [ways, setWays] = useState(MIN_WAYS)
  const [quote, setQuote] = useState<PartQuote | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [amountText, setAmountText] = useState('')
  const [partNote, setPartNote] = useState<string | null>(null)       // "Part 1 paid · RM 23.45 · Change RM 26.55"
  const sessionRef = useRef(session)
  const priorIdsRef = useRef(earlierIds)                              // the ids an earlier Payment sent, as this screen opened with them
  const ownIdsRef = useRef<string[]>([])                              // the ids this screen sent itself
  const totalsRef = useRef<BillTotals | null>(null)
  const paidRef = useRef(0)                                           // paidSen as last read: the balance follow compares
  // the part being sent, frozen with the paid parts the screen showed: Try again resends exactly it
  const sentPartRef = useRef<{ amountSen: number; ways: number | null; paidSen: number } | null>(null)
  const loadFailed = useRef(false)
  const [methodsKey, setMethodsKey] = useState(0)    // bumped by Retry after the payment methods failed to load
  const [quoteKey, setQuoteKey] = useState(0)        // bumped by Retry after the share failed to load
  const readSeq = useRef(0)
  const keySeq = useRef(0)
  const quoteSeq = useRef(0)
  // The amount the cashier is paying against with Split off (the balance): set by the first load, moved
  // only by a Pay that found the bill changed. Pay never records an amount the cashier has not seen.
  const payingForRef = useRef<number | null>(null)

  // ── the Checkout sheet's follow logic ──
  const step = (e: PayEvent): PaySession => {
    const s = nextPay(sessionRef.current, e)
    sessionRef.current = s
    setSession(s)
    if (e.type === 'send') {
      if (!ownIdsRef.current.includes(s.checkoutId)) ownIdsRef.current = [...ownIdsRef.current, s.checkoutId]
      onSendIds(checkoutIds(s))
    }
    return s
  }
  const apply = (a: FollowAction) => {
    if (a.kind === 'paidHere') setResult(a.result)
    else if (a.kind === 'lock') { setLockNote(a.note); setMethod(null); setError(null); setChangeNote(null) }
    else if (a.kind === 'reload') {
      totalsRef.current = a.totals
      if (payingForRef.current === null) payingForRef.current = a.totals.totalSen - paidRef.current
      setTotals(a.totals)
      if (a.note) setChangeNote(a.note)
    }
  }
  /** Takes in what the parts paid, then the follow rules on the balance give the action. */
  const absorb = (state: ReadState): FollowAction => {
    if (state.result && state.earlier) setResultEarlier(true)
    const shown = totalsRef.current ? totalsRef.current.totalSen - paidRef.current : null
    paidRef.current = state.paidSen ?? 0
    setPaidSen(paidRef.current)
    setParts(state.parts ?? [])
    return followBill(state, shown)
  }
  /** A part sent with no reply that the bill now lists under this attempt's id went through: it is
   *  shown paid (change unknown) and the next part gets a new id. Only while unsure / checking. */
  const takeLanded = (state: CheckoutState): boolean => {
    const id = sessionRef.current.checkoutId
    const landed = sentPartRef.current ? (state.parts ?? []).find((p) => p.id === id) : undefined
    if (!landed) return false
    setParts(state.parts ?? [])
    partDone({ partNo: landed.partNo, amountSen: landed.amountSen, changeSen: null, paidSen: state.paidSen ?? 0 })
    apply(followBill(state, totalsRef.current ? totalsRef.current.totalSen - paidRef.current : null))   // the total moved too: shown
    return true
  }
  // The bill as this screen follows it. Split by item: an open table bill with no part paid under our
  // ids is weighed by the PART's totals (pos_split_totals), never the table bill's — in the follow and
  // in Check bill alike, so neither can put the table's total on the Pay button (nor its paid parts:
  // the picked units have none). A selection the server refuses comes back as its words (the picked
  // units changed: back to the picker), unless a Pay selected landed between the two reads (its units
  // are gone, so the selection is refused): then one more read with the same ids finds that part paid.
  const readState = async (): Promise<ReadState | { refused: string }> => {
    const ids = checkoutIds(sessionRef.current)
    const state = await fetchCheckoutState(bill.id, ids)
    if (!byItem) return state
    if (state.status !== 'open' || state.result) return tagEarlier(state)
    try {
      return { ...state, totals: await splitTotals(bill.id, byItem.items), paidSen: undefined, parts: undefined }
    } catch (e) {
      if (looksOffline(msg(e))) throw e
      let again: CheckoutState
      try {
        again = await fetchCheckoutState(bill.id, ids)
      } catch (e2) {
        if (looksOffline(msg(e2))) throw e2
        return { refused: msg(e) }
      }
      return again.result ? tagEarlier(again) : { refused: msg(e) }
    }
  }
  // Split by item: a part found paid under an id this screen did not send itself is an earlier Pay
  // selected that landed late — shown as that, so the cashier never takes it for this guest's payment.
  // Both may have sent: a read with only this screen's ids tells which.
  const tagEarlier = async (state: CheckoutState): Promise<ReadState> => {
    if (!state.result || priorIdsRef.current.length === 0) return state
    if (ownIdsRef.current.length === 0) return { ...state, earlier: true }
    const mine = await fetchCheckoutState(bill.id, ownIdsRef.current)
    return { ...state, earlier: !mine.result }
  }
  const follow = async () => {
    const seq = ++readSeq.current
    try {
      const state = await readState()
      if (seq !== readSeq.current) return
      if ('refused' in state) { apply({ kind: 'lock', note: state.refused }); return }
      if (!(sessionRef.current.phase === 'unsure' && takeLanded(state))) apply(absorb(state))
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
  // Split by item: once a part's result shows, its ids are spent. Drop them now, not on Done: the till
  // may lock before Done, and the next split Payment of this bill (other units) must not start with
  // them, or the follow would find that paid part and show the new selection as paid.
  useEffect(() => {
    if (result && byItem) onSendIds([])
  }, [result]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const phase = sessionRef.current.phase
    if (!result && !lockNote && phase !== 'paying' && phase !== 'checking') void follow()
  }, [bill.id, refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let live = true
    fetchBillItems(bill.id).then((rows) => { if (live) setItems(rows) }, () => undefined)   // the list is for reading; the totals are the server's
    return () => { live = false }
  }, [bill.id, refreshKey])
  // an equal split already started fixes N; the share is the server's, quoted again whenever the bill moves.
  // The old quote goes at once: Pay waits for the new one, so a share for the old N or the old bill is never sent.
  useEffect(() => { const f = fixedWays(parts); if (f !== null) setWays(f) }, [parts])
  // A screen opened on a bill whose equal split has begun comes back in Equally, once: a cashier who then
  // turns it off keeps it off while the bill is read again.
  const modeRestoredRef = useRef(false)
  useEffect(() => {
    if (modeRestoredRef.current || parts.length === 0) return
    modeRestoredRef.current = true
    if (fixedWays(parts) !== null) setPartMode((cur) => (cur === 'none' ? 'equal' : cur))
  }, [parts])
  useEffect(() => {
    ++quoteSeq.current
    setQuote(null); setQuoteError(null)
    if (partMode !== 'equal') return
    const seq = quoteSeq.current
    partQuote(bill.id, ways).then(
      (q) => { if (seq === quoteSeq.current) setQuote(q) },
      (e) => { if (seq === quoteSeq.current) { setQuote(null); setQuoteError(msg(e)) } },
    )
  }, [bill.id, partMode, ways, paidSen, totals?.totalSen, quoteKey])

  const billTotal = totals?.totalSen ?? 0
  const balance = billTotal - paidSen
  // nothing left to pay (the parts paid it all, or a RM 0.00 bill): checkout_bill with no payment, in any mode
  const settled = totals !== null && balance === 0
  // Equally: part or last share is the quote's call (its share against its balance), never the screen's
  const equal = partMode === 'equal' && !settled ? equalPay(quote) : null
  const partDue = settled ? null
    : equal ? (equal.kind === 'part' ? equal.shareSen : null)
    : partMode === 'amount' ? parseRinggit(amountText) : null
  const payingRest = settled || partMode === 'none' || equal?.kind === 'rest'
  const total = payingRest ? balance : partDue ?? 0                  // what this Pay records
  const isPart = !payingRest && partDue !== null && partDue > 0 && partDue < balance
  const shareProblem = equal?.kind === 'problem' && quote !== null ? equal.problem : null   // a quote came, but no share to pay
  const partOffline = isPart && !online                                // a part needs the server; the whole bill pays as before
  const fixed = fixedWays(parts)
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
  // The Split row: By item opens the picker; Equally / By amount toggle a part payment
  const chooseMode = (m: (typeof SPLIT_MODES)[number]) => {
    if (locked || busy || !online) return
    if (m === 'item') { onSplitByItem?.(); return }
    setPartMode((cur) => (cur === m ? 'none' : m))
    setLines([]); setEntry(''); setEntryFresh(false); setTenderedText(''); setReference(''); setError(null); setPartNote(null)
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

  /** A part went through: a fresh attempt id for the next one, the screen stays on the bill. */
  const partDone = (r: PartDone) => {
    const fresh = newPaySession(crypto.randomUUID(), checkoutIds(sessionRef.current))
    sessionRef.current = fresh; setSession(fresh)
    sentPartRef.current = null
    paidRef.current = r.paidSen; setPaidSen(r.paidSen)
    payingForRef.current = (totalsRef.current?.totalSen ?? 0) - r.paidSen
    setPartNote(partPaidNote(r)); setError(null)
    setLines([]); setMethod(null); setEntry(''); setEntryFresh(false); setTenderedText(''); setReference(''); setAmountText(''); setSplit(false)
  }

  // Pay (editing) and Try again (unsure): Try again resends the SAME lines (and the same part) under the session's id
  const send = async (toSend: TenderLine[]) => {
    const s = sessionRef.current
    if (!totals || lockNote || (s.phase !== 'editing' && s.phase !== 'unsure')) return
    const sending = s.phase === 'unsure' ? lines : toSend
    if (s.phase === 'editing') {
      const problem = payProblem(total, sending)
      if (problem) { setError(problem); return }
      setLines(sending)
      sentPartRef.current = isPart ? { amountSen: total, ways: partMode === 'equal' ? quote?.ways ?? ways : null, paidSen } : null   // the paid parts on screen
    }
    const part = sentPartRef.current
    step({ type: 'send' }); setError(null); setChangeNote(null); setPartNote(null)
    try {
      if (part) {
        const r = await payBillPart(bill.id, s.checkoutId, part.amountSen, part.ways, toPayments(sending), part.paidSen)
        partDone({ partNo: r.partNo, amountSen: r.amountSen, changeSen: r.changeSen, paidSen: r.paidSen })
        void follow()
        return
      }
      setResult(byItem
        ? await checkoutItems(bill.id, byItem.items, toPayments(sending), s.checkoutId)
        : await checkoutBill(bill.id, toPayments(sending), s.checkoutId))
    } catch (e) {
      const m = msg(e)
      if (looksOffline(m)) { step({ type: 'noReply' }); setError(UNSURE); void follow() }
      else {
        step({ type: 'refused' }); setError(m)
        if (!split) setLines([])                         // a refused one-go payment does not linger
        sentPartRef.current = null                       // a refused part recorded nothing: the next Pay sends what is on screen
        void follow()                                    // e.g. "The bill changed. Check the split again.": the new parts and balance show
      }
    }
  }
  const pay = () => {
    if (session.phase === 'unsure') { void send(lines); return }
    if (partMode !== 'none' && !settled) {
      const problem = equal ? (equal.kind === 'problem' ? equal.problem : null) : partProblem(partMode, partDue, balance)
      if (problem) { setError(problem); return }
    }
    if (partOffline) { setError(SPLIT_OFFLINE); return }
    if (split) { void send(lines); return }
    if (payingForRef.current !== null && payingForRef.current !== balance) {
      // the bill changed since the cashier started: show it, and take a second, deliberate Pay
      payingForRef.current = balance
      setError(billChangedAtPay(method)); setReference(''); setEntry('')
      return
    }
    if (total === 0) { void send([]); return }          // RM 0.00 closes with no payment, as on the Checkout sheet
    if (!method) { setError('Choose how the bill is paid'); return }
    const r = singleLines(method, total, entry, reference)
    if ('problem' in r) { setError(r.problem); return }
    void send(r.lines.map((l) => ({ ...l, key: String(++keySeq.current) })))
  }

  // Check bill: paid by this screen → its result; a part of this screen landed → it is paid; open → unlock with a new id; else lock
  const checkBill = async () => {
    if (sessionRef.current.phase !== 'unsure') return
    step({ type: 'check' }); setError(null)
    ++readSeq.current
    try {
      const state = await readState()
      if ('refused' in state) { step({ type: 'checkEnded' }); apply({ kind: 'lock', note: state.refused }); return }
      if (!takeLanded(state)) {
        const a = absorb(state)
        apply(a)
        if (a.kind === 'keep' || a.kind === 'reload') {
          step({ type: 'checkedOpen', newCheckoutId: crypto.randomUUID() }); setError(CHECKED_OPEN)
          sentPartRef.current = null                     // the part was not recorded: the next Pay sends what is on screen
          if (!split) setLines([])                       // the one-go payment is rebuilt by the next Pay
        }
        else step({ type: 'checkEnded' })
      }
    } catch (e) {
      step({ type: 'checkEnded' }); setError(`Could not check the bill: ${msg(e)}`)
    }
    void follow()
  }

  if (result && resultEarlier) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-cream p-6">
        <div className="w-full max-w-md rounded-2xl bg-card p-8 text-center shadow-card">
          <p role="status" className="text-lg font-semibold text-brown-dark">{earlierPartPaid(result)}</p>
          <button type="button" onClick={onPaid} className="mt-8 min-h-14 w-full rounded-xl bg-brown-btn text-lg font-semibold text-white hover:bg-brown-btn-hover">Done</button>
        </div>
      </div>
    )
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
  const shown = byItem
    ? byItem.items.flatMap((s) => { const it = live.find((i) => i.id === s.itemId); return it ? [{ ...it, qty: s.qty }] : [] })
    : live
  const itemCount = shown.reduce((n, i) => n + i.qty, 0)
  const showPad = !locked && method !== null && (split || method.kind === 'cash')
  const change = !split && method?.kind === 'cash' ? liveChangeSen(total, entry) : null
  const quick = method?.kind === 'cash' ? quickTenders(split ? parseRinggit(entry) ?? left : total) : []
  const key = 'flex h-14 items-center justify-center rounded-xl border border-border-mid bg-card text-xl font-semibold text-brown-dark disabled:opacity-40'
  const lineTotals = linesById(totals)
  const billDisc = storedDiscount(bill)
  const tag = catalogTag(items ?? [])
  const partsOff = locked || busy || !online
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
          {shown.map((i) => (
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
        {parts.length > 0 && (
          <div aria-label="Paid parts" className="mt-2 space-y-1 border-t border-border pt-2">
            {parts.map((p) => <div key={p.id} className="text-brown-muted">{paidPartLabel(p, parts)}</div>)}
            <div className="flex justify-between text-base font-semibold text-brown-dark">
              <span>{BALANCE_DUE}</span><span className="tabular-nums">{formatSen(balance)}</span>
            </div>
          </div>
        )}
        {changeNote && <p role="status" className="mt-2 rounded bg-amber-50 p-2 text-amber-800">{changeNote}</p>}
        <button type="button" onClick={onClose} disabled={busy}
          className="mt-3 min-h-14 rounded-xl border border-border-mid font-medium text-brown-dark disabled:opacity-40">
          {lockNote ? 'Close' : 'Cancel payment'}
        </button>
      </section>

      <section aria-label="Payment" className="flex min-w-0 flex-1 flex-col p-4">
        <div className="flex flex-wrap items-center justify-end gap-2">
          {!byItem && (
            <div role="group" aria-label="Split bill" className="mr-auto flex flex-wrap items-center gap-2">
              <span className="text-sm text-brown-muted">Split</span>
              {SPLIT_MODES.map((m) => (
                <button key={m} type="button" onClick={() => chooseMode(m)} aria-pressed={m !== 'item' && partMode === m}
                  disabled={partsOff || (m === 'item' && (!onSplitByItem || paidSen > 0 || !canSplit(itemCount)))}
                  className={`min-h-11 rounded-xl px-3 text-sm font-medium disabled:opacity-40 ${m !== 'item' && partMode === m ? 'bg-brown-dark text-cream' : 'border border-border-mid text-brown-dark'}`}>
                  {SPLIT_MODE_LABEL[m]}
                </button>
              ))}
              {!online && <span className="text-xs text-amber-800">{SPLIT_OFFLINE}</span>}
            </div>
          )}
          <button type="button" onClick={toggleSplit} disabled={locked} aria-pressed={split}
            className={`min-h-11 rounded-xl px-4 text-sm font-medium disabled:opacity-40 ${split ? 'bg-brown-dark text-cream' : 'border border-border-mid text-brown-dark'}`}>
            Split payment
          </button>
        </div>
        {partMode === 'equal' && (
          <div className="mt-2 flex items-center justify-center gap-3">
            <button type="button" aria-label="Fewer ways" disabled={partsOff || fixed !== null || ways <= MIN_WAYS}
              onClick={() => setWays((w) => clampWays(w - 1))} className={`${key} w-14`}>−</button>
            <span className="min-w-32 text-center font-medium text-brown-dark">{splitIntoLabel(fixed ?? ways)}</span>
            <button type="button" aria-label="More ways" disabled={partsOff || fixed !== null || ways >= MAX_WAYS}
              onClick={() => setWays((w) => clampWays(w + 1))} className={`${key} w-14`}>+</button>
          </div>
        )}
        {partMode === 'amount' && (
          <div className="mx-auto mt-2 flex w-full max-w-md items-end gap-2">
            <label className="flex-1 text-sm">Amount (RM)
              <input inputMode="decimal" disabled={partsOff} className="mt-1 h-12 w-full rounded-xl border border-border-mid px-3 text-base"
                value={amountText} onChange={(e) => { setAmountText(e.target.value); setLines([]); setError(null) }} />
            </label>
            {PERCENT_CHIPS.map((pct) => {
              const sen = percentChipSen(billTotal, pct, balance)
              return (
                <button key={pct} type="button" disabled={partsOff || sen === null}
                  onClick={() => { if (sen !== null) { setAmountText((sen / 100).toFixed(2)); setLines([]); setError(null) } }}
                  className="h-12 rounded-xl border border-border-mid px-3 text-sm font-medium text-brown-dark disabled:opacity-40">{pct}%</button>
              )
            })}
          </div>
        )}
        {lockNote && <p role="alert" className="mt-3 rounded bg-red-50 p-3 font-semibold text-red-700">{lockNote}</p>}
        <div className="mt-2 text-center">
          {partMode === 'equal' && quote && quote.ways !== null && quote.shareSen !== null && (
            <div className="text-sm font-medium text-brown-dark">{shareLabel(quote.sharesPaid + 1, quote.ways, equal?.kind === 'rest' ? balance : quote.shareSen)}</div>
          )}
          <div className="text-sm uppercase tracking-wide text-brown-muted">
            {split ? 'Left to pay' : paidSen > 0 && partMode === 'none' ? BALANCE_DUE : 'Amount due'}
          </div>
          <div className="text-5xl font-semibold text-brown-dark tabular-nums">{totals ? formatSen(due) : '…'}</div>
          {!split && method?.kind === 'cash' && (
            <div className="mt-1 text-sm text-brown-muted">
              Received {entry ? `RM ${entry}` : 'exact'} · Change {change === null ? '—' : formatSen(change)}
            </div>
          )}
          {split && <div className="mt-1 text-sm text-brown-muted">This payment {formatSen(parseRinggit(entry) ?? 0)}</div>}
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
        {partNote && <p role="status" className="mt-3 rounded bg-green-50 p-2 text-sm text-green-800">{partNote}</p>}
        {quoteError && (
          <p role="alert" className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">
            {quoteError} <button type="button" className="min-h-11 px-2 underline" onClick={() => setQuoteKey((k) => k + 1)}>Retry</button>
          </p>
        )}
        {shareProblem && <p role="alert" className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{shareProblem}</p>}
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
          <button type="button" onClick={pay} disabled={busy || !totals || (split ? left !== 0 : !method && total !== 0) || equal?.kind === 'problem' || partOffline
              || (!settled && amountMissing(partMode, partDue))}
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
