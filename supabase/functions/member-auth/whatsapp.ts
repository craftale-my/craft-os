// The `whatsapp` code provider: Meta's WhatsApp Cloud API, sent directly (no reseller), as an
// authentication template with a copy-code button. The template itself (Meta's fixed wording: "<code> is
// your verification code. For your security, do not share this code." + "This code expires in 5 minutes.")
// is created once by the owner (docs/pos/2026-11-23-members-whatsapp-setup.md), not by this function.
//
// Send: POST https://graph.facebook.com/<version>/<phone number id>/messages (Meta's "Copy code
// authentication templates" page, checked 2026-11-23; its examples use v27.0). The code appears twice: in
// the body parameter and in the copy-code button's url parameter.
//
// A 200 only means Meta accepted the message; whether the number has WhatsApp is not known here, so the
// sheet tells the guest what to do when nothing arrives.
//
// Pure apart from `fetch`, which is injectable (whatsapp.test.ts, handler.test.ts).

import { type CodeProvider, SendFailure } from './logic.ts'

type Env = (name: string) => string | undefined

export const WHATSAPP_DEFAULT_VERSION = 'v27.0'
export const WHATSAPP_DEFAULT_LANG = 'en_US'
export const WHATSAPP_TIMEOUT_MS = 8000

/** Meta's rate-limit / throttling error codes (Cloud API error-codes page, checked 2026-11-23): app call
 *  limit, WABA limit, throughput, number restricted for spam, too many to the same recipient. */
export const META_BUSY_CODES = new Set([4, 80007, 130429, 131048, 131056])

export interface WhatsAppOptions {
  fetch?: typeof fetch
  timeoutMs?: number
}

/** The adapter, or null (→ `unavailable`) when a secret is missing or not in its expected shape. */
export function whatsappProvider(env: Env, opts: WhatsAppOptions = {}): CodeProvider | null {
  const token = env('WHATSAPP_TOKEN')?.trim()
  const phoneId = env('WHATSAPP_PHONE_NUMBER_ID')?.trim()
  const template = env('WHATSAPP_TEMPLATE')?.trim()
  const lang = env('WHATSAPP_TEMPLATE_LANG')?.trim() || WHATSAPP_DEFAULT_LANG
  const version = env('WHATSAPP_GRAPH_VERSION')?.trim() || WHATSAPP_DEFAULT_VERSION
  if (!token || !phoneId || !template) return null
  // the id and the version go into the URL: digits only, and `v<major>.<minor>`
  if (!/^[0-9]{1,30}$/.test(phoneId) || !/^v[0-9]{1,3}\.[0-9]{1,3}$/.test(version)) return null
  // Meta template names are lowercase letters, digits and underscores; a language is like en_US or ms
  if (!/^[a-z0-9_]{1,512}$/.test(template) || !/^[a-z]{2,3}(_[A-Z]{2,4})?$/.test(lang)) return null
  const doFetch = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs ?? WHATSAPP_TIMEOUT_MS
  const url = `https://graph.facebook.com/${version}/${phoneId}/messages`

  return {
    kind: 'real',
    name: 'whatsapp',
    async sendCode(toE164, code) {
      const body = whatsappBody(toE164, code, template, lang)
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      let res: Response
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        })
      } catch (e) {
        throw new SendFailure('unavailable', ctrl.signal.aborted || isAbort(e) ? 'timeout' : 'network')
      } finally {
        clearTimeout(timer)
      }
      let reply: unknown = null
      try { reply = await res.json() } catch { /* not JSON: judged by the status below */ }
      const err = metaError(reply)
      if (res.status === 429 || (err && err.code !== null && META_BUSY_CODES.has(err.code))) {
        throw new SendFailure('busy', detail(res.status, err))
      }
      if (!res.ok || err) throw new SendFailure('unavailable', detail(res.status, err))
      const id = (reply as { messages?: Array<{ id?: unknown }> } | null)?.messages?.[0]?.id
      if (typeof id !== 'string' || id === '') throw new SendFailure('unavailable', `http ${res.status} no message id`)
    },
  }
}

/** The send body. `to` is the number in digits without the plus. */
export function whatsappBody(toE164: string, code: string, template: string, lang: string) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toE164.replace(/^\+/, ''),
    type: 'template',
    template: {
      name: template,
      language: { code: lang },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: code }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
      ],
    },
  }
}

interface MetaError { code: number | null; subcode: number | null; trace: string | null }

/** Meta's `{ error: { code, error_subcode, fbtrace_id, … } }`, only the fields that are safe to log. */
function metaError(reply: unknown): MetaError | null {
  const e = (reply as { error?: unknown } | null)?.error
  if (!e || typeof e !== 'object') return null
  const o = e as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : null)
  const trace = typeof o.fbtrace_id === 'string' ? o.fbtrace_id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || null : null
  return { code: num(o.code), subcode: num(o.error_subcode), trace }
}

/** What is logged of a failed send: the HTTP status and Meta's code, subcode and trace id. Never Meta's
 *  message text, which can echo the number. */
function detail(status: number, err: MetaError | null): string {
  const parts = [`http ${status}`]
  if (err?.code !== null && err?.code !== undefined) parts.push(`code ${err.code}`)
  if (err?.subcode !== null && err?.subcode !== undefined) parts.push(`subcode ${err.subcode}`)
  if (err?.trace) parts.push(`fbtrace_id ${err.trace}`)
  return parts.join(' ')
}

function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError'
}
