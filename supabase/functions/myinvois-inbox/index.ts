// Edge Function: myinvois-inbox
//
// Reads the e-Invoices other businesses issued TO the company (Shopee sellers,
// Lalamove, Maybank, food suppliers…) from LHDN MyInvois into the Register
// (account_docs). Read-only towards LHDN: it never submits or cancels anything,
// so it needs no signing certificate.
//
// Actions (POST { action, ... }), all need manage_accounts:
//   status   — are the credentials set, and does LHDN accept them
//   sync     — { month: 'YYYY-MM', page }  one page (≤100) of Search Documents,
//              invoiceDirection=Received, issued in that month (Malaysia time).
//              The caller loops over pages, ≥5 s apart (LHDN allows 1 search / 5 s).
//   details  — { uuid }  the raw document → line descriptions and tax
//
// Secrets (Dashboard → Edge Functions → Secrets):
//   MYINVOIS_CLIENT_ID, MYINVOIS_CLIENT_SECRET — the ERP system registered in the
//     MyInvois portal (same names as the einvoice function on feature/einvoice).
//   MYINVOIS_ENV — 'production' (default) or 'sandbox'.
//
// Deploy: supabase functions deploy myinvois-inbox --project-ref <ref> --use-api

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { monthWindow, parseRawDocument, registerFields, supplierKey, type ReceivedDoc } from './parse.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const HOSTS = {
  sandbox: { api: 'https://preprod-api.myinvois.hasil.gov.my', portal: 'https://preprod.myinvois.hasil.gov.my' },
  production: { api: 'https://api.myinvois.hasil.gov.my', portal: 'https://myinvois.hasil.gov.my' },
}

class LhdnError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
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

function settings() {
  const env = Deno.env.get('MYINVOIS_ENV') === 'sandbox' ? 'sandbox' : 'production'
  const id = Deno.env.get('MYINVOIS_CLIENT_ID') ?? ''
  const secret = Deno.env.get('MYINVOIS_CLIENT_SECRET') ?? ''
  return { env, host: HOSTS[env], id, secret, configured: id !== '' && secret !== '' } as const
}

let cachedToken: { value: string; expiresAt: number } | null = null

