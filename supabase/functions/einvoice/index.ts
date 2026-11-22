// Edge Function: einvoice
//
// The only place that talks to LHDN's MyInvois. The Client Secret (and, later, the
// signing certificate) live here as function secrets, never in a POS iPad or the
// customer page. Callers send their own JWT; every action needs access_settings.
//
// Actions (POST { action, ... }):
//   status       — are credentials and the company's details in place; can we get a token
//   submit_bill  — { billId, buyer? }  one paid bill as its own e-invoice
//   consolidate  — { branchId, month: 'YYYY-MM' }  a past month's remaining bills, one line per day
//   refresh      — { documentId }  read LHDN's verdict (or resend a draft that never reached LHDN)
//
// Secrets (Dashboard → Edge Functions → Secrets): MYINVOIS_CLIENT_ID, MYINVOIS_CLIENT_SECRET.
// SUPABASE_URL, SUPABASE_ANON_KEY and the secret key are injected by the platform.
//
// Deploy: supabase functions deploy einvoice --project-ref <ref> --use-api
// Design: docs/superpowers/specs/2026-10-26-myinvois-einvoice-design.md

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { billLines, buildDocument, dayLines, documentTotals, GENERAL_PUBLIC,
  type DocInput, type IdType, type Party } from './ubl.ts'
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

/** Same lookup as provision-staff: the new sb_secret_ key first, the legacy service role key as fallback. */
function resolveSecretKey(): string | null {
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (raw) {
    const looksRight = (v: unknown): v is string => typeof v === 'string' && v.startsWith('sb_secret_')
    if (looksRight(raw)) return raw
    try {
      const parsed = JSON.parse(raw)
      if (looksRight(parsed)) return parsed
      for (const c of Array.isArray(parsed) ? parsed : Object.values(parsed ?? {})) {
        if (looksRight(c)) return c
        if (c && typeof c === 'object') for (const v of Object.values(c)) if (looksRight(v)) return v
      }
    } catch {
      // not JSON — fall through
    }
  }
  return Deno.env.get('SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? null
}

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

/**
 * Create the draft (claiming its bills), build the UBL with the draft's code number,
 * send it. A rejection gives the bills back; a failure before LHDN answered leaves a
 * draft that `refresh` resends.
 */
async function issue(
  admin: SupabaseClient, client: MyInvoisClient, doc: Record<string, unknown>, billIds: string[],
  build: (codeNumber: string) => DocInput,
) {
  const { data: row, error } = await admin.rpc('einvoice_create_document', {
    p_doc: { ...doc, environment: client.env }, p_bill_ids: billIds, p_refund_ids: [],
  })
  if (error) throw new Refusal(error.message, 409)

  let payload: Record<string, unknown>
  try {
    payload = buildDocument(build(row.code_number))
  } catch (e) {
    await admin.from('einvoice_documents').delete().eq('id', row.id)
    throw new Refusal((e as Error).message, 422)
  }
  await updateDoc(admin, row.id, { payload })
  return send(admin, client, { ...row, payload })
}

async function send(admin: SupabaseClient, client: MyInvoisClient, row: Record<string, any>) {
  try {
    const r = await client.submit([{ codeNumber: row.code_number, document: row.payload }])
    const ok = r.accepted.find((a) => a.codeNumber === row.code_number)
    if (ok) {
      return updateDoc(admin, row.id, {
        status: 'submitted', submission_uid: r.submissionUid, lhdn_uuid: ok.uuid,
        submitted_at: new Date().toISOString(), errors: null,
      })
    }
    await releaseLinks(admin, row.id)
    return updateDoc(admin, row.id, { status: 'rejected', submission_uid: r.submissionUid, errors: r.rejected })
  } catch (e) {
    if (e instanceof MyInvoisError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 429) {
      await releaseLinks(admin, row.id)
      return updateDoc(admin, row.id, { status: 'rejected', errors: { status: e.status, body: e.body } })
    }
    // Credentials, rate limit, network or LHDN down: keep the draft and its bills for a resend.
    return updateDoc(admin, row.id, {
      errors: { message: (e as Error).message, ...(e instanceof MyInvoisError ? { status: e.status, body: e.body } : {}) },
    })
  }
}

const withLink = (doc: Record<string, any>) => ({
  ...doc,
  validationUrl: doc.lhdn_uuid && doc.long_id ? validationUrl(doc.environment, doc.lhdn_uuid, doc.long_id) : null,
})

/** The current month in Malaysia time, as YYYY-MM. */
const currentMonthMyt = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7)

function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
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
      token = e instanceof MyInvoisError ? `refused (${e.status})` : `failed: ${(e as Error).message}`
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

