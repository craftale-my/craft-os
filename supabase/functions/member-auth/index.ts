// Edge Function: member-auth
//
// A QR-page guest signs in as a member with an SMS code (spec
// docs/superpowers/specs/2026-11-22-members-phone-points-design.md §5). Guests have no login, so this
// runs without a JWT check and reaches the database only through the service-role functions of
// supabase/migration-2026-11-23-members.sql, which carry the limits and the storage.
//
//   request — { action: 'request', phone }
//             → 200 { ok: true } | { ok: false, reason: 'rate' | 'busy' | 'unavailable' | 'invalid_phone' }
//   verify  — { action: 'verify', phone, code, device? }
//             → 200 { ok: true, token }
//             | { ok: false, reason: 'wrong' | 'expired' | 'locked' | 'invalid_phone' | 'unavailable' }
//   A body that is neither → 400 { error }; another method → 405 { error }.
//
// Secrets: SMS_PROVIDER ('log' on dev; a real provider later, Task 20). 'log' sends nothing and stores the
// plain code in member_otps.dev_code, and runs only with MEMBER_AUTH_ALLOW_LOG=1 (never set on prod).
// Never logged: the code, the token, a full phone number.
//
// Deploy (no JWT check; SUPABASE_URL and the secret keys are injected by the platform):
//   supabase functions deploy member-auth --no-verify-jwt

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { resolveSecretKey } from '../_shared/secretKey.ts'
import {
  type RequestReply, type VerifyReply,
  cleanCode, clientIp, codeHash, deviceLabel, makeCode, makeToken, maskForLog, normalisePhone,
  parseBody, requestRefusal, selectProvider, sha256Hex, smsText, verifyReply,
} from './logic.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// no-store: the verify reply carries the member token
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  try {
    return await handle(req)
  } catch (e) {
    console.error('member-auth', e instanceof Error ? e.message : String(e))
    return json({ error: 'Something went wrong. Try again.' }, 500)
  }
})

async function handle(req: Request): Promise<Response> {
  const serviceKey = resolveSecretKey()
  const url = Deno.env.get('SUPABASE_URL')
  if (!serviceKey || !url) return json({ error: 'Function is not configured: no secret key available' }, 500)
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

  let body: unknown
  try { body = await req.json() } catch { return json({ error: 'Invalid request' }, 400) }
  const input = parseBody(body)
  if (!input) return json({ error: 'Invalid request' }, 400)

  const phone = normalisePhone(input.phone)
  if (!phone) return json({ ok: false, reason: 'invalid_phone' })

  if (input.action === 'request') {
    const reply: RequestReply = await requestCode(admin, phone, req)
    return json(reply)
  }

  const code = cleanCode(input.code)
  // a string that cannot be a code can never match: answered without spending one of the 5 tries
  if (!code) return json({ ok: false, reason: 'wrong' } satisfies VerifyReply)
  const token = makeToken()
  const { data, error } = await admin.rpc('member_otp_verify', {
    p_phone: phone,
    p_code_hash: await codeHash(phone, code),
    p_token_hash: await sha256Hex(token),
    p_device: deviceLabel(input.device ?? req.headers.get('user-agent')),
  })
  if (error) {
    console.error('member_otp_verify', maskForLog(phone), error.message)
    return json({ ok: false, reason: 'unavailable' } satisfies VerifyReply)
  }
  const reply = verifyReply(String(data), token)
  if (!reply.ok) console.log('verify', maskForLog(phone), reply.reason)
  return json(reply)
}

// deno-lint-ignore no-explicit-any
async function requestCode(admin: any, phone: string, req: Request): Promise<RequestReply> {
  const provider = selectProvider((n) => Deno.env.get(n))
  if (!provider) {
    console.error('member-auth: no SMS provider (SMS_PROVIDER unset or unknown, or log mode not allowed)')
    return { ok: false, reason: 'unavailable' }
  }
  const code = makeCode()
  const hash = await codeHash(phone, code)
  const { data, error } = await admin.rpc('member_otp_request', {
    p_phone: phone,
    p_ip: clientIp(req.headers.get('cf-connecting-ip'), req.headers.get('x-forwarded-for')),
    p_code_hash: hash,
    p_dev_code: provider.kind === 'log' ? code : null,
  })
  if (error) {
    console.error('member_otp_request', maskForLog(phone), error.message)
    return { ok: false, reason: 'unavailable' }
  }
  if (data !== 'ok') {
    console.log('request', maskForLog(phone), data)
    return requestRefusal(String(data))
  }
  try {
    await provider.sendSms(phone, smsText(code))
  } catch (e) {
    // a vendor's message may echo the number or the text: digit runs are cut out
    console.error('sendSms', provider.name, maskForLog(phone), (e instanceof Error ? e.message : String(e)).replace(/\d{4,}/g, '…'))
    // the SMS never left: the stored code must not be confirmable
    const { error: voidErr } = await admin.rpc('member_otp_void', { p_phone: phone, p_code_hash: hash })
    if (voidErr) console.error('member_otp_void', maskForLog(phone), voidErr.message)
    return { ok: false, reason: 'unavailable' }
  }
  return { ok: true }
}
