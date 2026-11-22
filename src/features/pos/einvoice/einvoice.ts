// Pure rules behind the E-invoice screen: the company form, which documents still
// need the owner, and what Retry sends to the `einvoice` Edge Function.
// Design: docs/superpowers/specs/2026-10-26-myinvois-einvoice-design.md

export const SETTINGS_FIELDS = [
  'supplier_name', 'supplier_tin', 'supplier_brn', 'supplier_sst_no', 'supplier_ttx_no',
  'msic_code', 'business_activity', 'address_line', 'city', 'postcode', 'state_code', 'phone', 'email',
] as const
export type SettingsField = (typeof SETTINGS_FIELDS)[number]
export type SettingsForm = Record<SettingsField, string>
export type CleanSettings = Record<SettingsField, string | null>

/** Same list the Edge Function refuses to submit without (REQUIRED in index.ts). */
const REQUIRED: SettingsField[] = [
  'supplier_name', 'supplier_tin', 'supplier_brn', 'msic_code', 'business_activity',
  'address_line', 'city', 'state_code', 'phone',
]

/** LHDN state codes (e-Invoice code list). */
export const STATE_CODES: { code: string; name: string }[] = [
  { code: '01', name: 'Johor' }, { code: '02', name: 'Kedah' }, { code: '03', name: 'Kelantan' },
  { code: '04', name: 'Melaka' }, { code: '05', name: 'Negeri Sembilan' }, { code: '06', name: 'Pahang' },
  { code: '07', name: 'Pulau Pinang' }, { code: '08', name: 'Perak' }, { code: '09', name: 'Perlis' },
  { code: '10', name: 'Selangor' }, { code: '11', name: 'Terengganu' }, { code: '12', name: 'Sabah' },
  { code: '13', name: 'Sarawak' }, { code: '14', name: 'WP Kuala Lumpur' }, { code: '15', name: 'WP Labuan' },
  { code: '16', name: 'WP Putrajaya' }, { code: '17', name: 'Not applicable' },
]

export const emptySettings = (): SettingsForm =>
  Object.fromEntries(SETTINGS_FIELDS.map((f) => [f, ''])) as SettingsForm

/** A database row (nulls allowed) as form strings. */
export const toForm = (row: Partial<Record<SettingsField, string | null>> | null): SettingsForm => {
  const form = emptySettings()
  for (const f of SETTINGS_FIELDS) form[f] = row?.[f] ?? ''
  if (form.supplier_sst_no === 'NA') form.supplier_sst_no = ''
  if (form.supplier_ttx_no === 'NA') form.supplier_ttx_no = ''
  return form
}

/** The row to save: trimmed, blanks as null, LHDN's "NA" for no SST / tourism tax number. */
export function cleanSettings(form: SettingsForm): CleanSettings {
  const out = {} as CleanSettings
  for (const f of SETTINGS_FIELDS) out[f] = form[f].trim() || null
  out.supplier_tin = out.supplier_tin?.toUpperCase().replace(/\s+/g, '') ?? null
  out.supplier_brn = out.supplier_brn?.replace(/[\s-]+/g, '') ?? null
  out.phone = out.phone?.replace(/[\s-]+/g, '') ?? null
  out.supplier_sst_no = out.supplier_sst_no?.toUpperCase() ?? 'NA'
  out.supplier_ttx_no = out.supplier_ttx_no?.toUpperCase() ?? 'NA'
  return out
}

