# 导航信息架构(Navigation IA)分层设计

Status: Draft
Date: 2026-08-02
Baseline: `main` @ `2f4137b`

## 背景

功能持续增加,侧栏是平铺的一层结构,加一个功能就多一行。诉求不是"砍菜单",而是**建立大类/小类的分层规则**,让后续的 `PROCUREMENT` / `SALES` / `COSTING` 有确定的位置可放,不用每次重新拍板。

本设计只解决导航结构。页面内部的业务逻辑不动。

## 现状问题

### 1. 15 个菜单项背后只有 10 个真实路由

以拥有全部 capability 的 manager 为准(`STAFF_NAV` 3 项 + `HR_NAV` 4 项 + `MGMT_NAV` 7 项 + `SETTINGS_NAV` 1 项):

| 重复 | 位置 | 说明 |
| --- | --- | --- |
| `Dashboard` + `My Profile` 指向同一个 `/profile` | `Sidebar.tsx:31-32` | 且 `Dashboard` 未配 `activePaths`,永不高亮 |
| `Reviews` / `Skill Assessments` / `Probation Reviews` / `Staff Management` 全部 `to: '/dashboard'` | `Sidebar.tsx:48-51` | 仅靠 `scrollTo` 滚到同一页的不同 section,4 项 = 0 个新页面 |
| `My Schedule` + `Schedule` 指向同一个 `/schedule` | `Sidebar.tsx:34` / `:46` | 用 `hideWithCap` 回避同时出现,是命名问题的补丁 |
| Missions 三处同源 | `GrowthPage.tsx:9` 直接 `import { MissionsTab } from '../staff/StaffProfile'`;`StaffProfile.tsx:50` 默认停在该 tab | 点 `My Profile` 与点 `Missions` 渲染同一组件同一份数据 |
| Reviews / Skills 各两处 | 侧栏锚点 vs `StaffProfile.tsx:26-32` 的页内 tab | — |

### 2. 三种互相矛盾的「大类→小类」写法

| 模块 | 大类 | 小类 |
| --- | --- | --- |
| Settings | 1 个侧栏项 | 11 个页内 tab(`Settings.tsx:15-27`) |
| Dashboard | 1 个侧栏项 | 4 个 section 又被拎回侧栏当锚点 |
| Profile / Growth | 1 个侧栏项 | 页内 tab(5 个 / 3 个) |

同样是"一个大类挂若干小类",用了三套做法。**这是加功能越加越乱的真正原因**——没有规则规定新深度该落在哪一层,于是每次现场决定。

### 3. 顶层分组混用两条轴

`STAFF`(人轴)+ `HR`(域轴)+ `MANAGEMENT`(人轴)。混轴的代价是新功能无法判断归属——"员工排班"按人轴属于 STAFF,按域轴属于 HR,两套标准都成立。

## 决策:域轴顶层 + 页内 Mine/Team 叠加

顶层按**域**划分,个人视图与团队视图的区分**留在页面内部**,不体现为导航分组。

### 依据:代码已经选了这条路

五个共享页面全部采用"一个页面、按 capability 叠加团队区"的模式:

| 页面 | 位置 | 做法 |
| --- | --- | --- |
| Schedule | `Schedule.tsx:794-802` | 非管理者 → `MyScheduleView`;管理者 → 全员 week/day 视图外加 "My Upcoming Shifts" 卡 |
| Leave | `HrLeave.tsx:640-648` | 所有人看 `MyLeaveView`,管理者追加 `Team Leave Management` |
| Claims / Salary / Attendance | `HrClaims.tsx:371` / `HrSalary.tsx:385` / `HrAttendance.tsx:1178` | 同样的叠加 |

若顶层按人轴分成 `ME` 和 `TEAM`,这五页会各自在两个分组下出现,重新制造上表第 3 类重复。

补充理由:对无 capability 的店员而言,`ME` 组等于整个 app,一个包含全部内容的分组没有信息量;而 `ME` 真正有意义的对象是管理者,偏偏对管理者代码是把两个模式合在一页的。

## 目标 IA

