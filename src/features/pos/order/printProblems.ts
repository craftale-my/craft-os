import type { PrintJobRow } from './posApi'

export type ProblemKind = 'failed' | 'stuck' | 'waiting'
export interface PrintProblem { job: PrintJobRow; kind: ProblemKind; ageMs: number }

/** Failed jobs, jobs stuck in 'printing', and 'pending' jobs nobody has claimed for a while. */
export function classifyJobs(jobs: PrintJobRow[], now: number, stuckMs: number, waitMs: number): PrintProblem[] {
  const out: PrintProblem[] = []
  for (const job of jobs) {
    const ageMs = now - Date.parse(job.created_at)
    if (job.status === 'failed') out.push({ job, kind: 'failed', ageMs })
    else if (job.status === 'printing' && job.claimed_at && now - Date.parse(job.claimed_at) > stuckMs) out.push({ job, kind: 'stuck', ageMs })
    else if (job.status === 'pending' && ageMs > waitMs) out.push({ job, kind: 'waiting', ageMs })
  }
  return out
}

/** Distinct menu routes that have no printer configured, sorted. */
export function routesWithoutPrinter(menuRoutes: string[], printerRoutes: string[]): string[] {
  const have = new Set(printerRoutes)
  return [...new Set(menuRoutes)].filter((r) => r && !have.has(r)).sort()
}

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`
}
