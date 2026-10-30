// Edge Function: claim-ai
//
// The only place Claim Desk talks to Claude. The API key stays here as a function
// secret; the browser sends its own JWT plus the images / PDF to read.
//
// Tasks (POST { task, ... }):
//   taobao    — { images, accounts }  Chinese Taobao order screenshots → orders + items in English
//   receipt   — { images | pdf, accounts, taxes, docTypes }  one paper invoice / receipt → supplier, date, total…
//   suggest   — { suppliers, accounts }  supplier names → likely account (needs manage_accounts)
//
// Secrets (Dashboard → Edge Functions → Secrets): ANTHROPIC_API_KEY.
// Optional: CLAIM_AI_MODEL (default claude-sonnet-5-5).
//
// Deploy: supabase functions deploy claim-ai --project-ref <ref> --use-api

import Anthropic from 'npm:@anthropic-ai/sdk@0'
import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const MAX_IMAGES = 12
const MAX_BYTES = 18_000_000 // base64 characters across all inputs
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

type ImageIn = { media_type: string; data: string }

function prompt(task: string, b: Record<string, unknown>): string {
  const accounts = JSON.stringify(b.accounts ?? [])
  if (task === 'taobao') {
    return `You help a Malaysian company's accountant. The images are screenshots of one or more Taobao (China) order pages in Chinese, paid personally by a staff member who will claim reimbursement. A long screenshot may be split into several consecutive images. Extract every order and every item and translate into clear business English for Malaysian tax (LHDN) and audit records. Reply with only JSON:
{"orders":[{"orderNo":"string","orderDate":"YYYY-MM-DD","sellerZh":"shop name as shown","sellerEn":"English translation of the shop name","items":[{"descZh":"original item title, shortened","descEn":"concise English description including spec / colour / size","qty":number,"unitPriceCny":number,"amountCny":number}],"shippingCny":number,"discountCny":number,"totalPaidCny":number}],"paymentMethod":"e.g. Alipay, in English, or empty","suggestedAccount":one of ${accounts},"notes":"anything unclear, in English, or empty"}
Numbers only, no currency symbols. Use null when a value is not visible. Never invent an order number. Do not list the same order twice when it appears in overlapping images.`
  }
  if (task === 'receipt') {
    return `You help a Malaysian company's accountant digitise a paper source document (all pages belong to ONE document). Reply with only JSON:
{"docKind":one of ${JSON.stringify(b.docTypes ?? [])},"supplier":"","supplierRegNo":"","supplierTin":"","docNo":"","docDate":"YYYY-MM-DD","currency":"MYR","total":number,"sst":number,"description":"one-line English summary of what was bought","paid":true|false|null,"einvoiceUuid":"","suggestedAccount":one of ${accounts},"suggestedTax":one of ${JSON.stringify(b.taxes ?? [])},"notes":"what is unclear or missing, in English"}
Translate anything not in English or Malay into English. Use null for values that are not visible. Do not guess document numbers.`
  }
  // suggest
  const names = (b.suppliers as string[]).slice(0, 100)
  return `You help a Malaysian SME's accountant classify purchases. For each supplier name below, pick the most likely account from this exact list: ${accounts}. Also guess the platform from: ["Shopee","Lazada","Walk-in / Direct","Other"]. Reply with only a JSON array of {"supplier": string (exactly as given), "account": string, "platform": string}.

Suppliers:
${names.join('\n')}`
}

/** The model is told to reply with JSON only; tolerate a code fence or a sentence around it. */
export function parseJsonReply(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  try {
    return JSON.parse(t)
  } catch {
    const start = t.search(/[[{]/)
    const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'))
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1))
    throw new Error('invalid_json')
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const authHeader = req.headers.get('Authorization') ?? ''
  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: userData } = await userClient.auth.getUser()
  if (!userData?.user) return json({ error: 'not_signed_in' }, 401)
  const { data: me } = await userClient.from('staff').select('id, is_active').eq('id', userData.user.id).maybeSingle()
  if (!me?.is_active) return json({ error: 'not_active_staff' }, 403)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'bad_request' }, 400)
  }
  const task = String(body.task ?? '')
  if (!['taobao', 'receipt', 'suggest'].includes(task)) return json({ error: 'unknown_task' }, 400)

  if (task === 'suggest') {
    const { data: ok } = await userClient.rpc('has_accounts_cap')
    if (!ok) return json({ error: 'forbidden' }, 403)
    if (!Array.isArray(body.suppliers) || body.suppliers.length === 0) return json({ error: 'no_suppliers' }, 400)
  }

  const images = (Array.isArray(body.images) ? body.images : []) as ImageIn[]
  const pdf = typeof body.pdf === 'string' ? body.pdf : null
  if (task !== 'suggest') {
    if (!images.length && !pdf) return json({ error: 'no_input' }, 400)
    if (images.length > MAX_IMAGES) return json({ error: 'too_many_images', max: MAX_IMAGES }, 400)
    if (images.some((i) => !IMAGE_TYPES.includes(i?.media_type) || typeof i?.data !== 'string')) {
      return json({ error: 'bad_image' }, 400)
    }
    const size = images.reduce((t, i) => t + i.data.length, 0) + (pdf?.length ?? 0)
    if (size > MAX_BYTES) return json({ error: 'too_large' }, 413)
  }

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return json({ error: 'ai_not_configured' }, 503)
  const client = new Anthropic({ apiKey })

  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    ...(pdf ? [{ type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: pdf } }] : []),
    ...images.map((i) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: i.media_type as 'image/jpeg', data: i.data },
    })),
    { type: 'text' as const, text: prompt(task, body) },
  ]

  try {
    const res = await client.beta.messages.create({
      model: Deno.env.get('CLAIM_AI_MODEL') || 'claude-sonnet-5-5',
      max_tokens: 16000,
      output_config: { effort: 'medium' },
      // Re-run on another model if a safety classifier declines an ordinary receipt.
      betas: ['server-side-fallback-2026-07-01'],
      // @ts-ignore — newer request field than some SDK typings
      fallbacks: 'default',
      messages: [{ role: 'user', content }],
    })
    if (res.stop_reason === 'refusal') return json({ error: 'refused' }, 422)
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
    return json({ result: parseJsonReply(text) })
  } catch (e) {
    if (e instanceof Error && e.message === 'invalid_json') return json({ error: 'invalid_json' }, 502)
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'rate_limited' }, 429)
    if (e instanceof Anthropic.AuthenticationError) return json({ error: 'ai_not_configured' }, 503)
    if (e instanceof Anthropic.BadRequestError) return json({ error: 'ai_bad_request', detail: e.message }, 400)
    if (e instanceof Anthropic.APIError) return json({ error: 'ai_error', detail: e.message }, 502)
    return json({ error: 'ai_error', detail: String(e) }, 502)
  }
})
