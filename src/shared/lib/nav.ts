import type { Capability } from '../types'

/**
 * 侧栏的导航树。刻意不含 React 与图标,
 * 好让过滤与高亮规则能脱离渲染单测。图标映射在 Sidebar.tsx。
 */

type Cap = Capability | Capability[]

export interface NavLeaf {
  id: string
  label: string
  to: string
  /** 前缀匹配,命中即视为激活。省略时等价于 [to]。 */
  activePaths?: string[]
  /** 需要的 capability(数组 ⇒ 全部都要有);省略 ⇒ 所有人可见。 */
  cap?: Cap
}

/** 一个模块:左上角切换器里的一格,选中后侧栏只列它的 children。 */
export interface NavGroup {
  id: string
  label: string
  /** 切换器里模块名下面那行说明。 */
  desc?: string
  children: NavLeaf[]
  cap?: Cap
}

export type NavEntry = NavLeaf | NavGroup

export function isGroup(entry: NavEntry): entry is NavGroup {
  return 'children' in entry
}

/**
 * 顺序即显示顺序。大类 = 模块(进切换器),顶层叶子 = 固定项(钉在侧栏底部,
 * 不属于任何模块)。
 *
 * Reviews / Missions / Tasks / Projects 以前靠 Team 组的 view_team 一并挡住;
 * 拆成 People 与 Work 之后组上没有 cap 了(Org Chart 人人可看),所以
 * view_team 要写在每个叶子上,可见范围才和拆分前一致。
 */
export const NAV: NavEntry[] = [
  {
    id: 'people',
    label: 'People',
    desc: 'Staff records, reviews and growth',
    children: [
      { id: 'directory',    label: 'Directory', to: '/team',          activePaths: ['/team', '/staff/'], cap: 'view_team' },
      { id: 'org-chart',    label: 'Org Chart', to: '/org-chart' },
      { id: 'team-reviews', label: 'Reviews',   to: '/team/reviews',  activePaths: ['/team/reviews', '/probation/'], cap: ['view_team', 'conduct_reviews'] },
      { id: 'team-missions',label: 'Missions',  to: '/team/missions', cap: ['view_team', 'manage_missions'] },
    ],
  },
  {
    id: 'time-pay',
    label: 'Time & Pay',
    desc: 'Schedule, attendance, leave and pay',
    children: [
      { id: 'schedule',   label: 'Schedule',   to: '/schedule' },
      { id: 'attendance', label: 'Attendance', to: '/hr/attendance' },
      { id: 'leave',      label: 'Leave',      to: '/hr/leave' },
      { id: 'claims',     label: 'Claims',     to: '/hr/claims' },
      { id: 'salary',     label: 'Salary',     to: '/hr/salary' },
    ],
  },
  {
    id: 'work',
    label: 'Work',
    desc: 'Tasks and projects',
    children: [
      { id: 'team-tasks',   label: 'Tasks',    to: '/team/tasks',    cap: 'view_team' },
      { id: 'team-projects',label: 'Projects', to: '/team/projects', cap: 'view_team' },
    ],
  },
  {
    id: 'inventory',
    label: 'Inventory',
    desc: 'Purchasing, stock and recipes',
    children: [
      { id: 'proc-orders',    label: 'Purchase Orders', to: '/procurement/orders', cap: 'use_procurement' },
      { id: 'proc-receiving', label: 'Receiving', to: '/procurement/receiving', cap: 'use_procurement' },
      { id: 'proc-transfers', label: 'Transfers', to: '/procurement/transfers', cap: 'use_procurement' },
      { id: 'proc-wastage',   label: 'Wastage',   to: '/procurement/wastage',   cap: 'use_procurement' },
      { id: 'proc-inventory', label: 'Stock on Hand', to: '/procurement/inventory', cap: 'use_procurement' },
      { id: 'proc-recipes',   label: 'Recipes',   to: '/procurement/recipes',   cap: 'use_procurement' },
      { id: 'proc-items',     label: 'Items',     to: '/procurement/items',     cap: 'manage_procurement' },
      { id: 'proc-suppliers', label: 'Suppliers', to: '/procurement/suppliers', cap: 'manage_procurement' },
    ],
  },
  {
    id: 'pos',
    label: 'POS',
    desc: 'Register, menu, sales reports and devices',
    children: [
      { id: 'pos-register', label: 'Register',          to: '/pos', activePaths: ['/pos'] },
      { id: 'pos-reports',  label: 'Reports',           to: '/pos/reports', cap: 'access_settings' },
      { id: 'menu',         label: 'Menu',              to: '/menu', activePaths: ['/menu'], cap: 'manage_menu' },
      { id: 'pos-settings', label: 'POS Settings',      to: '/pos/settings', cap: 'access_settings' },
      { id: 'pos-devices',  label: 'Devices',           to: '/pos/devices', cap: 'access_settings' },
    ],
  },
  { id: 'profile', label: 'Profile', to: '/profile' },
  { id: 'settings', label: 'Settings', to: '/settings', cap: 'access_settings' },
  { id: 'feedback', label: 'Feedback', to: '/feedback' },
]

