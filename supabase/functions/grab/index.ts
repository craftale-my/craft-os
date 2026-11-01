// Edge Function: grab
//
// The only place that talks to GrabFood. Grab calls the routes below (their URLs are typed
// into the Grab developer portal as https://<ref>.supabase.co/functions/v1/grab/<route>);
// staff with access_settings use /admin. Every call in or out is written to grab_events.
//
//   POST /oauth/token          Grab gets a token from us (PartnerOauthRequest → PartnerOauthResponse)
//   GET  /menu                 Grab pulls a store's menu (?merchantID=…) → GetMenuNewResponse
//   POST /orders               Submit order: kept once per orderID in grab_orders → 204
//   PUT  /order/state          Push order state → grab_orders.state → 204
//   POST /menu/sync-state      Menu sync state → grab_stores.last_menu_* → 204
//   POST /integration-status   Push integration status → grab_stores.integration_status → 204
//   POST /admin                { action } with a staff JWT: status, preview_menu, notify_menu,
//                              accept_order, mark_ready, pause_store
//
// Every route but /oauth/token and /admin needs "Authorization: Bearer <token from /oauth/token>".
// Grab orders are only stored here; turning them into POS bills is the next step.
//
// Secrets (Dashboard → Edge Functions → Secrets):
//   GRAB_PARTNER_CLIENT_ID / GRAB_PARTNER_CLIENT_SECRET  ours: made up by us, typed into Grab's portal
//   GRAB_CLIENT_ID / GRAB_CLIENT_SECRET                  Grab's: issued in the portal, for calls to Grab
//   GRAB_ENV                                             sandbox (default) or production
//
// Deploy (no JWT check: Grab sends its own token):
//   supabase functions deploy grab --project-ref <ref> --use-api --no-verify-jwt
// Design: docs/superpowers/specs/2026-11-01-grab-integration-design.md

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { resolveSecretKey } from '../_shared/secretKey.ts'
import { GrabApiError, GrabClient, type GrabEnv } from './grabApi.ts'
import {
  bearer, buildMenu, issueToken, matchRoute, menuItemIds, parseIntegrationStatus, parseMenuSyncState,
  parseOauthRequest, parseOrderState, parseSubmitOrder, sameText, verifyToken, type MenuSource,
} from './logic.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
const noContent = () => new Response(null, { status: 204, headers: CORS })

class Refusal extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

const nowS = () => Math.floor(Date.now() / 1000)

function settings() {
  const env = (Deno.env.get('GRAB_ENV') ?? 'sandbox') as GrabEnv
  return {
    env: env === 'production' ? 'production' as const : 'sandbox' as const,
    partnerId: Deno.env.get('GRAB_PARTNER_CLIENT_ID') ?? '',
    partnerSecret: Deno.env.get('GRAB_PARTNER_CLIENT_SECRET') ?? '',
    grabId: Deno.env.get('GRAB_CLIENT_ID') ?? '',
    grabSecret: Deno.env.get('GRAB_CLIENT_SECRET') ?? '',
  }
}
type Settings = ReturnType<typeof settings>

async function logEvent(admin: SupabaseClient, e: {
  direction: 'in' | 'out'; kind: string; merchant_id?: string | null; grab_order_id?: string | null
  body?: unknown; http_status?: number; error?: string | null
}) {
  const { error } = await admin.from('grab_events').insert(e)
  if (error) console.error('grab_events', error.message)
}

function grabClient(admin: SupabaseClient, s: Settings): GrabClient {
  if (!s.grabId || !s.grabSecret) {
    throw new Refusal('Grab credentials are not set — add GRAB_CLIENT_ID and GRAB_CLIENT_SECRET under Edge Functions → Secrets', 409)
  }
  return new GrabClient(s.env, s.grabId, s.grabSecret, (c) =>
    logEvent(admin, { direction: 'out', kind: `${c.method} ${c.path}`, body: c.body, http_status: c.status }))
}

async function menuSource(admin: SupabaseClient, merchantId: string): Promise<MenuSource | null> {
  const { data, error } = await admin.rpc('grab_menu_source', { p_merchant_id: merchantId })
  if (error) throw error
  return data as MenuSource | null
}

