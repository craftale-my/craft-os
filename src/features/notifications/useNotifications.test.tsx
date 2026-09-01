// @vitest-environment jsdom
//
// The signed-in user's notification inbox. Realtime mock modeled on
// src/features/tasks/useBoardTasks.realtime.test.tsx so both describe
// realtime the same way: subscribe unfiltered, let RLS scope the rows.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor, cleanup } from '@testing-library/react'

const h = vi.hoisted(() => {
  const rows: unknown[] = []
  const handlers: ((p: unknown) => void)[] = []
  const updateCalls: unknown[] = []
  const channel = {
    on: (_e: string, _f: unknown, cb: (p: unknown) => void) => { handlers.push(cb); return channel },
    subscribe: (cb?: (s: string) => void) => { cb?.('SUBSCRIBED'); return channel },
  }
  const makeQuery = () => {
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'is', 'order', 'limit']) q[m] = () => q
    q.update = (patch: unknown) => { updateCalls.push(patch); return q }
    // A fresh copy every call, not the live `rows` reference — a real
    // Postgrest response is always a new array. Aliasing the same mutable
    // array across two setItems() calls makes React's Object.is bail out
    // on the second one (same reference in, even though its contents
    // changed), so the component never re-renders and the update is lost.
    q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [...rows], error: null }).then(ok)
    return q
  }
  return { rows, handlers, updateCalls, channel, makeQuery }
})

vi.mock('../../shared/lib/supabase', () => ({
  supabase: {
    from: () => h.makeQuery(),
    channel: () => h.channel,
    removeChannel: vi.fn(),
  },
}))

const { useNotifications } = await import('./useNotifications')

beforeEach(() => { h.rows.length = 0; h.handlers.length = 0; h.updateCalls.length = 0 })
afterEach(() => cleanup())

describe('useNotifications', () => {
  it('counts only the unread ones', async () => {
    h.rows.push(
      { id: 'n1', title: 'Late arrival — Ali', read_at: null },
      { id: 'n2', title: 'Late arrival — Siti', read_at: '2026-09-02T01:00:00Z' },
    )
    const { result } = renderHook(() => useNotifications('sup-1'))
    await waitFor(() => expect(result.current.items).toHaveLength(2))
    expect(result.current.unread).toBe(1)
  })

  it('reloads when a notification arrives over realtime', async () => {
    const { result } = renderHook(() => useNotifications('sup-1'))
    await waitFor(() => expect(h.handlers.length).toBeGreaterThan(0))
    h.rows.push({ id: 'n3', title: 'Late arrival — Ahmad', read_at: null })
    h.handlers[0]({ eventType: 'INSERT' })
    await waitFor(() => expect(result.current.unread).toBe(1))
  })

  it('marks only read_at — the row trigger rejects any other column change', async () => {
    h.rows.push({ id: 'n1', title: 'Late arrival — Ali', read_at: null })
    const { result } = renderHook(() => useNotifications('sup-1'))
    await waitFor(() => expect(result.current.items).toHaveLength(1))

    await result.current.markRead('n1')

    expect(h.updateCalls).toHaveLength(1)
    expect(Object.keys(h.updateCalls[0] as object)).toEqual(['read_at'])
    await waitFor(() => expect(result.current.unread).toBe(0))
  })

  it('does nothing when there is no signed-in staff id', async () => {
    const { result } = renderHook(() => useNotifications(undefined))
    await waitFor(() => expect(result.current.items).toEqual([]))
    expect(h.handlers).toHaveLength(0)
  })
})
