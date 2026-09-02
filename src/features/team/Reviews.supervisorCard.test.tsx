// @vitest-environment jsdom
//
// countLateDays() already distinguishes a real 0 from a failed read (see
// Reviews.lateCount.test.ts). But that's the exported function in isolation —
// nothing pinned SupervisorReviewCard, the one place that actually renders
// the number a supervisor reads. A read failure that got flattened back into
// `count ?? 0` here would reach a human as a confident, wrong "0 late days"
// with no sign anything went wrong. This file pins the card's own three-state
// selection (loading / failed / loaded) against that regression.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import type { MonthlyReview, Staff } from '../../shared/types'

const h = vi.hoisted(() => {
  // Configurable per-test: what the attendance count query resolves to.
  let response: { count: number | null; error: { message: string } | null } = { count: 3, error: null }
  const makeQuery = () => {
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'gte', 'lte']) q[m] = () => q
    q.then = (ok: (v: unknown) => unknown) => Promise.resolve(response).then(ok)
    return q
  }
  return { makeQuery, setResponse: (r: typeof response) => { response = r } }
})

vi.mock('../../shared/lib/supabase', () => ({
  supabase: { from: () => h.makeQuery() },
}))

const { SupervisorReviewCard } = await import('./Reviews')

const STAFF = { id: 'staff-1', name: 'Jane Doe', rank: 'junior' } as unknown as Staff

// late_count: 3 stands in for a number a supervisor already trusted — a
// previous session's manual override, or a prior successful auto-detect.
// The read failing must never overwrite that with a silent 0.
const REVIEW = {
  id: 'rev-1', staff_id: 'staff-1', reviewer_id: null, month: 9, year: 2026,
  late_count: 3, attendance_score: null,
  self_attitude: null, self_efficiency: null, self_coffee_skill: null, self_service: null,
  self_comments: null, self_submitted_at: null,
  sup_attitude: null, sup_efficiency: null, sup_coffee_skill: null, sup_service: null,
  sup_comments: null, sup_submitted_at: null,
  status: 'self_done', created_at: '2026-09-01T00:00:00Z',
  staff: STAFF,
} as unknown as MonthlyReview

function expandCard() {
  fireEvent.click(screen.getByText('Jane Doe').closest('button') as HTMLElement)
}

beforeEach(() => { h.setResponse({ count: 3, error: null }) })
afterEach(() => cleanup())

describe('SupervisorReviewCard late-count states', () => {
  it('shows a loading caption, not a number, before the read resolves', () => {
    render(<SupervisorReviewCard review={REVIEW} reviewerId="sup-1" onComplete={() => {}} />)
    expandCard()
    // Asserted synchronously, before the mocked query's promise has a chance
    // to resolve — the effect has fired but nothing has come back yet.
    expect(screen.getByText(/Checking attendance records/i)).toBeTruthy()
  })

  it('shows the failure caption and keeps the known count, instead of a confident 0, when the read errors', async () => {
    h.setResponse({ count: null, error: { message: 'relation "attendance" does not have column "late_excused"' } })
    render(<SupervisorReviewCard review={REVIEW} reviewerId="sup-1" onComplete={() => {}} />)
    expandCard()
    await waitFor(() => expect(screen.getByText(/Could not load attendance records/i)).toBeTruthy())
    // The stepper must still read the previously-known 3, not a silent 0 —
    // the exact "confident, wrong 0" the docstring on countLateDays warns
    // about, now checked at the point a human actually sees it.
    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.queryByText('0')).toBeNull()
    expect(screen.queryByText(/Auto-detected from attendance records/i)).toBeNull()
  })

  it('shows the auto-detected caption and the fetched count once the read succeeds', async () => {
    h.setResponse({ count: 1, error: null })
    render(<SupervisorReviewCard review={REVIEW} reviewerId="sup-1" onComplete={() => {}} />)
    expandCard()
    await waitFor(() => expect(screen.getByText(/Auto-detected from attendance records/i)).toBeTruthy())
    expect(screen.getByText('1')).toBeTruthy()
    expect(screen.queryByText(/Could not load attendance records/i)).toBeNull()
  })
})
