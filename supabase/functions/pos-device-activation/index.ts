// Edge Function: pos-device-activation
//
// A POS tablet or print agent asks to be activated, shows its code, and polls until HQ
// approves it in Craft OS (POS → Devices). The caller has no login yet, so this function
// runs without a JWT check and reaches the database only through the service-role
// functions of supabase/migration-2026-10-29-pos-devices.sql. Those carry the limits
// (5 requests per IP per hour, 50 waiting, 24 h expiry) and answer a wrong secret exactly
// like an unknown code.
//
//   request — { action: 'request', name?, platform } → 200 { code, secret, expiresAt }
//             (429 / 503 / 400 { error } when refused)
//   poll    — { action: 'poll', code, secret }
//             → { status: 'pending' | 'rejected' | 'expired' | 'unknown' }
//             → once: { status: 'approved', deviceId, email, password, branchId, kind, name }
//
// Deploy (no JWT check; SUPABASE_URL and the secret keys are injected by the platform):
//   supabase functions deploy pos-device-activation --no-verify-jwt

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { resolveSecretKey } from '../_shared/secretKey.ts'
import { clientIp, deviceCredentials, parseBody, requestReply } from './logic.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// no-store: the approved reply carries the device's password
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
    // an unexpected throw still answers with CORS headers, so the app sees the message
    console.error('pos-device-activation', e instanceof Error ? e.message : String(e))
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

  if (input.action === 'request') {
    const { data, error } = await admin.rpc('pos_activation_request', {
      p_name: input.name, p_platform: input.platform,
      p_ip: clientIp(req.headers.get('cf-connecting-ip'), req.headers.get('x-forwarded-for')),
    })
    if (error || !data) {
      console.error('pos_activation_request', error?.message ?? 'no reply')
      return json({ error: 'Could not start the activation. Try again.' }, 500)
    }
    const reply = requestReply(data as Record<string, unknown>)
    return json(reply.body, reply.status)
  }

  const { data, error } = await admin.rpc('pos_activation_poll', { p_code: input.code, p_secret: input.secret })
  if (error || !data) {
    console.error('pos_activation_poll', error?.message ?? 'no reply')
    return json({ error: 'Could not check the activation. Try again.' }, 500)
  }
  const poll = data as { status: string; requestId?: string; branchId?: string; kind?: string; name?: string }
  if (poll.status !== 'issue') return json({ status: poll.status })

  // This poll holds the claim: make the device account, then record the device.
  const { email, password } = deviceCredentials()
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, app_metadata: { pos_device: true },
  })
  if (createErr || !created.user) {
    console.error('createUser', createErr?.message)
    await admin.rpc('pos_activation_unclaim', { p_request_id: poll.requestId })
    return json({ status: 'pending' })
  }
  const { error: finishErr } = await admin.rpc('pos_activation_finish', { p_request_id: poll.requestId, p_user_id: created.user.id })
  if (finishErr) {
    console.error('pos_activation_finish', finishErr.message)
    const { error: deleteErr } = await admin.auth.admin.deleteUser(created.user.id)
    if (deleteErr) console.error('deleteUser (orphan device account left)', created.user.id, deleteErr.message)
    await admin.rpc('pos_activation_unclaim', { p_request_id: poll.requestId })
    return json({ status: 'pending' })
  }
  return json({
    status: 'approved', deviceId: created.user.id, email, password,
    branchId: poll.branchId, kind: poll.kind, name: poll.name,
  })
}
