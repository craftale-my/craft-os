import { supabase } from './supabase'
import { matchBranchId, type BranchRow } from './branches'

/**
 * Resolve a staff.branch label to a branch_id for writing alongside it.
 * Returns undefined when the branches lookup fails: callers then leave
 * branch_id out and the DB trigger staff_sync_branch_id_trg fills it.
 */
export async function branchIdForLabel(label: string | null | undefined): Promise<string | null | undefined> {
  if (!label) return null
  try {
    const { data, error } = await supabase.from('branches').select('id, name, is_active').order('created_at')
    if (error || !data) return undefined
    return matchBranchId(label, data as BranchRow[])
  } catch {
    return undefined
  }
}
