// src/shared/components/Sidebar.customerService.test.tsx
// @vitest-environment jsdom
//
// The Customer Service entry shows only for staff with cs_role, calls
// openCustomerService() on click, and shows its message when it fails.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Same supabase stub as Sidebar.test.tsx: the module graph pulls in
// NotificationBell → supabase, and an unmocked import would hit PROD.
vi.mock('../lib/supabase', () => {
  const query: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'is', 'order', 'limit', 'update']) query[m] = () => query
  query.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok)
  const channel = {
    on: () => channel,
    subscribe: (cb?: (s: string) => void) => { cb?.('SUBSCRIBED'); return channel },
  }
  return { supabase: { from: () => query, channel: () => channel, removeChannel: vi.fn() } }
})

const h = vi.hoisted(() => ({
  staff: { id: 's1', name: 'Yong', rank: 'manager', avatar: null, cs_role: 'agent' as string | null },
  open: vi.fn<() => Promise<string | null>>(),
}))

vi.mock('../../features/auth/AuthContext', () => ({
  useAuth: () => ({ staff: h.staff, signOut: vi.fn() }),
}))
vi.mock('../lib/permissions', () => ({ useCan: () => ({ can: () => true }) }))
vi.mock('../lib/customerService', () => ({ openCustomerService: h.open }))

const { SidebarContent } = await import('./Sidebar')

const renderSidebar = (onNavigate = vi.fn()) => {
  render(
    <MemoryRouter initialEntries={['/profile']}>
      <SidebarContent onNavigate={onNavigate} />
    </MemoryRouter>,
  )
  return { onNavigate }
}

beforeEach(() => {
  h.staff.cs_role = 'agent'
  h.open.mockReset()
})
afterEach(() => cleanup())

describe('Customer Service entry', () => {
  it('is hidden without cs_role', () => {
    h.staff.cs_role = null
    renderSidebar()
    expect(screen.queryByRole('button', { name: /customer service/i })).toBeNull()
  })

  it('opens Customer Service and closes the drawer on success', async () => {
    h.open.mockResolvedValue(null)
    const { onNavigate } = renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: /customer service/i }))
    expect(h.open).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(onNavigate).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the failure message and keeps the drawer open', async () => {
    h.open.mockResolvedValue("You don't have Customer Service access yet. Ask an admin.")
    const { onNavigate } = renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: /customer service/i }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/ask an admin/i)
    expect(onNavigate).not.toHaveBeenCalled()
  })
})
