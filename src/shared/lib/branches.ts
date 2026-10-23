/** Full branch name → the short label used in lists and cards. */
export function shortenBranch(branch: string | null): string {
  if (!branch) return '—'
  if (branch.includes('Connaught')) return 'Cheras'
  if (branch.includes('Puteri')) return 'Puchong'
  if (branch.includes('Usahawan')) return 'Kepong'
  return branch
}
