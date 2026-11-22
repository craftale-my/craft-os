// src/features/pos/order/billMember.ts
/** A member on a bill at the counter (spec 2026-11-22-members-phone-points-design.md §3 "Staff (POS)"):
 *  pos_bill_set_member / pos_bill_clear_member (migration-2026-11-23-members.sql) and pos_bill_member
 *  (migration-2026-11-23-members-pos.sql). All need the till's staff session at the bill's outlet. */
import { supabase } from '../../../shared/lib/supabase'
import { shortMask } from '../../../shared/lib/memberPhone'
import { readableError } from '../checkout/rpcResult'

export interface BillMember {
  memberId: string
  phone: string            // E.164, shown in full to staff
  points: number           // the member's balance
  isNew?: boolean          // only from Attach: the number was not a member yet
  earned?: number | null   // only from pos_bill_member: this bill's earn row
}

/** The client's own words for a number the phone rule refuses (the server's are shown as they are). */
export const INVALID_PHONE = 'Enter a Malaysian mobile number, like 012-345 6789.'

/** "Member ••6789" under the bill number. */
export const memberLine = (phone: string): string => `Member ${shortMask(phone)}`

/** "120 points", "1 point". */
export const pointsWord = (n: number): string => `${n} ${n === 1 ? 'point' : 'points'}`

/** The server's words, or plain words for a request that got no reply (never the browser's "Load failed"). */
function fail(error: { message: string } | null): never {
  throw new Error(readableError(error?.message ?? 'Unknown error'))
}

function parse(data: unknown): BillMember | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (typeof d.memberId !== 'string' || typeof d.phone !== 'string') return null
  return {
    memberId: d.memberId, phone: d.phone, points: Number(d.points ?? 0),
    ...(typeof d.isNew === 'boolean' ? { isNew: d.isNew } : {}),
    ...('earned' in d ? { earned: d.earned === null || d.earned === undefined ? null : Number(d.earned) } : {}),
  }
}

/** The bill's member, or null when it has none. */
export async function fetchBillMember(billId: string): Promise<BillMember | null> {
  const { data, error } = await supabase.rpc('pos_bill_member', { p_bill_id: billId })
  if (error) fail(error)
  return parse(data)
}

/** Attach (or change to) the member with this number; a number not yet a member is created (isNew). */
export async function setBillMember(billId: string, phone: string): Promise<BillMember> {
  const { data, error } = await supabase.rpc('pos_bill_set_member', { p_bill_id: billId, p_phone: phone })
  if (error) fail(error)
  const m = parse(data)
  if (!m) throw new Error('The server did not return the member.')
  return m
}

export async function clearBillMember(billId: string): Promise<void> {
  const { error } = await supabase.rpc('pos_bill_clear_member', { p_bill_id: billId })
  if (error) fail(error)
}
