import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { functions: { invoke: h.invoke } } }))

import { approveRegistration } from './provision'

const INPUT = { requestId: 'r1', email: 'a@b.c', fullName: 'A', password: 'secret1' }

beforeEach(() => h.invoke.mockReset())

describe('approveRegistration', () => {
  it('reports a normal approval without alreadyExisted', async () => {
    h.invoke.mockResolvedValue({ data: { ok: true, staffId: 's1' }, error: null })
    expect(await approveRegistration(INPUT)).toEqual({ ok: true, staffId: 's1', alreadyExisted: false, message: undefined })
  })

  it('passes through alreadyExisted and the server message', async () => {
    h.invoke.mockResolvedValue({
      data: { ok: true, staffId: 's1', alreadyExisted: true, message: 'An account for this email already existed.' },
      error: null,
    })
    const res = await approveRegistration(INPUT)
    expect(res).toMatchObject({ ok: true, alreadyExisted: true, message: 'An account for this email already existed.' })
  })

  it('surfaces the error body of a non-2xx response', async () => {
    const context = { json: async () => ({ error: 'This registration request is already approved.' }) }
    h.invoke.mockResolvedValue({ data: null, error: { message: 'Edge Function returned a non-2xx status code', context } })
    expect(await approveRegistration(INPUT)).toEqual({ ok: false, error: 'This registration request is already approved.' })
  })
})
