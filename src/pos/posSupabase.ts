import { createClient } from '@supabase/supabase-js'
import { contextCode, type ContextCode } from '../features/pos/deviceErrors'

/** The POS app's Supabase client (spec §3). vite.pos.config.ts gives it to every module that
 *  imports src/shared/lib/supabase.ts, so the till's code runs on it unchanged. The device's
 *  session lives under its own storage key, apart from any Craft OS login. */

export const POS_STORAGE_KEY = 'craft-pos-auth'
/** Fired on window with the code as `detail` when any call meets a pos_ctx() coded error, or
 *  `not_printing_tablet` (a print call from a tablet HQ no longer has print). */
export const CONTEXT_EVENT = 'craft-pos:context'
export const NOT_PRINTING = 'not_printing_tablet'
export type PosSignal = ContextCode | typeof NOT_PRINTING

/** Whether the server answered the last call: a store to subscribe to (useSyncExternalStore). */
export interface Reachability {
  get: () => boolean
  set: (reachable: boolean) => void
  subscribe: (listener: () => void) => () => void
}

export function makeReachability(): Reachability {
  let reachable = true
  const listeners = new Set<() => void>()
  return {
    get: () => reachable,
    set: (v) => { if (v !== reachable) { reachable = v; for (const l of listeners) l() } },
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l) } },
  }
}

/** The server is reachable: fed by every call through the POS client. "Offline" in the app is
 *  `navigator.onLine && reachability.get()`, since a Wi-Fi with no internet still says online. */
export const reachability = makeReachability()

// fetch's own network failure (TypeError), or an abort or a timeout: no reply came
const unreachable = (e: unknown) =>
  e instanceof TypeError || (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError'))

/** fetch that announces a coded error in a failed reply (PostgREST: `{ code, message }`), and
 *  marks the server reachable on any reply (even an error) or unreachable when none came. */
export function makePosFetch(base: typeof fetch, announce: (code: PosSignal) => void,
  mark: (reachable: boolean) => void = () => undefined): typeof fetch {
  return async (input, init) => {
    let res: Response
    try { res = await base(input, init) } catch (e) {
      if (unreachable(e)) mark(false)
      throw e
    }
    mark(true)
    if (!res.ok) {
      try {
        const message = ((await res.clone().json()) as { message?: unknown } | null)?.message
        const code = message === NOT_PRINTING ? NOT_PRINTING : contextCode(message)
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
        (code) => window.dispatchEvent(new CustomEvent<PosSignal>(CONTEXT_EVENT, { detail: code })),
        reachability.set),
    },
  },
)
