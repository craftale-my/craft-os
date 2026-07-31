// @vitest-environment jsdom
//
// Renders the real MyAttendance card against a faked clock and a stubbed
// Supabase, to prove the night-shift clock-out survives midnight. The pure
// date maths is covered in shared/lib/attendance.test.ts — this file covers the
// WIRING: that the component asks for the right rows and reaches the right
// button state.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import type { Staff } from '../../shared/types'

// Chainable stub: every builder method returns itself, awaiting yields { data }.
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

const NIGHT_SHIFT = {
  name: 'Night',
  department: 'barista',
  color: '#8B6344',
  start_time: '17:00:00',
  end_time: '01:00:00',
  break1_duration_minutes: 0,
  break2_duration_minutes: 0,
}
const DAY_SHIFT = { ...NIGHT_SHIFT, name: 'Morning', start_time: '09:30:00', end_time: '18:00:00' }

const STAFF = { id: 'staff-1', branch: 'HQ' } as unknown as Staff

/** Seed the stubbed tables for one scenario. */
function seed(opts: {
  attendance?: Record<string, unknown>[]
  shifts?: Record<string, unknown>[]
}) {
  h.tables.attendance = opts.attendance ?? []
  h.tables.scheduled_shifts = opts.shifts ?? []
  h.tables.attendance_breaks = []
  h.tables.system_rules = []
}

const clockedInAt5pmJul31 = {
  id: 'att-jul31',
  staff_id: 'staff-1',
  date: '2026-07-31',
  status: 'present',
  clock_in: new Date(2026, 6, 31, 17, 0, 0).toISOString(),
  clock_out: null,
  late_minutes: 0,
}

const nightShiftOnJul31 = { date: '2026-07-31', leave_type: null, shift_type: NIGHT_SHIFT }

const clockIn = () => screen.getByRole('button', { name: /Clock In/i })
const clockOut = () => screen.getByRole('button', { name: /Clock Out/i })

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('MyAttendance across midnight', () => {
  it('THE BUG: at 1:05am the 5pm–1am shift can still clock OUT', async () => {
    vi.setSystemTime(new Date(2026, 7, 1, 1, 5, 0))
    seed({ attendance: [clockedInAt5pmJul31], shifts: [nightShiftOnJul31] })

    render(<MyAttendance staff={STAFF} />)

    // The card holds yesterday's attendance day, not the wall-clock day.
    await waitFor(() => expect(screen.getByText(/Current shift/i)).toBeTruthy())
    expect(screen.getByText(/31 July/)).toBeTruthy()
    expect(screen.getByText(/Night shift running past midnight/)).toBeTruthy()

    // The whole point: Clock Out live, Clock In locked.
    expect(clockOut().hasAttribute('disabled')).toBe(false)
    expect(clockIn().hasAttribute('disabled')).toBe(true)

    // And the open session is still on screen.
    expect(screen.getByText(/Clocked in at/i)).toBeTruthy()
  })

  it('still works at 12:01am, the moment the old code broke', async () => {
    vi.setSystemTime(new Date(2026, 7, 1, 0, 1, 0))
    seed({ attendance: [clockedInAt5pmJul31], shifts: [nightShiftOnJul31] })

    render(<MyAttendance staff={STAFF} />)

    await waitFor(() => expect(clockOut().hasAttribute('disabled')).toBe(false))
    expect(screen.getByText(/31 July/)).toBeTruthy()
  })

  it('before midnight is unchanged — 11:50pm still shows 31 July as Today', async () => {
    vi.setSystemTime(new Date(2026, 6, 31, 23, 50, 0))
    seed({ attendance: [clockedInAt5pmJul31], shifts: [nightShiftOnJul31] })

    render(<MyAttendance staff={STAFF} />)

    await waitFor(() => expect(clockOut().hasAttribute('disabled')).toBe(false))
    expect(screen.getByText(/^Today$/i)).toBeTruthy()
    expect(screen.queryByText(/Night shift running past midnight/)).toBeNull()
  })

  it('rolls over once the shift is closed — 1:05am after clocking out shows a fresh day', async () => {
    vi.setSystemTime(new Date(2026, 7, 1, 1, 5, 0))
    seed({
      attendance: [{ ...clockedInAt5pmJul31, clock_out: new Date(2026, 7, 1, 1, 0, 0).toISOString() }],
      shifts: [nightShiftOnJul31],
    })

    render(<MyAttendance staff={STAFF} />)

    await waitFor(() => expect(screen.getByText(/^Today$/i)).toBeTruthy())
    expect(screen.getByText(/1 August/)).toBeTruthy()
    expect(clockIn().hasAttribute('disabled')).toBe(false)
    expect(clockOut().hasAttribute('disabled')).toBe(true)
  })

  it('does not carry over a DAY shift left open — 1:05am starts a new day', async () => {
    vi.setSystemTime(new Date(2026, 7, 1, 1, 5, 0))
    seed({
      attendance: [clockedInAt5pmJul31],
      shifts: [{ date: '2026-07-31', leave_type: null, shift_type: DAY_SHIFT }],
    })

    render(<MyAttendance staff={STAFF} />)

    await waitFor(() => expect(screen.getByText(/^Today$/i)).toBeTruthy())
    expect(screen.getByText(/1 August/)).toBeTruthy()
    expect(clockIn().hasAttribute('disabled')).toBe(false)
  })

  it('past the grace window a forgotten clock-out no longer blocks the new day', async () => {
    vi.setSystemTime(new Date(2026, 7, 1, 17, 0, 0)) // next evening, new night shift
    seed({
      attendance: [clockedInAt5pmJul31],
      shifts: [nightShiftOnJul31, { date: '2026-08-01', leave_type: null, shift_type: NIGHT_SHIFT }],
    })

    render(<MyAttendance staff={STAFF} />)

    await waitFor(() => expect(screen.getByText(/1 August/)).toBeTruthy())
    expect(clockIn().hasAttribute('disabled')).toBe(false)
  })
})