async function actionSubmitBill(admin: SupabaseClient, s: Settings, callerId: string, body: any) {
  if (typeof body.billId !== 'string') throw new Refusal('billId is required')
  const buyer = buyerParty(body.buyer)
  const client = readyClient(s)

  const { data: src, error } = await admin.rpc('einvoice_bill_source', { p_bill_id: body.billId })
  if (error) throw error
  if (!src) throw new Refusal('No such bill', 404)
  if (src.bill.status !== 'paid') throw new Refusal(`Only a paid bill can be e-invoiced (this one is ${src.bill.status})`, 409)

  const parts = billLines(src.items, src.totals)
  const build = (codeNumber: string): DocInput => ({
    kind: 'invoice', codeNumber, issuedAt: new Date(), supplier: supplierParty(s), buyer: buyer ?? GENERAL_PUBLIC,
    lines: parts.lines, docChargeSen: parts.docChargeSen, docChargeReason: 'Service charge', roundingSen: parts.roundingSen,
  })
  const payable = documentTotals(build('check')).payable
  if (payable !== src.bill.totalSen) throw new Refusal(`The document adds up to ${payable} sen, the bill is ${src.bill.totalSen} sen`, 422)

  const doc = await issue(admin, client, {
    kind: 'invoice', branchId: src.bill.branchId, billId: src.bill.id, buyer, totalSen: payable, createdBy: callerId,
  }, [src.bill.id], build)
  return withLink(doc)
}

async function actionConsolidate(admin: SupabaseClient, s: Settings, callerId: string, body: any) {
  if (typeof body.branchId !== 'string') throw new Refusal('branchId is required')
  if (typeof body.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(body.month)) throw new Refusal('month must be YYYY-MM')
  if (body.month >= currentMonthMyt()) throw new Refusal('A month can be consolidated only after it ends (Malaysia time)', 409)
  const client = readyClient(s)

  const { data: bills, error } = await admin.rpc('einvoice_unlinked_paid_bills', {
    p_branch_id: body.branchId, p_month: `${body.month}-01`,
  })
  if (error) throw error
  if (!bills?.length) return { nothingToDo: true, month: body.month }

  const parts = dayLines(bills.map((b: any) => ({ billNo: b.bill_no, day: b.day, totals: b.totals })))
  const period = { start: `${body.month}-01`, end: monthEnd(body.month) }
  const build = (codeNumber: string): DocInput => ({
    kind: 'consolidated_invoice', codeNumber, issuedAt: new Date(), supplier: supplierParty(s), buyer: GENERAL_PUBLIC,
    lines: parts.lines, docChargeSen: 0, roundingSen: parts.roundingSen, period,
  })
  const expected = bills.reduce((a: number, b: any) => a + b.total_sen, 0)
  const payable = documentTotals(build('check')).payable
  if (payable !== expected) throw new Refusal(`The document adds up to ${payable} sen, the bills to ${expected} sen`, 422)

  const doc = await issue(admin, client, {
    kind: 'consolidated_invoice', branchId: body.branchId, periodStart: period.start, periodEnd: period.end,
    totalSen: payable, createdBy: callerId,
  }, bills.map((b: any) => b.id), build)
  return { ...withLink(doc), bills: bills.length }
}

async function actionRefresh(admin: SupabaseClient, s: Settings, body: any) {
  if (typeof body.documentId !== 'string') throw new Refusal('documentId is required')
  const { data: row, error } = await admin.from('einvoice_documents').select('*').eq('id', body.documentId).maybeSingle()
  if (error) throw error
  if (!row) throw new Refusal('No such document', 404)
  if (row.environment !== s.environment) throw new Refusal(`This document was sent to ${row.environment}; settings now say ${s.environment}`, 409)
  const client = readyClient(s)

  if (row.status === 'draft') return withLink(await send(admin, client, row))
  if (row.status !== 'submitted') return withLink(row)

  const summary = (await client.getSubmission(row.submission_uid)).find((d) => d.uuid === row.lhdn_uuid)
  if (!summary || summary.status === 'Submitted') return withLink(row)
  if (summary.status === 'Valid') {
    return withLink(await updateDoc(admin, row.id, {
      status: 'valid', long_id: summary.longId, validated_at: new Date().toISOString(), errors: null,
    }))
  }
  await releaseLinks(admin, row.id)
  const errors = summary.status === 'Invalid' ? await client.getDocumentDetails(row.lhdn_uuid).catch((e) => ({ message: e.message })) : null
  return withLink(await updateDoc(admin, row.id, { status: summary.status === 'Invalid' ? 'invalid' : 'cancelled', errors }))
}

// ── Entry ───────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const url = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const secretKey = resolveSecretKey()
  if (!url || !anonKey || !secretKey) return json({ error: 'Function is not configured: missing platform keys' }, 500)

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

  const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const body = await req.json().catch(() => ({}))

  try {
    const { data: settings, error } = await admin.from('einvoice_settings').select('*').eq('id', true).single()
    if (error) throw error
    switch (body.action) {
      case 'status': return json(await actionStatus(settings))
      case 'submit_bill': return json(await actionSubmitBill(admin, settings, userData.user.id, body))
      case 'consolidate': return json(await actionConsolidate(admin, settings, userData.user.id, body))
      case 'refresh': return json(await actionRefresh(admin, settings, body))
      default: return json({ error: 'action must be status, submit_bill, consolidate or refresh' }, 400)
    }
  } catch (e) {
    if (e instanceof Refusal) return json({ error: e.message, detail: e.detail }, e.status)
    console.error(e)
    return json({ error: (e as Error).message ?? 'Unexpected error' }, 500)
  }
})
