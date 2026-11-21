import { describe, it, expect } from 'vitest'
import { NAV, visibleNav, activeEntry, isGroup, navShell } from './nav'
import type { Capability } from '../types'

/** 用一组 capability 造 can();未列出的一律 false。 */
const canWith = (...caps: Capability[]) => (c: Capability) => caps.includes(c)

const ids = (entries: ReturnType<typeof visibleNav>) => entries.map(e => e.id)

describe('visibleNav', () => {
  it('无任何 capability 的店员只看到 People(仅 Org Chart)、Time & Pay、POS(仅 Register)与固定项', () => {
    const nav = visibleNav(canWith())
    // POS 模块的 Register 不带 cap,店员也看得到。
    expect(ids(nav)).toEqual(['people', 'time-pay', 'pos', 'profile', 'feedback'])
    const people = nav.find(e => e.id === 'people')!
    expect(isGroup(people) && people.children.map(c => c.id)).toEqual(['org-chart'])
  })

  it('shows Org Chart to staff with no capabilities at all', () => {
    // 组织图人人可看:People 模块本身不带 cap,view_team 写在其余叶子上。
    const people = visibleNav(canWith()).find(e => e.id === 'people')
    expect(people && isGroup(people) ? people.children.map(c => c.id) : []).toContain('org-chart')
  })

  it('店员的 Time & Pay 保留全部五项', () => {
    const nav = visibleNav(canWith())
    const group = nav.find(e => e.id === 'time-pay')!
    expect(isGroup(group) && group.children.map(c => c.id)).toEqual([
      'schedule', 'attendance', 'leave', 'claims', 'salary',
    ])
  })

  it('有 view_team 但无 conduct_reviews 时,People 里没有 Reviews,Work 照常出现', () => {
    const nav = visibleNav(canWith('view_team'))
    const people = nav.find(e => e.id === 'people')!
    expect(isGroup(people) && people.children.map(c => c.id)).toEqual(['directory', 'org-chart'])
    const work = nav.find(e => e.id === 'work')!
    expect(isGroup(work) && work.children.map(c => c.id)).toEqual(['team-tasks', 'team-projects'])
  })

  it('shows Projects to anyone who can see the team area', () => {
    // Projects 只要求 view_team:能看到团队就该看得到专案清单。
    // 写 / 删由 manage_projects 与 RLS 挡,不是靠导航藏起来。
    const nav = visibleNav(cap => cap === 'view_team')
    const work = nav.find(e => e.id === 'work')
    expect(work && isGroup(work) ? work.children.map(c => c.id) : []).toContain('team-projects')
  })

  it('hides Projects from staff, along with the whole Work module', () => {
    const nav = visibleNav(() => false)
    expect(nav.find(e => e.id === 'work')).toBeUndefined()
  })

  it('子项被 capability 全部过滤掉时整个大类消失', () => {
    // Reviews 要 view_team + conduct_reviews 两个都有;只有后者时不该冒出来,
    // Work 模块也因为子项全被滤掉而整个消失。
    const nav = visibleNav(canWith('conduct_reviews'))
    expect(ids(nav)).toEqual(['people', 'time-pay', 'pos', 'profile', 'feedback'])
    const people = nav.find(e => e.id === 'people')!
    expect(isGroup(people) && people.children.map(c => c.id)).toEqual(['org-chart'])
  })

  it('access_settings 控制 Settings 叶子项', () => {
    expect(ids(visibleNav(canWith('access_settings')))).toEqual(['people', 'time-pay', 'pos', 'profile', 'settings', 'feedback'])
  })

  it('POS groups the register, reports, menu, POS settings and devices; staff see only the register', () => {
    const pos = (can: (c: Capability) => boolean) => {
      const g = visibleNav(can).find(e => e.id === 'pos')
      return g && isGroup(g) ? g.children.map(c => c.id) : []
    }
    expect(pos(canWith())).toEqual(['pos-register'])
    expect(pos(canWith('access_settings'))).toEqual(['pos-register', 'pos-reports', 'pos-settings', 'pos-devices'])
    expect(pos(canWith('manage_menu'))).toEqual(['pos-register', 'menu'])
    expect(pos(canWith('access_settings', 'manage_menu'))).toEqual(['pos-register', 'pos-reports', 'menu', 'pos-settings', 'pos-devices'])
  })

  it('Feedback 对所有人可见,排在最后', () => {
    const none = visibleNav(canWith())
    const all = visibleNav(() => true)
    expect(ids(none).slice(-1)).toEqual(['feedback'])
    expect(ids(all).slice(-1)).toEqual(['feedback'])
    expect(activeEntry(all, '/feedback')).toEqual({ leafId: 'feedback', groupId: null })
  })

  it('不修改原始 NAV', () => {
    const before = JSON.stringify(NAV)
    visibleNav(canWith())
    expect(JSON.stringify(NAV)).toBe(before)
  })
})

