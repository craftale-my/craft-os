import { describe, expect, it } from 'vitest'
import { classifyJobs, formatAge, routesWithoutPrinter } from './printProblems'
import type { PrintJobRow } from './posApi'

const NOW = Date.parse('2026-10-23T12:00:00Z')
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString()
const job = (o: Partial<PrintJobRow>): PrintJobRow => ({
  id: 'j', branch_id: 'b', route: 'Bar', payload: {} as PrintJobRow['payload'], status: 'pending',
  attempts: 0, last_error: null, claimed_at: null, created_at: iso(0), ...o,
})

describe('classifyJobs', () => {
  it('flags failed jobs', () => {
    expect(classifyJobs([job({ status: 'failed' })], NOW, 120_000, 45_000).map((p) => p.kind)).toEqual(['failed'])
  })
  it('flags printing jobs claimed longer than stuckMs ago only', () => {
    const jobs = [job({ id: 'a', status: 'printing', claimed_at: iso(200_000) }), job({ id: 'b', status: 'printing', claimed_at: iso(10_000) })]
    const r = classifyJobs(jobs, NOW, 120_000, 45_000)
    expect(r.map((p) => [p.job.id, p.kind])).toEqual([['a', 'stuck']])
  })
  it('flags pending jobs older than waitMs with their age', () => {
    const r = classifyJobs([job({ created_at: iso(60_000) })], NOW, 120_000, 45_000)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ kind: 'waiting', ageMs: 60_000 })
  })
  it('ignores fresh pending and printed jobs', () => {
    expect(classifyJobs([job({ created_at: iso(10_000) }), job({ status: 'printed' })], NOW, 120_000, 45_000)).toEqual([])
  })
})

describe('routesWithoutPrinter', () => {
  it('lists distinct menu routes missing a printer, sorted', () => {
    expect(routesWithoutPrinter(['Kitchen', 'Bar', 'Kitchen', 'Dessert'], ['Bar'])).toEqual(['Dessert', 'Kitchen'])
  })
  it('is empty when all are covered', () => {
    expect(routesWithoutPrinter(['Bar'], ['Bar', 'Kitchen'])).toEqual([])
  })
})

describe('formatAge', () => {
  it('uses seconds then minutes', () => {
    expect(formatAge(50_000)).toBe('50 s')
    expect(formatAge(300_000)).toBe('5 min')
  })
})