/** After the response when the platform allows it, so Grab is not kept waiting. */
function later(p: Promise<unknown>) {
  const rt = (globalThis as any).EdgeRuntime
  const safe = p.catch((e) => console.error('grab background', e instanceof Error ? e.message : String(e)))
  if (rt?.waitUntil) rt.waitUntil(safe)
  else return safe
}

// ── Grab → us ───────────────────────────────────────────────────────────────
async function routeOauth(admin: SupabaseClient, s: Settings, req: Request) {
  if (!s.partnerId || !s.partnerSecret) return json({ error: 'not_configured' }, 503)
  const o = parseOauthRequest(req.headers.get('content-type'), await req.text())
  const ok = !!o && o.grantType === 'client_credentials' && sameText(o.clientId, s.partnerId) && sameText(o.clientSecret, s.partnerSecret)
  await logEvent(admin, { direction: 'in', kind: 'oauth', body: { client_id: o?.clientId ?? null, grant_type: o?.grantType ?? null }, http_status: ok ? 200 : 401 })
  if (!ok) return json({ error: 'invalid_client' }, 401)
  const t = await issueToken(s.partnerSecret, nowS())
  return json({ access_token: t.token, token_type: 'Bearer', expires_in: t.expiresIn })
}

async function routeMenu(admin: SupabaseClient, url: URL) {
  const merchantId = url.searchParams.get('merchantID') ?? ''
  const src = merchantId ? await menuSource(admin, merchantId) : null
  if (!src) {
    await logEvent(admin, { direction: 'in', kind: 'get_menu', merchant_id: merchantId || null, http_status: 404, error: 'unknown merchant' })
    return json({ error: 'unknown merchantID' }, 404)
  }
  const { menu, warnings } = buildMenu(src)
  const items = menu.categories.reduce((n: number, c: any) => n + c.items.length, 0)
  await logEvent(admin, {
    direction: 'in', kind: 'get_menu', merchant_id: merchantId, http_status: 200,
    body: { categories: menu.categories.length, items, warnings }, error: warnings.length ? warnings.join('; ') : null,
  })
  return json(menu)
}

async function routeSubmitOrder(admin: SupabaseClient, s: Settings, body: unknown) {
  const parsed = parseSubmitOrder(body)
  if (!parsed.ok) {
    await logEvent(admin, { direction: 'in', kind: 'submit_order', body, http_status: 400, error: parsed.error })
    return json({ error: parsed.error }, 400)
  }
  const { row, itemIds } = parsed
  const { data: store, error: storeErr } = await admin.from('grab_stores')
    .select('branch_id, auto_accept, is_active').eq('merchant_id', row.merchant_id).maybeSingle()
  if (storeErr) throw storeErr
  const src = store ? await menuSource(admin, row.merchant_id) : null
  const known = src ? menuItemIds(src) : new Set<string>()
  const unmatched = itemIds.filter((id) => !known.has(id))

  const { data: inserted, error } = await admin.from('grab_orders').upsert({
    ...row, branch_id: store?.branch_id ?? null, unmatched_items: unmatched, payload: body,
  }, { onConflict: 'grab_order_id', ignoreDuplicates: true }).select('id')
  if (error) throw error
  const isNew = (inserted ?? []).length > 0

  const problems = [
    !store && 'merchant is not mapped to an outlet',
    unmatched.length > 0 && `${unmatched.length} item id(s) are not on this store's Grab menu`,
    !isNew && 'repeat of an order already received',
  ].filter(Boolean).join('; ')
  await logEvent(admin, {
    direction: 'in', kind: 'submit_order', merchant_id: row.merchant_id, grab_order_id: row.grab_order_id,
    body, http_status: 204, error: problems || null,
  })

  // Sandbox convenience until the POS can accept: a store set to auto-accept takes MANUAL orders at once.
  if (isNew && store?.auto_accept && store.is_active && row.accepted_type === 'MANUAL' && s.grabId && s.grabSecret) {
    await later(acceptOrder(admin, s, row.grab_order_id, true))
  }
  return noContent()
}

