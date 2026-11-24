import { supabase } from '../../../shared/lib/supabase'
import type { Approver } from '../checkout/checkoutApi'
import type { Outlet, OutletInput, OutletKind } from './outlet'

function fail(error: { message: string } | null): never {
  throw new Error(error?.message ?? 'Unknown error')
}

interface OutletRow {
  id: string; name: string; kind: OutletKind; opens_on: string | null; closes_on: string | null
  bill_prefix: string | null; is_active: boolean; is_home: boolean; open_now: boolean
}

/** The caller's outlets (home branch first): my_outlets(). */
export async function fetchMyOutlets(): Promise<Outlet[]> {
  const { data, error } = await supabase.rpc('my_outlets')
  if (error) fail(error)
  return ((data ?? []) as OutletRow[]).map((r) => ({
    id: r.id, name: r.name, kind: r.kind, opensOn: r.opens_on, closesOn: r.closes_on, billPrefix: r.bill_prefix,
    isActive: r.is_active, isHome: r.is_home, openNow: r.open_now,
  }))
}

/** HQ adds (id null) or changes an outlet; returns its id. */
export async function saveOutlet(o: OutletInput): Promise<string> {
  const { data, error } = await supabase.rpc('save_outlet', {
    p_id: o.id, p_name: o.name, p_kind: o.kind, p_opens_on: o.opensOn, p_closes_on: o.closesOn, p_bill_prefix: o.billPrefix,
  })
  if (error) fail(error)
  return data as string
}

/** The extra outlets of a staff member (branch ids). */
export async function fetchStaffOutlets(staffId: string): Promise<string[]> {
  const { data, error } = await supabase.from('staff_outlets').select('branch_id').eq('staff_id', staffId)
  if (error) fail(error)
  return ((data ?? []) as { branch_id: string }[]).map((r) => r.branch_id)
}

export async function setStaffOutlet(staffId: string, branchId: string, on: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_staff_outlet', { p_staff_id: staffId, p_branch_id: branchId, p_on: on })
  if (error) fail(error)
}

/** Who may approve at an outlet the caller manages (POS settings → Approvers). */
export async function fetchOutletApprovers(branchId: string): Promise<Approver[]> {
  const { data, error } = await supabase.rpc('pos_outlet_approvers', { p_branch_id: branchId })
  if (error) fail(error)
  return ((data ?? []) as { staff_id: string; name: string; has_pin: boolean }[]).map((a) => ({ staffId: a.staff_id, name: a.name, hasPin: a.has_pin }))
}
