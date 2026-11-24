import { describe, expect, it } from 'vitest'
import { parseBillSummaries } from './billSummaries'

describe('parseBillSummaries', () => {
  it('keys the rows by bill id, with what the bill\'s parts paid (0 before Part B or with none)', () => {
    const m = parseBillSummaries([
      { bill_id: 'b1', total_sen: 10670, item_count: 4, paid_sen: 2345 },
      { bill_id: 'b2', total_sen: 0, item_count: 0 },
    ])
    expect([...m.values()]).toEqual([
      { billId: 'b1', totalSen: 10670, itemCount: 4, paidSen: 2345 },
      { billId: 'b2', totalSen: 0, itemCount: 0, paidSen: 0 },
    ])
    expect(m.get('b1')?.totalSen).toBe(10670)
  })
  it('an empty branch has no rows', () => {
    expect(parseBillSummaries([]).size).toBe(0)
  })
  it('refuses anything that is not the function\'s shape', () => {
    expect(() => parseBillSummaries(null)).toThrow('Unexpected reply from the server')
    expect(() => parseBillSummaries([{ bill_id: 'b1', total_sen: '10.00', item_count: 1 }])).toThrow('Unexpected reply from the server')
    expect(() => parseBillSummaries([null])).toThrow('Unexpected reply from the server')
  })
})
