import { describe, expect, it } from 'vitest'
import { areaTabs, currentArea, elapsedLabel, visibleTables } from './home'
import type { OpenBillRow, TableRow } from './posApi'

const t = (id: string, label: string, area: string | null, sort_order: number): TableRow =>
  ({ id, label, area, sort_order, qr_token: 'x', qr_paused: false, is_active: true })
const bill = (id: string, table_id: string | null): OpenBillRow =>
  ({ id, bill_no: `261026-${id}`, table_id, order_type: table_id ? 'dine_in' : 'takeaway', pax: 2, opened_at: '2026-10-26T02:00:00Z', discount_kind: null, discount_value: null, discount_reason: null })

const tables = [
  t('a1', 'A1', 'Indoor', 1), t('a2', 'A2', 'Indoor', 2), t('b1', 'B1', 'Patio', 3),
  t('c1', 'C1', null, 4), t('z1', 'Z1', 'Bar', 0),
]

describe('areaTabs', () => {
  it('All first, then areas in table order, each counting its tables with an open bill', () => {
    const tabs = areaTabs(tables, [bill('1', 'a2'), bill('2', 'c1'), bill('3', null), bill('4', 'b1')])
    expect(tabs).toEqual([
      { area: null, label: 'All', openCount: 3 },
      { area: 'Bar', label: 'Bar', openCount: 0 },
      { area: 'Indoor', label: 'Indoor', openCount: 1 },
      { area: 'Patio', label: 'Patio', openCount: 1 },
    ])
  })
  it('ties on sort order go by area name; no areas = All only', () => {
    expect(areaTabs([t('x', 'X', 'Zeta', 1), t('y', 'Y', 'Alpha', 1)], []).map((a) => a.label)).toEqual(['All', 'Alpha', 'Zeta'])
    expect(areaTabs([t('c1', 'C1', null, 1)], [])).toEqual([{ area: null, label: 'All', openCount: 0 }])
  })
})

describe('currentArea', () => {
  it('keeps a tab that exists and falls back to All otherwise', () => {
    const tabs = areaTabs(tables, [])
    expect(currentArea(tabs, 'Patio')).toBe('Patio')
    expect(currentArea(tabs, 'Garden')).toBeNull()
  })
})

describe('visibleTables', () => {
  it('All shows every table; an area shows only its own', () => {
    expect(visibleTables(tables, null, '').map((x) => x.label)).toEqual(['A1', 'A2', 'B1', 'C1', 'Z1'])
    expect(visibleTables(tables, 'Indoor', '').map((x) => x.label)).toEqual(['A1', 'A2'])
  })
  it('a search looks at every label in any case, whatever the tab', () => {
    expect(visibleTables(tables, 'Indoor', ' b ').map((x) => x.label)).toEqual(['B1'])
  })
})

describe('elapsedLabel', () => {
  const opened = '2026-10-26T02:00:00Z'
  const at = (min: number) => Date.parse(opened) + min * 60_000
  it('minutes under an hour, hours and two-digit minutes from an hour', () => {
    expect(elapsedLabel(opened, at(0))).toBe('0m')
    expect(elapsedLabel(opened, at(12) + 59_000)).toBe('12m')
    expect(elapsedLabel(opened, at(59))).toBe('59m')
    expect(elapsedLabel(opened, at(65))).toBe('1h 05m')
    expect(elapsedLabel(opened, at(120))).toBe('2h 00m')
  })
  it('a clock a little behind the server never shows a negative time', () => {
    expect(elapsedLabel(opened, at(-2))).toBe('0m')
  })
})
