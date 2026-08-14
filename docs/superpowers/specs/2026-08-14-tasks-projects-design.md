# Tasks & Projects 改版 Phase 1 设计

Status: Pending approval
Date: 2026-08-14
Base branch: `main`(Tasks 模块所在分支;procurement 的 `feature/po-system` 与本次无关)
Work branch: `feature/tasks-projects`

## 背景与范围

`/team/tasks` 是 Craft OS 里最早写的模块之一,至今仍是一块三栏 Kanban:每张卡只有
priority / department / title / assignee / due date,一个任务只能挂一张附件,没有
任何分类或归属概念。管理层想用它推进「开新分店筹备」这类跨月工作时,板面很快就
退化成一长串互不相干的卡片。

本次改版做两件事:引入 **Tag**(自由标签)与 **Project**(完整项目实体),并顺手
补齐这个模块欠下的技术债。

### 前置发现:`tasks` 表在当前 production 不存在

动工前用 anon key 直接打了 live Supabase(`yfsoesxzurzjdwstszru`)确认:

| table | HTTP |
|---|---|
| `staff` / `missions` / `departments` | 200 |
| `tasks` | **404** — `PGRST205: Could not find the table 'public.tasks'` |
| `task_comments` | **404** |

而且 repo 里从来没有这两张表的 DDL——`supabase/schema.sql` 与所有 migration 都
搜不到。结论:这两张表当初是在旧 project(`vvxg`)手动建的,2026-07-05 迁移到新
project 时没跟过来。storage bucket `task-attachments` 则有迁过来(HTTP 200)。

现象是 `Tasks.tsx:869` 的 `loadTasks()` 只判断 `if (tasksRes.data)`、不处理 error,
所以查询失败时画面静静显示一块空白 Kanban,不报错。

**这对本次改版是好消息**:没有既有资料要迁,7 张表全部新建,不必设计任何 schema
migration 路径。

### Phase 1 范围

- Tag(自由输入 + typeahead + 正规化去重 + 最小管理界面)
- Project(完整实体:列表页、详情页、owner、日期、状态、进度)
- Task checklist(子项打勾)
- 多附件
- 栏内手动排序
- Done 归档(14 天窗口 + Archive 页)
- Realtime 同步
- 建表 SQL 与 RLS 进 repo
- 新增 `manage_projects` capability
- `Tasks.tsx` 拆档 + 统一错误处理(接上 `db-write.ts`)

### Phase 1 不做

- 多人 assignee(维持单一 `assigned_to`)
- Recurring task(需要 pg_cron 或 `supabase/functions` 里的排程任务,自成一个子系统)
- Task 与 Mission / XP 打通(task 可自建自关,接上等于开后门刷分)
- 可自订 Kanban 栏位(维持固定三栏)
- 项目成员手动维护(改为从任务 assignee 自动推导)
- 甘特图 / 依赖关系 / 工时

## 关键决策(已与用户确认)

| 决策 | 选择 | 理由 |
|---|---|---|
| Project 形态 | 完整实体(列表页 + 详情页 + owner + 日期 + 状态 + 进度) | 管理层要看得到「这个项目做到哪了」 |
| Task 与 Project 关系 | `project_id` nullable;`/team/tasks` 是全局总板,`/team/projects/:id` 是项目专属板 | 日常杂务本来就不属于任何项目;全局板保留「我今天要做什么」的视角 |
| Tag 创建方式 | 自由输入(free-form),不设审核 | 使用者只有 5–8 个管理层,治理成本低于门槛成本 |
| Tag 去重 | 存 `slug`(lowercase 正规化)+ `name`(显示原文),前端 typeahead | `Urgent` / `urgent` / ` Urgent ` 自动收敛成同一个 |
| Kanban 栏位 | 固定三栏 `todo / in_progress / done` | 全局板必须能把所有 task 排进同一组栏位;「blocked」用 tag 表达即可 |
| 使用者范围 | 仅 management(维持 `view_team` 门禁) | 使用者澄清:这个模块本来就不给一线 staff 用 |
| 开 Project 的权限 | 新增 `manage_projects`,预设含 supervisor | 使用者要求放宽;做成独立开关以便日后收紧 |
| 项目成员 | 不做手动维护,从任务 assignee 自动推导 | 手动清单没人会更新;owner + assignee 已完整回答「谁在这个项目里」 |
| 归档机制 | 只用 `completed_at`,不加 `archived_at` | 两个栏位做同一件事只会互相矛盾 |

