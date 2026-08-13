import type { Attendance, AttendanceBreak, ScheduledShift, ShiftType } from '../types'

export interface DailyDetail {
  date: string                    // YYYY-MM-DD
  status: Attendance['status'] | null   // null when no attendance row at all
  clockIn: string | null          // ISO
  clockOut: string | null         // ISO
  lateMinutes: number
  workedMinutes: number | null    // null if either clock missing
  breaks: { number: 1 | 2; start: string | null; end: string | null; durationMinutes: number | null; overtimeMinutes: number; isOvertime: boolean }[]
  shiftName: string | null        // scheduled shift name, null if none
  shiftStart: string | null       // HH:MM:SS from shift_types
  shiftEnd: string | null
  leaveType: string | null        // scheduled_shifts.leave_type when the day is a leave marker
  missedClockIn: boolean          // had a work shift scheduled but no clock_in
  distanceM: number | null        // clock_in_distance_m
}

export interface StaffSummary {
  staffId: string
  present: number; late: number; lateMinutes: number
  absent: number; onLeave: number; halfDay: number
  missedClockIn: number; breakOvertimes: number
  days: DailyDetail[]             // sorted by date ascending
}

/** Worked minutes = clock_out − clock_in − breaks taken, clamped at 0.
 *  null when either clock is missing. A clock_out earlier than clock_in is
 *  treated as an overnight shift (clock_out rolled to the next day). */
export function computeWorkedMinutes(
  clockIn: string | null,
  clockOut: string | null,
  breakMinutesTotal: number,
): number | null {
  if (!clockIn || !clockOut) return null
  const start = new Date(clockIn).getTime()
  let end = new Date(clockOut).getTime()
  if (end < start) end += 24 * 60 * 60 * 1000
  const minutes = Math.round((end - start) / 60000) - breakMinutesTotal
  return Math.max(0, minutes)
}

type ShiftWithType = ScheduledShift & {
  shift_type?: Pick<ShiftType, 'name' | 'start_time' | 'end_time'> | null
}

/** One StaffSummary per input staffId — including staff with zero rows, whose
 *  counters are all 0 and whose `days` is empty. `days` is the union of dates
 *  that have either an attendance row or a scheduled_shifts row. */
export function buildStaffReport(
  staffIds: string[],
  attendance: Attendance[],
  breaks: AttendanceBreak[],
  shifts: ShiftWithType[],
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

      // A "work shift" has shift_type_id set — a leave marker (leave_type set,
      // shift_type_id null) is never a scheduled shift for missedClockIn purposes.
      const isWorkShift = !!shift?.shift_type_id
      const missedClockIn = isWorkShift && !att?.clock_in

      return {
        date,
        status: att?.status ?? null,
        clockIn: att?.clock_in ?? null,
        clockOut: att?.clock_out ?? null,
        lateMinutes: att?.late_minutes ?? 0,
        workedMinutes: computeWorkedMinutes(att?.clock_in ?? null, att?.clock_out ?? null, breakMinutesTotal),
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
    const lateRows = staffAttendance.filter(a => a.status === 'late')
    const late = lateRows.length
    const lateMinutes = lateRows.reduce((sum, a) => sum + a.late_minutes, 0)
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
