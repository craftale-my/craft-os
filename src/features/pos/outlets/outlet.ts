// Outlets (branches, kiosks, pop-ups): the form rules and the dates shown beside them.
// The server (save_outlet, pos_outlet_open) is the truth; these mirror its words.

export type OutletKind = 'branch' | 'kiosk' | 'popup'

export const OUTLET_KINDS: { kind: OutletKind; label: string }[] = [
  { kind: 'branch', label: 'Branch' },
  { kind: 'kiosk', label: 'Kiosk' },
  { kind: 'popup', label: 'Pop-up' },
]

/** One row of my_outlets(). Dates are 'YYYY-MM-DD' (Malaysia days). */
export interface Outlet {
  id: string
  name: string
  kind: OutletKind
  opensOn: string | null
  closesOn: string | null
  billPrefix: string | null
  isActive: boolean
  isHome: boolean
  openNow: boolean
}

/** The outlet form as typed: empty strings for empty fields. */
export interface OutletDraft {
  id: string | null
  name: string
  kind: OutletKind
  opensOn: string
  closesOn: string
  billPrefix: string
}

/** What save_outlet receives. */
export interface OutletInput {
  id: string | null
  name: string
  kind: OutletKind
  opensOn: string | null
  closesOn: string | null
  billPrefix: string | null
}

export function draftFromOutlet(o: Outlet | null): OutletDraft {
  if (!o) return { id: null, name: '', kind: 'branch', opensOn: '', closesOn: '', billPrefix: '' }
  return { id: o.id, name: o.name, kind: o.kind, opensOn: o.opensOn ?? '', closesOn: o.closesOn ?? '', billPrefix: o.billPrefix ?? '' }
}

/** The form checked with save_outlet's rules and messages. Dates are kept for a pop-up only. */
export function parseOutletDraft(d: OutletDraft): { ok: true; value: OutletInput } | { ok: false; problem: string } {
  const name = d.name.trim()
  if (!name) return { ok: false, problem: 'Enter the outlet name' }
  if (name.length > 60) return { ok: false, problem: 'The outlet name is longer than 60 characters' }
  const popup = d.kind === 'popup'
  const opensOn = popup && d.opensOn ? d.opensOn : null
  const closesOn = popup && d.closesOn ? d.closesOn : null
  if (popup && (!opensOn || !closesOn)) return { ok: false, problem: 'A pop-up needs its first and last day' }
  if (opensOn && closesOn && closesOn < opensOn) return { ok: false, problem: 'The last day is before the first day' }
  const billPrefix = d.billPrefix.trim().toUpperCase() || null
  if (billPrefix && !/^[A-Z0-9]{1,4}$/.test(billPrefix)) return { ok: false, problem: 'The bill prefix is 1 to 4 letters or digits' }
  return { ok: true, value: { id: d.id, name, kind: d.kind, opensOn, closesOn, billPrefix } }
}

const MYT_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit' })

/** Today in Malaysia, 'YYYY-MM-DD'. */
export function mytDay(now: Date): string {
  return MYT_DAY.format(now)
}

/** The first bill number of a Malaysia day at an outlet with this prefix: 'PJ-261029-001'. */
export function billNoExample(prefix: string | null, now: Date): string {
  const [y, m, d] = mytDay(now).split('-')
  return `${prefix ? `${prefix}-` : ''}${y.slice(2)}${m}${d}-001`
}

const SHORT_DAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' })

/** '2026-11-30' → '30 Nov'. */
export function shortDay(iso: string): string {
  return SHORT_DAY.format(new Date(`${iso}T00:00:00Z`))
}

/** Why an outlet is not open for POS today, or null when it is. */
export function outletNote(o: Pick<Outlet, 'kind' | 'opensOn' | 'closesOn' | 'isActive'>, today: string): string | null {
  if (!o.isActive) return 'Inactive'
  if (o.kind !== 'popup' || !o.opensOn || !o.closesOn) return null
  if (today < o.opensOn) return `Opens on ${shortDay(o.opensOn)}`
  if (today > o.closesOn) return `Closed on ${shortDay(o.closesOn)}`
  return null
}

/** '1 Dec – 31 Dec' for a pop-up, '' otherwise. */
export function outletDates(o: Pick<Outlet, 'kind' | 'opensOn' | 'closesOn'>): string {
  return o.kind === 'popup' && o.opensOn && o.closesOn ? `${shortDay(o.opensOn)} – ${shortDay(o.closesOn)}` : ''
}

/** The outlet to show first: the one asked for, else the home branch, else the first. */
export function pickOutlet(outlets: Outlet[], wanted: string | null): Outlet | null {
  return outlets.find((o) => o.id === wanted) ?? outlets.find((o) => o.isHome) ?? outlets[0] ?? null
}
