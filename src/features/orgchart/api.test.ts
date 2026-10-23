import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  rpcResult: { data: [] as unknown[] | null, error: null as { message: string } | null },
  updateResult: { data: [{ id: 's1' }] as unknown[] | null, error: null as { message: string } | null },
  calls: [] as { op: string; args: unknown[] }[],
}))

vi.mock('../../shared/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => { h.calls.push({ op: 'rpc', args }); return Promise.resolve(h.rpcResult) },
    from: (table: string) => {
      const q: Record<string, unknown> = {}
      q.update = (payload: unknown) => { h.calls.push({ op: 'update', args: [table, payload] }); return q }
      q.eq = (col: string, val: unknown) => { h.calls.push({ op: 'eq', args: [col, val] }); return q }
      q.select = (cols: string) => { h.calls.push({ op: 'select', args: [cols] }); return Promise.resolve(h.updateResult) }
      return q
    },
  },
}))

const { fetchOrgChart, assignSupervisor } = await import('./api')

beforeEach(() => {
  h.calls.length = 0
  h.rpcResult = { data: [], error: null }
  h.updateResult = { data: [{ id: 's1' }], error: null }
})

describe('fetchOrgChart', () => {
  it('calls get_org_chart and returns its rows', async () => {
    h.rpcResult = { data: [{ id: 'a' }], error: null }
    await expect(fetchOrgChart()).resolves.toEqual([{ id: 'a' }])
    expect(h.calls[0]).toEqual({ op: 'rpc', args: ['get_org_chart'] })
  })

  it('throws the database message on error', async () => {
    h.rpcResult = { data: null, error: { message: 'permission denied' } }
    await expect(fetchOrgChart()).rejects.toThrow('permission denied')
  })
})

describe('assignSupervisor', () => {
  it('updates only supervisor_id on that staff row and asks for the row back', async () => {
    await expect(assignSupervisor('s1', 'boss')).resolves.toEqual({ ok: true })
    expect(h.calls).toEqual([
      { op: 'update', args: ['staff', { supervisor_id: 'boss' }] },
      { op: 'eq', args: ['id', 's1'] },
      { op: 'select', args: ['id'] },
    ])
  })

  it('reports a write that RLS silently dropped', async () => {
    h.updateResult = { data: [], error: null }
    const out = await assignSupervisor('s1', 'boss')
    expect(out.ok).toBe(false)
  })

  it('passes the loop-guard message through', async () => {
    h.updateResult = { data: null, error: { message: 'Supervisor would create a reporting loop' } }
    await expect(assignSupervisor('s1', 'boss')).resolves.toEqual({
      ok: false, reason: 'Supervisor would create a reporting loop',
    })
  })
})