describe('activeEntry', () => {
  const full = visibleNav(() => true)

  it('/team/reviews 命中 Reviews 而不是 Directory(最长前缀优先)', () => {
    expect(activeEntry(full, '/team/reviews')).toEqual({ leafId: 'team-reviews', groupId: 'people' })
  })

  it('/team 命中 Directory', () => {
    expect(activeEntry(full, '/team')).toEqual({ leafId: 'directory', groupId: 'people' })
  })

  it('/staff/abc 经 activePaths 命中 Directory', () => {
    expect(activeEntry(full, '/staff/abc')).toEqual({ leafId: 'directory', groupId: 'people' })
  })

  it('固定项没有 groupId,Org Chart 归 People', () => {
    expect(activeEntry(full, '/profile')).toEqual({ leafId: 'profile', groupId: null })
    expect(activeEntry(full, '/org-chart')).toEqual({ leafId: 'org-chart', groupId: 'people' })
  })

  it('/team/projects 命中 Projects,不会误点亮 Directory', () => {
    // Directory 的 activePaths 含 '/team',/team/projects 也命中它;
    // 靠 activeEntry 取最长前缀才分得开。少了这条,新增任何 /team/xxx
    // 路由都会让侧栏把 Directory 标成当前页。
    expect(activeEntry(full, '/team/projects')).toEqual({ leafId: 'team-projects', groupId: 'work' })
  })

  it('/pos/reports lights Reports, not the Register (longest prefix wins)', () => {
    expect(activeEntry(full, '/pos/reports')).toEqual({ leafId: 'pos-reports', groupId: 'pos' })
  })

  it('专案详情页 /team/projects/:id 一样归 Projects', () => {
    expect(activeEntry(full, '/team/projects/abc-123')).toEqual({ leafId: 'team-projects', groupId: 'work' })
  })

  it('Task 14:/team/tasks/archive 一样归 Tasks,不会落到别的叶子上', () => {
    // team-tasks 没有自己的 activePaths,靠预设的 [leaf.to] = ['/team/tasks']
    // 做前缀匹配。Archive 是 /team/tasks 底下的子路由,这里钉住「新增子路由不必
    // 手动帮每个既有叶子补 activePaths」这件事真的成立 —— 少了这一条,侧栏会在
    // 使用者点进 Archive 之后连 Tasks 都不亮,看起来像是离开了整个 Team 大类。
    expect(activeEntry(full, '/team/tasks/archive')).toEqual({ leafId: 'team-tasks', groupId: 'work' })
  })

  it('未知路径返回 null', () => {
    expect(activeEntry(full, '/nowhere')).toBeNull()
  })
})

describe('visibleNav 的扁平化结果', () => {
  it('所有 to 值互不相同(即使折叠在同一个大类里)', () => {
    const full = visibleNav(() => true)
    const flatTo = full.flatMap(e => (isGroup(e) ? e.children.map(c => c.to) : [e.to]))
    expect(new Set(flatTo).size).toBe(flatTo.length)
  })
})

describe('Inventory module', () => {
  const childIds = (nav: ReturnType<typeof visibleNav>) => {
    const group = nav.find(e => e.id === 'inventory')
    return group && isGroup(group) ? group.children.map(c => c.id) : null
  }

  it('is hidden from users with neither procurement capability', () => {
    expect(childIds(visibleNav(canWith('view_team', 'manage_hr')))).toBeNull()
  })

  it('shows supervisors (use_procurement only) orders, receiving, transfers, wastage, recipes and inventory, not master data', () => {
    expect(childIds(visibleNav(canWith('use_procurement')))).toEqual([
      'proc-orders', 'proc-receiving', 'proc-transfers', 'proc-wastage', 'proc-inventory', 'proc-recipes',
    ])
  })

  it('shows managers (both capabilities) every procurement page', () => {
    expect(childIds(visibleNav(canWith('manage_procurement', 'use_procurement')))).toEqual([
      'proc-orders', 'proc-receiving', 'proc-transfers', 'proc-wastage', 'proc-inventory', 'proc-recipes',
      'proc-menu-costing', 'proc-items', 'proc-suppliers',
    ])
  })

  it('detail routes highlight their list page', () => {
    const full = visibleNav(() => true)
    expect(activeEntry(full, '/procurement/orders/new')).toEqual({ leafId: 'proc-orders', groupId: 'inventory' })
    expect(activeEntry(full, '/procurement/receiving/po-1')).toEqual({ leafId: 'proc-receiving', groupId: 'inventory' })
    expect(activeEntry(full, '/procurement/items/item-1')).toEqual({ leafId: 'proc-items', groupId: 'inventory' })
    expect(activeEntry(full, '/procurement/inventory/item-1')).toEqual({ leafId: 'proc-inventory', groupId: 'inventory' })
    expect(activeEntry(full, '/procurement/wastage')).toEqual({ leafId: 'proc-wastage', groupId: 'inventory' })
    expect(activeEntry(full, '/procurement/transfers/po-1/ship')).toEqual({ leafId: 'proc-transfers', groupId: 'inventory' })
    expect(activeEntry(full, '/procurement/recipes/item-1/produce')).toEqual({ leafId: 'proc-recipes', groupId: 'inventory' })
    expect(activeEntry(full, '/procurement/menu-costing/v-1')).toEqual({ leafId: 'proc-menu-costing', groupId: 'inventory' })
  })
})

describe('navShell', () => {
  it('店员页面少,平铺不出切换器', () => {
    const shell = navShell(visibleNav(canWith()))
    expect(shell.flat).toBe(true)
    expect(shell.modules.map(m => m.id)).toEqual(['people', 'time-pay', 'pos'])
    expect(shell.pinned.map(p => p.id)).toEqual(['profile', 'feedback'])
  })

  it('全权限时五个模块进切换器,固定项单独列出', () => {
    const shell = navShell(visibleNav(() => true))
    expect(shell.flat).toBe(false)
    expect(shell.modules.map(m => m.id)).toEqual(['people', 'time-pay', 'work', 'inventory', 'pos'])
    expect(shell.pinned.map(p => p.id)).toEqual(['profile', 'settings', 'feedback'])
  })

  it('店员拿到采购权限后页面变多,自动改用切换器', () => {
    // 看的是页面数不是角色:Owner 在 Settings 里加权限,侧栏自己跟着变。
    expect(navShell(visibleNav(canWith('use_procurement'))).flat).toBe(false)
  })
})
