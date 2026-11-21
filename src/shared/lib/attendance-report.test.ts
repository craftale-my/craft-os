import { describe, it, expect } from 'vitest'
import { computeWorkedMinutes, buildStaffReport } from './attendance-report'
import type { Attendance, AttendanceBreak, ScheduledShift, ShiftType } from '../types'

// Build ISO strings in LOCAL time so tests are timezone-independent.
const localIso = (dateStr: string, time: string) => new Date(`${dateStr}T${time}`).toISOString()

function makeAttendance(overrides: Partial<Attendance> & { id: string; staff_id: string; date: string }): Attendance {
  return {
    clock_in: null,
    clock_out: null,
    status: 'present',
    late_minutes: 0,
    late_reason_code: null,
    late_reason: null,
    late_excused: false,
    late_excused_by: null,
    late_excused_at: null,
    notes: null,
    recorded_by: null,
    created_at: '2026-01-01T00:00:00.000Z',
    clock_in_photo_url: null,
    clock_out_photo_url: null,
    clock_in_lat: null,
    clock_in_lng: null,
    clock_in_distance_m: null,
    clock_out_lat: null,
    clock_out_lng: null,
    clock_out_distance_m: null,
    break_start: null,
    break_end: null,
    break_minutes: null,
    break_late: false,
    break_overrun_minutes: 0,
    scheduled_shift_id: null,
    marked_by: null,
    ...overrides,
  }
}

