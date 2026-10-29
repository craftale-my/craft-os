import { describe, expect, it } from 'vitest'
import { approveProblem, lastSeenText, mytDateTime, normalizeCode, parseLockMinutes, type ApproveDraft } from './devices'

describe('normalizeCode', () => {
  it('accepts the code however it is typed', () => {
    expect(normalizeCode('ABC-DEF')).toBe('ABC-DEF')
    expect(normalizeCode('abc def')).toBe('ABC-DEF')
    expect(normalizeCode(' a b c d e f ')).toBe('ABC-DEF')
    expect(normalizeCode('9XF-FKR')).toBe('9XF-FKR')
  })
  it('refuses wrong lengths and the characters codes never use (I, O, 0, 1)', () => {
    expect(normalizeCode('ABC-DE')).toBeNull()
    expect(normalizeCode('ABC-DEFG')).toBeNull()
    expect(normalizeCode('ABC-DE0')).toBeNull()
    expect(normalizeCode('IBC-DEF')).toBeNull()
    expect(normalizeCode('')).toBeNull()
  })
})

describe('approveProblem', () => {
  const ok: ApproveDraft = { code: 'abc def', branchId: 'b1', kind: 'pos', name: 'Bar iPad', prints: true }
  it('passes a complete form', () => {
    expect(approveProblem(ok, 'ABC-DEF')).toBeNull()
  })
  it("refuses with pos_decide_device_request's words", () => {
    expect(approveProblem({ ...ok, code: 'ABC-DEG' }, 'ABC-DEF')).toBe('The code does not match the tablet')
    expect(approveProblem({ ...ok, branchId: '' }, 'ABC-DEF')).toBe('Choose the outlet')
    expect(approveProblem({ ...ok, name: '  ' }, 'ABC-DEF')).toBe('Enter the device name (up to 40 characters)')
    expect(approveProblem({ ...ok, name: 'x'.repeat(41) }, 'ABC-DEF')).toBe('Enter the device name (up to 40 characters)')
    expect(approveProblem({ ...ok, kind: 'print_agent' }, 'ABC-DEF')).toBe('Only a POS tablet can print and hold the cash drawer')
    expect(approveProblem({ ...ok, kind: 'print_agent', prints: false }, 'ABC-DEF')).toBeNull()
  })
})

describe('lastSeenText', () => {
  const now = new Date('2026-10-29T12:00:00Z')
  it('reads as a short age', () => {
    expect(lastSeenText(null, now)).toBe('Never')
    expect(lastSeenText('2026-10-29T11:59:30Z', now)).toBe('Just now')
    expect(lastSeenText('2026-10-29T11:55:00Z', now)).toBe('5 min ago')
    expect(lastSeenText('2026-10-29T09:00:00Z', now)).toBe('3 h ago')
    expect(lastSeenText('2026-10-28T11:00:00Z', now)).toBe('1 day ago')
    expect(lastSeenText('2026-10-26T12:00:00Z', now)).toBe('3 days ago')
  })
})

describe('mytDateTime', () => {
  it('is Malaysia time', () => {
    expect(mytDateTime('2026-10-29T06:05:00Z')).toBe('29 Oct, 14:05')
  })
})

describe('parseLockMinutes', () => {
  it('a whole number from 1 to 60', () => {
    expect(parseLockMinutes(' 15 ')).toBe(15)
    expect(parseLockMinutes('1')).toBe(1)
    expect(parseLockMinutes('60')).toBe(60)
    expect(parseLockMinutes('0')).toBeNull()
    expect(parseLockMinutes('61')).toBeNull()
    expect(parseLockMinutes('7.5')).toBeNull()
    expect(parseLockMinutes('')).toBeNull()
  })
})
