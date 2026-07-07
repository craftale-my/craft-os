import { describe, it, expect } from 'vitest'
import { shouldClearLeaveAttendance, SCHEDULE_LEAVE_OPTIONS } from './index'

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
