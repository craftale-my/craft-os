/** Activation (spec §2 "Activation flow"): the tablet asks the Edge Function
 *  pos-device-activation for a code, shows it, and polls every 5 s until HQ approves or
 *  rejects it in Craft OS → Devices. The approved reply carries the device's sign-in once. */

export type Platform = 'ipad' | 'android' | 'other'

/** iPadOS 13+ says "Macintosh" but has a touch screen. */
export function detectPlatform(userAgent: string, maxTouchPoints: number): Platform {
  if (/iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)) return 'ipad'
  if (/Android/.test(userAgent)) return 'android'
  return 'other'
}

export interface Pending { code: string; secret: string; expiresAt: string; name: string | null }

export type PollReply =
  | { status: 'pending' | 'rejected' | 'expired' | 'unknown' }
  | { status: 'approved'; deviceId: string; email: string; password: string; branchId: string; kind: string; name: string }

export type EndReason = 'rejected' | 'expired' | 'unknown' | 'wrong_kind' | 'unpaired'

export type ActivationState =
  | { kind: 'choose' }                                    // the first screen: what this device is for
  | { kind: 'requesting' }
  | { kind: 'waiting'; pending: Pending; note: string | null }
  | { kind: 'signing_in'; email: string; password: string }
  | { kind: 'ended'; reason: EndReason }
  | { kind: 'error'; message: string }

export const POLL_MS = 5_000

/** The next state after a poll reply. Only 'waiting' keeps polling. */
export function afterPoll(pending: Pending, reply: PollReply): ActivationState {
  switch (reply.status) {
    case 'pending': return { kind: 'waiting', pending, note: null }
    case 'approved':
      return reply.kind === 'pos'
        ? { kind: 'signing_in', email: reply.email, password: reply.password }
        : { kind: 'ended', reason: 'wrong_kind' }
    default: return { kind: 'ended', reason: reply.status }
  }
}

export const isPolling = (s: ActivationState): boolean => s.kind === 'waiting'

export const ENDED: Record<EndReason, string> = {
  rejected: 'This request was rejected.',
  expired: 'This request expired.',
  // a spent or lost request — also what a poll sees when the approved reply never arrived
  unknown: 'This request is no longer valid. If HQ already approved it, ask HQ to unpair this device in Devices and approve a new request.',
  wrong_kind: 'HQ approved this device as a print agent. Ask HQ to unpair it in Devices and approve it again as POS.',
  unpaired: 'This device was unpaired. Ask HQ to activate it again.',
}

// ── The waiting request survives a reload (the secret never leaves this device) ──
const KEY = 'craft-pos-activation'

export function savePending(store: Storage, p: Pending): void { store.setItem(KEY, JSON.stringify(p)) }
export function clearPending(store: Storage): void { store.removeItem(KEY) }
export function loadPending(store: Storage): Pending | null {
  try {
    const p = JSON.parse(store.getItem(KEY) ?? 'null') as Pending | null
    return p && typeof p.code === 'string' && typeof p.secret === 'string' ? p : null
  } catch { return null }
}
