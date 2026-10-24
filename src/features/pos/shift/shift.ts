/** Pure rules of the shift screens (Sub-plan 4a). The server repeats every check with
 *  the same words (migration-2026-10-24-pos-shifts-fn.sql); these are only so the
 *  cashier sees the problem before pressing the button. Money is integer sen. */
import { looksOffline } from '../checkout/rpcResult'   // the one "no reply" classifier (knows Safari's "Load failed")
import { parseRinggit } from '../checkout/tender'
import { formatSen } from '../order/cart'
import type { ZReport } from '../print/zreport'

export type CashMoveKind = 'pay_in' | 'pay_out'
export const KIND_LABEL: Record<CashMoveKind, string> = { pay_in: 'Pay in', pay_out: 'Pay out' }

/** A shift open longer than this gets the amber "close it" note in the top bar. */
export const SHIFT_STALE_HOURS = 20

/** The most a float, a count or a pay in / pay out can be (RM 100000.00), as the server says. */
export const MAX_CASH_SEN = 10_000_000

export interface OpenShift { id: string; openedAt: string; openedByName: string | null; openingFloatSen: number }
/** pos_current_shift: never the expected cash (the count at close is blind). */
export interface ShiftStatus { shift: OpenShift | null; openBillCount: number; lastFloatSen: number | null; now: string }

export type CloseResult =
  | { kind: 'closed'; report: ZReport; printed: boolean }
  | { kind: 'needsApproval'; expectedSen: number; varianceSen: number; limitSen: number }

export interface CashMoveResult { id: string; kind: CashMoveKind; amountSen: number }

