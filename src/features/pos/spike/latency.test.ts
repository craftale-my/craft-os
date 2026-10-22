import { describe, it, expect } from 'vitest'
import { parseServerTime, clockOffsetMs, latencyMs, LATENCY_BUDGET_MS } from './latency'
import { assertDevDatabase } from './guard'

describe('parseServerTime', () => {
  it('reads Postgres timestamps with microseconds', () => {
    expect(parseServerTime('2026-10-22T03:48:00.123456+00:00')).toBe(Date.UTC(2026, 9, 22, 3, 48, 0, 123))
  })

  it('reads plain ISO timestamps', () => {
    expect(parseServerTime('2026-10-22T03:48:00.500Z')).toBe(Date.UTC(2026, 9, 22, 3, 48, 0, 500))
  })
})

describe('clock offset and latency', () => {
  it('assumes the server answered halfway through the round trip', () => {
    // local clock is 1000 ms behind the server
    const server = '2026-10-22T03:48:01.050Z'
    const sent = Date.UTC(2026, 9, 22, 3, 48, 0, 0)
    expect(clockOffsetMs(sent, server, sent + 100)).toBe(1000)
  })

  it('measures from placed_at to arrival on the server clock', () => {
    const placed = '2026-10-22T03:48:00.000Z'
    const receivedLocal = Date.UTC(2026, 9, 22, 3, 47, 59, 400) // local clock is behind
    expect(latencyMs(placed, receivedLocal, 1000)).toBe(400)
  })

  it('budget is two seconds', () => {
    expect(LATENCY_BUDGET_MS).toBe(2000)
  })
})

describe('assertDevDatabase', () => {
  it('refuses the production project', () => {
    expect(() => assertDevDatabase('https://yfsoesxzurzjdwstszru.supabase.co')).toThrow('production')
  })

  it('refuses the production project however the URL is capitalised', () => {
    expect(() => assertDevDatabase('https://YFSOESXZURZJDWSTSZRU.supabase.co')).toThrow('production')
  })

  it('allows any other project', () => {
    expect(() => assertDevDatabase('https://abcdefgh.supabase.co')).not.toThrow()
  })
})
