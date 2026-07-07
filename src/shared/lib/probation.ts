import type { ProbationReview, Staff } from '../types'

export interface ProbationBuckets<S, R> {
  /** Reviews still in progress (no overall result) — one dashboard card each. */
  active: R[]
  /** Trainees whose latest review is finished — show outcome, never a Start button. */
  completed: { staff: S; review: R }[]
  /** Trainees with no review at all — the only ones who may Start. */
  unstarted: S[]
}

/**
 * Split staff + probation reviews into dashboard buckets. A trainee with any
 * existing review must never fall back into `unstarted` — that's what caused
 * managers to re-start (and re-complete) finished probations.
 */
export function bucketProbations<
  S extends Pick<Staff, 'id' | 'rank' | 'status'>,
  R extends Pick<ProbationReview, 'staff_id' | 'overall_result' | 'created_at'>,
>(allStaff: S[], reviews: R[]): ProbationBuckets<S, R> {
  const active = reviews.filter(r => r.overall_result == null)
  const activeStaffIds = new Set(active.map(r => r.staff_id))

  const latestCompleted = new Map<string, R>()
  for (const r of reviews) {
    if (r.overall_result == null) continue
    const prev = latestCompleted.get(r.staff_id)
    if (!prev || r.created_at > prev.created_at) latestCompleted.set(r.staff_id, r)
  }

  const completed: { staff: S; review: R }[] = []
  const unstarted: S[] = []
  for (const s of allStaff) {
    if (s.rank !== 'trainee' || s.status === 'resigned' || activeStaffIds.has(s.id)) continue
    const done = latestCompleted.get(s.id)
    if (done) completed.push({ staff: s, review: done })
    else unstarted.push(s)
  }

  return { active, completed, unstarted }
}
