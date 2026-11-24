import { describe, it, expect } from 'vitest'
import { newQueuedOrder } from '../offline/orderQueue'
import { padFromRejected } from './rejectedOrder'

const line = { productId: 'p1', variantId: 'v1', qty: 2, note: null, optionIds: [] }

describe('padFromRejected', () => {
  it('reopens a table order with its lines, guests and catalog', () => {
    expect(padFromRejected(newQueuedOrder('dine_in', 't-5', 3, [line], 1, 'a', 'c-staff'))).toEqual({
      target: { kind: 'table', tableId: 't-5', pax: 3 }, lines: [line], catalogId: 'c-staff',
    })
  })

  it('a table order sent without guests reopens with none', () => {
    expect(padFromRejected(newQueuedOrder('dine_in', 't-5', null, [line], 1, 'a', 'c-staff')).target)
      .toEqual({ kind: 'table', tableId: 't-5', pax: null })
  })

  it('reopens a takeaway as a new takeaway; an order queued before catalogs has none', () => {
    const { catalogId: _drop, ...legacy } = newQueuedOrder('takeaway', null, null, [line], 1, 'b')
    void _drop
    expect(padFromRejected(legacy)).toEqual({ target: { kind: 'takeaway', billId: null }, lines: [line], catalogId: null })
  })
})