/** Field → message. Empty object means the company is ready to submit. */
export function checkSettings(s: CleanSettings): Partial<Record<SettingsField, string>> {
  const errs: Partial<Record<SettingsField, string>> = {}
  for (const f of REQUIRED) if (!s[f]) errs[f] = 'Required'
  const bad = (f: SettingsField, ok: boolean, msg: string) => { if (s[f] && !ok) errs[f] = msg }
  bad('supplier_tin', /^[A-Z]{1,2}\d{8,12}$/.test(s.supplier_tin ?? ''), 'A TIN looks like C12345678090')
  bad('supplier_brn', /^\d{12}$/.test(s.supplier_brn ?? ''), 'Use the 12-digit SSM number, e.g. 201901012345')
  bad('msic_code', /^\d{5}$/.test(s.msic_code ?? ''), 'MSIC is 5 digits')
  bad('state_code', /^(0[1-9]|1[0-7])$/.test(s.state_code ?? ''), 'Pick a state')
  bad('postcode', /^\d{5}$/.test(s.postcode ?? ''), 'Postcode is 5 digits')
  bad('phone', /^\+?\d{8,15}$/.test(s.phone ?? ''), 'Digits only, e.g. +60123456789')
  bad('email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email ?? ''), 'Not an email address')
  return errs
}

// ── Documents ───────────────────────────────────────────────────────────────
export type DocKind = 'invoice' | 'credit_note' | 'consolidated_invoice' | 'consolidated_credit_note'
export type DocStatus = 'draft' | 'submitted' | 'valid' | 'invalid' | 'rejected' | 'cancelled'

export interface EinvoiceDoc {
  id: string
  kind: DocKind
  environment: 'sandbox' | 'production'
  branch_id: string
  code_number: string
  bill_id: string | null
  period_start: string | null
  period_end: string | null
  buyer: unknown
  total_sen: number
  status: DocStatus
  errors: unknown
  created_at: string
  lhdn_uuid: string | null
  long_id: string | null
  /** A draft with needs_check: LHDN's answer to a send is unknown (reason in `errors`); never resent automatically.
   *  A submitted document with needs_check: LHDN reported a status we do not know. */
  needs_check?: boolean | null
  send_started_at?: string | null
  /** Joined for display; absent in tests. */
  bill?: { bill_no: string } | null
}

export const KIND_LABEL: Record<DocKind, string> = {
  invoice: 'E-invoice',
  credit_note: 'Credit note',
  consolidated_invoice: 'Monthly consolidated',
  consolidated_credit_note: 'Monthly credit note',
}

/** What a document covers: a branch's month, or one bill. Later documents for the same key replace earlier ones. */
const coverKey = (d: EinvoiceDoc) =>
  d.kind.startsWith('consolidated') ? `${d.kind}|${d.branch_id}|${d.period_start}` : `${d.kind}|${d.bill_id}`

/** A draft whose send has an unknown answer (check the MyInvois portal, then Send again). */
export const isNeedsCheck = (d: EinvoiceDoc) => d.status === 'draft' && d.needs_check === true

/** A submitted document LHDN reports an unknown status for: it keeps its bills; check the portal (no Send again). */
export const isUnexpectedStatus = (d: EinvoiceDoc) => d.status === 'submitted' && d.needs_check === true

/** A draft LHDN did not take (busy, rate limit, no token): the claim was cleared and the next run sends it again. */
export const isWaitingToResend = (d: EinvoiceDoc) =>
  d.status === 'draft' && d.needs_check !== true && !d.send_started_at && d.errors != null

/** Only LHDN's own no needs the owner; a draft is never "not accepted". */
const needsOwner = (d: EinvoiceDoc) => d.status === 'rejected' || d.status === 'invalid'

function latestPerCover(docs: EinvoiceDoc[]): EinvoiceDoc[] {
  const latest = new Map<string, EinvoiceDoc>()
  for (const d of docs) {
    const k = coverKey(d)
    const cur = latest.get(k)
    if (!cur || d.created_at > cur.created_at) latest.set(k, d)
  }
  return [...latest.values()]
}

const newestFirst = (a: EinvoiceDoc, b: EinvoiceDoc) => b.created_at.localeCompare(a.created_at)

/** Documents whose latest attempt failed — the only ones the owner has to look at. */
export function openProblems(docs: EinvoiceDoc[]): EinvoiceDoc[] {
  return latestPerCover(docs).filter(needsOwner).sort(newestFirst)
}

/** Latest documents to check in the MyInvois portal: needs-check drafts and unexpected statuses. */
export const needsCheckDocs = (docs: EinvoiceDoc[]): EinvoiceDoc[] =>
  latestPerCover(docs).filter((d) => isNeedsCheck(d) || isUnexpectedStatus(d)).sort(newestFirst)

export const NEEDS_CHECK_COPY = 'Check the MyInvois portal for this document. If it is not there, press Send again.'
export const UNEXPECTED_STATUS_COPY = 'LHDN reports an unexpected status for this document. Check the MyInvois portal.'
export const WAITING_TO_RESEND_COPY = 'Waiting to be sent again'

export interface Retry { label: string; body: Record<string, unknown> }

/** The Edge Function call that moves this document forward, or null when there is nothing to do. */
export function retryFor(d: EinvoiceDoc): Retry | null {
  if (isNeedsCheck(d)) return { label: 'Send again', body: { action: 'resend', documentId: d.id } }
  if (d.status === 'draft') return { label: 'Resend', body: { action: 'refresh', documentId: d.id } }
  if (d.status === 'submitted') return { label: 'Check with LHDN', body: { action: 'refresh', documentId: d.id } }
  if (d.status !== 'rejected' && d.status !== 'invalid') return null
  if (d.kind === 'consolidated_invoice' && d.period_start) {
    return { label: 'Retry', body: { action: 'consolidate', branchId: d.branch_id, month: d.period_start.slice(0, 7) } }
  }
  if (d.kind === 'invoice' && d.bill_id) {
    return { label: 'Retry', body: { action: 'submit_bill', billId: d.bill_id, buyer: d.buyer ?? undefined } }
  }
  if (d.kind === 'credit_note' || d.kind === 'consolidated_credit_note') {
    return { label: 'Retry', body: { action: 'credit_notes' } }   // its refunds were given back: issue what is due
  }
  return null
}

/** LHDN's error payloads vary by endpoint; pull out something a person can read. */
export function errorText(errors: unknown): string {
  if (errors == null) return ''
  if (typeof errors === 'string') return errors
  const found: string[] = []
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || found.length >= 3 || v == null) return
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return }
    if (typeof v !== 'object') return
    const o = v as Record<string, unknown>
    for (const key of ['message', 'error', 'details']) {
      const m = o[key]
      if (typeof m === 'string' && m.trim()) { found.push(m.trim()); return }
    }
    Object.values(o).forEach((x) => walk(x, depth + 1))
  }
  walk(errors, 0)
  return found.length ? found.join(' · ') : JSON.stringify(errors).slice(0, 200)
}

