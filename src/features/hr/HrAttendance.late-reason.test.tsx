// @vitest-environment jsdom
//
// Clocking in late must not complete until the staff member says why. The
// reason travels in the SAME upsert as the attendance row, so a late row can
// never exist without its reason.
import { useEffect } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import type { Staff } from '../../shared/types'

const h = vi.hoisted(() => {
  const tables: Record<string, unknown[]> = {}
  const writes: Record<string, unknown>[] = []
  const rpcs: { fn: string; args: unknown }[] = []
  const makeQuery = (table: string, rows: unknown[]) => {
    const q: Record<string, unknown> = {}
    // `system_rules` is looked up by `.eq('key', ...)`; pin that filter so a
    // typo in the key string falls through to "no row" instead of matching by
    // table alone (which would silently return whatever the fixture holds).
    let keyFilter: string | undefined
    for (const m of ['select', 'gte', 'lte', 'in', 'order', 'limit', 'update']) q[m] = () => q
    q.eq = (field: string, value: unknown) => {
      if (table === 'system_rules' && field === 'key') keyFilter = value as string
      return q
    }
    q.upsert = (row: Record<string, unknown>) => { writes.push(row); return q }
    q.maybeSingle = () => {
      const matched = keyFilter === undefined
        ? rows
        : rows.filter(r => (r as Record<string, unknown>).key === keyFilter)
      return Promise.resolve({ data: matched[0] ?? null, error: null })
    }
    q.single = q.maybeSingle
    q.then = (onOk: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(onOk)
    return q
  }
  return { tables, writes, rpcs, makeQuery }
})

vi.mock('../../shared/lib/supabase', () => ({
  supabase: {
    from: (table: string) => h.makeQuery(table, h.tables[table] ?? []),
    rpc: (fn: string, args: unknown) => {
      h.rpcs.push({ fn, args })
      // Default: notify_late's happy path — enabled, and someone in every
      // tier was reached. Individual tests override via vi.spyOn to drive
      // the other branches (error, disabled, no supervisor reached).
      return Promise.resolve({ data: { enabled: true, staff: 1, supervisor: 1 }, error: null })
    },
  },
}))

// The camera/GPS modal cannot run in jsdom; drive its onDone directly.
vi.mock('./ClockModal', () => ({
  ClockModal: ({ onDone }: { onDone: (r: unknown) => void }) => {
    useEffect(() => { onDone({ photoUrl: 'x', lat: 0, lng: 0, distanceM: 0 }) }, [onDone])
    return null
  },
}))

const { MyAttendance } = await import('./HrAttendance')
const STAFF = { id: 'staff-1', branch: 'HQ' } as unknown as Staff
const DAY_SHIFT = { name: 'Day', department: 'barista', color: '#8B6344', start_time: '09:30:00', end_time: '18:00:00', break1_duration_minutes: 0, break2_duration_minutes: 0 }

// `Clock In` alone is ambiguous — the GPS/selfie footnote below the card also
// says "clock in/out" — so the button is addressed by role.
const clockInBtn = () => screen.getByRole('button', { name: /Clock In/i })

beforeEach(() => {
  h.writes.length = 0
  h.rpcs.length = 0
  h.tables.attendance = []
  h.tables.scheduled_shifts = [{ date: '2026-09-02', leave_type: null, shift_type: DAY_SHIFT }]
  h.tables.system_rules = []
  vi.setSystemTime(new Date(2026, 8, 2, 9, 42, 0))
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('迟到必须说明原因', () => {
  it('asks why before the clock-in is written', async () => {
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => clockInBtn())
    fireEvent.click(clockInBtn())
    await waitFor(() => expect(screen.getByText(/12 minutes late/i)).toBeTruthy())
    expect(h.writes).toHaveLength(0)
  })

  it('carries the reason into the same write', async () => {
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => clockInBtn())
    fireEvent.click(clockInBtn())
    await waitFor(() => screen.getByText(/12 minutes late/i))
    fireEvent.click(screen.getByText('Traffic jam'))
    fireEvent.click(screen.getByText(/Submit/i))
    await waitFor(() => expect(h.writes).toHaveLength(1))
    expect(h.writes[0]).toMatchObject({ status: 'late', late_minutes: 12, late_reason_code: 'traffic' })
  })

  it('does not ask a punctual staff member anything', async () => {
    vi.setSystemTime(new Date(2026, 8, 2, 9, 30, 40))
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => clockInBtn())
    fireEvent.click(clockInBtn())
    await waitFor(() => expect(h.writes).toHaveLength(1))
    expect(h.writes[0]).toMatchObject({ status: 'present', late_minutes: 0 })
    // late_reason_code/late_reason are append-only in the database: a punctual
    // write must omit the keys outright rather than send explicit nulls, so a
    // future re-upsert of this same row is never read as "changing" a reason
    // that was never there. Sending `null` here is unreachable today, but the
    // regression it protects against is a hard clock-in failure the moment it
    // becomes reachable — so it's pinned at the key level, not just the value.
    expect(h.writes[0]).not.toHaveProperty('late_reason_code')
    expect(h.writes[0]).not.toHaveProperty('late_reason')
    // The month-stats card always renders a "Late" tally, so this asserts the
    // absence of the step itself rather than of the word.
    expect(screen.queryByText(/minutes late for your/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /Submit/i })).toBeNull()
  })

  it('keeps the reason on screen when the write does not land', async () => {
    // h.tables.attendance stays [], so the upsert's .select() returns no row —
    // exactly how RLS rejects a write: no error, nothing saved.
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => clockInBtn())
    fireEvent.click(clockInBtn())
    await waitFor(() => screen.getByText(/12 minutes late/i))
    fireEvent.click(screen.getByText('Traffic jam'))
    fireEvent.click(screen.getByText(/Submit/i))

    // The failure has to be legible INSIDE the step. The step is a full-screen
    // overlay, so a banner in the card underneath it is hidden by the dimmer.
    const step = await screen.findByRole('dialog')
    const alert = within(step).getByRole('alert')
    expect(alert.textContent).toMatch(/Clock in FAILED/i)
    expect(alert.textContent).toMatch(/Nothing was saved/i)
    // The step stays up with the reason still chosen — nothing is thrown away.
    expect(within(step).getByText(/12 minutes late/i)).toBeTruthy()
    expect(screen.queryByText(/Clocked in at/i)).toBeNull()
  })

  it('closes and confirms once the write lands', async () => {
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => clockInBtn())
    fireEvent.click(clockInBtn())
    await waitFor(() => screen.getByText(/12 minutes late/i))
    fireEvent.click(screen.getByText('Traffic jam'))
    // From here the upsert's .select() hands back the row it created.
    h.tables.attendance = [{
      id: 'att-1', staff_id: 'staff-1', date: '2026-09-02', status: 'late',
      clock_in: new Date(2026, 8, 2, 9, 42, 0).toISOString(), clock_out: null,
      late_minutes: 12, late_reason_code: 'traffic', late_reason: null,
    }]
    fireEvent.click(screen.getByText(/Submit/i))

    // Two things say "late by 12 min" once it lands — the success banner and
    // the card's badge — so the banner is matched on its full sentence.
    await waitFor(() => expect(screen.getByText(/Clocked in at .*late by 12 min/i)).toBeTruthy())
    expect(screen.queryByText(/12 minutes late/i)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('records the arrival, not the moment the reason was typed', async () => {
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => clockInBtn())
    fireEvent.click(clockInBtn())
    await waitFor(() => screen.getByText(/12 minutes late/i))
    // Thinking about the answer for eight minutes must not rewrite when they
    // arrived: the selfie and the GPS check both happened at 9:42.
    vi.setSystemTime(new Date(2026, 8, 2, 9, 50, 0))
    fireEvent.click(screen.getByText('Traffic jam'))
    fireEvent.click(screen.getByText(/Submit/i))
    await waitFor(() => expect(h.writes).toHaveLength(1))
    // To the minute: shouldAdvanceTime lets real milliseconds through.
    const clockIn = new Date(h.writes[0].clock_in as string)
    expect([clockIn.getHours(), clockIn.getMinutes()]).toEqual([9, 42])
    expect(h.writes[0]).toMatchObject({ late_minutes: 12 })
  })

  it('demands a written explanation past the threshold HR configured', async () => {
    // system_rules.late_reason_written_threshold = 5, so 12 minutes needs words.
    h.tables.system_rules = [{ key: 'late_reason_written_threshold', value: '5' }]
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => clockInBtn())
    fireEvent.click(clockInBtn())
    await waitFor(() => screen.getByText(/12 minutes late/i))
    fireEvent.click(screen.getByText('Traffic jam'))

    const submit = screen.getByRole('button', { name: /Submit/i })
    expect(submit.hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Accident on the LDP' } })
    expect(submit.hasAttribute('disabled')).toBe(false)

    fireEvent.click(submit)
    await waitFor(() => expect(h.writes).toHaveLength(1))
    expect(h.writes[0]).toMatchObject({
      late_reason_code: 'traffic', late_reason: 'Accident on the LDP',
    })
  })

  it('does not let a blank threshold value force written prose on every late minute', async () => {
    // system_rules.value is `text not null`, so a blank string is reachable —
    // and Number('') is 0, which would demand a written explanation for a
    // 1-minute lateness. The constant (15) must apply instead.
    h.tables.system_rules = [{ key: 'late_reason_written_threshold', value: '' }]
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => clockInBtn())
    fireEvent.click(clockInBtn())
    await waitFor(() => screen.getByText(/12 minutes late/i))
    fireEvent.click(screen.getByText('Traffic jam'))
    expect(screen.getByRole('button', { name: /Submit/i }).hasAttribute('disabled')).toBe(false)
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})

