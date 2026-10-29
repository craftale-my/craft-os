// @vitest-environment jsdom
//
// A missing or wrong staff.supervisor_id used to be fixable only by
// hand-written SQL against production. This pins the two rules that make the
// profile-page picker safe to use instead:
//
//   1. A staff member is never offered as their own supervisor — the DB has
//      a CHECK constraint forbidding supervisor_id = id, so an unfiltered
//      list would offer a choice guaranteed to fail on save.
//   2. Choosing a supervisor actually reaches the save payload under the
//      `supervisor_id` column.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import type { Staff } from '../../shared/types'

const h = vi.hoisted(() => {
  const tables: Record<string, unknown[]> = {}
  const writes: { table: string; payload: Record<string, unknown> }[] = []
  // `rows` is read fresh from h.tables[table] on every `.from(table)` call and
  // handed back as a COPY (`rows.slice()`) — never the live array reference —
  // so a later mutation of h.tables[table] can't retroactively change what an
  // already-resolved query returned. This is the mock-aliasing trap this
  // repo's test harnesses have hit twice before.
  const makeQuery = (table: string, rows: unknown[]) => {
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'order']) q[m] = () => q
    q.update = (payload: Record<string, unknown>) => { writes.push({ table, payload }); return q }
    q.then = (onOk: (v: unknown) => unknown) =>
      Promise.resolve({ data: rows.slice(), error: null }).then(onOk)
    return q
  }
  return { tables, writes, makeQuery }
})

vi.mock('../../shared/lib/supabase', () => ({
  supabase: {
    from: (table: string) => h.makeQuery(table, h.tables[table] ?? []),
    rpc: () => Promise.resolve({ data: 1, error: null }),
  },
}))

vi.mock('./privateApi', () => ({
  fetchStaffPrivate: async () => null,
  saveStaffPrivate: async () => {},
  fetchManagerNotes: async () => null,
  saveManagerNotes: async () => {},
}))

const { PersonalInfoTab, supervisorOptions } = await import('./StaffProfile')
const { LookupsProvider } = await import('../../shared/lib/lookups')

const TARGET = { id: 'staff-1', name: 'Ali', status: 'active', supervisor_id: null,
  rank: 'junior', level: 1, xp: 0, department: null, branch: null, employment_type: null,
  working_experience: null, education: null, nickname: null, gender: null, contact_number: null,
  address: null, job_title_id: null, confirmation_date: null,
} as unknown as Staff

const OTHER_ACTIVE = { id: 'sup-1', name: 'Manager Mei', status: 'active' } as const
const OTHER_ACTIVE_2 = { id: 'sup-2', name: 'Manager Wong', status: 'active' } as const

function renderTab(staff: Staff, onSaved: () => void = () => {}) {
  return render(
    <LookupsProvider>
      <PersonalInfoTab staff={staff} priv={null} isSelf={false} isManager={true} email="ali@x.com" authEmail="ali@x.com" onSaved={onSaved} />
    </LookupsProvider>
  )
}

// The label/select pair isn't linked via htmlFor/id, so getByLabelText can't
// find it — walk from the "Supervisor" label text to its sibling <select>.
function getSupervisorSelect(): HTMLSelectElement {
  // "Supervisor" also appears as a Rank <option> (RANK_LABELS.supervisor),
  // so the match must be scoped to the field's <label> element specifically.
  const label = screen.getByText('Supervisor', { selector: 'label' })
  return within(label.parentElement as HTMLElement).getByRole('combobox') as HTMLSelectElement
}

beforeEach(() => {
  h.writes.length = 0
  h.tables.staff = [TARGET, OTHER_ACTIVE, OTHER_ACTIVE_2]
  h.tables.roles = []
  h.tables.departments = []
  h.tables.employment_types = []
  h.tables.system_role_permissions = []
})
afterEach(() => cleanup())

