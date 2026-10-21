import { describe, it, expect } from 'vitest'
import { shouldClearLeaveAttendance, SCHEDULE_LEAVE_OPTIONS, SCHEDULE_LEAVE_LABELS, weekStartOf, otherRestDayInWeek } from './index'

describe('shouldClearLeaveAttendance', () => {
  it('returns false when there is no attendance row', () => {
    expect(shouldClearLeaveAttendance(null)).toBe(false)
    expect(shouldClearLeaveAttendance(undefined)).toBe(false)
  })

  it('returns true for a pristine on_leave row with no clock data', () => {
    expect(shouldClearLeaveAttendance({ status: 'on_leave', clock_in: null })).toBe(true)
  })

  it('returns false when the row has clock-in data', () => {
    expect(shouldClearLeaveAttendance({ status: 'on_leave', clock_in: '2026-07-07T01:00:00Z' })).toBe(false)
  })

  it('returns false for non-leave statuses', () => {
    expect(shouldClearLeaveAttendance({ status: 'present', clock_in: null })).toBe(false)
  })
})

describe('SCHEDULE_LEAVE_OPTIONS', () => {
  it('offers exactly the five schedule-assignable leave types', () => {
    expect(SCHEDULE_LEAVE_OPTIONS.map(o => o.type)).toEqual([
      'medical', 'emergency', 'unpaid', 'maternity', 'public_holiday',
    ])
  })

  it('labels public_holiday as a replacement day', () => {
    expect(SCHEDULE_LEAVE_OPTIONS.find(o => o.type === 'public_holiday')?.label)
      .toBe('Public Holiday Replacement')
  })
})

describe('weekStartOf', () => {
  it('returns the Monday of a Mon–Sun week', () => {
    expect(weekStartOf('2026-10-19')).toBe('2026-10-19') // Monday
    expect(weekStartOf('2026-10-21')).toBe('2026-10-19') // Wednesday
    expect(weekStartOf('2026-10-25')).toBe('2026-10-19') // Sunday belongs to the week before
    expect(weekStartOf('2026-10-26')).toBe('2026-10-26')
  })

  it('crosses month boundaries', () => {
    expect(weekStartOf('2026-11-01')).toBe('2026-10-26')
  })
})

describe('otherRestDayInWeek', () => {
  const rest = (date: string) => ({ date, leave_type: 'rest_day' as const })

  it('allows a rest day when the week has none', () => {
    expect(otherRestDayInWeek([{ date: '2026-10-20', leave_type: 'medical' }], '2026-10-21')).toBeNull()
  })

  it('blocks a second rest day in the same week', () => {
    expect(otherRestDayInWeek([rest('2026-10-20')], '2026-10-25')).toBe('2026-10-20')
  })

  it('ignores the day being edited', () => {
    expect(otherRestDayInWeek([rest('2026-10-21')], '2026-10-21')).toBeNull()
  })

  it('ignores rest days in other weeks', () => {
    expect(otherRestDayInWeek([rest('2026-10-18'), rest('2026-10-26')], '2026-10-21')).toBeNull()
  })

  it('labels the rest day', () => {
    expect(SCHEDULE_LEAVE_LABELS.rest_day).toBe('Rest Day')
  })
})