### 两处需要更正的既有认知

**一、`manage_tasks` 不是现行 RBAC 的 capability。** 它在
`src/shared/types/index.ts` 的 `PermissionKey`(旧的 `roles.permissions` 那套),
不在 `Capability` 联合类型里。`main` 上的 `Capability` 只有 10 项,完全没有 task
相关能力。所以本次是**新增** capability,不是接上既有的。

**二、`PROJECT_NOTES.md:79` 写「Everyone (logged in): `/profile`, `/tasks`」与实际
及产品意图皆不符。** Tasks 一直挂在 `requireCap="view_team"` 之下,而 `staff` 角色
该项为 `false`。经确认这是刻意的,要修的是文件,本次一并更正。

## 一、权限模型

新增一个 capability,加入 `Capability` 联合类型、`CAPABILITIES` 列表与
`DEFAULT_SYSTEM_ROLE_CAPS`(`main` 上这三处目前各有 10 项):

| Capability | 含义 | owner | admin | hr | manager | supervisor | staff |
|---|---|---|---|---|---|---|---|
| `manage_projects` | 建立 / 编辑 / 删除 Project;编辑 tag 词表 | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |

进入 Tasks / Projects 沿用既有 `view_team`,不新增门禁:

| 路由 | requireCap | 备注 |
|---|---|---|
| `/team/tasks` | `view_team` | 不变 |
| `/team/tasks/archive` | `view_team` | 新增 |
| `/team/projects` | `view_team` | 新增 |
| `/team/projects/:id` | `view_team` | 新增 |

`App.tsx:140` 既有的 `/tasks → /team/tasks` redirect 保留。

预设值目前与 `view_team` 完全重合,`manage_projects` 眼下不会挡下任何人。做成独立
能力是为了让 Owner 日后能在 Settings → System Roles 里单独收紧,不必改代码。

SQL 侧由 security definer 函数 `has_task_cap(p_cap text)` 兜底。它读
`system_role_permissions` 取 Owner 的显式覆盖,再回落到内建默认值(镜像
`DEFAULT_SYSTEM_ROLE_CAPS`):

```
'view_team'       → system_role in ('owner','admin','hr','manager','supervisor')
                    or rank in ('manager','supervisor')
'manage_projects' → 同上
```

取舍(与既有 RBAC migration 一致,明确记录于此):**能力矩阵里「关掉」某项只影响
前端 UI,不会收紧 RLS**——代码默认值不在 SQL 里,DB 侧无法复现「默认然后被覆盖」
的合并语义。RLS 是安全边界,能力矩阵是 UI 门禁。

## 二、数据库设计

migration 最终是**三份**,全部已由使用者在 Supabase SQL editor 执行,皆幂等:

| 档案 | 内容 | 为什么需要 |
|---|---|---|
| `migration-2026-08-14-tasks-projects.sql` | 7 张表、索引、trigger、`project_progress` view、RLS、realtime publication | 主体 |
| `migration-2026-08-14-tasks-upsert-fn.sql` | `upsert_tag()` function | supabase-js 的 `.upsert()` 只能发 `do update set <栏位> = excluded.<栏位>`,无法表达「冲突时保留既有值」。原本的写法会让后打字的人覆盖掉 tag 的显示名与 `created_by` |
| `migration-2026-08-14-checklist-assignee.sql` | `task_checklist_items.assigned_to` + 索引 | 使用者中途追加的子项负责人 |

### 表关系

```
projects ──< tasks ──< task_checklist_items
   │           │  │
   │           │  ├──< task_attachments
   │           │  └──< task_comments
   │           │
   │           └──< task_tags >── tags
   │
   └──> project_progress (view)
```

