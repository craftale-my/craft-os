import { describe, expect, it } from 'vitest'
import { billActions, itemActions } from './billActions'

const table = { isTable: true, hasBill: true, loaded: true, liveSentCount: 2, draftCount: 0, qrPaused: false, qrRequiresOpenBill: false, billDiscount: false }

describe('billActions', () => {
  it('a table bill with items: Move, Discount bill, Void bill, Pax, Pause QR', () => {
    expect(billActions(table)).toEqual(['move', 'discount_bill', 'void_bill', 'pax', 'pause_qr'])
  })
  it('drafts add Send first; a bill with nothing live offers Close empty bill instead of Void bill', () => {
    expect(billActions({ ...table, draftCount: 2, liveSentCount: 0 })).toEqual(['send', 'move', 'close_empty', 'pax', 'pause_qr'])
  })
  it('neither void nor close before the items are loaded', () => {
    expect(billActions({ ...table, loaded: false })).toEqual(['move', 'pax', 'pause_qr'])
  })
  it('an empty table: Pax and the QR switches; Open for QR only when QR waits for an open bill', () => {
    const empty = { ...table, hasBill: false, liveSentCount: 0, qrPaused: true }
    expect(billActions(empty)).toEqual(['pax', 'resume_qr'])
    expect(billActions({ ...empty, qrRequiresOpenBill: true })).toEqual(['pax', 'resume_qr', 'open_qr'])
  })
  it('a takeaway bill: Move, Discount bill and Void bill only', () => {
    expect(billActions({ ...table, isTable: false })).toEqual(['move', 'discount_bill', 'void_bill'])
    expect(billActions({ ...table, isTable: false, hasBill: false, draftCount: 1 })).toEqual(['send'])
  })
  it('a bill with a discount offers Edit and Remove instead; Remove stays even when nothing is live', () => {
    expect(billActions({ ...table, billDiscount: true })).toEqual(['move', 'edit_bill_discount', 'remove_bill_discount', 'void_bill', 'pax', 'pause_qr'])
    expect(billActions({ ...table, billDiscount: true, liveSentCount: 0 })).toEqual(['move', 'edit_bill_discount', 'remove_bill_discount', 'close_empty', 'pax', 'pause_qr'])
  })
})

describe('itemActions', () => {
  it('Discount item and Void item; a discounted item offers Edit and Remove', () => {
    expect(itemActions({ discounted: false })).toEqual(['discount_item', 'void_item'])
    expect(itemActions({ discounted: true })).toEqual(['edit_item_discount', 'remove_item_discount', 'void_item'])
  })
})
