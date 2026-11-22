import { describe, expect, it } from 'vitest'
import { formatPhone, maskPhone, normalisePhone } from './phone'

describe('normalisePhone (the server rule: migration-2026-11-23-members-verify.sql M2, member-auth logic.test.ts)', () => {
  const cases: [string, string | null][] = [
    ['0123456789', '+60123456789'], ['60123456789', '+60123456789'], ['+60123456789', '+60123456789'],
    ['012-345 6789', '+60123456789'], ['+60 12-345 6789', '+60123456789'], ['123456789', '+60123456789'],
    ['011-2345 6789', '+601123456789'], ['+601123456789', '+601123456789'],
    ['0312345678', null], ['+6531234567', null], ['01234567', null], ['012345678901', null],
    ['abc', null], ['', null],
    ['+60 012-345 6789', '+60123456789'], ['+600123456789', '+60123456789'], ['0060123456789', '+60123456789'],
    ['00600123456789', '+60123456789'], ['01234567890', null], ['0112345678', null], ['011234567890', null],
    ['1123456789', '+601123456789'], ['+60 11-2345 6789', '+601123456789'], ['0060 11 2345 6789', '+601123456789'],
    ['+6000123456789', null], ['0123456789 ', '+60123456789'], ['+60', null], ['0', null],
    // what a guest types after the fixed +60
    ['12-345 6789', '+60123456789'], ['11 0000 0101', '+601100000101'],
  ]
  it.each(cases)('%s → %s', (input, want) => expect(normalisePhone(input)).toBe(want))
  it('null, brackets and dots, and no Unicode spaces (the SQL refuses those)', () => {
    expect(normalisePhone(null)).toBeNull()
    expect(normalisePhone(undefined)).toBeNull()
    expect(normalisePhone('(012) 345.6789')).toBe('+60123456789')
    expect(normalisePhone('012 3456789')).toBeNull()
  })
})

describe('maskPhone / formatPhone', () => {
  it('masks all but the last four digits, like the server', () => {
    expect(maskPhone('+60123456789')).toBe('+60 ••• ••6789')
    expect(maskPhone('+601100000101')).toBe('+60 ••• ••0101')
  })
  it('formats for the "code sent to" line', () => {
    expect(formatPhone('+60123456789')).toBe('+60 12-345 6789')
    expect(formatPhone('+601123456789')).toBe('+60 11-2345 6789')
    expect(formatPhone('nope')).toBe('nope')
  })
})
