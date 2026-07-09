import { describe, it, expect } from 'vitest'
import { calcLateness, localDateStr } from './attendance'

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
