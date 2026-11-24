/** What the POS app keeps on the tablet besides its Supabase session: the last context it saw
 *  (so a reload with no network still opens the till for whoever was signed in, spec §3), a
 *  Lock that could not reach the server yet, and product names for the unpaired screen. */
import type { QueueStore, QueuedOrder } from '../features/pos/offline/orderQueue'
import type { RosterReply } from './roster'
import type { WhoAmI } from './sessionApi'

export interface Cached { roster: RosterReply; who: WhoAmI | null }

const CONTEXT = 'craft-pos-context'
const LOCK = 'craft-pos-lock-pending'
const NAMES = 'craft-pos-product-names'

function read<T>(store: Storage, key: string): T | null {
  try { return JSON.parse(store.getItem(key) ?? 'null') as T | null } catch { return null }
}

export const saveContext = (store: Storage, c: Cached): void => store.setItem(CONTEXT, JSON.stringify(c))
export const loadContext = (store: Storage): Cached | null => read<Cached>(store, CONTEXT)

export type LockReason = 'locked' | 'idle' | 'access_changed'
/** A Lock pressed offline: the server session is ended on the next roster read. */
export const setPendingLock = (store: Storage, r: LockReason): void => store.setItem(LOCK, r)
export const clearPendingLock = (store: Storage): void => store.removeItem(LOCK)
export const pendingLock = (store: Storage): LockReason | null => {
  const r = store.getItem(LOCK)
  return r === 'locked' || r === 'idle' || r === 'access_changed' ? r : null
}

export const saveProductNames = (store: Storage, rows: { id: string; name: string }[]): void =>
  store.setItem(NAMES, JSON.stringify(rows.map((r) => [r.id, r.name])))
export const loadProductNames = (store: Storage): Map<string, string> =>
  new Map(read<[string, string][]>(store, NAMES) ?? [])

/** Everything about this device's pairing goes when it is unpaired. */
export function forgetContext(store: Storage): void {
  store.removeItem(CONTEXT)
  store.removeItem(LOCK)
}

export const UNPAIRED_REASON = 'Not sent — this device was unpaired'

/** The device was unpaired: the orders still waiting are held back (never resent by
 *  themselves), so staff enter them again and a later activation cannot double them.
 *  They stay in the queue's list with Edit and Discard. Returns every held order, oldest first. */
export async function holdQueued(store: QueueStore): Promise<QueuedOrder[]> {
  for (const o of await store.all()) if (!o.failedReason) await store.put({ ...o, failedReason: UNPAIRED_REASON })
  return (await store.all()).sort((a, b) => a.queuedAt - b.queuedAt)
}
