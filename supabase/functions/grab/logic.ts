// The pure parts of the grab function (no Deno APIs), tested with Vitest in logic.test.ts.
// Field names follow Grab's own OpenAPI spec (grab/grabfood-api-sdk-java, api/openapi.yaml,
// GrabFood API 1.1.3): GetMenuNewResponse, SubmitOrderRequest, OrderStateRequest,
// PartnerOauthRequest/Response, MenuSyncWebhookRequest, PushIntegrationStatusWebhookRequest.

// ── Routes ──────────────────────────────────────────────────────────────────
// The URLs Grab calls are typed into the Grab developer portal as
// https://<ref>.supabase.co/functions/v1/grab/<route>.
export type Route =
  | 'oauth' | 'menu' | 'submit_order' | 'order_state' | 'menu_sync_state' | 'integration_status' | 'admin'

const ROUTES: Record<string, { route: Route; methods: string[] }> = {
  'oauth/token': { route: 'oauth', methods: ['POST'] },
  'menu': { route: 'menu', methods: ['GET'] },
  'orders': { route: 'submit_order', methods: ['POST'] },
  'order/state': { route: 'order_state', methods: ['PUT', 'POST'] },
  'menu/sync-state': { route: 'menu_sync_state', methods: ['POST', 'PUT'] },
  'integration-status': { route: 'integration_status', methods: ['POST', 'PUT'] },
  'admin': { route: 'admin', methods: ['POST'] },
}

/** The route for a request path such as /grab/order/state (or /functions/v1/grab/order/state). */
export function matchRoute(method: string, pathname: string): Route | 'not_found' | 'method_not_allowed' {
  const i = pathname.indexOf('/grab')
  const rest = i === -1 ? '' : pathname.slice(i + '/grab'.length).replace(/^\/+|\/+$/g, '')
  const hit = ROUTES[rest]
  if (!hit) return 'not_found'
  return hit.methods.includes(method.toUpperCase()) ? hit.route : 'method_not_allowed'
}

// ── Our OAuth endpoint (Grab asks it for a token before calling us) ─────────
const enc = new TextEncoder()

const b64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function hmac(key: string, text: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64url(await crypto.subtle.sign('HMAC', k, enc.encode(text)))
}

/** Compares without stopping at the first difference, so timing leaks nothing. */
export function sameText(a: string, b: string): boolean {
  const x = enc.encode(a)
  const y = enc.encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

export const TOKEN_TTL_S = 7 * 24 * 3600

/** A token we hand Grab: "v1.<expiry>.<signature>", signed with our client secret, so
 *  changing the secret ends every token issued before. Nothing to store. */
export async function issueToken(secret: string, nowS: number): Promise<{ token: string; expiresIn: number }> {
  const head = `v1.${nowS + TOKEN_TTL_S}`
  return { token: `${head}.${await hmac(`grab-token:${secret}`, head)}`, expiresIn: TOKEN_TTL_S }
}

export async function verifyToken(secret: string, token: string, nowS: number): Promise<boolean> {
  const m = /^(v1\.(\d{1,12}))\.([A-Za-z0-9_-]{20,})$/.exec(token)
  if (!m || Number(m[2]) <= nowS) return false
  return sameText(m[3], await hmac(`grab-token:${secret}`, m[1]))
}

export const bearer = (header: string | null) => /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1] ?? null

/** PartnerOauthRequest, sent as JSON (Grab's spec) or as a form (OAuth's usual shape). */
export function parseOauthRequest(contentType: string | null, raw: string):
  { clientId: string; clientSecret: string; grantType: string } | null {
  let o: Record<string, unknown> = {}
  if ((contentType ?? '').includes('application/x-www-form-urlencoded')) {
    o = Object.fromEntries(new URLSearchParams(raw))
  } else {
    try { o = JSON.parse(raw) } catch { return null }
  }
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  if (!o || !s(o.client_id) || !s(o.client_secret)) return null
  return { clientId: s(o.client_id), clientSecret: s(o.client_secret), grantType: s(o.grant_type) }
}

// ── The menu Grab pulls (GetMenuNewResponse) ────────────────────────────────
export interface SourceOption { id: string; name: string; priceDeltaSen: number; available: boolean }
export interface SourceGroup { id: string; name: string; min: number; max: number; options: SourceOption[] }
export interface SourceVariant { id: string; name: string; priceSen: number; isBase: boolean }
export interface SourceProduct {
  id: string; name: string; description: string | null
  categoryId: string; categoryName: string; categorySort: number; sort: number
  soldOut: boolean; variants: SourceVariant[] | null; groups: SourceGroup[]
}
/** What grab_menu_source(merchant_id) returns. */
export interface MenuSource { merchantId: string; branchId: string; catalogId: string | null; isActive: boolean; products: SourceProduct[] }

