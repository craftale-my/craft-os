import { describe, it, expect, vi } from 'vitest'

// permissions.ts also exports useCan(), which pulls in AuthContext/lookups —
// both of which instantiate the Supabase client at module load time. Mock
// them out so this file can unit-test the pure canReviewStaff function
// without needing real Supabase env vars.
vi.mock('../../features/auth/AuthContext', () => ({ useAuth: () => ({ staff: null }) }))
vi.mock('./lookups', () => ({ useLookups: () => ({ roleCaps: {} }) }))

import { canReviewStaff } from './permissions'
import type { Rank, SystemRole, Staff } from '../types'

type Me = Pick<Staff, 'rank' | 'system_role' | 'department' | 'branch' | 'branch_id'>
type Target = Pick<Staff, 'rank' | 'department' | 'branch' | 'branch_id'>

const me = (overrides: Partial<Me> = {}): Me => ({
  rank: 'supervisor',
  system_role: 'supervisor',
  department: 'barista',
  branch: 'Main',
  branch_id: null,
  ...overrides,
})

const target = (overrides: Partial<Target> = {}): Target => ({
  rank: 'junior',
  department: 'barista',
  branch: 'Main',
  branch_id: null,
  ...overrides,
})

describe('canReviewStaff', () => {
  it('manager rank is true regardless of branch/department, even reviewing a supervisor', () => {
    const m = me({ rank: 'manager', department: 'kitchen', branch: 'Other' })
    const t = target({ rank: 'supervisor', department: 'barista', branch: 'Main' })
    expect(canReviewStaff(m, t)).toBe(true)
  })

  it('system_role-promoted manager (rank trainee) is true', () => {
    const m = me({ rank: 'trainee', system_role: 'manager' as SystemRole })
    expect(canReviewStaff(m, target())).toBe(true)
  })

  it('supervisor same branch text + same department + target junior is true', () => {
    expect(canReviewStaff(me(), target())).toBe(true)
  })

  it('supervisor different department is false', () => {
    const t = target({ department: 'kitchen' })
    expect(canReviewStaff(me(), t)).toBe(false)
  })

  it('supervisor different branch text is false', () => {
    const t = target({ branch: 'Other' })
    expect(canReviewStaff(me(), t)).toBe(false)
  })

  it('target rank supervisor is false, target rank manager is false', () => {
    expect(canReviewStaff(me(), target({ rank: 'supervisor' as Rank }))).toBe(false)
    expect(canReviewStaff(me(), target({ rank: 'manager' as Rank }))).toBe(false)
  })

  it('branch_id wins over branch text when both set: equal ids + different text is true', () => {
    const m = me({ branch_id: 'b1', branch: 'Main' })
    const t = target({ branch_id: 'b1', branch: 'Other' })
    expect(canReviewStaff(m, t)).toBe(true)
  })

  it('branch_id wins over branch text when both set: different ids + same text is false', () => {
    const m = me({ branch_id: 'b1', branch: 'Main' })
    const t = target({ branch_id: 'b2', branch: 'Main' })
    expect(canReviewStaff(m, t)).toBe(false)
  })

  it('one branch_id null falls back to text compare: equal text is true', () => {
    const m = me({ branch_id: 'b1', branch: 'Main' })
    const t = target({ branch_id: null, branch: 'Main' })
    expect(canReviewStaff(m, t)).toBe(true)
  })

  it('one branch_id null falls back to text compare: me.branch null is false', () => {
    const m = me({ branch_id: 'b1', branch: null })
    const t = target({ branch_id: null, branch: 'Main' })
    expect(canReviewStaff(m, t)).toBe(false)
  })

  it('plain staff (rank junior, system_role staff) is false', () => {
    const m = me({ rank: 'junior', system_role: 'staff' as SystemRole })
    expect(canReviewStaff(m, target())).toBe(false)
  })

  it('null me is false', () => {
    expect(canReviewStaff(null, target())).toBe(false)
  })

  it('hr system_role (rank trainee) is false', () => {
    const m = me({ rank: 'trainee', system_role: 'hr' as SystemRole })
    expect(canReviewStaff(m, target())).toBe(false)
  })
})
