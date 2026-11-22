import { describe, it, expect } from 'vitest'
import {
  normaliseUsageRow, normaliseUsageSummary, sortUsageRows, formatPct, formatPeriod, sinceLabel,
  signedMoney, plural, partialPeriodNote,
} from './stockUsage'
import { money } from './procurement'

const row = (name: string, unexplained: number, sold: number) => ({
  item_id: name, item_name: name, base_unit: 'g', sold_base: 0, sold_value: sold,
  wasted_base: 0, wasted_value: 0, unexplained_base: 0, unexplained_value: unexplained, unexplained_pct: null,
  period_start: '2026-11-21T18:32:00Z', counted: true,
})

describe('normaliseUsageRow', () => {
  it('turns numeric strings into numbers and keeps null pct', () => {
    const r = normaliseUsageRow({ ...row('a', 0, 0), sold_value: '19.00', unexplained_value: '-2.5', unexplained_pct: null } as never)
    expect(r.sold_value).toBe(19)
    expect(r.unexplained_value).toBe(-2.5)
    expect(r.unexplained_pct).toBeNull()
    expect(r.counted).toBe(true)
    expect(r.period_start).toBe('2026-11-21T18:32:00Z')
  })
  it('keeps counted=false', () => {
    expect(normaliseUsageRow({ ...row('a', 0, 0), counted: false, unexplained_pct: '5' } as never).counted).toBe(false)
  })
})

describe('normaliseUsageSummary', () => {
  it('numbers the counts and keeps flags', () => {
    const s = normaliseUsageSummary({
      period_start: 'a', period_end: 'b', from_previous: true, bills_paid: '3', lines_without_recipe: '1',
      depletion_errors: '0', sold_value: '10', wasted_value: '1', unexplained_value: '-2', rows_without_cost: '4', capped: true,
    } as never)
    expect(s.bills_paid).toBe(3)
    expect(s.rows_without_cost).toBe(4)
    expect(s.capped).toBe(true)
  })
  it('defaults missing new fields', () => {
    const s = normaliseUsageSummary({ period_start: 'a', period_end: 'b' } as never)
    expect(s.rows_without_cost).toBe(0)
    expect(s.capped).toBe(false)
  })
})

describe('sortUsageRows', () => {
  it('puts the biggest unexplained loss first, then most sold, then name', () => {
    const out = sortUsageRows([row('b', -1, 5), row('a', -9, 1), row('c', 0, 50), row('d', -1, 9)])
    expect(out.map(r => r.item_name)).toEqual(['a', 'd', 'b', 'c'])
  })
})

describe('formatPct', () => {
  it('shows one decimal or a dash', () => {
    expect(formatPct(10.526)).toBe('10.5%')
    expect(formatPct(null)).toBe('—')
  })
})

describe('formatPeriod', () => {
  it('formats both ends in Malaysia time', () => {
    expect(formatPeriod('2026-11-21T18:32:00Z', '2026-11-30T15:10:00Z')).toBe('22 Nov 02:32 → 30 Nov 23:10')
  })
})

describe('sinceLabel', () => {
  const summaryStart = '2026-11-21T18:32:00Z'
  it('is null when the item shares the summary window', () => {
    expect(sinceLabel('2026-11-21T18:32:00Z', summaryStart)).toBeNull()
    expect(sinceLabel('2026-11-21T18:32:00.000+00:00', summaryStart)).toBeNull()
  })
  it('names the item start in Malaysia time when it differs', () => {
    expect(sinceLabel('2026-11-10T01:05:00Z', summaryStart)).toBe('since 10 Nov 09:05')
  })
})

describe('signedMoney', () => {
  it('signs a loss and a gain, neutral at zero', () => {
    expect(signedMoney(-2, money)).toEqual({ text: `−${money(2)}`, tone: 'loss' })
    expect(signedMoney(1.5, money)).toEqual({ text: `+${money(1.5)}`, tone: 'gain' })
    expect(signedMoney(0, money)).toEqual({ text: money(0), tone: 'zero' })
  })
})

describe('plural', () => {
  it('uses the singular for one', () => {
    expect(plural(1, 'bill')).toBe('1 bill')
    expect(plural(0, 'bill')).toBe('0 bills')
    expect(plural(38, 'order line')).toBe('38 order lines')
  })
})

describe('partialPeriodNote', () => {
  it('is null for a full period', () => {
    expect(partialPeriodNote({ partial_period: false, depletion_started_at: '2026-11-01T00:00:00Z' })).toBeNull()
  })
  it('says deduction has not started when there is no start', () => {
    expect(partialPeriodNote({ partial_period: true, depletion_started_at: null }))
      .toBe('Sales deduction has not started at this branch yet')
  })
  it('names the start in Malaysia time', () => {
    expect(partialPeriodNote({ partial_period: true, depletion_started_at: '2026-11-22T18:32:00Z' }))
      .toBe("Sales deduction started 23 Nov 02:32 — sales before that are not included, so this period's unexplained figure is overstated.")
  })
})

describe('normaliseUsageSummary partial period', () => {
  it('keeps the start and flag, defaults when missing', () => {
    const s = normaliseUsageSummary({ period_start: 'a', period_end: 'b', partial_period: true, depletion_started_at: 'x' } as never)
    expect(s.partial_period).toBe(true)
    expect(s.depletion_started_at).toBe('x')
    const d = normaliseUsageSummary({ period_start: 'a', period_end: 'b' } as never)
    expect(d.partial_period).toBe(false)
    expect(d.depletion_started_at).toBeNull()
  })
})
