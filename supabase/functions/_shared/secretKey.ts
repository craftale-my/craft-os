// A server key that bypasses RLS, for Edge Functions.
//
// Prefers SUPABASE_SECRET_KEYS (the platform injects it; the new sb_secret_ keys rotate on
// their own and outlive the legacy JWT keys). Its documented shape is a "JSON dictionary"
// with no promised key names, so an object, an array or a bare string are all accepted,
// recognised by the sb_secret_ prefix. SUPABASE_SERVICE_ROLE_KEY is the deprecated fallback.
// provision-staff carries its own copy of this function (deployed before this file existed).
export function resolveSecretKey(): string | null {
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (raw) {
    const looksRight = (v: unknown): v is string => typeof v === 'string' && v.startsWith('sb_secret_')
    if (looksRight(raw)) return raw
    try {
      const parsed = JSON.parse(raw)
      if (looksRight(parsed)) return parsed
      const candidates = Array.isArray(parsed) ? parsed : Object.values(parsed ?? {})
      for (const c of candidates) {
        if (looksRight(c)) return c
        if (c && typeof c === 'object') {
          for (const v of Object.values(c)) if (looksRight(v)) return v
        }
      }
    } catch {
      // not JSON: fall back below
    }
  }
  return Deno.env.get('SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? null
}
