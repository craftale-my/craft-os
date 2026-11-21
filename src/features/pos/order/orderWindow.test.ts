import { describe, expect, it } from 'vitest'
import {
  hhmm, lastOrderMessage, minutesOf, myMinuteOfDay, orderWindowProblem, ordersOpen, padPastLastOrder, pastLastOrder,
  qrClosedMessage, SAME_TIMES, SET_BOTH, WINDOW_HELP,
} from './orderWindow'

const at = (iso: string) => new Date(iso)   // written with +08:00: Malaysia time as it reads

describe('the ordering window (W7 spec §3)', () => {
  it('reads HH:MM', () => {
    expect(minutesOf('21:30')).toBe(1290)
    expect(minutesOf('00:00')).toBe(0)
    expect(minutesOf('9:00')).toBeNull()
    expect(minutesOf('24:00')).toBeNull()
    expect(minutesOf(null)).toBeNull()
  })
  it('the minute of the day in Malaysia, whatever the device\'s own zone', () => {
    expect(myMinuteOfDay(at('2026-01-05T21:30:59+08:00'))).toBe(1290)
    expect(myMinuteOfDay(at('2026-01-05T16:00:00Z'))).toBe(0)
    expect(myMinuteOfDay(at('2026-01-05T15:59:00Z'))).toBe(1439)
  })
  it('no times: always open', () => {
    expect(ordersOpen(null, null, at('2026-01-05T03:00:00+08:00'))).toBe(true)
  })
  it('09:00–21:30: from the 09:00 minute to the end of the 21:30 minute', () => {
    const cases: [string, boolean][] = [
      ['2026-01-05T08:59:59+08:00', false], ['2026-01-05T09:00:00+08:00', true],
      ['2026-01-05T21:30:59+08:00', true], ['2026-01-05T21:31:00+08:00', false],
    ]
    for (const [iso, want] of cases) expect(ordersOpen('09:00', '21:30', at(iso)), iso).toBe(want)
  })
  it('09:00–02:00 runs past midnight', () => {
    const cases: [string, boolean][] = [
      ['2026-01-05T23:30:00+08:00', true], ['2026-01-06T01:59:00+08:00', true], ['2026-01-06T02:00:30+08:00', true],
      ['2026-01-06T02:01:00+08:00', false], ['2026-01-06T08:59:00+08:00', false], ['2026-01-06T09:00:00+08:00', true],
    ]
    for (const [iso, want] of cases) expect(ordersOpen('09:00', '02:00', at(iso)), iso).toBe(want)
  })
  it('the words', () => {
    expect(lastOrderMessage('09:00', '21:30')).toBe('Last orders were at 21:30. Ordering opens again at 09:00.')
    expect(pastLastOrder('21:30')).toBe('Past last order (21:30)')
    expect(WINDOW_HELP).toBe('QR ordering stops outside these times. Staff can still order on the POS.')
    expect(SET_BOTH).toBe('Set both times or neither.')
    expect(SAME_TIMES).toBe('Orders open at and Last order at must be different times.')
  })
  it('the QR page\'s sentence and the pad\'s banner: outside the window only', () => {
    const late = at('2026-01-05T22:00:00+08:00')
    const noon = at('2026-01-05T12:00:00+08:00')
    expect(qrClosedMessage('09:00', '21:30', late)).toBe('Last orders were at 21:30. Ordering opens again at 09:00.')
    expect(qrClosedMessage('09:00', '21:30', noon)).toBeNull()
    expect(qrClosedMessage(null, null, late)).toBeNull()
    expect(padPastLastOrder('09:00', '21:30', late)).toBe('Past last order (21:30)')
    expect(padPastLastOrder('09:00', '21:30', noon)).toBeNull()
    expect(padPastLastOrder(null, null, late)).toBeNull()
  })
  it('the settings check: both or neither, not the same time', () => {
    expect(orderWindowProblem(null, null)).toBeNull()
    expect(orderWindowProblem('09:00', null)).toBe('Set both times or neither.')
    expect(orderWindowProblem(null, '21:30')).toBe('Set both times or neither.')
    expect(orderWindowProblem('10:00', '10:00')).toBe('Orders open at and Last order at must be different times.')
    expect(orderWindowProblem('09:00', '02:00')).toBeNull()
  })
  it('a Postgres time as HH:MM', () => {
    expect(hhmm('09:00:00')).toBe('09:00')
    expect(hhmm('21:30')).toBe('21:30')
    expect(hhmm(null)).toBeNull()
  })
})
