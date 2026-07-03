import { describe, it, expect } from 'vitest'
import { computeBreakOvertime } from './index'

describe('computeBreakOvertime', () => {
  it('reports no overtime when actual equals allowed', () => {
    const out = '2026-07-03T04:00:00.000Z'
    const back = '2026-07-03T05:00:00.000Z' // exactly 60 min
    const r = computeBreakOvertime(out, back, 60)
    expect(r.durationMinutes).toBe(60)
    expect(r.overtimeMinutes).toBe(0)
    expect(r.isOvertime).toBe(false)
  })

  it('reports overtime when actual exceeds allowed', () => {
    const out = '2026-07-03T04:00:00.000Z'
    const back = '2026-07-03T05:05:00.000Z' // 65 min
    const r = computeBreakOvertime(out, back, 60)
    expect(r.durationMinutes).toBe(65)
    expect(r.overtimeMinutes).toBe(5)
    expect(r.isOvertime).toBe(true)
  })

  it('reports no overtime when actual is under allowed', () => {
    const out = '2026-07-03T04:00:00.000Z'
    const back = '2026-07-03T04:30:00.000Z' // 30 min
    const r = computeBreakOvertime(out, back, 60)
    expect(r.durationMinutes).toBe(30)
    expect(r.overtimeMinutes).toBe(0)
    expect(r.isOvertime).toBe(false)
  })

  it('rounds duration to the nearest minute', () => {
    const out = '2026-07-03T04:00:00.000Z'
    const back = '2026-07-03T04:00:40.000Z' // 40s -> rounds to 1 min
    const r = computeBreakOvertime(out, back, 0)
    expect(r.durationMinutes).toBe(1)
    expect(r.overtimeMinutes).toBe(1) // allowed 0 -> 1 over
    expect(r.isOvertime).toBe(true)
  })
})
