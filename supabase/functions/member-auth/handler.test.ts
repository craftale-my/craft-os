import { describe, expect, it, vi } from 'vitest'
import { type Deps, type RpcResult, handle, MAX_BODY_BYTES } from './handler'
import type { RealProviderFactory } from './logic'

const ORIGIN = 'https://qr.example.test'
const URL_ = 'https://fn.example.test/functions/v1/member-auth'

type Call = { fn: string; args: Record<string, unknown> }

function makeDeps(opts: {
  env?: Record<string, string>
  answers?: Record<string, RpcResult | ((args: Record<string, unknown>) => RpcResult)>
  realProviders?: Record<string, RealProviderFactory>
} = {}) {
  const calls: Call[] = []
  const env = { MEMBER_AUTH_ORIGINS: `${ORIGIN}, http://localhost:5199`, SMS_PROVIDER: 'log', MEMBER_AUTH_ALLOW_LOG: '1', ...opts.env }
  const deps: Deps = {
    env: (n) => env[n as keyof typeof env],
    rpc: async (fn, args) => {
      calls.push({ fn, args })
      const a = opts.answers?.[fn]
      if (typeof a === 'function') return a(args)
      return a ?? { data: 'ok', error: null }
    },
    log: { info: () => {}, error: () => {} },
    realProviders: opts.realProviders,
    makeCode: () => '123456',
    makeToken: () => 'T'.repeat(43),
  }
  return { deps, calls }
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(URL_, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}
const REQ = { action: 'request', phone: '012-345 6789', table: 'tabletok' }
const VER = { action: 'verify', phone: '012-345 6789', code: '123 456' }

describe('origin, method, content type and size', () => {
  it('no Origin or a foreign one → 403 without CORS, no rpc', async () => {
    const { deps, calls } = makeDeps()
    for (const origin of [undefined, 'https://evil.example', 'null', `${ORIGIN}.evil.example`]) {
      const headers: Record<string, string> = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' }
      if (origin) headers.origin = origin
      const res = await handle(new Request(URL_, { method: 'POST', headers, body: JSON.stringify(REQ) }), deps)
      expect(res.status).toBe(403)
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    }
    expect(calls).toHaveLength(0)
  })
  it('no secret set → every origin is refused', async () => {
    const { deps } = makeDeps({ env: { MEMBER_AUTH_ORIGINS: '' } })
    expect((await handle(post(REQ), deps)).status).toBe(403)
  })
  it('an allowed origin is echoed, never *', async () => {
    const { deps } = makeDeps()
    const res = await handle(post(REQ, { origin: 'http://localhost:5199' }), deps)
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5199')
    expect(res.headers.get('vary')).toBe('Origin')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
  it('OPTIONS preflight from an allowed origin; another method → 405', async () => {
    const { deps } = makeDeps()
    const pre = await handle(new Request(URL_, { method: 'OPTIONS', headers: { origin: ORIGIN } }), deps)
    expect(pre.status).toBe(200)
    expect(pre.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(pre.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS')
    const bad = await handle(new Request(URL_, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), deps)
    expect(bad.status).toBe(403)
    const get = await handle(new Request(URL_, { method: 'GET', headers: { origin: ORIGIN } }), deps)
    expect(get.status).toBe(405)
  })
  it('text/plain, a form or no Content-Type → 415, no rpc', async () => {
    const { deps, calls } = makeDeps()
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) {
      const res = await handle(post(REQ, { 'content-type': ct }), deps)
      expect(res.status).toBe(415)
    }
    expect(calls).toHaveLength(0)
    expect((await handle(post(REQ, { 'content-type': 'application/json; charset=utf-8' }), deps)).status).toBe(200)
  })
  it('a body over 2 KB → 413 before parsing, no rpc', async () => {
    const { deps, calls } = makeDeps()
    const big = JSON.stringify({ ...REQ, pad: 'x'.repeat(MAX_BODY_BYTES) })
    const res = await handle(post(big), deps)
    expect(res.status).toBe(413)
    // also when no Content-Length is declared (a stream)
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close() } })
    const res2 = await handle(new Request(URL_, {
      method: 'POST', body: stream, headers: { origin: ORIGIN, 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' },
      // @ts-expect-error duplex is needed for a stream body in Node
      duplex: 'half',
    }), deps)
    expect(res2.status).toBe(413)
    expect(calls).toHaveLength(0)
  })
  it('not JSON, or no table on a request → 400', async () => {
    const { deps } = makeDeps()
    expect((await handle(post('{nope'), deps)).status).toBe(400)
    expect((await handle(post({ action: 'request', phone: '0123456789' }), deps)).status).toBe(400)
  })
})

describe('request', () => {
  it('passes the number, the IP, the hash, the dev code (log mode) and the table', async () => {
    const { deps, calls } = makeDeps()
    const res = await handle(post(REQ), deps)
    expect(await res.json()).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0].fn).toBe('member_otp_request')
    expect(calls[0].args).toMatchObject({ p_phone: '+60123456789', p_ip: '203.0.113.7', p_dev_code: '123456', p_table_token: 'tabletok' })
    expect(calls[0].args.p_code_hash).toMatch(/^[0-9a-f]{64}$/)
  })
  it('an IPv6 caller is passed as its /64', async () => {
    const { deps, calls } = makeDeps()
    await handle(post(REQ, { 'cf-connecting-ip': '2001:db8:1:2:aaaa:bbbb:cccc:dddd' }), deps)
    expect(calls[0].args.p_ip).toBe('2001:db8:1:2::/64')
  })
  it('p_dev_code is null for a real provider', async () => {
    const send = vi.fn(async () => {})
    const real: Record<string, RealProviderFactory> = { fake: () => ({ kind: 'real', name: 'fake', sendSms: send }) }
    const { deps, calls } = makeDeps({ env: { SMS_PROVIDER: 'fake' }, realProviders: real })
    expect(await (await handle(post(REQ), deps)).json()).toEqual({ ok: true })
    expect(calls[0].args.p_dev_code).toBeNull()
    expect(send).toHaveBeenCalledWith('+60123456789', 'Craft Cafe: your code is 123456. It expires in 5 minutes.')
  })
  it('a failed send voids the stored code and answers unavailable', async () => {
    const real: Record<string, RealProviderFactory> = {
      fake: () => ({ kind: 'real', name: 'fake', async sendSms() { throw new Error('vendor down for 60123456789') } }),
    }
    const { deps, calls } = makeDeps({ env: { SMS_PROVIDER: 'fake' }, realProviders: real })
    expect(await (await handle(post(REQ), deps)).json()).toEqual({ ok: false, reason: 'unavailable' })
    expect(calls.map((c) => c.fn)).toEqual(['member_otp_request', 'member_otp_void'])
    expect(calls[1].args).toEqual({ p_phone: '+60123456789', p_code_hash: calls[0].args.p_code_hash })
  })
  it('no cf-connecting-ip (an X-Forwarded-For does not count) → unavailable, no rpc', async () => {
    const { deps, calls } = makeDeps()
    const res = await handle(post(REQ, { 'cf-connecting-ip': '', 'x-forwarded-for': '6.6.6.6' }), deps)
    expect(await res.json()).toEqual({ ok: false, reason: 'unavailable' })
    expect(calls).toHaveLength(0)
  })
  it('no provider → unavailable, nothing stored', async () => {
    const { deps, calls } = makeDeps({ env: { SMS_PROVIDER: '' } })
    expect(await (await handle(post(REQ), deps)).json()).toEqual({ ok: false, reason: 'unavailable' })
    expect(calls).toHaveLength(0)
  })
  it('the SQL answers map to reasons', async () => {
    for (const [sql, reason] of [['rate_number', 'rate'], ['rate_ip', 'rate'], ['rate_table', 'busy'], ['cap', 'busy'], ['disabled', 'unavailable']]) {
      const { deps } = makeDeps({ answers: { member_otp_request: { data: sql, error: null } } })
      expect(await (await handle(post(REQ), deps)).json()).toEqual({ ok: false, reason })
    }
    const { deps } = makeDeps({ answers: { member_otp_request: { data: null, error: { message: 'boom' } } } })
    expect(await (await handle(post(REQ), deps)).json()).toEqual({ ok: false, reason: 'unavailable' })
  })
  it('a bad number → invalid_phone, no rpc', async () => {
    const { deps, calls } = makeDeps()
    expect(await (await handle(post({ ...REQ, phone: '03-1234 5678' }), deps)).json()).toEqual({ ok: false, reason: 'invalid_phone' })
    expect(calls).toHaveLength(0)
  })
  it('a member and a non-member get byte-identical replies', async () => {
    // the handler never asks who is a member; the SQL answers the same for both
    const { deps } = makeDeps()
    const a = await handle(post({ ...REQ, phone: '0123456789' }), deps)
    const b = await handle(post({ ...REQ, phone: '0129999999' }), deps)
    expect(a.status).toBe(b.status)
    expect(await a.text()).toBe(await b.text())
    expect([...a.headers.entries()]).toEqual([...b.headers.entries()])
  })
})