### `projects`

| 栏位 | 型别 | 说明 |
|---|---|---|
| `id` | uuid pk | |
| `name` | text not null | |
| `description` | text | |
| `color` | text not null default `'#C4813A'` | 列表与卡片上的色点 |
| `status` | text not null default `'active'` | check: `active` / `on_hold` / `completed` / `cancelled` |
| `owner_id` | uuid → `staff(id)` on delete set null | |
| `start_date` | date | |
| `due_date` | date | |
| `created_by` | uuid → `staff(id)` on delete set null | |
| `created_at` / `updated_at` | timestamptz default now() | |

### `tasks`

| 栏位 | 型别 | 说明 |
|---|---|---|
| `id` | uuid pk | |
| `title` | text not null | |
| `description` | text | |
| `status` | text not null default `'todo'` | check: `todo` / `in_progress` / `done` |
| `priority` | text not null default `'medium'` | check: `low` / `medium` / `high` |
| `project_id` | uuid → `projects(id)` **on delete set null** | 删项目不删任务,任务掉回散装 |
| `assigned_to` | uuid → `staff(id)` on delete set null | |
| `created_by` | uuid → `staff(id)` on delete set null | |
| `due_date` | date | |
| `department` | text | `departments.slug`,与 `staff.department` 同一套 |
| `position` | double precision not null default 0 | 栏内排序,见第五节 |
| `completed_at` | timestamptz | 由 trigger 维护 |
| `created_at` / `updated_at` | timestamptz default now() | |

FK 一律用 inline `references` 写法,让 Postgres 产生预设约束名
(`tasks_assigned_to_fkey`、`tasks_created_by_fkey`、`task_comments_staff_id_fkey`),
因为前端 PostgREST embed 语法直接依赖这些名字:

```ts
.select('*, assignee:staff!tasks_assigned_to_fkey(id,name,avatar)')
```

**不要**手动命名这些 constraint。

### `tags` / `task_tags`

| `tags` | 型别 | 说明 |
|---|---|---|
| `id` | uuid pk | |
| `slug` | text not null **unique** | lowercase 正规化,去重靠它 |
| `name` | text not null | 显示用原文 |
| `color` | text not null default `'#8B7355'` | |
| `created_by` | uuid → `staff(id)` on delete set null | |
| `created_at` | timestamptz | |

`task_tags`:`task_id` + `tag_id` 复合主键,两边 `on delete cascade`。

新增 tag 走
`upsert ... on conflict (slug) do update set name = tags.name returning *`
——冲突时刻意写回自己的旧 `name`(先到先得),目的是让 `RETURNING` 回传既有列,
所以打 `Urgent` 会直接命中已存在的 `urgent`,不会产生第二笔。

### `task_checklist_items`

`id` / `task_id`(cascade) / `title` / `done` bool default false / `position` double precision /
**`assigned_to`** → `staff(id)` on delete set null

> **2026-08-14 修订(使用者中途追加)。** 原设计的子项只有「文字 + 打勾」。使用者澄清实际
> 用法是「一个任务底下几个子项,分给不同人去 take,全部清掉才算完成」,因此追加两件事:
> 子项可指定负责人(`assigned_to`,由
> `supabase/migration-2026-08-14-checklist-assignee.sql` 补上),以及**软性**完成提醒 ——
> 子项未做完就要移到 Done 时跳确认(`Still 3 of 7 items open. Mark as done anyway?`),
> 取消则什么都不做。刻意不硬挡:子项可能作废,硬挡会让任务永远结不掉。

### `task_attachments`

`id` / `task_id`(cascade) / `url` / **`storage_path`** / `file_name` / `mime_type` /
`size_bytes` / `uploaded_by` / `created_at`

`storage_path` 是新加的。现行代码只存 public URL,`removeAttachment()`
(`Tasks.tsx:508`)只把栏位设成 null,档案永远留在 bucket 里变孤儿。存 path 才能在
删除时一并 `storage.from('task-attachments').remove([path])`。

### `task_comments`