async function routeOrderState(admin: SupabaseClient, body: unknown) {
  const parsed = parseOrderState(body)
  if (!parsed.ok) {
    await logEvent(admin, { direction: 'in', kind: 'order_state', body, http_status: 400, error: parsed.error })
    return json({ error: parsed.error }, 400)
  }
  const { data, error } = await admin.from('grab_orders')
    .update({ state: parsed.state, last_state_payload: body, state_at: new Date().toISOString() })
    .eq('grab_order_id', parsed.orderId).select('id')
  if (error) throw error
  await logEvent(admin, {
    direction: 'in', kind: 'order_state', merchant_id: parsed.merchantId, grab_order_id: parsed.orderId, body, http_status: 204,
    error: (data ?? []).length ? null : 'no such order received',
  })
  return noContent()
}

async function routeMenuSyncState(admin: SupabaseClient, body: unknown) {
  const parsed = parseMenuSyncState(body)
  if (!parsed.ok) {
    await logEvent(admin, { direction: 'in', kind: 'menu_sync_state', body, http_status: 400, error: parsed.error })
    return json({ error: parsed.error }, 400)
  }
  const { error } = await admin.from('grab_stores').update({
    last_menu_status: parsed.status, last_menu_errors: parsed.errors.length ? parsed.errors : null,
    ...(parsed.jobId ? { last_menu_job_id: parsed.jobId } : {}), updated_at: new Date().toISOString(),
  }).eq('merchant_id', parsed.merchantId)
  if (error) throw error
  await logEvent(admin, { direction: 'in', kind: 'menu_sync_state', merchant_id: parsed.merchantId, body, http_status: 204 })
  return noContent()
}

async function routeIntegrationStatus(admin: SupabaseClient, body: unknown) {
  const parsed = parseIntegrationStatus(body)
  if (!parsed.ok) {
    await logEvent(admin, { direction: 'in', kind: 'integration_status', body, http_status: 400, error: parsed.error })
    return json({ error: parsed.error }, 400)
  }
  const { error } = await admin.from('grab_stores')
    .update({ integration_status: parsed.status, updated_at: new Date().toISOString() }).eq('merchant_id', parsed.merchantId)
  if (error) throw error
  await logEvent(admin, { direction: 'in', kind: 'integration_status', merchant_id: parsed.merchantId, body, http_status: 204 })
  return noContent()
}

// ── Staff → us → Grab ───────────────────────────────────────────────────────
async function acceptOrder(admin: SupabaseClient, s: Settings, orderId: string, accept: boolean) {
  await grabClient(admin, s).acceptOrder(orderId, accept)
  const { error } = await admin.from('grab_orders')
    .update(accept ? { accepted_at: new Date().toISOString() } : { state: 'REJECTED', state_at: new Date().toISOString() })
    .eq('grab_order_id', orderId)
  if (error) throw error
  return { orderId, accepted: accept }
}

async function actionStatus(admin: SupabaseClient, s: Settings, base: string) {
  const { data: stores, error } = await admin.from('grab_stores')
    .select('branch_id, merchant_id, catalog_id, auto_accept, is_active, integration_status, last_menu_status, updated_at')
  if (error) throw error
  let grabToken: { ok: boolean; error?: string } | null = null
  if (s.grabId && s.grabSecret) {
    try { await grabClient(admin, s).accessToken(); grabToken = { ok: true } } catch (e) { grabToken = { ok: false, error: (e as Error).message } }
  }
  return {
    environment: s.env,
    ourCredentials: { clientId: s.partnerId !== '', clientSecret: s.partnerSecret !== '' },
    grabCredentials: { clientId: s.grabId !== '', clientSecret: s.grabSecret !== '' },
    grabToken,
    stores,
    // the URLs to type into the Grab developer portal
    urls: {
      oauth: `${base}/oauth/token`, menu: `${base}/menu`, submitOrder: `${base}/orders`, orderState: `${base}/order/state`,
      menuSyncState: `${base}/menu/sync-state`, integrationStatus: `${base}/integration-status`,
    },
  }
}

