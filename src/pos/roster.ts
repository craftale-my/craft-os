/** The lock screen's data: pos_login_roster() (migration-2026-10-29-pos-devices.sql) and what
 *  the screen shows from it (spec §2 "PIN login and staff sessions", §5 "Messages"). */

export interface RosterOutlet {
  id: string
  name: string
  kind: string
  opensOn: string | null      // YYYY-MM-DD
  closesOn: string | null
  isActive: boolean
  open: boolean               // pos_outlet_open(): the POS may be used here today
}

export interface RosterReply {
  device: { id: string; name: string; prints: boolean }
  outlet: RosterOutlet
  idleLockMinutes: number
  session: { staffId: string; name: string } | null
  staff: { id: string; name: string; hasPin: boolean }[]
}

export interface RosterPerson { id: string; name: string; canSignIn: boolean; note: string | null }

export const NO_PIN_NOTE = 'Set a PIN in Craft OS first'

/** Names without a PIN are greyed with a note (spec §5). */
export function rosterPeople(staff: RosterReply['staff']): RosterPerson[] {
  return staff.map((s) => ({ id: s.id, name: s.name, canSignIn: s.hasPin, note: s.hasPin ? null : NO_PIN_NOTE }))
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "30 Nov", with the year when it is not this year. */
export function shortDate(day: string, today: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return `${d} ${MONTHS[m - 1]}${String(y) === today.slice(0, 4) ? '' : ` ${y}`}`
}

/** Today in Malaysia (YYYY-MM-DD), the day pos_outlet_open() uses. */
export function malaysiaToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** Why nobody may sign in here today, or null when the outlet is open (spec §5 `outlet_closed`). */
export function closedMessage(o: RosterOutlet, today: string): string | null {
  if (o.open) return null
  if (o.isActive && o.opensOn && today < o.opensOn) return `This outlet opens on ${shortDate(o.opensOn, today)}.`
  if (o.isActive && o.closesOn && today > o.closesOn) return `This outlet closed on ${shortDate(o.closesOn, today)}.`
  return 'This outlet is closed.'
}
