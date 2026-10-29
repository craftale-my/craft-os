import { describe, expect, it, vi } from 'vitest'

vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }))
const { makePosFetch, makeReachability } = await import('./posSupabase')

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

  it('announces not_printing_tablet as its own signal', async () => {
    const announce = vi.fn()
    await makePosFetch(reply(400, '{"code":"P0001","message":"not_printing_tablet"}'), announce)('u')
    expect(announce).toHaveBeenCalledWith('not_printing_tablet')
  })
})

describe('reachability', () => {
  it('no reply (a network failure, an abort or a timeout) marks the server unreachable, and rethrows', async () => {
    for (const err of [new TypeError('Failed to fetch'), new DOMException('aborted', 'AbortError'), new DOMException('timed out', 'TimeoutError')]) {
      const mark = vi.fn()
      await expect(makePosFetch(async () => { throw err }, vi.fn(), mark)('u')).rejects.toBe(err)
      expect(mark).toHaveBeenCalledWith(false)
    }
  })

  it('any reply, even an error, marks it reachable', async () => {
    const mark = vi.fn()
    await makePosFetch(reply(503, '<html>Unavailable</html>'), vi.fn(), mark)('u')
    await makePosFetch(reply(401, '{"message":"JWT expired"}'), vi.fn(), mark)('u')
    await makePosFetch(reply(200, '[]'), vi.fn(), mark)('u')
    expect(mark.mock.calls).toEqual([[true], [true], [true]])
  })

  it('the store tells its subscribers when the flag changes, once per change', () => {
    const r = makeReachability()
    const heard = vi.fn()
    const stop = r.subscribe(heard)
    expect(r.get()).toBe(true)
    r.set(false); r.set(false)
    expect(r.get()).toBe(false)
    r.set(true)
    expect(heard).toHaveBeenCalledTimes(2)
    stop(); r.set(false)
    expect(heard).toHaveBeenCalledTimes(2)
  })
})