async function accessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.value
  const s = settings()
  const res = await fetch(`${s.host.api}/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: s.id, client_secret: s.secret, grant_type: 'client_credentials', scope: 'InvoicingAPI' }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok || !body?.access_token) throw new LhdnError('MyInvois refused the credentials', res.status, body)
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 }
  return cachedToken.value
}

async function lhdnGet(path: string) {
  const res = await fetch(`${settings().host.api}${path}`, {
    headers: { Authorization: `Bearer ${await accessToken()}`, Accept: 'application/json' },
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new LhdnError(`MyInvois GET ${path.split('?')[0]} → ${res.status}`, res.status, body)
  return body
}

// ── sync ────────────────────────────────────────────────────────────────────
async function syncPage(admin: SupabaseClient, month: string, page: number) {
  const w = monthWindow(month)
  const q = new URLSearchParams({
    issueDateFrom: w.from, issueDateTo: w.to, invoiceDirection: 'Received',
    pageNo: String(page), pageSize: '100',
  })
  const r = await lhdnGet(`/api/v1.0/documents/search?${q}`)
  const docs = ((r?.result ?? []) as ReceivedDoc[]).filter((d) => d?.uuid)
  const meta = r?.metadata ?? {}

  const uuids = docs.map((d) => d.uuid)
  const { data: existing, error: exErr } = uuids.length
    ? await admin.from('account_docs').select('id, einvoice_uuid, status, amount_myr, notes').in('einvoice_uuid', uuids)
    : { data: [], error: null }
  if (exErr) throw exErr
  const byUuid = new Map((existing ?? []).map((e) => [e.einvoice_uuid as string, e]))

  const keys = [...new Set(docs.map((d) => supplierKey(d.supplierName || d.issuerName)).filter(Boolean))]
  const { data: mem } = keys.length
    ? await admin.from('supplier_memory').select('key, gl_account, tax_treatment, platform').in('key', keys)
    : { data: [] }
  const memory = new Map((mem ?? []).map((m) => [m.key as string, m]))

  let created = 0, updated = 0, cancelled = 0, skipped = 0
  const inserts: Record<string, unknown>[] = []
  for (const d of docs) {
    const f = registerFields(d)
    const isCancelled = /cancel/i.test(d.status ?? '')
    const ex = byUuid.get(d.uuid)
    if (ex) {
      const patch: Record<string, unknown> = { einvoice: f.einvoice }
      if (ex.amount_myr == null && f.amount_myr != null) Object.assign(patch, { amount: f.amount, amount_myr: f.amount_myr, sst: f.sst })
      if (isCancelled && ex.status !== 'Cancelled') {
        if (ex.status === 'Posted to AutoCount') {
          patch.notes = `${ex.notes ?? ''} [Cancelled by supplier in MyInvois AFTER posting — reverse in AutoCount]`.trim()
        } else {
          patch.status = 'Cancelled'
          patch.notes = `${ex.notes ?? ''} [Cancelled by supplier in MyInvois]`.trim()
        }
        cancelled++
      } else {
        updated++
      }
      const { error } = await admin.from('account_docs').update(patch).eq('id', ex.id)
      if (error) throw error
      continue
    }
    if (!f.doc_date) { skipped++; continue }
    const m = memory.get(supplierKey(f.supplier))
    inserts.push({
      ...f,
      gl_account: m?.gl_account ?? null,
      tax_treatment: m?.tax_treatment ?? null,
      platform: m?.platform ?? null,
      payment: null,
      status: isCancelled ? 'Cancelled' : f.amount_myr == null ? 'Needs info' : 'Draft',
      notes: d.typeVersionName ? `MyInvois: ${d.typeName ?? ''} ${d.typeVersionName}`.trim() : null,
    })
    if (isCancelled) cancelled++
    else created++
  }
  if (inserts.length) {
    // ignoreDuplicates: a parallel sync of the same month must not fail on the unique uuid index.
    const { error } = await admin.from('account_docs').upsert(inserts, { onConflict: 'einvoice_uuid', ignoreDuplicates: true })
    if (error) throw error
  }
  return {
    page, totalPages: meta.totalPages ?? 1, totalCount: meta.totalCount ?? docs.length,
    seen: docs.length, created, updated, cancelled, skipped,
  }
}

async function details(admin: SupabaseClient, uuid: string) {
  const r = await lhdnGet(`/api/v1.0/documents/${encodeURIComponent(uuid)}/raw`)
  const parsed = typeof r?.document === 'string' ? parseRawDocument(r.document) : { currency: null, tax: null, items: [] }
  const { data: row } = await admin.from('account_docs').select('id, description, sst, amount_myr').eq('einvoice_uuid', uuid).maybeSingle()
  if (row) {
    const patch: Record<string, unknown> = { items: parsed.items }
    if (!row.description && parsed.items.length) {
      patch.description = parsed.items.map((i) => i.descEn).join('; ').slice(0, 300)
    }
    if (parsed.tax != null) patch.sst = parsed.tax
    if (row.amount_myr == null && typeof r?.totalPayableAmount === 'number') {
      patch.amount = r.totalPayableAmount
      patch.amount_myr = r.totalPayableAmount
    }
    const { error } = await admin.from('account_docs').update(patch).eq('id', row.id)
    if (error) throw error
  }
  return { uuid, ...parsed, totalPayableAmount: r?.totalPayableAmount ?? null, saved: !!row }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  })
  const { data: ok } = await userClient.rpc('has_accounts_cap')
  if (!ok) return json({ error: 'forbidden' }, 403)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'bad_request' }, 400)
  }

  const s = settings()
  if (body.action === 'status') {
    if (!s.configured) return json({ configured: false, environment: s.env, portal: s.host.portal })
    try {
      await accessToken()
      return json({ configured: true, connected: true, environment: s.env, portal: s.host.portal })
    } catch (e) {
      return json({ configured: true, connected: false, environment: s.env, portal: s.host.portal,
        error: e instanceof LhdnError ? e.body : String(e) })
    }
  }
  if (!s.configured) return json({ error: 'not_configured' }, 409)

  const key = resolveSecretKey()
  if (!key) return json({ error: 'server_misconfigured' }, 500)
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, key, { auth: { persistSession: false } })

  try {
    if (body.action === 'sync') {
      const page = Math.max(1, Number(body.page) || 1)
      return json(await syncPage(admin, String(body.month ?? ''), page))
    }
    if (body.action === 'details') {
      if (typeof body.uuid !== 'string' || !body.uuid) return json({ error: 'uuid required' }, 400)
      return json(await details(admin, body.uuid))
    }
    return json({ error: 'unknown_action' }, 400)
  } catch (e) {
    if (e instanceof LhdnError) {
      return json({ error: e.status === 429 ? 'rate_limited' : 'lhdn_error', status: e.status, detail: e.body, message: e.message },
        e.status === 429 ? 429 : 502)
    }
    const msg = e instanceof Error ? e.message : (e as { message?: string })?.message ?? String(e)
    return json({ error: msg.includes('month') ? 'bad_month' : 'failed', message: msg }, msg.includes('month') ? 400 : 500)
  }
})