`id` / `task_id`(cascade) / `staff_id` / `comment` / `created_at`——与原结构一致,
只是这次进 repo。

### `project_progress`(view)

```sql
create or replace view project_progress
with (security_invoker = true) as
select
  p.id as project_id,
  count(t.id)                                                    as total_tasks,
  count(t.id) filter (where t.status = 'done')                   as done_tasks,
  count(t.id) filter (where t.status <> 'done'
                        and t.due_date < current_date)           as overdue_tasks
from projects p
left join tasks t on t.project_id = p.id
group by p.id;
```

`security_invoker = true` 必须写(PG15+),否则 view 以 owner 身分执行,绕过 RLS。

### Trigger

```sql
create or replace function tasks_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  if new.status = 'done' and old.status is distinct from 'done' then
    new.completed_at := now();
  elsif new.status <> 'done' then
    new.completed_at := null;
  end if;
  return new;
end $$;
```

`projects` 用一个只更新 `updated_at` 的简化版。

### 索引

`tasks(project_id)` / `tasks(assigned_to)` / `tasks(status, position)` /
`tasks(due_date)` / `tasks(completed_at)`;`task_tags(tag_id)`;
`task_checklist_items(task_id)`;`task_attachments(task_id)`;`task_comments(task_id)`。

### RLS

**七张表**全部 `enable row level security`。`V` = `has_task_cap('view_team')`,
`M` = `has_task_cap('manage_projects')`。`staff.id` 即 `auth.uid()`,所以
`created_by = auth.uid()` 是有效比较。

| 表 | select | insert | update | delete |
|---|---|---|---|---|
| `projects` | V | M | M | M |
| `tasks` | V | V(+ `created_by = auth.uid()`) | V | `created_by = auth.uid()` or M |
| `tags` | V | V | M | M |
| `task_tags` | V | V | 无(不可改) | V |
| `task_checklist_items` | V | V | V | V |
| `task_attachments` | V | V | 无(不可改) | V |
| `task_comments` | V | V(+ `staff_id = auth.uid()`) | `staff_id = auth.uid()` | `staff_id = auth.uid()` or M |

「无」表示不建 update policy,该表的 UPDATE 一律被拒——`task_tags` 与
`task_attachments` 是纯关联/不可变记录,要改就删了重建。

使用者全是管理层,所以 task 层面刻意宽松:任何能进板的人都能改任何 task。收紧的点
只放在「删别人的东西」与「改 project / tag 词表」。

### Realtime

```sql
do $$ begin
  alter publication supabase_realtime add table tasks;
exception when duplicate_object then null;
end $$;
```

`alter publication ... add table` 不是幂等语句,表已在 publication 内会报错,故包在
例外处理里。

只订 `tasks`。checklist / attachment / comment 的变动在开启详情弹窗时重新拉取,不进
realtime——避免为了低频事件常驻多条订阅。

## 三、前端结构

现行 `src/features/tasks/Tasks.tsx` 是 1126 行、内含 5 个 component。照
`src/features/hr/` 与 `src/features/team/` 的惯例(平铺档案、不开子资料夹、纯逻辑
可就地放 `.ts`)拆开:

下表是**实作完成后**的样子(行数为实际值,含注释)。原始规划少列了
`useBoardTasks.ts` 与 `permissions.ts`,而这两支各自收着一整块跨页面共用的决策,
不是可有可无的胶水:

