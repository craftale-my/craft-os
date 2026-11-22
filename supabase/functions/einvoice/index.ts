// Edge Function: einvoice
//
// The only place that talks to LHDN's MyInvois. The Client Secret (and, later, the
// signing certificate) live here as function secrets, never in a POS iPad or the
// customer page.
//
// Actions (POST { action, ... }):
//   status        — (user) are credentials and the company's details in place; can we get a token
//   submit_bill   — (user) { billId, buyer? }  one paid bill as its own e-invoice (over RM 10,000: buyer required)
//   consolidate   — (user) { branchId, month: 'YYYY-MM' }  a past business month's remaining bills
//   refresh       — (user) { documentId }  read LHDN's verdict (or resend a draft that never reached LHDN)
//   resend        — (user) { documentId }  send a draft whose answer was unknown (needs_check), after checking the MyInvois portal
//   credit_notes  — (user) issue every credit note due now, past the 3-attempt stop (the screen's Retry)
//   run           — (job)  the daily run: refresh, consolidate on days 1–7, credit notes; one einvoice_job_runs row
//   reconcile     — (job)  { from?, to? }  build (never submit) every paid bill's document and each outlet-month's
//                    consolidated invoice; compare with the bills and Reports → Overview
// (user) = a Craft OS login with access_settings, checked here (the function is deployed with --no-verify-jwt).
// (job)  = header x-einvoice-job-secret equal to the function secret EINVOICE_JOB_SECRET; pg_cron sends it
//          through pg_net (supabase/migration-2026-11-23-einvoice-w5-cron.sql).
//
// Secrets (Dashboard → Edge Functions → Secrets): MYINVOIS_CLIENT_ID, MYINVOIS_CLIENT_SECRET, EINVOICE_JOB_SECRET.
// SUPABASE_URL, SUPABASE_ANON_KEY and the secret key are injected by the platform.
//
// Deploy: supabase functions deploy einvoice --project-ref <ref> --no-verify-jwt
// Design: docs/superpowers/specs/2026-10-26-myinvois-einvoice-design.md (W5)

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { resolveSecretKey } from '../_shared/secretKey.ts'
import { buildDocument, type IdType, type Party } from './ubl.ts'
import {
  PlanError, planConsolidated, planConsolidatedCreditNote, planCreditNote, planInvoice,
  type BillSource, type MonthBill, type PendingRefund, type PlanCtx, type Planned,
} from './documents.ts'
import {
  STALE_SEND_MS, businessDay, conRef, emptyReport, jobSecretMatches, monthEnd, monthOf, previousMonth, runCreditNotes,
  runJob, runOutcome, sendDraft,
  type AttemptRef, type JobReport, type JobSteps, type PendingDoc, type StepResult,
} from './job.ts'
import { reconcile, type ReconcileSource } from './reconcile.ts'
import { MyInvoisClient, MyInvoisError, validationUrl, type Environment } from './myinvois.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

