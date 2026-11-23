import type { Attendance, AttendanceBreak, ScheduledShift, ShiftType } from '../types'
import { isOvernightShift } from './attendance'

export interface DailyDetail {
  date: string                    // YYYY-MM-DD
  status: Attendance['status'] | null   // null when no attendance row at all
  clockIn: string | null          // ISO
  clockOut: string | null         // ISO
  lateMinutes: number             // 0 unless the row is still recorded as late
  workedMinutes: number | null    // null if either clock missing, or a break was never closed
  breaks: { number: 1 | 2; start: string | null; end: string | null; durationMinutes: number | null; overtimeMinutes: number; isOvertime: boolean }[]
  shiftName: string | null        // scheduled shift name, null if none
  shiftStart: string | null       // HH:MM:SS from shift_types
  shiftEnd: string | null
  leaveType: string | null        // scheduled_shifts.leave_type when the day is a leave marker
  missedClockIn: boolean          // a live work shift that ended unworked and unexcused
  distanceM: number | null        // clock_in_distance_m
}

export interface StaffSummary {
  staffId: string
  present: number; late: number; lateMinutes: number
  absent: number; onLeave: number; halfDay: number
  missedClockIn: number; breakOvertimes: number
  days: DailyDetail[]             // sorted by date ascending
}

const DAY_MS = 24 * 60 * 60 * 1000
/** No single shift runs longer than this, so a backwards gap smaller than
 *  DAY_MS − MAX_SHIFT_MS cannot be a day boundary. */
const MAX_SHIFT_MS = 16 * 60 * 60 * 1000

/** Worked minutes = clock_out − clock_in − breaks taken, clamped at 0.
 *  null when either clock is missing.
 *
 *  A clock_out earlier than clock_in is rolled to the next day ONLY when the
 *  backwards gap is wide enough to be a real overnight encoding. Both clocks
 *  are absolute instants written by the device, so a genuine 17:00–01:00 shift
 *  already stores clock_out later than clock_in and never reaches the rollover;
 *  what does reach it is device clock skew, where a clock_out two minutes
 *  "before" the clock_in used to become 1,438 minutes — a day of work invented
 *  out of a two-minute error. Narrow inversions now fall through to the clamp. */
export function computeWorkedMinutes(
  clockIn: string | null,
  clockOut: string | null,
  breakMinutesTotal: number,
): number | null {
  if (!clockIn || !clockOut) return null
  const start = new Date(clockIn).getTime()
  let end = new Date(clockOut).getTime()
  if (end < start && start - end > DAY_MS - MAX_SHIFT_MS) end += DAY_MS
  const minutes = Math.round((end - start) / 60000) - breakMinutesTotal
  return Math.max(0, minutes)
}

type ShiftWithType = ScheduledShift & {
  shift_type?: Pick<ShiftType, 'name' | 'start_time' | 'end_time'> | null
}

/** Attendance statuses that say "not expected to clock in today". `absent` is
 *  deliberately absent from this set: it is what the system STORES for a real
 *  missed shift (mark_absent_for_missed_shifts writes it), so exempting it
 *  would blank the metric the moment the hourly job caught up. */
const EXCUSED_STATUSES = new Set<Attendance['status']>(['on_leave', 'public_holiday'])

/** Shift statuses that still oblige the staff member to turn up. Mirrors
 *  `ss.status in ('scheduled','confirmed')` in mark_absent_for_missed_shifts. */
const LIVE_SHIFT_STATUSES = new Set<ScheduledShift['status']>(['scheduled', 'confirmed'])

/** Shift times are Malaysian wall-clock, and Malaysia has been a fixed UTC+8
 *  with no daylight saving since 1982 — the SQL job reads them as
 *  `now() at time zone 'Asia/Kuala_Lumpur'`. Anchoring them to the viewer's zone
 *  instead would move the "has this shift ended?" line by the viewer's offset:
 *  on a UTC laptop a shift stayed un-ended for eight more hours, hiding real
 *  missed clock-ins. */
const MYT_OFFSET = '+08:00'

/** `date` advanced one calendar day, computed in UTC so the host zone cannot
 *  shift it across a boundary. */
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** The instant a shift ends, in Malaysian time. An overnight shift (end at or
 *  before start, e.g. 22:00–06:00) ends the FOLLOWING day — the same rule the
 *  auto-absent SQL applies with
 *  `case when st.end_time <= st.start_time then interval '1 day'`. */
function shiftEndsAt(date: string, start: string, end: string): Date {
  const day = isOvernightShift({ start_time: start, end_time: end }) ? nextDay(date) : date
  return new Date(`${day}T${end}${MYT_OFFSET}`)
}

/** One StaffSummary per input staffId — including staff with zero rows, whose
 *  counters are all 0 and whose `days` is empty. `days` is the union of dates
 *  that have either an attendance row or a scheduled_shifts row. */
