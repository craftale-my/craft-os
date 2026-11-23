// The member-auth handler with its outside world passed in (deps), so handler.test.ts can run it with a
// fake rpc and fake secrets. index.ts wires the real ones (the service-role client and Deno.env).

import {
  type RealProviderFactory, type RequestReply, type VerifyReply,
  cleanCode, codeHash, deviceLabel, makeCode as makeCodeReal, makeToken as makeTokenReal, maskForLog,
  memberClientIp, normalisePhone, parseBody, requestRefusal, selectProvider, SendFailure, sha256Hex, verifyReply,
} from './logic.ts'
import { whatsappProvider } from './whatsapp.ts'

/** The real channels, keyed by the SMS_PROVIDER value (every other value but 'log' answers `unavailable`). */
export const REAL_PROVIDERS: Record<string, RealProviderFactory> = {
  whatsapp: (env) => whatsappProvider(env),
}

export interface RpcResult { data: unknown; error: { message: string } | null }

export interface Deps {
  /** A service-role RPC call. */
  rpc(fn: string, args: Record<string, unknown>): Promise<RpcResult>
  env(name: string): string | undefined
  log?: { info(...a: unknown[]): void; error(...a: unknown[]): void }
  /** Test seams; the real ones (REAL_PROVIDERS, makeCode, makeToken) by default. */
  realProviders?: Record<string, RealProviderFactory>
  makeCode?: () => string
  makeToken?: () => string
}

/** The body is read up to this many bytes; a longer one is refused (413) before it is parsed. */
export const MAX_BODY_BYTES = 2048

const BASE_HEADERS = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
}

/** The QR origins allowed to call (secret MEMBER_AUTH_ORIGINS, comma-separated, exact match). */
export function allowedOrigins(env: Deps['env']): string[] {
  return (env('MEMBER_AUTH_ORIGINS') ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean)
}

/** Whether a Content-Type header is JSON (parameters such as charset allowed). */
export function isJsonContentType(ct: string | null): boolean {
  return (ct ?? '').split(';')[0].trim().toLowerCase() === 'application/json'
}

/** The body as text, or null when it is longer than `max` bytes (read in chunks, never all at once). */
export async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) return null
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) { await reader.cancel().catch(() => {}); return null }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const c of chunks) { all.set(c, at); at += c.byteLength }
  return new TextDecoder().decode(all)
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const log = deps.log ?? console
  const origin = (req.headers.get('origin') ?? '').replace(/\/+$/, '')
  // only the QR page's own sites: another site cannot make a guest's browser ask for codes
  if (!origin || !allowedOrigins(deps.env).includes(origin)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Origin' },
    })
  }
  const cors = { ...BASE_HEADERS, 'Access-Control-Allow-Origin': origin }
  // no-store: the verify reply carries the member token
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  // a JSON body needs a CORS preflight from a browser: a plain form post from another page cannot send one
  if (!isJsonContentType(req.headers.get('content-type'))) return json({ error: 'Content-Type must be application/json' }, 415)

  try {
    const text = await readCapped(req, MAX_BODY_BYTES)
    if (text === null) return json({ error: 'Request too large' }, 413)
    let body: unknown
    try { body = JSON.parse(text) } catch { return json({ error: 'Invalid request' }, 400) }
    const input = parseBody(body)
    if (!input) return json({ error: 'Invalid request' }, 400)

    const phone = normalisePhone(input.phone)
    if (!phone) return json({ ok: false, reason: 'invalid_phone' })

    // the platform-set client address (an IPv6 one cut to its /64); the SQL requires one
    const ip = memberClientIp(req.headers)
    if (!ip) {
      log.error('member-auth: no platform client IP header')
      return json({ ok: false, reason: 'unavailable' })
    }

    if (input.action === 'request') {
      const reply: RequestReply = await requestCode(deps, log, phone, ip, input.table)
      return json(reply)
    }

    const code = cleanCode(input.code)
    // a string that cannot be a code can never match: answered without a call, so no try is spent
    if (!code) return json({ ok: false, reason: 'wrong' } satisfies VerifyReply)
    const token = (deps.makeToken ?? makeTokenReal)()
    const { data, error } = await deps.rpc('member_otp_verify', {
      p_phone: phone,
      p_code_hash: await codeHash(phone, code),
      p_token_hash: await sha256Hex(token),
      p_device: deviceLabel(input.device ?? req.headers.get('user-agent')),
      p_ip: ip,
    })
    if (error) {
      log.error('member_otp_verify', maskForLog(phone), error.message)
      return json({ ok: false, reason: 'unavailable' } satisfies VerifyReply)
    }
    const reply = verifyReply(String(data), token)
    if (!reply.ok) log.info('verify', maskForLog(phone), reply.reason)
    return json(reply)
  } catch (e) {
    log.error('member-auth', e instanceof Error ? e.message : String(e))
    return json({ error: 'Something went wrong. Try again.' }, 500)
  }
}

async function requestCode(deps: Deps, log: NonNullable<Deps['log']>, phone: string, ip: string, table: string): Promise<RequestReply> {
  const provider = selectProvider(deps.env, deps.realProviders ?? REAL_PROVIDERS)
  if (!provider) {
    log.error('member-auth: no code provider (SMS_PROVIDER unset or unknown, its secrets missing, or log mode not allowed)')
    return { ok: false, reason: 'unavailable' }
  }
  const code = (deps.makeCode ?? makeCodeReal)()
  const hash = await codeHash(phone, code)
  const { data, error } = await deps.rpc('member_otp_request', {
    p_phone: phone,
    p_ip: ip,
    p_code_hash: hash,
    p_dev_code: provider.kind === 'log' ? code : null,
    p_table_token: table,
  })
  if (error) {
    log.error('member_otp_request', maskForLog(phone), error.message)
    return { ok: false, reason: 'unavailable' }
  }
  if (data !== 'ok') {
    log.info('request', maskForLog(phone), data)
    return requestRefusal(String(data))
  }
  try {
    await provider.sendCode(phone, code)
  } catch (e) {
    const reason = e instanceof SendFailure ? e.reason : 'unavailable'
    // a SendFailure's detail holds only status / codes / trace id; any other message may echo the number
    // or the code: digit runs are cut out
    const what = e instanceof SendFailure ? e.detail : (e instanceof Error ? e.message : String(e)).replace(/\d{4,}/g, '…')
    log.error('sendCode', provider.name, maskForLog(phone), reason, what)
    // the code never left: the stored one must not be confirmable
    const { error: voidErr } = await deps.rpc('member_otp_void', { p_phone: phone, p_code_hash: hash })
    if (voidErr) log.error('member_otp_void', maskForLog(phone), voidErr.message)
    return { ok: false, reason }
  }
  return { ok: true }
}
