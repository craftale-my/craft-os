// @vitest-environment jsdom
//
// nav.ts 已覆盖过滤与高亮的纯逻辑;本文件只验证 WIRING:
// 大类默认折叠、点击展开/收起、子项在展开后才可见、点击大类本身绝不触发导航。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'

vi.mock('../lib/supabase', () => ({ supabase: { from: () => ({}) } }))
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

afterEach(cleanup)

describe('Sidebar 两级导航', () => {
  it('顶层叶子项始终可见', () => {
    renderAt('/profile')
    expect(screen.getByText('Profile')).toBeTruthy()
    expect(screen.getByText('Settings')).toBeTruthy()
  })

  it('未选中的大类不展开子项', () => {
    renderAt('/profile')
    expect(screen.getByText('Team')).toBeTruthy()
    expect(screen.queryByText('Directory')).toBeNull()
  })

  it('当前路径所在的大类自动展开', () => {
    renderAt('/team/reviews')
    expect(screen.getByText('Directory')).toBeTruthy()
    expect(screen.getByText('Reviews')).toBeTruthy()
  })

  it('点击折叠的大类标题只展开子项,不触发导航', () => {
    const { pathnames } = renderWithLocationSpy('/profile')
    fireEvent.click(screen.getByText('Team'))
    expect(screen.getByText('Directory')).toBeTruthy()
    expect(pathnames[pathnames.length - 1]).toBe('/profile')
  })

  it('点击已展开的大类标题会收起子项,同样不触发导航', () => {
    const { pathnames } = renderWithLocationSpy('/team/reviews')
    // /team/reviews 命中 team-reviews,Team 组已自动展开
    expect(screen.getByText('Directory')).toBeTruthy()
    fireEvent.click(screen.getByText('Team'))
    expect(screen.queryByText('Directory')).toBeNull()
    expect(pathnames[pathnames.length - 1]).toBe('/team/reviews')
  })

  it('侧栏不存在两个指向同一路由的链接', () => {
    renderAt('/team')
    const hrefs = Array.from(document.querySelectorAll('a')).map(a => a.getAttribute('href'))
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })
})