describe('verify', () => {
  it('passes the IP and the device label; spaces in the code are dropped', async () => {
    const { deps, calls } = makeDeps()
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
    const res = await handle(post({ ...VER, device: ua }), deps)
    expect(await res.json()).toEqual({ ok: true, token: 'T'.repeat(43) })
    expect(calls[0].fn).toBe('member_otp_verify')
    expect(calls[0].args).toMatchObject({ p_phone: '+60123456789', p_device: 'iPhone Safari', p_ip: '203.0.113.7' })
  })
  it('a malformed code → wrong without an rpc (no try spent)', async () => {
    const { deps, calls } = makeDeps()
    for (const code of ['12', '1234567', '12a456', '']) {
      expect(await (await handle(post({ ...VER, code }), deps)).json()).toEqual({ ok: false, reason: 'wrong' })
    }
    expect(calls).toHaveLength(0)
  })
  it('no IP → unavailable, no rpc', async () => {
    const { deps, calls } = makeDeps()
    expect(await (await handle(post(VER, { 'cf-connecting-ip': '' }), deps)).json()).toEqual({ ok: false, reason: 'unavailable' })
    expect(calls).toHaveLength(0)
  })
  it('the SQL answers map to reasons; an rpc error → unavailable', async () => {
    for (const r of ['wrong', 'expired', 'locked']) {
      const { deps } = makeDeps({ answers: { member_otp_verify: { data: r, error: null } } })
      expect(await (await handle(post(VER), deps)).json()).toEqual({ ok: false, reason: r })
    }
    const { deps } = makeDeps({ answers: { member_otp_verify: { data: null, error: { message: 'x' } } } })
    expect(await (await handle(post(VER), deps)).json()).toEqual({ ok: false, reason: 'unavailable' })
  })
})