function allowed(cap: Cap | undefined, can: (cap: Capability) => boolean): boolean {
  if (!cap) return true
  return Array.isArray(cap) ? cap.every(can) : can(cap)
}

/** 按 capability 过滤。子项全被滤掉的大类整体消失。 */
export function visibleNav(can: (cap: Capability) => boolean): NavEntry[] {
  const out: NavEntry[] = []
  for (const entry of NAV) {
    if (!allowed(entry.cap, can)) continue
    if (!isGroup(entry)) { out.push(entry); continue }
    const children = entry.children.filter(c => allowed(c.cap, can))
    if (children.length > 0) out.push({ ...entry, children })
  }
  return out
}

/** 模块页面总数不超过这个数,就不值得多一层切换器。 */
export const FLAT_NAV_MAX = 8

export interface NavShell {
  /** 切换器里的模块,已按 capability 过滤。 */
  modules: NavGroup[]
  /** 钉在侧栏底部的固定项。 */
  pinned: NavLeaf[]
  /**
   * true ⇒ 不出切换器,所有模块的页面平铺成一张清单。一般店员只有
   * Org Chart + Time & Pay 六项,多一层只会让他们多点一下。看页面数而不是
   * 看角色:Owner 在 Settings 里给某个角色加了权限,侧栏会自己跟着变。
   */
  flat: boolean
}

export function navShell(nav: NavEntry[]): NavShell {
  const modules = nav.filter(isGroup)
  const pinned = nav.filter((e): e is NavLeaf => !isGroup(e))
  const pages = modules.reduce((n, m) => n + m.children.length, 0)
  return { modules, pinned, flat: modules.length <= 1 || pages <= FLAT_NAV_MAX }
}

/**
 * 当前路径命中的叶子项与其所属大类。前缀最长者优先,
 * 否则 /team 会把 /team/reviews 也一并点亮。
 */
export function activeEntry(
  nav: NavEntry[],
  pathname: string,
): { leafId: string; groupId: string | null } | null {
  const pairs: Array<{ leaf: NavLeaf; groupId: string | null }> = []
  for (const entry of nav) {
    if (isGroup(entry)) entry.children.forEach(c => pairs.push({ leaf: c, groupId: entry.id }))
    else pairs.push({ leaf: entry, groupId: null })
  }

  let best: { leafId: string; groupId: string | null; len: number } | null = null
  for (const { leaf, groupId } of pairs) {
    for (const p of leaf.activePaths ?? [leaf.to]) {
      if (pathname !== p && !pathname.startsWith(p)) continue
      if (!best || p.length > best.len) best = { leafId: leaf.id, groupId, len: p.length }
    }
  }

  return best ? { leafId: best.leafId, groupId: best.groupId } : null
}
