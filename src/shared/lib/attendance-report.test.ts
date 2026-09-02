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

  it('marks missedClockIn true when a work shift is scheduled but there is no clock_in', () => {
    const shifts = [
      makeShift({ id: 'sh1', staff_id: 's1', date: '2026-08-01', shift_type_id: 'st1' }),
    ]
    const [summary] = buildStaffReport(['s1'], [], [], shifts)
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
    const [summary] = buildStaffReport(['s1'], attendance, [], shifts)
    expect(summary.missedClockIn).toBe(0)
    expect(summary.days[0].missedClockIn).toBe(false)
    expect(summary.days[0].leaveType).toBe('annual')
  })

  it('does not count missedClockIn when a work shift was clocked in', () => {
    const shifts = [
      makeShift({ id: 'sh1', staff_id: 's1', date: '2026-08-01', shift_type_id: 'st1' }),
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
      makeShift({ id: 'sh1', staff_id: 's2', date: '2026-08-02', shift_type_id: 'st1' }),
    ]
    const [s1, s2] = buildStaffReport(['s1', 's2'], attendance, breaks, shifts)

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
