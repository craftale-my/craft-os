import { describe, it, expect } from 'vitest'
import {
  DEFAULT_WRITTEN_EXPLANATION_THRESHOLD_MINUTES,
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
})
