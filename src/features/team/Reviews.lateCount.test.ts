// An excused lateness must not cost attendance score. attendance_score is
// generated from late_count (schema.sql:209), and this query is the only place
// that count is derived.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => {
  const filters: { m: string; args: unknown[] }[] = []
  // Configurable per-test: what the query resolves to. Defaults to a clean
  // success (count: 3, no error) so the existing tests below don't have to
  // know about this.
  let response: { count: number | null; error: { message: string } | null } = { count: 3, error: null }
  const makeQuery = () => {
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'gte', 'lte']) {
      q[m] = (...args: unknown[]) => { filters.push({ m, args }); return q }
    }
    q.then = (ok: (v: unknown) => unknown) => Promise.resolve(response).then(ok)
    return q
  }
  return { filters, makeQuery, get response() { return response }, setResponse: (r: typeof response) => { response = r } }
})

vi.mock('../../shared/lib/supabase', () => ({ supabase: { from: () => h.makeQuery() } }))

const { countLateDays } = await import('./Reviews')

beforeEach(() => { h.filters.length = 0; h.setResponse({ count: 3, error: null }) })

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

  // I3: `error` used to be discarded entirely, so any failed read — RLS, a
  // transient network error, or `late_excused` not existing yet because the
  // migration hasn't landed in production — came back as `count === null`
  // and was coerced to 0 by `count ?? 0`, silently reporting "zero late
  // days" (a perfect attendance score) for a read that never actually
  // succeeded.
  it('signals failure instead of a confident zero when the read errors', async () => {
    h.setResponse({ count: null, error: { message: 'relation "attendance" does not have column "late_excused"' } })
    expect(await countLateDays('staff-1', 2026, 9)).toBeNull()
  })

  it('does not coerce a failed read into 0 even though that is count ?? 0’s normal fallback', async () => {
    h.setResponse({ count: null, error: { message: 'network error' } })
    const result = await countLateDays('staff-1', 2026, 9)
    expect(result).not.toBe(0)
    expect(result).toBeNull()
  })
})
