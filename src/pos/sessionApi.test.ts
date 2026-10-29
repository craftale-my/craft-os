import { afterEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ signInWithPassword: vi.fn() }))
vi.mock('./posSupabase', () => ({ POS_STORAGE_KEY: 'craft-pos-auth', supabase: { auth } }))
const { requestActivation, signInDevice } = await import('./sessionApi')

const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

afterEach(() => { vi.unstubAllGlobals() })

describe('requestActivation', () => {
  it('too_many (429): the error is the function\'s English text, not a code', async () => {
    // supabase/functions/pos-device-activation/logic.ts requestReply
    vi.stubGlobal('fetch', reply(429, { error: 'Too many activation requests from this network. Try again in an hour.' }))
    await expect(requestActivation(null, 'ipad')).rejects.toThrow('Too many activation requests from this network. Try again in an hour.')
  })
  it('a reply with no text falls back to a plain message', async () => {
    vi.stubGlobal('fetch', reply(500, null))
    await expect(requestActivation(null, 'ipad')).rejects.toThrow('Could not start the activation. Try again.')
  })
})

describe('signInDevice', () => {
  it('keeps the error name, so a network failure can be retried', async () => {
    auth.signInWithPassword.mockResolvedValue({ error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch' } })
    await expect(signInDevice('e', 'p')).rejects.toMatchObject({ name: 'AuthRetryableFetchError', message: 'Failed to fetch' })
  })
})
