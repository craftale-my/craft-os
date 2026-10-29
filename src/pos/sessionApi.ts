/** The POS app's calls: the device's sign-in and staff sessions (migration-2026-10-29-pos-devices.sql),
 *  pos_whoami (migration-2026-10-30-pos-app.sql), unpair (…-pos-device-till.sql), and the
 *  activation Edge Function, which the tablet calls with no login yet. */
import { POS_STORAGE_KEY, supabase } from './posSupabase'
import type { Pending, Platform, PollReply } from './activation'
import type { RosterReply } from './roster'

export interface WhoAmI {
  deviceId: string
  deviceName: string
  prints: boolean
  outletId: string
  outletName: string
  staffId: string
  staffName: string
  canSupervise: boolean
  canUnpair: boolean
}

export type PinReply =
  | { ok: true; sessionId: string; staff: { id: string; name: string } }
  | { ok: false; code: 'outlet_closed' | 'not_allowed' | 'no_pin' | 'pin_locked' | 'wrong_pin'; error: string }

const fail = (e: { message: string }): never => { throw new Error(e.message) }

export async function fetchRoster(): Promise<RosterReply> {
  const { data, error } = await supabase.rpc('pos_login_roster')
  if (error) fail(error)
  return data as RosterReply
}

export async function startSession(staffId: string, pin: string): Promise<PinReply> {
  const { data, error } = await supabase.rpc('pos_start_session', { p_staff_id: staffId, p_pin: pin })
  if (error) fail(error)
  return data as PinReply
}

export async function endSession(reason: 'locked' | 'idle' | 'access_changed'): Promise<void> {
  const { error } = await supabase.rpc('pos_end_session', { p_reason: reason })
  if (error) fail(error)
}

export async function fetchWhoAmI(): Promise<WhoAmI> {
  const { data, error } = await supabase.rpc('pos_whoami')
  if (error) fail(error)
  return data as WhoAmI
}

export async function unpairThisDevice(): Promise<void> {
  const { error } = await supabase.rpc('pos_unpair_this_device')
  if (error) fail(error)
}

/** A device session is stored on this tablet. Read from storage, not getSession(): offline,
 *  an expired token cannot refresh and getSession() would answer "none" (spec §3: a tablet
 *  that reloads with no network still opens the POS). */
export function hasDeviceSession(): boolean {
  return localStorage.getItem(POS_STORAGE_KEY) !== null
}

export async function signInDevice(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) fail(error)
}

/** Drops this tablet's session only (the device account is already revoked or unpaired). */
export async function forgetDevice(): Promise<void> {
  await supabase.auth.signOut({ scope: 'local' })
}

// ── Activation: the Edge Function pos-device-activation, deployed with --no-verify-jwt ──
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string
const ACTIVATION_URL = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/pos-device-activation`

async function activation(body: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(ACTIVATION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${ANON}` },
    body: JSON.stringify(body),
  })
  let json: Record<string, unknown> | null = null
  try { json = (await res.json()) as Record<string, unknown> } catch { /* not JSON */ }
  return { status: res.status, json }
}

export async function requestActivation(name: string | null, platform: Platform): Promise<Pending> {
  const { status, json } = await activation({ action: 'request', name, platform })
  if (status !== 200 || typeof json?.code !== 'string' || typeof json.secret !== 'string') {
    throw new Error(typeof json?.error === 'string' ? json.error : 'Could not start the activation. Try again.')
  }
  return { code: json.code, secret: json.secret, expiresAt: String(json.expiresAt), name }
}

export async function pollActivation(p: Pending): Promise<PollReply> {
  const { status, json } = await activation({ action: 'poll', code: p.code, secret: p.secret })
  if (status !== 200 || typeof json?.status !== 'string') {
    throw new Error(typeof json?.error === 'string' ? json.error : 'Could not check the activation.')
  }
  return json as unknown as PollReply
}
