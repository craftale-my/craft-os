# Navigation IA 重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把平铺的 15 项侧栏改成「顶层叶子 + 两个可展开大类」的两级结构,并拆开 2025 行的 `Dashboard.tsx`,使后续模块有确定的落位规则。

**Architecture:** 导航结构抽成不含 React 的纯模块 `shared/lib/nav.ts`(沿用仓库既有的 `shared/lib/tabs.ts` 模式),`Sidebar.tsx` 只负责渲染与展开态。`Dashboard.tsx` 按职责拆成 `features/team/Directory.tsx`(名册/注册审批/动态)与 `features/team/Reviews.tsx`(四个考核 tab),共用数据抽成 `useTeamData`。旧路由全部保留重定向。

**Tech Stack:** React 19 · react-router-dom 7 · TypeScript · Vitest 2.1 + @testing-library/react · Tailwind · Supabase

## Global Constraints

- **UI 文案一律英文。** 侧栏标签、tab 标签、按钮文字均为英文,不得出现中文。
- **规则 1:** ≥3 个独立路由 → 升为顶层大类;1-2 个 → 作为页内 tab 挂进最近的大类。
- **规则 2:** 页内 tab 永远不进侧栏。禁止用 `scrollTo` / `scrollIntoView` 把 section 提升为导航项。
- **规则 3:** 一个功能在侧栏只出现一次。
- **规则 4:** 个人视图与团队视图的区分放在页面内部,不体现为导航分组。
- **测试环境:** 涉及组件渲染的测试文件首行必须写 `// @vitest-environment jsdom`,本仓库无全局 setup 文件。
- **Supabase:** 本仓库无 dev 环境,本地开发直连 PROD。测试一律 mock `shared/lib/supabase`,不得产生真实读写。
- **前置依赖 A:** capability 系统半失效(`view_salary` / `manage_staff` 从未被读取,`HrSalary.tsx:370` / `HrLeave.tsx:624` / `HrClaims.tsx:357` 用 rank 硬判断绕开)。本计划不修它,但 Task 6 的分组过滤依赖 capability 可信。开工前确认它已被处理或已知悉风险。
- **前置依赖 B:** `stash@{0}` 的 mobile-pwa-shell WIP 同样改写 `Sidebar.tsx`(移除移动端顶栏、导出 `SidebarContent`、新增 `shared/lib/tabs.ts`)。**应先落地它再执行本计划**,否则 Task 6 会与之冲突。若它已落地,Task 6 需额外同步 `shared/lib/tabs.ts`:`team` → `/team`、`tasks` → `/team/tasks`,`missions` 从 `STAFF_TABS` 移除并以 `leave` 补位。
- **不在本期范围:** `Home` 个人落地页、`Time & Pay` 五页的内部拆分、`Settings` 的 11 个 tab。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `src/shared/lib/nav.ts` (新) | 导航树定义 + 过滤/高亮的纯函数,不含 React 与图标 |
| `src/shared/lib/nav.test.ts` (新) | 上述纯逻辑的单测 |
| `src/shared/components/Sidebar.tsx` (改) | 从 `nav.ts` 渲染,持有图标映射与展开态 |
| `src/features/team/useTeamData.ts` (新) | Directory 与 Reviews 共用的 staff 列表与加载态 |
| `src/features/team/Reviews.tsx` (新) | `/team/reviews`,四个 tab |
| `src/features/team/Directory.tsx` (新) | `/team`,名册 + 注册审批 + 动态流 |
| `src/features/staff/Dashboard.tsx` (删) | 拆分后删除 |
| `src/App.tsx` (改) | 新路由与重定向 |

---

### Task 1: 导航模型(纯逻辑)

**Files:**
- Create: `src/shared/lib/nav.ts`
- Test: `src/shared/lib/nav.test.ts`

**Interfaces:**
- Consumes: `Capability` from `src/shared/types`
- Produces: `NavLeaf`, `NavGroup`, `NavEntry`, `isGroup(e)`, `NAV`, `visibleNav(can)`, `activeEntry(nav, pathname)`

