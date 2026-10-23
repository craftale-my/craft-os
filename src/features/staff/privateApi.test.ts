import { describe, it, expect, vi, beforeEach } from 'vitest'

// Minimal supabase fake: records every call on the chain and resolves with
// whatever h.result holds. maybeSingle() and the thenable share the result.
const h = vi.hoisted(() => {
  const calls: { method: string; args: unknown[] }[] = []
  const state = { result: { data: null as unknown, error: null as { message: string } | null } }
  const chain: Record<string, unknown> = {}
  for (const m of ['from', 'select', 'eq', 'upsert']) {
    chain[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return chain }
  }
  chain.maybeSingle = () => { calls.push({ method: 'maybeSingle', args: [] }); return Promise.resolve(state.result) }
  chain.then = (onOk: (v: unknown) => unknown) => Promise.resolve(state.result).then(onOk)
  return { calls, state, chain }
})

vi.mock('../../shared/lib/supabase', () => ({ supabase: { from: (t: string) => (h.chain.from as (t: string) => unknown)(t) } }))

const api = await import('./privateApi')

beforeEach(() => {
  h.calls.length = 0
  h.state.result = { data: null, error: null }
})

const call = (m: string) => h.calls.find(c => c.method === m)

describe('fetchStaffPrivate', () => {
  it('reads staff_private for one staff id', async () => {
    h.state.result = { data: { staff_id: 's1', contact_number: '012' }, error: null }
    const row = await api.fetchStaffPrivate('s1')
    expect(call('from')?.args).toEqual(['staff_private'])
    expect(call('eq')?.args).toEqual(['staff_id', 's1'])
    expect(row?.contact_number).toBe('012')
  })

  it('returns null when RLS hides the row', async () => {
    h.state.result = { data: null, error: null }
    expect(await api.fetchStaffPrivate('s1')).toBeNull()
  })

  it('throws on a real error instead of pretending there is no row', async () => {
    h.state.result = { data: null, error: { message: 'network down' } }
    await expect(api.fetchStaffPrivate('s1')).rejects.toThrow('network down')
  })
})

describe('saveStaffPrivate', () => {
  it('upserts only the patched columns, keyed on staff_id', async () => {
    h.state.result = { data: [{ staff_id: 's1' }], error: null }
    await api.saveStaffPrivate('s1', { contact_number: '012', address: null })
    const [payload, opts] = call('upsert')!.args as [Record<string, unknown>, Record<string, unknown>]
    expect(payload).toMatchObject({ staff_id: 's1', contact_number: '012', address: null })
    expect(payload).not.toHaveProperty('ic_number')
    expect(opts).toEqual({ onConflict: 'staff_id' })
    expect(call('select')?.args).toEqual(['staff_id'])
  })

  it('throws when the write comes back with no rows (RLS filtered it)', async () => {
    h.state.result = { data: [], error: null }
    await expect(api.saveStaffPrivate('s1', { address: 'x' })).rejects.toThrow()
  })

  it('throws the database message on error', async () => {
    h.state.result = { data: null, error: { message: 'new row violates row-level security policy' } }
    await expect(api.saveStaffPrivate('s1', { address: 'x' })).rejects.toThrow('row-level security')
  })
})

describe('manager notes', () => {
  it('fetchManagerNotes returns the notes text or null', async () => {
    h.state.result = { data: { notes: 'Great with customers' }, error: null }
    expect(await api.fetchManagerNotes('s1')).toBe('Great with customers')
    h.state.result = { data: null, error: null }
    expect(await api.fetchManagerNotes('s1')).toBeNull()
    expect(call('from')?.args).toEqual(['staff_manager_notes'])
  })

  it('saveManagerNotes records who wrote it and throws on 0 rows', async () => {
    h.state.result = { data: [{ staff_id: 's1' }], error: null }
    await api.saveManagerNotes('s1', 'note', 'mgr-1')
    const [payload] = call('upsert')!.args as [Record<string, unknown>]
    expect(payload).toMatchObject({ staff_id: 's1', notes: 'note', updated_by: 'mgr-1' })

    h.state.result = { data: [], error: null }
    await expect(api.saveManagerNotes('s1', 'note', 'mgr-1')).rejects.toThrow()
  })
})
