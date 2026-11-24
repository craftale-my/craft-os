// src/qr/member/memberApi.ts
/** The member calls of the QR page (spec 2026-11-22-members-phone-points-design.md §5): the Edge Function
 *  `member-auth` for the sign-in code, and the anon RPCs `member_me`, `member_sign_out`, `member_link_table`,
 *  `member_public_settings` (supabase/migration-2026-11-23-members.sql). */
import type { SupabaseClient } from '@supabase/supabase-js'
import { qrClient } from '../qrClient'

/** Why a request or a verify did not go through. `network` = no reply at all. */
export type RequestReason = 'invalid_phone' | 'rate' | 'busy' | 'unavailable' | 'network'
export type VerifyReason = 'wrong' | 'expired' | 'locked' | 'invalid_phone' | 'unavailable' | 'network'
export type RequestReply = { ok: true } | { ok: false; reason: RequestReason }
export type VerifyReply = { ok: true; token: string } | { ok: false; reason: VerifyReason }

export interface MemberEntry { at: string; branchName: string | null; points: number; kind: string }
export interface MemberMe { phoneMasked: string; points: number; rate: number; entries: MemberEntry[] }
export interface LinkReply { linked: boolean; phoneMasked: string | null }
export interface MemberSettings { qrEnabled: boolean; rate: number }

export interface MemberApi {
  /** `tableToken`: the QR table the guest is at (a code is asked from a live table) */
  requestCode(phone: string, tableToken: string): Promise<RequestReply>
  verifyCode(phone: string, code: string): Promise<VerifyReply>
  /** null: the token names no live member (unknown, expired, deleted) */
  memberMe(token: string): Promise<MemberMe | null>
  memberSignOut(token: string): Promise<void>
  /** null: a dead member token. Links only a guest who has an ordered item on the open bill. */
  memberLinkTable(tableToken: string, memberToken: string, guestId: string): Promise<LinkReply | null>
  memberPublicSettings(): Promise<MemberSettings>
}

const UNEXPECTED = 'Unexpected reply from the server'
const REQUEST_REASONS: readonly string[] = ['invalid_phone', 'rate', 'busy', 'unavailable']
const VERIFY_REASONS: readonly string[] = ['wrong', 'expired', 'locked', 'invalid_phone', 'unavailable']
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

/** `url` is the member-auth endpoint, `anonKey` the gateway's key; `fetcher` is injectable for tests. */
export function makeMemberApi(client: SupabaseClient, url: string, anonKey: string, fetcher: typeof fetch = (...a) => fetch(...a)): MemberApi {
  /** the function's JSON reply, 'network' when nothing came back, null for a reply that is not JSON */
  const post = async (body: unknown): Promise<Record<string, unknown> | 'network' | null> => {
    let res: Response
    try {
      res = await fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: anonKey, Authorization: `Bearer ${anonKey}` },
        body: JSON.stringify(body),
      })
    } catch { return 'network' }
    try { const j: unknown = await res.json(); return isObj(j) ? j : null } catch { return null }
  }
  const rpc = async (fn: string, args: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = await client.rpc(fn, args)
    if (error) throw new Error(error.message)
    return data
  }
  return {
    async requestCode(phone, tableToken) {
      const j = await post({ action: 'request', phone, table: tableToken })
      if (j === 'network') return { ok: false, reason: 'network' }
      if (j?.ok === true) return { ok: true }
      const r = j?.reason
      return { ok: false, reason: typeof r === 'string' && REQUEST_REASONS.includes(r) ? r as RequestReason : 'unavailable' }
    },
    async verifyCode(phone, code) {
      const j = await post({ action: 'verify', phone, code, device: typeof navigator === 'undefined' ? undefined : navigator.userAgent })
      if (j === 'network') return { ok: false, reason: 'network' }
      if (j?.ok === true && typeof j.token === 'string' && j.token !== '') return { ok: true, token: j.token }
      const r = j?.reason
      return { ok: false, reason: typeof r === 'string' && VERIFY_REASONS.includes(r) ? r as VerifyReason : 'unavailable' }
    },
    async memberMe(token) {
      const d = await rpc('member_me', { p_token: token })
      if (d === null) return null
      if (!isObj(d) || typeof d.phoneMasked !== 'string' || typeof d.points !== 'number') throw new Error(UNEXPECTED)
      const entries = Array.isArray(d.entries) ? d.entries.filter(isObj).map((e) => ({
        at: String(e.at), branchName: typeof e.branchName === 'string' ? e.branchName : null,
        points: Number(e.points) || 0, kind: String(e.kind),
      })) : []
      return { phoneMasked: d.phoneMasked, points: d.points, rate: Number(d.rate) || 0, entries }
    },
    async memberSignOut(token) { await rpc('member_sign_out', { p_token: token }) },
    async memberLinkTable(tableToken, memberToken, guestId) {
      const d = await rpc('member_link_table', { p_table_token: tableToken, p_guest_id: guestId, p_member_token: memberToken })
      if (d === null) return null
      if (!isObj(d) || typeof d.linked !== 'boolean') throw new Error(UNEXPECTED)
      return { linked: d.linked, phoneMasked: typeof d.phoneMasked === 'string' ? d.phoneMasked : null }
    },
    async memberPublicSettings() {
      const d = await rpc('member_public_settings', {})
      if (!isObj(d) || typeof d.qrEnabled !== 'boolean') throw new Error(UNEXPECTED)
      return { qrEnabled: d.qrEnabled, rate: Number(d.rate) || 0 }
    },
  }
}

/** The page's instance: the endpoint comes from the same project settings as the Supabase client. */
export const memberApi: MemberApi = makeMemberApi(
  qrClient,
  `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/member-auth`,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string,
)
