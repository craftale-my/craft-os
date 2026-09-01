// @vitest-environment jsdom
//
// I6: NotificationBell must mount exactly once regardless of viewport or
// drawer state. It used to live inside SidebarContent, and the desktop
// <aside> keeps SidebarContent mounted at all times (only hidden by CSS,
// "hidden sm:block") — so opening the mobile drawer mounted a SECOND
// SidebarContent (the drawer's own <aside>) alongside the first, which meant
// a second useNotifications() fetch and a second `notifications:<staffId>`
// realtime channel subscription on the same topic. This file renders the
// full <Sidebar>, not just <SidebarContent>, because the bug only shows up
// once both the always-mounted desktop chrome and the drawer are involved.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const h = vi.hoisted(() => ({ channelCalls: 0 }))

vi.mock('../lib/supabase', () => {
  const query: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'is', 'order', 'limit', 'update']) query[m] = () => query
  query.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok)
  const channel = {
    on: () => channel,
    subscribe: (cb?: (s: string) => void) => { cb?.('SUBSCRIBED'); return channel },
  }
  return {
    supabase: {
      from: () => query,
      // Counts how many independent realtime subscriptions get opened —
      // this is the concrete, observable cost of a duplicate mount (see the
      // file banner above): two mounts means two open WebSocket topics.
      channel: () => { h.channelCalls++; return channel },
      removeChannel: vi.fn(),
    },
  }
})
vi.mock('../../features/auth/AuthContext', () => ({
  useAuth: () => ({ staff: { id: 's1', name: 'Yong', rank: 'manager', avatar: null }, signOut: vi.fn() }),
}))
vi.mock('../lib/permissions', () => ({ useCan: () => ({ can: () => true }) }))

const { Sidebar } = await import('./Sidebar')

// <Sidebar> (unlike <SidebarContent>, which Sidebar.test.tsx renders
// directly) also renders the mobile top bar's AddToHomeScreenLogo, which
// reads window.matchMedia — unimplemented in jsdom.
window.matchMedia = window.matchMedia ?? ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
}) as unknown as MediaQueryList)

function renderSidebar() {
  return render(
    <MemoryRouter initialEntries={['/profile']}>
      <Sidebar />
    </MemoryRouter>,
  )
}

beforeEach(() => { h.channelCalls = 0 })
afterEach(cleanup)

describe('通知铃铛只挂载一次,且无需打开抽屉就能看到', () => {
  it('is present without ever opening the mobile drawer', () => {
    renderSidebar()
    expect(screen.getByRole('button', { name: /notifications/i })).toBeTruthy()
  })

  it('opens exactly one realtime subscription at rest', () => {
    renderSidebar()
    expect(h.channelCalls).toBe(1)
  })

  it('stays a single bell — and a single subscription — once the mobile drawer opens', () => {
    renderSidebar()
    // The hamburger button: the only <button> in the mobile top bar besides
    // the bell itself (AddToHomeScreenLogo renders no button when the
    // install-hint isn't eligible, which is the case in this jsdom
    // environment — see AddToHomeScreen.tsx's `eligible` check).
    const header = document.querySelector('header')
    const hamburger = header?.querySelector('button')
    expect(hamburger).toBeTruthy()
    fireEvent.click(hamburger as HTMLElement)

    // Before the fix: the desktop <aside> (always mounted, only hidden by
    // CSS) and the now-open mobile drawer's <aside> each ran their own
    // SidebarContent — and therefore their own NotificationBell — at once.
    expect(screen.getAllByRole('button', { name: /notifications/i })).toHaveLength(1)
    expect(h.channelCalls).toBe(1)
  })
})
