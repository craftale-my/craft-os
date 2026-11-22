import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeMemberApi } from './memberApi'

const URL = 'https://x.supabase.co/functions/v1/member-auth'
const reply = (json: unknown) => vi.fn(async () => new Response(JSON.stringify(json), { status: 200 }))
function rpcClient(r: { data?: unknown; error?: { message: string } }) {
  const rpc = vi.fn(async () => ({ data: r.data ?? null, error: r.error ?? null }))
  return { rpc, client: { rpc } as unknown as SupabaseClient }
}
const noRpc = { rpc: vi.fn() } as unknown as SupabaseClient

describe('member-auth calls', () => {
  it('request posts the action and phone with the anon key, and maps ok', async () => {
    const f = reply({ ok: true })
    const api = makeMemberApi(noRpc, URL, 'anon', f as unknown as typeof fetch)
    expect(await api.requestCode('+60123456789')).toEqual({ ok: true })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(URL)
    expect(JSON.parse(String(init.body))).toEqual({ action: 'request', phone: '+60123456789' })
    expect((init.headers as Record<string, string>).apikey).toBe('anon')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer anon')
  })
  it.each(['invalid_phone', 'rate', 'busy', 'unavailable'])('request reason %s comes through', async (reason) => {
    const api = makeMemberApi(noRpc, URL, 'anon', reply({ ok: false, reason }) as unknown as typeof fetch)
    expect(await api.requestCode('x')).toEqual({ ok: false, reason })
  })
  it('no reply is network; a 500 or an unknown reason is unavailable', async () => {
    const down = vi.fn(async () => { throw new TypeError('Load failed') })
    expect(await makeMemberApi(noRpc, URL, 'a', down as unknown as typeof fetch).requestCode('x')).toEqual({ ok: false, reason: 'network' })
    expect(await makeMemberApi(noRpc, URL, 'a', down as unknown as typeof fetch).verifyCode('x', '1')).toEqual({ ok: false, reason: 'network' })
    const bad = vi.fn(async () => new Response('oops', { status: 500 }))
    expect(await makeMemberApi(noRpc, URL, 'a', bad as unknown as typeof fetch).requestCode('x')).toEqual({ ok: false, reason: 'unavailable' })
    expect(await makeMemberApi(noRpc, URL, 'a', reply({ ok: false, reason: 'weird' }) as unknown as typeof fetch).verifyCode('x', '1'))
      .toEqual({ ok: false, reason: 'unavailable' })
  })
  it('verify returns the token, or the reason', async () => {
    const f = reply({ ok: true, token: 'tok' })
    expect(await makeMemberApi(noRpc, URL, 'a', f as unknown as typeof fetch).verifyCode('+60123456789', '123456')).toEqual({ ok: true, token: 'tok' })
    const body = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body).toMatchObject({ action: 'verify', phone: '+60123456789', code: '123456' })
    for (const reason of ['wrong', 'expired', 'locked']) {
      expect(await makeMemberApi(noRpc, URL, 'a', reply({ ok: false, reason }) as unknown as typeof fetch).verifyCode('x', '1')).toEqual({ ok: false, reason })
    }
  })
})

describe('member RPCs', () => {
  it('member_me parses, and null stays null', async () => {
    const { rpc, client } = rpcClient({ data: { phoneMasked: '+60 ••• ••6789', points: 120, rate: '1.00', entries: [{ at: '2026-11-22T10:00:00Z', branchName: 'Craft Cafe Cheras', points: 42, kind: 'earn' }] } })
    const me = await makeMemberApi(client, URL, 'a').memberMe('tok')
    expect(rpc).toHaveBeenCalledWith('member_me', { p_token: 'tok' })
    expect(me).toEqual({ phoneMasked: '+60 ••• ••6789', points: 120, rate: 1, entries: [{ at: '2026-11-22T10:00:00Z', branchName: 'Craft Cafe Cheras', points: 42, kind: 'earn' }] })
    expect(await makeMemberApi(rpcClient({ data: null }).client, URL, 'a').memberMe('tok')).toBeNull()
  })
  it('member_link_table sends table token, guest id and member token', async () => {
    const { rpc, client } = rpcClient({ data: { linked: false, phoneMasked: '+60 ••• ••1234' } })
    expect(await makeMemberApi(client, URL, 'a').memberLinkTable('T', 'M', 'G')).toEqual({ linked: false, phoneMasked: '+60 ••• ••1234' })
    expect(rpc).toHaveBeenCalledWith('member_link_table', { p_table_token: 'T', p_guest_id: 'G', p_member_token: 'M' })
    expect(await makeMemberApi(rpcClient({ data: null }).client, URL, 'a').memberLinkTable('T', 'M', 'G')).toBeNull()
  })
  it('an RPC error throws; settings parse', async () => {
    await expect(makeMemberApi(rpcClient({ error: { message: 'gone' } }).client, URL, 'a').memberPublicSettings()).rejects.toThrow('gone')
    const { rpc, client } = rpcClient({ data: { qrEnabled: true, rate: 1 } })
    expect(await makeMemberApi(client, URL, 'a').memberPublicSettings()).toEqual({ qrEnabled: true, rate: 1 })
    await makeMemberApi(client, URL, 'a').memberSignOut('tok')
    expect(rpc).toHaveBeenLastCalledWith('member_sign_out', { p_token: 'tok' })
  })
})
