import { describe, it, expect } from 'vitest'
import { writeOutcome } from './db-write'

describe('writeOutcome', () => {
  it('treats a returned row as proof the write landed', () => {
    expect(writeOutcome({ data: [{ id: 'a1' }], error: null })).toEqual({ ok: true })
  })

  // The defect this exists to prevent: a clock-out rejected by RLS comes back
  // with NO error and NO rows, so checking `error` alone reported success.
  it('fails on an empty result — a silently rejected write is NOT a success', () => {
    const r = writeOutcome({ data: [], error: null })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/not saved/i)
  })

  it('fails on a null result', () => {
    expect(writeOutcome({ data: null, error: null }).ok).toBe(false)
  })

  it('surfaces the database error message', () => {
    const r = writeOutcome({ data: null, error: { message: 'permission denied for table attendance' } })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('permission denied for table attendance')
  })

  it('reports the error even when rows came back alongside it', () => {
    const r = writeOutcome({ data: [{ id: 'a1' }], error: { message: 'boom' } })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('boom')
  })

  it('mentions being signed out, the likeliest cause on a long night shift', () => {
    const r = writeOutcome({ data: [], error: null })
    expect(r.ok === false && r.reason).toMatch(/signed out/i)
  })
})
