// @vitest-environment jsdom
//
// M5: the staff member's own "This Month" card has to agree with what feeds
// Reviews.countLateDays (see Reviews.lateCount.test.ts) — an excused
// lateness must not inflate the number a staff member sees as their own
// tally, which is the exact month-end "my card says 3, my review says 1"
// mismatch this whole late-reason/excuse feature exists to prevent. The
// excused days must stay visible somewhere rather than silently vanishing.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import type { Staff } from '../../shared/types'

const h = vi.hoisted(() => {
  const tables: Record<string, unknown[]> = {}
  const makeQuery = (table: string, rows: unknown[]) => {
    const q: Record<string, unknown> = {}
    let keyFilter: string | undefined
    for (const m of ['select', 'gte', 'lte', 'in', 'order', 'limit']) q[m] = () => q
    q.eq = (field: string, value: unknown) => {
      if (table === 'system_rules' && field === 'key') keyFilter = value as string
      return q
    }
    q.maybeSingle = () => {
      const matched = keyFilter === undefined
        ? rows
        : rows.filter(r => (r as Record<string, unknown>).key === keyFilter)
      return Promise.resolve({ data: matched[0] ?? null, error: null })
    }
    q.single = q.maybeSingle
    // A fresh copy every call, never the live `rows` reference — the
    // aliasing trap this harness family has hit before.
    q.then = (onOk: (v: unknown) => unknown) => Promise.resolve({ data: rows.slice(), error: null }).then(onOk)
    return q
  }
  return { tables, makeQuery }
})

vi.mock('../../shared/lib/supabase', () => ({
  supabase: { from: (table: string) => h.makeQuery(table, h.tables[table] ?? []) },
}))

const { MyAttendance } = await import('./HrAttendance')
const STAFF = { id: 'staff-1', branch: 'HQ' } as unknown as Staff

beforeEach(() => {
  h.tables.attendance = []
  h.tables.scheduled_shifts = []
  h.tables.system_rules = []
  h.tables.attendance_breaks = []
  // Comfortably after every seeded date below, and no shift on "yesterday"
  // (Sept 19), so resolveAttendanceDate() has nothing to carry over.
  vi.setSystemTime(new Date(2026, 8, 20, 10, 0, 0))
})
afterEach(() => { cleanup(); vi.useRealTimers() })

function lateTile(): HTMLElement {
  return screen.getByText('Late').parentElement as HTMLElement
}

describe('本月统计与 Review 的迟到口径一致(M5)', () => {
  it('excludes an excused late day from the prominent Late count', async () => {
    h.tables.attendance = [
      { id: 'a1', staff_id: 'staff-1', date: '2026-09-01', status: 'present', late_minutes: 0, late_excused: false },
      { id: 'a2', staff_id: 'staff-1', date: '2026-09-05', status: 'late', late_minutes: 10, late_excused: true },
      { id: 'a3', staff_id: 'staff-1', date: '2026-09-08', status: 'late', late_minutes: 20, late_excused: false },
      { id: 'a4', staff_id: 'staff-1', date: '2026-09-10', status: 'absent', late_minutes: 0, late_excused: false },
    ]
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => expect(screen.getByText('This Month')).toBeTruthy())

    // Two records have status='late', but one is excused — the tile's
    // headline number must be 1 (matching Reviews.countLateDays), not 2.
    const countEl = lateTile().querySelector('p.text-2xl') as HTMLElement
    expect(countEl.textContent?.trim()).toBe('1')
  })

  it('does not drop the excused day silently — it surfaces as a note on the tile', async () => {
    h.tables.attendance = [
      { id: 'a2', staff_id: 'staff-1', date: '2026-09-05', status: 'late', late_minutes: 10, late_excused: true },
      { id: 'a3', staff_id: 'staff-1', date: '2026-09-08', status: 'late', late_minutes: 20, late_excused: false },
    ]
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => expect(screen.getByText('This Month')).toBeTruthy())
    expect(lateTile().textContent).toMatch(/1 excused/i)
  })

  it('does not show an excused note when nothing was excused', async () => {
    h.tables.attendance = [
      { id: 'a3', staff_id: 'staff-1', date: '2026-09-08', status: 'late', late_minutes: 20, late_excused: false },
    ]
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => expect(screen.getByText('This Month')).toBeTruthy())
    expect(lateTile().textContent).not.toMatch(/excused/i)
  })

  it('flags the excused day in the day-by-day list too, not just the tally', async () => {
    h.tables.attendance = [
      { id: 'a2', staff_id: 'staff-1', date: '2026-09-05', status: 'late', late_minutes: 10, late_excused: true },
    ]
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => expect(screen.getByText('2026-09-05')).toBeTruthy())
    expect(screen.getByText('Excused')).toBeTruthy()
  })
})
