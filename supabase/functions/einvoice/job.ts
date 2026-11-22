// The daily run (spec W5.4) as decisions over injected steps, so vitest can drive it; index.ts wires the
// steps to the database and LHDN. Also the business-day calendar, the attempt keys and the job secret check.
// Pure: no Deno, Node or network.
// Design: docs/superpowers/specs/2026-10-26-myinvois-einvoice-design.md (W5.4, W5.5)

import type { PendingRefund } from './documents.ts'

export const MAX_ATTEMPTS = 3
/** At most this many outlet-months are consolidated in one run; the rest are reported as 'later' for the next run. */
export const MAX_CONSOLIDATIONS_PER_RUN = 6

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

/** A real calendar day written YYYY-MM-DD (2026-02-30 and 2026-13-01 are not). */
export function isRealDay(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

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
 *  refused: we did not send (a check failed, or an error). A line can also be stopped (3 failures) or
 *  later (over this run's bound, left for the next run). */
export interface StepResult {
  outcome: 'issued' | 'waiting' | 'nothing' | 'rejected' | 'refused'
  codeNumber?: string
  status?: string
  error?: string
}
export interface StepLine {
  key: string
  outcome: StepResult['outcome'] | 'stopped' | 'later'
  codeNumber?: string
  status?: string
  error?: string
}

/** refundId: a single credit note's refund, read before a refresh can release the link. */
export interface PendingDoc {
  id: string; codeNumber: string; kind: string; branchId: string; periodStart: string | null; status: string
  refundId: string | null
}

export interface JobSteps {
  /** ok, or why nothing may be sent (no credentials, company details missing, production unsigned). */
  setUp(): Promise<{ ok: true } | { ok: false; reason: string }>
  /** Drafts and submitted documents of the current environment. */
  pendingDocuments(): Promise<PendingDoc[]>
  refresh(doc: PendingDoc): Promise<{ status: string }>
  /** Closed business months (YYYY-MM) of outlets with a start date that still have unreported bills, oldest first. */
  unreportedMonths(): Promise<{ branchId: string; month: string }[]>
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

/** LHDN turning down a document the run issued counts against its outlet-month, or its refund. */
export function refOfDocument(d: PendingDoc): AttemptRef | null {
  if (d.kind === 'credit_note') return d.refundId ? cnRef(d.branchId, d.refundId) : null
  if (!d.periodStart) return null
  if (d.kind === 'consolidated_invoice') return conRef(d.branchId, monthOf(d.periodStart))
  if (d.kind === 'consolidated_credit_note') return ccnRef(d.branchId, monthOf(d.periodStart))
  return null
}

/**
 * One counted try: skipped at MAX_ATTEMPTS (unless forced); a refusal or rejection adds one. Only a document
 * LHDN found valid (here or when refreshed), nothing left to do, or the owner's forced Retry resets the count:
 * a submitted document may still turn invalid, and resetting the daily run's count then would re-issue it forever.
 */
async function attempt(s: JobSteps, ref: AttemptRef, run: () => Promise<StepResult>, force: boolean): Promise<StepLine> {
  const failures = await s.failures(ref.key)
  if (!force && failures >= MAX_ATTEMPTS) return { key: ref.key, outcome: 'stopped' }
  let r: StepResult
  try {
    r = await run()
  } catch (e) {
    r = { outcome: 'refused', error: message(e) }
  }
  // the owner's Retry (force) is their call: a document sent clears the stop, as the manual consolidate does
  const settled = r.outcome === 'nothing' || (r.outcome === 'issued' && (force || r.status === 'valid'))
  if (r.outcome === 'rejected' || r.outcome === 'refused') await s.record(ref, false, r.error ?? r.outcome)
  else if (settled && failures > 0) await s.record(ref, true, null)
  return { key: ref.key, ...r }
}

/** One attempt whose own bookkeeping can fail: the error goes to the report and the loop goes on. */
async function attemptInto(
  lines: StepLine[], report: JobReport, s: JobSteps, ref: AttemptRef, run: () => Promise<StepResult>, force: boolean,
): Promise<StepLine | null> {
  try {
    const line = await attempt(s, ref, run, force)
    lines.push(line)
    return line
  } catch (e) {
    report.errors.push(`${ref.key}: ${message(e)}`)
    return null
  }
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
      } else if (ref && after.status === 'valid' && (await s.failures(ref.key)) > 0) {
        await s.record(ref, true, null)
      }
    } catch (e) {
      report.errors.push(`${d.codeNumber}: ${message(e)}`)
    }
  }
}