本任务不改变任何用户可见行为,只新增模块与测试。

- [ ] **Step 1: 写失败的测试**

创建 `src/shared/lib/nav.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { NAV, visibleNav, activeEntry, isGroup } from './nav'
import type { Capability } from '../types'

/** 用一组 capability 造 can();未列出的一律 false。 */
const canWith = (...caps: Capability[]) => (c: Capability) => caps.includes(c)

const ids = (entries: ReturnType<typeof visibleNav>) => entries.map(e => e.id)

describe('visibleNav', () => {
  it('无任何 capability 的店员只看到 Profile 与 Time & Pay', () => {
    const nav = visibleNav(canWith())
    expect(ids(nav)).toEqual(['profile', 'time-pay'])
  })

  it('店员的 Time & Pay 保留全部五项', () => {
    const nav = visibleNav(canWith())
    const group = nav.find(e => e.id === 'time-pay')!
    expect(isGroup(group) && group.children.map(c => c.id)).toEqual([
      'schedule', 'attendance', 'leave', 'claims', 'salary',
    ])
  })

  it('有 view_team 但无 conduct_reviews 时,Team 组里没有 Reviews', () => {
    const nav = visibleNav(canWith('view_team'))
    const team = nav.find(e => e.id === 'team')!
    expect(isGroup(team) && team.children.map(c => c.id)).toEqual(['directory', 'team-tasks'])
  })

  it('子项被 capability 全部过滤掉时整个大类消失', () => {
    // view_team 是 Team 组本身的 cap;没有它,组不出现
    expect(ids(visibleNav(canWith('conduct_reviews')))).toEqual(['profile', 'time-pay'])
  })

  it('access_settings 控制 Settings 叶子项', () => {
    expect(ids(visibleNav(canWith('access_settings')))).toEqual(['profile', 'time-pay', 'settings'])
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
    expect(activeEntry(full, '/team/reviews')).toEqual({ leafId: 'team-reviews', groupId: 'team' })
  })

  it('/team 命中 Directory', () => {
    expect(activeEntry(full, '/team')).toEqual({ leafId: 'directory', groupId: 'team' })
  })

  it('/staff/abc 经 activePaths 命中 Directory', () => {
    expect(activeEntry(full, '/staff/abc')).toEqual({ leafId: 'directory', groupId: 'team' })
  })

  it('顶层叶子项没有 groupId', () => {
    expect(activeEntry(full, '/profile')).toEqual({ leafId: 'profile', groupId: null })
  })

  it('未知路径返回 null', () => {
    expect(activeEntry(full, '/nowhere')).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `npx vitest run src/shared/lib/nav.test.ts`
Expected: FAIL — `Failed to resolve import "./nav"`

- [ ] **Step 3: 实现 nav.ts**

创建 `src/shared/lib/nav.ts`:

```ts
import type { Capability } from '../types'

