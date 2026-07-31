/** Device-local calendar date as YYYY-MM-DD. new Date().toISOString() would
 *  give the UTC date, which is YESTERDAY between 00:00 and 07:59 in Malaysia
 *  (UTC+8) — wrong for attendance-day and lateness math. */
export function localDateStr(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** The calendar day before `dateStr`, as YYYY-MM-DD. */
export function prevDateStr(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`)
  d.setDate(d.getDate() - 1)
  return localDateStr(d)
}

/** Just the start/end of a shift_types row — all this module needs of one. */
export interface ShiftWindow {
  start_time: string
  end_time: string
}

function toMinutes(t: string): number {
  const [h, m] = t.split(':')
  return Number(h) * 60 + Number(m)
}

/** A shift whose end is at or before its start runs past midnight (17:00–01:00).
 *  Same rule the auto-absent SQL uses, so both layers agree on what a night
 *  shift is. */
export function isOvernightShift(shift: ShiftWindow): boolean {
  return toMinutes(shift.end_time) <= toMinutes(shift.start_time)
}

/** How long past an overnight shift's scheduled end the previous day stays the
 *  active attendance day. Generous enough for a late clock-out, short enough
 *  that a forgotten one never swallows the following day. */
export const OVERNIGHT_CLOCK_OUT_GRACE_MINUTES = 240

/** Which attendance day the staff member is currently in.
 *
 *  Normally today. But a night shift is stored under the date it STARTS (the
 *  same convention as scheduled_shifts and mark_absent_for_missed_shifts), so
 *  between midnight and the shift end the active day is still YESTERDAY —
 *  otherwise the 1:00am clock-out would look for a record that only exists
 *  under yesterday's date, and the UI would demand a fresh clock-in.
 *
 *  Only an OPEN session (clocked in, not out) holds the day back, and only
 *  within the grace window, so a normal day rolls over untouched. */
export function resolveAttendanceDate({
  now = new Date(),
  prevShift,
  prevOpen,
}: {
  now?: Date
  /** Yesterday's scheduled shift, if the staff member had one. */
  prevShift: ShiftWindow | null
  /** Yesterday's attendance row has a clock-in but no clock-out. */
  prevOpen: boolean
}): string {
  const today = localDateStr(now)
  if (!prevOpen || !prevShift || !isOvernightShift(prevShift)) return today

  // Yesterday's overnight shift ends TODAY at end_time.
  const endsAt = new Date(`${today}T${prevShift.end_time}`)
  const deadline = endsAt.getTime() + OVERNIGHT_CLOCK_OUT_GRACE_MINUTES * 60000
  return now.getTime() <= deadline ? prevDateStr(today) : today
}

/** Strict lateness vs the scheduled shift start (no grace period).
 *  Baseline is device-local `${dateStr}T${startTime}`, matching how the app
 *  builds todayStr()/times everywhere. Sub-minute lateness rounds UP so a
 *  `late` status never shows "0 minutes". */
export function calcLateness(
  clockInIso: string,
  dateStr: string,
  startTime: string,
): { isLate: boolean; lateMinutes: number } {
  const start = new Date(`${dateStr}T${startTime}`)
  const diffMs = new Date(clockInIso).getTime() - start.getTime()
  if (diffMs <= 0) return { isLate: false, lateMinutes: 0 }
  return { isLate: true, lateMinutes: Math.ceil(diffMs / 60000) }
}
