// Resigned staff must drop out of the team attendance views, but not out of
// the history: a period in which they still have records keeps their row.
import { describe, it, expect, vi } from 'vitest'
import type { Staff } from '../../shared/types'

vi.mock('../../shared/lib/supabase', () => ({ supabase: {} }))
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({}) }))

const { hideIdleResigned } = await import('./HrAttendance')

const staff = [
  { id: 'a', name: 'Active', status: 'active' },
  { id: 'r1', name: 'Resigned, worked this month', status: 'resigned' },
  { id: 'r2', name: 'Resigned, nothing on record', status: 'resigned' },
] as Staff[]

describe('hideIdleResigned', () => {
  it('drops resigned staff with no records in the period', () => {
    expect(hideIdleResigned(staff, new Set(['r1'])).map(s => s.id)).toEqual(['a', 'r1'])
  })

  it('keeps active staff even with no records', () => {
    expect(hideIdleResigned(staff, new Set()).map(s => s.id)).toEqual(['a'])
  })
})
