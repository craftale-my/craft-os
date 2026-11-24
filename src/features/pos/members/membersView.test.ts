import { describe, expect, it } from 'vitest'
import { billOrReason, checkAdjust, checkSettings, dateMy, dateTimeMy, searchDigits, signedPoints } from './membersView'

describe('membersView', () => {
  it('dates in Malaysia time', () => {
    expect(dateMy('2026-11-22T17:30:00Z')).toBe('23 Nov 2026')
    expect(dateMy(null)).toBe('—')
    expect(dateTimeMy('2026-11-23T06:05:00Z')).toBe('23 Nov 2026, 14:05')
  })
  it('signed points and the bill / reason cell', () => {
    expect(signedPoints(42)).toBe('+42')
    expect(signedPoints(-5)).toBe('−5')
    expect(billOrReason({ billNo: '261123-001', reason: null })).toBe('261123-001')
    expect(billOrReason({ billNo: null, reason: 'Missed at the counter' })).toBe('Missed at the counter')
    expect(billOrReason({ billNo: null, reason: null })).toBe('—')
  })
  it('search keeps digits only', () => {
    expect(searchDigits('+60 12-345')).toBe('6012345')
  })
  it('adjust: a whole number, not 0, within the limit, and a reason', () => {
    expect(checkAdjust('20', 'Birthday')).toEqual({ points: 20 })
    expect(checkAdjust('20', 'x'.repeat(200))).toEqual({ points: 20 })
    expect(checkAdjust('20', 'x'.repeat(201))).toEqual({ error: 'Keep the reason to 200 characters.' })
    expect(checkAdjust('+20', 'x')).toEqual({ points: 20 })
    expect(checkAdjust('-15', 'x')).toEqual({ points: -15 })
    expect(checkAdjust('−15', 'x')).toEqual({ points: -15 })
    expect(checkAdjust('', 'x')).toEqual({ error: 'Enter a whole number of points, like 20 or -20.' })
    expect(checkAdjust('1.5', 'x')).toEqual({ error: 'Enter a whole number of points, like 20 or -20.' })
    expect(checkAdjust('0', 'x')).toEqual({ error: 'Enter a number of points between -100000 and 100000, not 0.' })
    expect(checkAdjust('100001', 'x')).toEqual({ error: 'Enter a number of points between -100000 and 100000, not 0.' })
    expect(checkAdjust('5', '   ')).toEqual({ error: 'A reason is required.' })
  })
  it('settings: rate 0–100 with two decimals, a whole sign-in code cap 0–100000', () => {
    expect(checkSettings('1', '300')).toEqual({ rate: 1, smsDailyCap: 300 })
    expect(checkSettings('1.1', '0')).toEqual({ rate: 1.1, smsDailyCap: 0 })
    expect(checkSettings('100', '100000')).toEqual({ rate: 100, smsDailyCap: 100000 })
    for (const r of ['', '-1', '101', '1.234', 'x']) expect(checkSettings(r, '300')).toEqual({ error: 'Points per RM 1 must be a number from 0 to 100.' })
    for (const c of ['', '-1', '1.5', '100001']) expect(checkSettings('1', c)).toEqual({ error: 'Sign-in codes per day must be a whole number from 0 to 100000.' })
  })
})