// ── Outlet start dates (W5.3) ───────────────────────────────────────────────
export const LIVE_STATUSES: DocStatus[] = ['draft', 'submitted', 'valid']

export const hasLiveDocument = (docs: EinvoiceDoc[], branchId: string) =>
  docs.some((d) => d.branch_id === branchId && LIVE_STATUSES.includes(d.status))

export const START_DATE_LOCKED = 'E-invoices were already sent for this outlet: the start date can only move later.'

/** The screen's copy of branches_einvoice_from_guard; null = fine to save. '' clears the date. */
export function startDateProblem(next: string, current: string | null, live: boolean): string | null {
  if (next !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(next)) return 'Pick a date'
  if (live && current && (next === '' || next < current)) return START_DATE_LOCKED
  return null
}

// ── The buyer of a bill over RM 10,000 (W5.6) ───────────────────────────────
export type BuyerIdType = 'BRN' | 'NRIC' | 'PASSPORT' | 'ARMY'
export const BUYER_ID_TYPES: { value: BuyerIdType; label: string }[] = [
  { value: 'BRN', label: 'Company (SSM no.)' }, { value: 'NRIC', label: 'MyKad (IC no.)' },
  { value: 'PASSPORT', label: 'Passport' }, { value: 'ARMY', label: 'Army / police ID' },
]

export interface BuyerForm {
  name: string; tin: string; idType: BuyerIdType; idValue: string; email: string; phone: string
  addressLine: string; city: string; postcode: string; stateCode: string
}

export const emptyBuyer = (): BuyerForm => ({
  name: '', tin: '', idType: 'BRN', idValue: '', email: '', phone: '', addressLine: '', city: '', postcode: '', stateCode: '',
})