class Refusal extends Error {
  constructor(message: string, readonly status = 400, readonly detail?: unknown) {
    super(message)
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

// ── The company as supplier ─────────────────────────────────────────────────
interface Settings {
  environment: Environment
  supplier_name: string | null; supplier_tin: string | null; supplier_brn: string | null
  supplier_sst_no: string; supplier_ttx_no: string
  msic_code: string | null; business_activity: string | null
  address_line: string | null; city: string | null; postcode: string | null
  state_code: string | null; country_code: string
  phone: string | null; email: string | null
}

const REQUIRED: (keyof Settings)[] = [
  'supplier_name', 'supplier_tin', 'supplier_brn', 'msic_code', 'business_activity',
  'address_line', 'city', 'state_code', 'phone',
]

const missingSettings = (s: Settings) => REQUIRED.filter((k) => !String(s[k] ?? '').trim())

function supplierParty(s: Settings): Party {
  return {
    name: s.supplier_name!, tin: s.supplier_tin!, idType: 'BRN', idValue: s.supplier_brn!,
    sstNo: s.supplier_sst_no, ttxNo: s.supplier_ttx_no, msicCode: s.msic_code!, activity: s.business_activity!,
    address: { line: s.address_line!, city: s.city!, postcode: s.postcode ?? undefined, stateCode: s.state_code!, countryCode: s.country_code },
    phone: s.phone!, email: s.email ?? undefined,
  }
}

/** A customer asking for their own e-invoice. Unknown address and phone become LHDN's "NA". */
function buyerParty(b: unknown): Party | null {
  if (b == null) return null
  const x = b as Record<string, any>
  const idTypes: IdType[] = ['BRN', 'NRIC', 'PASSPORT', 'ARMY']
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  if (!str(x.name) || !str(x.tin)) throw new Refusal('The buyer needs a name and a TIN')
  if (!idTypes.includes(x.idType) || !str(x.idValue)) throw new Refusal('The buyer needs an ID type (BRN, NRIC, PASSPORT or ARMY) and number')
  return {
    name: str(x.name), tin: str(x.tin).toUpperCase(), idType: x.idType, idValue: str(x.idValue), sstNo: str(x.sstNo) || 'NA',
    address: {
      line: str(x.address?.line) || 'NA', city: str(x.address?.city) || 'NA', postcode: str(x.address?.postcode) || undefined,
      stateCode: /^(0[1-9]|1[0-7])$/.test(str(x.address?.stateCode)) ? str(x.address.stateCode) : '17',
      countryCode: 'MYS',
    },
    phone: str(x.phone) || 'NA', email: str(x.email) || undefined,
  }
}

// ── Shared steps ────────────────────────────────────────────────────────────
function credentials() {
  const id = Deno.env.get('MYINVOIS_CLIENT_ID') ?? ''
  const secret = Deno.env.get('MYINVOIS_CLIENT_SECRET') ?? ''
  return { id, secret, present: { clientId: id !== '', clientSecret: secret !== '' } }
}

/** The client for sending, or the reason nothing may be sent ("not set up" for the daily run). */
function readyClient(s: Settings): MyInvoisClient {
  if (s.environment === 'production') {
    throw new Refusal('Production needs signed v1.1 documents, which are not built yet — keep environment = sandbox', 409)
  }
  const c = credentials()
  if (!c.present.clientId || !c.present.clientSecret) {
    throw new Refusal('MyInvois credentials are not set — add MYINVOIS_CLIENT_ID and MYINVOIS_CLIENT_SECRET under Edge Functions → Secrets', 409)
  }
  const missing = missingSettings(s)
  if (missing.length) throw new Refusal(`Company details are incomplete: ${missing.join(', ')}`, 409, { missing })
  return new MyInvoisClient(s.environment, c.id, c.secret)
}

const planCtx = (s: Settings): PlanCtx => ({ supplier: supplierParty(s), issuedAt: new Date() })

/** A builder's refusal becomes the caller's: nothing was created yet. */
function plan(make: () => Planned): Planned {
  try {
    return make()
  } catch (e) {
    if (e instanceof PlanError) throw new Refusal(e.message, e.status)
    throw e
  }
}

const releaseLinks = async (admin: SupabaseClient, documentId: string) => {
  await admin.from('einvoice_bill_links').delete().eq('document_id', documentId)
  await admin.from('einvoice_refund_links').delete().eq('document_id', documentId)
}

async function updateDoc(admin: SupabaseClient, id: string, patch: Record<string, unknown>) {
  const { data, error } = await admin.from('einvoice_documents')
    .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select('*').single()
  if (error) throw error
  return data
}

async function loadDocument(admin: SupabaseClient, id: string) {
  const { data, error } = await admin.from('einvoice_documents').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  if (!data) throw new Refusal('No such document', 404)
  return data
}

/**
 * Create the draft (claiming its bills or refunds), build the UBL with the draft's code number,
 * send it. A rejection gives the bills and refunds back; a failure before LHDN answered leaves a
 * draft that `refresh` (or the next daily run) resends.
 */
async function issue(
  admin: SupabaseClient, client: MyInvoisClient, doc: Record<string, unknown>,
  links: { billIds: string[]; refundIds: string[] }, planned: Planned,
) {
  const { data: row, error } = await admin.rpc('einvoice_create_document', {
    p_doc: { ...doc, kind: planned.kind, totalSen: planned.totalSen, environment: client.env },
    p_bill_ids: links.billIds, p_refund_ids: links.refundIds,
  })
  if (error) throw new Refusal(error.message, 409)

  let payload: Record<string, unknown>
  try {
    payload = buildDocument(planned.build(row.code_number))
  } catch (e) {
    await admin.from('einvoice_documents').delete().eq('id', row.id)
    throw new Refusal(message(e), 422)
  }
  await updateDoc(admin, row.id, { payload })
  return send(admin, client, { ...row, payload })
}

/**
 * Send a draft, once. A draft means "we never recorded LHDN's answer", so the draft is claimed first
 * (einvoice_claim_send) and only the winner submits. A clear rejection frees the bills; LHDN not taking it
 * frees the claim for the next run; any unclear answer sets needs_check and nothing resends it until the
 * owner presses Resend.
 */
async function send(admin: SupabaseClient, client: MyInvoisClient, row: Record<string, any>) {
  if (row.status !== 'draft') return row
  const markRejected = (errors: unknown) => updateDoc(admin, row.id, { status: 'rejected', errors })
  if (!row.payload) {
    const out = await markRejected({ message: 'The document was never built, so it was not sent' })
    await releaseLinks(admin, row.id)
    return out
  }
  return sendDraft<Record<string, any>>(row.code_number, {
    async claim() {
      const { data, error } = await admin.rpc('einvoice_claim_send', { p_id: row.id })
      if (error) throw error
      return Array.isArray(data) && data.length > 0
    },
    lost: () => loadDocument(admin, row.id),
    submit: () => client.submit([{ codeNumber: row.code_number, document: row.payload }]),
    markSubmitted: (uuid, submissionUid) => updateDoc(admin, row.id, {
      status: 'submitted', submission_uid: submissionUid, lhdn_uuid: uuid, submitted_at: new Date().toISOString(), errors: null,
    }),
    markRejected,
    releaseLinks: () => releaseLinks(admin, row.id),
    markNeedsCheck: (errors) => updateDoc(admin, row.id, { needs_check: true, errors }),
    clearClaim: (errors) => updateDoc(admin, row.id, { send_started_at: null, errors }),
  })
}

/** Read LHDN's verdict on a submitted document, or resend a draft that never reached LHDN. */
async function refreshDocument(admin: SupabaseClient, client: MyInvoisClient, row: Record<string, any>) {
  if (row.status === 'draft') return send(admin, client, row)
  if (row.status !== 'submitted') return row
  const summary = (await client.getSubmission(row.submission_uid)).find((d) => d.uuid === row.lhdn_uuid)
  if (!summary || summary.status === 'Submitted') return row
  if (summary.status === 'Valid') {
    return updateDoc(admin, row.id, { status: 'valid', long_id: summary.longId, validated_at: new Date().toISOString(), errors: null })
  }
  const errors = summary.status === 'Invalid'
    ? await client.getDocumentDetails(row.lhdn_uuid).catch((e) => ({ message: message(e) }))
    : null
  const out = await updateDoc(admin, row.id, { status: summary.status === 'Invalid' ? 'invalid' : 'cancelled', errors })
  await releaseLinks(admin, row.id)       // after the status is saved, never before
  return out
}

const withLink = (doc: Record<string, any>) => ({
  ...doc,
  validationUrl: doc.lhdn_uuid && doc.long_id ? validationUrl(doc.environment, doc.lhdn_uuid, doc.long_id) : null,
})

async function recordAttempt(admin: SupabaseClient, ref: AttemptRef, ok: boolean, error: string | null) {
  const { error: e } = await admin.rpc('einvoice_record_attempt', {
    p_key: ref.key, p_kind: ref.kind, p_branch_id: ref.branchId, p_period_start: ref.periodStart,
    p_refund_id: ref.refundId, p_ok: ok, p_error: error,
  })
  if (e) throw e
}

const toPendingRefund = (r: Record<string, any>): PendingRefund => ({
  refundId: r.refund_id, billId: r.bill_id, branchId: r.branch_id, billNo: r.bill_no, amountSen: r.amount_sen,
  refundDay: r.refund_day, totals: r.totals ?? null, invoiceCode: r.invoice_code, invoiceUuid: r.invoice_uuid,
  invoiceBuyer: (r.invoice_buyer as Party | null) ?? null,
  refundedBeforeSen: r.refunded_before_sen as number,
})

const monthEnded = (month: string) => month < monthOf(businessDay(new Date()))

// ── What each document covers ───────────────────────────────────────────────
/** A past business month's remaining bills of one outlet, from its start date, as one consolidated invoice. */
async function consolidateOutlet(
  admin: SupabaseClient, s: Settings, client: MyInvoisClient, branchId: string, month: string, callerId: string | null,
) {
  if (!monthEnded(month)) throw new Refusal('A month can be consolidated only after its last business day ends (06:00 Malaysia time on the 1st)', 409)
  const { data: outlet, error: outletErr } = await admin.from('branches').select('id, einvoice_from').eq('id', branchId).maybeSingle()
  if (outletErr) throw outletErr
  if (!outlet) throw new Refusal('No such outlet', 404)
  if (!outlet.einvoice_from) throw new Refusal('This outlet is not reported by us yet: set "Report e-invoices from" first', 409)

  const { data: bills, error } = await admin.rpc('einvoice_unlinked_paid_bills', { p_branch_id: branchId, p_month: `${month}-01` })
  if (error) throw error
  if (!bills?.length) return { nothingToDo: true, month }

  const first = `${month}-01`
  const period = { start: outlet.einvoice_from > first ? outlet.einvoice_from : first, end: monthEnd(month) }
  const monthBills: MonthBill[] = bills.map((b: any) => ({ id: b.id, billNo: b.bill_no, day: b.day, totalSen: b.total_sen, totals: b.totals }))
  const planned = plan(() => planConsolidated(monthBills, period, planCtx(s)))
  const doc = await issue(admin, client, {
    branchId, periodStart: period.start, periodEnd: period.end, createdBy: callerId,
  }, { billIds: monthBills.map((b) => b.id), refundIds: [] }, planned)
  return { ...withLink(doc), bills: monthBills.length }
}

/** A refund of an individually invoiced bill. */
async function creditNoteFor(admin: SupabaseClient, s: Settings, client: MyInvoisClient, r: PendingRefund) {
  const planned = plan(() => planCreditNote(r, planCtx(s)))
  const doc = await issue(admin, client, {
    branchId: r.branchId, billId: r.billId, buyer: r.invoiceBuyer, createdBy: null,
  }, { billIds: [], refundIds: [r.refundId] }, planned)
  return withLink(doc)
}

/** An outlet's refunds of one past business month whose bills sit in valid consolidated invoices. */
async function consolidatedCreditNoteFor(admin: SupabaseClient, s: Settings, client: MyInvoisClient, branchId: string, month: string) {
  const { data, error } = await admin.rpc('einvoice_pending_consolidated_refunds', { p_branch_id: branchId, p_month: `${month}-01` })
  if (error) throw error
  const refunds = (data ?? []).map(toPendingRefund)
  if (!refunds.length) return { nothingToDo: true, month }
  const period = { start: `${month}-01`, end: monthEnd(month) }
  const planned = plan(() => planConsolidatedCreditNote(refunds, period, planCtx(s)))
  const doc = await issue(admin, client, {
    branchId, periodStart: period.start, periodEnd: period.end, createdBy: null,
  }, { billIds: [], refundIds: refunds.map((r: PendingRefund) => r.refundId) }, planned)
  return withLink(doc)
}

// ── The daily run's steps ───────────────────────────────────────────────────
/** One step as the runner sees it; a refusal never stops the run. */
async function step(run: () => Promise<Record<string, any>>): Promise<StepResult> {
  try {
    const d = await run()
    if (d.nothingToDo) return { outcome: 'nothing' }
    const base = { codeNumber: d.code_number as string, status: d.status as string }
    if (d.status === 'rejected') return { ...base, outcome: 'rejected', error: JSON.stringify(d.errors ?? null).slice(0, 500) }
    if (d.status === 'draft') return { ...base, outcome: 'waiting', ...(d.errors ? { error: JSON.stringify(d.errors).slice(0, 500) } : {}) }
    return { ...base, outcome: 'issued' }
  } catch (e) {
    return { outcome: 'refused', error: message(e) }
  }
}

function jobSteps(admin: SupabaseClient, s: Settings): JobSteps {
  let client: MyInvoisClient | null = null
  const ready = () => client ?? (client = readyClient(s))
  return {
    async setUp() {
      try {
        ready()
        return { ok: true }
      } catch (e) {
        return { ok: false, reason: message(e) }
      }
    },
    async pendingDocuments(): Promise<PendingDoc[]> {
      // A send that started long ago and never recorded an answer: its outcome is unknown, never resend it.
      const cutoff = new Date(Date.now() - STALE_SEND_MS).toISOString()
      const { error: staleErr } = await admin.from('einvoice_documents')
        .update({ needs_check: true, updated_at: new Date().toISOString() })
        .eq('status', 'draft').eq('needs_check', false).not('send_started_at', 'is', null).lt('send_started_at', cutoff)
      if (staleErr) throw staleErr
      const { data, error } = await admin.from('einvoice_documents')
        .select('id, code_number, kind, branch_id, period_start, status')
        .in('status', ['draft', 'submitted']).eq('environment', s.environment).order('created_at')
      if (error) throw error
      return (data ?? []).map((d: any) => ({
        id: d.id, codeNumber: d.code_number, kind: d.kind, branchId: d.branch_id, periodStart: d.period_start, status: d.status,
      }))
    },
    async refresh(doc) {
      const after = await refreshDocument(admin, ready(), await loadDocument(admin, doc.id))
      return { status: after.status }
    },
    async outlets() {
      const { data, error } = await admin.from('branches').select('id, einvoice_from').not('einvoice_from', 'is', null)
      if (error) throw error
      return (data ?? []).map((b: any) => ({ id: b.id, einvoiceFrom: b.einvoice_from }))
    },
    async failures(key) {
      const { data, error } = await admin.from('einvoice_job_attempts').select('failures').eq('key', key).maybeSingle()
      if (error) throw error
      return data?.failures ?? 0
    },
    record: (ref, ok, error) => recordAttempt(admin, ref, ok, error),
    consolidate: (branchId, month) => step(() => consolidateOutlet(admin, s, ready(), branchId, month, null)),
    async singleRefunds() {
      const { data, error } = await admin.rpc('einvoice_pending_single_refunds')
      if (error) throw error
      return (data ?? []).map(toPendingRefund)
    },
    creditNote: (r) => step(() => creditNoteFor(admin, s, ready(), r)),
    async refundMonths(before) {
      const { data, error } = await admin.rpc('einvoice_consolidated_refund_months', { p_before: before })
      if (error) throw error
      return (data ?? []).map((m: any) => ({ branchId: m.branch_id, month: String(m.month).slice(0, 7) }))
    },
    consolidatedCreditNote: (branchId, month) => step(() => consolidatedCreditNoteFor(admin, s, ready(), branchId, month)),
  }
}

// ── Actions ─────────────────────────────────────────────────────────────────
async function actionStatus(s: Settings) {
  const c = credentials()
  let token: string = 'not tried'
  if (c.present.clientId && c.present.clientSecret) {
    try {
      await new MyInvoisClient(s.environment, c.id, c.secret).accessToken()
      token = 'ok'
    } catch (e) {
      token = e instanceof MyInvoisError ? `refused (${e.status})` : `failed: ${message(e)}`
    }
  }
  return {
    environment: s.environment,
    credentials: c.present,
    settingsMissing: missingSettings(s),
    signing: s.environment === 'production' ? 'required, not built' : 'not needed in sandbox (v1.0)',
    token,
  }
}

async function actionSubmitBill(admin: SupabaseClient, s: Settings, callerId: string | null, body: any) {
  if (typeof body.billId !== 'string') throw new Refusal('billId is required')
  const buyer = buyerParty(body.buyer)
  const client = readyClient(s)
  const { data: src, error } = await admin.rpc('einvoice_bill_source', { p_bill_id: body.billId })
  if (error) throw error
  if (!src) throw new Refusal('No such bill', 404)
  const source = src as BillSource
  const planned = plan(() => planInvoice(source, planCtx(s), buyer))
  const doc = await issue(admin, client, {
    branchId: source.bill.branchId, billId: source.bill.id, buyer, createdBy: callerId,
  }, { billIds: [source.bill.id], refundIds: [] }, planned)
  return withLink(doc)
}

async function actionConsolidate(admin: SupabaseClient, s: Settings, callerId: string | null, body: any) {
  if (typeof body.branchId !== 'string') throw new Refusal('branchId is required')
  if (typeof body.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(body.month)) throw new Refusal('month must be YYYY-MM')
  if (!monthEnded(body.month)) throw new Refusal('A month can be consolidated only after its last business day ends (06:00 Malaysia time on the 1st)', 409)
  const client = readyClient(s)
  const ref = conRef(body.branchId, body.month)
  try {
    const r: Record<string, any> = await consolidateOutlet(admin, s, client, body.branchId, body.month, callerId)
    const rejected = r.status === 'rejected'
    await recordAttempt(admin, ref, !rejected, rejected ? 'LHDN rejected the document' : null)
    return r
  } catch (e) {
    if (e instanceof Refusal) await recordAttempt(admin, ref, false, e.message).catch((err) => console.error(err))
    throw e
  }
}

async function actionRefresh(admin: SupabaseClient, s: Settings, body: any) {
  if (typeof body.documentId !== 'string') throw new Refusal('documentId is required')
  const row = await loadDocument(admin, body.documentId)
  if (row.environment !== s.environment) throw new Refusal(`This document was sent to ${row.environment}; settings now say ${s.environment}`, 409)
  return withLink(await refreshDocument(admin, readyClient(s), row))
}

/** The owner's call after checking the MyInvois portal: send a draft whose answer was unknown. */
async function actionResend(admin: SupabaseClient, s: Settings, body: any) {
  if (typeof body.documentId !== 'string') throw new Refusal('documentId is required')
  const client = readyClient(s)
  const row = await loadDocument(admin, body.documentId)
  if (row.environment !== s.environment) throw new Refusal(`This document was sent to ${row.environment}; settings now say ${s.environment}`, 409)
  const [bl, rl] = await Promise.all([
    admin.from('einvoice_bill_links').select('document_id', { count: 'exact', head: true }).eq('document_id', row.id),
    admin.from('einvoice_refund_links').select('document_id', { count: 'exact', head: true }).eq('document_id', row.id),
  ])
  if (bl.error) throw bl.error
  if (rl.error) throw rl.error
  if (!(bl.count ?? 0) && !(rl.count ?? 0)) throw new Refusal('This document has no bills left; it cannot be sent again.', 409)
  const { data, error } = await admin.from('einvoice_documents')
    .update({ needs_check: false, send_started_at: null, updated_at: new Date().toISOString() })
    .eq('id', row.id).eq('status', 'draft').eq('needs_check', true).select('*')
  if (error) throw error
  if (!data?.length) throw new Refusal('Only a draft that needs a check can be resent', 409)
  return withLink(await send(admin, client, data[0]))
}

/** The screen's Retry for credit notes: everything due now, stopped ones included. */
async function actionCreditNotes(admin: SupabaseClient, s: Settings): Promise<JobReport> {
  readyClient(s)
  const report = emptyReport(businessDay(new Date()))
  await runCreditNotes(jobSteps(admin, s), report, report.businessDay, true)
  return report
}

async function actionRun(admin: SupabaseClient, s: Settings) {
  const startedAt = new Date()
  let report: JobReport
  try {
    report = await runJob(jobSteps(admin, s), startedAt)
  } catch (e) {
    report = { ...emptyReport(businessDay(startedAt)), errors: [`Run: ${message(e)}`] }
  }
  const outcome = runOutcome(report)
  const { error } = await admin.from('einvoice_job_runs').insert({
    started_at: startedAt.toISOString(), finished_at: new Date().toISOString(), environment: s.environment, outcome, report,
  })
  if (error) throw error
  return { outcome, report }
}

/**
 * The overview is per full business month, so the window is widened to whole months. Default: the previous
 * month and the current one. At most 3 months (each is built bill by bill).
 */
async function actionReconcile(admin: SupabaseClient, body: any) {
  const day = (v: unknown, name: string): string | null => {
    if (v == null) return null
    const real = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v
    if (!real) throw new Refusal(`${name} must be a real date, YYYY-MM-DD`)
    return v as string
  }
  const given = { from: day(body.from, 'from'), to: day(body.to, 'to') }
  const today = monthOf(businessDay(new Date()))
  const toMonth = given.to ? monthOf(given.to) : today
  const fromMonth = given.from ? monthOf(given.from) : previousMonth(toMonth)
  const count = (Number(toMonth.slice(0, 4)) - Number(fromMonth.slice(0, 4))) * 12 + Number(toMonth.slice(5)) - Number(fromMonth.slice(5)) + 1
  if (count < 1) throw new Refusal('to must not be before from')
  if (count > 3) throw new Refusal('Reconcile at most 3 months at a time')
  const { data, error } = await admin.rpc('einvoice_reconcile_source', { p_from: `${fromMonth}-01`, p_to: monthEnd(toMonth) })
  if (error) throw error
  return reconcile(data as ReconcileSource)
}

// ── Entry ───────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const url = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const secretKey = resolveSecretKey()
  if (!url || !anonKey || !secretKey) return json({ error: 'Function is not configured: missing platform keys' }, 500)

  const parsed = await req.json().catch(() => null)
  const badBody = parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
  const body = badBody ? {} : parsed
  const job = body.action === 'run' || body.action === 'reconcile'
  let callerId: string | null = null
  if (job) {
    if (!jobSecretMatches(req.headers.get('x-einvoice-job-secret'), Deno.env.get('EINVOICE_JOB_SECRET'))) {
      return json({ error: 'Not allowed' }, 401)
    }
  } else {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Missing Authorization header' }, 401)
    const asCaller = createClient(url, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: userData, error: userErr } = await asCaller.auth.getUser(authHeader.replace(/^Bearer\s+/i, ''))
    if (userErr || !userData.user) return json({ error: 'Invalid session' }, 401)
    const { data: allowed } = await asCaller.rpc('has_menu_cap', { p_cap: 'access_settings' })
    if (allowed !== true) return json({ error: 'You need Access Settings to work with e-invoices' }, 403)
    callerId = userData.user.id
  }

  const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
  try {
    if (badBody) throw new Refusal('The request body must be a JSON object')
    const { data: settings, error } = await admin.from('einvoice_settings').select('*').eq('id', true).single()
    if (error) throw error
    switch (body.action) {
      case 'status': return json(await actionStatus(settings))
      case 'submit_bill': return json(await actionSubmitBill(admin, settings, callerId, body))
      case 'consolidate': return json(await actionConsolidate(admin, settings, callerId, body))
      case 'refresh': return json(await actionRefresh(admin, settings, body))
      case 'resend': return json(await actionResend(admin, settings, body))
      case 'credit_notes': return json(await actionCreditNotes(admin, settings))
      case 'run': return json(await actionRun(admin, settings))
      case 'reconcile': return json(await actionReconcile(admin, body))
      default: return json({ error: 'action must be status, submit_bill, consolidate, refresh, resend, credit_notes, run or reconcile' }, 400)
    }
  } catch (e) {
    if (e instanceof Refusal) return json({ error: e.message, detail: e.detail }, e.status)
    console.error(e)
    return json({ error: message(e) || 'Unexpected error' }, 500)
  }
})
