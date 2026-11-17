import { describe, expect, it } from 'vitest'
import { filterTransactions, mytDateLabel, splitFromNote, txKind, txPaymentLabel, txStatusLabel, txWhere } from './transactions'

const b = (bill_no: string, status: 'paid' | 'voided' | 'merged', refunded_sen = 0, label: string | null = 'T3') => ({
  bill_no, status, refunded_sen, order_type: label ? 'dine_in' as const : 'takeaway' as const,
  dining_tables: label ? { label } : null,
})
const bills = [b('261026-001', 'paid'), b('261026-002', 'paid', 500, null), b('261026-003', 'voided', 0, 'B4'), b('261026-004', 'merged')]

describe('transactions', () => {
  it('where a bill was', () => {
    expect(txWhere(bills[0])).toBe('Table T3')
    expect(txWhere(bills[1])).toBe('Takeaway')
    expect(txWhere({ order_type: 'dine_in', dining_tables: null })).toBe('—')
  })
  it('a refund moves a paid bill to Refunded', () => {
    expect(bills.map(txKind)).toEqual(['paid', 'refunded', 'voided', 'merged'])
    expect(bills.map(txStatusLabel)).toEqual(['Paid', 'Refunded RM 5.00', 'Voided', 'Merged'])
  })
  it('filters, then searches the bill number or the table', () => {
    expect(filterTransactions(bills, 'all', '').length).toBe(4)
    expect(filterTransactions(bills, 'paid', '').map((x) => x.bill_no)).toEqual(['261026-001'])
    expect(filterTransactions(bills, 'refunded', '').map((x) => x.bill_no)).toEqual(['261026-002'])
    expect(filterTransactions(bills, 'all', 'b4').map((x) => x.bill_no)).toEqual(['261026-003'])
    expect(filterTransactions(bills, 'all', ' -004').map((x) => x.bill_no)).toEqual(['261026-004'])
    expect(filterTransactions(bills, 'voided', 'takeaway')).toEqual([])
  })
  it('today\'s date in Malaysia', () => {
    expect(mytDateLabel(Date.parse('2026-10-26T15:59:00Z'))).toBe('26 Oct 2026')
    expect(mytDateLabel(Date.parse('2026-10-26T16:00:00Z'))).toBe('27 Oct 2026')
  })
})

describe('txPaymentLabel and splitFromNote: a bill paid in parts or split from a table bill', () => {
  const pay = { method_name: 'Cash', reference: null, tendered_sen: 5000, change_sen: 2680, part: null }
  it('a payment of a part says which part, before the method', () => {
    expect(txPaymentLabel({ ...pay, part: { partNo: 2, ways: 4 } })).toBe('Part 2 of 4 · Cash · received RM 50.00, change RM 26.80')
    expect(txPaymentLabel({ ...pay, tendered_sen: null, method_name: 'Card', reference: 'A12', part: { partNo: 1, ways: null } }))
      .toBe('Part 1 · Card · A12')
  })
  it('the final payment of the bill is labelled as before', () => {
    expect(txPaymentLabel(pay)).toBe('Cash · received RM 50.00, change RM 26.80')
  })
  it('a part paid by item names its table bill', () => {
    expect(splitFromNote('261117-001')).toBe('Split from bill 261117-001.')
  })
})
