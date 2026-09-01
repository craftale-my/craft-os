// @vitest-environment jsdom
//
// The report's load effect refires on every range/filter change with no request
// id and no cleanup, so two runs can be in flight at once. Whichever one settles
// LAST publishes its rows, its error and its truncation flag — regardless of
// which selection it belongs to. Changing the filter to a slow selection and
// back, or simply picking dates faster than the network answers, could leave the
// table showing another selection's numbers under the current filter's heading,
// and both CSV exports read from that same state.
//
// The supabase mock hands out a deferred promise per table read so the test
// chooses the settle order explicitly.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import type { Staff } from '../../shared/types'

type Deferred = { resolve: (rows: unknown[]) => void; table: string }

const h = vi.hoisted(() => {
  const pending: { table: string; resolve: (v: unknown) => void }[] = []
  const makeQuery = (table: string) => {
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'gte', 'lte', 'in', 'order', 'limit', 'range']) q[m] = () => q
    q.then = (onOk: (v: unknown) => unknown) =>
      new Promise(res => pending.push({ table, resolve: res })).then(onOk)
    return q
  }
  return { pending, makeQuery }
})

vi.mock('../../shared/lib/supabase', () => ({
  supabase: { from: (table: string) => h.makeQuery(table) },
}))

const { AttendanceReport } = await import('./HrAttendance')

const STAFF: Staff[] = [
  { id: 'staff-a', name: 'Ann', branch: 'HQ', department: 'barista' },
  { id: 'staff-b', name: 'Bob', branch: 'Branch 2', department: 'barista' },
] as unknown as Staff[]

const attRow = (staffId: string, date: string) => ({
  id: `att-${staffId}-${date}`,
  staff_id: staffId,
  date,
  status: 'present',
  clock_in: `${date}T01:30:00.000Z`,
  clock_out: `${date}T10:00:00.000Z`,
  late_minutes: 0,
})

const waitForPending = async (table: string) =>
  waitFor(() => expect(h.pending.some(p => p.table === table)).toBe(true))

/** Wait for the next read of `table` to be issued, then settle it with `rows`. */
async function settle(table: string, rows: unknown[]) {
  await waitForPending(table)
  const i = h.pending.findIndex(p => p.table === table)
  const [p] = h.pending.splice(i, 1)
  await act(async () => { p.resolve({ data: rows, error: null }); await Promise.resolve() })
}

/** Let every queued continuation and state update drain. Assertions about a run
 *  that must NOT publish are only meaningful once it has had its chance to. */
async function flush() {
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
}

const summaryRow = (name: string) => {
  const cell = screen.queryAllByText(name).find(el => el.closest('td'))
  return cell?.closest('tr') ?? null
}
const presentCount = (name: string) => summaryRow(name)?.children[1]?.textContent

beforeEach(() => {
  h.pending.length = 0
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date(2026, 7, 31, 12, 0, 0))
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('a superseded load must not publish over the current one', () => {
  it('ignores an older response that lands after a newer one', async () => {
    const { rerender } = render(<AttendanceReport allStaff={STAFF} />)

    // Run 1 (both staff) issues its attendance read and is left in flight.
    await waitForPending('attendance')
    const stale = h.pending.shift()!

    // The selection narrows to one person: run 2 starts while run 1 is unfinished.
    rerender(<AttendanceReport allStaff={[STAFF[0]]} />)
    await waitForPending('attendance')

    // Run 2 completes first, with Ann present on two days.
    await settle('attendance', [attRow('staff-a', '2026-08-20'), attRow('staff-a', '2026-08-21')])
    await settle('attendance_breaks', [])
    await settle('scheduled_shifts', [])
    await waitFor(() => expect(presentCount('Ann')).toBe('2'))

    // Only now does the superseded run answer — with a different, larger set.
    await act(async () => {
      stale.resolve({
        data: [
          attRow('staff-a', '2026-08-01'), attRow('staff-a', '2026-08-02'),
          attRow('staff-a', '2026-08-03'), attRow('staff-b', '2026-08-01'),
        ],
        error: null,
      })
      await Promise.resolve()
    })
    await flush()

    // Ann's count must still belong to the current selection, not the abandoned
    // one's three days.
    expect(presentCount('Ann')).toBe('2')
    expect(summaryRow('Bob')).toBeNull()
    // And the abandoned run must stop rather than go on to spend two more reads
    // whose results it could never publish.
    expect(h.pending).toHaveLength(0)
  })

  it('does not let a superseded failure blank the current result', async () => {
    const { rerender } = render(<AttendanceReport allStaff={STAFF} />)

    await waitForPending('attendance')
    const stale = h.pending.shift()!

    rerender(<AttendanceReport allStaff={[STAFF[0]]} />)
    await waitForPending('attendance')

    await settle('attendance', [attRow('staff-a', '2026-08-20')])
    await settle('attendance_breaks', [])
    await settle('scheduled_shifts', [])
    await waitFor(() => expect(presentCount('Ann')).toBe('1'))

    // The abandoned run fails. Its error belongs to a selection nobody is looking at.
    await act(async () => {
      stale.resolve({ data: null, error: { message: 'Bad Request' } })
      await Promise.resolve()
    })
    await flush()

    expect(screen.queryByText(/could not load/i)).toBeNull()
    expect(presentCount('Ann')).toBe('1')
  })
})
