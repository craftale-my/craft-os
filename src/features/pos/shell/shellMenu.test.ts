import { describe, expect, it } from 'vitest'
import { menuItems, mytClock } from './shellMenu'

describe('menuItems', () => {
  it('everything for a manager', () => {
    expect(menuItems({ manageMenu: true, supervise: true, settings: true })).toEqual(['order', 'menu', 'transaction', 'report', 'setting'])
  })
  it('a cashier sees Order and Transaction only', () => {
    expect(menuItems({ manageMenu: false, supervise: false, settings: false })).toEqual(['order', 'transaction'])
  })
  it('a supervisor without settings gets Report but not Setting', () => {
    expect(menuItems({ manageMenu: false, supervise: true, settings: false })).toEqual(['order', 'transaction', 'report'])
  })
})

describe('mytClock', () => {
  it('is Malaysia time, 24-hour, two digits', () => {
    expect(mytClock(Date.parse('2026-10-26T01:05:00Z'))).toBe('09:05')
    expect(mytClock(Date.parse('2026-10-26T15:59:59Z'))).toBe('23:59')
    expect(mytClock(Date.parse('2026-10-26T16:00:00Z'))).toBe('00:00')
  })
})