/**
 * Step 2, every day: each closed business month that still has unreported bills, oldest first (last month's
 * goes out on the 1st; a missed run, a killed run or a start date set into a past month is caught up). At most
 * MAX_CONSOLIDATIONS_PER_RUN tries per run — a stopped key costs no try — and the rest are reported as later.
 */
export async function runConsolidation(s: JobSteps, report: JobReport): Promise<void> {
  let months: { branchId: string; month: string }[]
  try {
    months = await s.unreportedMonths()
  } catch (e) {
    report.errors.push(`Consolidation: ${message(e)}`)
    return
  }
  const oldestFirst = [...months].sort((a, b) => a.month.localeCompare(b.month) || a.branchId.localeCompare(b.branchId))
  let tried = 0
  for (const m of oldestFirst) {
    const ref = conRef(m.branchId, m.month)
    if (tried >= MAX_CONSOLIDATIONS_PER_RUN) {
      report.consolidated.push({ key: ref.key, outcome: 'later' })
      continue
    }
    const line = await attemptInto(report.consolidated, report, s, ref, () => s.consolidate(m.branchId, m.month), false)
    if (line?.outcome !== 'stopped') tried++
  }
}

/** Step 3: single credit notes, then one consolidated credit note per outlet and past month with refunds due. */
export async function runCreditNotes(s: JobSteps, report: JobReport, day: string, force = false): Promise<void> {
  try {
    for (const r of await s.singleRefunds()) {
      await attemptInto(report.creditNotes, report, s, cnRef(r.branchId, r.refundId), () => s.creditNote(r), force)
    }
    for (const m of await s.refundMonths(`${monthOf(day)}-01`)) {
      await attemptInto(report.creditNotes, report, s, ccnRef(m.branchId, m.month),
        () => s.consolidatedCreditNote(m.branchId, m.month), force)
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
  await runConsolidation(s, report)
  await runCreditNotes(s, report, day)
  return report
}

// ── Reading LHDN's verdict ──────────────────────────────────────────────────
/** LHDN's document status as our action: only Cancelled cancels (and frees the bills); anything we do not
 *  know keeps the document submitted and flags it for a check in the MyInvois portal. */
export type RefreshVerdict = 'waiting' | 'valid' | 'invalid' | 'cancelled' | 'unexpected'

export function refreshVerdict(status: unknown): RefreshVerdict {
  switch (status) {
    case 'Submitted': return 'waiting'
    case 'Valid': return 'valid'
    case 'Invalid': return 'invalid'
    case 'Cancelled': return 'cancelled'
    default: return 'unexpected'
  }
}

// ── Sending a draft exactly once ────────────────────────────────────────────
/** What a failed submit means: release = LHDN did not take it (send again next run); rejected = a clear no
 *  (a 4xx whose body is LHDN's error envelope); needs_check = we cannot know whether LHDN has it (422
 *  duplicate, other 5xx, network after sending, a 4xx from a proxy or firewall: no body, or not LHDN's). */
export type FailureVerdict = 'release' | 'rejected' | 'needs_check'

/** Error codes LHDN's submit endpoint answers with (MyInvois SDK, Submit Documents). */
const LHDN_ERROR_CODES = new Set(['BadStructure', 'MaximumSizeExceeded', 'IncorrectSubmitter', 'BadArgument', 'DuplicateSubmission'])

/** LHDN's error envelope: a JSON object with an `error` field, or one carrying a known LHDN error code. */
export function isLhdnErrorBody(body: unknown): boolean {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return false
  const b = body as Record<string, unknown>
  if (b.error != null && b.error !== '') return true
  return typeof b.code === 'string' && LHDN_ERROR_CODES.has(b.code)
}

export function submitFailureVerdict(e: unknown): FailureVerdict {
  const x = (e ?? {}) as { status?: unknown; notSent?: unknown; body?: unknown }
  if (x.notSent === true) return 'release'
  const s = typeof x.status === 'number' ? x.status : null
  if (s === 429 || s === 503 || s === 401) return 'release'
  if (s === 422) return 'needs_check'
  if (s !== null && s >= 400 && s < 500 && isLhdnErrorBody(x.body)) return 'rejected'
  return 'needs_check'
}

/** Drafts claimed longer ago than this and still draft have an unknown answer. */
export const STALE_SEND_MS = 15 * 60_000

export interface SubmitReply {
  submissionUid: string | null
  accepted: { uuid: string; codeNumber: string }[]
  rejected: { codeNumber: string; error: unknown }[]
}

/** Everything sendDraft does to the outside; each port is one write or call. */
export interface SendPorts<R> {
  claim(): Promise<boolean>
  lost(): Promise<R>
  submit(): Promise<SubmitReply>
  markSubmitted(uuid: string, submissionUid: string | null): Promise<R>
  markRejected(errors: unknown): Promise<R>
  releaseLinks(): Promise<void>
  markNeedsCheck(errors: unknown): Promise<R>
  clearClaim(errors: unknown): Promise<R>
}

const detailOf = (e: unknown) => ({
  message: message(e),
  ...(typeof (e as any)?.status === 'number' ? { status: (e as any).status, body: (e as any).body } : {}),
})

/**
 * Claim the draft, and only the winner submits. Classification first, then the database: a clear rejection
 * saves its status BEFORE giving the bills back (a failed save must never leave a draft without its bills);
 * a database error never releases anything and never clears the claim, so the daily run flags the draft
 * for a check. If LHDN accepted but saving fails twice, the thrown error carries LHDN's identifiers.
 */
export async function sendDraft<R>(codeNumber: string, p: SendPorts<R>): Promise<R> {
  if (!(await p.claim())) return p.lost()
  let r: SubmitReply
  try {
    r = await p.submit()
  } catch (e) {
    const verdict = submitFailureVerdict(e)
    if (verdict === 'rejected') {
      const out = await p.markRejected(detailOf(e))
      await p.releaseLinks()
      return out
    }
    return verdict === 'release' ? p.clearClaim(detailOf(e)) : p.markNeedsCheck(detailOf(e))
  }
  const ok = r.accepted.find((a) => a.codeNumber === codeNumber)
  if (ok && !r.submissionUid) {
    // Without the submission id its status can never be read: never "submitted", someone has to look.
    return p.markNeedsCheck({ message: `LHDN accepted ${codeNumber} (uuid ${ok.uuid}) but gave no submission id`, uuid: ok.uuid })
  }
  if (ok) {
    try {
      return await p.markSubmitted(ok.uuid, r.submissionUid)
    } catch {
      try {
        return await p.markSubmitted(ok.uuid, r.submissionUid)
      } catch (e2) {
        throw new Error(`LHDN accepted ${codeNumber} (uuid ${ok.uuid}, submission ${r.submissionUid ?? 'unknown'}) but saving it failed: ${message(e2)}`)
      }
    }
  }
  if (r.rejected.some((x) => x.codeNumber === codeNumber)) {
    const out = await p.markRejected(r.rejected)
    await p.releaseLinks()
    return out
  }
  return p.markNeedsCheck({ message: 'LHDN answered without naming this document' })
}