export const ALL_DAY = 'all-day'
const OPEN_ALL_DAY = { openPeriodType: 'OpenAllDay' }

// Grab's limits (GetMenuNewResponse, MenuCategory, MenuItem, ModifierGroup)
const LIMITS = { categories: 100, itemsPerCategory: 300, groupsPerItem: 30, modifiersPerGroup: 100 }

/** Grab has no variants, so each priced variant is its own item (id = variant id, the
 *  same id a Submit order sends back): "Coffee Latte (COLD)", or the product's name when it
 *  has one variant. Problems Grab would refuse come back as warnings, nothing is cut. */
export function buildMenu(src: MenuSource) {
  const warnings: string[] = []
  const categories: any[] = []
  const byCategory = new Map<string, any>()

  for (const p of src.products) {
    const variants = p.variants ?? []
    if (!variants.length) continue
    let cat = byCategory.get(p.categoryId)
    if (!cat) {
      cat = { id: p.categoryId, name: p.categoryName, availableStatus: 'AVAILABLE', sellingTimeID: ALL_DAY, sequence: categories.length + 1, items: [] }
      byCategory.set(p.categoryId, cat)
      categories.push(cat)
    }
    const groups = p.groups
      .filter((g) => g.options.length > 0)
      .map((g, gi) => ({
        id: g.id,
        name: g.name,
        availableStatus: g.options.some((o) => o.available) ? 'AVAILABLE' : 'UNAVAILABLE',
        selectionRangeMin: Math.min(g.min, g.options.length),
        selectionRangeMax: Math.max(1, Math.min(g.max, g.options.length)),
        sequence: gi + 1,
        modifiers: g.options.map((o, oi) => ({
          id: o.id, name: o.name, availableStatus: o.available ? 'AVAILABLE' : 'UNAVAILABLE', price: o.priceDeltaSen, sequence: oi + 1,
        })),
      }))
    for (const g of groups) {
      if (g.modifiers.length > LIMITS.modifiersPerGroup) warnings.push(`${p.name} / ${g.name}: ${g.modifiers.length} modifiers (Grab allows ${LIMITS.modifiersPerGroup})`)
    }
    if (groups.length > LIMITS.groupsPerItem) warnings.push(`${p.name}: ${groups.length} modifier groups (Grab allows ${LIMITS.groupsPerItem})`)
    for (const v of variants) {
      cat.items.push({
        id: v.id,
        name: variants.length === 1 ? p.name : `${p.name} (${v.name})`,
        availableStatus: p.soldOut ? 'UNAVAILABLE' : 'AVAILABLE',
        price: v.priceSen,
        ...(p.description?.trim() ? { description: p.description.trim() } : {}),
        sequence: cat.items.length + 1,
        modifierGroups: groups,
      })
    }
  }
  if (categories.length > LIMITS.categories) warnings.push(`${categories.length} categories (Grab allows ${LIMITS.categories})`)
  for (const c of categories) {
    if (c.items.length > LIMITS.itemsPerCategory) warnings.push(`${c.name}: ${c.items.length} items (Grab allows ${LIMITS.itemsPerCategory})`)
  }

  return {
    menu: {
      merchantID: src.merchantId,
      partnerMerchantID: src.branchId,
      currency: { code: 'MYR', symbol: 'RM', exponent: 2 },
      sellingTimes: [{
        id: ALL_DAY, name: 'All day',
        serviceHours: { mon: OPEN_ALL_DAY, tue: OPEN_ALL_DAY, wed: OPEN_ALL_DAY, thu: OPEN_ALL_DAY, fri: OPEN_ALL_DAY, sat: OPEN_ALL_DAY, sun: OPEN_ALL_DAY },
      }],
      categories,
    },
    warnings,
  }
}

/** The variant ids a Submit order may name for this store. */
export const menuItemIds = (src: MenuSource) =>
  new Set(src.products.flatMap((p) => (p.variants ?? []).map((v) => v.id)))

