import { describe, expect, it } from 'vitest'
import { BILL_ACTION_LABEL, PART_PAID_FIRST, billActionNotes, billActions, itemActionNotes, itemActions } from './billActions'
import { SPLIT_ACTION_LABEL, SPLIT_OFFLINE } from './splitSelection'

const table = { isTable: true, hasBill: true, loaded: true, liveSentCount: 2, draftCount: 0, qrPaused: false, qrRequiresOpenBill: false, billDiscount: false }

describe('billActions', () => {
  it('a table bill with items: Move, Split / Move items, Discount bill, Void bill, Pax, Pause QR', () => {
    expect(billActions(table)).toEqual(['move', 'split', 'discount_bill', 'void_bill', 'pax', 'pause_qr'])
  })
  it('one live unit: nothing to split', () => {
    expect(billActions({ ...table, liveSentCount: 1 })).toEqual(['move', 'discount_bill', 'void_bill', 'pax', 'pause_qr'])
  })
  it('drafts add Send first; a bill with nothing live offers Close empty bill instead of Void bill', () => {
    expect(billActions({ ...table, draftCount: 2, liveSentCount: 0 })).toEqual(['send', 'move', 'close_empty', 'pax', 'pause_qr'])
  })
  it('neither split, void nor close before the items are loaded', () => {
    expect(billActions({ ...table, loaded: false })).toEqual(['move', 'pax', 'pause_qr'])
  })
  it('an empty table: Pax and the QR switches; Open for QR only when QR waits for an open bill', () => {
    const empty = { ...table, hasBill: false, liveSentCount: 0, qrPaused: true }
    expect(billActions(empty)).toEqual(['pax', 'resume_qr'])
    expect(billActions({ ...empty, qrRequiresOpenBill: true })).toEqual(['pax', 'resume_qr', 'open_qr'])
  })
  it('a takeaway bill: Move, Split / Move items, Discount bill and Void bill', () => {
    expect(billActions({ ...table, isTable: false })).toEqual(['move', 'split', 'discount_bill', 'void_bill'])
    expect(billActions({ ...table, isTable: false, hasBill: false, draftCount: 1 })).toEqual(['send'])
  })
  it('a bill with a discount offers Edit and Remove instead; Remove stays even when nothing is live', () => {
    expect(billActions({ ...table, billDiscount: true })).toEqual(['move', 'split', 'edit_bill_discount', 'remove_bill_discount', 'void_bill', 'pax', 'pause_qr'])
    expect(billActions({ ...table, billDiscount: true, liveSentCount: 0 })).toEqual(['move', 'edit_bill_discount', 'remove_bill_discount', 'close_empty', 'pax', 'pause_qr'])
  })
  it('the split action reads Split / Move items', () => {
    expect(BILL_ACTION_LABEL.split).toBe('Split / Move items')
    expect(BILL_ACTION_LABEL.split).toBe(SPLIT_ACTION_LABEL)
  })
})

describe('billActionNotes', () => {
  it('nothing is off online on a bill with no part paid', () => {
    expect(billActionNotes({ online: true, partPaid: false })).toEqual({})
  })
  it('offline: Split / Move items needs a connection', () => {
    expect(billActionNotes({ online: false, partPaid: false })).toEqual({ split: SPLIT_OFFLINE })
  })
  it('a part paid: split, discount (set or edit) and void bill are off with the server\'s words; Remove discount and Move stay', () => {
    expect(PART_PAID_FIRST).toBe('This bill has a part payment. Pay the rest first.')
    const notes = billActionNotes({ online: true, partPaid: true })
    expect(notes).toEqual({ split: PART_PAID_FIRST, discount_bill: PART_PAID_FIRST, edit_bill_discount: PART_PAID_FIRST, void_bill: PART_PAID_FIRST })
    expect(notes.remove_bill_discount).toBeUndefined()
    expect(notes.move).toBeUndefined()
  })
  it('a part paid and offline: the part note wins for split', () => {
    expect(billActionNotes({ online: false, partPaid: true }).split).toBe(PART_PAID_FIRST)
  })
})

describe('itemActions', () => {
  it('Discount item and Void item; a discounted item offers Edit and Remove', () => {
    expect(itemActions({ discounted: false })).toEqual(['discount_item', 'void_item'])
    expect(itemActions({ discounted: true })).toEqual(['edit_item_discount', 'remove_item_discount', 'void_item'])
  })
})

describe('itemActionNotes', () => {
  it('no part paid: nothing is off', () => {
    expect(itemActionNotes({ partPaid: false })).toEqual({})
  })
  it('a part paid: discount (set or edit) and void item are off with the server\'s words; Remove discount stays', () => {
    expect(itemActionNotes({ partPaid: true })).toEqual({ discount_item: PART_PAID_FIRST, edit_item_discount: PART_PAID_FIRST, void_item: PART_PAID_FIRST })
  })
})
