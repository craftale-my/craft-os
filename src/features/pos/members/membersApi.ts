// src/features/pos/members/membersApi.ts
/** Back office → Members (members spec §3 "Owner (back office)"): the RPCs of migration-2026-11-23-members.sql.
 *  Reads need access_settings; adjust, delete, settings and earn problems need an active owner (the server checks). */
import { supabase } from '../../../shared/lib/supabase'

export const PAGE_SIZE = 50

export interface MemberRow { id: string; phone: string; points: number; joinedAt: string; lastVisitAt: string | null }
export interface MemberPage { total: number; rows: MemberRow[] }
export type LedgerKind = 'earn' | 'refund' | 'adjust'
export interface LedgerEntry {
  id: string; at: string; kind: LedgerKind; points: number
  billId: string | null; billNo: string | null; branchName: string | null; reason: string | null; staffName: string | null
}
export interface MemberLedger {
  member: MemberRow & { deletedAt: string | null }
  entries: LedgerEntry[]
}
export interface MemberSettings { rate: number; qrEnabled: boolean; smsDailyCap: number; smsSentToday: number }
export interface EarnFailure { id: string; billId: string; billNo: string | null; branchName: string | null; error: string; at: string }

async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data as T
}

export async function searchMembers(query: string, page: number): Promise<MemberPage> {
  const d = await call<MemberPage | null>('member_search', { p_query: query, p_limit: PAGE_SIZE, p_offset: page * PAGE_SIZE })
  return { total: Number(d?.total ?? 0), rows: d?.rows ?? [] }
}

/** Null when the member is not found. */
export const fetchLedger = (memberId: string) => call<MemberLedger | null>('member_ledger', { p_member_id: memberId })

/** The new balance. */
export async function adjustPoints(memberId: string, points: number, reason: string): Promise<number> {
  const d = await call<{ points: number }>('member_adjust', { p_member_id: memberId, p_points: points, p_reason: reason })
  return Number(d.points)
}

export const deleteMember = (memberId: string) => call<void>('member_delete', { p_member_id: memberId })

export const fetchMemberSettings = () => call<MemberSettings>('member_settings_get')

export const saveMemberSettings = (s: { rate: number; qrEnabled: boolean; smsDailyCap: number }) =>
  call<MemberSettings>('member_settings_set', { p_rate: s.rate, p_qr_enabled: s.qrEnabled, p_sms_daily_cap: s.smsDailyCap })

export async function fetchEarnFailures(): Promise<EarnFailure[]> {
  return (await call<EarnFailure[] | null>('member_earn_failures_list')) ?? []
}
