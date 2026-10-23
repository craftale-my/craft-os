import { describe, it, expect } from 'vitest'
import {
  DEFAULT_WRITTEN_EXPLANATION_THRESHOLD_MINUTES,
  LATE_REASON_MAX_LENGTH,
  isLateReasonComplete,
  requiresWrittenExplanation,
} from './lateReason'

const T = DEFAULT_WRITTEN_EXPLANATION_THRESHOLD_MINUTES

describe('requiresWrittenExplanation', () => {
  it('does not ask for writing at the threshold itself', () => {
    expect(requiresWrittenExplanation(15, T)).toBe(false)
  })

  it('asks for writing one minute past the threshold', () => {
    expect(requiresWrittenExplanation(16, T)).toBe(true)
  })

  it('defaults to 15 minutes when no threshold is configured', () => {
    expect(T).toBe(15)
  })
})

describe('isLateReasonComplete', () => {
  it('is incomplete with no reason code at all', () => {
    expect(isLateReasonComplete({ code: null, note: '', lateMinutes: 5, thresholdMinutes: T })).toBe(false)
  })

  it('is complete with just a code under the threshold', () => {
    expect(isLateReasonComplete({ code: 'traffic', note: '', lateMinutes: 5, thresholdMinutes: T })).toBe(true)
  })

  it('is incomplete over the threshold when nothing is typed', () => {
    expect(isLateReasonComplete({ code: 'traffic', note: '   ', lateMinutes: 40, thresholdMinutes: T })).toBe(false)
  })

  it('is complete over the threshold once something is typed', () => {
    expect(isLateReasonComplete({ code: 'traffic', note: 'Accident on the LDP', lateMinutes: 40, thresholdMinutes: T })).toBe(true)
  })

  // attendance_late_reason_length_check enforces this in the database; a
  // reason that is otherwise "complete" (code chosen, non-blank note) must
  // still be rejected here once it is too long to ever be written.
  it('is complete with a note exactly at the character limit', () => {
    const note = 'a'.repeat(LATE_REASON_MAX_LENGTH)
    expect(isLateReasonComplete({ code: 'traffic', note, lateMinutes: 40, thresholdMinutes: T })).toBe(true)
  })

  it('is incomplete once the note exceeds the character limit', () => {
    const note = 'a'.repeat(LATE_REASON_MAX_LENGTH + 1)
    expect(isLateReasonComplete({ code: 'traffic', note, lateMinutes: 40, thresholdMinutes: T })).toBe(false)
  })
})

describe('LATE_REASON_MAX_LENGTH', () => {
  it('mirrors attendance_late_reason_length_check (500 chars)', () => {
    expect(LATE_REASON_MAX_LENGTH).toBe(500)
  })
})
