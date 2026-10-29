import { createClient } from '@supabase/supabase-js'
import { contextCode, type ContextCode } from '../features/pos/deviceErrors'

/** The POS app's Supabase client (spec §3). vite.pos.config.ts gives it to every module that
 *  imports src/shared/lib/supabase.ts, so the till's code runs on it unchanged. The device's
 *  session lives under its own storage key, apart from any Craft OS login. */

export const POS_STORAGE_KEY = 'craft-pos-auth'
/** Fired on window with the code as `detail` when any call meets a pos_ctx() coded error. */
export const CONTEXT_EVENT = 'craft-pos:context'

/** fetch that announces a coded error in a failed reply (PostgREST: `{ code, message }`). */
export function makePosFetch(base: typeof fetch, announce: (code: ContextCode) => void): typeof fetch {
  return async (input, init) => {
    const res = await base(input, init)
    if (!res.ok) {
      try {
        const code = contextCode(((await res.clone().json()) as { message?: unknown } | null)?.message)
        if (code) announce(code)
      } catch { /* not JSON */ }
    }
    return res
  }
}

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string,
  {
    auth: { storageKey: POS_STORAGE_KEY, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    global: {
      fetch: makePosFetch((input, init) => fetch(input, init),
        (code) => window.dispatchEvent(new CustomEvent<ContextCode>(CONTEXT_EVENT, { detail: code }))),
    },
  },
)
