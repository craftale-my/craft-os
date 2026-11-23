// @vitest-environment jsdom
//
// Everything the report puts in a file or a cell, rather than in a counter.
//
//  - Both exports read the summaries state without consulting `error`,
//    `loading` or `truncated`, so a failed load exported a well-formed CSV of
//    zeros and a truncated one exported as if it were complete. Those files get
//    mailed to payroll.
//  - `fmtClock` read the hour with getHours(), i.e. the VIEWER's timezone, while
//    the Date, Shift and Late columns beside it are fixed Malaysian values, so
//    the same export produced different times depending on who ran it.
//  - An overnight shift's clock_out belongs to the next calendar day but printed
//    as a bare time on the shift's start-day row, reading as a clock-out before
//    the clock-in.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import type { Staff } from '../../shared/types'

const h = vi.hoisted(() => {
  const tables: Record<string, Record<string, unknown>[]> = {}
  const failures: Record<string, string> = {}
  const downloads: { filename: string; body: string }[] = []
  const makeQuery = (table: string) => {
    let range: [number, number] | null = null
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'gte', 'lte', 'in', 'order', 'limit']) q[m] = () => q
    q.range = (a: number, b: number) => { range = [a, b]; return q }
    q.then = (onOk: (v: unknown) => unknown) => {
      if (failures[table]) return Promise.resolve({ data: null, error: { message: failures[table] } }).then(onOk)
      const all = tables[table] ?? []
      const data = range ? all.slice(range[0], range[1] + 1) : all
      return Promise.resolve({ data, error: null }).then(onOk)
    }
    return q
  }
  return { tables, failures, downloads, makeQuery }
})

vi.mock('../../shared/lib/supabase', () => ({
  supabase: { from: (table: string) => h.makeQuery(table) },
}))
vi.mock('../../shared/lib/csv', async (orig) => {
  const real = await orig<typeof import('../../shared/lib/csv')>()
  return { ...real, downloadCSV: (filename: string, body: string) => { h.downloads.push({ filename, body }) } }
})

const { AttendanceReport } = await import('./HrAttendance')

const STAFF: Staff[] = [
  { id: 'staff-a', name: 'Ann', branch: 'HQ', department: 'barista' },
] as unknown as Staff[]

const MORNING = { name: 'Morning', start_time: '09:30:00', end_time: '18:00:00' }

function seedOneGoodDay() {
  h.tables.attendance = [{
    id: 'att-1', staff_id: 'staff-a', date: '2026-08-03', status: 'late', late_minutes: 2,
    // 09:32 and 18:05 Malaysian time, stored as absolute instants.
    clock_in: '2026-08-03T01:32:00.000Z',
    clock_out: '2026-08-03T10:05:00.000Z',
  }]
  h.tables.scheduled_shifts = [{
    id: 'sh-1', staff_id: 'staff-a', date: '2026-08-03',
    shift_type_id: 'st1', leave_type: null, status: 'scheduled', shift_type: MORNING,
  }]
  h.tables.attendance_breaks = []
}

const clickExport = (label: RegExp) => fireEvent.click(screen.getByRole('button', { name: label }))
const exportBtn = (label: RegExp) => screen.getByRole('button', { name: label }) as HTMLButtonElement
const summaryRow = (name: string) =>
  screen.queryAllByText(name).find(el => el.closest('td'))?.closest('tr') ?? null