async function routeAdmin(admin: SupabaseClient, s: Settings, req: Request, base: string) {
  const url = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const authHeader = req.headers.get('Authorization')
  if (!anonKey || !authHeader) return json({ error: 'Missing Authorization header' }, 401)
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: userData, error: userErr } = await asCaller.auth.getUser(authHeader.replace(/^Bearer\s+/i, ''))
  if (userErr || !userData.user) return json({ error: 'Invalid session' }, 401)
  const { data: allowed } = await asCaller.rpc('has_menu_cap', { p_cap: 'access_settings' })
  if (allowed !== true) return json({ error: 'You need Access Settings to work with Grab' }, 403)

  const body = await req.json().catch(() => ({})) as Record<string, any>
  const need = (k: string) => {
    if (typeof body[k] !== 'string' || !body[k].trim()) throw new Refusal(`${k} is required`)
    return body[k].trim() as string
  }
  switch (body.action) {
    case 'status': return json(await actionStatus(admin, s, base))
    case 'preview_menu': {
      const src = await menuSource(admin, need('merchantId'))
      if (!src) throw new Refusal('No Grab store has that merchant ID', 404)
      return json(buildMenu(src))
    }
    case 'notify_menu': {
      const merchantId = need('merchantId')
      const r = await grabClient(admin, s).notifyMenuUpdate(merchantId)
      const { error } = await admin.from('grab_stores')
        .update({ last_menu_job_id: r.jobId, last_menu_status: 'QUEUEING', last_menu_errors: null, updated_at: new Date().toISOString() })
        .eq('merchant_id', merchantId)
      if (error) throw error
      return json({ jobId: r.jobId })
    }
    case 'accept_order': return json(await acceptOrder(admin, s, need('orderId'), body.accept !== false))
    case 'mark_ready': {
      const orderId = need('orderId')
      await grabClient(admin, s).markReady(orderId)
      const { error } = await admin.from('grab_orders').update({ ready_at: new Date().toISOString() }).eq('grab_order_id', orderId)
      if (error) throw error
      return json({ orderId, ready: true })
    }
    case 'pause_store': {
      const duration = ['30m', '1h', '24h'].includes(body.duration) ? body.duration : undefined
      await grabClient(admin, s).pauseStore(need('merchantId'), body.pause !== false, duration)
      return json({ paused: body.pause !== false })
    }
    default:
      return json({ error: 'action must be status, preview_menu, notify_menu, accept_order, mark_ready or pause_store' }, 400)
  }
}

// ── Entry ───────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const url = new URL(req.url)
  const route = matchRoute(req.method, url.pathname)
  if (route === 'not_found') return json({ error: 'Not found' }, 404)
  if (route === 'method_not_allowed') return json({ error: 'Method not allowed' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const secretKey = resolveSecretKey()
  if (!supabaseUrl || !secretKey) return json({ error: 'Function is not configured: missing platform keys' }, 500)
  const admin = createClient(supabaseUrl, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const s = settings()
  const base = `${supabaseUrl}/functions/v1/grab`

  try {
    if (route === 'oauth') return await routeOauth(admin, s, req)
    if (route === 'admin') return await routeAdmin(admin, s, req, base)

    // Grab's webhooks: our token first
    if (!s.partnerSecret) return json({ error: 'not_configured' }, 503)
    const token = bearer(req.headers.get('Authorization'))
    if (!token || !(await verifyToken(s.partnerSecret, token, nowS()))) {
      await logEvent(admin, { direction: 'in', kind: route, http_status: 401, error: 'missing or invalid token' })
      return json({ error: 'unauthorized' }, 401)
    }
    if (route === 'menu') return await routeMenu(admin, url)
    const body = await req.json().catch(() => null)
    if (body === null) return json({ error: 'body must be JSON' }, 400)
    switch (route) {
      case 'submit_order': return await routeSubmitOrder(admin, s, body)
      case 'order_state': return await routeOrderState(admin, body)
      case 'menu_sync_state': return await routeMenuSyncState(admin, body)
      case 'integration_status': return await routeIntegrationStatus(admin, body)
    }
    return json({ error: 'Not found' }, 404)
  } catch (e) {
    if (e instanceof Refusal) return json({ error: e.message }, e.status)
    if (e instanceof GrabApiError) return json({ error: e.message, grab: e.body }, 502)
    console.error('grab', e instanceof Error ? e.message : String(e))
    return json({ error: 'Something went wrong' }, 500)
  }
})
