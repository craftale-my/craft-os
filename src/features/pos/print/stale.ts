// Pure, shared by the Node print agent and the iPad print host (explicit .ts imports only).

/** A drawer kick never tried for this long is left pending: a late kick would open the drawer with nobody
 *  at the till (W4). */
export const DRAWER_MAX_AGE_MIN = 2

/** The age in minutes of a job too old to print by itself, or null to print it. An old job that was never
 *  tried stays pending (the iPad shows it as "Waiting") so staff decide, not a backlog dump; a requeued one
 *  (attempts >= 1) is a Reprint someone asked for. Tickets wait up to maxAgeMin, a drawer kick 2 minutes. */
export function staleMinutes(
  job: { created_at?: string; attempts?: number; payload?: { kind?: string } },
  nowMs: number,
  maxAgeMin: number,
): number | null {
  if (!job.created_at || (job.attempts ?? 0) > 0) return null
  const ageMin = (nowMs - Date.parse(job.created_at)) / 60_000
  const limit = job.payload?.kind === 'drawer' ? Math.min(DRAWER_MAX_AGE_MIN, maxAgeMin) : maxAgeMin
  return ageMin > limit ? ageMin : null
}
