// fail() speaks plain words for a request with no reply and keeps the server's own refusals.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ reply: { data: null as unknown, error: null as { message: string } | null } }))
vi.mock('../../../shared/lib/supabase', () => ({ supabase: { rpc: () => Promise.resolve(h.reply) } }))

import { setItemsServed } from './checkoutApi'
import { NO_REPLY } from './rpcResult'

describe('checkoutApi failures', () => {
  beforeEach(() => { h.reply = { data: null, error: null } })

  it('a dropped connection becomes the no-reply sentence', async () => {
    h.reply = { data: null, error: { message: 'TypeError: Failed to fetch' } }
    await expect(setItemsServed(['a'], true)).rejects.toThrow(NO_REPLY)
  })
  it('a server refusal passes through unchanged', async () => {
    h.reply = { data: null, error: { message: 'This bill is no longer open.' } }
    await expect(setItemsServed(['a'], true)).rejects.toThrow('This bill is no longer open.')
  })
})
