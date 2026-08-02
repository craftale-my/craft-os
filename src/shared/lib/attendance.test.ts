import { describe, it, expect } from 'vitest'
import {
  calcLateness,
  isOvernightShift,
  localDateStr,
  prevDateStr,
  resolveAttendanceDate,
  shiftDurationHours,
} from './attendance'

const NIGHT = { start_time: '17:00:00', end_time: '01:00:00' }
const DAY = { start_time: '09:30:00', end_time: '18:00:00' }

// Build ISO strings in LOCAL time so tests are timezone-independent.
const localIso = (dateStr: string, time: string) => new Date(`${dateStr}T${time}`).toISOString()

describe('calcLateness', () => {
  it('is not late when clocking in exactly on time', () => {
    const r = calcLateness(localIso('2026-07-08', '09:30:00'), '2026-07-08', '09:30:00')
    expect(r).toEqual({ isLate: false, lateMinutes: 0 })
  })

  it('is not late when early', () => {
    const r = calcLateness(localIso('2026-07-08', '09:15:00'), '2026-07-08', '09:30:00')
    expect(r).toEqual({ isLate: false, lateMinutes: 0 })
  })

  it('rounds a 30-second lateness up to 1 minute', () => {
    const r = calcLateness(localIso('2026-07-08', '09:30:30'), '2026-07-08', '09:30:00')
    expect(r).toEqual({ isLate: true, lateMinutes: 1 })
  })

  it('reports 12 minutes when 12 minutes late', () => {
    const r = calcLateness(localIso('2026-07-08', '09:42:00'), '2026-07-08', '09:30:00')
    expect(r).toEqual({ isLate: true, lateMinutes: 12 })
  })

  it('handles HH:MM start times (no seconds part)', () => {
    const r = calcLateness(localIso('2026-07-08', '09:31:00'), '2026-07-08', '09:30')
    expect(r).toEqual({ isLate: true, lateMinutes: 1 })
  })
})

describe('localDateStr', () => {
  it('returns the local calendar date', () => {
    expect(localDateStr(new Date(2026, 6, 8, 12, 0, 0))).toBe('2026-07-08')
  })

  it('stays on the local date just after local midnight (UTC would say yesterday)', () => {
    expect(localDateStr(new Date(2026, 6, 8, 0, 30, 0))).toBe('2026-07-08')
  })

  it('pads single-digit months and days', () => {
    expect(localDateStr(new Date(2026, 0, 5, 9, 0, 0))).toBe('2026-01-05')
  })
})

describe('prevDateStr', () => {
  it('steps back one day', () => {
    expect(prevDateStr('2026-07-31')).toBe('2026-07-30')
  })

  it('crosses a month boundary', () => {
    expect(prevDateStr('2026-08-01')).toBe('2026-07-31')
  })

  it('crosses a year boundary', () => {
    expect(prevDateStr('2026-01-01')).toBe('2025-12-31')
  })
})

describe('isOvernightShift', () => {
  it('flags a shift that ends past midnight', () => {
    expect(isOvernightShift(NIGHT)).toBe(true)
  })

  it('does not flag a same-day shift', () => {
    expect(isOvernightShift(DAY)).toBe(false)
  })

  it('tolerates HH:MM times without seconds', () => {
    expect(isOvernightShift({ start_time: '22:00', end_time: '06:00' })).toBe(true)
    expect(isOvernightShift({ start_time: '09:00', end_time: '17:00' })).toBe(false)
  })
})

describe('shiftDurationHours', () => {
  it('measures a normal day shift, minus its breaks', () => {
    expect(shiftDurationHours({ ...DAY, break1_duration_minutes: 60 })).toBe(7.5)
  })

  // The bug: a plain end-minus-start made 17:00–01:00 come out as -16.75h, so a
  // night worker's upcoming-hours total was a large negative number.
  it('measures an overnight shift as a positive span', () => {
    expect(shiftDurationHours({ ...NIGHT, break1_duration_minutes: 45 })).toBe(7.25)
  })

  it('measures a 10pm–6am shift with no break', () => {
    expect(shiftDurationHours({ start_time: '22:00:00', end_time: '06:00:00' })).toBe(8)
  })

  it('adds both breaks together', () => {
    expect(shiftDurationHours({ ...NIGHT, break1_duration_minutes: 30, break2_duration_minutes: 15 })).toBe(7.25)
  })

  it('treats missing break fields as no break', () => {
    expect(shiftDurationHours(NIGHT)).toBe(8)
    expect(shiftDurationHours({ ...NIGHT, break1_duration_minutes: null })).toBe(8)
  })

  it('never returns a negative span for any overnight pairing', () => {
    for (const [start, end] of [['17:00:00', '01:00:00'], ['23:30:00', '07:30:00'], ['20:00:00', '04:00:00']]) {
      expect(shiftDurationHours({ start_time: start, end_time: end })).toBeGreaterThan(0)
    }
  })
})

describe('resolveAttendanceDate', () => {
  // The bug: a 5pm–1am night shift clocked in on 31 Jul. At 1:05am the wall
  // clock says 1 Aug, but the open session — and so the clock-out — still
  // belongs to 31 Jul.
  it('stays on the previous day while an overnight shift is still open', () => {
    const now = new Date(2026, 7, 1, 1, 5, 0)
    expect(resolveAttendanceDate({ now, prevShift: NIGHT, prevOpen: true })).toBe('2026-07-31')
  })

  it('stays on the previous day between midnight and the shift end', () => {
    const now = new Date(2026, 7, 1, 0, 30, 0)
    expect(resolveAttendanceDate({ now, prevShift: NIGHT, prevOpen: true })).toBe('2026-07-31')
  })

  it('rolls over once the grace window after the shift end has passed', () => {
    const now = new Date(2026, 7, 1, 6, 0, 0)
    expect(resolveAttendanceDate({ now, prevShift: NIGHT, prevOpen: true })).toBe('2026-08-01')
  })

  it('rolls over as normal when yesterday was already clocked out', () => {
    const now = new Date(2026, 7, 1, 1, 5, 0)
    expect(resolveAttendanceDate({ now, prevShift: NIGHT, prevOpen: false })).toBe('2026-08-01')
  })

  it('rolls over as normal when yesterday was a day shift left open', () => {
    const now = new Date(2026, 7, 1, 1, 5, 0)
    expect(resolveAttendanceDate({ now, prevShift: DAY, prevOpen: true })).toBe('2026-08-01')
  })

  it('rolls over as normal when yesterday had no shift', () => {
    const now = new Date(2026, 7, 1, 1, 5, 0)
    expect(resolveAttendanceDate({ now, prevShift: null, prevOpen: true })).toBe('2026-08-01')
  })

  it('is unaffected during the evening half of a night shift', () => {
    const now = new Date(2026, 6, 31, 23, 50, 0)
    expect(resolveAttendanceDate({ now, prevShift: NIGHT, prevOpen: false })).toBe('2026-07-31')
  })

  it('does not hijack the day when the previous night shift is long over', () => {
    // Same night shift pattern every day: at 5pm on 1 Aug the staff member is
    // starting a NEW shift, even if 31 Jul was never clocked out.
    const now = new Date(2026, 7, 1, 17, 0, 0)
    expect(resolveAttendanceDate({ now, prevShift: NIGHT, prevOpen: true })).toBe('2026-08-01')
  })
})
