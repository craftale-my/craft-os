// @vitest-environment jsdom
//
// Excusing a lateness goes through the excuse_lateness() RPC, which
// authorises the caller itself (see the migration comment in
// supabase/migration-2026-09-02-late-reason-notifications.sql). The "Excuse"
// button in DailyRoster must only appear for someone that function would
// actually accept — showing it more widely produces a click the database
// rejects while the UI implies it worked.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'

const h = vi.hoisted(() => {
  const tables: Record<string, unknown[]> = {}
  const rpcs: { fn: string; args: unknown }[] = []
  // Configurable per-test: what excuse_lateness() should hand back.
  let excuseResult: { data: unknown; error: { message: string } | null } = { data: true, error: null }
  // `rows` is read from h.tables[table] fresh on every `.from(table)` call
  // (see the mock below), and handed back here as a COPY — never the live
  // array reference — so a later mutation of h.tables[table] can't
  // retroactively change what an already-resolved query returned (the
  // aliasing trap the harness family hit before).
  const makeQuery = (rows: unknown[]) => {
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'order']) q[m] = () => q
    q.then = (onOk: (v: unknown) => unknown) =>
      Promise.resolve({ data: rows.slice(), error: null }).then(onOk)
    return q
  }
  return { tables, rpcs, makeQuery, get excuseResult() { return excuseResult }, setExcuseResult: (r: typeof excuseResult) => { excuseResult = r } }
})

vi.mock('../../shared/lib/supabase', () => ({
  supabase: {
    from: (table: string) => h.makeQuery(h.tables[table] ?? []),
    rpc: (fn: string, args: unknown) => {
      h.rpcs.push({ fn, args })
      if (fn === 'excuse_lateness') {
        const result = h.excuseResult
        // Model the real excuse_lateness() side effect: on success the
        // database has already committed late_excused = true by the time the
        // RPC returns, so the roster's subsequent reload sees it. Builds a
        // fresh array of fresh objects (never mutates the existing rows or
        // reuses the old array reference) — the aliasing trap this harness
        // family hit before.
        if (!result.error) {
          const id = (args as { p_attendance_id: string }).p_attendance_id
          h.tables.attendance = (h.tables.attendance ?? []).map(r =>
            (r as { id: string }).id === id ? { ...(r as object), late_excused: true } : { ...(r as object) }
          )
        }
        return Promise.resolve(result)
      }
      return Promise.resolve({ data: 1, error: null })
    },
  },
}))

const { DailyRoster } = await import('./HrAttendance')

beforeEach(() => {
  h.rpcs.length = 0
  h.tables.attendance = []
  h.tables.attendance_breaks = []
  h.setExcuseResult({ data: true, error: null })
})
afterEach(() => cleanup())

describe('豁免的按钮只给真正有权限的人看', () => {
  it('shows Excuse to the staff member’s own supervisor', async () => {
    h.tables.staff = [{ id: 'staff-1', name: 'Ali', supervisor_id: 'sup-1', rank: 'junior' }]
    h.tables.attendance = [{ id: 'a1', staff_id: 'staff-1', date: '2026-09-02', status: 'late', late_minutes: 12, late_reason_code: 'traffic', late_excused: false }]
    render(<DailyRoster allStaff={h.tables.staff as never} managerId="sup-1" />)
    await waitFor(() => expect(screen.getByText('Excuse')).toBeTruthy())
  })

  it('hides Excuse from a supervisor who is not theirs, because RLS would reject it', async () => {
    h.tables.staff = [{ id: 'staff-1', name: 'Ali', supervisor_id: 'sup-9', rank: 'junior' }]
    h.tables.attendance = [{ id: 'a1', staff_id: 'staff-1', date: '2026-09-02', status: 'late', late_minutes: 12, late_excused: false }]
    render(<DailyRoster allStaff={h.tables.staff as never} managerId="sup-1" />)
    await waitFor(() => screen.getByText('Ali'))
    expect(screen.queryByText('Excuse')).toBeNull()
  })

  it('shows Excuse to a manager-rank staff member even when not the supervisor', async () => {
    h.tables.staff = [{ id: 'staff-1', name: 'Ali', supervisor_id: 'sup-9', rank: 'junior' }, { id: 'mgr-1', name: 'Manager', rank: 'manager', system_role: 'staff' }]
    h.tables.attendance = [{ id: 'a1', staff_id: 'staff-1', date: '2026-09-02', status: 'late', late_minutes: 12, late_excused: false }]
    render(<DailyRoster allStaff={h.tables.staff as never} managerId="mgr-1" />)
    await waitFor(() => expect(screen.getByText('Excuse')).toBeTruthy())
  })

  it('shows Excuse to an admin/owner system_role even when not the supervisor', async () => {
    h.tables.staff = [{ id: 'staff-1', name: 'Ali', supervisor_id: 'sup-9', rank: 'junior' }, { id: 'admin-1', name: 'Admin', rank: 'junior', system_role: 'admin' }]
    h.tables.attendance = [{ id: 'a1', staff_id: 'staff-1', date: '2026-09-02', status: 'late', late_minutes: 12, late_excused: false }]
    render(<DailyRoster allStaff={h.tables.staff as never} managerId="admin-1" />)
    await waitFor(() => expect(screen.getByText('Excuse')).toBeTruthy())
  })

  it('hides Excuse from a plain supervisor-rank colleague who is not this staff member’s supervisor_id', async () => {
    // rank 'supervisor' is not the same as rank 'manager' in the RPC's
    // predicate — it must NOT be treated as manager-tier.
    h.tables.staff = [{ id: 'staff-1', name: 'Ali', supervisor_id: 'sup-9', rank: 'junior' }, { id: 'other-sup', name: 'Other', rank: 'supervisor', system_role: 'supervisor' }]
    h.tables.attendance = [{ id: 'a1', staff_id: 'staff-1', date: '2026-09-02', status: 'late', late_minutes: 12, late_excused: false }]
    render(<DailyRoster allStaff={h.tables.staff as never} managerId="other-sup" />)
    await waitFor(() => screen.getByText('Ali'))
    expect(screen.queryByText('Excuse')).toBeNull()
  })

  it('never shows Excuse once the record is already excused, regardless of who is looking', async () => {
    h.tables.staff = [{ id: 'staff-1', name: 'Ali', supervisor_id: 'sup-1', rank: 'junior' }]
    h.tables.attendance = [{ id: 'a1', staff_id: 'staff-1', date: '2026-09-02', status: 'late', late_minutes: 12, late_excused: true }]
    render(<DailyRoster allStaff={h.tables.staff as never} managerId="sup-1" />)
    await waitFor(() => expect(screen.getByText('Excused')).toBeTruthy())
    expect(screen.queryByText('Excuse')).toBeNull()
  })
})

