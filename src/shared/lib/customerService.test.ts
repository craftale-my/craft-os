// src/shared/lib/customerService.test.ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('./supabase', () => ({ supabase: {} }))

const { requestCsTicket, ssoUrl } = await import('./customerService')

const res = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('requestCsTicket', () => {
  it('posts the Supabase token and returns the ticket', async () => {
    const f = vi.fn(async () => res(200, { ticket: 'abc', expiresIn: 60 }))
    await expect(requestCsTicket('https://api.test/', 'tok', f as unknown as typeof fetch))
      .resolves.toEqual({ ok: true, ticket: 'abc' })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.test/api/v1/auth/sso/ticket')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
  })
  it.each([
    [401, 'signed_out'],
    [403, 'no_access'],
    [503, 'unavailable'],
    [500, 'unavailable'],
  ])('maps HTTP %i to %s', async (status, reason) => {
    const f = vi.fn(async () => res(status))
    await expect(requestCsTicket('https://api.test', 'tok', f as unknown as typeof fetch))
      .resolves.toEqual({ ok: false, reason })
  })
  it('treats a network failure as unavailable', async () => {
    const f = vi.fn(async () => { throw new TypeError('fetch failed') })
    await expect(requestCsTicket('https://api.test', 'tok', f as unknown as typeof fetch))
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
  })
  it('treats a 200 with no ticket as unavailable', async () => {
    const f = vi.fn(async () => res(200, {}))
    await expect(requestCsTicket('https://api.test', 'tok', f as unknown as typeof fetch))
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
  })
})

describe('ssoUrl', () => {
  it('puts the ticket in the fragment, never the query string', () => {
    expect(ssoUrl('https://cm.test/', 'a+b')).toBe('https://cm.test/sso#t=a%2Bb')
  })
})
