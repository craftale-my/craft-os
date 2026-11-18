import { describe, expect, it } from 'vitest'
import { columnsFor, tableCsv } from './columns'

interface Row { name: string | null; day: string; at: string | null; n: number | null; sen: number | null }
const c = columnsFor<Row>()
const cols = [
  c.text('Name', (r) => r.name), c.day('Day', (r) => r.day), c.time('At', (r) => r.at, 'Still open'),
  c.count('N', (r) => r.n), c.money('Sen', (r) => r.sen),
]
const row: Row = { name: 'Latte', day: '2026-01-05', at: '2026-01-05T04:00:00.000Z', n: 3, sen: -80 }
const empty: Row = { name: null, day: '2026-01-06', at: null, n: null, sen: null }

describe('columns', () => {
  it('the screen shows RM, days and Malaysia times; the CSV holds plain values', () => {
    expect(cols.map((x) => x.show(row))).toEqual(['Latte', 'Mon 5 Jan 2026', '5 Jan 2026, 12:00', '3', 'RM -0.80'])
    expect(cols.map((x) => x.csv(row))).toEqual(['Latte', '2026-01-05', '2026-01-05 12:00', 3, '-0.80'])
    expect(cols.map((x) => x.numeric)).toEqual([false, false, false, true, true])
  })
  it('a missing value shows a dash (or the column\'s own words) and leaves the CSV cell empty', () => {
    expect(cols.map((x) => x.show(empty))).toEqual(['—', 'Tue 6 Jan 2026', 'Still open', '—', '—'])
    expect(cols.map((x) => x.csv(empty))).toEqual([null, '2026-01-06', null, null, null])
  })
  it('tableCsv: the labels, then one row per row', () => {
    expect(tableCsv(cols, [row, empty])).toBe('﻿Name,Day,At,N,Sen\r\nLatte,2026-01-05,2026-01-05 12:00,3,-0.80\r\n,2026-01-06,,,\r\n')
  })
})
