/** Full branch name → the short label used in lists and cards. */
export function shortenBranch(branch: string | null): string {
  if (!branch) return '—'
  if (branch.includes('Connaught')) return 'Cheras'
  if (branch.includes('Puteri')) return 'Puchong'
  if (branch.includes('Usahawan')) return 'Kepong'
  return branch
}

export interface BranchRow { id: string; name: string; is_active?: boolean | null }

/**
 * The branches row a staff.branch label points at, or null ("Other", empty,
 * unknown). The label matches when it — or the part before " (" — equals the
 * branch name, ignoring case: "Cheras (Taman Connaught)" → Cheras. Active rows
 * win. Mirrors branch_id_for_label() in
 * supabase/migration-2026-10-29-staff-branch-id-sync.sql.
 */
export function matchBranchId(label: string | null | undefined, branches: BranchRow[]): string | null {
  const key = (label ?? '').split(' (')[0].trim().toLowerCase()
  if (!key) return null
  const hits = branches.filter(b => b.name.trim().toLowerCase() === key)
  return (hits.find(b => b.is_active !== false) ?? hits[0])?.id ?? null
}
