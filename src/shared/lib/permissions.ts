import { useAuth } from '../../features/auth/AuthContext'
import { useLookups } from './lookups'
import type { Capability, SystemRole, Rank, Staff } from '../types'

/** Fallback mapping used before staff.system_role exists (pre-migration). */
export function rankToSystemRole(rank?: Rank | null): SystemRole {
  if (rank === 'manager') return 'manager'
  if (rank === 'supervisor') return 'supervisor'
  return 'staff'
}

/** The user's system role, falling back to a rank-derived one when the column
 *  isn't present yet (so the app isn't locked down before the migration runs). */
export function effectiveSystemRole(staff: Pick<Staff, 'system_role' | 'rank'> | null | undefined): SystemRole {
  return staff?.system_role ?? rankToSystemRole(staff?.rank)
}

/**
 * Frontend mirror of SQL can_review_staff(target uuid): determines whether the
 * current user can review a target staff member. Managers can review anyone;
 * supervisors can only review staff in the same branch, department, and with
 * rank below supervisor (trainee/junior/senior). Branch comparison prioritizes
 * branch_id when both parties have it; falls back to text branch comparison.
 */
export function canReviewStaff(
  me: Pick<Staff, 'rank' | 'system_role' | 'department' | 'branch' | 'branch_id'> | null | undefined,
  target: Pick<Staff, 'rank' | 'department' | 'branch' | 'branch_id'> | null | undefined,
): boolean {
  if (!me || !target) return false

  // Managers (rank=manager or system_role in manager/admin/owner) can review anyone
  if (me.rank === 'manager' || me.system_role === 'manager' || me.system_role === 'admin' || me.system_role === 'owner') {
    return true
  }

  // Supervisors (rank=supervisor or system_role=supervisor) can review under specific conditions
  if (me.rank === 'supervisor' || me.system_role === 'supervisor') {
    // Target must be below supervisor rank
    if (target.rank !== 'trainee' && target.rank !== 'junior' && target.rank !== 'senior') {
      return false
    }

    // Must be same department (and both must have department set)
    if (!target.department || target.department !== me.department) {
      return false
    }

    // Branch match: prioritize branch_id when both have it, otherwise fall back to text
    const meHasBranchId = me.branch_id !== null && me.branch_id !== undefined
    const targetHasBranchId = target.branch_id !== null && target.branch_id !== undefined

    if (meHasBranchId && targetHasBranchId) {
      // Both have branch_id: must match exactly
      return me.branch_id === target.branch_id
    }

    // At least one is null: fall back to text comparison
    if (me.branch !== null && me.branch !== undefined) {
      return me.branch === target.branch
    }

    return false
  }

  // Non-manager, non-supervisor (HR, staff, etc.) cannot review
  return false
}

/**
 * Capability check for the current user, driven by their system_role and the
 * effective capability matrix (code defaults merged with the Owner's overrides).
 * This is a UI/route/query gate, not a security boundary — RLS still applies.
 */
export function useCan() {
  const { staff } = useAuth()
  const { roleCaps } = useLookups()
  const role: SystemRole = effectiveSystemRole(staff)
  const can = (cap: Capability): boolean => !!roleCaps[role]?.[cap]
  return {
    role,
    can,
    isOwner: role === 'owner',
    /** true when the user should only see their own branch's data. */
    ownBranchOnly: !can('all_branches'),
  }
}