```
Profile           /profile              ← 置顶,不入任何分组
                                           tabs: Missions · Skills · Career · Personal · Reviews · History

TEAM                                    cap: view_team
  Directory       /team                 ← staff 表 + registration approvals + activity feed
  Reviews         /team/reviews         cap: conduct_reviews
                                           tabs: Monthly · Probation · Skills · Promotion
  Missions        /team/missions        cap: manage_missions
  Tasks           /team/tasks

TIME & PAY                              ← 五页沿用现有 Mine/Team 叠加,不拆
  Schedule        /schedule
  Attendance      /hr/attendance
  Leave           /hr/leave
  Claims          /hr/claims
  Salary          /hr/salary

SETTINGS          /settings             cap: access_settings
```

可见项数:店员 6 项(今天 8 项,含 2 个重复);全 capability manager 11 项(今天 15 项)。

**预留的未来大类。** `feature/po-system` 合并时,`PROCUREMENT` 作为第 5 个大类整体接入,子项为 `Purchase Orders` / `Receiving` / `Inventory`(cap `use_procurement`)与 `Suppliers` / `Items`(cap `manage_procurement`),无需改动本设计的任何其他部分。后续的 `SALES` / `CUSTOMERS` / `COSTING` 同理。

`Home` 作为个人落地页(今天的班 · 待办 · 我的任务)是已识别的未来页面,**本期不建、不入侧栏**,详见「不在本期范围」。

## 四条决策规则

新功能按此判定归属,不再逐次讨论:

1. **≥3 个独立路由 → 升为顶层大类**;1-2 个 → 作为页内 tab 挂进最近的大类
2. **页内 tab 永远不进侧栏**(禁止用 `scrollTo` 把 section 提升为导航项)
3. **一个功能在侧栏只出现一次**
4. **个人视图与团队视图的区分放在页面内部**,不体现为导航分组

## 路由变更

| 现状 | 目标 | 处理 |
| --- | --- | --- |
| `/dashboard` | `/team` | 新增 `<Navigate to="/team" replace />` |
| `/dashboard` + `scrollTo: reviews-section` | `/team/reviews`(tab `Monthly`) | 锚点删除 |
| `/dashboard` + `scrollTo: probation-section` | `/team/reviews`(tab `Probation`) | 锚点删除 |
| `/dashboard` + `scrollTo: skill-assessments-section` | `/team/reviews`(tab `Skills`) | 锚点删除 |
| `/dashboard` + `scrollTo: staff-section` | `/team` | 锚点删除,Directory 即该 section |
| `/tasks` | `/team/tasks` | 新增重定向 |
| `/missions`(career + missions tab) | `/profile` 的 tab | 新增重定向到 `/profile` |
| `/missions`(manage tab) | `/team/missions` | — |
| `/profile` `/schedule` `/hr/*` `/settings` `/staff/:id` `/probation/:staffId` | 不变 | — |

重定向保留至少一个发布周期,覆盖书签与已安装 PWA 的旧入口。

**同步更新的引用点**(已全量核对):`App.tsx:215`、`ProtectedRoute.tsx:53` 两处将 manager 落地页从 `/dashboard` 改为 `/team`;`Sidebar.tsx` 导航项定义整体重写。

`NavItem` 的 `scrollTo` 与 `hideWithCap` 两个字段在改造后无消费者,一并删除——它们正是规则 2 与规则 3 的历史补丁。

## Dashboard.tsx 拆分

`Dashboard.tsx` 现为 2025 行,四个滚动锚点正因它是巨型页而存在。拆为两页:

**`/team` — Directory**
- `staff-section`(`:1884`)staff 表与筛选
- registration requests(`:1774`,pending / rejected 子 tab)
- activity feed(`:1992`)
- 关联弹窗:Add New Staff(`:159`)、Approve Registration(`:335`)、Reject Registration(`:420`)、Account Created(`:790`)

**`/team/reviews` — Reviews**
- `reviews-section`(`:1477`)→ tab `Monthly`
- `probation-section`(`:1581`)→ tab `Probation`
- `skill-assessments-section`(`:1683`)→ tab `Skills`
- `promotion-reviews-section`(`:1736`)→ tab `Promotion`
- 关联弹窗:Fail Assessment(`:500`)、Promotion Evaluation(`:633`)

两页都需要 staff 列表与 capability 判定,将共用的数据获取抽为 `src/features/team/useTeamData.ts`,避免拆分后各自重复请求。

