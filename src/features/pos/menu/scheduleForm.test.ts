import { describe, expect, it } from 'vitest'
import {
  addWindow, emptyScheduleForm, removeWindow, scheduleFormDirty, scheduleFormFromDetail, scheduleFormUnsaved, schedulePayload, scheduleProblems,
  setProduct, toggleDay, updateWindow,
} from './scheduleForm'

const detail = {
  id: 's1', name: 'Breakfast',
  windows: [{ days: [1, 2, 3, 4, 5], start: '08:00', end: '11:30' }],
  productIds: ['p2', 'p1'],
}

describe('scheduleForm', () => {
  it('starts a new schedule with one everyday window and no products', () => {
    const f = emptyScheduleForm()
    expect(f.windows).toEqual([{ key: 'w1', days: [1, 2, 3, 4, 5, 6, 7], start: '', end: '' }])
    expect(f.productIds).toEqual([])
    expect(scheduleFormDirty(f, null)).toBe(true)
  })

  it('warns before leaving a new schedule only once something was entered, a name or not', () => {
    const f = emptyScheduleForm()
    expect(scheduleFormUnsaved(f, null)).toBe(false)
    expect(scheduleFormUnsaved(updateWindow(f, 'w1', { start: '08:00' }), null)).toBe(true)
    expect(scheduleFormUnsaved(toggleDay(f, 'w1', 7), null)).toBe(true)
    expect(scheduleFormUnsaved(setProduct(f, 'p1', true), null)).toBe(true)
    expect(scheduleFormUnsaved({ ...f, name: 'B' }, null)).toBe(true)
    const loaded = scheduleFormFromDetail(detail)
    expect(scheduleFormUnsaved(loaded, loaded)).toBe(false)
    expect(scheduleFormUnsaved({ ...loaded, name: 'Brunch' }, loaded)).toBe(true)
  })

  it('edits windows: add, times, days in Monday-first order, remove', () => {
    let f = scheduleFormFromDetail(detail)
    f = addWindow(f)
    expect(f.windows.map((w) => w.key)).toEqual(['w1', 'w2'])
    f = updateWindow(f, 'w2', { start: '18:00', end: '21:00' })
    f = toggleDay(f, 'w2', 3)
    expect(f.windows[1].days).toEqual([1, 2, 4, 5, 6, 7])
    f = toggleDay(f, 'w2', 3)
    expect(f.windows[1].days).toEqual([1, 2, 3, 4, 5, 6, 7])
    f = removeWindow(f, 'w1')
    expect(f.windows.map((w) => w.key)).toEqual(['w2'])
    expect(addWindow(f).windows.map((w) => w.key)).toEqual(['w2', 'w1'])
  })

  it('keeps the product list sorted and without repeats', () => {
    let f = scheduleFormFromDetail(detail)
    expect(f.productIds).toEqual(['p1', 'p2'])
    f = setProduct(f, 'p0', true)
    f = setProduct(f, 'p0', true)
    expect(f.productIds).toEqual(['p0', 'p1', 'p2'])
    expect(setProduct(f, 'p1', false).productIds).toEqual(['p0', 'p2'])
  })

  it('finds every problem with the server words, once each', () => {
    const f = { ...emptyScheduleForm(), name: '  ' }
    expect(scheduleProblems(f, [])).toEqual([
      { section: 'details', message: 'Schedule name is required' },
      { section: 'windows', message: 'Enter each time as HH:MM, e.g. 08:00' },
    ])
    const twin = { ...scheduleFormFromDetail(detail), id: null, name: ' breakfast ' }
    expect(scheduleProblems(twin, [{ id: 's1', name: 'Breakfast' }])).toEqual([
      { section: 'details', message: 'A schedule called breakfast already exists' },
    ])
    expect(scheduleProblems(scheduleFormFromDetail(detail), [{ id: 's1', name: 'Breakfast' }])).toEqual([])
    const bad = { ...scheduleFormFromDetail(detail), windows: [
      { key: 'a', days: [], start: '08:00', end: '09:00' }, { key: 'b', days: [1], start: '10:00', end: '10:00' }, { key: 'c', days: [], start: '11:00', end: '12:00' }] }
    expect(scheduleProblems(bad, []).map((p) => p.message)).toEqual([
      'Pick at least one day for each time window', 'A time window cannot start and end at the same time'])
    expect(scheduleProblems({ ...bad, windows: [] }, [])[0].message).toBe('A schedule needs at least one time window')
    const many = Array.from({ length: 11 }, (_, i) => ({ key: `k${i}`, days: [1], start: '08:00', end: '09:00' }))
    expect(scheduleProblems({ ...bad, windows: many }, [])[0].message).toBe('Too many time windows (at most 10)')
  })

  it('sends everything for a new schedule', () => {
    const f = setProduct(updateWindow({ ...emptyScheduleForm(), name: ' Late  night ' }, 'w1', { start: '22:00', end: '02:00' }), 'p1', true)
    expect(schedulePayload(f, null)).toEqual({
      id: null, name: 'Late night',
      windows: [{ days: [1, 2, 3, 4, 5, 6, 7], start: '22:00', end: '02:00' }], productIds: ['p1'],
    })
  })

  it('for a saved schedule sends the products only when they changed', () => {
    const loaded = scheduleFormFromDetail(detail)
    expect(schedulePayload(updateWindow(loaded, 'w1', { end: '12:00' }), loaded)).toEqual({
      id: 's1', name: 'Breakfast', windows: [{ days: [1, 2, 3, 4, 5], start: '08:00', end: '12:00' }],
    })
    const changed = setProduct(loaded, 'p3', true)
    expect(schedulePayload(changed, loaded)).toMatchObject({ productIds: ['p1', 'p2', 'p3'] })
    expect(scheduleFormDirty(loaded, scheduleFormFromDetail(detail))).toBe(false)
    expect(scheduleFormDirty(changed, loaded)).toBe(true)
  })
})
