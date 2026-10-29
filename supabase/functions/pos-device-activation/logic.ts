// The pure parts of pos-device-activation (no Deno APIs), tested with Vitest in logic.test.ts.

export type Platform = 'ipad' | 'android' | 'other' | 'agent'
export const PLATFORMS: Platform[] = ['ipad', 'android', 'other', 'agent']

export type ActivationBody =
  | { action: 'request'; name: string | null; platform: Platform }
  | { action: 'poll'; code: string; secret: string }

/** The request body, or null when it is neither action. */
export function parseBody(body: unknown): ActivationBody | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (b.action === 'request') {
    if (typeof b.platform !== 'string' || !PLATFORMS.includes(b.platform as Platform)) return null
    const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 40).trim() : null
    return { action: 'request', name, platform: b.platform as Platform }
  }
  if (b.action === 'poll') {
    if (typeof b.code !== 'string' || typeof b.secret !== 'string') return null
    if (b.code.length > 16 || b.secret.length > 128) return null
    return { action: 'poll', code: b.code, secret: b.secret }
  }
  return null
}

/** The caller's IP as the platform forwards it: the first x-forwarded-for entry. */
export function clientIp(forwardedFor: string | null): string | null {
  const first = forwardedFor?.split(',')[0]?.trim()
  return first ? first.slice(0, 64) : null
}

/** A synthetic email and a random password for a device account; never shown to anyone. */
export function deviceCredentials(): { email: string; password: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  const password = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return { email: `device-${crypto.randomUUID()}@devices.invalid`, password }
}

/** The HTTP status and body for pos_activation_request's reply. */
export function requestReply(r: Record<string, unknown>): { status: number; body: Record<string, unknown> } {
  switch (r.error) {
    case undefined:
      return { status: 200, body: { code: r.code, secret: r.secret, expiresAt: r.expiresAt } }
    case 'too_many':
      return { status: 429, body: { error: 'Too many activation requests from this network. Try again in an hour.' } }
    case 'busy':
      return { status: 503, body: { error: 'Too many devices are waiting for approval. Ask HQ.' } }
    default:
      return { status: 400, body: { error: 'Invalid request' } }
  }
}