const cleanTin = (v: string) => v.trim().toUpperCase().replace(/\s+/g, '')

/** The `buyer` submit_bill reads (buyerParty in supabase/functions/einvoice/index.ts). */
export function buyerPayload(f: BuyerForm) {
  const t = (v: string) => v.trim() || undefined
  return {
    name: f.name.trim(), tin: cleanTin(f.tin), idType: f.idType, idValue: f.idValue.trim().replace(/[\s-]+/g, ''),
    email: t(f.email), phone: f.phone.replace(/[\s-]+/g, '') || undefined,
    address: { line: t(f.addressLine), city: t(f.city), postcode: t(f.postcode), stateCode: f.stateCode || undefined },
  }
}

export function checkBuyer(f: BuyerForm): Partial<Record<keyof BuyerForm, string>> {
  const errs: Partial<Record<keyof BuyerForm, string>> = {}
  if (!f.name.trim()) errs.name = 'Required'
  const tin = cleanTin(f.tin)
  if (!tin) errs.tin = 'Required'
  else if (!/^[A-Z]{1,2}\d{8,12}$/.test(tin)) errs.tin = 'A TIN looks like C12345678090 or IG12345678901'
  if (!f.idValue.trim()) errs.idValue = 'Required'
  if (f.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) errs.email = 'Not an email address'
  if (f.postcode.trim() && !/^\d{5}$/.test(f.postcode.trim())) errs.postcode = 'Postcode is 5 digits'
  return errs
}

export interface LargeBill { id: string; branch_id: string; bill_no: string; day: string; total_sen: number }

