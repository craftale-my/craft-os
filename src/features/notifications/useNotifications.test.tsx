// @vitest-environment jsdom
//
// The signed-in user's notification inbox. Realtime mock modeled on
// src/features/tasks/useBoardTasks.realtime.test.tsx so both describe
// realtime the same way: subscribe unfiltered, let RLS scope the rows.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor, cleanup, act } from '@testing-library/react'

const h = vi.hoisted(() => {
  const rows: unknown[] = []
  const handlers: ((p: unknown) => void)[] = []
  const updateCalls: unknown[] = []
  // What channel.on() was subscribed with, and what supabase.removeChannel()
  // was handed — both discarded by the mock before this task, which is why
  // an added server-side filter or a deleted cleanup block broke nothing.
  const filters: Record<string, unknown>[] = []
  const removed: unknown[] = []
  const state = {
    selectCalls: 0,
    gate: null as Promise<void> | null,
    // markRead() now goes through .update().eq().select() (see
    // useNotifications.ts — writeOutcome() needs the row back to tell a
    // real write from an RLS-silenced one), so this is what THAT call
    // resolves to specifically. Defaults to "the row came back", i.e. a
    // clean success, so tests that don't care about markRead's outcome
    // don't have to know this exists.
    updateResponse: { data: [{}], error: null } as { data: unknown[] | null; error: { message: string } | null },
  }
  const channel = {
    on: (_e: string, filter: Record<string, unknown>, cb: (p: unknown) => void) => {
      filters.push(filter)
      handlers.push(cb)
      return channel
    },
    subscribe: (cb?: (s: string) => void) => { cb?.('SUBSCRIBED'); return channel },
  }
  const makeQuery = () => {
    const q: Record<string, unknown> = {}
    let isUpdate = false
    for (const m of ['eq', 'is', 'order', 'limit']) q[m] = () => q
    // load() is the only caller that ever hits .select() on a plain read —
    // markRead()'s .select() (after .update()) is counted separately below,
    // via state.updateResponse, so this still counts refreshes specifically.
    q.select = () => { if (!isUpdate) state.selectCalls++; return q }
    q.update = (patch: unknown) => { updateCalls.push(patch); isUpdate = true; return q }
    // A fresh copy every call, not the live `rows` reference — a real
    // Postgrest response is always a new array. Aliasing the same mutable
    // array across two setItems() calls makes React's Object.is bail out
    // on the second one (same reference in, even though its contents
    // changed), so the component never re-renders and the update is lost.
    q.then = (ok: (v: unknown) => unknown) => {
      const gate = state.gate ?? Promise.resolve()
      const resolved = isUpdate ? state.updateResponse : { data: [...rows], error: null }
      return gate.then(() => resolved).then(ok)
    }
    return q
  }
  return { rows, handlers, updateCalls, filters, removed, channel, makeQuery, state }
})

vi.mock('../../shared/lib/supabase', () => ({
  supabase: {
    from: () => h.makeQuery(),
    channel: () => h.channel,
    removeChannel: (ch: unknown) => { h.removed.push(ch) },
  },
}))

const { useNotifications } = await import('./useNotifications')

beforeEach(() => {
  h.rows.length = 0
  h.handlers.length = 0
  h.updateCalls.length = 0
  h.filters.length = 0
  h.removed.length = 0
  h.state.selectCalls = 0
  h.state.gate = null
  h.state.updateResponse = { data: [{}], error: null }
})
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

  // The BEFORE UPDATE guard trigger raises rather than silently ignoring a
  // bad update, and RLS can reject the row outright — markRead() used to
  // apply the "read" state locally no matter what the write actually did,
  // telling the staff member/supervisor a notification was handled when it
  // wasn't. Same bug class writeOutcome() (db-write.ts) exists to catch.
  it('does not mark it read locally when the update errors', async () => {
    h.rows.push({ id: 'n1', title: 'Late arrival — Ali', read_at: null })
    const { result } = renderHook(() => useNotifications('sup-1'))
    await waitFor(() => expect(result.current.items).toHaveLength(1))

    h.state.updateResponse = { data: null, error: { message: 'guard trigger rejected the update' } }
    // act(), not a bare await: markRead's setItems (or lack of it) is
    // committed asynchronously, and reading result.current immediately after
    // a plain `await markRead(...)` can race that commit — passing either
    // way regardless of whether the fix is actually in place.
    await act(async () => { await result.current.markRead('n1') })

    expect(result.current.unread).toBe(1)
    expect(result.current.items.find(n => n.id === 'n1')?.read_at).toBeNull()
  })

  it('does not mark it read locally when RLS silently drops the update (no error, no row)', async () => {
    h.rows.push({ id: 'n1', title: 'Late arrival — Ali', read_at: null })
    const { result } = renderHook(() => useNotifications('sup-1'))
    await waitFor(() => expect(result.current.items).toHaveLength(1))

    h.state.updateResponse = { data: [], error: null }
    await act(async () => { await result.current.markRead('n1') })

    expect(result.current.unread).toBe(1)
    expect(result.current.items.find(n => n.id === 'n1')?.read_at).toBeNull()
  })

  it('does nothing when there is no signed-in staff id', async () => {
    const { result } = renderHook(() => useNotifications(undefined))
    await waitFor(() => expect(result.current.items).toEqual([]))
    expect(h.handlers).toHaveLength(0)
  })

  it('subscribes to every notification row — a recipient filter would silently drop deliveries RLS already scopes', async () => {
    renderHook(() => useNotifications('sup-1'))
    await waitFor(() => expect(h.handlers.length).toBeGreaterThan(0))

    // No `filter` key. Adding `filter: 'recipient_id=eq.sup-1'` would look like
    // a sensible optimisation, but RLS already scopes the rows, and a
    // server-side filter here would silently miss deliveries — the same trap
    // the task board hit (see useBoardTasks.ts / useBoardTasks.realtime.test.tsx).
    expect(h.filters).toHaveLength(1)
    expect(h.filters[0]).toEqual({ event: '*', schema: 'public', table: 'notifications' })
  })

  it('removes the channel on unmount and drops the refresh that was still pending', async () => {
    h.rows.push({ id: 'n1', title: 'Late arrival — Ali', read_at: null })
    const { result, unmount } = renderHook(() => useNotifications('sup-1'))
    await waitFor(() => expect(result.current.items).toHaveLength(1))
    await waitFor(() => expect(h.handlers.length).toBeGreaterThan(0))

    // Fire a realtime event while still mounted, and hold its refetch pending
    // — this is the refresh that is "still in flight" when unmount happens.
    let release: () => void = () => {}
    h.state.gate = new Promise<void>(r => { release = r })
    h.rows.push({ id: 'n2', title: 'Late arrival — Siti', read_at: null })
    h.handlers[0]({ eventType: 'INSERT' })

    const selectCallsAtUnmount = h.state.selectCalls
    unmount()

    // The channel opened for this hook must be the one handed to removeChannel.
    expect(h.removed).toHaveLength(1)
    expect(h.removed[0]).toBe(h.channel)

    // Let the refresh that was in flight at unmount time resolve. It must not
    // throw, and must not be treated as a signal to keep going.
    release()
    await new Promise(r => setTimeout(r, 0))

    // A lagging event delivered after unmount (as if the socket hadn't fully
    // torn down yet) must not start a new refresh — the channel's own `live`
    // flag has to already be false, independent of removeChannel being called.
    h.handlers[0]({ eventType: 'INSERT' })
    await new Promise(r => setTimeout(r, 0))
    expect(h.state.selectCalls).toBe(selectCallsAtUnmount)
  })
})
