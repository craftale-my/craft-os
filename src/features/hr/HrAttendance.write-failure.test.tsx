// @vitest-environment jsdom
//
// A write that Row Level Security rejects comes back with no error and no rows.
// The clock/break actions used to fire those writes blind and always report
// success, so a staff member could be shown a green tick while nothing was
// saved. These tests drive the real component through the break buttons — the
// one write path that does not go through the camera/GPS modal — and assert the
// failure is surfaced instead of swallowed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import type { Staff } from '../../shared/types'

const h = vi.hoisted(() => {
  const tables: Record<string, unknown[]> = {}
  const makeQuery = (rows: unknown[]) => {
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'gte', 'lte', 'in', 'order', 'limit', 'upsert', 'update']) {
      q[m] = () => q
    }
    q.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null })
    q.single = q.maybeSingle
    q.then = (onOk: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(onOk)
    return q
  }
  return { tables, makeQuery }
})

vi.mock('../../shared/lib/supabase', () => ({
  supabase: { from: (table: string) => h.makeQuery(h.tables[table] ?? []) },
}))

const { MyAttendance } = await import('./HrAttendance')

const STAFF = { id: 'staff-1', branch: 'HQ' } as unknown as Staff

// A night shift that grants a 45-minute first break, so the break buttons show.
const SHIFT_WITH_BREAK = {
  name: 'Night',
  department: 'barista',
  color: '#8B6344',
  start_time: '17:00:00',
  end_time: '01:00:00',
  break1_duration_minutes: 45,
  break2_duration_minutes: 0,
}

const OPEN_SESSION = {
  id: 'att-jul31',
  staff_id: 'staff-1',
  date: '2026-07-31',
  status: 'present',
  clock_in: new Date(2026, 6, 31, 17, 0, 0).toISOString(),
  clock_out: null,
  late_minutes: 0,
}

function seed(breaksReturnedByTheWrite: unknown[]) {
  h.tables.attendance = [OPEN_SESSION]
  h.tables.scheduled_shifts = [{ date: '2026-07-31', leave_type: null, shift_type: SHIFT_WITH_BREAK }]
  h.tables.system_rules = []
  // Drives what the break upsert's .select() hands back: [] models a write that
  // RLS silently dropped, a row models one that landed.
  h.tables.attendance_breaks = breaksReturnedByTheWrite
}

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(new Date(2026, 6, 31, 20, 0, 0)) })
afterEach(() => { cleanup(); vi.useRealTimers() })

const startBreakBtn = () => screen.getByRole('button', { name: /Break 1 Clock-Out/i })

describe('a write that does not land is reported, not swallowed', () => {
  it('shows an error when the break write returns no row', async () => {
    seed([])
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => expect(startBreakBtn()).toBeTruthy())

    fireEvent.click(startBreakBtn())

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/could not start break 1/i)
    expect(alert.textContent).toMatch(/not saved/i)
    // Critically: no green tick claiming it worked.
    expect(screen.queryByText(/Break 1 started/i)).toBeNull()
  })

  it('tells the staff member the likely cause and what to do', async () => {
    seed([])
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => expect(startBreakBtn()).toBeTruthy())

    fireEvent.click(startBreakBtn())

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/signed out/i)
    expect(alert.textContent).toMatch(/try again/i)
  })

  it('reports success — and shows no alert — when the write does land', async () => {
    // Starts with no break rows so the button is enabled, then the write
    // returns the row it created.
    seed([])
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => expect(startBreakBtn().hasAttribute('disabled')).toBe(false))

    h.tables.attendance_breaks = [{
      id: 'brk-1', attendance_id: 'att-jul31', break_number: 1,
      clock_out_time: new Date(2026, 6, 31, 20, 0, 0).toISOString(), clock_in_time: null,
    }]
    fireEvent.click(startBreakBtn())

    await waitFor(() => expect(screen.getByText(/Break 1 started/i)).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