function makeBreak(overrides: Partial<AttendanceBreak> & { id: string; attendance_id: string; break_number: 1 | 2 }): AttendanceBreak {
  return {
    clock_out_time: null,
    clock_in_time: null,
    duration_minutes: null,
    overtime_minutes: 0,
    is_overtime: false,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

type ShiftWithType = ScheduledShift & { shift_type?: Pick<ShiftType, 'name' | 'start_time' | 'end_time'> | null }

/** The report only ever receives shifts with their type embedded, and the
 *  missed-clock-in rule needs the end time to know whether the shift is over. */
const MORNING = { name: 'Morning', start_time: '09:30:00', end_time: '18:00:00' }
/** Well after every date these tests use, so shifts count as ended. */
const AFTER = new Date('2026-09-01T12:00:00+08:00')

function makeShift(overrides: Partial<ShiftWithType> & { id: string; staff_id: string; date: string }): ShiftWithType {
  return {
    shift_type_id: null,
    leave_type: null,
    branch_id: null,
    status: 'scheduled',
    notes: null,
    created_by: null,
    created_at: '2026-01-01T00:00:00.000Z',
    shift_type: null,
    ...overrides,
  }
}

describe('computeWorkedMinutes', () => {
  it('computes a normal same-day shift', () => {
    const clockIn = localIso('2026-08-01', '09:30:00')
    const clockOut = localIso('2026-08-01', '18:00:00')
    expect(computeWorkedMinutes(clockIn, clockOut, 0)).toBe(510) // 8.5h
  })

  it('returns null when clock_out is missing', () => {
    const clockIn = localIso('2026-08-01', '09:30:00')
    expect(computeWorkedMinutes(clockIn, null, 0)).toBeNull()
  })

  it('returns null when clock_in is missing', () => {
    const clockOut = localIso('2026-08-01', '18:00:00')
    expect(computeWorkedMinutes(null, clockOut, 0)).toBeNull()
  })

  it('returns null when both clocks are missing', () => {
    expect(computeWorkedMinutes(null, null, 0)).toBeNull()
  })

  it('treats a clock_out before clock_in as crossing midnight (+24h)', () => {
    const clockIn = localIso('2026-08-01', '17:00:00')
    const clockOut = localIso('2026-08-01', '01:00:00') // same calendar date, but earlier clock time
    // 17:00 -> 01:00 next day = 8 hours = 480 minutes
    expect(computeWorkedMinutes(clockIn, clockOut, 0)).toBe(480)
  })

  it('subtracts break minutes from the worked total', () => {
    const clockIn = localIso('2026-08-01', '09:30:00')
    const clockOut = localIso('2026-08-01', '18:00:00')
    expect(computeWorkedMinutes(clockIn, clockOut, 60)).toBe(450)
  })

  it('clamps at zero rather than returning negative minutes', () => {
    const clockIn = localIso('2026-08-01', '09:30:00')
    const clockOut = localIso('2026-08-01', '10:00:00') // 30 minutes worked
    expect(computeWorkedMinutes(clockIn, clockOut, 120)).toBe(0)
  })
})

describe('buildStaffReport', () => {
  it('returns a zeroed summary with empty days for a staff with no rows', () => {
    const result = buildStaffReport(['s1'], [], [], [])
    expect(result).toEqual([{
      staffId: 's1',
      present: 0, late: 0, lateMinutes: 0,
      absent: 0, onLeave: 0, halfDay: 0,
      missedClockIn: 0, breakOvertimes: 0,
      days: [],
    }])
  })

  it('counts present/absent/on_leave/half_day rows by status', () => {
    const attendance = [
      makeAttendance({ id: 'a1', staff_id: 's1', date: '2026-08-01', status: 'present' }),
      makeAttendance({ id: 'a2', staff_id: 's1', date: '2026-08-02', status: 'absent' }),
      makeAttendance({ id: 'a3', staff_id: 's1', date: '2026-08-03', status: 'on_leave' }),
      makeAttendance({ id: 'a4', staff_id: 's1', date: '2026-08-04', status: 'half_day' }),
    ]
    const [summary] = buildStaffReport(['s1'], attendance, [], [])
    expect(summary.present).toBe(1)
    expect(summary.absent).toBe(1)
    expect(summary.onLeave).toBe(1)
    expect(summary.halfDay).toBe(1)
  })

  it('counts late rows and sums their late_minutes', () => {
    const attendance = [
      makeAttendance({ id: 'a1', staff_id: 's1', date: '2026-08-01', status: 'late', late_minutes: 12 }),
      makeAttendance({ id: 'a2', staff_id: 's1', date: '2026-08-02', status: 'late', late_minutes: 5 }),
      makeAttendance({ id: 'a3', staff_id: 's1', date: '2026-08-03', status: 'present', late_minutes: 0 }),
    ]
    const [summary] = buildStaffReport(['s1'], attendance, [], [])
    expect(summary.late).toBe(2)
    expect(summary.lateMinutes).toBe(17)
  })

  it('marks missedClockIn true when an ended work shift has no clock_in', () => {
    const shifts = [
      makeShift({ id: 'sh1', staff_id: 's1', date: '2026-08-01', shift_type_id: 'st1', shift_type: MORNING }),
    ]
    const [summary] = buildStaffReport(['s1'], [], [], shifts, AFTER)
    expect(summary.missedClockIn).toBe(1)
    expect(summary.days[0].missedClockIn).toBe(true)
  })

  it('does not count missedClockIn on a leave-marker day', () => {
    const shifts = [
      makeShift({ id: 'sh1', staff_id: 's1', date: '2026-08-01', shift_type_id: null, leave_type: 'annual' }),
    ]
    const attendance = [
      makeAttendance({ id: 'a1', staff_id: 's1', date: '2026-08-01', status: 'on_leave', clock_in: null }),
    ]
    const [summary] = buildStaffReport(['s1'], attendance, [], shifts, AFTER)
    expect(summary.missedClockIn).toBe(0)
    expect(summary.days[0].missedClockIn).toBe(false)
    expect(summary.days[0].leaveType).toBe('annual')
  })

  it('does not count missedClockIn when a work shift was clocked in', () => {
    const shifts = [
      makeShift({ id: 'sh1', staff_id: 's1', date: '2026-08-01', shift_type_id: 'st1', shift_type: MORNING }),
    ]
    const attendance = [
      makeAttendance({ id: 'a1', staff_id: 's1', date: '2026-08-01', status: 'present', clock_in: localIso('2026-08-01', '09:30:00') }),
    ]
    const [summary] = buildStaffReport(['s1'], attendance, [], shifts)
    expect(summary.missedClockIn).toBe(0)
    expect(summary.days[0].missedClockIn).toBe(false)
  })

  it('counts breakOvertimes across break rows marked is_overtime', () => {
    const attendance = [
      makeAttendance({ id: 'a1', staff_id: 's1', date: '2026-08-01', status: 'present' }),
      makeAttendance({ id: 'a2', staff_id: 's1', date: '2026-08-02', status: 'present' }),
    ]
    const breaks = [
      makeBreak({ id: 'b1', attendance_id: 'a1', break_number: 1, is_overtime: true }),
      makeBreak({ id: 'b2', attendance_id: 'a1', break_number: 2, is_overtime: false }),
      makeBreak({ id: 'b3', attendance_id: 'a2', break_number: 1, is_overtime: true }),
    ]
    const [summary] = buildStaffReport(['s1'], attendance, breaks, [])
    expect(summary.breakOvertimes).toBe(2)
  })

  it('sorts a day\'s breaks by break_number and leaves [] when there are none', () => {
    const attendance = [
      makeAttendance({ id: 'a1', staff_id: 's1', date: '2026-08-01', status: 'present' }),
      makeAttendance({ id: 'a2', staff_id: 's1', date: '2026-08-02', status: 'present' }),
    ]
    const breaks = [
      makeBreak({ id: 'b1', attendance_id: 'a1', break_number: 2 }),
      makeBreak({ id: 'b2', attendance_id: 'a1', break_number: 1 }),
    ]
    const [summary] = buildStaffReport(['s1'], attendance, breaks, [])
    const day1 = summary.days.find(d => d.date === '2026-08-01')!
    expect(day1.breaks.map(b => b.number)).toEqual([1, 2])
    const day2 = summary.days.find(d => d.date === '2026-08-02')!
    expect(day2.breaks).toEqual([])
  })

  it('builds days as the union of attendance-only and shift-only dates, sorted ascending', () => {
    const attendance = [
      makeAttendance({ id: 'a1', staff_id: 's1', date: '2026-08-05', status: 'present' }),
    ]
    const shifts = [
      makeShift({ id: 'sh1', staff_id: 's1', date: '2026-08-01', shift_type_id: 'st1' }),
    ]
    const [summary] = buildStaffReport(['s1'], attendance, [], shifts)
    expect(summary.days.map(d => d.date)).toEqual(['2026-08-01', '2026-08-05'])
    // shift-only day: no attendance row -> status null
    expect(summary.days[0].status).toBeNull()
    // attendance-only day: no shift -> shiftName null
    expect(summary.days[1].shiftName).toBeNull()
  })

  it('merges a day that has both an attendance row and a scheduled shift into one entry', () => {
    const attendance = [
      makeAttendance({ id: 'a1', staff_id: 's1', date: '2026-08-01', status: 'present', clock_in: localIso('2026-08-01', '09:30:00'), clock_out: localIso('2026-08-01', '18:00:00') }),
    ]
    const shifts = [
      makeShift({
        id: 'sh1', staff_id: 's1', date: '2026-08-01', shift_type_id: 'st1',
        shift_type: { name: 'Morning', start_time: '09:30:00', end_time: '18:00:00' },
      }),
    ]
    const [summary] = buildStaffReport(['s1'], attendance, [], shifts)
    expect(summary.days).toHaveLength(1)
    expect(summary.days[0].shiftName).toBe('Morning')
    expect(summary.days[0].shiftStart).toBe('09:30:00')
    expect(summary.days[0].shiftEnd).toBe('18:00:00')
    expect(summary.days[0].status).toBe('present')
  })

  it('computes workedMinutes per day, subtracting the day\'s total break duration', () => {
    const attendance = [
      makeAttendance({
        id: 'a1', staff_id: 's1', date: '2026-08-01', status: 'present',
        clock_in: localIso('2026-08-01', '09:30:00'),
        clock_out: localIso('2026-08-01', '18:00:00'),
      }),
    ]
    const breaks = [
      makeBreak({ id: 'b1', attendance_id: 'a1', break_number: 1, duration_minutes: 30 }),
      makeBreak({ id: 'b2', attendance_id: 'a1', break_number: 2, duration_minutes: 15 }),
    ]
    const [summary] = buildStaffReport(['s1'], attendance, breaks, [])
    // 8.5h (510m) - 45m breaks = 465m
    expect(summary.days[0].workedMinutes).toBe(465)
  })

  it('returns workedMinutes null for a day missing clock_out', () => {
    const attendance = [
      makeAttendance({ id: 'a1', staff_id: 's1', date: '2026-08-01', status: 'present', clock_in: localIso('2026-08-01', '09:30:00'), clock_out: null }),
    ]
    const [summary] = buildStaffReport(['s1'], attendance, [], [])
    expect(summary.days[0].workedMinutes).toBeNull()
  })

  it('keeps each staff isolated — rows for one staff do not leak into another\'s summary', () => {
    const attendance = [
      makeAttendance({ id: 'a1', staff_id: 's1', date: '2026-08-01', status: 'late', late_minutes: 10 }),
      makeAttendance({ id: 'a2', staff_id: 's2', date: '2026-08-01', status: 'absent' }),
    ]
    const breaks = [
      makeBreak({ id: 'b1', attendance_id: 'a1', break_number: 1, is_overtime: true }),
    ]
    const shifts = [
      makeShift({ id: 'sh1', staff_id: 's2', date: '2026-08-02', shift_type_id: 'st1', shift_type: MORNING }),
    ]
    const [s1, s2] = buildStaffReport(['s1', 's2'], attendance, breaks, shifts, AFTER)

    expect(s1.staffId).toBe('s1')
    expect(s1.late).toBe(1)
    expect(s1.lateMinutes).toBe(10)
    expect(s1.absent).toBe(0)
    expect(s1.breakOvertimes).toBe(1)
    expect(s1.missedClockIn).toBe(0)
    expect(s1.days.map(d => d.date)).toEqual(['2026-08-01'])

    expect(s2.staffId).toBe('s2')
    expect(s2.absent).toBe(1)
    expect(s2.late).toBe(0)
    expect(s2.breakOvertimes).toBe(0)
    expect(s2.missedClockIn).toBe(1) // shift on 08-02, no clock-in
    expect(s2.days.map(d => d.date)).toEqual(['2026-08-01', '2026-08-02'])
  })

  it('preserves input staffId order and includes a zero-row staff among populated ones', () => {
    const attendance = [
      makeAttendance({ id: 'a1', staff_id: 's1', date: '2026-08-01', status: 'present' }),
    ]
    const result = buildStaffReport(['s1', 's2', 's3'], attendance, [], [])
    expect(result.map(r => r.staffId)).toEqual(['s1', 's2', 's3'])
    expect(result[1]).toEqual({
      staffId: 's2',
      present: 0, late: 0, lateMinutes: 0,
      absent: 0, onLeave: 0, halfDay: 0,
      missedClockIn: 0, breakOvertimes: 0,
      days: [],
    })
  })

  it('exposes distanceM from clock_in_distance_m', () => {
    const attendance = [
      makeAttendance({ id: 'a1', staff_id: 's1', date: '2026-08-01', status: 'present', clock_in_distance_m: 42 }),
    ]
    const [summary] = buildStaffReport(['s1'], attendance, [], [])
    expect(summary.days[0].distanceM).toBe(42)
  })
})

// ─── missed clock-in: the rule the auto-absent SQL job already implements ─────
//
// mark_absent_for_missed_shifts() marks a day missed only when a live shift
// ('scheduled'/'confirmed') has ENDED in MYT — overnight shifts ending the next
// day — and writes 'on_leave' rather than 'absent' when approved leave covers
// the day. The report's red column has to agree with the row that job writes,
// because the same day appears in both.
describe('missedClockIn mirrors the auto-absent job', () => {
  const NOON_AUG_1 = new Date('2026-08-01T12:00:00+08:00')
  const workShift = (over: Partial<ShiftWithType> = {}) => makeShift({
    id: 'sh1', staff_id: 's1', date: '2026-08-01', shift_type_id: 'st1', shift_type: MORNING, ...over,
  })

  it('does not count a shift that has not ended yet', () => {
    // 09:30–18:00 seen at noon: still being worked, nobody has missed anything.
    const [summary] = buildStaffReport(['s1'], [], [], [workShift()], NOON_AUG_1)
    expect(summary.missedClockIn).toBe(0)
    expect(summary.days[0].missedClockIn).toBe(false)
  })

  it('counts the same shift once it has ended', () => {
    const afterEnd = new Date('2026-08-01T18:01:00+08:00')
    const [summary] = buildStaffReport(['s1'], [], [], [workShift()], afterEnd)
    expect(summary.missedClockIn).toBe(1)
  })

  it('does not count a future rostered day', () => {
    const shift = workShift({ date: '2026-08-05' })
    const [summary] = buildStaffReport(['s1'], [], [], [shift], NOON_AUG_1)
    expect(summary.missedClockIn).toBe(0)
  })

  it('treats an overnight shift as ending the next day', () => {
    const night = { name: 'Night', start_time: '17:00:00', end_time: '01:00:00' }
    const shift = workShift({ shift_type: night })
    // 00:30 on 08-02 is still inside a 17:00–01:00 shift that began on 08-01.
    const midShift = new Date('2026-08-02T00:30:00+08:00')
    expect(buildStaffReport(['s1'], [], [], [shift], midShift)[0].missedClockIn).toBe(0)
    const afterShift = new Date('2026-08-02T01:30:00+08:00')
    expect(buildStaffReport(['s1'], [], [], [shift], afterShift)[0].missedClockIn).toBe(1)
  })

  it('does not count an approved leave day that kept its work shift', () => {
    // HrLeave.approve() writes the on_leave attendance row but leaves the
    // rostered work shift in place, so the day used to land in Leave AND Missed.
    const attendance = [
      makeAttendance({ id: 'a1', staff_id: 's1', date: '2026-08-01', status: 'on_leave', clock_in: null }),
    ]
    const [summary] = buildStaffReport(['s1'], attendance, [], [workShift()], AFTER)
    expect(summary.onLeave).toBe(1)
    expect(summary.missedClockIn).toBe(0)
  })

  it('does not count a public holiday', () => {
    const attendance = [
      makeAttendance({ id: 'a1', staff_id: 's1', date: '2026-08-01', status: 'public_holiday', clock_in: null }),
    ]
    const [summary] = buildStaffReport(['s1'], attendance, [], [workShift()], AFTER)
    expect(summary.missedClockIn).toBe(0)
  })

  it('still counts a day the system already marked absent', () => {
    // 'absent' is what the job STORES for a missed shift — exempting it would
    // blank the metric as soon as the hourly job caught up.
    const attendance = [
      makeAttendance({ id: 'a1', staff_id: 's1', date: '2026-08-01', status: 'absent', clock_in: null }),
    ]
    const [summary] = buildStaffReport(['s1'], attendance, [], [workShift()], AFTER)
    expect(summary.absent).toBe(1)
    expect(summary.missedClockIn).toBe(1)
  })

  it('does not count a cancelled or swapped shift', () => {
    for (const status of ['cancelled', 'swapped'] as const) {
      const [summary] = buildStaffReport(['s1'], [], [], [workShift({ status })], AFTER)
      expect(summary.missedClockIn).toBe(0)
    }
  })

  it('does not count a shift whose type could not be resolved', () => {
    // Mirrors the SQL's INNER JOIN shift_types: with no end time there is no
    // way to know the shift is over, so it must not be reported as missed.
    const [summary] = buildStaffReport(['s1'], [], [], [workShift({ shift_type: null })], AFTER)
    expect(summary.missedClockIn).toBe(0)
  })
})

describe('worked minutes stay honest', () => {
  it('reports unknown rather than crediting an unclosed break as work', () => {
    const attendance = [
      makeAttendance({
        id: 'a1', staff_id: 's1', date: '2026-08-01', status: 'present',
        clock_in: localIso('2026-08-01', '09:00:00'),
        clock_out: localIso('2026-08-01', '18:00:00'),
      }),
    ]
    const openBreak = [
      makeBreak({
        id: 'b1', attendance_id: 'a1', break_number: 1,
        clock_out_time: localIso('2026-08-01', '12:00:00'),
        clock_in_time: null, duration_minutes: null,
      }),
    ]
    const [summary] = buildStaffReport(['s1'], attendance, openBreak, [], AFTER)
    expect(summary.days[0].workedMinutes).toBeNull()
  })

  it('still subtracts a break that was closed', () => {
    const attendance = [
      makeAttendance({
        id: 'a1', staff_id: 's1', date: '2026-08-01', status: 'present',
        clock_in: localIso('2026-08-01', '09:00:00'),
        clock_out: localIso('2026-08-01', '18:00:00'),
      }),
    ]
    const closed = [
      makeBreak({
        id: 'b1', attendance_id: 'a1', break_number: 1,
        clock_out_time: localIso('2026-08-01', '12:00:00'),
        clock_in_time: localIso('2026-08-01', '13:00:00'),
        duration_minutes: 60,
      }),
    ]
    const [summary] = buildStaffReport(['s1'], attendance, closed, [], AFTER)
    expect(summary.days[0].workedMinutes).toBe(480)
  })

  it('clamps a clock_out a few minutes before clock_in instead of inventing a day', () => {
    // Device clock skew, not a night shift: two minutes backwards used to
    // become 1,438 minutes of work.
    const clockIn = localIso('2026-08-01', '09:04:00')
    const clockOut = localIso('2026-08-01', '09:02:00')
    expect(computeWorkedMinutes(clockIn, clockOut, 0)).toBe(0)
  })
})

describe('late minutes agree between the summary and the detail rows', () => {
  it('ignores stale late_minutes left on a row no longer marked late', () => {
    // "Mark all present" upserts without late_minutes, so a formerly-late row
    // keeps its minutes while its status becomes present.
    const attendance = [
      makeAttendance({
        id: 'a1', staff_id: 's1', date: '2026-08-01', status: 'present', late_minutes: 25,
        clock_in: localIso('2026-08-01', '09:55:00'),
      }),
    ]
    const [summary] = buildStaffReport(['s1'], attendance, [], [], AFTER)
    expect(summary.lateMinutes).toBe(0)
    expect(summary.late).toBe(0)
    expect(summary.days[0].lateMinutes).toBe(0)
  })

  it('sums the same minutes the detail rows show', () => {
    const attendance = [
      makeAttendance({ id: 'a1', staff_id: 's1', date: '2026-08-01', status: 'late', late_minutes: 7 }),
      makeAttendance({ id: 'a2', staff_id: 's1', date: '2026-08-02', status: 'late', late_minutes: 12 }),
    ]
    const [summary] = buildStaffReport(['s1'], attendance, [], [], AFTER)
    expect(summary.lateMinutes).toBe(19)
    expect(summary.days.reduce((n, d) => n + d.lateMinutes, 0)).toBe(19)
  })
})