| 档案 | 行数 | 作用 |
|---|---|---|
| `Tasks.tsx` | 225 | `/team/tasks` 页面外壳 + 筛选列 |
| `TasksArchive.tsx` | 157 | `/team/tasks/archive`,全部已完成任务 + 搜寻 |
| `Projects.tsx` | 230 | `/team/projects` 列表 |
| `ProjectDetail.tsx` | 297 | `/team/projects/:id` |
| `TaskBoard.tsx` | 407 | 三栏板本体(桌面三栏 + mobile 单栏、落点指示线),总板与项目页共用 |
| `TaskCard.tsx` | 178 | 卡片 |
| `TaskDetailModal.tsx` | 461 | 详情弹窗外壳 |
| `TaskFormModal.tsx` | 202 | 新增 / 编辑表单 |
| `ProjectFormModal.tsx` | 183 | 项目表单 |
| `TagInput.tsx` | 81 | typeahead 输入 |
| `TagManagerModal.tsx` | 129 | 改名 / 换色 / 删除 tag,需 `manage_projects` |
| `ChecklistEditor.tsx` | 221 | 子项清单 |
| `AttachmentGallery.tsx` | 200 | 多附件 + lightbox |
| `CommentThread.tsx` | 99 | 评论 |
| `useBoardTasks.ts` | 432 | **板的全部行为**:三笔读取、乐观换栏与回滚、软性完成闸门、整栏重新编号、realtime 订阅与自身回音的辨识 |
| `permissions.ts` | 60 | 这个模块的两条门禁(`useTaskPermissions` / `canDeleteTask`),对齐 RLS |
| `api.ts` | 417 | 全部 supabase 查询 |
| `types.ts` | 124 | 型别 |

`useBoardTasks.ts` 是拆档真正的重点,不只是「把 useState 搬出去」:`/team/tasks`
与 `/team/projects/:id` 是同一块板,复制一份过去,两边迟早会对「拖失败要滚回哪里」
或「什么算一次真的搬动」有两种说法。两页各自只保留自己独有的东西(前者是筛选列,
后者是专案头部与 `project_progress` 的重拉)。

`permissions.ts` 收的是第一节那张能力表在 UI 上的落点。分成两支是因为 RLS 本来就
分成两条:板上的任务写入对齐 `tasks_*` 的 `view_team`,专案与 tag 词表对齐
`projects_manage` / `tags_update` 的 `manage_projects`,删除任务再紧一格
(`tasks_delete`:自己建的,或是有 `manage_projects`)。三个页面共用这一份,
不各自写一份 rank 判断 —— `Rank` 里没有 owner / admin / hr,
`system_role='owner'` 配 `rank='senior'` 会被 rank 判断当成没有权限的人。

`TagManagerModal` 是自由输入方案的配套:既然不设建立门槛,就必须留一条修正打错字
的路,否则 `urgnet` 会永远躺在下拉选单里。入口放在筛选列的 Tag 下拉底部
(`Manage tags…`),仅 `manage_projects` 可见。

### `api.ts` 是重点

现行查询散落在各 component,且**全部吞掉 error**——`loadTasks()` 只写
`if (tasksRes.data)`,`saveEdit()` / `handleFileChange()` / `removeAttachment()`
都是 `if (error) return`。空白板没人发现就是这么来的。

两条硬性要求:

1. **读取**统一 `throw`,页面层用 `{ data, error, loading, reload }` 呈现,错误显示
   成页面顶端红色横条并附 `Retry`。
2. **写入一律走 `writeOutcome()`**(`src/shared/lib/db-write.ts`),且每个写入都必须
   带 `.select()`。原因该档案的注释已写明:RLS 挡掉的写入回传**没有 error 也没有
   rows**,`error === null` 不代表写进去了。clock-out 就是这样让员工看到绿色
   「Clocked out ✓」而实际什么都没存(`f1240b2`)。

Kanban 的乐观更新尤其危险:拖卡后先改本地状态,若写入实际被 RLS 挡掉却判定成功,
卡片会停在新栏位直到重整才弹回去。必须用 `writeOutcome()` 判定,失败则滚回原栏与
原 `position`。

### 路由与导航

`src/App.tsx` 在既有 `/team/*` 区块内新增三条路由,皆 `requireCap="view_team"`:
`/team/tasks/archive`、`/team/projects`、`/team/projects/:id`。

`src/shared/lib/nav.ts` 的 `NAV` 树,在 `team` 群组内 `team-tasks` 之后插入一片叶子:

```ts
{ id: 'team-projects', label: 'Projects', to: '/team/projects' }
```

不加 `cap`——与 `team-tasks` 一致,群组本身的 `cap: 'view_team'` 已经挡好了。