export interface ShiftListRow {
  id: string
  openedAt: string
  closedAt: string
  openedBy: string | null
  closedBy: string | null
  nettSen: number
  varianceSen: number
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const strOrNull = (x: unknown): string | null => (typeof x === 'string' ? x : null)
const unexpected = (): never => { throw new Error('Unexpected reply from the server') }

export function parseShiftStatus(data: unknown): ShiftStatus {
  if (!isObj(data) || !isNum(data.openBillCount) || typeof data.now !== 'string') return unexpected()
  const s = data.shift
  let shift: OpenShift | null = null
  if (s !== null) {
    if (!isObj(s) || typeof s.id !== 'string' || typeof s.openedAt !== 'string' || !isNum(s.openingFloatSen)) return unexpected()
    shift = { id: s.id, openedAt: s.openedAt, openedByName: strOrNull(s.openedByName), openingFloatSen: s.openingFloatSen }
  }
  return { shift, openBillCount: data.openBillCount, lastFloatSen: isNum(data.lastFloatSen) ? data.lastFloatSen : null, now: data.now }
}

/** A frozen Z report as the server stored it (only its outline is checked). A report frozen
 *  before the first count's variance was stored has no firstVarianceSen: read as null. */
export function parseZReport(data: unknown): ZReport {
  if (!isObj(data) || !isObj(data.summary) || !isObj(data.sales) || !isObj(data.cash) || !Array.isArray(data.payments)) return unexpected()
  const firstVarianceSen = isNum(data.cash.firstVarianceSen) ? data.cash.firstVarianceSen : null
  return { ...data, cash: { ...data.cash, firstVarianceSen } } as unknown as ZReport
}

/** Throws the server's words for a wrong PIN; otherwise closed, or "needs approval". */
export function parseCloseResult(data: unknown): CloseResult {
  if (!isObj(data) || typeof data.ok !== 'boolean') return unexpected()
  if (data.ok) {
    if (typeof data.printed !== 'boolean') return unexpected()
    return { kind: 'closed', report: parseZReport(data.report), printed: data.printed }
  }
  if (data.needsApproval === true) {
    if (!isNum(data.expectedSen) || !isNum(data.varianceSen) || !isNum(data.limitSen)) return unexpected()
    return { kind: 'needsApproval', expectedSen: data.expectedSen, varianceSen: data.varianceSen, limitSen: data.limitSen }
  }
  throw new Error(typeof data.error === 'string' && data.error ? data.error : 'Not approved')
}

export function parseCashMoveResult(data: unknown): CashMoveResult {
  if (!isObj(data) || typeof data.ok !== 'boolean') return unexpected()
  if (!data.ok) throw new Error(typeof data.error === 'string' && data.error ? data.error : 'Not approved')
  if (typeof data.id !== 'string' || (data.kind !== 'pay_in' && data.kind !== 'pay_out') || !isNum(data.amountSen)) return unexpected()
  return { id: data.id, kind: data.kind, amountSen: data.amountSen }
}

export function parseShiftList(data: unknown): ShiftListRow[] {
  if (!Array.isArray(data)) return unexpected()
  return data.map((r) => {
    if (!isObj(r) || typeof r.id !== 'string' || typeof r.openedAt !== 'string' || typeof r.closedAt !== 'string'
        || !isNum(r.nettSen) || !isNum(r.varianceSen)) return unexpected()
    return { id: r.id, openedAt: r.openedAt, closedAt: r.closedAt, openedBy: strOrNull(r.openedBy), closedBy: strOrNull(r.closedBy),
      nettSen: r.nettSen, varianceSen: r.varianceSen }
  })
}

const MYT_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit', hour12: false })

/** "09:02", Malaysia time. */
export function mytTime(iso: string): string {
  return MYT_TIME.format(new Date(iso))
}

/** The top bar's words for the shift. */
export function shiftLabel(s: ShiftStatus): string {
  return s.shift ? `Shift open · since ${mytTime(s.shift.openedAt)}` : 'No shift open'
}

/** The amber note: a shift open more than 20 hours (by the server's clock) was not closed last night. */
export function staleShiftNote(s: ShiftStatus): string | null {
  if (!s.shift) return null
  const hours = (Date.parse(s.now) - Date.parse(s.shift.openedAt)) / 3_600_000
  return hours > SHIFT_STALE_HOURS ? 'This shift was opened yesterday — close it' : null
}

/** Close shift's first screen: open bills are not closed with the shift. */
export function openBillsWarning(n: number): string | null {
  if (n <= 0) return null
  return n === 1 ? '1 bill is still open — it stays open for the next shift'
    : `${n} bills are still open — they stay open for the next shift`
}

/** 1250 → "12.50", for prefilling an amount field. */
export function senToText(sen: number): string {
  return (sen / 100).toFixed(2)
}

/** The opening float: RM 0.00 to RM 100000.00. */
export function floatProblem(text: string): string | null {
  const sen = parseRinggit(text)
  return sen === null || sen > MAX_CASH_SEN ? 'Enter the opening float (RM 0.00 to RM 100000.00)' : null
}

/** The blind count: RM 0.00 to RM 100000.00. */
export function countProblem(text: string): string | null {
  const sen = parseRinggit(text)
  return sen === null || sen > MAX_CASH_SEN ? 'Enter the counted cash (RM 0.00 to RM 100000.00)' : null
}

/** Pay in / Pay out: an amount from RM 0.01 to RM 100000.00 and a reason, as record_cash_move says. */
export function cashMoveProblem(amountText: string, reason: string): string | null {
  const sen = parseRinggit(amountText)
  if (sen === null || sen <= 0 || sen > MAX_CASH_SEN) return 'Enter the amount (RM 0.01 to RM 100000.00)'
  if (!reason.trim()) return 'Enter a reason'
  if (reason.trim().length > 200) return 'Reason is too long'
  return null
}

/** The cash variance limit on POS settings: RM 0.00 to RM 10000.00. */
export function limitProblem(text: string): string | null {
  const sen = parseRinggit(text)
  return sen === null || sen > 1_000_000 ? 'Enter a cash variance limit between RM 0.00 and RM 10000.00' : null
}

/** −615 → "Short RM 6.15", 50 → "Over RM 0.50", 0 → "Exact". */
export function varianceLabel(sen: number): string {
  if (sen === 0) return 'Exact'
  return sen < 0 ? `Short ${formatSen(-sen)}` : `Over ${formatSen(sen)}`
}

/** Why the close sheet asks for a supervisor: this count is off by more than the limit, or the
 *  first count was (a new count corrects the figure, the approval stays — close_shift's rule). */
export function approvalNote(check: { varianceSen: number; limitSen: number }): string {
  const limit = formatSen(check.limitSen)
  return Math.abs(check.varianceSen) > check.limitSen
    ? `More than ${limit} off: a supervisor approves the difference with a reason. If you miscounted, count again — the approval is still needed.`
    : `A supervisor still approves, because the first count was more than ${limit} off.`
}

/** The close refusal that leaves a cashier without the report (a resend with another count
 *  after a lost reply) says where the report is. */
export function closeShiftError(m: string): string {
  return m === 'This shift is already closed' ? `${m} — a supervisor can open its Z report under Shifts` : m
}

export function printedNote(printed: boolean): string {
  return printed ? 'Z report sent to the receipt printer' : 'Not printed — no receipt printer set'
}

/** After a refused pay in / pay out, what is recorded under its id: 'unsure' (no reply — keep the
 *  move, its id and its fields until the server answers), 'recorded' (a resend that does not match:
 *  the id holds another move, the fields stay fixed, a reopen starts afresh) or 'nothing' (every
 *  other refusal: a new id, the fields unlocked). */
export type MoveRefusal = 'unsure' | 'recorded' | 'nothing'
export function moveRefusal(m: string): MoveRefusal {
  if (looksOffline(m)) return 'unsure'
  return m.startsWith('This was already recorded') ? 'recorded' : 'nothing'
}

/** The words for a pay in / pay out sent with no reply, by the button that sends it again. */
export const LOST_MOVE_NOTE: Record<CashMoveKind, string> = {
  pay_in: 'Not sure it was recorded (no reply). Press Record again — it will not be recorded twice.',
  pay_out: 'Not sure it was recorded (no reply). Press Approve again — it will not be recorded twice.',
}

/** A pay in / pay out sent with no reply. The top bar keeps it while the sheet is closed, so Cancel
 *  and reopen resume the same id with the same fields — never a second record. */
export interface PendingMove { id: string; kind: CashMoveKind; amountText: string; reason: string }

/** How the Pay in / Pay out sheet starts: afresh with a new id, or resuming the unanswered move. */
export function resumeMove(pending: PendingMove | null, newId: string) {
  if (!pending) return { id: newId, kind: 'pay_in' as CashMoveKind, amountText: '', reason: '', unsure: false, note: null }
  const amount = formatSen(parseRinggit(pending.amountText) ?? 0)
  const again = pending.kind === 'pay_in' ? 'Record pay in' : 'Next: approval, then Approve'
  return {
    ...pending, unsure: true,
    note: `Not sure the last ${KIND_LABEL[pending.kind].toLowerCase()} of ${amount} was recorded (no reply). Press ${again} — it will not be recorded twice.`,
  }
}
