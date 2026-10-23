import { describe, expect, it } from 'vitest'
import {
  availableAt, daysLabel, malaysiaClock, notAvailableNow, parseHm, slotLabel, windowLabel, windowOpen, windowProblem,
  type SlotWindow,
} from './timeSlots'
import vectors from './slotVectors.json'

interface Vector { name: string; days: number[]; start: string; end: string; at: string; open: boolean }
const all = vectors as Vector[]

describe('windowOpen — shared vectors (same instants as the SQL verify script)', () => {
  it('has the vectors the design asks for', () => {
    expect(all).toHaveLength(19)
    expect(all.filter((v) => v.end < v.start).length).toBeGreaterThanOrEqual(8)   // midnight crossings
  })
  for (const v of all) {
    it(v.name, () => {
      expect(windowOpen({ days: v.days, start: v.start, end: v.end }, malaysiaClock(new Date(v.at)))).toBe(v.open)
    })
  }
})

describe('malaysiaClock', () => {
  it('is UTC + 8 hours, Monday = 1 and Sunday = 7, seconds dropped', () => {
    expect(malaysiaClock(new Date('2026-10-25T16:30:59Z'))).toEqual({ isoDay: 1, minute: 30 })   // Mon 00:30
    expect(malaysiaClock(new Date('2026-10-25T04:00:00Z'))).toEqual({ isoDay: 7, minute: 720 })  // Sun 12:00
    expect(malaysiaClock(new Date('2026-10-24T15:59:00Z'))).toEqual({ isoDay: 6, minute: 1439 }) // Sat 23:59
  })
})

describe('parseHm', () => {
  it('reads HH:MM from 00:00 to 23:59 only', () => {
    expect(parseHm('00:00')).toBe(0)
    expect(parseHm('08:05')).toBe(485)
    expect(parseHm('23:59')).toBe(1439)
    for (const bad of ['24:00', '8:00', '08:60', '08:00:00', '', 'noon']) expect(parseHm(bad)).toBeNull()
  })
})

describe('availableAt and slotLabel', () => {
  const breakfast: SlotWindow = { days: [1, 2, 3, 4, 5], start: '08:00', end: '11:30' }
  const dinner: SlotWindow = { days: [1, 2, 3, 4, 5], start: '18:00', end: '21:00' }
  const mon = (hm: string) => new Date(`2026-10-26T${hm}:00+08:00`)
  it('no windows: always available', () => {
    expect(availableAt([], mon('03:00'))).toBe(true)
    expect(slotLabel([], mon('03:00'))).toBeNull()
  })
  it('any window open makes the product available', () => {
    expect(availableAt([breakfast, dinner], mon('09:00'))).toBe(true)
    expect(availableAt([breakfast, dinner], mon('19:00'))).toBe(true)
    expect(availableAt([breakfast, dinner], mon('14:00'))).toBe(false)
  })
  it('names the next window that opens later today', () => {
    expect(slotLabel([dinner, breakfast], mon('07:00'))).toBe('Available 08:00–11:30')
    expect(slotLabel([breakfast, dinner], mon('14:00'))).toBe('Available 18:00–21:00')
    expect(slotLabel([breakfast, dinner], mon('22:00'))).toBe('Not available now')
    expect(slotLabel([breakfast], new Date('2026-10-24T09:00:00+08:00'))).toBe('Not available now')   // Saturday
    expect(slotLabel([breakfast], mon('09:00'))).toBeNull()
  })
  it('uses the server words', () => {
    expect(notAvailableNow('Big Breakfast')).toBe('Big Breakfast is not available at this time')
  })
})

describe('labels and problems', () => {
  it('names days like Feedme', () => {
    expect(daysLabel([1, 2, 3, 4, 5, 6, 7])).toBe('Daily')
    expect(daysLabel([5, 1, 2, 3, 4])).toBe('Mon–Fri')
    expect(daysLabel([6, 7])).toBe('Sat, Sun')
    expect(daysLabel([1, 3, 4, 5])).toBe('Mon, Wed–Fri')
    expect(daysLabel([])).toBe('No days')
  })
  it('marks a window that crosses midnight', () => {
    expect(windowLabel({ days: [5, 6], start: '22:00', end: '02:00' })).toBe('Fri, Sat · 22:00–02:00 (next day)')
    expect(windowLabel({ days: [1, 2, 3, 4, 5, 6, 7], start: '10:00', end: '23:59' })).toBe('Daily · 10:00–23:59')
  })
  it('gives the server words for a bad window', () => {
    expect(windowProblem({ days: [], start: '08:00', end: '09:00' })).toBe('Pick at least one day for each time window')
    expect(windowProblem({ days: [1], start: '', end: '09:00' })).toBe('Enter each time as HH:MM, e.g. 08:00')
    expect(windowProblem({ days: [1], start: '09:00', end: '09:00' })).toBe('A time window cannot start and end at the same time')
    expect(windowProblem({ days: [1], start: '22:00', end: '02:00' })).toBeNull()
  })
})