/**
 * 侧栏的导航树。与 shared/lib/tabs.ts 同样刻意不含 React 与图标,
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
  let best: { leafId: string; groupId: string | null; len: number } | null = null

  const consider = (leaf: NavLeaf, groupId: string | null) => {
    for (const p of leaf.activePaths ?? [leaf.to]) {
      if (pathname !== p && !pathname.startsWith(p)) continue
      if (!best || p.length > best.len) best = { leafId: leaf.id, groupId, len: p.length }
    }
  }

  for (const entry of nav) {
    if (isGroup(entry)) entry.children.forEach(c => consider(c, entry.id))
    else consider(entry, null)
  }

  return best ? { leafId: best.leafId, groupId: best.groupId } : null
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `npx vitest run src/shared/lib/nav.test.ts`
Expected: PASS,11 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add src/shared/lib/nav.ts src/shared/lib/nav.test.ts
git commit -m "feat: add React-free navigation model with capability filtering"
```

---

### Task 2: 新路由与重定向

**Files:**
- Modify: `src/App.tsx`(路由表、`:215` 落地页)
- Modify: `src/features/auth/ProtectedRoute.tsx:53`
- Modify: `src/shared/components/Sidebar.tsx`(仅改 `to:` 值,结构不动)

**Interfaces:**
- Consumes: Task 1 无输出被本任务使用(nav.ts 尚未接线)
- Produces: 可用路由 `/team`、`/team/tasks`、`/team/missions`;旧路径 `/dashboard`、`/tasks` 重定向

本任务后页面内容不变,只是换了 URL,且旧书签仍可用。`/team` 暂时仍渲染 `DashboardPage`,Task 3-4 再替换。

- [ ] **Step 1: 加新路由**

在 `src/App.tsx` 中,把现有 `/dashboard` 路由块替换为:

```tsx
      <Route
        path="/team"
        element={
          <ProtectedRoute requireCap="view_team">
            <AppLayout><DashboardPage /></AppLayout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/team/tasks"
        element={
          <ProtectedRoute requireCap="view_team">
            <AppLayout><TasksPage /></AppLayout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/team/missions"
        element={
          <ProtectedRoute requireCap="manage_missions">
            <AppLayout><GrowthPage /></AppLayout>
          </ProtectedRoute>
        }
      />

      {/* 旧入口:保留至少一个发布周期,覆盖书签与已安装 PWA */}
      <Route path="/dashboard" element={<Navigate to="/team" replace />} />
      <Route path="/tasks" element={<Navigate to="/team/tasks" replace />} />
```

删除原来的 `/tasks` 路由块(它已被上面的重定向取代)。

- [ ] **Step 2: 改两处落地页跳转**

`src/App.tsx` 第 215 行附近,`/` 路由内:

```tsx
            ? <Navigate to={
                effectiveSystemRole(staff) !== 'staff'
                  ? '/team'
                  : '/profile'
              } replace />
```

`src/features/auth/ProtectedRoute.tsx:53`:

```tsx
    const dest = staff.rank === 'manager' || staff.rank === 'supervisor' ? '/team' : '/profile'
```

- [ ] **Step 3: 改侧栏的 to 值**

`src/shared/components/Sidebar.tsx` 的 `MGMT_NAV`,把五处 `to: '/dashboard'` 改为 `to: '/team'`,`to: '/tasks'` 改为 `to: '/team/tasks'`,并把 `team-dash` 的 `activePaths` 改为 `['/team', '/staff/']`。`scrollTo` 字段本任务暂不动,Task 6 统一清理。

- [ ] **Step 4: 构建并手动验证**

Run: `npm run build`
Expected: 构建成功,无 TypeScript 错误

Run: `npm run dev`,以 manager 账号登录,逐一确认:
- 登录后落在 `/team`,页面内容与改动前的 `/dashboard` 一致
- 浏览器直接访问 `/dashboard` 跳转到 `/team`
- 直接访问 `/tasks` 跳转到 `/team/tasks`
- 侧栏 `Tasks` 可达

- [ ] **Step 5: 提交**

```bash
git add src/App.tsx src/features/auth/ProtectedRoute.tsx src/shared/components/Sidebar.tsx
git commit -m "refactor: move team routes under /team with redirects from old paths"
```

---

### Task 3: 抽出 useTeamData 并拆出 Reviews 页

**Files:**
- Create: `src/features/team/useTeamData.ts`
- Create: `src/features/team/Reviews.tsx`
- Modify: `src/features/staff/Dashboard.tsx`(移出四个考核 section 与两个弹窗)
- Modify: `src/App.tsx`(新增 `/team/reviews` 路由)

**Interfaces:**
- Consumes: `/team` 路由(Task 2)
- Produces: `useTeamData()` 返回 `{ staff: Staff[]; loading: boolean; reload: () => void }`;`/team/reviews` 路由

- [ ] **Step 1: 抽出共用数据 hook**

创建 `src/features/team/useTeamData.ts`。把 `Dashboard.tsx` 中拉取全员 staff 列表的逻辑原样搬进来(保留其原有的 branch 过滤与排序),对外暴露:

```ts
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../shared/lib/supabase'
import type { Staff } from '../../shared/types'