export function buildStaffReport(
  staffIds: string[],
  attendance: Attendance[],
  breaks: AttendanceBreak[],
  shifts: ShiftWithType[],
  /** Clock used to decide whether a shift has ended yet. */
  now: Date = new Date(),
): StaffSummary[] {
  const breaksByAttId = new Map<string, AttendanceBreak[]>()
  for (const b of breaks) {
    const list = breaksByAttId.get(b.attendance_id)
    if (list) list.push(b)
    else breaksByAttId.set(b.attendance_id, [b])
  }

  return staffIds.map(staffId => {
    const staffAttendance = attendance.filter(a => a.staff_id === staffId)
    const staffShifts = shifts.filter(s => s.staff_id === staffId)

    const attByDate = new Map(staffAttendance.map(a => [a.date, a]))
    const shiftByDate = new Map(staffShifts.map(s => [s.date, s]))
    const dates = [...new Set([...attByDate.keys(), ...shiftByDate.keys()])].sort()

    const days: DailyDetail[] = dates.map(date => {
      const att = attByDate.get(date) ?? null
      const shift = shiftByDate.get(date) ?? null

      const dayBreaks = (att ? breaksByAttId.get(att.id) : undefined) ?? []
      const sortedBreaks = [...dayBreaks].sort((a, b) => a.break_number - b.break_number)
      const breakMinutesTotal = sortedBreaks.reduce((sum, b) => sum + (b.duration_minutes ?? 0), 0)
      // A break that was started and never ended has no duration, and there is
      // no honest way to guess one: counting it as zero credited the whole
      // unclosed break as time worked. Worked time for the day is unknown.
      const hasOpenBreak = sortedBreaks.some(b => b.clock_out_time && !b.clock_in_time)

      // "Missed clock-in" has to mean the same thing here as it does in
      // mark_absent_for_missed_shifts(), because the same day shows up in both:
      // a live work shift that has ENDED, with no clock-in, on a day nothing
      // excuses. Before, any work shift without a clock-in counted — so an
      // approved leave day counted twice (Leave and Missed), today's shift
      // counted before anyone could work it, and a cancelled shift counted at
      // all.
      const st = shift?.shift_type
      const endsAt = shift?.shift_type_id && st?.start_time && st?.end_time
        ? shiftEndsAt(date, st.start_time, st.end_time)
        : null
      const missedClockIn =
        !!shift?.shift_type_id &&
        !shift.leave_type &&
        LIVE_SHIFT_STATUSES.has(shift.status) &&
        endsAt != null &&
        endsAt.getTime() < now.getTime() &&
        !att?.clock_in &&
        !(att && EXCUSED_STATUSES.has(att.status))

      // The summary counts late minutes only from rows still recorded as late,
      // so the detail row must apply the same predicate or the expander
      // contradicts the total above it — a day re-marked present keeps its
      // stale late_minutes on the row.
      const dayLateMinutes = att?.status === 'late' ? (att.late_minutes ?? 0) : 0

      return {
        date,
        status: att?.status ?? null,
        clockIn: att?.clock_in ?? null,
        clockOut: att?.clock_out ?? null,
        lateMinutes: dayLateMinutes,
        workedMinutes: hasOpenBreak
          ? null
          : computeWorkedMinutes(att?.clock_in ?? null, att?.clock_out ?? null, breakMinutesTotal),
        breaks: sortedBreaks.map(b => ({
          number: b.break_number,
          start: b.clock_out_time,
          end: b.clock_in_time,
          durationMinutes: b.duration_minutes,
          overtimeMinutes: b.overtime_minutes,
          isOvertime: b.is_overtime,
        })),
        shiftName: shift?.shift_type?.name ?? null,
        shiftStart: shift?.shift_type?.start_time ?? null,
        shiftEnd: shift?.shift_type?.end_time ?? null,
        leaveType: shift?.leave_type ?? null,
        missedClockIn,
        distanceM: att?.clock_in_distance_m ?? null,
      }
    })

    const present = staffAttendance.filter(a => a.status === 'present').length
    const late = staffAttendance.filter(a => a.status === 'late').length
    // Derived from `days` rather than re-filtered from the rows, so the headline
    // total and the expander's Late column cannot drift apart again.
    const lateMinutes = days.reduce((sum, d) => sum + d.lateMinutes, 0)
    const absent = staffAttendance.filter(a => a.status === 'absent').length
    const onLeave = staffAttendance.filter(a => a.status === 'on_leave').length
    const halfDay = staffAttendance.filter(a => a.status === 'half_day').length
    const missedClockIn = days.filter(d => d.missedClockIn).length
    const breakOvertimes = staffAttendance.reduce(
      (sum, a) => sum + (breaksByAttId.get(a.id) ?? []).filter(b => b.is_overtime).length,
      0,
    )

    return { staffId, present, late, lateMinutes, absent, onLeave, halfDay, missedClockIn, breakOvertimes, days }
  })
}
