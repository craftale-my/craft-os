// @vitest-environment jsdom
//
// PostgREST answers at most 1000 rows per request. The report used to take that
// slice silently: attendance came back ordered by date (so the cut fell at a
// date boundary) while scheduled_shifts came back unordered (so the cut fell
// anywhere). buildStaffReport then saw shift rows whose attendance partner had
// been dropped and reported `missedClockIn` for them — inventing dated absences
// for staff who had clocked in every single day, complete with a red row, a
// "Missed" chip, and both CSV exports carrying them. The truncation banner said
// rows "were left out and the totals below are incomplete", which reads as
// under-counting, not as fabricated violations on a disciplinary metric.
//
// The supabase mock below models the real server: it applies the filters, honours
// `.order()` only when asked, and caps every response at 1000 rows unless the
// caller pages with `.range()`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import type { Staff } from '../../shared/types'

const PAGE_CAP = 1000

const h = vi.hoisted(() => {
  const tables: Record<string, Record<string, unknown>[]> = {}
  const pageSizes: Record<string, number[]> = {}
  const PAGE_CAP = 1000

  const makeQuery = (table: string) => {
    const filters: { op: string; col: string; val: unknown }[] = []
    const orders: string[] = []
    let range: [number, number] | null = null

    const run = () => {
      let rows = (tables[table] ?? []).slice()
      for (const f of filters) {
        rows = rows.filter(r => {
          const v = r[f.col]
          if (f.op === 'in') return (f.val as unknown[]).includes(v)
          if (f.op === 'gte') return String(v) >= String(f.val)
          if (f.op === 'lte') return String(v) <= String(f.val)
          return r[f.col] === f.val
        })
      }
      // Unordered reads come back in whatever order the server pleases. Model the
      // worst case honestly: reverse it, so an unordered cut is not accidentally
      // the same slice an ordered one would give.
      if (orders.length > 0) {
        rows.sort((a, b) => {
          for (const c of orders) {
            const x = String(a[c] ?? ''), y = String(b[c] ?? '')
            if (x !== y) return x < y ? -1 : 1
          }
          return 0
        })
      } else {
        rows.reverse()
      }
      const start = range ? range[0] : 0
      const end = range ? Math.min(range[1] + 1, start + PAGE_CAP) : PAGE_CAP
      const page = rows.slice(start, end)
      ;(pageSizes[table] ??= []).push(page.length)
      return { data: page, error: null }
    }

    const q: Record<string, unknown> = {}
    q.select = () => q
    q.eq = (col: string, val: unknown) => { filters.push({ op: 'eq', col, val }); return q }
    q.in = (col: string, val: unknown) => { filters.push({ op: 'in', col: col.split('.').pop()!, val }); return q }
    q.gte = (col: string, val: unknown) => { filters.push({ op: 'gte', col: col.split('.').pop()!, val }); return q }
    q.lte = (col: string, val: unknown) => { filters.push({ op: 'lte', col: col.split('.').pop()!, val }); return q }
    q.order = (col: string) => { orders.push(col); return q }
    q.limit = () => q
    q.range = (a: number, b: number) => { range = [a, b]; return q }
    q.then = (onOk: (v: unknown) => unknown) => Promise.resolve(run()).then(onOk)
    return q
  }
  return { tables, pageSizes, makeQuery }
})

vi.mock('../../shared/lib/supabase', () => ({
  supabase: { from: (table: string) => h.makeQuery(table) },
}))

const { AttendanceReport } = await import('./HrAttendance')

const STAFF_COUNT = 50
const STAFF: Staff[] = Array.from({ length: STAFF_COUNT }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  name: `Staff ${i}`,
  branch: 'HQ',
  department: 'barista',
}) as unknown as Staff)

/** Everybody rostered and clocked in on every day of the range. Nobody missed
 *  anything, so every "Missed clock-in" the report shows is invented. */
