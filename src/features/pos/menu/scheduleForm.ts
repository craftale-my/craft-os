// src/features/pos/menu/scheduleForm.ts
/** The schedule editor's form: pure, so every rule is tested. menu_save_schedule checks all
 *  of it again with the same words; this only shows a problem next to its section first. */
import type { ScheduleDetail, SchedulePayload } from './slotsApi'
import { MAX_WINDOWS, windowProblem, type SlotWindow } from './timeSlots'
import { cleanName, nameProblem } from './menuForms'

/** One window row; `key` only tells rows apart on screen. */
export interface WindowForm extends SlotWindow { key: string }
export interface ScheduleForm {
  id: string | null
  name: string
  windows: WindowForm[]
  /** the products that follow it, sorted */
  productIds: string[]
}
export type ScheduleSection = 'details' | 'windows' | 'products'
export interface ScheduleProblem { section: ScheduleSection; message: string }

export const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7]

const nextKey = (ws: WindowForm[]) => {
  let n = 1
  while (ws.some((w) => w.key === `w${n}`)) n++
  return `w${n}`
}

/** A new schedule: one window every day with its times still to be typed. */
export function emptyScheduleForm(): ScheduleForm {
  return { id: null, name: '', windows: [{ key: 'w1', days: [...ALL_DAYS], start: '', end: '' }], productIds: [] }
}

export function scheduleFormFromDetail(d: ScheduleDetail): ScheduleForm {
  return {
    id: d.id, name: d.name,
    windows: d.windows.map((w, i) => ({ key: `w${i + 1}`, days: [...w.days], start: w.start, end: w.end })),
    productIds: [...d.productIds].sort(),
  }
}

export function addWindow(f: ScheduleForm): ScheduleForm {
  return { ...f, windows: [...f.windows, { key: nextKey(f.windows), days: [...ALL_DAYS], start: '', end: '' }] }
}
export function updateWindow(f: ScheduleForm, key: string, patch: Partial<Pick<WindowForm, 'start' | 'end'>>): ScheduleForm {
  return { ...f, windows: f.windows.map((w) => (w.key === key ? { ...w, ...patch } : w)) }
}
/** Ticks or unticks one day of one window; days stay in Monday-first order. */
export function toggleDay(f: ScheduleForm, key: string, day: number): ScheduleForm {
  return {
    ...f,
    windows: f.windows.map((w) => (w.key !== key ? w : {
      ...w, days: w.days.includes(day) ? w.days.filter((d) => d !== day) : [...w.days, day].sort((a, b) => a - b),
    })),
  }
}
export function removeWindow(f: ScheduleForm, key: string): ScheduleForm {
  return { ...f, windows: f.windows.filter((w) => w.key !== key) }
}
export function setProduct(f: ScheduleForm, productId: string, on: boolean): ScheduleForm {
  const rest = f.productIds.filter((id) => id !== productId)
  return { ...f, productIds: on ? [...rest, productId].sort() : rest }
}

/** Every problem that would stop a save, in section order. `others` are the saved schedules. */
export function scheduleProblems(f: ScheduleForm, others: { id: string; name: string }[]): ScheduleProblem[] {
  const out: ScheduleProblem[] = []
  const add = (section: ScheduleSection, message: string | null) => {
    if (message && !out.some((p) => p.message === message)) out.push({ section, message })
  }
  const name = cleanName(f.name)
  add('details', nameProblem('Schedule', f.name, 60))
  if (name && others.some((o) => o.id !== f.id && o.name.toLowerCase() === name.toLowerCase())) {
    add('details', `A schedule called ${name} already exists`)
  }
  if (f.windows.length === 0) add('windows', 'A schedule needs at least one time window')
  if (f.windows.length > MAX_WINDOWS) add('windows', `Too many time windows (at most ${MAX_WINDOWS})`)
  for (const w of f.windows) add('windows', windowProblem(w))
  return out
}

export function scheduleFormDirty(f: ScheduleForm, loaded: ScheduleForm | null): boolean {
  return loaded === null || JSON.stringify(f) !== JSON.stringify(loaded)
}

/** Whether leaving would lose something: a saved schedule changed since it was loaded, or a new
 *  one changed in any way from the empty form (a window, a day, a product — not only a name). */
export function scheduleFormUnsaved(f: ScheduleForm, loaded: ScheduleForm | null): boolean {
  return loaded !== null ? scheduleFormDirty(f, loaded) : JSON.stringify(f) !== JSON.stringify(emptyScheduleForm())
}

/** What menu_save_schedule takes. Windows are always sent whole; for a saved schedule the
 *  product list only when it changed, so a save never undoes a link made meanwhile in a
 *  product's editor. */
export function schedulePayload(f: ScheduleForm, loaded: ScheduleForm | null): SchedulePayload {
  const p: SchedulePayload = {
    id: f.id,
    name: cleanName(f.name),
    windows: f.windows.map((w) => ({ days: [...w.days].sort((a, b) => a - b), start: w.start, end: w.end })),
  }
  const isNew = f.id === null || loaded === null
  if (isNew || f.productIds.join() !== loaded.productIds.join()) p.productIds = [...f.productIds]
  return p
}
