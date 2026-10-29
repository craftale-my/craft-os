// @vitest-environment jsdom
//
// The Personal tab must only show IC / DOB / phone / address from the
// staff_private row. A viewer RLS hides that row from (priv === null) sees
// "Restricted", and saving the form must send phone/address to staff_private
// rather than to staff.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import type { Staff, StaffPrivate } from '../../shared/types'

const h = vi.hoisted(() => {
  const tables: Record<string, unknown[]> = {}
  const writes: { table: string; payload: Record<string, unknown> }[] = []
  const makeQuery = (table: string, rows: unknown[]) => {
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'order']) q[m] = () => q
    q.update = (payload: Record<string, unknown>) => { writes.push({ table, payload }); return q }
    q.then = (onOk: (v: unknown) => unknown) =>
      Promise.resolve({ data: rows.slice(), error: null }).then(onOk)
    return q
  }
  return {
    tables, writes, makeQuery,
    saveStaffPrivate: vi.fn(async () => {}),
  }
})

vi.mock('../../shared/lib/supabase', () => ({
  supabase: {
    from: (table: string) => h.makeQuery(table, h.tables[table] ?? []),
    rpc: () => Promise.resolve({ data: 1, error: null }),
  },
}))

vi.mock('./privateApi', () => ({
  fetchStaffPrivate: vi.fn(async () => null),
  saveStaffPrivate: h.saveStaffPrivate,
  fetchManagerNotes: vi.fn(async () => null),
  saveManagerNotes: vi.fn(async () => {}),
}))

const { PersonalInfoTab } = await import('./StaffProfile')
const { LookupsProvider } = await import('../../shared/lib/lookups')

const STAFF = { id: 'staff-1', name: 'Ali', status: 'active', supervisor_id: null,
  rank: 'junior', level: 1, xp: 0, department: null, branch: null, employment_type: null,
  working_experience: null, education: null, nickname: null, gender: null,
  job_title_id: null, confirmation_date: null,
} as unknown as Staff

const PRIV: StaffPrivate = {
  staff_id: 'staff-1', ic_number: '900101-14-5555', date_of_birth: '1990-01-01',
  contact_number: '012-3456789', address: '1 Jalan Test', updated_at: '2026-10-23T00:00:00Z',
}

function renderTab(props: { priv: StaffPrivate | null; isSelf: boolean; isManager: boolean }) {
  return render(
    <LookupsProvider>
      <PersonalInfoTab staff={STAFF} email="ali@x.com" authEmail="ali@x.com" onSaved={() => {}} {...props} />
    </LookupsProvider>
  )
}

beforeEach(() => {
  h.writes.length = 0
  h.saveStaffPrivate.mockClear()
  h.tables.staff = [STAFF]
  h.tables.roles = []
  h.tables.departments = []
  h.tables.employment_types = []
  h.tables.system_role_permissions = []
})
afterEach(() => cleanup())

describe('PersonalInfoTab private fields', () => {
  it('shows Restricted for all four fields when the private row is hidden', async () => {
    renderTab({ priv: null, isSelf: false, isManager: false })
    await waitFor(() => expect(screen.getAllByText('Restricted')).toHaveLength(4))
    expect(screen.queryByText('900101-14-5555')).toBeNull()
  })

  it('shows the values when the private row is visible', async () => {
    renderTab({ priv: PRIV, isSelf: true, isManager: false })
    await waitFor(() => expect(screen.getByText('900101-14-5555')).toBeTruthy())
    expect(screen.getByText('012-3456789')).toBeTruthy()
    expect(screen.getByText('1 Jalan Test')).toBeTruthy()
    expect(screen.queryByText('Restricted')).toBeNull()
  })

  it('saves a changed phone to staff_private, not to staff', async () => {
    renderTab({ priv: PRIV, isSelf: true, isManager: false })
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const phone = screen.getByDisplayValue('012-3456789')
    fireEvent.change(phone, { target: { value: '019-0000000' } })
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }))

    await waitFor(() => expect(h.saveStaffPrivate).toHaveBeenCalledTimes(1))
    expect(h.saveStaffPrivate).toHaveBeenCalledWith('staff-1', { contact_number: '019-0000000', address: '1 Jalan Test' })
    const staffWrite = h.writes.find(w => w.table === 'staff')!
    expect(staffWrite.payload).not.toHaveProperty('contact_number')
    expect(staffWrite.payload).not.toHaveProperty('address')
  })

  it('does not touch staff_private when phone and address are unchanged', async () => {
    renderTab({ priv: PRIV, isSelf: true, isManager: false })
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }))
    // Edit mode exiting means save() ran to completion, so the negative
    // assertion below cannot pass just because save() hadn't finished yet.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy())
    expect(h.writes.some(w => w.table === 'staff')).toBe(true)
    expect(h.saveStaffPrivate).not.toHaveBeenCalled()
  })
})
