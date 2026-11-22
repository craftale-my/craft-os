import { describe, expect, it } from 'vitest'
import { formatPhone, maskPhone, normalisePhone, shortMask } from './memberPhone'
import { MEMBER_PHONE_CASES } from './memberPhoneCases'

describe('normalisePhone (the shared case table, also run by member-auth logic.test.ts)', () => {
  it.each(MEMBER_PHONE_CASES.map(([i, w]) => [i, w] as [string, string | null]))('%j → %s', (input, want) =>
    expect(normalisePhone(input)).toBe(want))
  it('null and undefined', () => {
    expect(normalisePhone(null)).toBeNull()
    expect(normalisePhone(undefined)).toBeNull()
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

describe('shortMask', () => {
  it('the last four digits after two dots (the till)', () => {
    expect(shortMask('+60123456789')).toBe('••6789')
    expect(shortMask('+601100000291')).toBe('••0291')
  })
})