`team-tasks` **不需要改**:`activeEntry` 在没有 `activePaths` 时回落到 `[leaf.to]`
并做前缀比对,`/team/tasks/archive` 本来就会点亮 Tasks。同理 `/team/projects` 虽然
也命中 directory 叶子的 `activePaths: ['/team', ...]`,但 `activeEntry` 取最长前缀,
`/team/projects` 胜出,不会误点亮 Directory。

图标映射在 `Sidebar.tsx` 补一条,沿用 `lucide-react` 的 `FolderKanban`。

## 四、页面与交互

### `/team/projects`

一行一个项目:色点 + 名称 + owner 头像 + status pill + 进度条 + `8/15` + due date +
逾期数(有才显示)。顶部 `Active / On Hold / Completed / All` 切换,预设 Active。
右上 `+ New Project`(需 `manage_projects`)。

### `/team/projects/:id`

上半:名称、描述、owner、start/due date、status、进度条、参与者头像组(从该项目所有
task 的 `assigned_to` 去重推导,加上 `owner_id`)。
下半:`TaskBoard`,只显示 `project_id = :id` 的任务。

### `/team/tasks`

维持三栏。卡片版面:

```
[High] [Kitchen] [● 开新分店筹备]        ← priority / department / project(色点+名)
Fix the espresso machine leak            ← title
[#urgent] [#equipment] +1                ← tags,最多 2 个,其余收成 +N
👤 Amy   ☑3/7  📎2  💬4        ⚠ 12 Aug  ← assignee / checklist / 附件数 / 评论数 / 日期
```

筛选列在既有的 search / My Tasks / Department / Assignee 之后,新增 **Project** 与
**Tag** 两个下拉。

Done 栏只显示 `completed_at` 在 14 天内的任务。这个窗**只在 server 端执行**,前端不
另放一份同义的过滤函数——两个真相来源迟早会不一致。是 server-side 条件,不是前端过滤
——否则半年后每次开板都要拉全部历史:

```ts
.or(`status.neq.done,completed_at.gte.${cutoffIso}`)
```

栏底一条 `View archive →` 连到 `/team/tasks/archive`。

### Task 详情弹窗

在既有区块之外新增三块:

- **Tags** — `TagInput`,打字即时下拉既有 tag(比对 slug 的前缀与包含),Enter 建立
  或选取;已选 tag 显示为可点 × 的 pill
- **Checklist** — 逐行文字 + checkbox,可拖曳排序,顶部显示 `3/7` 与细进度条
- **Attachments** — 缩图网格,可加多张,点击开 lightbox,可逐张删除(同时删 storage
  档案,靠 `storage_path`)

### Project 表单

name / description / color(色票选择)/ status / owner / start date / due date。

## 五、纯逻辑与测试

纯函数抽到 `src/shared/lib/tasks.ts`,测试放旁边 `tasks.test.ts`——与
`leave.ts` / `attendance.ts` / `probation.ts` 同一个惯例。

| 函数 | 职责 |
|---|---|
| `normalizeTagName(input)` | → `{ slug, name }`。trim、内部空白收敛成单一空格、slug 转 lowercase |
| `computeDropPosition(prev?, next?)` | 拖放后的新 position |
| `insertPosition(column, index)` | 「插在第 index 张之前」该拿的 position。`column` 不含正在拖的那一张,`index` 先夹回 `[0, length]` —— 落点来自 DOM 事件,一个过期的索引不该算出 `NaN` |
| `needsRebalance(positions)` | 相邻间距过小时回报需要重新编号 |
| `rebalance(items)` | 以 1024 为步长重新编号 |
| `projectProgress(done, total)` | → 0–100 整数,`total = 0` 时回 0 |
| `openChecklistCount(task)` | 还没做完的子项数,clamp 到 0。软性完成闸门的确认文字与 `open > 0` 的判断都吃它 |
| `isOverdue(dueDate, today)` | 当天到期不算逾期 |
| `deriveParticipants(tasks, ownerId)` | 项目参与者去重推导 |

### `position` 规则