function seedPerfectAttendance(days: number) {
  const att: Record<string, unknown>[] = []
  const shifts: Record<string, unknown>[] = []
  for (let d = 0; d < days; d++) {
    const date = `2026-08-${String(d + 1).padStart(2, '0')}`
    for (const [i, s] of STAFF.entries()) {
      att.push({
        id: `10000000-0000-4000-8000-${String(d * 100 + i).padStart(12, '0')}`,
        staff_id: s.id,
        date,
        status: 'present',
        clock_in: `${date}T01:30:00.000Z`,
        clock_out: `${date}T10:00:00.000Z`,
        late_minutes: 0,
      })
      shifts.push({
        id: `20000000-0000-4000-8000-${String(d * 100 + i).padStart(12, '0')}`,
        staff_id: s.id,
        date,
        shift_type_id: 'st-morning',
        leave_type: null,
        shift_type: { name: 'Morning', start_time: '09:30:00', end_time: '18:00:00' },
      })
    }
  }
  h.tables.attendance = att
  h.tables.scheduled_shifts = shifts
  h.tables.attendance_breaks = []
}

const summaryRow = (name: string) => {
  const cell = screen.getAllByText(name).find(el => el.closest('td'))
  return cell?.closest('tr') ?? null
}
const missedCount = (name: string) => summaryRow(name)?.children[7]?.textContent
const presentCount = (name: string) => summaryRow(name)?.children[1]?.textContent

beforeEach(() => {
  for (const k of Object.keys(h.pageSizes)) delete h.pageSizes[k]
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date(2026, 7, 31, 23, 0, 0))
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('a range past the 1000-row page cap does not invent absences', () => {
  // 50 staff x 30 days = 1,500 attendance rows and 1,500 shift rows: the
  // untouched "Last 30 days" default on a full roster.
  it('reports no missed clock-ins when everyone clocked in every day', async () => {
    seedPerfectAttendance(31)
    render(<AttendanceReport allStaff={STAFF} />)

    await waitFor(() => expect(summaryRow('Staff 0')).toBeTruthy())
    await waitFor(() => expect(presentCount('Staff 0')).not.toBe('0'))

    expect(missedCount('Staff 0')).toBe('0')
  })

  it('counts every day that was actually worked', async () => {
    seedPerfectAttendance(31)
    render(<AttendanceReport allStaff={STAFF} />)

    await waitFor(() => expect(summaryRow('Staff 0')).toBeTruthy())
    // The default preset is the last 30 days ending today (2026-08-31), i.e.
    // 2026-08-02..2026-08-31 = 30 seeded days.
    await waitFor(() => expect(presentCount('Staff 0')).toBe('30'))
  })

  it('shows no "Missed" chip in the detail table for a fully-attended month', async () => {
    seedPerfectAttendance(31)
    render(<AttendanceReport allStaff={STAFF} />)

    await waitFor(() => expect(summaryRow('Staff 0')).toBeTruthy())
    await waitFor(() => expect(presentCount('Staff 0')).toBe('30'))

    expect(screen.queryByText(/No record/)).toBeNull()
    expect(screen.queryByText(/· Missed/)).toBeNull()
  })

  it('pages the reads instead of taking one silent 1000-row slice', async () => {
    seedPerfectAttendance(31)
    render(<AttendanceReport allStaff={STAFF} />)

    await waitFor(() => expect(presentCount('Staff 0')).toBe('30'))

    // 1,500 matching rows cannot arrive in a single capped response.
    const attPages = h.pageSizes.attendance ?? []
    expect(attPages.length).toBeGreaterThan(1)
    expect(attPages.reduce((a, b) => a + b, 0)).toBe(STAFF_COUNT * 30)
    expect(Math.max(...attPages)).toBeLessThanOrEqual(PAGE_CAP)
  })

  it('does not raise the truncation banner for a range it can fully read', async () => {
    seedPerfectAttendance(31)
    render(<AttendanceReport allStaff={STAFF} />)

    await waitFor(() => expect(presentCount('Staff 0')).toBe('30'))
    expect(screen.queryByText(/hit the .*-record limit/i)).toBeNull()
  })
})
