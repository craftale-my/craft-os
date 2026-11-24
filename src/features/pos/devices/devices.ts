// Devices in Craft OS: the approval form's rules and the words shown for each device.
// The server (pos_decide_device_request, pos_unpair_device) is the truth; these mirror it.

export type DeviceKind = 'pos' | 'print_agent'
export type DevicePlatform = 'ipad' | 'android' | 'other' | 'agent'

export const KIND_LABELS: Record<DeviceKind, string> = { pos: 'POS', print_agent: 'Print agent' }
export const PLATFORM_LABELS: Record<DevicePlatform, string> = { ipad: 'iPad', android: 'Android', other: 'Other', agent: 'Computer' }

/** One row of pos_device_requests_pending(). */
export interface PendingRequest {
  id: string
  code: string
  name: string | null
  platform: DevicePlatform
  createdAt: string
  expiresAt: string
}

/** One row of pos_devices_list(). */
export interface DeviceRow {
  id: string
  name: string
  branchId: string
  outletName: string
  kind: DeviceKind
  platform: DevicePlatform
  prints: boolean
  approvedByName: string | null
  approvedAt: string
  lastSeenAt: string | null
  revokedAt: string | null
}

export interface ApproveDraft {
  code: string
  branchId: string
  kind: DeviceKind
  name: string
  prints: boolean        // the outlet's printing tablet (prints and holds the cash drawer)
}

/** A code as typed ("abc def", "ABCDEF") in the tablet's form "ABC-DEF", or null. */
export function normalizeCode(text: string): string | null {
  const s = text.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return /^[A-HJ-NP-Z2-9]{6}$/.test(s) ? `${s.slice(0, 3)}-${s.slice(3)}` : null
}

/** The approval form checked with pos_decide_device_request's rules and messages. */
export function approveProblem(d: ApproveDraft, requestCode: string): string | null {
  if (normalizeCode(d.code) !== requestCode) return 'The code does not match the tablet'
  if (!d.branchId) return 'Choose the outlet'
  const name = d.name.trim()
  if (!name || name.length > 40) return 'Enter the device name (up to 40 characters)'
  if (d.prints && d.kind !== 'pos') return 'Only a POS tablet can print and hold the cash drawer'
  return null
}

/** "Never", "Just now", "5 min ago", "3 h ago", "2 days ago". */
export function lastSeenText(iso: string | null, now: Date): string {
  if (!iso) return 'Never'
  const min = Math.floor((now.getTime() - new Date(iso).getTime()) / 60000)
  if (min < 1) return 'Just now'
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h ago`
  const days = Math.floor(h / 24)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}

const MYT_DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
})

/** "29 Oct, 14:05", Malaysia time. */
export function mytDateTime(iso: string): string {
  return MYT_DATE_TIME.format(new Date(iso))
}

/** "15" → 15; anything but a whole number from 1 to 60 → null. */
export function parseLockMinutes(text: string): number | null {
  const t = text.trim()
  if (!/^\d{1,2}$/.test(t)) return null
  const n = Number(t)
  return n >= 1 && n <= 60 ? n : null
}