新任务进栏底:`max(position) + 1024`。拖到两卡之间:`(prev + next) / 2`。拖到栏首:
`min - 1024`。拖到栏尾:`max + 1024`。空栏:`1024`。相邻间距 `< 0.0001` 时触发
`rebalance`,把该栏整个以 1024 为步长写回。

### 必测案例

- `projectProgress(0, 0)` 不得除以零
- `isOverdue` 在到期当日回 `false`、隔日回 `true`
- `normalizeTagName` 让 `'Urgent'` / `' urgent '` / `'URGENT'` 产生同一个 slug,且
  保留各自输入的 `name` 供 upsert 决定
- `computeDropPosition(undefined, undefined)` 空栏情形
- `insertPosition` 的 index 越界(负数、大于长度)夹回栏首 / 栏尾,不回 `NaN`
- 连续在同两卡之间插入 60 次后 `needsRebalance` 为 true
- `openChecklistCount` 在 done > total 时回 0,不回负数
- `deriveParticipants` 去重、忽略 `assigned_to = null`、owner 恒在结果内

### 元件测试

全部照 `src/features/hr/HrAttendance.write-failure.test.tsx` 的写法:docblock 指定
`@vitest-environment jsdom`(`vitest.config.ts` 全域是 `node`),不引
`@testing-library/jest-dom`。

规划时只写了一个 `Tasks.drag-failure.test.tsx`,实际拆成了下面这些 —— 板的拖放
最后落在 `Tasks.reorder.test.tsx`,那个档名从未存在过:

| 档案 | 钉住的事 |
|---|---|
| `Tasks.reorder.test.tsx` | 拖卡换栏的乐观更新、RLS 静默挡掉时滚回原栏原位、栏内重新编号 |
| `Tasks.doneGate.test.tsx` | 「还有子项没做完」的软性确认,三条进 done 的路都要问 |
| `Tasks.refresh.test.tsx` | 背景重拉不得卸载开着的弹窗(全屏 loader 只挡第一次) |
| `Tasks.projectFilter.test.tsx` | Project 筛选下拉,以及它自己那笔读取的失败横幅 |
| `Tasks.staffRead.test.tsx` | staff 读失败要说出来,不得退化成只剩 "Unassigned" 的下拉 |
| `TasksArchive.test.tsx` | `/team/tasks/archive` 的清单与搜寻 |
| `Projects.test.tsx` | 清单读失败不得画成空清单;删除的 `WriteOutcome` |
| `ProjectDetail.test.tsx` | 专案头部、参与者推导、板的搬动接线、进度重拉,以及门禁对齐 RLS(不是对齐 rank) |
| `ProjectFormModal.test.tsx` | 新增 / 编辑两条路各自的 `WriteOutcome` |
| `TaskFormModal.project.test.tsx` | 从专案页建的任务要归给那个专案 |
| `TaskDetailModal.tags.test.tsx` | 重打一个已存在的 tag 名字要挂到同一笔上 |
| `TaskDetailModal.write-failure.test.tsx` | 存档 / 删除的 `WriteOutcome`、删除闸门、专案清单读失败的显示位置 |
| `TagManagerModal.write-failure.test.tsx` | 改名 / 删除的 `WriteOutcome`,含撞名那句话 |
| `CommentThread.write-failure.test.tsx` | 张贴的 `WriteOutcome`(失败要留住草稿)、读失败的显示 |
| `ChecklistEditor.test.tsx` | 认领 / 取消认领(空字串要送成 null)与 `WriteOutcome` |
| `AttachmentGallery.test.tsx` | 上传 / 删除的接线与 lightbox |
| `TaskBoard.archiveLink.test.tsx` / `TaskBoard.projectBadge.test.tsx` | Done 栏底的 archive 出口;卡上的 project 标签只在总板画 |
| `useBoardTasks.realtime.test.tsx` | realtime 订阅、自身回音的辨识、重连补拉,以及这些都不得抹掉写入失败的横幅 |

