import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  cleanCode, codeHash, deviceLabel, makeCode, makeToken, maskForLog, memberClientIp, normalisePhone, parseBody,
  requestRefusal, selectProvider, sha256Hex, smsText, verifyReply, type RealProviderFactory,
} from './logic'

const envOf = (vars: Record<string, string>) => (n: string) => vars[n]

describe('normalisePhone (mirrors the M2 cases of migration-2026-11-23-members-verify.sql)', () => {
  const cases: [string, string | null][] = [
    ['0123456789', '+60123456789'], ['60123456789', '+60123456789'], ['+60123456789', '+60123456789'],
    ['012-345 6789', '+60123456789'], ['+60 12-345 6789', '+60123456789'], ['123456789', '+60123456789'],
    ['011-2345 6789', '+601123456789'], ['+601123456789', '+601123456789'],
    ['0312345678', null], ['+6531234567', null], ['01234567', null], ['012345678901', null],
    ['abc', null], ['', null],
    // the review rules: +60 / 60 / 0060 then one optional 0; 011 has 8 more digits, other 01x 7
    ['+60 012-345 6789', '+60123456789'], ['+600123456789', '+60123456789'], ['0060123456789', '+60123456789'],
    ['00600123456789', '+60123456789'], ['01234567890', null], ['0112345678', null], ['011234567890', null],
    ['1123456789', '+601123456789'], ['+60 11-2345 6789', '+601123456789'], ['0060 11 2345 6789', '+601123456789'],
    ['+6000123456789', null], ['0123456789 ', '+60123456789'], ['+60', null], ['0', null],
  ]
  it.each(cases)('%s → %s', (input, want) => expect(normalisePhone(input)).toBe(want))
  it('null, brackets and dots, and no Unicode spaces (the SQL would refuse those)', () => {
    expect(normalisePhone(null)).toBeNull()
    expect(normalisePhone('(012) 345.6789')).toBe('+60123456789')
    expect(normalisePhone('012 3456789')).toBeNull()
  })
})

describe('maskForLog', () => {
  it('keeps the last 4 digits only', () => {
    expect(maskForLog('+60123456789')).toBe('••6789')
    expect(maskForLog('12')).toBe('••')
    expect(maskForLog(null)).toBe('••')
  })
})

describe('makeCode', () => {
  it('six digits, leading zeros kept', () => {
    expect(makeCode((a) => { a[0] = 42; return a })).toBe('000042')
    for (let i = 0; i < 200; i++) expect(makeCode()).toMatch(/^[0-9]{6}$/)
  })
  it('draws again above the largest multiple of 10^6 (no modulo bias)', () => {
    const draws = [0xffffffff, 4_294_000_000, 4_293_999_999]
    let n = 0
    expect(makeCode((a) => { a[0] = draws[n++]; return a })).toBe('999999')
    expect(n).toBe(3)
  })
  it('uniform within a loose bound: each leading digit near 10%', () => {
    const counts = new Array(10).fill(0)
    const N = 20_000
    for (let i = 0; i < N; i++) counts[Number(makeCode()[0])]++
    for (const c of counts) expect(Math.abs(c - N / 10)).toBeLessThan(N / 10 * 0.12) // ~5.7 sigma
  })
})

describe('cleanCode', () => {
  it('six digits, spaces dropped; anything else null', () => {
    expect(cleanCode('012345')).toBe('012345')
    expect(cleanCode(' 123 456 ')).toBe('123456')
    expect(cleanCode('12345')).toBeNull()
    expect(cleanCode('1234567')).toBeNull()
    expect(cleanCode('12a456')).toBeNull()
  })
})

describe('hashes and tokens', () => {
  it('sha256Hex matches node', async () => {
    expect(await sha256Hex('abc')).toBe(createHash('sha256').update('abc').digest('hex'))
  })
  it('the code hash is salted with the E.164 number', async () => {
    const h = await codeHash('+60123456789', '012345')
    expect(h).toBe(createHash('sha256').update('+60123456789:012345').digest('hex'))
    expect(h).not.toBe(await sha256Hex('012345'))
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })
  it('a token is 32 bytes base64url, new each time', () => {
    const a = makeToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(a, 'base64url')).toHaveLength(32)
    expect(makeToken()).not.toBe(a)
  })
})

describe('smsText', () => {
  it('the exact wording', () => {
    expect(smsText('123456')).toBe('Craft Cafe: your code is 123456. It expires in 5 minutes.')
  })
})

