// The Edge Function pos-device-activation, called from Node by the pair command. The POS app's
// twin (src/pos/sessionApi.ts) reads Vite's import.meta.env, so it cannot run here; the requests
// and replies are the same, with platform 'agent'.
import type { Pending, PollReply } from '../../src/pos/activation.ts'

export interface ActivationClient {
  request: (name: string | null) => Promise<Pending>
  poll: (p: Pending) => Promise<PollReply>
}

const STATUSES = ['pending', 'rejected', 'expired', 'unknown', 'approved']
const filled = (v: unknown): boolean => typeof v === 'string' && v !== ''

/** A known status; an approved reply carries the device's sign-in and kind. */
function isPollReply(json: Record<string, unknown>): boolean {
  if (!STATUSES.includes(json.status as string)) return false
  if (json.status !== 'approved') return true
  return filled(json.deviceId) && filled(json.email) && filled(json.password) && filled(json.kind)
}

export function activationClient(supabaseUrl: string, anonKey: string, fetchFn: typeof fetch = fetch): ActivationClient {
  const endpoint = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/pos-device-activation`
  const call = async (body: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> => {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      body: JSON.stringify(body),
    })
    let json: Record<string, unknown> | null = null
    try { json = (await res.json()) as Record<string, unknown> } catch { /* not JSON */ }
    return { status: res.status, json }
  }
  return {
    request: async (name) => {
      const { status, json } = await call({ action: 'request', name, platform: 'agent' })
      if (status !== 200 || !json || typeof json.code !== 'string' || typeof json.secret !== 'string') {
        throw new Error(typeof json?.error === 'string' ? json.error : 'Could not start the activation. Try again.')
      }
      return { code: json.code, secret: json.secret, expiresAt: String(json.expiresAt), name }
    },
    poll: async (p) => {
      const { status, json } = await call({ action: 'poll', code: p.code, secret: p.secret })
      if (status !== 200 || !json || typeof json.status !== 'string') {
        throw new Error(typeof json?.error === 'string' ? json.error : 'Could not check the activation.')
      }
      if (!isPollReply(json)) throw new Error('Unexpected reply from the activation service.')
      return json as unknown as PollReply
    },
  }
}
