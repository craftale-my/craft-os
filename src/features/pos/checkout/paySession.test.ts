import { describe, expect, it } from 'vitest'
import { CHECKED_OPEN, UNSURE, checkoutIds, linesLocked, newPaySession, nextPay, type PayEvent, type PaySession } from './paySession'

const run = (s: PaySession, ...events: PayEvent[]) => events.reduce(nextPay, s)
const start = newPaySession('id-1')

describe('nextPay — payment attempts of one checkout', () => {
  it('a refusal goes back to editing with the same id', () => {
    expect(run(start, { type: 'send' }, { type: 'refused' })).toEqual({ phase: 'editing', checkoutId: 'id-1', earlierIds: [] })
  })
  it('no reply locks the lines; Try again sends the same id', () => {
    const unsure = run(start, { type: 'send' }, { type: 'noReply' })
    expect(unsure).toEqual({ phase: 'unsure', checkoutId: 'id-1', earlierIds: [] })
    expect(linesLocked(unsure)).toBe(true)
    expect(run(unsure, { type: 'send' })).toEqual({ phase: 'paying', checkoutId: 'id-1', earlierIds: [] })
  })
  it('Check bill finding the bill open unlocks the lines with a new id', () => {
    const open = run(start, { type: 'send' }, { type: 'noReply' }, { type: 'check' }, { type: 'checkedOpen', newCheckoutId: 'id-2' })
    expect(open).toEqual({ phase: 'editing', checkoutId: 'id-2', earlierIds: ['id-1'] })
    expect(linesLocked(open)).toBe(false)
  })
  it('Check bill that does not find the bill open stays unsure, same id', () => {
    expect(run(start, { type: 'send' }, { type: 'noReply' }, { type: 'check' }, { type: 'checkEnded' }))
      .toEqual({ phase: 'unsure', checkoutId: 'id-1', earlierIds: [] })
  })
  it('keeps every id it used, so a late first payment still shows as paid by this sheet', () => {
    const twice = run(start,
      { type: 'send' }, { type: 'noReply' }, { type: 'check' }, { type: 'checkedOpen', newCheckoutId: 'id-2' },
      { type: 'send' }, { type: 'noReply' }, { type: 'check' }, { type: 'checkedOpen', newCheckoutId: 'id-3' })
    expect(checkoutIds(twice)).toEqual(['id-1', 'id-2', 'id-3'])
    expect(checkoutIds(start)).toEqual(['id-1'])
  })
  it('ignores events that do not fit (a double tap, a late reply)', () => {
    const paying = run(start, { type: 'send' })
    expect(run(paying, { type: 'send' })).toBe(paying)
    expect(run(start, { type: 'check' })).toBe(start)
    expect(run(start, { type: 'checkedOpen', newCheckoutId: 'id-9' })).toBe(start)
    expect(run(start, { type: 'noReply' })).toBe(start)
    expect(linesLocked(paying)).toBe(true)
    expect(linesLocked(start)).toBe(false)
  })
  it('a reopened sheet starts with the ids an earlier sheet of the bill used', () => {
    const reopened = newPaySession('id-3', ['id-1', 'id-2'])
    expect(reopened).toEqual({ phase: 'editing', checkoutId: 'id-3', earlierIds: ['id-1', 'id-2'] })
    expect(checkoutIds(reopened)).toEqual(['id-1', 'id-2', 'id-3'])
    expect(checkoutIds(run(reopened, { type: 'send' }, { type: 'noReply' }, { type: 'check' }, { type: 'checkedOpen', newCheckoutId: 'id-4' })))
      .toEqual(['id-1', 'id-2', 'id-3', 'id-4'])
  })
  it('says what happened in the words of the design', () => {
    expect(UNSURE.startsWith('Not sure the payment went through')).toBe(true)
    expect(CHECKED_OPEN).toBe('The bill is still open — the payment was not recorded. Check the lines and press Pay.')
  })
})
