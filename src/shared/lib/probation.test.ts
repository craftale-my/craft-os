import { describe, it, expect } from 'vitest'
import { bucketProbations } from './probation'
import type { Rank, StaffStatus } from '../types'

type S = { id: string; rank: Rank; status: StaffStatus }
type R = { staff_id: string; overall_result: 'hired' | 'eliminated' | null; created_at: string }

const trainee = (id: string, status: StaffStatus = 'active'): S => ({ id, rank: 'trainee', status })
const review = (staff_id: string, overall_result: R['overall_result'], created_at: string): R =>
  ({ staff_id, overall_result, created_at })

describe('bucketProbations', () => {
  it('puts a trainee with no reviews into unstarted', () => {
    const s = trainee('a')
    const { active, completed, unstarted } = bucketProbations([s], [])
    expect(unstarted).toEqual([s])
    expect(active).toEqual([])
    expect(completed).toEqual([])
  })

  it('puts an in-progress review into active and keeps the trainee out of unstarted', () => {
    const s = trainee('a')
    const r = review('a', null, '2026-07-07T04:00:00Z')
    const { active, completed, unstarted } = bucketProbations([s], [r])
    expect(active).toEqual([r])
    expect(unstarted).toEqual([])
    expect(completed).toEqual([])
  })

  it('puts a trainee whose only review is completed into completed — not back into unstarted', () => {
    const s = trainee('a')
    const r = review('a', 'hired', '2026-07-07T04:00:00Z')
    const { active, completed, unstarted } = bucketProbations([s], [r])
    expect(active).toEqual([])
    expect(unstarted).toEqual([])
    expect(completed).toEqual([{ staff: s, review: r }])
  })

  it('picks the latest completed review when there are several', () => {
    const s = trainee('a')
    const older = review('a', 'hired', '2026-07-07T04:30:00Z')
    const newer = review('a', 'eliminated', '2026-07-07T09:31:00Z')
    const { completed } = bucketProbations([s], [older, newer])
    expect(completed).toEqual([{ staff: s, review: newer }])
  })

  it('lets an active review win over a completed one for the same trainee', () => {
    const s = trainee('a')
    const done = review('a', 'eliminated', '2026-07-07T04:24:00Z')
    const stale = review('a', null, '2026-07-07T04:26:00Z')
    const { active, completed, unstarted } = bucketProbations([s], [done, stale])
    expect(active).toEqual([stale])
    expect(completed).toEqual([])
    expect(unstarted).toEqual([])
  })

  it('excludes resigned trainees from unstarted and completed', () => {
    const gone = trainee('a', 'resigned')
    const done = review('a', 'hired', '2026-07-07T04:00:00Z')
    const fresh = trainee('b', 'resigned')
    const { completed, unstarted } = bucketProbations([gone, fresh], [done])
    expect(completed).toEqual([])
    expect(unstarted).toEqual([])
  })

  it('never lists non-trainees in unstarted or completed, but keeps their active review card', () => {
    const boss: S = { id: 'm', rank: 'manager', status: 'active' }
    const r = review('m', null, '2026-07-07T04:00:00Z')
    const done = review('m', 'hired', '2026-07-06T04:00:00Z')
    const { active, completed, unstarted } = bucketProbations([boss], [r, done])
    expect(active).toEqual([r])
    expect(completed).toEqual([])
    expect(unstarted).toEqual([])
  })

  it('preserves the input order of active reviews', () => {
    const r1 = review('a', null, '2026-07-08T00:00:00Z')
    const r2 = review('b', null, '2026-07-07T00:00:00Z')
    const { active } = bucketProbations([trainee('a'), trainee('b')], [r1, r2])
    expect(active).toEqual([r1, r2])
  })
})