// ── Submit order (SubmitOrderRequest) ───────────────────────────────────────
export interface GrabOrderRow {
  grab_order_id: string
  merchant_id: string
  short_order_number: string
  order_type: string
  accepted_type: 'AUTO' | 'MANUAL'
  payment_type: 'CASH' | 'CASHLESS'
  subtotal_sen: number
  total_sen: number | null
  cutlery: boolean
  order_time: string
  scheduled_time: string | null
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const isoOrNull = (v: unknown) => {
  const s = str(v)
  return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null
}

export function parseSubmitOrder(body: unknown):
  { ok: true; row: GrabOrderRow; itemIds: string[] } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' }
  const b = body as Record<string, any>
  for (const k of ['orderID', 'shortOrderNumber', 'merchantID']) {
    if (!str(b[k])) return { ok: false, error: `${k} is required` }
  }
  if (b.paymentType !== 'CASH' && b.paymentType !== 'CASHLESS') return { ok: false, error: 'paymentType must be CASH or CASHLESS' }
  const flags = b.featureFlags ?? {}
  if (flags.orderAcceptedType !== 'AUTO' && flags.orderAcceptedType !== 'MANUAL') return { ok: false, error: 'featureFlags.orderAcceptedType must be AUTO or MANUAL' }
  if (!str(flags.orderType)) return { ok: false, error: 'featureFlags.orderType is required' }
  const orderTime = isoOrNull(b.orderTime)
  if (!orderTime) return { ok: false, error: 'orderTime must be an ISO 8601 time' }
  if (b.currency?.code && b.currency.code !== 'MYR') return { ok: false, error: `currency ${b.currency.code} is not MYR` }
  if (!isInt(b.price?.subtotal)) return { ok: false, error: 'price.subtotal must be an integer (sen)' }
  if (!Array.isArray(b.items) || b.items.length === 0) return { ok: false, error: 'items must be a non-empty array' }
  for (const [i, it] of b.items.entries()) {
    if (!str(it?.id) || !isInt(it?.quantity) || it.quantity < 1 || !isInt(it?.price)) {
      return { ok: false, error: `items[${i}] needs id, quantity (≥ 1) and price (sen)` }
    }
  }
  return {
    ok: true,
    row: {
      grab_order_id: str(b.orderID),
      merchant_id: str(b.merchantID),
      short_order_number: str(b.shortOrderNumber),
      order_type: str(flags.orderType),
      accepted_type: flags.orderAcceptedType,
      payment_type: b.paymentType,
      subtotal_sen: b.price.subtotal,
      total_sen: isInt(b.price.total) ? b.price.total : null,
      cutlery: b.cutlery === true,
      order_time: orderTime,
      scheduled_time: isoOrNull(b.scheduledTime),
    },
    itemIds: b.items.map((it: any) => str(it.id)),
  }
}

// ── Push order state (OrderStateRequest) ────────────────────────────────────
export const ORDER_STATES = ['ACCEPTED', 'DRIVER_ALLOCATED', 'DRIVER_ARRIVED', 'COLLECTED', 'DELIVERED',
  'BILL_PAID', 'COMPLETED', 'REFUNDED', 'FAILED', 'CANCELLED'] as const

export function parseOrderState(body: unknown):
  { ok: true; orderId: string; merchantId: string; state: string } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, any>
  if (!str(b.orderID) || !str(b.merchantID)) return { ok: false, error: 'orderID and merchantID are required' }
  if (!ORDER_STATES.includes(b.state)) return { ok: false, error: `state must be one of ${ORDER_STATES.join(', ')}` }
  return { ok: true, orderId: str(b.orderID), merchantId: str(b.merchantID), state: b.state }
}

// ── Menu sync state and integration status webhooks ─────────────────────────
export function parseMenuSyncState(body: unknown):
  { ok: true; merchantId: string; jobId: string | null; status: string; errors: string[] } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, any>
  if (!str(b.merchantID)) return { ok: false, error: 'merchantID is required' }
  if (!['QUEUEING', 'PROCESSING', 'SUCCESS', 'FAILED'].includes(b.status)) return { ok: false, error: 'status must be QUEUEING, PROCESSING, SUCCESS or FAILED' }
  const errors = Array.isArray(b.errors) ? b.errors.filter((e: unknown) => typeof e === 'string') : []
  return { ok: true, merchantId: str(b.merchantID), jobId: str(b.jobID) || null, status: b.status, errors }
}

export function parseIntegrationStatus(body: unknown):
  { ok: true; merchantId: string; status: string } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, any>
  if (!str(b.grabMerchantID)) return { ok: false, error: 'grabMerchantID is required' }
  if (!['INACTIVE', 'ACTIVE', 'SYNCING', 'FAILED'].includes(b.integrationStatus)) {
    return { ok: false, error: 'integrationStatus must be INACTIVE, ACTIVE, SYNCING or FAILED' }
  }
  return { ok: true, merchantId: str(b.grabMerchantID), status: b.integrationStatus }
}
