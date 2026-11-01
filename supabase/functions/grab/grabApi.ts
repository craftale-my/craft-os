// Calls from us to GrabFood's partner API, with the client credentials Grab issues in its
// developer portal. Paths and bodies follow Grab's OpenAPI spec (GrabFood API 1.1.3).

export type GrabEnv = 'sandbox' | 'production'

const BASE: Record<GrabEnv, string> = {
  sandbox: 'https://partner-api.grab.com/grabfood-sandbox',
  production: 'https://partner-api.grab.com/grabfood',
}
// the same token host for both environments (the spec lists api.grab.com for each)
const OAUTH_URL = 'https://api.grab.com/grabid/v1/oauth2/token'

export class GrabApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message)
  }
}

export interface GrabCall { method: string; path: string; status: number; body: unknown }

export class GrabClient {
  private token: { value: string; expiresAt: number } | null = null

  constructor(
    private readonly env: GrabEnv,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly onCall: (c: GrabCall) => Promise<void> = async () => {},
  ) {}

  /** Reused until a minute before it expires (Grab's tokens last 7 days). */
  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value
    const res = await fetch(OAUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId, client_secret: this.clientSecret,
        grant_type: 'client_credentials', scope: 'food.partner_api',
      }),
    })
    const body = await res.json().catch(() => null)
    await this.onCall({ method: 'POST', path: 'oauth2/token', status: res.status, body: res.ok ? { expires_in: body?.expires_in } : body })
    if (!res.ok || typeof body?.access_token !== 'string') throw new GrabApiError('Grab refused our client credentials', res.status, body)
    this.token = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000 }
    return this.token.value
  }

  private async call(method: string, path: string, payload?: unknown) {
    const res = await fetch(`${BASE[this.env]}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await this.accessToken()}` },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    })
    const text = await res.text()
    let body: unknown = text || null
    try { body = text ? JSON.parse(text) : null } catch { /* keep the text */ }
    await this.onCall({ method, path, status: res.status, body })
    if (!res.ok) throw new GrabApiError(`Grab answered ${res.status} to ${method} ${path}`, res.status, body)
    return { status: res.status, body, jobId: res.headers.get('x-job-id') }
  }

  /** Accept or reject an order Grab sent with orderAcceptedType MANUAL. */
  acceptOrder(orderId: string, accept: boolean) {
    return this.call('POST', '/partner/v1/order/prepare', { orderID: orderId, toState: accept ? 'Accepted' : 'Rejected' })
  }

  /** markStatus 1 = food is ready. */
  markReady(orderId: string) {
    return this.call('POST', '/partner/v1/orders/mark', { orderID: orderId, markStatus: 1 })
  }

  pauseStore(merchantId: string, pause: boolean, duration?: '30m' | '1h' | '24h') {
    return this.call('PUT', '/partner/v1/merchant/pause', { merchantID: merchantId, isPause: pause, ...(pause ? { duration: duration ?? '30m' } : {}) })
  }

  /** Asks Grab to pull our menu again; the job's result arrives at the menu sync webhook. */
  notifyMenuUpdate(merchantId: string) {
    return this.call('POST', '/partner/v1/merchant/menu/notification', { merchantID: merchantId })
  }

  storeStatus(merchantId: string) {
    return this.call('GET', `/partner/v1/merchants/${encodeURIComponent(merchantId)}/store/status`)
  }
}
