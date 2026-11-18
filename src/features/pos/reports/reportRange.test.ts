import { describe, expect, it } from 'vitest'
import {
  MAX_DAYS, PRESETS, TABS, addDays, businessDay, dayCount, daysIn, defaultOutlets, filterParams, isDay,
  presetOf, presetRange, previousRange, rangeProblem, readFilter,
} from './reportRange'

const at = (iso: string) => new Date(iso)
const NOW = at('2026-11-18T03:00:00Z')                                 // Wed 18 Nov 2026, 11:00 in Malaysia

describe('businessDay', () => {
  it('runs from 06:00 to 05:59 the next morning, Malaysia time', () => {
    expect(businessDay(at('2026-01-05T22:00:00Z'))).toBe('2026-01-06')   // 6 Jan 06:00
    expect(businessDay(at('2026-01-05T21:59:59Z'))).toBe('2026-01-05')   // 6 Jan 05:59:59
    expect(businessDay(at('2026-01-05T17:30:00Z'))).toBe('2026-01-05')   // 6 Jan 01:30 counts to 5 Jan
    expect(businessDay(at('2026-01-04T22:00:00Z'))).toBe('2026-01-05')   // 5 Jan 06:00
  })
})

describe('days', () => {
  it('isDay takes real dates only; addDays, dayCount and daysIn count whole days', () => {
    expect(isDay('2026-02-28')).toBe(true)
    expect(isDay('2026-02-30')).toBe(false)
    expect(isDay('2026-1-5')).toBe(false)
    expect(isDay('')).toBe(false)
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(dayCount({ from: '2026-01-05', to: '2026-01-06' })).toBe(2)
    expect(dayCount({ from: '2026-01-01', to: '2027-01-01' })).toBe(366)
    expect(daysIn({ from: '2026-01-30', to: '2026-02-02' })).toEqual(['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02'])
    expect(daysIn({ from: '2026-01-06', to: '2026-01-05' })).toEqual([])
  })
})

describe('presetRange', () => {
  it('Today, Yesterday, This week (Mon–Sun), This month, Last month', () => {
    expect(PRESETS.map((p) => p.label)).toEqual(['Today', 'Yesterday', 'This week', 'This month', 'Last month'])
    expect(presetRange('today', NOW)).toEqual({ from: '2026-11-18', to: '2026-11-18' })
    expect(presetRange('yesterday', NOW)).toEqual({ from: '2026-11-17', to: '2026-11-17' })
    expect(presetRange('this_week', NOW)).toEqual({ from: '2026-11-16', to: '2026-11-22' })
    expect(presetRange('this_month', NOW)).toEqual({ from: '2026-11-01', to: '2026-11-30' })
    expect(presetRange('last_month', NOW)).toEqual({ from: '2026-10-01', to: '2026-10-31' })
  })
  it('before 06:00 it is still the business day before', () => {
    expect(presetRange('today', at('2026-11-17T21:59:00Z'))).toEqual({ from: '2026-11-17', to: '2026-11-17' })
    expect(presetRange('today', at('2026-11-17T22:00:00Z'))).toEqual({ from: '2026-11-18', to: '2026-11-18' })
  })
  it('a Sunday ends its week; January looks back to December; February has 28 days', () => {
    expect(presetRange('this_week', at('2026-11-22T03:00:00Z'))).toEqual({ from: '2026-11-16', to: '2026-11-22' })
    expect(presetRange('last_month', at('2026-01-10T03:00:00Z'))).toEqual({ from: '2025-12-01', to: '2025-12-31' })
    expect(presetRange('this_month', at('2026-02-10T03:00:00Z'))).toEqual({ from: '2026-02-01', to: '2026-02-28' })
  })
})

