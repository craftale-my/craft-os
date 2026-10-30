import { describe, expect, it } from 'vitest'
import { moveTargets, TAKEAWAY_NEEDS_OCCUPIED } from './moveTargets'
import type { OpenBillRow, TableRow } from './posApi'

const t = (id: string): TableRow => ({ id, label: id.toUpperCase(), area: null, sort_order: 0, qr_token: 'x', qr_paused: false, is_active: true })
const bill = (id: string, table_id: string | null): OpenBillRow =>
  ({ id, bill_no: `B-${id}`, table_id, order_type: table_id ? 'dine_in' : 'takeaway', pax: null, opened_at: '2026-10-26T02:00:00Z', discount_kind: null, discount_value: null, discount_reason: null })
const tables = [t('t1'), t('t2'), t('t3')]
const bills = [bill('b1', 't1'), bill('b3', 't3'), bill('bt', null)]
const summaries = new Map([['b3', { billId: 'b3', totalSen: 10670, itemCount: 3 }]])

describe('moveTargets', () => {
  it('from a table bill: empty tables move, occupied tables merge; its own table is not listed', () => {
    expect(moveTargets(bills[0], tables, bills, summaries)).toEqual([
      { tableId: 't2', label: 'T2', kind: 'move' },
      { tableId: 't3', label: 'T3', kind: 'merge', intoBillId: 'b3', intoBillNo: 'B-b3', totalSen: 10670 },
    ])
  })
  it('from a takeaway bill: only occupied tables, by merging; empty ones are refused with the reason', () => {
    expect(moveTargets(bills[2], tables, bills, summaries)).toEqual([
      { tableId: 't1', label: 'T1', kind: 'merge', intoBillId: 'b1', intoBillNo: 'B-b1', totalSen: null },
      { tableId: 't2', label: 'T2', kind: 'refused', reason: TAKEAWAY_NEEDS_OCCUPIED },
      { tableId: 't3', label: 'T3', kind: 'merge', intoBillId: 'b3', intoBillNo: 'B-b3', totalSen: 10670 },
    ])
  })
  it('from a takeaway bill: another open takeaway bill is also a merge target (existing behaviour)', () => {
    const two = [...bills, bill('bt2', null)]
    const sums = new Map([['bt2', { billId: 'bt2', totalSen: 500, itemCount: 1 }]])
    const targets = moveTargets(two[2], tables, two, sums)
    expect(targets.slice(3)).toEqual([
      { tableId: null, label: 'Takeaway B-bt2', kind: 'merge', intoBillId: 'bt2', intoBillNo: 'B-bt2', totalSen: 500 },
    ])
    expect(targets.some((x) => x.kind === 'merge' && x.intoBillId === 'bt')).toBe(false)
  })
  it('from a table bill: a takeaway bill is never offered as a target', () => {
    const two = [...bills, bill('bt2', null)]
    expect(moveTargets(two[0], tables, two, summaries).every((x) => x.tableId !== null)).toBe(true)
    expect(moveTargets(two[0], tables, two, summaries)).toHaveLength(2)
  })
})
