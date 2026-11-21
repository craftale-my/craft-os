import { describe, expect, it } from 'vitest'
import { callNoMatches, takeawayLabel } from './callNo'

describe('call numbers on screen (W4 spec §2)', () => {
  it('a takeaway label', () => {
    expect(takeawayLabel('TA012')).toBe('TA012 · Takeaway')
    expect(takeawayLabel(null)).toBe('Takeaway')
    expect(takeawayLabel(undefined)).toBe('Takeaway')
  })
  it('"TA12", "ta012", "12" and " TA 012 " find TA012', () => {
    for (const q of ['TA12', 'ta012', '12', ' TA 012 ', 'TA012', '012', 'ta']) expect(callNoMatches('TA012', q), q).toBe(true)
  })
  it('another number, another prefix, an empty search or no number: no match', () => {
    expect(callNoMatches('TA012', '13')).toBe(false)
    expect(callNoMatches('TA012', 'P12')).toBe(false)
    expect(callNoMatches('TA012', '  ')).toBe(false)
    expect(callNoMatches(null, '12')).toBe(false)
  })
})
