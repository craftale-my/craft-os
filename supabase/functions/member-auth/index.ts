// Edge Function: member-auth
//
// A QR-page guest signs in as a member with an SMS code (spec
// docs/superpowers/specs/2026-11-22-members-phone-points-design.md §5). Guests have no login, so this
// runs without a JWT check and reaches the database only through the service-role functions of
// supabase/migration-2026-11-23-members.sql, which carry the limits and the storage.
//
//   Every call: an allowed Origin (secret MEMBER_AUTH_ORIGINS) else 403; POST else 405 (OPTIONS answers the
//   preflight); Content-Type application/json else 415; a body of at most 2 KB else 413.
//   request — { action: 'request', phone, table }   (table = the QR table token)
//             → 200 { ok: true } | { ok: false, reason: 'rate' | 'busy' | 'unavailable' | 'invalid_phone' }
//   verify  — { action: 'verify', phone, code, device? }
//             → 200 { ok: true, token }
//             | { ok: false, reason: 'wrong' | 'expired' | 'locked' | 'invalid_phone' | 'unavailable' }
//   A body that is neither → 400 { error }.
//
// Secrets: MEMBER_AUTH_ORIGINS (the QR sites, comma-separated). SMS_PROVIDER ('log' on dev; a real provider
// later, Task 20). 'log' sends nothing and stores the plain code in member_otps.dev_code, and runs only
// with MEMBER_AUTH_ALLOW_LOG=1 (never set on prod).
// Never logged: the code, the token, a full phone number.
//
// The handler is handler.ts (tested with a fake rpc in handler.test.ts); this file wires the real client.
//
// Deploy (no JWT check; SUPABASE_URL and the secret keys are injected by the platform):
//   supabase functions deploy member-auth --no-verify-jwt

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { resolveSecretKey } from '../_shared/secretKey.ts'
import { handle } from './handler.ts'

Deno.serve(async (req) => {
  const serviceKey = resolveSecretKey()
  const url = Deno.env.get('SUPABASE_URL')
  if (!serviceKey || !url) {
    return new Response(JSON.stringify({ error: 'Function is not configured: no secret key available' }), {
      status: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
  }
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  return await handle(req, {
    rpc: async (fn, args) => {
      const { data, error } = await admin.rpc(fn, args)
      return { data, error: error ? { message: error.message } : null }
    },
    env: (n) => Deno.env.get(n),
  })
})
