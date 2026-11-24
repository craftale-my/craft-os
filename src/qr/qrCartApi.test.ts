// src/qr/qrCartApi.test.ts
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeCartApi, makeCartSignal } from './qrCartApi'

const guest = { id: 'me', name: 'Eric', avatar: 'a1' }

function rpcClient(reply: { data?: unknown; error?: { message: string } }) {
  const rpc = vi.fn(async () => ({ data: reply.data ?? null, error: reply.error ?? null }))
  return { rpc, client: { rpc } as unknown as SupabaseClient }
}

describe('makeCartApi', () => {
  it('put sends only the order line fields, a null line id for a new line, and the token', async () => {
    const { rpc, client } = rpcClient({ data: 'line-9' })
    const line = { productId: 'latte', variantId: 'hot', qty: 2, note: 'x', optionIds: ['o1'], name: 'Latte', price: 9, extra: true }
    const id = await makeCartApi(client, 'tok').put(guest, line as never, null)
    expect(id).toBe('line-9')
    expect(rpc).toHaveBeenCalledWith('qr_cart_put', {
      p_token: 'tok',
      p_guest: guest,
      p_line: { productId: 'latte', variantId: 'hot', qty: 2, note: 'x', optionIds: ['o1'] },
      p_line_id: null,
    })
  })

  it('an RPC error becomes a thrown Error with its message', async () => {
    const { client } = rpcClient({ error: { message: 'table closed' } })
    await expect(makeCartApi(client, 'tok').remove('me', 'l1')).rejects.toThrow('table closed')
  })

  it('state throws on a malformed reply', async () => {
    const { client } = rpcClient({ data: { nonsense: true } })
    await expect(makeCartApi(client, 'tok').state()).rejects.toThrow('Unexpected reply from the server')
  })

  it('send returns sent or changed and throws for anything else', async () => {
    const reply = async (data: unknown) => makeCartApi(rpcClient({ data }).client, 'tok').send(2, 'v1', [], 'o1')
    await expect(reply({ status: 'sent' })).resolves.toBe('sent')
    await expect(reply({ status: 'changed' })).resolves.toBe('changed')
    await expect(reply({ status: 'weird' })).rejects.toThrow('Unexpected reply from the server')
    await expect(reply('sent')).rejects.toThrow('Unexpected reply from the server')
    await expect(reply(null)).rejects.toThrow('Unexpected reply from the server')
  })
})

function channelClient() {
  let fire: () => void = () => {}
  const channel = {
    on: vi.fn((_type: string, _filter: unknown, cb: () => void) => { fire = cb; return channel }),
    subscribe: vi.fn(),
    send: vi.fn(async () => 'ok'),
  }
  const channelFn = vi.fn(() => channel)
  return { channel, channelFn, client: { channel: channelFn } as unknown as SupabaseClient, broadcast: () => fire() }
}

describe('makeCartSignal', () => {
  it('opens the channel once however often it is subscribed again', () => {
    const { channel, channelFn, client } = channelClient()
    const signal = makeCartSignal(client, 'topic')
    const off = signal.subscribe(() => {})
    off()
    signal.subscribe(() => {})
    expect(channelFn).toHaveBeenCalledTimes(1)
    expect(channel.subscribe).toHaveBeenCalledTimes(1)
  })

  it('a broadcast reaches only the latest handler, and nothing after unsubscribe', () => {
    const { client, broadcast } = channelClient()
    const signal = makeCartSignal(client, 'topic')
    const first = vi.fn()
    const second = vi.fn()
    signal.subscribe(first)()
    const off = signal.subscribe(second)
    broadcast()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    off()
    broadcast()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('a stale unsubscribe does not drop the newer handler', () => {
    const { client, broadcast } = channelClient()
    const signal = makeCartSignal(client, 'topic')
    const offOld = signal.subscribe(vi.fn())
    const latest = vi.fn()
    signal.subscribe(latest)
    offOld()
    broadcast()
    expect(latest).toHaveBeenCalledTimes(1)
  })

  it('ping before any subscribe does nothing; after subscribe it sends a data-less broadcast', () => {
    const { channel, client } = channelClient()
    const signal = makeCartSignal(client, 'topic')
    expect(() => signal.ping()).not.toThrow()
    expect(channel.send).not.toHaveBeenCalled()
    signal.subscribe(() => {})
    signal.ping()
    expect(channel.send).toHaveBeenCalledWith({ type: 'broadcast', event: 'changed', payload: {} })
  })
})
