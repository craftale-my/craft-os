// The print agent prints for ONE branch (pre-pilot hardening §7): BRANCH_ID in .env, and
// every route, sweep and Realtime event filtered by it. Pure, so Vitest can check it.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** BRANCH_ID from the environment, lower-cased. Missing or not a uuid → throws (the agent refuses to start). */
export function branchIdFrom(env: Record<string, string | undefined>): string {
  const value = env.BRANCH_ID?.trim()
  if (!value) {
    throw new Error('Missing BRANCH_ID in tools/print-agent/.env — the id of the branch this agent prints for (branches.id)')
  }
  if (!UUID.test(value)) throw new Error(`BRANCH_ID "${value}" is not a branch id (a uuid from branches.id)`)
  return value.toLowerCase()
}

/** The Realtime filter for this branch's rows. */
export const branchFilter = (branchId: string): string => `branch_id=eq.${branchId}`

/** A job this agent prints: of its branch, on one of that branch's agent routes. */
export function isAgentJob(job: { branch_id?: string; route: string }, branchId: string, routes: ReadonlyMap<string, string>): boolean {
  return job.branch_id === branchId && routes.has(job.route)
}

/** The agent's login must be staff of BRANCH_ID: the print RPCs skip every other branch's job. */
export function loginBranchProblem(staffBranchId: string | null, branchId: string): string | null {
  if (staffBranchId === null) return 'AGENT_EMAIL has no branch — set it in Team, or log the agent in as staff of BRANCH_ID'
  if (staffBranchId.toLowerCase() !== branchId) {
    return 'AGENT_EMAIL is staff of another branch than BRANCH_ID — the print RPCs would skip every job; log in as staff of BRANCH_ID'
  }
  return null
}