describe('豁免的动作与失败可见性', () => {
  it('calls excuse_lateness with the attendance id and shows Excused after it lands', async () => {
    h.tables.staff = [{ id: 'staff-1', name: 'Ali', supervisor_id: 'sup-1', rank: 'junior' }]
    h.tables.attendance = [{ id: 'a1', staff_id: 'staff-1', date: '2026-09-02', status: 'late', late_minutes: 12, late_excused: false }]
    render(<DailyRoster allStaff={h.tables.staff as never} managerId="sup-1" />)
    await waitFor(() => screen.getByText('Excuse'))
    fireEvent.click(screen.getByText('Excuse'))

    // The mocked RPC commits late_excused = true as its side effect (see the
    // supabase mock above) before resolving, exactly like the real database
    // would — so the roster's reload afterwards picks it up.
    await waitFor(() => expect(screen.getByText('Excused')).toBeTruthy())
    expect(h.rpcs.find(r => r.fn === 'excuse_lateness')?.args).toEqual({ p_attendance_id: 'a1' })
    expect(screen.queryByText('Excuse')).toBeNull()
  })

  it('shows a roster-level error banner, not a silent failure, when the RPC is rejected', async () => {
    h.tables.staff = [{ id: 'staff-1', name: 'Ali', supervisor_id: 'sup-1', rank: 'junior' }]
    h.tables.attendance = [{ id: 'a1', staff_id: 'staff-1', date: '2026-09-02', status: 'late', late_minutes: 12, late_excused: false }]
    h.setExcuseResult({ data: null, error: { message: 'not authorised' } })
    render(<DailyRoster allStaff={h.tables.staff as never} managerId="sup-1" />)
    await waitFor(() => screen.getByText('Excuse'))
    fireEvent.click(screen.getByText('Excuse'))
    await waitFor(() => expect(screen.getByText(/Could not excuse this lateness/i)).toBeTruthy())
    expect(screen.getByText(/not authorised/i)).toBeTruthy()
    // Nothing changed server-side, so the button must still be there to retry.
    expect(screen.getByText('Excuse')).toBeTruthy()
  })
})

describe('迟到原因显示在经理的名单上', () => {
  it('shows the reason code label and free-text note beside the late record', async () => {
    h.tables.staff = [{ id: 'staff-1', name: 'Ali', supervisor_id: 'sup-1', rank: 'junior' }]
    h.tables.attendance = [{ id: 'a1', staff_id: 'staff-1', date: '2026-09-02', status: 'late', late_minutes: 12, late_reason_code: 'traffic', late_reason: 'Accident on the LDP', late_excused: false }]
    render(<DailyRoster allStaff={h.tables.staff as never} managerId="sup-1" />)
    await waitFor(() => expect(screen.getByText(/Traffic jam/)).toBeTruthy())
    expect(screen.getByText(/Accident on the LDP/)).toBeTruthy()
  })
})