/** Directory 与 Reviews 共用的全员名册。两页都要,分开取会重复请求。 */
export function useTeamData() {
  const [staff, setStaff] = useState<Staff[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(() => {
    setLoading(true)
    supabase.from('staff').select('*').order('name').then(({ data }) => {
      if (data) setStaff(data as Staff[])
      setLoading(false)
    })
  }, [])

  useEffect(() => { reload() }, [reload])

  return { staff, loading, reload }
}
```

搬运时以 `Dashboard.tsx` 现有实现为准:若它对 `status`、`branch_id` 有额外过滤,一并保留,不要在本次重构中改变数据语义。

- [ ] **Step 2: 建 Reviews 页外壳**

创建 `src/features/team/Reviews.tsx`:

```tsx
import { useState } from 'react'
import { useTeamData } from './useTeamData'

type Tab = 'monthly' | 'probation' | 'skills' | 'promotion'

const TAB_LABELS: Record<Tab, string> = {
  monthly:   'Monthly',
  probation: 'Probation',
  skills:    'Skills',
  promotion: 'Promotion',
}

export default function ReviewsPage() {
  const [tab, setTab] = useState<Tab>('monthly')
  const { staff, loading, reload } = useTeamData()

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold text-brown-dark mb-6">Reviews</h1>

      <div className="flex gap-1 mb-6 bg-white shadow-card rounded-xl p-1 overflow-x-auto">
        {(Object.keys(TAB_LABELS) as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2 text-sm rounded-lg whitespace-nowrap px-2 transition-colors ${
              tab === t
                ? 'bg-[#4A2E1A] text-[#F5F0E8] font-medium'
                : 'text-brown-muted hover:text-brown-dark'
            }`}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {tab === 'monthly'   && <MonthlyReviews   staff={staff} loading={loading} onChange={reload} />}
      {tab === 'probation' && <ProbationReviews staff={staff} loading={loading} onChange={reload} />}
      {tab === 'skills'    && <SkillAssessments staff={staff} loading={loading} onChange={reload} />}
      {tab === 'promotion' && <PromotionReviews staff={staff} loading={loading} onChange={reload} />}
    </div>
  )
}
```

- [ ] **Step 3: 搬运四个 section**

从 `src/features/staff/Dashboard.tsx` **原样剪切**下列区块到 `Reviews.tsx`,各自包成上面引用的组件,props 一律为 `{ staff, loading, onChange }`:

| 源区块 | 目标组件 |
| --- | --- |
| `<section id="reviews-section">`(`:1477` 起) | `MonthlyReviews` |
| `<section id="probation-section">`(`:1581` 起) | `ProbationReviews` |
| `<section id="skill-assessments-section">`(`:1683` 起) | `SkillAssessments` |
| `<section id="promotion-reviews-section">`(`:1736` 起) | `PromotionReviews` |

同时搬运其关联弹窗:Fail Assessment(`:500` 起)、Promotion Evaluation(`:633` 起)。

搬运原则:**只搬不改**。JSX 内容、类名、Supabase 查询保持原样;仅把原先读自 Dashboard 局部 state 的 staff 列表改为读 props。外层 `<section id="...">` 的 id 属性删除——它们只为 `scrollTo` 存在(规则 2)。

- [ ] **Step 4: 挂路由**

`src/App.tsx` 顶部加 `import ReviewsPage from './features/team/Reviews'`,并在 `/team` 之后加:

```tsx
      <Route
        path="/team/reviews"
        element={
          <ProtectedRoute requireCap="conduct_reviews">
            <AppLayout><ReviewsPage /></AppLayout>
          </ProtectedRoute>
        }
      />
```

- [ ] **Step 5: 构建并验证**

Run: `npm run build`
Expected: 构建成功

Run: `npm run dev`,以有 `conduct_reviews` 的账号验证:
- `/team/reviews` 四个 tab 均可切换,内容与改动前 `/dashboard` 上对应 section 一致
- `/team` 上这四个 section 已消失,其余部分(名册、注册审批、动态)完好
- Fail Assessment 与 Promotion Evaluation 弹窗在新页面可正常打开与提交

- [ ] **Step 6: 提交**

```bash
git add src/features/team/useTeamData.ts src/features/team/Reviews.tsx src/features/staff/Dashboard.tsx src/App.tsx
git commit -m "refactor: split the four review sections out into /team/reviews"
```

---

### Task 4: Dashboard 更名为 Directory

**Files:**
- Create: `src/features/team/Directory.tsx`(由 `Dashboard.tsx` 移动而来)
- Delete: `src/features/staff/Dashboard.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `useTeamData()`(Task 3)
- Produces: `/team` 由 `DirectoryPage` 承载

- [ ] **Step 1: 移动文件**

```bash
git mv src/features/staff/Dashboard.tsx src/features/team/Directory.tsx
```

- [ ] **Step 2: 改默认导出名与标题**

`Directory.tsx` 中把默认导出的组件名改为 `DirectoryPage`,页面 `<h1>` 的文案由 `Dashboard` 改为 `Directory`(英文,见 Global Constraints)。

改用共用 hook:删除文件内自己拉取 staff 列表的 state 与 effect,替换为 `const { staff, loading, reload } = useTeamData()`,并把原先调用本地刷新函数的地方改为 `reload()`。

- [ ] **Step 3: 更新引用**

`src/App.tsx` 把 `import DashboardPage from './features/staff/Dashboard'` 改为 `import DirectoryPage from './features/team/Directory'`,并把 `/team` 路由的 `<DashboardPage />` 改为 `<DirectoryPage />`。

Run: `grep -rn "features/staff/Dashboard\|DashboardPage" src`
Expected: 无输出

- [ ] **Step 4: 构建并验证**

Run: `npm run build`
Expected: 构建成功

Run: `npx vitest run`
Expected: 现有 7 个测试文件全部通过(本次重构不应影响它们)

Run: `npm run dev`,确认 `/team` 名册、筛选、注册审批(pending / rejected 子 tab)、动态流、Add New Staff 弹窗均正常。

- [ ] **Step 5: 提交**

```bash
git add -A src/features src/App.tsx
git commit -m "refactor: rename Dashboard to team Directory and share the staff query"
```

---

### Task 5: Growth 折进 Profile

**Files:**
- Modify: `src/features/staff/StaffProfile.tsx`(新增 Career tab)
- Modify: `src/features/growth/GrowthPage.tsx`(只保留管理视图)
- Modify: `src/App.tsx`(`/missions` 重定向)

**Interfaces:**
- Consumes: `/team/missions` 路由(Task 2)
- Produces: `StaffProfile` 的 tab 集合增加 `career`

`GrowthPage` 现有三个 tab:`career` / `missions` / `manage`。前两个与 Profile 重复(`GrowthPage.tsx:9` 直接 import 了 `MissionsTab`),折进 Profile;`manage` 留在 `/team/missions`。

- [ ] **Step 1: Profile 增加 Career tab**

`src/features/staff/StaffProfile.tsx:24-32`,把 `Tab` 类型与 `TAB_LABELS` 改为:

```ts
type Tab = 'missions' | 'skills' | 'career' | 'personal' | 'reviews' | 'history'

const TAB_LABELS: Record<Tab, string> = {
  missions: 'Missions',
  skills:   'Skills',
  career:   'Career',
  personal: 'Personal',
  reviews:  'Reviews',
  history:  'History',
}
```

把 `GrowthPage.tsx` 里的 `CareerProgress` 组件原样剪切到新文件 `src/features/staff/CareerProgress.tsx`(具名导出 `CareerProgress`),在 `StaffProfile.tsx` 中 `import { CareerProgress } from './CareerProgress'`,并在 tab 渲染处加:

```tsx
        {tab === 'career' && <CareerProgress staff={staff} />}
```

- [ ] **Step 2: GrowthPage 只留管理视图**

`src/features/growth/GrowthPage.tsx` 删除 `career` 与 `missions` 两个 tab 及其切换 UI,直接渲染原 `manage` tab 的内容(`MissionsPage`)。页面 `<h1>` 由 `Growth` 改为 `Missions`。移除对 `MissionsTab` 的 import(`:9`)——该重复引用是本次要消除的目标之一。

- [ ] **Step 3: 加重定向**

`src/App.tsx` 把原 `/missions` 路由块替换为:

```tsx
      <Route path="/missions" element={<Navigate to="/profile" replace />} />
```

- [ ] **Step 4: 构建并验证**

Run: `npm run build`
Expected: 构建成功

Run: `npm run dev`:
- 以店员账号访问 `/missions`,跳转到 `/profile`,且 Missions 与 Career 两个 tab 内容与改动前一致
- 以有 `manage_missions` 的账号访问 `/team/missions`,任务库增删改查正常

- [ ] **Step 5: 提交**

```bash
git add src/features/staff/StaffProfile.tsx src/features/growth/GrowthPage.tsx src/App.tsx
git commit -m "refactor: fold personal growth views into Profile tabs"
```

---

### Task 6: 侧栏改为两级并清理历史补丁

**Files:**
- Modify: `src/shared/components/Sidebar.tsx`(整体重写导航部分)
- Test: `src/shared/components/Sidebar.test.tsx`(新建)

**Interfaces:**
- Consumes: `visibleNav`、`activeEntry`、`isGroup`、`NavEntry`(Task 1);Task 2-5 建立的全部新路由
- Produces: 无下游任务

- [ ] **Step 1: 写失败的测试**

创建 `src/shared/components/Sidebar.test.tsx`:

```tsx
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
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `npx vitest run src/shared/components/Sidebar.test.tsx`
Expected: FAIL — 现有侧栏是平铺的,`Directory` 在 `/profile` 下也可见,且存在重复 href

- [ ] **Step 3: 重写侧栏导航部分**

`src/shared/components/Sidebar.tsx`:

删除 `STAFF_NAV`、`HR_NAV`、`MGMT_NAV`、`SETTINGS_NAV` 四个常量、`NavItem` 接口、`isActive` 函数,以及 `scrollTo` 与 `hideWithCap` 两个字段的全部用法——它们分别是规则 2 与规则 3 的历史补丁,留着会诱导后来者复用。

新增图标映射(`nav.ts` 刻意不含图标):

```tsx
import { visibleNav, activeEntry, isGroup } from '../lib/nav'
import type { NavLeaf, NavGroup } from '../lib/nav'

const ICONS: Record<string, LucideIcon> = {
  profile: User,
  directory: Users,
  'team-reviews': ClipboardList,
  'team-missions': Target,
  'team-tasks': CheckSquare,
  schedule: CalendarDays,
  attendance: CalendarCheck,
  leave: Palmtree,
  claims: Receipt,
  salary: Wallet,
  settings: Settings,
}
```

`NavLink` 改为消费 `NavLeaf`:

```tsx
function NavLink({ leaf, active, onNavigate }: {
  leaf: NavLeaf
  active: boolean
  onNavigate: () => void
}) {
  const Icon = ICONS[leaf.id]
  return (
    <Link
      to={leaf.to}
      onClick={onNavigate}
      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
        active
          ? 'bg-[#8B6344] text-[#F5F0E8] font-semibold'
          : 'text-[#D4C4B0] hover:bg-[#5A3A22] hover:text-[#F5F0E8]'
      }`}
    >
      {Icon && <Icon size={16} className="flex-shrink-0" />}
      <span className="truncate">{leaf.label}</span>
    </Link>
  )
}
```

`SidebarContent` 内部的状态与展开逻辑。折叠中的大类被点击时展开并跳到第一个子项;已展开的大类被点击时仅折叠,不导航:

```tsx
  const nav = visibleNav(can)
  const active = activeEntry(nav, pathname)
  const [openGroup, setOpenGroup] = useState<string | null>(active?.groupId ?? null)
  const navigate = useNavigate()

  // 路由变化时,让当前所在的大类保持展开
  useEffect(() => {
    if (active?.groupId) setOpenGroup(active.groupId)
  }, [active?.groupId])

  function toggleGroup(group: NavGroup) {
    if (openGroup === group.id) { setOpenGroup(null); return }
    setOpenGroup(group.id)
    if (group.children[0]) { navigate(group.children[0].to); onNavigate() }
  }
```

导航区渲染(替换原来四个 section 的 JSX,logo、用户卡片、Sign out 三块不动):

```tsx
      <nav className="flex-1 px-3 space-y-1 overflow-y-auto pb-2 min-h-0">
        {nav.map(entry => {
          if (!isGroup(entry)) {
            return (
              <NavLink
                key={entry.id}
                leaf={entry}
                active={active?.leafId === entry.id}
                onNavigate={onNavigate}
              />
            )
          }
          const open = openGroup === entry.id
          return (
            <div key={entry.id}>
              <button
                onClick={() => toggleGroup(entry)}
                className="flex items-center justify-between w-full px-3 py-2.5 rounded-lg text-sm
                           text-[#D4C4B0] hover:bg-[#5A3A22] hover:text-[#F5F0E8] transition-colors"
              >
                <span className="font-semibold tracking-wide">{entry.label}</span>
                <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
              </button>
              {open && (
                <div className="mt-0.5 ml-3 pl-2 border-l border-[#5A3A22] space-y-0.5">
                  {entry.children.map(leaf => (
                    <NavLink
                      key={leaf.id}
                      leaf={leaf}
                      active={active?.leafId === leaf.id}
                      onNavigate={onNavigate}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </nav>
```

需要补的 import:`useState` / `useEffect` from `react`,`useNavigate` from `react-router-dom`,`ChevronDown` from `lucide-react`,以及 `NavGroup` from `../lib/nav`。原先的 `Menu` 等未再使用的图标 import 一并删除,否则 `npm run lint` 会报未使用变量。

- [ ] **Step 4: 运行测试,确认通过**

Run: `npx vitest run src/shared/components/Sidebar.test.tsx`
Expected: PASS,5 个用例全绿

- [ ] **Step 5: 全量回归**

Run: `npx vitest run`
Expected: 全部测试文件通过

Run: `npm run build`
Expected: 构建成功

Run: `grep -rn "scrollTo\|scrollIntoView" src`
Expected: 无输出(验收标准 2)

- [ ] **Step 6: 逐条核对验收标准**

以真实账号在 `npm run dev` 下确认:

1. 侧栏不存在两个指向同一路由的项
2. 代码中无 `scrollTo` / `scrollIntoView` 导航(见 Step 5)
3. `/dashboard`、`/tasks`、`/missions` 访问后正确重定向
4. 无 capability 的店员登录后侧栏为 6 项:`Profile` + `Time & Pay` 五项
5. 全 capability manager 为 11 项,且任一时刻可见行数不超过 `Profile` + 2 个大类标题 + 当前展开组的子项 + `Settings`
6. `Directory.tsx` 与 `Reviews.tsx` 各自不超过约 1200 行 — Run: `wc -l src/features/team/*.tsx`
7. `promotion-reviews-section` 的内容可经 `/team/reviews` 的 `Promotion` tab 到达

- [ ] **Step 7: 提交**

```bash
git add src/shared/components/Sidebar.tsx src/shared/components/Sidebar.test.tsx
git commit -m "feat: render the sidebar as two levels from the nav model"
```

---

## 收尾

全部任务完成后,按 [[push_github_on_wrapup]] 的惯例推送:

```bash
git push origin main
```

若 `feature/po-system` 随后合并,按 spec 的「预留的未来大类」把 `PROCUREMENT` 作为第 5 个大类加进 `nav.ts` 的 `NAV`:子项 `Purchase Orders` / `Receiving` / `Inventory` 用 `use_procurement`,`Suppliers` / `Items` 用 `manage_procurement`。除 `NAV` 与 `ICONS` 两处外无需改动任何导航代码——这正是本次分层要换来的性质。