describe('supervisorOptions (pure)', () => {
  it('never offers the staff member as their own supervisor', () => {
    const pool = [TARGET, OTHER_ACTIVE, OTHER_ACTIVE_2]
    const opts = supervisorOptions(pool, TARGET)
    expect(opts.some(o => o.slug === TARGET.id)).toBe(false)
    expect(opts.map(o => o.slug).sort()).toEqual(['sup-1', 'sup-2'])
  })

  it('excludes inactive staff from the general pool', () => {
    const resigned = { id: 'sup-3', name: 'Old Boss', status: 'resigned' } as const
    const opts = supervisorOptions([TARGET, OTHER_ACTIVE, resigned], TARGET)
    expect(opts.some(o => o.slug === 'sup-3')).toBe(false)
  })

  it('pins the current supervisor even if they are no longer active, so Save cannot silently unassign them', () => {
    const resignedSupervisor = { id: 'sup-9', name: 'Old Boss', status: 'resigned' } as const
    const staffWithResignedSupervisor = { ...TARGET, supervisor_id: 'sup-9' } as unknown as Staff
    const opts = supervisorOptions([TARGET, OTHER_ACTIVE, resignedSupervisor], staffWithResignedSupervisor)
    expect(opts[0]).toEqual({ slug: 'sup-9', name: 'Old Boss (inactive)' })
  })

  it('does not blow up when the current supervisor cannot be found in the pool at all', () => {
    const staffWithUnknownSupervisor = { ...TARGET, supervisor_id: 'ghost' } as unknown as Staff
    const opts = supervisorOptions([TARGET, OTHER_ACTIVE], staffWithUnknownSupervisor)
    expect(opts.some(o => o.slug === 'ghost')).toBe(false)
    expect(opts.map(o => o.slug)).toEqual(['sup-1'])
  })
})

describe('Supervisor picker in the profile page', () => {
  it('does not render the staff member themselves as a choice', async () => {
    renderTab(TARGET)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await waitFor(() => getSupervisorSelect())
    const select = getSupervisorSelect()
    const optionNames = Array.from(select.options).map(o => o.value)
    expect(optionNames).not.toContain(TARGET.id)
    expect(optionNames).toEqual(expect.arrayContaining(['sup-1', 'sup-2']))
  })

  it('writes the chosen supervisor to supervisor_id in the save payload', async () => {
    renderTab(TARGET)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await waitFor(() => getSupervisorSelect())

    fireEvent.change(getSupervisorSelect(), { target: { value: 'sup-2' } })
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }))

    await waitFor(() => expect(h.writes).toHaveLength(1))
    expect(h.writes[0].table).toBe('staff')
    expect(h.writes[0].payload).toMatchObject({ supervisor_id: 'sup-2' })
  })

  it('saves null, not empty string, when no supervisor is chosen', async () => {
    renderTab(TARGET)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await waitFor(() => getSupervisorSelect())

    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }))

    await waitFor(() => expect(h.writes).toHaveLength(1))
    expect(h.writes[0].payload).toMatchObject({ supervisor_id: null })
  })
})

describe('Supervisor read-only row on a staff member\'s own profile', () => {
  // The editable Supervisor control is rightly hidden from a staff member —
  // only a manager may reassign it. But hiding the read-only *display* too
  // meant a staff member could never see who their own supervisor was, even
  // though nothing about that value is sensitive and they're the person most
  // affected by it being wrong or missing. This pins: the display shows for
  // isSelf even when isManager is false, and the editable control stays
  // hidden — widening who can *see* the value must not widen who can edit it.
  const staffWithSupervisor = { ...TARGET, supervisor_id: 'sup-1' } as unknown as Staff

  it('shows the read-only Supervisor row to a staff member viewing their own profile', async () => {
    render(
      <LookupsProvider>
        <PersonalInfoTab staff={staffWithSupervisor} priv={null} isSelf={true} isManager={false}
          email="ali@x.com" authEmail="ali@x.com" onSaved={() => {}} />
      </LookupsProvider>
    )
    await waitFor(() => expect(screen.getByText('Supervisor')).toBeTruthy())
    await waitFor(() => expect(screen.getByText('Manager Mei')).toBeTruthy())
  })

  it('does not offer the editable Supervisor control to a staff member viewing their own profile', async () => {
    render(
      <LookupsProvider>
        <PersonalInfoTab staff={staffWithSupervisor} priv={null} isSelf={true} isManager={false}
          email="ali@x.com" authEmail="ali@x.com" onSaved={() => {}} />
      </LookupsProvider>
    )
    await waitFor(() => expect(screen.getByText('Supervisor')).toBeTruthy())
    // Own profile is still editable (isSelf), but the Supervisor field itself
    // must stay read-only — no combobox should render for it even in edit mode.
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Save Changes/i })).toBeTruthy())
    expect(screen.queryByText('Supervisor', { selector: 'label' })).toBeNull()
  })
})