`api.*.test.ts` 那一组(`reads` / `boardQuery` / `tags` / `updateTag` / `checklist` /
`attachments` / `projects.write`)让 `api.ts` 跑真的,只把 supabase client 换成假的
—— 验的是「送出去的查询长什么样」,以及读失败真的 throw。

RLS 静默挡掉的形状(**`{ data: [], error: null }`**)是所有写入测试的重点:
只测 `error !== null` 会漏掉真正咬过人的那一种失败。凡是呼叫端要看 `.ok` 的地方,
都必须有一则测试会因为那段判断被删掉而变红 —— 否则那段判断等於没有人守着。

### 既有测试

`src/shared/lib/nav.test.ts` 补一个案例:`team-projects` 叶子对 `view_team` 为 true
的角色可见、对 `staff` 不可见(整个 team 群组消失)。
`src/shared/components/Sidebar.test.tsx` 现有断言必须维持通过。

`permissions.test.ts` **不需要**改——它只测纯函数 `canReviewStaff`,不涉及能力矩阵。

## 六、上线顺序

每一步做完都能独立验证再走下一步。

| 步 | 内容 | 完成后的状态 |
|---|---|---|
| 1 | `supabase/migration-2026-08-14-tasks-projects.sql`,在 Supabase SQL editor 执行 | 资料库就绪;**`/team/tasks` 从这一步起不再是空白板** |
| 2 | `types.ts`、`shared/lib/tasks.ts` + 单元测试、`api.ts`、新增 capability | 无画面变化,底层就绪 |
| 3 | 拆档 + 总板改版(Tags / Checklist / 多附件 / 排序 / 错误横条) | `/team/tasks` 全部新功能上线 |
| 4 | `/team/projects`、`/team/projects/:id`、路由、`nav.ts` 入口 | Project 功能上线 |
| 5 | Realtime 订阅 + `/team/tasks/archive` | 收尾 |

`PROJECT_NOTES.md` 在步骤 4 之后一并更新:更正 §2 的 `/tasks` 存取说明(实际是
`/team/tasks`、且仅限 management)、在 §3 补 Projects、在 §4 的表清单补进 7 张新表。

## 七、风险与注意事项

**1. 没有 dev Supabase,执行 migration 即直接改动 production。**

本次风险低:`tasks` 相关的表在 prod 完全不存在,全部是新增,不触及 staff / HR /
salary 任何既有资料。SQL 写成幂等(`create table if not exists`、`drop policy
if exists` 后重建、publication 包例外处理),重复执行安全。

**2. 单一 working tree、多个并行 session——动工前必须先清空工作区。**

本设计撰写期间,工作区就被另一个 session 从 `feature/po-system` 切到了 `main`,
`src/features/procurement/` 当场从工作区消失。`git stash list` 目前有两笔:

```
stash@{0}  mobile-pwa-shell WIP — 2026-07-30 并行会话遗留
stash@{1}  epitaxy: pre-switch from feature/po-system
```

且 `main` 上现有一批未提交改动(`index.html`、`src/shared/lib/pwa.ts`、
`src/shared/components/AddToHomeScreen.tsx`、`src/shared/components/Sidebar.tsx`、
`public/icons/`、三个 `Hr*.tsx`),看起来是另一个 session 正在进行的 PWA shell 工作。

**开 `feature/tasks-projects` 之前必须先确认这批改动的归属**(提交、显式 stash、
或等那个 session 收工),否则切分支会再次触发 auto-stash,改动从工作区消失。
本设计的步骤 3 与 4 会动到 `Sidebar.tsx` 与 `nav.ts`,与 PWA 工作有直接冲突面。

**3. `main` 与 `feature/po-system` 差异颇大,勿混用参照。**
`main` 上没有 procurement 模块、没有 `manage_procurement` / `use_procurement`
两个 capability(`Capability` 只有 10 项)、导航是 `nav.ts` 的分组树而非扁平 tab bar、
Tasks 路由是 `/team/tasks`。本设计全部以 `main` 为准。

**4. 无新增 npm 依赖。** 图标沿用 `lucide-react`,配色沿用现有 Tailwind 色票与
`#C4813A` 主色系。
