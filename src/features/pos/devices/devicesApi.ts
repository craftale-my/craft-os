import { supabase } from '../../../shared/lib/supabase'
import type { ApproveDraft, DeviceKind, DevicePlatform, DeviceRow, PendingRequest } from './devices'

function fail(error: { message: string } | null): never {
  throw new Error(error?.message ?? 'Unknown error')
}

/** HQ: the activation requests waiting for a decision. */
export async function fetchPendingRequests(): Promise<PendingRequest[]> {
  const { data, error } = await supabase.rpc('pos_device_requests_pending')
  if (error) fail(error)
  return ((data ?? []) as { id: string; code: string; name: string | null; platform: DevicePlatform; created_at: string; expires_at: string }[])
    .map((r) => ({ id: r.id, code: r.code, name: r.name, platform: r.platform, createdAt: r.created_at, expiresAt: r.expires_at }))
}

/** HQ approves a request (the code typed from the tablet, outlet, kind, name, printing tablet). */
export async function approveRequest(requestId: string, d: ApproveDraft): Promise<void> {
  const { error } = await supabase.rpc('pos_decide_device_request', {
    p_request_id: requestId, p_approve: true, p_code: d.code, p_branch_id: d.branchId, p_kind: d.kind, p_name: d.name,
    p_prints: d.prints,
  })
  if (error) fail(error)
}

export async function rejectRequest(requestId: string): Promise<void> {
  const { error } = await supabase.rpc('pos_decide_device_request', {
    p_request_id: requestId, p_approve: false, p_code: null, p_branch_id: null, p_kind: null, p_name: null, p_prints: null,
  })
  if (error) fail(error)
}

/** The devices of the caller's outlets. */
export async function fetchDevices(): Promise<DeviceRow[]> {
  const { data, error } = await supabase.rpc('pos_devices_list')
  if (error) fail(error)
  return ((data ?? []) as {
    id: string; name: string; branch_id: string; outlet_name: string; kind: DeviceKind; platform: DevicePlatform; prints: boolean
    approved_by_name: string | null; approved_at: string; last_seen_at: string | null; revoked_at: string | null
  }[]).map((r) => ({
    id: r.id, name: r.name, branchId: r.branch_id, outletName: r.outlet_name, kind: r.kind, platform: r.platform, prints: r.prints,
    approvedByName: r.approved_by_name, approvedAt: r.approved_at, lastSeenAt: r.last_seen_at, revokedAt: r.revoked_at,
  }))
}

export async function unpairDevice(deviceId: string): Promise<void> {
  const { error } = await supabase.rpc('pos_unpair_device', { p_device_id: deviceId })
  if (error) fail(error)
}

/** Makes an active POS tablet its outlet's printing tablet (the previous one stops). */
export async function setPrintTablet(deviceId: string): Promise<void> {
  const { error } = await supabase.rpc('pos_set_print_tablet', { p_device_id: deviceId })
  if (error) fail(error)
}

/** branch_pos_settings is readable by every signed-in staff member; no row = the default 10. */
export async function fetchIdleLockMinutes(branchId: string): Promise<number> {
  const { data, error } = await supabase.from('branch_pos_settings').select('idle_lock_minutes').eq('branch_id', branchId).maybeSingle()
  if (error) fail(error)
  return (data as { idle_lock_minutes: number } | null)?.idle_lock_minutes ?? 10
}

export async function saveIdleLockMinutes(branchId: string, minutes: number): Promise<void> {
  const { error } = await supabase.rpc('save_lock_settings', { p_branch_id: branchId, p_idle_lock_minutes: minutes })
  if (error) fail(error)
}
