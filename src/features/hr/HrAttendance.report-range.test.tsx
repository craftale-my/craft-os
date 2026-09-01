// @vitest-environment jsdom
//
// The report used to fetch breaks by listing every attendance row's UUID in
// `.in('attendance_id', [...])`. supabase-js puts that list in the query string,
// so the request grew by ~39 bytes per attendance row: a full roster crossed the
// API gateway's ~25KB URL ceiling at around 17 days and the gateway answered a
// bare `400 Bad Request`. Because the three datasets publish atomically, the
// whole report then blanked behind "Could not load breaks — Bad Request".
//
// These tests pin the property that broke: the breaks request must be filtered
// server-side by the same date/staff predicates as the other two, so its size
// tracks the roster, not the number of days.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import type { Staff } from '../../shared/types'

type RecordedCall = { table: string; select: string; filters: { method: string; args: unknown[] }[] }

const h = vi.hoisted(() => {
  const tables: Record<string, unknown[]> = {}
  const calls: RecordedCall[] = []
  const makeQuery = (table: string) => {
    const record: RecordedCall = { table, select: '', filters: [] }
    calls.push(record)
    let range: [number, number] | null = null
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'gte', 'lte', 'in', 'order', 'limit', 'range']) {
      q[m] = (...args: unknown[]) => {
        if (m === 'select') record.select = String(args[0] ?? '')
        else record.filters.push({ method: m, args })
        if (m === 'range') range = [args[0] as number, args[1] as number]
        return q
      }
    }
    // Honour .range() so the caller's paging terminates the way it does against
    // the real server; filters are recorded rather than applied.
    q.then = (onOk: (v: unknown) => unknown) => {
      const all = tables[table] ?? []
      const data = range ? all.slice(range[0], range[1] + 1) : all
      return Promise.resolve({ data, error: null }).then(onOk)
    }
    return q
  }
  return { tables, calls, makeQuery }
})

vi.mock('../../shared/lib/supabase', () => ({
  supabase: { from: (table: string) => h.makeQuery(table) },
}))

const { AttendanceReport } = await import('./HrAttendance')

/** Supabase's gateway rejects a request whose URL passes roughly this size with
 *  a bare `400 Bad Request`. Measured against the live project: 640 UUIDs in an
 *  `in.()` filter (~25.1KB) still answered 200, 660 (~25.8KB) did not. */
const GATEWAY_URL_LIMIT = 25_000

/** What supabase-js would serialise into the query string for one request. */
function queryStringBytes(c: RecordedCall): number {
  return c.filters.reduce(
    (n, f) => n + f.method.length + JSON.stringify(f.args).length,
    c.select.length,
  )
}

const lastCallTo = (table: string) => [...h.calls].reverse().find(c => c.table === table)

/** The staff's row in the summary table. The name also appears in the staff
 *  dropdown, so match the table cell rather than the `<option>`. */
const summaryRow = (name: string) => {
  const cell = screen.getAllByText(name).find(el => el.closest('td'))
  return cell?.closest('tr') ?? null
}

// 40 staff — the live roster — over the 30-day default range is 1,200 attendance
// rows, well past the ceiling when they travel as a UUID list.
const STAFF: Staff[] = Array.from({ length: 40 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  name: `Staff ${i}`,
  branch: 'HQ',
  department: 'barista',
}) as unknown as Staff)

/** Attendance ids are real UUIDs in production, so keep them UUID-length here —
 *  the byte estimate above is only meaningful against the real 36-char value. */
const attId = (dayIndex: number, staffIndex: number) =>
  `10000000-0000-4000-8000-${String(dayIndex * 100 + staffIndex).padStart(12, '0')}`

function seedAttendance(days: number) {
  const rows: unknown[] = []
  for (let d = 0; d < days; d++) {
    const date = `2026-08-${String(d + 1).padStart(2, '0')}`
    for (const [i, s] of STAFF.entries()) {
      rows.push({
        id: attId(d, i),
        staff_id: s.id,
        date,
        status: 'present',
        clock_in: `${date}T09:00:00.000Z`,
        clock_out: `${date}T18:00:00.000Z`,
        late_minutes: 0,
      })
    }
  }
  h.tables.attendance = rows
  h.tables.scheduled_shifts = []
  h.tables.attendance_breaks = []
}

beforeEach(() => {
  h.calls.length = 0
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date(2026, 7, 31, 12, 0, 0))
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('the breaks query survives a range longer than a fortnight', () => {
  it('stays inside the gateway URL limit across a full month of a full roster', async () => {
    seedAttendance(31)
    render(<AttendanceReport allStaff={STAFF} />)

    await waitFor(() => expect(lastCallTo('attendance_breaks')).toBeTruthy())

    const breaksCall = lastCallTo('attendance_breaks')!
    expect(queryStringBytes(breaksCall)).toBeLessThan(GATEWAY_URL_LIMIT)
  })

  it('filters breaks by date and staff rather than by attendance id', async () => {
    seedAttendance(31)
    render(<AttendanceReport allStaff={STAFF} />)

    await waitFor(() => expect(lastCallTo('attendance_breaks')).toBeTruthy())

    const breaksCall = lastCallTo('attendance_breaks')!
    // No filter may carry one value per attendance row — that is the growth that
    // blew the URL. The staff list is bounded by the roster and is fine.
    for (const f of breaksCall.filters) {
      for (const arg of f.args) {
        if (Array.isArray(arg)) expect(arg.length).toBeLessThanOrEqual(STAFF.length)
      }
    }
    const filtered = breaksCall.filters.map(f => String(f.args[0])).join(' ')
    expect(filtered).toMatch(/date/)
    expect(filtered).toMatch(/staff_id/)
  })

  it('shows the report instead of a Bad Request banner over a 31-day range', async () => {
    seedAttendance(31)
    render(<AttendanceReport allStaff={STAFF} />)

    await waitFor(() => expect(summaryRow('Staff 0')).toBeTruthy())
    expect(screen.queryByText(/could not load breaks/i)).toBeNull()
  })
})

describe('breaks still count once the join carries them', () => {
  it('counts break overtime from rows returned by the joined query', async () => {
    seedAttendance(1)
    // The inner join embeds the parent row; grouping still keys off attendance_id.
    h.tables.attendance_breaks = [{
      id: 'brk-1',
      attendance_id: attId(0, 0),
      break_number: 1,
      clock_out_time: '2026-08-01T12:00:00.000Z',
      clock_in_time: '2026-08-01T12:50:00.000Z',
      duration_minutes: 50,
      overtime_minutes: 5,
      is_overtime: true,
      attendance: { staff_id: STAFF[0].id, date: '2026-08-01' },
    }]

    render(<AttendanceReport allStaff={STAFF} />)

    await waitFor(() => expect(summaryRow('Staff 0')).toBeTruthy())
    // Break OT is the last cell on the staff's summary row.
    expect(summaryRow('Staff 0')!.lastElementChild!.textContent).toBe('1')
  })
})
