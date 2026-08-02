// @vitest-environment jsdom
//
// nav.ts 已覆盖过滤与高亮的纯逻辑;本文件只验证 WIRING:
// 大类默认折叠、点击展开、子项在展开后才可见。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

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

  it('点击大类标题展开其子项,并落在第一个可见子项上', () => {
    renderAt('/profile')
    fireEvent.click(screen.getByText('Team'))
    expect(screen.getByText('Directory')).toBeTruthy()
    expect(screen.getByText('Directory').closest('a')?.getAttribute('href')).toBe('/team')
  })

  it('侧栏不存在两个指向同一路由的链接', () => {
    renderAt('/team')
    const hrefs = Array.from(document.querySelectorAll('a')).map(a => a.getAttribute('href'))
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })
})