// ── The daily run (W5.4) ────────────────────────────────────────────────────
interface JobStepJson { key: string; outcome: string; codeNumber?: string; error?: string }
/** einvoice_job_runs.report: the JobReport of supabase/functions/einvoice/job.ts. */
export interface JobReportJson {
  setUp?: boolean
  notSetUp?: string
  refreshed?: { codeNumber: string; status: string }[]
  consolidated?: JobStepJson[]
  creditNotes?: JobStepJson[]
  errors?: string[]
}
export interface JobRun {
  id: string
  started_at: string
  /** null while running, and forever for a run killed half-way. */
  finished_at?: string | null
  environment: 'sandbox' | 'production'
  outcome: 'running' | 'not_set_up' | 'ok' | 'errors'
  report: JobReportJson
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** A run still 'running' after this long was killed (an Edge Function lives minutes, not this). */
export const RUN_UNFINISHED_MS = 30 * 60_000

export function runSummary(r: JobRun, now: Date = new Date()): string {
  if (r.outcome === 'running') {
    return now.getTime() - new Date(r.started_at).getTime() < RUN_UNFINISHED_MS
      ? 'Running…'
      : 'Did not finish — it stopped before saving what it did'
  }
  if (r.outcome === 'not_set_up') return `Not set up — nothing sent${r.report.notSetUp ? ` (${r.report.notSetUp})` : ''}`
  const rep = r.report
  const sent = (l?: JobStepJson[]) => (l ?? []).filter((x) => x.outcome === 'issued').length
  const problems = (rep.errors?.length ?? 0)
    + [...(rep.consolidated ?? []), ...(rep.creditNotes ?? [])].filter((x) => ['rejected', 'refused', 'stopped'].includes(x.outcome)).length
  const later = (rep.consolidated ?? []).filter((x) => x.outcome === 'later').length
  return [
    `${rep.refreshed?.length ?? 0} checked with LHDN`,
    `${sent(rep.consolidated)} monthly sent`,
    `${plural(sent(rep.creditNotes), 'credit note')} sent`,
    ...(later ? [`${plural(later, 'month')} left for the next run`] : []),
    ...(problems ? [plural(problems, 'problem')] : []),
  ].join(' · ')
}

// ── Stopped attempts (einvoice_job_attempts) ────────────────────────────────
export const STOP_AT = 3

export interface Attempt {
  key: string
  kind: 'consolidated_invoice' | 'consolidated_credit_note' | 'credit_note'
  branch_id: string
  period_start: string | null
  refund_id: string | null
  failures: number
  last_error: string | null
  updated_at: string
}

/** What Retry sends for an attempt the daily run stopped. */
export function retryForAttempt(a: Attempt): Retry {
  if (a.kind === 'consolidated_invoice' && a.period_start) {
    return { label: 'Retry', body: { action: 'consolidate', branchId: a.branch_id, month: a.period_start.slice(0, 7) } }
  }
  return { label: 'Retry', body: { action: 'credit_notes' } }
}

// ── Closed months not reported yet (einvoice_unreported_months) ────────────
/** One outlet's closed business month with bills in no live document; month = its first day (YYYY-MM-DD). */
export interface UnreportedMonth { branch_id: string; month: string; bills: number; total_sen: number }

/** The business month (YYYY-MM) of a moment: 06:00–05:59 Malaysia time, as the Edge Function's businessDay. */
export const businessMonthOf = (at: Date) => new Date(at.getTime() + 2 * 3600_000).toISOString().slice(0, 7)

/**
 * The months that are overdue: the daily run has had its chance (a run started after the month closed) and the
 * month is still not reported. Just after 06:00 on the 1st, last month is not overdue until the 07:00 run.
 */
export function overdueMonths(months: UnreportedMonth[], lastRun: JobRun | null): UnreportedMonth[] {
  if (!lastRun) return months
  const ranIn = businessMonthOf(new Date(lastRun.started_at))
  return months.filter((m) => m.month.slice(0, 7) < ranIn)
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const rmText = (sen: number) => `RM ${(sen / 100).toFixed(2)}`

/** "<Outlet> · <Month YYYY> · n bills · RM x.xx" */
export const unreportedLabel = (m: UnreportedMonth, outlet: string) =>
  `${outlet} · ${MONTHS[Number(m.month.slice(5, 7)) - 1]} ${m.month.slice(0, 4)} · ${plural(m.bills, 'bill')} · ${rmText(m.total_sen)}`

export const retryForMonth = (m: UnreportedMonth): Retry =>
  ({ label: 'Retry', body: { action: 'consolidate', branchId: m.branch_id, month: m.month.slice(0, 7) } })

// ── The banner (W5.7) ───────────────────────────────────────────────────────
export interface BannerInput {
  docs: EinvoiceDoc[]; stopped: Attempt[]; largeBills: LargeBill[]; lastRun: JobRun | null
  unreported: UnreportedMonth[]; outlets: { einvoice_from: string | null }[]; now: Date
}

/** The daily run is late after this long without a run (a day's run plus a day's grace). */
export const RUN_LATE_MS = 48 * 3600_000

export function bannerMessages(i: BannerInput): string[] {
  const out: string[] = []
  const rejected = openProblems(i.docs).length
  if (rejected) out.push(`LHDN did not accept ${rejected === 1 ? 'an e-invoice' : `${rejected} e-invoices`}.`)
  const stopped = i.stopped.filter((a) => a.failures >= STOP_AT).length
  if (stopped) out.push(`${stopped === 1 ? 'An e-invoice run' : `${stopped} e-invoice runs`} stopped after ${STOP_AT} failed attempts.`)
  if (overdueMonths(i.unreported, i.lastRun).length) out.push("Some months' sales have not been reported to LHDN yet.")
  const large = i.largeBills.length
  if (large) {
    out.push(`${large === 1 ? 'A bill' : `${large} bills`} over RM 10,000 ${large === 1 ? 'needs' : 'need'} the buyer's details for an individual e-invoice.`)
  }
  if (i.lastRun?.outcome === 'not_set_up' && i.lastRun.environment === 'production') {
    out.push('E-invoicing is not set up: nothing is being sent to LHDN.')
  }
  const reporting = i.outlets.some((o) => o.einvoice_from)
  if (reporting && (!i.lastRun || i.now.getTime() - new Date(i.lastRun.started_at).getTime() > RUN_LATE_MS)) {
    out.push('The daily e-invoice run has not run for 2 days.')
  }
  if (needsCheckDocs(i.docs).length) out.push('An e-invoice needs checking in the MyInvois portal.')
  return out
}
