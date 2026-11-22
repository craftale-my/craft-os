// The Edge Function pos-device-activation, called from Node by the pair command. The POS app's
// twin (src/pos/sessionApi.ts) reads Vite's import.meta.env, so it cannot run here; the requests
// and replies are the same, with platform 'agent'.
import type { Pending, PollReply } from '../../src/pos/activation.ts'

export interface ActivationClient {
  request: (name: string | null) => Promise<Pending>
  poll: (p: Pending) => Promise<PollReply>
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
      return json as unknown as PollReply
    },
  }
}
