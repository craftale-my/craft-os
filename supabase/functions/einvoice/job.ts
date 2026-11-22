// The daily run (spec W5.4) as decisions over injected steps, so vitest can drive it; index.ts wires the
// steps to the database and LHDN. Also the business-day calendar, the attempt keys and the job secret check.
// Pure: no Deno, Node or network.
// Design: docs/superpowers/specs/2026-10-26-myinvois-einvoice-design.md (W5.4, W5.5)

import type { PendingRefund } from './documents.ts'

export const MAX_ATTEMPTS = 3

/** The business day (06:00–05:59 Malaysia time, as Reports) of a moment, YYYY-MM-DD: UTC + 8 h − 6 h. */
export const businessDay = (at: Date): string => new Date(at.getTime() + 2 * 3600_000).toISOString().slice(0, 10)
export const monthOf = (day: string) => day.slice(0, 7)

export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

/** Days 1–7 of a business month: last month is consolidated (LHDN allows 7 days). */
export const inConsolidationWindow = (day: string) => Number(day.slice(8, 10)) <= 7

/** The pg_cron caller's header against the function secret, in constant time; a short or missing secret never matches. */
export function jobSecretMatches(given: string | null, expected: string | undefined): boolean {
  if (!expected || expected.length < 32 || !given || given.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

// ── What can fail repeatedly (einvoice_job_attempts) ───────────────────────
export type AttemptKind = 'consolidated_invoice' | 'consolidated_credit_note' | 'credit_note'
export interface AttemptRef { key: string; kind: AttemptKind; branchId: string; periodStart: string | null; refundId: string | null }

export const conRef = (branchId: string, month: string): AttemptRef =>
  ({ key: `CON|${branchId}|${month}`, kind: 'consolidated_invoice', branchId, periodStart: `${month}-01`, refundId: null })
export const ccnRef = (branchId: string, month: string): AttemptRef =>
  ({ key: `CCN|${branchId}|${month}`, kind: 'consolidated_credit_note', branchId, periodStart: `${month}-01`, refundId: null })
export const cnRef = (branchId: string, refundId: string): AttemptRef =>
  ({ key: `CN|${refundId}`, kind: 'credit_note', branchId, periodStart: null, refundId })

// ── Steps and their report ──────────────────────────────────────────────────
/** issued: sent (submitted / valid); waiting: a draft to resend; nothing: no work; rejected: LHDN said no;
 *  refused: we did not send (a check failed, or an error). */
export interface StepResult {
  outcome: 'issued' | 'waiting' | 'nothing' | 'rejected' | 'refused'
  codeNumber?: string
  status?: string
  error?: string
}
export interface StepLine {
  key: string
  outcome: StepResult['outcome'] | 'stopped'
  codeNumber?: string
  status?: string
  error?: string
}

export interface PendingDoc { id: string; codeNumber: string; kind: string; branchId: string; periodStart: string | null; status: string }

export interface JobSteps {
  /** ok, or why nothing may be sent (no credentials, company details missing, production unsigned). */
  setUp(): Promise<{ ok: true } | { ok: false; reason: string }>
  /** Drafts and submitted documents of the current environment. */
  pendingDocuments(): Promise<PendingDoc[]>
  refresh(doc: PendingDoc): Promise<{ status: string }>
  /** Outlets with a start date. */
  outlets(): Promise<{ id: string; einvoiceFrom: string | null }[]>
  failures(key: string): Promise<number>
  record(ref: AttemptRef, ok: boolean, error: string | null): Promise<void>
  consolidate(branchId: string, month: string): Promise<StepResult>
  singleRefunds(): Promise<PendingRefund[]>
  creditNote(refund: PendingRefund): Promise<StepResult>
  /** Outlet-months (YYYY-MM) with consolidated refunds due, before `before` (YYYY-MM-01). */
  refundMonths(before: string): Promise<{ branchId: string; month: string }[]>
  consolidatedCreditNote(branchId: string, month: string): Promise<StepResult>
}

export interface JobReport {
  businessDay: string
  setUp: boolean
  notSetUp?: string
  refreshed: { codeNumber: string; status: string }[]
  consolidated: StepLine[]
  creditNotes: StepLine[]
  errors: string[]
}

export type RunOutcome = 'not_set_up' | 'ok' | 'errors'

export function runOutcome(r: JobReport): RunOutcome {
  if (!r.setUp) return 'not_set_up'
  const bad = (l: StepLine) => l.outcome === 'rejected' || l.outcome === 'refused' || l.outcome === 'stopped'
  return r.errors.length > 0 || r.consolidated.some(bad) || r.creditNotes.some(bad) ? 'errors' : 'ok'
}

export const emptyReport = (day: string): JobReport =>
  ({ businessDay: day, setUp: true, refreshed: [], consolidated: [], creditNotes: [], errors: [] })

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** LHDN turning down a consolidated document counts against its outlet-month. */
export function refOfDocument(d: PendingDoc): AttemptRef | null {
  if (!d.periodStart) return null
  if (d.kind === 'consolidated_invoice') return conRef(d.branchId, monthOf(d.periodStart))
  if (d.kind === 'consolidated_credit_note') return ccnRef(d.branchId, monthOf(d.periodStart))
  return null
}

/** One counted try: skipped at MAX_ATTEMPTS (unless forced); a refusal or rejection adds one; a success resets. */
async function attempt(s: JobSteps, ref: AttemptRef, run: () => Promise<StepResult>, force: boolean): Promise<StepLine> {
  const failures = await s.failures(ref.key)
  if (!force && failures >= MAX_ATTEMPTS) return { key: ref.key, outcome: 'stopped' }
  let r: StepResult
  try {
    r = await run()
  } catch (e) {
    r = { outcome: 'refused', error: message(e) }
  }
  if (r.outcome === 'rejected' || r.outcome === 'refused') await s.record(ref, false, r.error ?? r.outcome)
  else if ((r.outcome === 'issued' || r.outcome === 'nothing') && failures > 0) await s.record(ref, true, null)
  return { key: ref.key, ...r }
}

/** Step 1: every draft is resent and every submitted document asked about. */
export async function runRefresh(s: JobSteps, report: JobReport): Promise<void> {
  let docs: PendingDoc[]
  try {
    docs = await s.pendingDocuments()
  } catch (e) {
    report.errors.push(`Pending documents: ${message(e)}`)
    return
  }
  for (const d of docs) {
    try {
      const after = await s.refresh(d)
      report.refreshed.push({ codeNumber: d.codeNumber, status: after.status })
      const ref = refOfDocument(d)
      if (ref && (after.status === 'invalid' || after.status === 'rejected')) {
        await s.record(ref, false, `LHDN: ${d.codeNumber} is ${after.status}`)
      }
    } catch (e) {
      report.errors.push(`${d.codeNumber}: ${message(e)}`)
    }
  }
}

/** Step 2 (days 1–7): last month for every outlet whose start date is in or before it. */
export async function runConsolidation(s: JobSteps, report: JobReport, day: string): Promise<void> {
  const month = previousMonth(monthOf(day))
  try {
    for (const o of await s.outlets()) {
      if (!o.einvoiceFrom || o.einvoiceFrom > monthEnd(month)) continue
      report.consolidated.push(await attempt(s, conRef(o.id, month), () => s.consolidate(o.id, month), false))
    }
  } catch (e) {
    report.errors.push(`Consolidation: ${message(e)}`)
  }
}

/** Step 3: single credit notes, then one consolidated credit note per outlet and past month with refunds due. */
export async function runCreditNotes(s: JobSteps, report: JobReport, day: string, force = false): Promise<void> {
  try {
    for (const r of await s.singleRefunds()) {
      report.creditNotes.push(await attempt(s, cnRef(r.branchId, r.refundId), () => s.creditNote(r), force))
    }
    for (const m of await s.refundMonths(`${monthOf(day)}-01`)) {
      report.creditNotes.push(await attempt(s, ccnRef(m.branchId, m.month), () => s.consolidatedCreditNote(m.branchId, m.month), force))
    }
  } catch (e) {
    report.errors.push(`Credit notes: ${message(e)}`)
  }
}

/** The daily run. Not set up: nothing is called. A failing step never stops the next. */
export async function runJob(s: JobSteps, now: Date): Promise<JobReport> {
  const day = businessDay(now)
  const report = emptyReport(day)
  const ready = await s.setUp()
  if (!ready.ok) return { ...report, setUp: false, notSetUp: ready.reason }
  await runRefresh(s, report)
  if (inConsolidationWindow(day)) await runConsolidation(s, report, day)
  await runCreditNotes(s, report, day)
  return report
}
