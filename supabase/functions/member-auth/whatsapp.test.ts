import { describe, expect, it, vi } from 'vitest'
import { SendFailure } from './logic'
import { META_BUSY_CODES, WHATSAPP_DEFAULT_LANG, WHATSAPP_DEFAULT_VERSION, WHATSAPP_TIMEOUT_MS, whatsappBody, whatsappProvider } from './whatsapp'

const ENV = { WHATSAPP_TOKEN: 'tok-abc', WHATSAPP_PHONE_NUMBER_ID: '106540352242922', WHATSAPP_TEMPLATE: 'craft_signin_code' }
const envOf = (vars: Record<string, string>) => (n: string) => vars[n]
const okReply = () => new Response(JSON.stringify({
  messaging_product: 'whatsapp', contacts: [{ input: '60123456789', wa_id: '60123456789' }], messages: [{ id: 'wamid.HBgL' }],
}), { status: 200, headers: { 'content-type': 'application/json' } })

function provider(vars: Record<string, string>, reply: (init?: RequestInit) => Response | Promise<Response> = okReply, timeoutMs?: number) {
  const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => reply(init))
  return { p: whatsappProvider(envOf(vars), { fetch: fetchFn as unknown as typeof fetch, timeoutMs }), fetchFn }
}
async function failure(promise: Promise<unknown>): Promise<SendFailure> {
  try { await promise } catch (e) { expect(e).toBeInstanceOf(SendFailure); return e as SendFailure }
  throw new Error('expected a SendFailure')
}

describe('whatsappProvider — secrets', () => {
  it('token, phone number id and template are required', () => {
    expect(whatsappProvider(envOf(ENV))?.name).toBe('whatsapp')
    expect(whatsappProvider(envOf(ENV))?.kind).toBe('real')
    for (const k of Object.keys(ENV)) {
      expect(whatsappProvider(envOf({ ...ENV, [k]: '' }))).toBeNull()
      expect(whatsappProvider(envOf({ ...ENV, [k]: '  ' }))).toBeNull()
    }
    expect(whatsappProvider(envOf({}))).toBeNull()
  })
  it('values that would bend the URL or are not Meta shapes → null', () => {
    expect(whatsappProvider(envOf({ ...ENV, WHATSAPP_PHONE_NUMBER_ID: '123/../me' }))).toBeNull()
    expect(whatsappProvider(envOf({ ...ENV, WHATSAPP_GRAPH_VERSION: 'latest' }))).toBeNull()
    expect(whatsappProvider(envOf({ ...ENV, WHATSAPP_TEMPLATE: 'Sign In' }))).toBeNull()
    expect(whatsappProvider(envOf({ ...ENV, WHATSAPP_TEMPLATE_LANG: 'english' }))).toBeNull()
    expect(whatsappProvider(envOf({ ...ENV, WHATSAPP_TEMPLATE_LANG: 'ms', WHATSAPP_GRAPH_VERSION: 'v23.0' }))).not.toBeNull()
  })
})

describe('whatsappProvider — the request', () => {
  it('exact URL (default version), headers and JSON body; the code twice; `to` without +', async () => {
    const { p, fetchFn } = provider(ENV)
    await p!.sendCode('+60123456789', '042917')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe(`https://graph.facebook.com/${WHATSAPP_DEFAULT_VERSION}/106540352242922/messages`)
    expect(WHATSAPP_DEFAULT_VERSION).toBe('v27.0')
    expect(init!.method).toBe('POST')
    expect(init!.headers).toEqual({ 'Authorization': 'Bearer tok-abc', 'Content-Type': 'application/json' })
    expect(init!.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(String(init!.body))).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '60123456789',
      type: 'template',
      template: {
        name: 'craft_signin_code',
        language: { code: 'en_US' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: '042917' }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '042917' }] },
        ],
      },
    })
    expect(WHATSAPP_DEFAULT_LANG).toBe('en_US')
  })
  it('the version and language secrets are used when set', async () => {
    const { p, fetchFn } = provider({ ...ENV, WHATSAPP_GRAPH_VERSION: 'v24.0', WHATSAPP_TEMPLATE_LANG: 'ms' })
    await p!.sendCode('+601112345678', '111111')
    expect(fetchFn.mock.calls[0][0]).toBe('https://graph.facebook.com/v24.0/106540352242922/messages')
    const body = JSON.parse(String(fetchFn.mock.calls[0][1]!.body))
    expect(body.template.language).toEqual({ code: 'ms' })
    expect(body.to).toBe('601112345678')
  })
  it('whatsappBody is what is sent', () => {
    expect(whatsappBody('+60123456789', '1', 't', 'en_US').to).toBe('60123456789')
  })
})