// attendance_guard_late_update() (supabase/migration-2026-09-02-late-reason-
// notifications.sql) lets the clock-in always land, but silently clamps
// status/late_minutes back to whatever the row already carried when the
// proposed write would erase a verdict a manager or the system already
// recorded (an absent sweep, a hand-marked late, an approved leave). Before
// this fix, the success message was built from this component's OWN computed
// lateness, not from what the database actually saved — so a staff member
// clocked in onto an 'absent' row saw a clean "Clocked in ✓" while the stored
// row still said absent, with no hint a manager needs to fix it.
//
// The mock's upsert never actually mutates h.tables.attendance (see
// makeQuery above — `q.upsert` only records into `h.writes`); `.select()`
// always hands back whatever the table currently holds. That is the seam:
// seeding the table with the PRE-EXISTING (unclamped-by-the-write) row before
// the write fires models the database returning that same row untouched,
// exactly as the real trigger's silent reset would.
describe('数据库把写入钳制回原状态时,必须如实告知——不能只报"打卡成功"', () => {
  it('tells a punctual staff member their record still shows Absent when the write was clamped', async () => {
    // Punctual (9:30:40 vs a 9:30:00 shift start — the same instant the
    // "does not ask a punctual staff member anything" test above uses),
    // so this component intends status: 'present'. But the row already
    // carries 'absent' from the hourly auto-absent sweep, and the guard
    // resets status/late_minutes back to OLD rather than let a bare
    // clock-in erase that verdict.
    vi.setSystemTime(new Date(2026, 8, 2, 9, 30, 40))
    h.tables.attendance = [{
      id: 'att-1', staff_id: 'staff-1', date: '2026-09-02', status: 'absent',
      late_minutes: 0, clock_in: null, clock_out: null,
    }]
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => clockInBtn())
    fireEvent.click(clockInBtn())

    // The clock-in itself still lands and is still reported as successful —
    // it was. This is an added caveat, not a failure. Matched on the
    // checkmark, not just "Clocked in at": the card's own status line renders
    // the same words with no ✓, so a bare match is ambiguous the moment it
    // also renders (see the disambiguation the notification tests already
    // need for the same reason).
    await waitFor(() => expect(h.writes).toHaveLength(1))
    await waitFor(() => expect(screen.getByText(/Clocked in at .*✓/i)).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText(/still recorded as Absent/i)).toBeTruthy()
    expect(screen.getByText(/ask your manager/i)).toBeTruthy()
  })

  it('tells a late staff member their record still shows Absent when the row was already absent', async () => {
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => clockInBtn())
    fireEvent.click(clockInBtn())
    await waitFor(() => screen.getByText(/12 minutes late/i))
    fireEvent.click(screen.getByText('Traffic jam'))
    // The row was already 'absent' before this clock-in — the guard refuses
    // to move it to 'late' and resets status/late_minutes back to OLD.
    h.tables.attendance = [{
      id: 'att-1', staff_id: 'staff-1', date: '2026-09-02', status: 'absent',
      clock_in: new Date(2026, 8, 2, 9, 42, 0).toISOString(), clock_out: null,
      late_minutes: 0,
    }]
    fireEvent.click(screen.getByText(/Submit/i))

    // Disambiguated the same way the notification tests below have to: the
    // card's own "Clocked in at" badge also renders alongside the banner.
    await waitFor(() => expect(screen.getByText(/Clocked in at .*late by 12 min/i)).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText(/still recorded as Absent/i)).toBeTruthy()
    expect(screen.getByText(/ask your manager/i)).toBeTruthy()
  })

  it('adds no caveat to a punctual clock-in that was not clamped', async () => {
    vi.setSystemTime(new Date(2026, 8, 2, 9, 30, 40))
    h.tables.attendance = [{
      id: 'att-1', staff_id: 'staff-1', date: '2026-09-02', status: 'present',
      late_minutes: 0, clock_in: null, clock_out: null,
    }]
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => clockInBtn())
    fireEvent.click(clockInBtn())

    // Anchored both ends: nothing may be appended after the checkmark.
    await waitFor(() => expect(screen.getByText(/^Clocked in at .* ✓$/)).toBeTruthy())
    expect(screen.queryByText(/still recorded as/i)).toBeNull()
    expect(screen.queryByText(/ask your manager/i)).toBeNull()
  })

  it('adds no caveat to a late clock-in that was not clamped — the row really is late', async () => {
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => clockInBtn())
    fireEvent.click(clockInBtn())
    await waitFor(() => screen.getByText(/12 minutes late/i))
    fireEvent.click(screen.getByText('Traffic jam'))
    h.tables.attendance = [{
      id: 'att-1', staff_id: 'staff-1', date: '2026-09-02', status: 'late',
      clock_in: new Date(2026, 8, 2, 9, 42, 0).toISOString(), clock_out: null,
      late_minutes: 12, late_reason_code: 'traffic', late_reason: null,
    }]
    fireEvent.click(screen.getByText(/Submit/i))

    // Anchored both ends, same as the notification tests below rely on.
    await waitFor(() => expect(screen.getByText(/^Clocked in at .*late by 12 min ⚠️$/)).toBeTruthy())
    expect(screen.queryByText(/still recorded as/i)).toBeNull()
    expect(screen.queryByText(/ask your manager/i)).toBeNull()
  })
})

