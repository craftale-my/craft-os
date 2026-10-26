import { describe, expect, it } from 'vitest'
import { billTitle, shownPax, takesNewItems, targetBill, targetKey, targetOrderType, targetTitle } from './orderTarget'
import type { OpenBillRow } from './posApi'

const bill = (id: string, table_id: string | null, pax: number | null = null): OpenBillRow =>
  ({ id, bill_no: `261026-${id}`, table_id, order_type: table_id ? 'dine_in' : 'takeaway', pax, opened_at: '2026-10-26T02:00:00Z' })
const bills = [bill('001', 't1', 4), bill('002', null)]
const tables = [{ id: 't1', label: 'T1' }, { id: 't2', label: 'T2' }]

describe('order targets', () => {
  it('a table is dine-in on its open bill; a takeaway on its own bill', () => {
    expect(targetOrderType({ kind: 'table', tableId: 't1', pax: null })).toBe('dine_in')
    expect(targetOrderType({ kind: 'takeaway', billId: null })).toBe('takeaway')
    expect(targetBill({ kind: 'table', tableId: 't1', pax: null }, bills)?.id).toBe('001')
    expect(targetBill({ kind: 'table', tableId: 't2', pax: 2 }, bills)).toBeNull()
    expect(targetBill({ kind: 'takeaway', billId: '002' }, bills)?.id).toBe('002')
    expect(targetBill({ kind: 'takeaway', billId: 'gone' }, bills)).toBeNull()
    expect(targetBill({ kind: 'takeaway', billId: null }, bills)).toBeNull()
  })
  it('only an open takeaway bill refuses new items', () => {
    expect(takesNewItems({ kind: 'table', tableId: 't1', pax: null })).toBe(true)
    expect(takesNewItems({ kind: 'takeaway', billId: null })).toBe(true)
    expect(takesNewItems({ kind: 'takeaway', billId: '002' })).toBe(false)
  })
  it('pax: the bill\'s, else the one chosen for an empty table', () => {
    expect(shownPax({ kind: 'table', tableId: 't1', pax: 2 }, bills[0])).toBe(4)
    expect(shownPax({ kind: 'table', tableId: 't2', pax: 2 }, null)).toBe(2)
    expect(shownPax({ kind: 'takeaway', billId: '002' }, bills[1])).toBeNull()
  })
  it('titles', () => {
    expect(billTitle('t1', '261026-001', tables)).toBe('Table T1')
    expect(billTitle('gone', null, tables)).toBe('Table ?')
    expect(billTitle(null, '261026-002', tables)).toBe('Takeaway 261026-002')
    expect(targetTitle({ kind: 'takeaway', billId: null }, null, tables)).toBe('New takeaway')
    expect(targetTitle({ kind: 'table', tableId: 't2', pax: 3 }, null, tables)).toBe('Table T2')
  })
  it('a key per table or takeaway bill: the pax chosen does not change it, a move or merge does', () => {
    expect(targetKey({ kind: 'table', tableId: 't1', pax: null })).toBe(targetKey({ kind: 'table', tableId: 't1', pax: 3 }))
    expect(targetKey({ kind: 'table', tableId: 't1', pax: null })).not.toBe(targetKey({ kind: 'table', tableId: 't2', pax: null }))
    expect(targetKey({ kind: 'takeaway', billId: '002' })).not.toBe(targetKey({ kind: 'takeaway', billId: '003' }))
    expect(targetKey({ kind: 'takeaway', billId: null })).not.toBe(targetKey({ kind: 'takeaway', billId: '002' }))
    expect(targetKey({ kind: 'table', tableId: '002', pax: null })).not.toBe(targetKey({ kind: 'takeaway', billId: '002' }))
  })
})
