// The pure parts of member-auth (no Deno APIs), tested with Vitest in logic.test.ts.

// ── Body ──────────────────────────────────────────────────────────────────────

export type AuthBody =
  | { action: 'request'; phone: string; table: string }
  | { action: 'verify'; phone: string; code: string; device: string | null }

/** The request body, or null when it is neither action. Phone and code are checked later, so a bad
 *  number answers `invalid_phone` rather than a 400. A request names its QR table (the table token). */
export function parseBody(body: unknown): AuthBody | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (typeof b.phone !== 'string' || b.phone.length > 40) return null
  if (b.action === 'request') {
    if (typeof b.table !== 'string' || b.table.length === 0 || b.table.length > 100) return null
    return { action: 'request', phone: b.phone, table: b.table }
  }
  if (b.action === 'verify') {
    if (typeof b.code !== 'string' || b.code.length > 20) return null
    const device = typeof b.device === 'string' && b.device.length <= 512 ? b.device : null
    return { action: 'verify', phone: b.phone, code: b.code, device }
  }
  return null
}

// ── Phone ─────────────────────────────────────────────────────────────────────

/** A Malaysian mobile number in any shape people type or paste → E.164, or null. The same rule as the
 *  client's src/shared/lib/memberPhone.ts (both tests run the one case table, memberPhoneCases.ts): NFKC
 *  first (full-width digits and signs become ASCII), then every space, dash, invisible format mark (the
 *  bidi marks a contacts app wraps a number in), bracket and dot is dropped; then a leading +60 / 60 /
 *  0060, then one leading 0; what is left must be 1 then 11 + 8 digits or 1[02-9] + 7 digits. Wider than
 *  SQL member_phone_normalise, which only ever receives the E.164 this returns. */
export function normalisePhone(phone: string | null | undefined): string | null {
  const n = (phone ?? '').normalize('NFKC').replace(/[\s\p{Pd}\p{Cf}\u2212().]/gu, '')
    .replace(/^(\+?60|0060)/, '').replace(/^0/, '')
  return /^1(1[0-9]{8}|[02-9][0-9]{7})$/.test(n) ? '+60' + n : null
}

/** For logs only: the last 4 digits. */
export function maskForLog(phone: string | null | undefined): string {
  const d = (phone ?? '').replace(/\D/g, '')
  return d.length >= 4 ? '••' + d.slice(-4) : '••'
}

// ── Codes, tokens, hashes ─────────────────────────────────────────────────────

const CODE_SPACE = 1_000_000
// the largest multiple of 10^6 below 2^32: values at or above it are drawn again, so every code is equally likely
const CODE_LIMIT = Math.floor(0x1_0000_0000 / CODE_SPACE) * CODE_SPACE

/** A uniform 6-digit code, leading zeros kept. `random` is injectable for the rejection test. */
export function makeCode(random: (a: Uint32Array) => Uint32Array = (a) => crypto.getRandomValues(a)): string {
  const buf = new Uint32Array(1)
  for (;;) {
    const v = random(buf)[0]
    if (v < CODE_LIMIT) return String(v % CODE_SPACE).padStart(6, '0')
  }
}

/** The code as the guest typed it (spaces allowed), or null when it cannot be a code. */
export function cleanCode(code: string): string | null {
  const c = code.replace(/\s/g, '')
  return /^[0-9]{6}$/.test(c) ? c : null
}

/** 32 random bytes, base64url without padding (43 characters). */
export function makeToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The stored code hash: salted with the number, so a table of all 10^6 bare hashes is useless. */
export function codeHash(e164: string, code: string): Promise<string> {
  return sha256Hex(`${e164}:${code}`)
}

export function smsText(code: string): string {
  return `Craft Cafe: your code is ${code}. It expires in 5 minutes.`
}

// ── SMS provider ──────────────────────────────────────────────────────────────

export interface SmsProvider {
  /** 'log' sends nothing and hands the plain code to SQL (member_otps.dev_code); a real one sends. */
  kind: 'log' | 'real'
  name: string
  sendSms(to: string, text: string): Promise<void>
}

type Env = (name: string) => string | undefined

/** A real provider's adapter: reads its own secrets, returns null when they are missing. */
export type RealProviderFactory = (env: Env) => SmsProvider | null

// ── REAL PROVIDER (Task 20) ───────────────────────────────────────────────────
// The owner picks and signs up for the vendor. Its adapter goes here, keyed by the SMS_PROVIDER value,
// e.g. `example: exampleProvider`. Until then every value but 'log' answers `unavailable`.
//
//   const exampleProvider: RealProviderFactory = (env) => {
//     const key = env('EXAMPLE_SMS_KEY'); if (!key) return null
//     return { kind: 'real', name: 'example', async sendSms(to, text) { /* POST to the vendor; throw on failure */ } }
//   }
export const REAL_PROVIDERS: Record<string, RealProviderFactory> = {}

