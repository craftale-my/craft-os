// @vitest-environment jsdom
//
// assignRole() (Settings.tsx, SystemRolesTab) used to fire its `staff` update
// with no `.select()` and no outcome check, then show "System role updated"
// unconditionally. A write RLS silently rejects comes back with no error and
// no rows — indistinguishable from success unless the returned row is
// checked (see src/shared/lib/db-write.ts). Worse, this branch just added
// staff_guard_authority_update() (supabase/migration-2026-09-02-late-reason-
// notifications.sql), which RAISES an explicit error when an owner who has
// demoted themselves below manager-tier tries to promote themselves back on
// their own row — a real, reachable failure this call used to paper over
// with a green toast.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import type { Staff } from '../../shared/types'

const h = vi.hoisted(() => {
  const tables: Record<string, unknown[]> = {}
  // Drives what the `staff` update's `.select()` hands back for the NEXT
  // write: a row models a write that landed, [] models one RLS silently
  // dropped, and an `error` models a raised exception such as
  // staff_guard_authority_update().
  let nextStaffWrite: { data: unknown[] | null; error: { message: string } | null } = { data: [], error: null }
  const setNextStaffWrite = (r: typeof nextStaffWrite) => { nextStaffWrite = r }
  const makeQuery = (table: string, rows: unknown[]) => {
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'order', 'update']) q[m] = () => q
    q.then = (onOk: (v: unknown) => unknown) => {
      // Every table other than the one write this file exercises just hands
      // back its seeded rows — departments/employment_types/
      // system_role_permissions for LookupsProvider's own fetch.
      if (table === 'staff') return Promise.resolve(nextStaffWrite).then(onOk)
      return Promise.resolve({ data: rows, error: null }).then(onOk)
    }
    return q
  }
  return { tables, makeQuery, setNextStaffWrite }
})

vi.mock('../../shared/lib/supabase', () => ({
  supabase: { from: (table: string) => h.makeQuery(table, h.tables[table] ?? []) },
}))

const { SystemRolesTab } = await import('./Settings')
const { LookupsProvider } = await import('../../shared/lib/lookups')

function renderTab(allStaff: Staff[]) {
  const onRefresh = vi.fn()
  render(
    <LookupsProvider>
      <SystemRolesTab allStaff={allStaff} onRefresh={onRefresh} />
    </LookupsProvider>
  )
  return { onRefresh }
}

// A copy of the row array every time — the mock-aliasing trap this repo has
// hit before (a shared reference lets one test's mutation leak into the
// next).
const OWNER: Staff = {
  id: 'staff-1', name: 'Alice Owner', rank: 'manager', system_role: 'owner', status: 'active',
} as unknown as Staff

beforeEach(() => {
  h.tables.departments = []
  h.tables.employment_types = []
  h.tables.system_role_permissions = []
  h.setNextStaffWrite({ data: [], error: null })
})
afterEach(() => cleanup())

const roleSelect = () => screen.getByRole('combobox')

describe('assignRole surfaces a write it cannot verify landed', () => {
  it('does not show the success toast when staff_guard_authority_update() rejects the write', async () => {
    h.setNextStaffWrite({
      data: null,
      error: { message: 'Only a manager can change your own rank, system role, or status.' },
    })
    const { onRefresh } = renderTab([{ ...OWNER }])
    await waitFor(() => roleSelect())

    fireEvent.change(roleSelect(), { target: { value: 'manager' } })

    await waitFor(() => expect(screen.getByText(/Only a manager can change your own/i)).toBeTruthy())
    expect(screen.queryByText(/System role updated/i)).toBeNull()
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('does not show the success toast when RLS silently drops the write (no error, no row)', async () => {
    h.setNextStaffWrite({ data: [], error: null })
    const { onRefresh } = renderTab([{ ...OWNER }])
    await waitFor(() => roleSelect())

    fireEvent.change(roleSelect(), { target: { value: 'manager' } })

    await waitFor(() => expect(screen.getByText(/not saved/i)).toBeTruthy())
    expect(screen.queryByText(/System role updated/i)).toBeNull()
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('shows the success toast and refreshes when the write actually lands', async () => {
    h.setNextStaffWrite({ data: [{ id: 'staff-1', system_role: 'manager' }], error: null })
    const { onRefresh } = renderTab([{ ...OWNER }])
    await waitFor(() => roleSelect())

    fireEvent.change(roleSelect(), { target: { value: 'manager' } })

    await waitFor(() => expect(screen.getByText(/System role updated/i)).toBeTruthy())
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })
})
