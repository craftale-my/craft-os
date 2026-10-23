import { describe, it, expect } from 'vitest'
import { mytDayStartIso, refundChoices, refundDoneNote, refundableSen } from './todayBills'

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

describe('refundChoices', () => {
  const tng = { methodId: 'm-tng', methodName: "Touch 'n Go", leftSen: 2000 }
  const cash = { methodId: 'm-cash', methodName: 'Cash', leftSen: 2290 }

  it('offers each method the bill was paid with, up to what it has left, in payment order', () => {
    expect(refundChoices([tng, cash], 4290)).toEqual([
      { methodId: 'm-tng', maxSen: 2000, label: "Touch 'n Go · up to RM 20.00" },
      { methodId: 'm-cash', maxSen: 2290, label: 'Cash · up to RM 22.90' },
    ])
  })
  it('drops a method with nothing left', () => {
    expect(refundChoices([{ ...tng, leftSen: 0 }, cash], 2290).map((c) => c.methodId)).toEqual(['m-cash'])
  })
  it('never offers more than is left on the whole bill', () => {
    expect(refundChoices([tng, cash], 1500)).toEqual([
      { methodId: 'm-tng', maxSen: 1500, label: "Touch 'n Go · up to RM 15.00" },
      { methodId: 'm-cash', maxSen: 1500, label: 'Cash · up to RM 15.00' },
    ])
  })
  it('is empty when nothing is left to refund', () => {
    expect(refundChoices([tng, cash], 0)).toEqual([])
    expect(refundChoices([{ ...tng, leftSen: 0 }], 4290)).toEqual([])
    expect(refundChoices([], 4290)).toEqual([])
  })
})