/** The provider the secrets choose, or null (→ `unavailable`): unset, unknown, a real one missing its
 *  secrets, or `log` without MEMBER_AUTH_ALLOW_LOG=1 (dev sets it; prod never will). */
export function selectProvider(env: Env, real: Record<string, RealProviderFactory> = REAL_PROVIDERS): SmsProvider | null {
  const name = (env('SMS_PROVIDER') ?? '').trim().toLowerCase()
  if (!name) return null
  if (name === 'log') {
    if (env('MEMBER_AUTH_ALLOW_LOG') !== '1') return null
    return { kind: 'log', name: 'log', async sendSms() { /* nothing leaves: the code is in member_otps.dev_code */ } }
  }
  const factory = Object.prototype.hasOwnProperty.call(real, name) ? real[name] : undefined
  return factory ? factory(env) : null
}

// ── Replies ───────────────────────────────────────────────────────────────────

export type RequestReply = { ok: true } | { ok: false; reason: 'rate' | 'busy' | 'unavailable' | 'invalid_phone' }
export type VerifyReply =
  | { ok: true; token: string }
  | { ok: false; reason: 'wrong' | 'expired' | 'locked' | 'invalid_phone' | 'unavailable' }

/** member_otp_request's answer → the reply when it is not 'ok' (then the SMS still has to go). */
export function requestRefusal(sql: string): RequestReply {
  switch (sql) {
    case 'rate_number':
    case 'rate_ip':
      return { ok: false, reason: 'rate' }
    case 'cap':
    case 'rate_table': // the table's 20 a day: staff can add the number at the counter
      return { ok: false, reason: 'busy' }
    default: // 'disabled' (members off, or the table unknown, inactive or QR-paused) or anything unexpected
      return { ok: false, reason: 'unavailable' }
  }
}

/** member_otp_verify's answer → the reply (the token is added on 'ok'). */
export function verifyReply(sql: string, token: string): VerifyReply {
  switch (sql) {
    case 'ok':
      return { ok: true, token }
    case 'wrong':
    case 'expired':
    case 'locked':
      return { ok: false, reason: sql }
    default:
      return { ok: false, reason: 'unavailable' }
  }
}

// ── Device label ──────────────────────────────────────────────────────────────

/** A short label like 'iPhone Safari' from a User-Agent, at most 60 characters, never the raw string;
 *  null when nothing is recognised. */
export function deviceLabel(ua: string | null | undefined): string | null {
  if (!ua) return null
  const device =
    /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet')
    : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows'
    : /CrOS/.test(ua) ? 'Chromebook'
    : /Linux/.test(ua) ? 'Linux'
    : null
  const browser =
    /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /EdgiOS|EdgA|Edg\//.test(ua) ? 'Edge'
    : /OPR\/|OPiOS/.test(ua) ? 'Opera'
    : /FxiOS|Firefox\//.test(ua) ? 'Firefox'
    : /CriOS|Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : null
  const label = [device, browser].filter(Boolean).join(' ')
  return label ? label.slice(0, 60) : null
}

/** The caller's IP for the per-IP limits: cf-connecting-ip only, which Supabase's edge (Cloudflare) sets
 *  and refuses from a client (error 1000; checked on dev 2026-11-23). Never X-Forwarded-For or
 *  sb-forwarded-for, whose left-most entry a client can write. An IPv6 address is cut to its /64 (one
 *  phone or one household holds a whole /64, so the full address would make every limit per-address
 *  meaningless). Null when the header is missing or unreadable: the function then answers `unavailable`. */
export function memberClientIp(headers: { get(name: string): string | null }): string | null {
  const raw = headers.get('cf-connecting-ip')?.split(',')[0]?.trim()
  if (!raw) return null
  if (!raw.includes(':')) return /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(raw) ? raw : null
  return ipv6Prefix64(raw)
}

/** '2001:db8:1:2:3:4:5:6' → '2001:db8:1:2::/64'; an IPv4-mapped '::ffff:1.2.3.4' → '1.2.3.4'; null when
 *  it is not an IPv6 address. */
export function ipv6Prefix64(ip: string): string | null {
  const addr = ip.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase()
  const mapped = /^(?:::|(?:0{1,4}:){5})ffff:([0-9]{1,3}(?:\.[0-9]{1,3}){3})$/.exec(addr)
  if (mapped) return mapped[1]
  if (!/^[0-9a-f:]+$/.test(addr) || addr.split('::').length > 2) return null
  const [head, tail] = addr.includes('::') ? addr.split('::') : [addr, null]
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  if ([...h, ...t].some((g) => g.length === 0 || g.length > 4)) return null
  let groups: string[]
  if (tail === null) {
    if (h.length !== 8) return null
    groups = h
  } else {
    if (h.length + t.length > 7) return null
    groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]
  }
  return groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':') + '::/64'
}
