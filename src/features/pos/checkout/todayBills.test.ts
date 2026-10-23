import { describe, it, expect } from 'vitest'
import { mytDayStartIso, refundDoneNote, refundableSen } from './todayBills'

describe('mytDayStartIso', () => {
  it('is midnight Malaysia time, i.e. 16:00 UTC the day before', () => {
    expect(mytDayStartIso(Date.parse('2026-10-23T15:59:00Z'))).toBe('2026-10-22T16:00:00.000Z')
    expect(mytDayStartIso(Date.parse('2026-10-23T16:00:00Z'))).toBe('2026-10-23T16:00:00.000Z')
    expect(mytDayStartIso(Date.parse('2026-10-24T03:00:00Z'))).toBe('2026-10-23T16:00:00.000Z')
  })
})

describe('refundableSen', () => {
  it('is the total less what was refunded, on paid bills only', () => {
    expect(refundableSen({ status: 'paid', total_sen: 9280, refunded_sen: 1300 })).toBe(7980)
    expect(refundableSen({ status: 'paid', total_sen: 9280, refunded_sen: 9280 })).toBe(0)
    expect(refundableSen({ status: 'voided', total_sen: null, refunded_sen: 0 })).toBe(0)
  })
})

describe('refundDoneNote', () => {
  it('reports the amount the server recorded', () => {
    expect(refundDoneNote({ amountSen: 500, slipQueued: true }, '261024-007')).toBe('Refunded RM 5.00 on 261024-007')
  })
  it('says when no refund slip was printed', () => {
    expect(refundDoneNote({ amountSen: 1300, slipQueued: false }, '261024-007'))
      .toBe('Refunded RM 13.00 on 261024-007 — no refund slip printed (no receipt printer set)')
  })
})
