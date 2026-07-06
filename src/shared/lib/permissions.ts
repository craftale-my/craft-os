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