describe('whatsappProvider — failures', () => {
  const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status })
  it('HTTP 429 → busy', async () => {
    const { p } = provider(ENV, () => new Response('', { status: 429 }))
    const f = await failure(p!.sendCode('+60123456789', '123456'))
    expect([f.reason, f.detail]).toEqual(['busy', 'http 429'])
  })
  it.each([...META_BUSY_CODES])('Meta rate-limit code %i → busy', async (code) => {
    const { p } = provider(ENV, json(400, { error: { message: 'x', type: 'OAuthException', code, fbtrace_id: 'Az9' } }))
    const f = await failure(p!.sendCode('+60123456789', '123456'))
    expect([f.reason, f.detail]).toEqual(['busy', `http 400 code ${code} fbtrace_id Az9`])
  })
  it('the busy list is the five codes of the brief', () => {
    expect([...META_BUSY_CODES].sort((a, b) => a - b)).toEqual([4, 80007, 130429, 131048, 131056])
  })
  it('another Meta error → unavailable, with code, subcode and trace id only', async () => {
    const { p } = provider(ENV, json(400, { error: { message: 'Template name does not exist for 60123456789', code: 132001, error_subcode: 2494073, fbtrace_id: 'A_b-1' } }))
    const f = await failure(p!.sendCode('+60123456789', '123456'))
    expect([f.reason, f.detail]).toEqual(['unavailable', 'http 400 code 132001 subcode 2494073 fbtrace_id A_b-1'])
    expect(f.message).not.toMatch(/60123456789|123456|tok-abc|Template/)
  })
  it('a trace id with odd characters is cleaned', async () => {
    const { p } = provider(ENV, json(400, { error: { code: 100, fbtrace_id: 'A b\n<script>' } }))
    expect((await failure(p!.sendCode('+60123456789', '123456'))).detail).toBe('http 400 code 100 fbtrace_id Abscript')
  })
  it('non-2xx without JSON → unavailable', async () => {
    const { p } = provider(ENV, () => new Response('<html>bad gateway</html>', { status: 502 }))
    expect(await failure(p!.sendCode('+60123456789', '123456'))).toMatchObject({ reason: 'unavailable', detail: 'http 502' })
  })
  it('2xx with an error body → unavailable', async () => {
    const { p } = provider(ENV, json(200, { error: { code: 100 } }))
    expect(await failure(p!.sendCode('+60123456789', '123456'))).toMatchObject({ reason: 'unavailable', detail: 'http 200 code 100' })
  })
  it.each([
    ['no messages', {}],
    ['empty messages', { messages: [] }],
    ['an id that is not a string', { messages: [{ id: 5 }] }],
    ['an empty id', { messages: [{ id: '' }] }],
  ])('2xx with %s → unavailable', async (_n, body) => {
    const { p } = provider(ENV, json(200, body))
    expect(await failure(p!.sendCode('+60123456789', '123456'))).toMatchObject({ reason: 'unavailable', detail: 'http 200 no message id' })
  })
  it('2xx not JSON → unavailable', async () => {
    const { p } = provider(ENV, () => new Response('ok', { status: 200 }))
    expect(await failure(p!.sendCode('+60123456789', '123456'))).toMatchObject({ reason: 'unavailable' })
  })
  it('a network error → unavailable, "network" (the error text is not kept)', async () => {
    const { p } = provider(ENV, () => Promise.reject(new TypeError('connect to 60123456789 failed')))
    const f = await failure(p!.sendCode('+60123456789', '123456'))
    expect([f.reason, f.detail]).toEqual(['unavailable', 'network'])
  })
  it('no answer within the timeout → aborted, unavailable, "timeout"', async () => {
    const { p, fetchFn } = provider(ENV, (init) => new Promise<Response>((_r, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })))
    }), 30)
    const f = await failure(p!.sendCode('+60123456789', '123456'))
    expect([f.reason, f.detail]).toEqual(['unavailable', 'timeout'])
    expect(fetchFn.mock.calls[0][1]!.signal!.aborted).toBe(true)
  })
  it('the default timeout is 8 s', async () => {
    vi.useFakeTimers()
    try {
      const { p } = provider(ENV, (init) => new Promise<Response>((_r, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      }))
      const settled = vi.fn()
      const run = p!.sendCode('+60123456789', '123456').catch((e) => { settled(e); })
      await vi.advanceTimersByTimeAsync(WHATSAPP_TIMEOUT_MS - 1)
      expect(settled).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await run
      expect(settled.mock.calls[0][0]).toMatchObject({ reason: 'unavailable', detail: 'timeout' })
      expect(WHATSAPP_TIMEOUT_MS).toBe(8000)
    } finally { vi.useRealTimers() }
  })
})
