import { describe, expect, it } from 'vitest'
import {
  billNoExample, draftFromOutlet, mytDay, outletDates, outletNote, parseOutletDraft, pickOutlet, shortDay,
  type Outlet, type OutletDraft,
} from './outlet'

const draft = (over: Partial<OutletDraft> = {}): OutletDraft => ({ ...draftFromOutlet(null), name: 'Mid Valley', ...over })
const outlet = (over: Partial<Outlet> = {}): Outlet => ({
  id: 'o1', name: 'Cheras', kind: 'branch', opensOn: null, closesOn: null, billPrefix: null,
  isActive: true, isHome: false, openNow: true, ...over,
})

describe('parseOutletDraft', () => {
  it('trims the name and upper-cases the prefix', () => {
    expect(parseOutletDraft(draft({ name: '  Mid Valley ', billPrefix: ' mv ' }))).toEqual({
      ok: true, value: { id: null, name: 'Mid Valley', kind: 'branch', opensOn: null, closesOn: null, billPrefix: 'MV' },
    })
  })
  it('an empty prefix is none', () => {
    expect(parseOutletDraft(draft({ billPrefix: '  ' }))).toMatchObject({ ok: true, value: { billPrefix: null } })
  })
  it("refuses with save_outlet's words", () => {
    expect(parseOutletDraft(draft({ name: ' ' }))).toEqual({ ok: false, problem: 'Enter the outlet name' })
    expect(parseOutletDraft(draft({ name: 'x'.repeat(61) }))).toEqual({ ok: false, problem: 'The outlet name is longer than 60 characters' })
    expect(parseOutletDraft(draft({ billPrefix: 'ABCDE' }))).toEqual({ ok: false, problem: 'The bill prefix is 1 to 4 letters or digits' })
    expect(parseOutletDraft(draft({ billPrefix: 'P-1' }))).toEqual({ ok: false, problem: 'The bill prefix is 1 to 4 letters or digits' })
  })
  it('a pop-up needs both days, in order', () => {
    expect(parseOutletDraft(draft({ kind: 'popup', opensOn: '2026-12-01' }))).toEqual({ ok: false, problem: 'A pop-up needs its first and last day' })
    expect(parseOutletDraft(draft({ kind: 'popup', opensOn: '2026-12-02', closesOn: '2026-12-01' })))
      .toEqual({ ok: false, problem: 'The last day is before the first day' })
    expect(parseOutletDraft(draft({ kind: 'popup', opensOn: '2026-12-01', closesOn: '2026-12-01' })))
      .toMatchObject({ ok: true, value: { opensOn: '2026-12-01', closesOn: '2026-12-01' } })
  })
  it('a branch or kiosk keeps no dates', () => {
    expect(parseOutletDraft(draft({ kind: 'kiosk', opensOn: '2026-12-01', closesOn: '2026-11-01' })))
      .toMatchObject({ ok: true, value: { kind: 'kiosk', opensOn: null, closesOn: null } })
  })
})

describe('dates', () => {
  it('mytDay is the Malaysia day (UTC+8)', () => {
    expect(mytDay(new Date('2026-10-28T15:59:59Z'))).toBe('2026-10-28')
    expect(mytDay(new Date('2026-10-28T16:00:00Z'))).toBe('2026-10-29')
  })
  it('billNoExample matches pos_next_bill_no', () => {
    expect(billNoExample('PJ', new Date('2026-10-28T16:30:00Z'))).toBe('PJ-261029-001')
    expect(billNoExample(null, new Date('2026-10-28T16:30:00Z'))).toBe('261029-001')
  })
  it('shortDay and outletDates', () => {
    expect(shortDay('2026-11-30')).toBe('30 Nov')
    expect(outletDates(outlet({ kind: 'popup', opensOn: '2026-12-01', closesOn: '2026-12-31' }))).toBe('1 Dec – 31 Dec')
    expect(outletDates(outlet())).toBe('')
  })
})

describe('outletNote', () => {
  const pop = outlet({ kind: 'popup', opensOn: '2026-12-01', closesOn: '2026-12-31' })
  it('a pop-up before, during and after its days', () => {
    expect(outletNote(pop, '2026-11-30')).toBe('Opens on 1 Dec')
    expect(outletNote(pop, '2026-12-01')).toBeNull()
    expect(outletNote(pop, '2026-12-31')).toBeNull()
    expect(outletNote(pop, '2027-01-01')).toBe('Closed on 31 Dec')
  })
  it('an inactive outlet; a branch is always open', () => {
    expect(outletNote(outlet({ isActive: false }), '2026-12-01')).toBe('Inactive')
    expect(outletNote(outlet(), '2026-12-01')).toBeNull()
  })
})

describe('pickOutlet', () => {
  const list = [outlet({ id: 'a' }), outlet({ id: 'h', isHome: true }), outlet({ id: 'c' })]
  it('the one asked for, else home, else the first', () => {
    expect(pickOutlet(list, 'c')?.id).toBe('c')
    expect(pickOutlet(list, 'gone')?.id).toBe('h')
    expect(pickOutlet(list, null)?.id).toBe('h')
    expect(pickOutlet([outlet({ id: 'a' })], null)?.id).toBe('a')
    expect(pickOutlet([], 'a')).toBeNull()
  })
})
