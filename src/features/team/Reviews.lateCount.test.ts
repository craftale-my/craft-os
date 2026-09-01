// An excused lateness must not cost attendance score. attendance_score is
// generated from late_count (schema.sql:209), and this query is the only place
// that count is derived.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => {
  const filters: { m: string; args: unknown[] }[] = []
  const makeQuery = () => {
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'gte', 'lte']) {
      q[m] = (...args: unknown[]) => { filters.push({ m, args }); return q }
    }
    q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ count: 3 }).then(ok)
    return q
  }
  return { filters, makeQuery }
})

vi.mock('../../shared/lib/supabase', () => ({ supabase: { from: () => h.makeQuery() } }))

const { countLateDays } = await import('./Reviews')

beforeEach(() => { h.filters.length = 0 })

describe('countLateDays', () => {
  it('excludes excused days', async () => {
    await countLateDays('staff-1', 2026, 9)
    expect(h.filters).toContainEqual({ m: 'eq', args: ['late_excused', false] })
  })

  it('still only counts late days', async () => {
    await countLateDays('staff-1', 2026, 9)
    expect(h.filters).toContainEqual({ m: 'eq', args: ['status', 'late'] })
  })

  it('covers the whole month, including a 30-day one', async () => {
    await countLateDays('staff-1', 2026, 9)
    expect(h.filters).toContainEqual({ m: 'gte', args: ['date', '2026-09-01'] })
    expect(h.filters).toContainEqual({ m: 'lte', args: ['date', '2026-09-30'] })
  })

  it('handles February in a leap year', async () => {
    await countLateDays('staff-1', 2028, 2)
    expect(h.filters).toContainEqual({ m: 'lte', args: ['date', '2028-02-29'] })
  })

  it('returns the count', async () => {
    expect(await countLateDays('staff-1', 2026, 9)).toBe(3)
  })
})
