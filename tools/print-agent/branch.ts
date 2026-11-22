// The print agent prints for ONE outlet: the one its device was approved for (pos_agent_whoami),
// and every route, sweep and Realtime event is filtered by it. Pure, so Vitest can check it.

/** The Realtime filter for this branch's rows. */
export const branchFilter = (branchId: string): string => `branch_id=eq.${branchId}`

/** A job this agent prints: of its branch, on one of that branch's agent routes. */
export function isAgentJob(job: { branch_id?: string; route: string }, branchId: string, routes: ReadonlyMap<string, string>): boolean {
  return job.branch_id === branchId && routes.has(job.route)
}

// staleMinutes / DRAWER_MAX_AGE_MIN live in src so the iPad print host shares one definition.
export { DRAWER_MAX_AGE_MIN, staleMinutes } from '../../src/features/pos/print/stale.ts'
