import { describe, expect, it } from 'vitest'
import {
  average, barPercents, changeText, dailySeries, dayLabel, dayShort, discountValueText, hourLabel, rangeText,
  rateLabel, reportTime, discountCsvValue, signedSen,
} from './reportView'

describe('signedSen and discountCsvValue', () => {
  it('a negative amount reads -RM 0.80; zero and positive as formatSen', () => {
    expect(signedSen(-80)).toBe('-RM 0.80')
    expect(signedSen(0)).toBe('RM 0.00')
    expect(signedSen(9560)).toBe('RM 95.60')
  })
  it('the CSV value of a discount: ringgit for an amount, the percent number for a percent', () => {
    expect(discountCsvValue('amount', 200)).toBe('2.00')
    expect(discountCsvValue('percent', 1000)).toBe(10)
    expect(discountCsvValue('percent', 1250)).toBe(12.5)
    expect(discountCsvValue(null, null)).toBeNull()
    expect(discountCsvValue('amount', null)).toBeNull()
  })
})

describe('changeText', () => {
  it('against the previous period: +12%, -10%, 0%, — when the previous period is 0', () => {
    expect(changeText(10200, 1060)).toBe('+862%')
    expect(changeText(90, 100)).toBe('-10%')
    expect(changeText(100, 100)).toBe('0%')
    expect(changeText(5, 0)).toBe('—')
    expect(changeText(0, 0)).toBe('—')
  })
})

describe('numbers and words', () => {
  it('average rounds to the sen and is 0 with nothing to share', () => {
    expect(average(10200, 7)).toBe(1457)
    expect(average(1260, 2)).toBe(630)
    expect(average(0, 0)).toBe(0)
  })
  it('rates and discount values', () => {
    expect(rateLabel(600)).toBe('6%')
    expect(rateLabel(650)).toBe('6.5%')
    expect(rateLabel(0)).toBe('0%')
    expect(discountValueText('percent', 1000)).toBe('10%')
    expect(discountValueText('amount', 200)).toBe('RM 2.00')
    expect(discountValueText(null, null)).toBe('—')
  })
  it('days, times and hours in Malaysia time', () => {
    expect(dayLabel('2026-01-05')).toBe('Mon 5 Jan 2026')
    expect(dayShort('2026-01-05')).toBe('Mon 5 Jan')
    expect(reportTime('2026-01-05T17:30:00.000Z')).toBe('6 Jan 2026, 01:30')
    expect(hourLabel(9)).toBe('09:00–09:59')
    expect(rangeText({ from: '2026-01-05', to: '2026-01-05' })).toBe('Mon 5 Jan 2026')
    expect(rangeText({ from: '2026-01-05', to: '2026-01-06' })).toBe('Mon 5 Jan 2026 – Tue 6 Jan 2026')
  })
})

describe('bars', () => {
  it('dailySeries: every day of the range, outlets of one day added up, empty days 0', () => {
    expect(dailySeries([{ day: '2026-01-05', nettSen: 100 }, { day: '2026-01-05', nettSen: 50 }, { day: '2026-01-07', nettSen: 10 }],
      { from: '2026-01-05', to: '2026-01-07' }))
      .toEqual([{ day: '2026-01-05', nettSen: 150 }, { day: '2026-01-06', nettSen: 0 }, { day: '2026-01-07', nettSen: 10 }])
  })
  it('barPercents: against the largest, one decimal, never below 0', () => {
    expect(barPercents([3950, 6250])).toEqual([63.2, 100])
    expect(barPercents([0, 0])).toEqual([0, 0])
    expect(barPercents([-5, 10])).toEqual([0, 100])
    expect(barPercents([])).toEqual([])
  })
})