describe('selectProvider', () => {
  it('log only with MEMBER_AUTH_ALLOW_LOG=1', () => {
    expect(selectProvider(envOf({ SMS_PROVIDER: 'log', MEMBER_AUTH_ALLOW_LOG: '1' }))?.kind).toBe('log')
    expect(selectProvider(envOf({ SMS_PROVIDER: 'log' }))).toBeNull()
    expect(selectProvider(envOf({ SMS_PROVIDER: 'log', MEMBER_AUTH_ALLOW_LOG: 'true' }))).toBeNull()
  })
  it('unset, empty or unknown → null', () => {
    expect(selectProvider(envOf({}))).toBeNull()
    expect(selectProvider(envOf({ SMS_PROVIDER: ' ' }))).toBeNull()
    expect(selectProvider(envOf({ SMS_PROVIDER: 'acme', MEMBER_AUTH_ALLOW_LOG: '1' }))).toBeNull()
    expect(selectProvider(envOf({ SMS_PROVIDER: 'constructor' }))).toBeNull()
  })
  it('a registered real provider, null when its secrets are missing', () => {
    const fake: RealProviderFactory = (env) =>
      env('FAKE_KEY') ? { kind: 'real', name: 'fake', async sendSms() {} } : null
    expect(selectProvider(envOf({ SMS_PROVIDER: 'fake', FAKE_KEY: 'k' }), { fake })?.name).toBe('fake')
    expect(selectProvider(envOf({ SMS_PROVIDER: 'fake' }), { fake })).toBeNull()
  })
  it('the log adapter sends nothing and does not throw', async () => {
    const p = selectProvider(envOf({ SMS_PROVIDER: 'LOG', MEMBER_AUTH_ALLOW_LOG: '1' }))
    await expect(p!.sendSms('+60123456789', 'x')).resolves.toBeUndefined()
  })
})

describe('reason mapping', () => {
  it('member_otp_request', () => {
    expect(requestRefusal('rate_number')).toEqual({ ok: false, reason: 'rate' })
    expect(requestRefusal('rate_ip')).toEqual({ ok: false, reason: 'rate' })
    expect(requestRefusal('cap')).toEqual({ ok: false, reason: 'busy' })
    expect(requestRefusal('disabled')).toEqual({ ok: false, reason: 'unavailable' })
    expect(requestRefusal('weird')).toEqual({ ok: false, reason: 'unavailable' })
  })
  it('member_otp_verify', () => {
    expect(verifyReply('ok', 'T')).toEqual({ ok: true, token: 'T' })
    expect(verifyReply('wrong', 'T')).toEqual({ ok: false, reason: 'wrong' })
    expect(verifyReply('expired', 'T')).toEqual({ ok: false, reason: 'expired' })
    expect(verifyReply('locked', 'T')).toEqual({ ok: false, reason: 'locked' })
    expect(verifyReply('null', 'T')).toEqual({ ok: false, reason: 'unavailable' })
  })
})

describe('parseBody', () => {
  it('request and verify', () => {
    expect(parseBody({ action: 'request', phone: '0123456789' })).toEqual({ action: 'request', phone: '0123456789' })
    expect(parseBody({ action: 'verify', phone: 'p', code: '123456' })).toEqual({ action: 'verify', phone: 'p', code: '123456', device: null })
    expect(parseBody({ action: 'verify', phone: 'p', code: '1', device: 'UA' })).toMatchObject({ device: 'UA' })
  })
  it('anything else', () => {
    expect(parseBody(null)).toBeNull()
    expect(parseBody({ action: 'request' })).toBeNull()
    expect(parseBody({ action: 'request', phone: 'x'.repeat(41) })).toBeNull()
    expect(parseBody({ action: 'verify', phone: 'p' })).toBeNull()
    expect(parseBody({ action: 'delete', phone: 'p' })).toBeNull()
  })
})

describe('deviceLabel', () => {
  const ua = {
    iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1',
    androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
    samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36',
    windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0',
    macFirefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:127.0) Gecko/20100101 Firefox/127.0',
  }
  it('short labels', () => {
    expect(deviceLabel(ua.iphoneSafari)).toBe('iPhone Safari')
    expect(deviceLabel(ua.iphoneChrome)).toBe('iPhone Chrome')
    expect(deviceLabel(ua.androidChrome)).toBe('Android phone Chrome')
    expect(deviceLabel(ua.samsung)).toBe('Android phone Samsung Internet')
    expect(deviceLabel(ua.windowsEdge)).toBe('Windows Edge')
    expect(deviceLabel(ua.macFirefox)).toBe('Mac Firefox')
  })
  it('never the raw string; null when unknown', () => {
    expect(deviceLabel('curl/8.7.1')).toBeNull()
    expect(deviceLabel('')).toBeNull()
    expect(deviceLabel(null)).toBeNull()
    for (const s of Object.values(ua)) expect(deviceLabel(s)!.length).toBeLessThanOrEqual(60)
  })
})

describe('memberClientIp', () => {
  const h = (vars: Record<string, string>) => new Headers(vars)
  it('the platform-set headers: cf-connecting-ip, else sb-forwarded-for', () => {
    expect(memberClientIp(h({ 'cf-connecting-ip': ' 203.0.113.7 ', 'sb-forwarded-for': '198.51.100.1' }))).toBe('203.0.113.7')
    expect(memberClientIp(h({ 'sb-forwarded-for': '198.51.100.1' }))).toBe('198.51.100.1')
  })
  it('never a client-written X-Forwarded-For; null when no platform header', () => {
    expect(memberClientIp(h({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }))).toBeNull()
    expect(memberClientIp(h({ 'true-client-ip': '6.6.6.6', 'x-real-ip': '6.6.6.6' }))).toBeNull()
    expect(memberClientIp(h({ 'cf-connecting-ip': '  ' }))).toBeNull()
  })
  it('at most 64 characters', () => {
    expect(memberClientIp(h({ 'cf-connecting-ip': 'a'.repeat(100) }))).toHaveLength(64)
  })
})
