// @vitest-environment jsdom
//
// nav.ts 已覆盖过滤与高亮的纯逻辑;本文件只验证 WIRING:
// 侧栏只列当前模块的页面、切换器开合、选模块本身绝不触发导航。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'

// SidebarContent itself doesn't touch supabase (NotificationBell is mounted
// once at the <Sidebar> level now, not inside SidebarContent — see the
// comment there), but this file's module graph still pulls it in statically
// (Sidebar.tsx imports NotificationBell.tsx, which imports useNotifications,
// which imports supabase at module scope). vitest loads .env.local, so an
// unmocked import would build a real client against the PRODUCTION database.
// This mock needs a chainable query that resolves, plus channel()/
// removeChannel() for the realtime subscription, or importing this module
// throws "supabase.from(...).select is not a function".
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
      channel: () => channel,
      removeChannel: vi.fn(),
    },
  }
})
vi.mock('../../features/auth/AuthContext', () => ({
  useAuth: () => ({ staff: { id: 's1', name: 'Yong', rank: 'manager', avatar: null }, signOut: vi.fn() }),
}))
vi.mock('../lib/permissions', () => ({ useCan: () => ({ can: () => true }) }))

const { SidebarContent } = await import('./Sidebar')

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <SidebarContent onNavigate={() => {}} />
    </MemoryRouter>,
  )

/** 每次渲染都记录当前 pathname,用来断言点击大类标题后路由是否被悄悄改变了。 */
function LocationSpy({ onRender }: { onRender: (pathname: string) => void }) {
  const { pathname } = useLocation()
  onRender(pathname)
  return null
}

const renderWithLocationSpy = (path: string) => {
  const pathnames: string[] = []
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <LocationSpy onRender={p => pathnames.push(p)} />
      <SidebarContent onNavigate={() => {}} />
    </MemoryRouter>,
  )
  return { ...utils, pathnames }
}

afterEach(() => { cleanup(); localStorage.clear() })

describe('Sidebar 模块导航', () => {
  it('固定项在任何模块下都可见', () => {
    renderAt('/hr/leave')
    expect(screen.getByText('Profile')).toBeTruthy()
    expect(screen.getByText('Settings')).toBeTruthy()
    expect(screen.getByText('Feedback')).toBeTruthy()
  })

  it('侧栏只列当前路径所在模块的页面', () => {
    renderAt('/team/reviews')
    expect(screen.getByText('Directory')).toBeTruthy()
    expect(screen.getByText('Reviews')).toBeTruthy()
    expect(screen.queryByText('Schedule')).toBeNull()
    expect(screen.queryByText('Purchase Orders')).toBeNull()
  })

  it('切换器默认收起,点开后列出全部模块', () => {
    renderAt('/team')
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /switch module/i }))
    const dialog = screen.getByRole('dialog')
    for (const label of ['People', 'Time & Pay', 'Work', 'Inventory']) {
      expect(within(dialog).getByText(label)).toBeTruthy()
    }
  })

  it('选模块只换侧栏的页面清单,不触发导航', () => {
    const { pathnames } = renderWithLocationSpy('/team')
    fireEvent.click(screen.getByRole('button', { name: /switch module/i }))
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Inventory'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('Purchase Orders')).toBeTruthy()
    expect(screen.queryByText('Directory')).toBeNull()
    expect(pathnames[pathnames.length - 1]).toBe('/team')
  })

  it('路径不属于任何模块时,回到上次所在的模块', () => {
    localStorage.setItem('craftos.nav.module', 'time-pay')
    renderAt('/profile')
    expect(screen.getByText('Schedule')).toBeTruthy()
    expect(screen.queryByText('Directory')).toBeNull()
  })

  it('Escape 关闭切换器', () => {
    renderAt('/team')
    fireEvent.click(screen.getByRole('button', { name: /switch module/i }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('侧栏不存在两个指向同一路由的链接', () => {
    renderAt('/team')
    const hrefs = Array.from(document.querySelectorAll('a')).map(a => a.getAttribute('href'))
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })
})
