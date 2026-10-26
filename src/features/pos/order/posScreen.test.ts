import { describe, expect, it } from 'vitest'
import { onSession, payOutcome, retarget, SENT_BILL_CLOSED, SENT_BILL_NOT_LOADED, type Screen } from './posScreen'
import { QUEUED_NOT_SENT } from './billView'
import type { OpenBillRow } from './posApi'

const bill = (id: string, table_id: string | null): OpenBillRow =>
  ({ id, bill_no: `261026-${id}`, table_id, order_type: table_id ? 'dine_in' : 'takeaway', pax: null, opened_at: '2026-10-26T02:00:00Z' })
const line = { productId: 'p1', variantId: 'v1', qty: 2, note: null, optionIds: [] }
const onT1: Screen = { kind: 'order', session: 4, target: { kind: 'table', tableId: 't1', pax: null }, lines: [line], catalogId: 'c1' }

describe('onSession', () => {
  it('only the order screen of that session', () => {
    expect(onSession(onT1, 4)).toBe(true)
    expect(onSession(onT1, 3)).toBe(false)
    expect(onSession({ kind: 'home' }, 4)).toBe(false)
  })
})

describe('retarget', () => {
  it('the pax chosen for an empty table keeps the screen and its lines', () => {
    const r = retarget(onT1, 4, { kind: 'table', tableId: 't1', pax: 3 })
    expect(r).toEqual({ screen: { ...onT1, target: { kind: 'table', tableId: 't1', pax: 3 } }, restarted: false })
  })
  it('a move or merge onto another bill restarts the screen there without lines or catalog', () => {
    expect(retarget(onT1, 4, { kind: 'takeaway', billId: 'b9' }))
      .toEqual({ screen: { kind: 'order', session: 4, target: { kind: 'takeaway', billId: 'b9' } }, restarted: true })
  })
  it('a late call from a screen that is gone changes nothing', () => {
    const home: Screen = { kind: 'home' }
    expect(retarget(home, 4, { kind: 'table', tableId: 't2', pax: null })).toEqual({ screen: home, restarted: false })
    expect(retarget(onT1, 3, { kind: 'table', tableId: 't2', pax: null })).toEqual({ screen: onT1, restarted: false })
  })
})

describe('payOutcome', () => {
  const t1 = { kind: 'table' as const, tableId: 't1', pax: 2 }
  it('the order reached a bill that is open: Payment on it, back to the table', () => {
    expect(payOutcome('b1', [bill('b1', 't1')], t1)).toEqual({ kind: 'payment', bill: bill('b1', 't1'), back: t1 })
  })
  it('a new takeaway goes back to the bill it opened', () => {
    expect(payOutcome('b2', [bill('b2', null)], { kind: 'takeaway', billId: null }))
      .toEqual({ kind: 'payment', bill: bill('b2', null), back: { kind: 'takeaway', billId: 'b2' } })
  })
  it('no bill yet (still queued, or the lookup failed offline): home with the queued notice', () => {
    expect(payOutcome(null, null, t1)).toEqual({ kind: 'home', notice: QUEUED_NOT_SENT })
  })
  it('the bills could not be read, or the bill closed meanwhile: home, never Payment', () => {
    expect(payOutcome('b1', null, t1)).toEqual({ kind: 'home', notice: SENT_BILL_NOT_LOADED })
    expect(payOutcome('b1', [bill('b3', 't3')], t1)).toEqual({ kind: 'home', notice: SENT_BILL_CLOSED })
  })
})
