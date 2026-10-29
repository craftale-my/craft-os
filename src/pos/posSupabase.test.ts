import { describe, expect, it, vi } from 'vitest'

vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }))
const { makePosFetch } = await import('./posSupabase')

const reply = (status: number, body: string) => async () => new Response(body, { status, headers: { 'Content-Type': 'application/json' } })

describe('makePosFetch', () => {
  it('announces a coded error and still hands the reply back unread', async () => {
    const announce = vi.fn()
    const res = await makePosFetch(reply(400, '{"code":"P0001","message":"no_session"}'), announce)('https://x/rest/v1/rpc/open_table')
    expect(announce).toHaveBeenCalledWith('no_session')
    expect(await res.json()).toEqual({ code: 'P0001', message: 'no_session' })
  })

  it('stays quiet for other errors, non-JSON replies and successes', async () => {
    const announce = vi.fn()
    await makePosFetch(reply(400, '{"code":"P0001","message":"Item is not available"}'), announce)('u')
    await makePosFetch(reply(502, '<html>Bad gateway</html>'), announce)('u')
    await makePosFetch(reply(200, '{"message":"no_session"}'), announce)('u')
    expect(announce).not.toHaveBeenCalled()
  })
})
