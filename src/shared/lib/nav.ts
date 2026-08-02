import type { Capability } from '../types'

/**
 * 侧栏的导航树。刻意不含 React 与图标,
 * 好让过滤与高亮规则能脱离渲染单测。图标映射在 Sidebar.tsx。
 */

export interface NavLeaf {
  id: string
  label: string
  to: string
  /** 前缀匹配,命中即视为激活。省略时等价于 [to]。 */
  activePaths?: string[]
  /** 需要的 capability;省略 ⇒ 所有人可见。 */
  cap?: Capability
}

export interface NavGroup {
  id: string
  label: string
  children: NavLeaf[]
  cap?: Capability
}

export type NavEntry = NavLeaf | NavGroup

export function isGroup(entry: NavEntry): entry is NavGroup {
  return 'children' in entry
}

export const NAV: NavEntry[] = [
  { id: 'profile', label: 'Profile', to: '/profile' },
  {
    id: 'team',
    label: 'Team',
    cap: 'view_team',
    children: [
      { id: 'directory',    label: 'Directory', to: '/team',          activePaths: ['/team', '/staff/'] },
      { id: 'team-reviews', label: 'Reviews',   to: '/team/reviews',  activePaths: ['/team/reviews', '/probation/'], cap: 'conduct_reviews' },
      { id: 'team-missions',label: 'Missions',  to: '/team/missions', cap: 'manage_missions' },
      { id: 'team-tasks',   label: 'Tasks',     to: '/team/tasks' },
    ],
  },
  {
    id: 'time-pay',
    label: 'Time & Pay',
    children: [
      { id: 'schedule',   label: 'Schedule',   to: '/schedule' },
      { id: 'attendance', label: 'Attendance', to: '/hr/attendance' },
      { id: 'leave',      label: 'Leave',      to: '/hr/leave' },
      { id: 'claims',     label: 'Claims',     to: '/hr/claims' },
      { id: 'salary',     label: 'Salary',     to: '/hr/salary' },
    ],
  },
  { id: 'settings', label: 'Settings', to: '/settings', cap: 'access_settings' },
]

/** 按 capability 过滤。子项全被滤掉的大类整体消失。 */
export function visibleNav(can: (cap: Capability) => boolean): NavEntry[] {
  const out: NavEntry[] = []
  for (const entry of NAV) {
    if (entry.cap && !can(entry.cap)) continue
    if (!isGroup(entry)) { out.push(entry); continue }
    const children = entry.children.filter(c => !c.cap || can(c.cap))
    if (children.length > 0) out.push({ ...entry, children })
  }
  return out
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
