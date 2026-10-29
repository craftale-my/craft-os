// @vitest-environment jsdom
//
// Writes go through writeOutcome(): a write that RLS silently drops, or that
// staff_guard_cs_role() rejects, must show an error, never "Saved".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { Staff } from '../../shared/types'

const h = vi.hoisted(() => {
  let next: { data: unknown[] | null; error: { message: string } | null } = { data: [], error: null }
  const updates: unknown[] = []
  const query: Record<string, unknown> = {}
  query.update = (v: unknown) => { updates.push(v); return query }
  query.eq = () => query
  query.select = () => query
  query.then = (ok: (v: unknown) => unknown) => Promise.resolve(next).then(ok)
  return {
    updates,
    setNext: (r: typeof next) => { next = r },
    query,
  }
})

vi.mock('../../shared/lib/supabase', () => ({ supabase: { from: () => h.query } }))

const { CustomerServiceAccessTab } = await import('./CustomerServiceAccessTab')

const ALI = { id: 'staff-1', name: 'Ali', status: 'active', cs_role: null } as unknown as Staff
const GONE = { id: 'staff-2', name: 'Gone', status: 'resigned', cs_role: 'agent' } as unknown as Staff

beforeEach(() => { h.updates.length = 0; h.setNext({ data: [{ id: 'staff-1' }], error: null }) })
afterEach(() => cleanup())

describe('CustomerServiceAccessTab', () => {
  it('lists active staff only', () => {
    render(<CustomerServiceAccessTab allStaff={[{ ...ALI }, { ...GONE }]} onRefresh={vi.fn()} />)
    expect(screen.getByText('Ali')).toBeTruthy()
    expect(screen.queryByText('Gone')).toBeNull()
  })

  it('hides deactivated staff (is_active = false)', () => {
    const OFF = { id: 'staff-3', name: 'Deactivated', status: 'active', is_active: false, cs_role: null } as unknown as Staff
    render(<CustomerServiceAccessTab allStaff={[{ ...ALI }, OFF]} onRefresh={vi.fn()} />)
    expect(screen.getByText('Ali')).toBeTruthy()
    expect(screen.queryByText('Deactivated')).toBeNull()
  })

  it('saves a new level and refreshes', async () => {
    const onRefresh = vi.fn()
    render(<CustomerServiceAccessTab allStaff={[{ ...ALI }]} onRefresh={onRefresh} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'supervisor' } })
    await waitFor(() => expect(onRefresh).toHaveBeenCalled())
    expect(h.updates).toEqual([{ cs_role: 'supervisor' }])
    expect(screen.getByText('Saved')).toBeTruthy()
  })

  it('writes null for None', async () => {
    render(<CustomerServiceAccessTab allStaff={[{ ...ALI, cs_role: 'agent' } as Staff]} onRefresh={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } })
    await waitFor(() => expect(h.updates).toEqual([{ cs_role: null }]))
  })

  it('shows the trigger error instead of Saved', async () => {
    h.setNext({ data: null, error: { message: 'Only an owner or admin can change Customer Service access.' } })
    const onRefresh = vi.fn()
    render(<CustomerServiceAccessTab allStaff={[{ ...ALI }]} onRefresh={onRefresh} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'agent' } })
    expect(await screen.findByText(/only an owner or admin/i)).toBeTruthy()
    expect(screen.queryByText('Saved')).toBeNull()
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('shows an error when RLS silently drops the write', async () => {
    h.setNext({ data: [], error: null })
    render(<CustomerServiceAccessTab allStaff={[{ ...ALI }]} onRefresh={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'agent' } })
    expect(await screen.findByText(/not saved/i)).toBeTruthy()
  })
})