`promotion-reviews-section` 今天没有对应的侧栏项,拆分后作为 Reviews 的第四个 tab 首次获得正式入口。

## Sidebar 交互

侧栏有两类顶层条目,行为不同:

- **大类**(`TEAM`、`TIME & PAY`,以及未来的 `PROCUREMENT` 等)——二级项**仅在父类选中时展开**,侧栏可见高度不随大类数量增长。大类自身不可点击导航,仅切换展开态;点击大类默认选中其第一个可见子项。子项全部因 capability 被过滤时,该大类整体隐藏(沿用现有 `showMgmtSection` 的思路)
- **顶层叶子项**(`Profile`、`Settings`)——无子项,直接导航,不参与展开逻辑。`Profile` 置于最上,`Settings` 置于最下
- 当前 `activePaths` 前缀匹配机制保留,`/team/reviews` 等新路由据此高亮至父类

## 不在本期范围

- **`Home` 个人落地页**——新产品面,内容与优先级需单独 brainstorm
- **五个 TIME & PAY 页面的拆分**——现有 Mine/Team 叠加是本设计的依据,不动
- **`Settings` 的 11 个 tab**——已符合规则 1,原样保留
- **移动端 `BottomTabs`**——见下

## 集成风险

Sidebar.tsx 目前有三个在途版本,本设计基于 `main`:

| 来源 | 内容 | 与本设计的关系 |
| --- | --- | --- |
| `main` @ `2f4137b` | 侧栏 + 移动端顶栏 + overlay | 本设计的基线 |
| `stash@{0}` mobile-pwa-shell WIP | 移除移动端顶栏,改为 `BottomTabs` + 导出 `SidebarContent`,新增 `shared/lib/tabs.ts` | 改的是外壳渲染,不改导航项定义 |
| `feature/po-system`(领先 `main` 10 个提交) | 新增 `PROCUREMENT_NAV` 5 项 | 按上文"预留的未来大类"接入 |

**建议顺序:先落地 mobile-pwa-shell,再做本设计,最后合并 po-system。** 本设计改导航项定义与路由,mobile-pwa-shell 改外壳渲染,两者虽同文件但区域基本不重叠;顺序颠倒会导致 `tabs.ts` 的 `TabId` 与新路由不一致而返工。

若 mobile-pwa-shell 先落地,本设计需同步更新 `shared/lib/tabs.ts`:`team` → `/team`、`tasks` → `/team/tasks`。`missions` 从 `STAFF_TABS` 移除(已折进 Profile),该列表由 4 项减为 3 项而 `MAX_TABS` 为 4,空出的一格补 `leave`——请假是店员自助频次最高的 HR 操作,`salary` 与 `claims` 留在 More 抽屉。

## 依赖

capability 系统目前半失效,本设计的分组过滤建立在 capability 可信这一前提上:

- `view_salary`、`manage_staff` 已声明并在 Settings → Roles & Permissions 矩阵中可勾选,但全代码库从未被读取
- `manage_hr` 仅在 `HrAttendance.tsx:1152` 使用一次
- `HrSalary.tsx:370`、`HrLeave.tsx:624`、`HrClaims.tsx:357` 改用 `staff?.rank === ...` 硬判断,绕开 capability 系统

后果:owner 在 Settings 中授予的能力不生效,侧栏可能显示出用户点进去发现无权限的项。**已拆为独立任务处理,应先于本设计落地。**

## 验收标准

1. 侧栏不存在两个指向同一路由的项
2. `NavItem` 不再有 `scrollTo` 字段,代码中无 `scrollIntoView` 导航
3. `/dashboard`、`/tasks`、`/missions` 访问后正确重定向至新路由
4. 无 capability 的店员登录后侧栏为 6 项:`Profile` + `TIME & PAY` 五项
5. 全 capability manager 登录后为 11 项,且任一时刻侧栏可见行数不超过 `Profile` + 2 个大类标题 + 当前展开组的子项 + `Settings`
6. `Dashboard.tsx` 拆分后,`/team` 与 `/team/reviews` 各自单文件不超过约 1200 行
7. `promotion-reviews-section` 可经 `/team/reviews` 的 `Promotion` tab 到达