beforeEach(() => {
  for (const k of Object.keys(h.tables)) delete h.tables[k]
  for (const k of Object.keys(h.failures)) delete h.failures[k]
  h.downloads.length = 0
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-08-31T12:00:00+08:00'))
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('a CSV is never handed over when the numbers behind it are not real', () => {
  it('refuses to export after a failed load', async () => {
    h.tables.attendance = []
    h.failures.attendance = 'network error'
    render(<AttendanceReport allStaff={STAFF} />)

    await waitFor(() => expect(screen.getByText(/could not load attendance/i)).toBeTruthy())

    expect(exportBtn(/Export Summary CSV/i).disabled).toBe(true)
    clickExport(/Export Summary CSV/i)
    clickExport(/Export Detail CSV/i)
    expect(h.downloads).toHaveLength(0)
  })

  it('exports normally once the data is there', async () => {
    seedOneGoodDay()
    render(<AttendanceReport allStaff={STAFF} />)

    await waitFor(() => expect(summaryRow('Ann')).toBeTruthy())

    expect(exportBtn(/Export Summary CSV/i).disabled).toBe(false)
    clickExport(/Export Summary CSV/i)
    expect(h.downloads).toHaveLength(1)
    expect(h.downloads[0].filename).toMatch(/^attendance_summary_/)
    expect(h.downloads[0].filename).not.toMatch(/INCOMPLETE/)
    expect(h.downloads[0].body).not.toMatch(/INCOMPLETE/)
  })
})

describe('clock times are Malaysian wherever they are read', () => {
  it('renders a clock-in in MYT regardless of the viewer timezone', async () => {
    seedOneGoodDay()
    render(<AttendanceReport allStaff={STAFF} />)

    await waitFor(() => expect(summaryRow('Ann')).toBeTruthy())
    fireEvent.click(summaryRow('Ann')!)
    await waitFor(() => expect(screen.getByText('2026-08-03')).toBeTruthy())

    const row = screen.getByText('2026-08-03').closest('tr')!
    const cells = [...row.children].map(c => c.textContent)
    // Shift is "Morning 9:30am–6:00pm" and Late is "+2m", both fixed MYT values.
    // The clock-in has to read 9:32am beside them, not the viewer's hour.
    expect(cells).toContain('9:32am')
  })

  it('marks a clock-out that belongs to the next calendar day', async () => {
    h.tables.attendance = [{
      id: 'att-n', staff_id: 'staff-a', date: '2026-08-03', status: 'present', late_minutes: 0,
      clock_in: '2026-08-03T09:02:00.000Z',   // 17:02 MYT on 08-03
      clock_out: '2026-08-03T17:04:00.000Z',  // 01:04 MYT on 08-04
    }]
    h.tables.scheduled_shifts = [{
      id: 'sh-n', staff_id: 'staff-a', date: '2026-08-03',
      shift_type_id: 'st1', leave_type: null, status: 'scheduled',
      shift_type: { name: 'Night', start_time: '17:00:00', end_time: '01:00:00' },
    }]
    h.tables.attendance_breaks = []

    render(<AttendanceReport allStaff={STAFF} />)
    await waitFor(() => expect(summaryRow('Ann')).toBeTruthy())
    fireEvent.click(summaryRow('Ann')!)
    await waitFor(() => expect(screen.getByText('2026-08-03')).toBeTruthy())

    const cells = [...screen.getByText('2026-08-03').closest('tr')!.children].map(c => c.textContent)
    expect(cells).toContain('5:02pm')
    // Bare "1:04am" reads as eight hours before the clock-in.
    expect(cells.some(c => c?.includes('1:04am') && c.includes('+1d'))).toBe(true)
  })
})

describe('the range inputs refuse an empty date instead of asking Postgres', () => {
  it('asks for a start date rather than sending an empty operand', async () => {
    seedOneGoodDay()
    render(<AttendanceReport allStaff={STAFF} />)
    await waitFor(() => expect(summaryRow('Ann')).toBeTruthy())

    const fromInput = document.querySelector('input[type="date"]') as HTMLInputElement
    fireEvent.change(fromInput, { target: { value: '' } })

    await waitFor(() => expect(screen.getByText(/pick a start date/i)).toBeTruthy())
    // The raw Postgres complaint must never reach the manager.
    expect(screen.queryByText(/invalid input syntax/i)).toBeNull()
  })
})
