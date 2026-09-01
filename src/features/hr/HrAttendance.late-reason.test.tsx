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
  const makeQuery = (rows: unknown[]) => {
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'gte', 'lte', 'in', 'order', 'limit', 'update']) q[m] = () => q
    q.upsert = (row: Record<string, unknown>) => { writes.push(row); return q }
    q.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null })
    q.single = q.maybeSingle
    q.then = (onOk: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(onOk)
    return q
  }
  return { tables, writes, rpcs, makeQuery }
})

vi.mock('../../shared/lib/supabase', () => ({
  supabase: {
    from: (table: string) => h.makeQuery(h.tables[table] ?? []),
    rpc: (fn: string, args: unknown) => { h.rpcs.push({ fn, args }); return Promise.resolve({ data: 1, error: null }) },
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
    h.tables.system_rules = [{ value: '5' }]
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
})