describe('通知发送', () => {
  it('tells notify_late after the attendance row lands', async () => {
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => clockInBtn())
    fireEvent.click(clockInBtn())
    await waitFor(() => screen.getByText(/12 minutes late/i))
    fireEvent.click(screen.getByText('Traffic jam'))
    // From here the upsert's .select() hands back the row it created — same
    // seeding pattern as "closes and confirms once the write lands" above.
    h.tables.attendance = [{
      id: 'att-1', staff_id: 'staff-1', date: '2026-09-02', status: 'late',
      clock_in: new Date(2026, 8, 2, 9, 42, 0).toISOString(), clock_out: null,
      late_minutes: 12, late_reason_code: 'traffic', late_reason: null,
    }]
    fireEvent.click(screen.getByText(/Submit/i))
    await waitFor(() => expect(h.rpcs).toHaveLength(1))
    expect(h.rpcs[0].fn).toBe('notify_late')
    expect(h.rpcs[0].args).toMatchObject({
      p_staff_id: 'staff-1', p_date: '2026-09-02', p_late_minutes: 12, p_reason_code: 'traffic',
    })
  })

  it('still counts the clock-in as successful when the notification fails', async () => {
    const { supabase } = await import('../../shared/lib/supabase')
    vi.spyOn(supabase, 'rpc').mockResolvedValueOnce({ data: null, error: { message: 'boom' } } as never)
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => clockInBtn())
    fireEvent.click(clockInBtn())
    await waitFor(() => screen.getByText(/12 minutes late/i))
    fireEvent.click(screen.getByText('Traffic jam'))
    h.tables.attendance = [{
      id: 'att-1', staff_id: 'staff-1', date: '2026-09-02', status: 'late',
      clock_in: new Date(2026, 8, 2, 9, 42, 0).toISOString(), clock_out: null,
      late_minutes: 12, late_reason_code: 'traffic', late_reason: null,
    }]
    fireEvent.click(screen.getByText(/Submit/i))
    // The success banner still shows — a failed notification never undoes or
    // blocks the clock-in — but it now also names the failure. Matched on the
    // full sentence: the card's own "Clocked in at" badge also renders below
    // it, so a bare /Clocked in at/i match is ambiguous (see "closes and
    // confirms once the write lands" above for the same disambiguation).
    await waitFor(() => expect(screen.getByText(/Clocked in at .*late by 12 min/i)).toBeTruthy())
    expect(screen.getByText(/supervisor could not be notified/i)).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  // M2/M3: notify_late() now returns jsonb — { enabled, staff, supervisor } —
  // not a plain ok/error or a bare count. Each shape tells a different story
  // and the caller has to read `.data` instead of just `.error`.
  it('says nothing about a failure when notifications are turned off by configuration', async () => {
    const { supabase } = await import('../../shared/lib/supabase')
    vi.spyOn(supabase, 'rpc').mockResolvedValueOnce({
      data: { enabled: false, staff: 0, supervisor: 0 }, error: null,
    } as never)
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => clockInBtn())
    fireEvent.click(clockInBtn())
    await waitFor(() => screen.getByText(/12 minutes late/i))
    fireEvent.click(screen.getByText('Traffic jam'))
    h.tables.attendance = [{
      id: 'att-1', staff_id: 'staff-1', date: '2026-09-02', status: 'late',
      clock_in: new Date(2026, 8, 2, 9, 42, 0).toISOString(), clock_out: null,
      late_minutes: 12, late_reason_code: 'traffic', late_reason: null,
    }]
    fireEvent.click(screen.getByText(/Submit/i))
    // The clock-in still succeeded — an admin deliberately turned
    // notifications off, nothing is broken, so no failure text at all.
    await waitFor(() => expect(screen.getByText(/^Clocked in at .*late by 12 min ⚠️$/)).toBeTruthy())
    expect(screen.queryByText(/notif/i)).toBeNull()
    expect(screen.queryByText(/supervisor/i)).toBeNull()
  })

  it('says nobody in the supervisor tier was reached when notifications are enabled but supervisor is 0', async () => {
    const { supabase } = await import('../../shared/lib/supabase')
    vi.spyOn(supabase, 'rpc').mockResolvedValueOnce({
      data: { enabled: true, staff: 1, supervisor: 0 }, error: null,
    } as never)
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => clockInBtn())
    fireEvent.click(clockInBtn())
    await waitFor(() => screen.getByText(/12 minutes late/i))
    fireEvent.click(screen.getByText('Traffic jam'))
    h.tables.attendance = [{
      id: 'att-1', staff_id: 'staff-1', date: '2026-09-02', status: 'late',
      clock_in: new Date(2026, 8, 2, 9, 42, 0).toISOString(), clock_out: null,
      late_minutes: 12, late_reason_code: 'traffic', late_reason: null,
    }]
    fireEvent.click(screen.getByText(/Submit/i))
    // The staff-tier row landed (this is not the RPC-error case), but nobody
    // upstream did — this is the previously-invisible case, so it must be
    // named distinctly from "could not be notified" (which implies the call
    // itself failed).
    await waitFor(() => expect(screen.getByText(/Clocked in at .*late by 12 min/i)).toBeTruthy())
    expect(screen.getByText(/no supervisor was notified/i)).toBeTruthy()
  })

  it('reports plain success once the notification reaches at least one supervisor', async () => {
    const { supabase } = await import('../../shared/lib/supabase')
    vi.spyOn(supabase, 'rpc').mockResolvedValueOnce({
      data: { enabled: true, staff: 1, supervisor: 2 }, error: null,
    } as never)
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => clockInBtn())
    fireEvent.click(clockInBtn())
    await waitFor(() => screen.getByText(/12 minutes late/i))
    fireEvent.click(screen.getByText('Traffic jam'))
    h.tables.attendance = [{
      id: 'att-1', staff_id: 'staff-1', date: '2026-09-02', status: 'late',
      clock_in: new Date(2026, 8, 2, 9, 42, 0).toISOString(), clock_out: null,
      late_minutes: 12, late_reason_code: 'traffic', late_reason: null,
    }]
    fireEvent.click(screen.getByText(/Submit/i))
    await waitFor(() => expect(screen.getByText(/^Clocked in at .*late by 12 min ⚠️$/)).toBeTruthy())
    expect(screen.queryByText(/notif/i)).toBeNull()
    expect(screen.queryByText(/supervisor/i)).toBeNull()
  })

  it('still closes the dialog and confirms the clock-in when notify_late returns a null payload', async () => {
    // notified.error is null (the RPC call itself did not fail) but the jsonb
    // payload is missing — reachable if notify_late ever returns NULL. A raw
    // destructure of `.data` here used to throw AFTER the attendance row was
    // already saved, leaving the dialog stuck open forever with no error.
    const { supabase } = await import('../../shared/lib/supabase')
    vi.spyOn(supabase, 'rpc').mockResolvedValueOnce({ data: null, error: null } as never)
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => clockInBtn())
    fireEvent.click(clockInBtn())
    await waitFor(() => screen.getByText(/12 minutes late/i))
    fireEvent.click(screen.getByText('Traffic jam'))
    h.tables.attendance = [{
      id: 'att-1', staff_id: 'staff-1', date: '2026-09-02', status: 'late',
      clock_in: new Date(2026, 8, 2, 9, 42, 0).toISOString(), clock_out: null,
      late_minutes: 12, late_reason_code: 'traffic', late_reason: null,
    }]
    fireEvent.click(screen.getByText(/Submit/i))
    // The clock-in genuinely succeeded — the dialog must close and say so,
    // not sit open with no error and no way forward.
    await waitFor(() => expect(screen.getByText(/Clocked in at .*late by 12 min/i)).toBeTruthy())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('still closes the dialog and confirms the clock-in when notify_late returns a malformed payload', async () => {
    // Same failure mode, different shape: the fields are there but not the
    // expected types, so a naive `result.enabled` read wouldn't throw but
    // would silently do the wrong thing instead.
    const { supabase } = await import('../../shared/lib/supabase')
    vi.spyOn(supabase, 'rpc').mockResolvedValueOnce({ data: { unexpected: true }, error: null } as never)
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => clockInBtn())
    fireEvent.click(clockInBtn())
    await waitFor(() => screen.getByText(/12 minutes late/i))
    fireEvent.click(screen.getByText('Traffic jam'))
    h.tables.attendance = [{
      id: 'att-1', staff_id: 'staff-1', date: '2026-09-02', status: 'late',
      clock_in: new Date(2026, 8, 2, 9, 42, 0).toISOString(), clock_out: null,
      late_minutes: 12, late_reason_code: 'traffic', late_reason: null,
    }]
    fireEvent.click(screen.getByText(/Submit/i))
    await waitFor(() => expect(screen.getByText(/Clocked in at .*late by 12 min/i)).toBeTruthy())
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
