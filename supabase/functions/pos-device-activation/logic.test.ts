import { describe, expect, it } from 'vitest'
import { clientIp, deviceCredentials, parseBody, requestReply } from './logic'

describe('parseBody', () => {
  it('a request: platform required, name trimmed to 40 or null', () => {
    expect(parseBody({ action: 'request', platform: 'ipad', name: '  Bar iPad  ' })).toEqual({ action: 'request', platform: 'ipad', name: 'Bar iPad' })
    expect(parseBody({ action: 'request', platform: 'android' })).toEqual({ action: 'request', platform: 'android', name: null })
    expect(parseBody({ action: 'request', platform: 'agent', name: '   ' })).toEqual({ action: 'request', platform: 'agent', name: null })
    expect(parseBody({ action: 'request', platform: 'ipad', name: 'x'.repeat(50) })).toMatchObject({ name: 'x'.repeat(40) })
    expect(parseBody({ action: 'request', platform: 'toaster' })).toBeNull()
    expect(parseBody({ action: 'request' })).toBeNull()
  })
  it('a poll: code and secret as strings of sane length', () => {
    expect(parseBody({ action: 'poll', code: 'ABC-DEF', secret: 'f00' })).toEqual({ action: 'poll', code: 'ABC-DEF', secret: 'f00' })
    expect(parseBody({ action: 'poll', code: 'ABC-DEF' })).toBeNull()
    expect(parseBody({ action: 'poll', code: 'x'.repeat(17), secret: 's' })).toBeNull()
    expect(parseBody({ action: 'poll', code: 'ABC-DEF', secret: 's'.repeat(129) })).toBeNull()
  })
  it('anything else', () => {
    expect(parseBody(null)).toBeNull()
    expect(parseBody('poll')).toBeNull()
    expect(parseBody({ action: 'approve' })).toBeNull()
  })
})

describe('clientIp', () => {
  it('the first forwarded address', () => {
    expect(clientIp('203.0.113.7, 10.0.0.1')).toBe('203.0.113.7')
    expect(clientIp(' 203.0.113.7 ')).toBe('203.0.113.7')
    expect(clientIp(null)).toBeNull()
    expect(clientIp('')).toBeNull()
  })
})

describe('deviceCredentials', () => {
  it('a synthetic address and a 48-hex-digit password, new each time', () => {
    const a = deviceCredentials()
    const b = deviceCredentials()
    expect(a.email).toMatch(/^device-[0-9a-f-]{36}@devices\.invalid$/)
    expect(a.password).toMatch(/^[0-9a-f]{48}$/)
    expect(b.email).not.toBe(a.email)
    expect(b.password).not.toBe(a.password)
  })
})

describe('requestReply', () => {
  it('maps the SQL reply to HTTP', () => {
    expect(requestReply({ code: 'ABC-DEF', secret: 's', expiresAt: 't' })).toEqual({ status: 200, body: { code: 'ABC-DEF', secret: 's', expiresAt: 't' } })
    expect(requestReply({ error: 'too_many' })).toEqual({ status: 429, body: { error: 'Too many activation requests from this network. Try again in an hour.' } })
    expect(requestReply({ error: 'busy' })).toEqual({ status: 503, body: { error: 'Too many devices are waiting for approval. Ask HQ.' } })
    expect(requestReply({ error: 'bad_request' })).toEqual({ status: 400, body: { error: 'Invalid request' } })
  })
})
