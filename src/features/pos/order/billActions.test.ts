import { describe, expect, it } from 'vitest'
import { billActions } from './billActions'

const table = { isTable: true, hasBill: true, loaded: true, liveSentCount: 2, draftCount: 0, qrPaused: false, qrRequiresOpenBill: false }

describe('billActions', () => {
  it('a table bill with items: Move, Void bill, Pax, Pause QR', () => {
    expect(billActions(table)).toEqual(['move', 'void_bill', 'pax', 'pause_qr'])
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
  it('a takeaway bill: Move and Void bill only', () => {
    expect(billActions({ ...table, isTable: false })).toEqual(['move', 'void_bill'])
    expect(billActions({ ...table, isTable: false, hasBill: false, draftCount: 1 })).toEqual(['send'])
  })
})
