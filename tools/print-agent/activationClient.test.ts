import { describe, expect, it, vi } from 'vitest'
import { activationClient } from './activationClient.ts'

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('activationClient — the Edge Function from Node, platform agent', () => {
  it('requests with the anon key and platform agent', async () => {
    const fetchFn = vi.fn(async () => reply(200, { code: 'ABC-123', secret: 's', expiresAt: '2026-11-23T10:00:00Z' }))
    const client = activationClient('https://dev.supabase.co/', 'anon-key', fetchFn as unknown as typeof fetch)
    expect(await client.request('Office Mac')).toEqual({ code: 'ABC-123', secret: 's', expiresAt: '2026-11-23T10:00:00Z', name: 'Office Mac' })
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://dev.supabase.co/functions/v1/pos-device-activation')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', apikey: 'anon-key', Authorization: 'Bearer anon-key' })
    expect(JSON.parse(init.body as string)).toEqual({ action: 'request', name: 'Office Mac', platform: 'agent' })
  })
  it('throws the function words when a request is refused', async () => {
    const client = activationClient('https://dev.supabase.co', 'k', (async () => reply(429, { error: 'Too many activation requests from this network. Try again in an hour.' })) as unknown as typeof fetch)
    await expect(client.request(null)).rejects.toThrow('Too many activation requests from this network. Try again in an hour.')
    const bare = activationClient('https://dev.supabase.co', 'k', (async () => new Response('oops', { status: 502 })) as unknown as typeof fetch)
    await expect(bare.request(null)).rejects.toThrow('Could not start the activation. Try again.')
  })
  it('polls with the code and secret', async () => {
    const fetchFn = vi.fn(async () => reply(200, { status: 'pending' }))
    const client = activationClient('https://dev.supabase.co', 'k', fetchFn as unknown as typeof fetch)
    expect(await client.poll({ code: 'ABC-123', secret: 's', expiresAt: 'x', name: null })).toEqual({ status: 'pending' })
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ action: 'poll', code: 'ABC-123', secret: 's' })
  })
  it('throws when a poll fails', async () => {
    const client = activationClient('https://dev.supabase.co', 'k', (async () => reply(500, { error: 'Could not check the activation. Try again.' })) as unknown as typeof fetch)
    await expect(client.poll({ code: 'A', secret: 's', expiresAt: 'x', name: null })).rejects.toThrow('Could not check the activation. Try again.')
  })
})
