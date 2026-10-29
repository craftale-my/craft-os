import { describe, expect, it } from 'vitest'
import { closedMessage, malaysiaToday, NO_PIN_NOTE, rosterPeople, shortDate, type RosterOutlet } from './roster'

const outlet = (o: Partial<RosterOutlet>): RosterOutlet => ({
  id: 'b1', name: 'Pop-up Mid Valley', kind: 'popup', opensOn: '2026-11-01', closesOn: '2026-11-30', isActive: true, open: false, ...o,
})

describe('rosterPeople', () => {
  it('greys out a name with no PIN, with the note', () => {
    expect(rosterPeople([{ id: 'a', name: 'Aina', hasPin: true }, { id: 'b', name: 'Ben', hasPin: false }])).toEqual([
      { id: 'a', name: 'Aina', canSignIn: true, note: null },
      { id: 'b', name: 'Ben', canSignIn: false, note: NO_PIN_NOTE },
    ])
  })
})

describe('closedMessage', () => {
  it('is null while the outlet is open', () => {
    expect(closedMessage(outlet({ open: true }), '2026-11-10')).toBeNull()
  })
  it('tells when a pop-up opens', () => {
    expect(closedMessage(outlet({}), '2026-10-30')).toBe('This outlet opens on 1 Nov.')
  })
  it('tells when a pop-up closed', () => {
    expect(closedMessage(outlet({}), '2026-12-02')).toBe('This outlet closed on 30 Nov.')
  })
  it('says closed for an outlet switched off', () => {
    expect(closedMessage(outlet({ kind: 'branch', isActive: false, opensOn: null, closesOn: null }), '2026-11-10')).toBe('This outlet is closed.')
  })
})

describe('dates', () => {
  it('adds the year only when it is not this year', () => {
    expect(shortDate('2026-11-30', '2026-10-30')).toBe('30 Nov')
    expect(shortDate('2027-01-05', '2026-12-30')).toBe('5 Jan 2027')
  })
  it('takes today in Malaysia, not UTC', () => {
    expect(malaysiaToday(new Date('2026-10-30T17:30:00Z'))).toBe('2026-10-31')
    expect(malaysiaToday(new Date('2026-10-30T15:30:00Z'))).toBe('2026-10-30')
  })
})