describe('presetOf', () => {
  it('names the preset a range equals, else custom', () => {
    expect(presetOf({ from: '2026-11-16', to: '2026-11-22' }, NOW)).toBe('this_week')
    expect(presetOf({ from: '2026-10-01', to: '2026-10-31' }, NOW)).toBe('last_month')
    expect(presetOf({ from: '2026-11-02', to: '2026-11-03' }, NOW)).toBe('custom')
  })
})

describe('previousRange', () => {
  it('is the period of the same length just before', () => {
    expect(previousRange({ from: '2026-01-05', to: '2026-01-06' })).toEqual({ from: '2026-01-03', to: '2026-01-04' })
    expect(previousRange({ from: '2026-11-01', to: '2026-11-30' })).toEqual({ from: '2026-10-02', to: '2026-10-31' })
    expect(previousRange({ from: '2026-01-05', to: '2026-01-05' })).toEqual({ from: '2026-01-04', to: '2026-01-04' })
  })
})

describe('rangeProblem', () => {
  it('uses the server\'s words', () => {
    expect(rangeProblem({ from: '2026-01-05', to: '2026-01-06' })).toBeNull()
    expect(rangeProblem({ from: '2026-01-06', to: '2026-01-05' })).toBe('The start date is after the end date.')
    expect(rangeProblem({ from: '2026-01-01', to: '2027-01-01' })).toBeNull()
    expect(rangeProblem({ from: '2026-01-01', to: '2027-01-02' })).toBe(`Choose at most ${MAX_DAYS} days.`)
    expect(rangeProblem({ from: '', to: '2026-01-06' })).toBe('Choose a valid date range.')
    expect(rangeProblem({ from: '2026-02-30', to: '2026-03-01' })).toBe('Choose a valid date range.')
  })
})

describe('the filter in the URL', () => {
  const OUTLETS = [{ id: 'b1', isHome: false }, { id: 'b2', isHome: true }, { id: 'b3', isHome: false }]
  const params = (s: string) => new URLSearchParams(s)

  it('defaults: a manager their home outlet, HQ every outlet, today, Overview', () => {
    expect(readFilter(params(''), OUTLETS, false, NOW)).toEqual({ outlets: ['b2'], from: '2026-11-18', to: '2026-11-18', tab: 'overview' })
    expect(readFilter(params(''), OUTLETS, true, NOW).outlets).toEqual(['b1', 'b2', 'b3'])
    expect(defaultOutlets([{ id: 'x', isHome: false }, { id: 'y', isHome: false }], false)).toEqual(['x'])
    expect(defaultOutlets([], false)).toEqual([])
  })
  it('keeps only the caller\'s outlets, once each; a bad range or tab falls back', () => {
    expect(readFilter(params('outlets=b3,zz,b1,b3&from=2026-01-05&to=2026-01-06&tab=sst'), OUTLETS, false, NOW))
      .toEqual({ outlets: ['b3', 'b1'], from: '2026-01-05', to: '2026-01-06', tab: 'sst' })
    expect(readFilter(params('outlets=zz&from=2026-01-06&to=2026-01-05&tab=nope'), OUTLETS, false, NOW))
      .toEqual({ outlets: ['b2'], from: '2026-11-18', to: '2026-11-18', tab: 'overview' })
  })
  it('writes outlets, from, to and tab, and reads them back', () => {
    const f = { outlets: ['b1', 'b3'], from: '2026-01-05', to: '2026-01-06', tab: 'ledger' as const }
    expect(filterParams(f).toString()).toBe('outlets=b1%2Cb3&from=2026-01-05&to=2026-01-06&tab=ledger')
    expect(readFilter(filterParams(f), OUTLETS, false, NOW)).toEqual(f)
  })
  it('lists the twelve tabs in the spec\'s order', () => {
    expect(TABS.map((t) => t.label)).toEqual([
      'Overview', 'Sales summary', 'Daily sales', 'Hourly sales', 'Products', 'Payments', 'SST', 'Discounts', 'Voids',
      'Refunds', 'Cash drawer', 'Ledger export',
    ])
  })
})
