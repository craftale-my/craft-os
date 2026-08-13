# Tasks & Projects Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `/team/tasks` 从一块三栏 Kanban 升级成带 Tag 与 Project 的任务系统,并把这个模块从未进 repo 的资料库结构、被吞掉的错误、1126 行的单档全部补齐。

**Architecture:** 7 张新表(`projects` / `tasks` / `tags` / `task_tags` / `task_checklist_items` / `task_attachments` / `task_comments`)+ 1 个 `project_progress` view,全部新建、无既有资料。前端把 `src/features/tasks/Tasks.tsx` 拆成 16 个平铺档案,所有 Supabase 存取集中到 `api.ts`,纯逻辑抽到 `src/shared/lib/tasks.ts` 单测。写入一律经 `writeOutcome()` 判定。

**Tech Stack:** React 18 + TypeScript + Vite,Supabase(Postgres 15 + PostgREST + Storage + Realtime),Tailwind,`lucide-react`,Vitest + @testing-library/react。

**Spec:** `docs/superpowers/specs/2026-08-14-tasks-projects-design.md`

## Global Constraints

- **Base branch `main`。** 本计划所有路径、路由、导航结构以 `main` 为准。`feature/po-system` 上的 `tabs.ts`、`src/features/procurement/`、`manage_procurement` / `use_procurement` 在 `main` **不存在**,不得引用。
- **不得新增 npm 依赖。** 图标一律 `lucide-react`,已在依赖内。
- **UI 文字一律英文。** 标签、按钮、错误讯息、空状态文案全部英文;代码注释可中文。
- **配色沿用现有色票**:主色 `#C4813A`(hover `#A86C2C`)、底色 `#F5F0E8`、卡片 `#FDFAF6`、边框 `#EDE5D8` / `#D4C5B0`、主文字 `#3D2B1F`、次文字 `#8B7355`、弱化 `#A09080`。
- **所有写入必须带 `.select()` 并经 `writeOutcome()`(`src/shared/lib/db-write.ts`)判定。** RLS 挡掉的写入回传 `{ data: [], error: null }` —— `error === null` 不代表写进去了。
- **FK 一律 inline `references`,不得手动命名 constraint** —— 前端 PostgREST embed 依赖预设名 `tasks_assigned_to_fkey` / `tasks_created_by_fkey` / `task_comments_staff_id_fkey`。
- **Vitest 全域环境是 `node`**(`vitest.config.ts`)。需要 DOM 的测试档首行必须写 `// @vitest-environment jsdom`。
- **测试断言不得用 `@testing-library/jest-dom`** —— 它不是本 repo 的依赖。沿用既有风格:`toBeTruthy()` / `toBeNull()` / `el.textContent` 搭 `toMatch()`,见 `src/features/hr/HrAttendance.write-failure.test.tsx`。
- **每个 task 结束前必须跑过** `npx tsc --noEmit -p tsconfig.app.json` 与 `npx vitest run`,两者皆绿才 commit。

---

## ⚠️ Prerequisite:开工前必须完成(非代码任务)

本 repo 只有一个 git working tree,多个 Claude session 共用。计划撰写当下 `main`
上有另一个 session 未提交的 PWA shell 改动:

```
 M index.html
 M src/shared/components/Sidebar.tsx
 M src/features/hr/HrClaims.tsx
 M src/features/hr/HrLeave.tsx
 M src/features/hr/HrSalary.tsx
AM src/shared/lib/pwa.ts
A  public/icons/apple-touch-icon-180.png
?? src/shared/components/AddToHomeScreen.tsx
```

本计划的 Task 11 会修改 `src/shared/components/Sidebar.tsx`,与上述工作**直接冲突**。

- [ ] 确认上述改动已提交、或已显式 stash 并记录 tag
- [ ] `git status --short` 除本计划与 spec 两份 md 外应为干净
- [ ] `git checkout -b feature/tasks-projects`
- [ ] `git branch --show-current` 回传 `feature/tasks-projects`

**切分支会触发 auto-stash。** 未完成本节前不得执行任何 Task。

---

## File Structure

### 新增

| 路径 | 责任 |
|---|---|
| `supabase/migration-2026-08-14-tasks-projects.sql` | 全部 DDL、trigger、view、RLS、realtime |
| `src/shared/lib/tasks.ts` | 纯逻辑:tag 正规化、position 计算、进度、逾期、参与者推导 |
| `src/shared/lib/tasks.test.ts` | 上者的单测 |
| `src/features/tasks/types.ts` | `Task` / `Project` / `Tag` / `ChecklistItem` / `Attachment` / `Comment` 型别 |
| `src/features/tasks/api.ts` | 全部 Supabase 存取 |
| `src/features/tasks/useBoardTasks.ts` | 板资料的载入 / 搬移 / 重编号 hook,总板与项目页共用 |
| `src/features/tasks/TaskBoard.tsx` | 三栏板本体,总板与项目页共用 |
| `src/features/tasks/TaskCard.tsx` | 卡片 |
| `src/features/tasks/TaskDetailModal.tsx` | 详情弹窗外壳 |
| `src/features/tasks/TaskFormModal.tsx` | 新增 / 编辑表单 |
| `src/features/tasks/CommentThread.tsx` | 评论 |
| `src/features/tasks/TagInput.tsx` | typeahead 标签输入 |
| `src/features/tasks/TagManagerModal.tsx` | 改名 / 换色 / 删除 tag |
| `src/features/tasks/ChecklistEditor.tsx` | 子项清单 |
| `src/features/tasks/AttachmentGallery.tsx` | 多附件 + lightbox |
| `src/features/tasks/Projects.tsx` | `/team/projects` 列表 |
| `src/features/tasks/ProjectDetail.tsx` | `/team/projects/:id` |
| `src/features/tasks/ProjectFormModal.tsx` | 项目表单 |
| `src/features/tasks/TasksArchive.tsx` | `/team/tasks/archive` |
| `src/features/tasks/Tasks.drag-failure.test.tsx` | 拖卡写入失败回滚 |

### 修改

| 路径 | 改什么 |
|---|---|
| `src/features/tasks/Tasks.tsx` | 由 1126 行缩成 ~180 行的页面外壳 |
| `src/shared/types/index.ts` | `Capability` / `CAPABILITIES` / `DEFAULT_SYSTEM_ROLE_CAPS` 各加 `manage_projects` |
| `src/shared/lib/nav.ts` | `team` 群组内新增 `team-projects` 叶子 |
| `src/shared/lib/nav.test.ts` | 新增 Projects 可见性案例 |
| `src/shared/components/Sidebar.tsx` | `ICONS` 加 `'team-projects': FolderKanban` |
| `src/App.tsx` | 新增三条路由 |
| `PROJECT_NOTES.md` | 更正 Tasks 存取说明、补 Projects、补 7 张表 |

---

## Task 1:资料库 migration

**Files:**
- Create: `supabase/migration-2026-08-14-tasks-projects.sql`

**Interfaces:**
- Consumes: 既有 `staff(id, system_role, rank)`、`system_role_permissions(system_role, permissions jsonb)`、storage bucket `task-attachments`
- Produces: 表 `projects` / `tasks` / `tags` / `task_tags` / `task_checklist_items` / `task_attachments` / `task_comments`;view `project_progress(project_id, total_tasks, done_tasks, overdue_tasks)`;函数 `has_task_cap(text) → boolean`

- [ ] **Step 1: 建立 migration 档**

```sql
-- ============================================================================
-- Craft OS — Tasks & Projects Phase 1 (2026-08-14)
--
-- 在 Supabase SQL editor 里整份执行。幂等 — 可重复运行。
-- 对应设计文档:docs/superpowers/specs/2026-08-14-tasks-projects-design.md
--
-- 注意:tasks / task_comments 在本 project 从未存在(2026-07-05 迁移时漏迁),
-- 因此本档为全新建立,没有任何资料迁移。
-- ============================================================================

-- ── Part 1: 权限辅助函数 ─────────────────────────────────────────────────────
-- 内建默认值镜像 src/shared/types/index.ts 的 DEFAULT_SYSTEM_ROLE_CAPS;
-- Owner 在 Settings → System Roles 显式打开某能力时 RLS 跟着放行。
-- 反向(矩阵关掉)只影响前端 UI,不收紧 RLS —— 代码默认值不在 SQL 里,
-- DB 侧无法复现「默认 + 覆盖」的合并语义。刻意取舍,见设计文档第一节。
create or replace function has_task_cap(p_cap text) returns boolean
language sql security definer stable as $$
  select coalesce((
    select
      coalesce((
        select (srp.permissions ->> p_cap)::boolean
        from system_role_permissions srp
        where srp.system_role = s.system_role
      ), false)
      or
      case p_cap
        when 'view_team' then
          s.system_role in ('owner','admin','hr','manager','supervisor')
          or s.rank in ('manager','supervisor')
        when 'manage_projects' then
          s.system_role in ('owner','admin','hr','manager','supervisor')
          or s.rank in ('manager','supervisor')
        else false
      end
    from staff s
    where s.id = auth.uid()
  ), false)
$$;

-- ── Part 2: projects ────────────────────────────────────────────────────────
create table if not exists projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  color       text not null default '#C4813A',
  status      text not null default 'active'
              check (status in ('active','on_hold','completed','cancelled')),
  owner_id    uuid references staff(id) on delete set null,
  start_date  date,
  due_date    date,
  created_by  uuid references staff(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ── Part 3: tasks ───────────────────────────────────────────────────────────
create table if not exists tasks (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  description  text,
  status       text not null default 'todo'
               check (status in ('todo','in_progress','done')),
  priority     text not null default 'medium'
               check (priority in ('low','medium','high')),
  project_id   uuid references projects(id) on delete set null,
  assigned_to  uuid references staff(id) on delete set null,
  created_by   uuid references staff(id) on delete set null,
  due_date     date,
  department   text,
  position     double precision not null default 0,
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ── Part 4: tags ────────────────────────────────────────────────────────────
create table if not exists tags (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique,
  name       text not null,
  color      text not null default '#8B7355',
  created_by uuid references staff(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists task_tags (
  task_id uuid not null references tasks(id) on delete cascade,
  tag_id  uuid not null references tags(id)  on delete cascade,
  primary key (task_id, tag_id)
);

-- ── Part 5: 子项 / 附件 / 评论 ──────────────────────────────────────────────
create table if not exists task_checklist_items (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references tasks(id) on delete cascade,
  title      text not null,
  done       boolean not null default false,
  position   double precision not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists task_attachments (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references tasks(id) on delete cascade,
  url          text not null,
  storage_path text not null,
  file_name    text,
  mime_type    text,
  size_bytes   bigint,
  uploaded_by  uuid references staff(id) on delete set null,
  created_at   timestamptz not null default now()
);

create table if not exists task_comments (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references tasks(id) on delete cascade,
  staff_id   uuid not null references staff(id) on delete cascade,
  comment    text not null,
  created_at timestamptz not null default now()
);

-- ── Part 6: 索引 ────────────────────────────────────────────────────────────
create index if not exists tasks_project_id_idx     on tasks (project_id);
create index if not exists tasks_assigned_to_idx    on tasks (assigned_to);
create index if not exists tasks_status_pos_idx     on tasks (status, position);
create index if not exists tasks_due_date_idx       on tasks (due_date);
create index if not exists tasks_completed_at_idx   on tasks (completed_at);
create index if not exists task_tags_tag_id_idx     on task_tags (tag_id);
create index if not exists task_checklist_task_idx  on task_checklist_items (task_id);
create index if not exists task_attachments_task_idx on task_attachments (task_id);
create index if not exists task_comments_task_idx   on task_comments (task_id);

-- ── Part 7: trigger ─────────────────────────────────────────────────────────
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

drop trigger if exists tasks_touch_trg on tasks;
create trigger tasks_touch_trg before update on tasks
  for each row execute function tasks_touch();

create or replace function projects_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists projects_touch_trg on projects;
create trigger projects_touch_trg before update on projects
  for each row execute function projects_touch();

-- ── Part 8: 进度 view ───────────────────────────────────────────────────────
-- security_invoker 必须为 true(PG15+),否则 view 以 owner 身分执行、绕过 RLS。
create or replace view project_progress
with (security_invoker = true) as
select
  p.id                                                           as project_id,
  count(t.id)                                                    as total_tasks,
  count(t.id) filter (where t.status = 'done')                   as done_tasks,
  count(t.id) filter (where t.status <> 'done'
                        and t.due_date < current_date)           as overdue_tasks
from projects p
left join tasks t on t.project_id = p.id
group by p.id;

-- ── Part 9: RLS ─────────────────────────────────────────────────────────────
alter table projects             enable row level security;
alter table tasks                enable row level security;
alter table tags                 enable row level security;
alter table task_tags            enable row level security;
alter table task_checklist_items enable row level security;
alter table task_attachments     enable row level security;
alter table task_comments        enable row level security;

-- projects:看得到板的人都能看;只有 manage_projects 能写。
drop policy if exists "projects_select" on projects;
create policy "projects_select" on projects for select to authenticated
  using (has_task_cap('view_team'));
drop policy if exists "projects_manage" on projects;
create policy "projects_manage" on projects for all to authenticated
  using (has_task_cap('manage_projects'))
  with check (has_task_cap('manage_projects'));

-- tasks:使用者全是管理层,刻意宽松;只在「删别人建的」收紧。
drop policy if exists "tasks_select" on tasks;
create policy "tasks_select" on tasks for select to authenticated
  using (has_task_cap('view_team'));
drop policy if exists "tasks_insert" on tasks;
create policy "tasks_insert" on tasks for insert to authenticated
  with check (has_task_cap('view_team') and created_by = auth.uid());
drop policy if exists "tasks_update" on tasks;
create policy "tasks_update" on tasks for update to authenticated
  using (has_task_cap('view_team'))
  with check (has_task_cap('view_team'));
drop policy if exists "tasks_delete" on tasks;
create policy "tasks_delete" on tasks for delete to authenticated
  using (has_task_cap('view_team')
         and (created_by = auth.uid() or has_task_cap('manage_projects')));

-- tags:自由输入,人人可建;改名 / 换色 / 删除只给 manage_projects。
drop policy if exists "tags_select" on tags;
create policy "tags_select" on tags for select to authenticated
  using (has_task_cap('view_team'));
drop policy if exists "tags_insert" on tags;
create policy "tags_insert" on tags for insert to authenticated
  with check (has_task_cap('view_team'));
drop policy if exists "tags_update" on tags;
create policy "tags_update" on tags for update to authenticated
  using (has_task_cap('manage_projects'))
  with check (has_task_cap('manage_projects'));
drop policy if exists "tags_delete" on tags;
create policy "tags_delete" on tags for delete to authenticated
  using (has_task_cap('manage_projects'));

-- task_tags / task_attachments:纯关联与不可变记录,刻意不建 update policy。
drop policy if exists "task_tags_select" on task_tags;
create policy "task_tags_select" on task_tags for select to authenticated
  using (has_task_cap('view_team'));
drop policy if exists "task_tags_insert" on task_tags;
create policy "task_tags_insert" on task_tags for insert to authenticated
  with check (has_task_cap('view_team'));
drop policy if exists "task_tags_delete" on task_tags;
create policy "task_tags_delete" on task_tags for delete to authenticated
  using (has_task_cap('view_team'));

drop policy if exists "task_attachments_select" on task_attachments;
create policy "task_attachments_select" on task_attachments for select to authenticated
  using (has_task_cap('view_team'));
drop policy if exists "task_attachments_insert" on task_attachments;
create policy "task_attachments_insert" on task_attachments for insert to authenticated
  with check (has_task_cap('view_team') and uploaded_by = auth.uid());
drop policy if exists "task_attachments_delete" on task_attachments;
create policy "task_attachments_delete" on task_attachments for delete to authenticated
  using (has_task_cap('view_team'));

-- checklist:板内自由编辑。
drop policy if exists "task_checklist_all" on task_checklist_items;
create policy "task_checklist_all" on task_checklist_items for all to authenticated
  using (has_task_cap('view_team'))
  with check (has_task_cap('view_team'));

-- comments:只能以自己的身分发言,只能改自己的。
drop policy if exists "task_comments_select" on task_comments;
create policy "task_comments_select" on task_comments for select to authenticated
  using (has_task_cap('view_team'));
drop policy if exists "task_comments_insert" on task_comments;
create policy "task_comments_insert" on task_comments for insert to authenticated
  with check (has_task_cap('view_team') and staff_id = auth.uid());
drop policy if exists "task_comments_update" on task_comments;
create policy "task_comments_update" on task_comments for update to authenticated
  using (staff_id = auth.uid())
  with check (staff_id = auth.uid());
drop policy if exists "task_comments_delete" on task_comments;
create policy "task_comments_delete" on task_comments for delete to authenticated
  using (staff_id = auth.uid() or has_task_cap('manage_projects'));

-- ── Part 10: Realtime ───────────────────────────────────────────────────────
-- alter publication ... add table 不是幂等语句,表已在 publication 内会报错。
do $$ begin
  alter publication supabase_realtime add table tasks;
exception when duplicate_object then null;
end $$;
```

- [ ] **Step 2: 在 Supabase SQL editor 执行**

打开 Supabase → 专案 `yfsoesxzurzjdwstszru` → SQL Editor,整份贴上执行。
Expected: `Success. No rows returned`。

- [ ] **Step 3: 再执行一次,验证幂等**

同一份 SQL 再跑一次。
Expected: 一样 `Success. No rows returned`,无任何 error。

- [ ] **Step 4: 用 REST 验证七张表与 view 都在**

```bash
set -a && source .env.local && set +a && for t in projects tasks tags task_tags task_checklist_items task_attachments task_comments project_progress; do printf '%-22s %s\n' "$t" "$(curl -s -o /dev/null -w '%{http_code}' "$VITE_SUPABASE_URL/rest/v1/$t?select=*&limit=1" -H "apikey: $VITE_SUPABASE_ANON_KEY")"; done
```

Expected: 八行全部 `200`。(未登入时 RLS 会回空阵列,但 200 代表表存在且已进
schema cache——对照改动前 `tasks` 是 404。)

- [ ] **Step 5: Commit**

```bash
git add supabase/migration-2026-08-14-tasks-projects.sql
git commit -m "feat(tasks): add tasks & projects schema, RLS and progress view"
```

---

## Task 2:纯逻辑与单元测试

**Files:**
- Create: `src/shared/lib/tasks.ts`
- Test: `src/shared/lib/tasks.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `normalizeTagName(input: string): { slug: string; name: string } | null`
  - `POSITION_STEP: number`(= 1024)
  - `computeDropPosition(prev: number | undefined, next: number | undefined): number`
  - `needsRebalance(positions: number[]): boolean`
  - `rebalance<T>(items: T[]): Array<T & { position: number }>`
  - `projectProgress(done: number, total: number): number`
  - `isOverdue(dueDate: string | null, today: Date): boolean`
  - `deriveParticipants<T extends { assigned_to: string | null }>(tasks: T[], ownerId: string | null): string[]`

- [ ] **Step 1: 写失败的测试**

Create `src/shared/lib/tasks.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  normalizeTagName, computeDropPosition, needsRebalance, rebalance,
  projectProgress, isOverdue, deriveParticipants, POSITION_STEP,
} from './tasks'

describe('normalizeTagName', () => {
  it('collapses case and surrounding space into one slug', () => {
    expect(normalizeTagName('Urgent')!.slug).toBe('urgent')
    expect(normalizeTagName(' urgent ')!.slug).toBe('urgent')
    expect(normalizeTagName('URGENT')!.slug).toBe('urgent')
  })

  it('collapses runs of inner whitespace', () => {
    expect(normalizeTagName('new   store')!.slug).toBe('new store')
  })

  it('keeps the typed casing as the display name', () => {
    expect(normalizeTagName('  Urgent ')!.name).toBe('Urgent')
  })

  it('returns null for blank input', () => {
    expect(normalizeTagName('   ')).toBeNull()
  })
})

describe('computeDropPosition', () => {
  it('seeds an empty column', () => {
    expect(computeDropPosition(undefined, undefined)).toBe(POSITION_STEP)
  })

  it('drops above the first card', () => {
    expect(computeDropPosition(undefined, 1024)).toBe(1024 - POSITION_STEP)
  })

  it('drops below the last card', () => {
    expect(computeDropPosition(2048, undefined)).toBe(2048 + POSITION_STEP)
  })

  it('splits the gap between two cards', () => {
    expect(computeDropPosition(1024, 2048)).toBe(1536)
  })
})

describe('needsRebalance', () => {
  it('is false for a freshly stepped column', () => {
    expect(needsRebalance([1024, 2048, 3072])).toBe(false)
  })

  it('becomes true after repeated splits into the same gap', () => {
    let lo = 1024
    const hi = 2048
    for (let i = 0; i < 60; i++) lo = computeDropPosition(lo, hi)
    expect(needsRebalance([lo, hi])).toBe(true)
  })
})

describe('rebalance', () => {
  it('renumbers in order with a full step between neighbours', () => {
    const out = rebalance([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    expect(out.map(o => o.position)).toEqual([1024, 2048, 3072])
    expect(out.map(o => o.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('projectProgress', () => {
  it('never divides by zero', () => {
    expect(projectProgress(0, 0)).toBe(0)
  })

  it('rounds to a whole percent', () => {
    expect(projectProgress(1, 3)).toBe(33)
    expect(projectProgress(8, 15)).toBe(53)
    expect(projectProgress(6, 6)).toBe(100)
  })
})

describe('isOverdue', () => {
  // 以本地时间建构,否则 runner 的时区会改变「今天」是哪一天。
  const today = new Date(2026, 7, 14, 9, 0, 0)

  it('is false on the due date itself', () => {
    expect(isOverdue('2026-08-14', today)).toBe(false)
  })

  it('is true the day after', () => {
    expect(isOverdue('2026-08-13', today)).toBe(true)
  })

  it('is false with no due date', () => {
    expect(isOverdue(null, today)).toBe(false)
  })
})

describe('deriveParticipants', () => {
  it('dedupes assignees, drops nulls, and always includes the owner', () => {
    const tasks = [
      { assigned_to: 'amy' }, { assigned_to: 'amy' },
      { assigned_to: null }, { assigned_to: 'ben' },
    ]
    expect(deriveParticipants(tasks, 'jason').sort()).toEqual(['amy', 'ben', 'jason'])
  })

  it('does not duplicate the owner when they also hold a task', () => {
    expect(deriveParticipants([{ assigned_to: 'jason' }], 'jason')).toEqual(['jason'])
  })

  it('copes with no owner', () => {
    expect(deriveParticipants([{ assigned_to: 'amy' }], null)).toEqual(['amy'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/shared/lib/tasks.test.ts`
Expected: FAIL — `Failed to resolve import "./tasks"`。

- [ ] **Step 3: 写实作**

Create `src/shared/lib/tasks.ts`:

```ts
/**
 * Tasks 模块的纯逻辑。刻意不含 React 与 Supabase,
 * 好让排序、进度与日期规则能脱离渲染与网路单测。
 */

/** 栏内排序的基础步长。以 2 的幂次为步长,让「插入中点」能反覆二分。 */
export const POSITION_STEP = 1024

/** 相邻 position 小于此值就该重新编号,否则 double 精度会开始吃掉中点。 */
const MIN_GAP = 0.0001

/**
 * 使用者输入的标签 → 去重用的 slug 与显示用的原文。
 * slug 决定同一性(`Urgent` 与 ` urgent ` 是同一个标签),
 * name 保留使用者敲的大小写,由 upsert 决定先到者胜。
 */
export function normalizeTagName(input: string): { slug: string; name: string } | null {
  const name = input.trim().replace(/\s+/g, ' ')
  if (!name) return null
  return { slug: name.toLowerCase(), name }
}

/** 拖放落点的新 position。prev/next 是落点上下相邻卡片的 position。 */
export function computeDropPosition(prev: number | undefined, next: number | undefined): number {
  if (prev === undefined && next === undefined) return POSITION_STEP
  if (prev === undefined) return next! - POSITION_STEP
  if (next === undefined) return prev + POSITION_STEP
  return (prev + next) / 2
}

/** 该栏是否已经挤到需要整栏重新编号。 */
export function needsRebalance(positions: number[]): boolean {
  const sorted = [...positions].sort((a, b) => a - b)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] < MIN_GAP) return true
  }
  return false
}

/** 依现有顺序以 POSITION_STEP 重新编号。 */
export function rebalance<T>(items: T[]): Array<T & { position: number }> {
  return items.map((item, i) => ({ ...item, position: (i + 1) * POSITION_STEP }))
}

/** 完成百分比,0–100 整数。总数为 0 时回 0,不得除以零。 */
export function projectProgress(done: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((done / total) * 100)
}

/** 到期当日不算逾期;只比日期,不比时刻。 */
export function isOverdue(dueDate: string | null, today: Date): boolean {
  if (!dueDate) return false
  return dueDate < toLocalDateString(today)
}

/** 项目参与者 = 所有任务的 assignee 去重,加上 owner。 */
export function deriveParticipants<T extends { assigned_to: string | null }>(
  tasks: T[],
  ownerId: string | null,
): string[] {
  const out = new Set<string>()
  if (ownerId) out.add(ownerId)
  for (const t of tasks) if (t.assigned_to) out.add(t.assigned_to)
  return [...out]
}

/** 本地时区的 YYYY-MM-DD。date 栏位是无时区的日期,不能用 toISOString。 */
function toLocalDateString(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/shared/lib/tasks.test.ts`
Expected: PASS,19 个测试全绿。

- [ ] **Step 5: 型别检查**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: 无输出。

- [ ] **Step 6: Commit**

```bash
git add src/shared/lib/tasks.ts src/shared/lib/tasks.test.ts
git commit -m "feat(tasks): add pure ordering, progress and tag-normalisation logic"
```

---

## Task 3:型别与资料存取层

**Files:**
- Create: `src/features/tasks/types.ts`
- Create: `src/features/tasks/api.ts`

**Interfaces:**
- Consumes: `supabase`(`src/shared/lib/supabase.ts`)、`writeOutcome` / `WriteOutcome`(`src/shared/lib/db-write.ts`)、`normalizeTagName`(Task 2)、`DONE_WINDOW_DAYS`(本 task 的 `types.ts`)
- Produces: 下列型别与函数,后续所有 task 一律经此层存取 Supabase

- [ ] **Step 1: 写型别**

Create `src/features/tasks/types.ts`:

```ts
export type TaskStatus   = 'todo' | 'in_progress' | 'done'
export type TaskPriority = 'low' | 'medium' | 'high'
export type ProjectStatus = 'active' | 'on_hold' | 'completed' | 'cancelled'

export interface StaffLite { id: string; name: string; avatar: string | null }

export interface Tag {
  id: string
  slug: string
  name: string
  color: string
}

export interface ChecklistItem {
  id: string
  task_id: string
  title: string
  done: boolean
  position: number
}

export interface Attachment {
  id: string
  task_id: string
  url: string
  storage_path: string
  file_name: string | null
  mime_type: string | null
  size_bytes: number | null
  uploaded_by: string | null
  created_at: string
}

export interface TaskComment {
  id: string
  task_id: string
  staff_id: string
  comment: string
  created_at: string
  staff?: StaffLite
}

export interface Task {
  id: string
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  project_id: string | null
  assigned_to: string | null
  created_by: string | null
  due_date: string | null
  department: string | null
  position: number
  completed_at: string | null
  created_at: string
  updated_at: string
  assignee?: StaffLite
  creator?: StaffLite
  project?: { id: string; name: string; color: string } | null
  tags: Tag[]
  /** 由 board 查询聚合,不是资料表栏位。 */
  _comment_count: number
  _attachment_count: number
  _checklist_done: number
  _checklist_total: number
}

export interface Project {
  id: string
  name: string
  description: string | null
  color: string
  status: ProjectStatus
  owner_id: string | null
  start_date: string | null
  due_date: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  owner?: StaffLite
  /** 来自 project_progress view。 */
  total_tasks: number
  done_tasks: number
  overdue_tasks: number
}

export const TASK_COLUMNS: { key: TaskStatus; label: string }[] = [
  { key: 'todo',        label: 'To Do' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'done',        label: 'Done' },
]

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  active:    'Active',
  on_hold:   'On Hold',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

/** Done 栏保留几天。超过的只在 /team/tasks/archive 出现。 */
export const DONE_WINDOW_DAYS = 14
```

- [ ] **Step 2: 写资料存取层**

Create `src/features/tasks/api.ts`:

```ts
import { supabase } from '../../shared/lib/supabase'
import { writeOutcome, type WriteOutcome } from '../../shared/lib/db-write'
import { normalizeTagName } from '../../shared/lib/tasks'
import { DONE_WINDOW_DAYS } from './types'
import type {
  Task, Project, Tag, ChecklistItem, Attachment, TaskComment,
  TaskStatus, TaskPriority, ProjectStatus,
} from './types'

/**
 * Tasks 模块唯一的 Supabase 出入口。
 *
 * 两条硬规则:
 *  1. 读取失败一律 throw —— 页面层负责显示错误。旧版把 error 吞掉,
 *     结果 tasks 表整个不存在也只是显示一块空白板,没人发现。
 *  2. 写入一律带 .select() 并经 writeOutcome() 判定 —— RLS 挡掉的写入
 *     回传 { data: [], error: null },error === null 不代表写进去了。
 */

const TASK_SELECT = `
  *,
  assignee:staff!tasks_assigned_to_fkey(id,name,avatar),
  creator:staff!tasks_created_by_fkey(id,name,avatar),
  project:projects(id,name,color),
  task_tags(tags(id,slug,name,color)),
  task_comments(count),
  task_attachments(count),
  task_checklist_items(id,done)
`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function shapeTask(row: any): Task {
  const checklist: Array<{ done: boolean }> = row.task_checklist_items ?? []
  return {
    ...row,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tags: (row.task_tags ?? []).map((tt: any) => tt.tags).filter(Boolean),
    _comment_count:    row.task_comments?.[0]?.count ?? 0,
    _attachment_count: row.task_attachments?.[0]?.count ?? 0,
    _checklist_total:  checklist.length,
    _checklist_done:   checklist.filter(c => c.done).length,
  } as Task
}

/** Done 栏的 server-side 时间窗。前端过滤会让半年后每次开板都拉全部历史。 */
export function doneWindowFilter(now: Date, days = DONE_WINDOW_DAYS): string {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
  return `status.neq.done,completed_at.gte.${cutoff}`
}

// ── Tasks ───────────────────────────────────────────────────────────────────

/** 板上要显示的任务。`projectId` 给的话只取该项目。 */
export async function fetchBoardTasks(opts: {
  projectId?: string
  now?: Date
} = {}): Promise<Task[]> {
  let q = supabase.from('tasks').select(TASK_SELECT)
  if (opts.projectId) q = q.eq('project_id', opts.projectId)
  const { data, error } = await q
    .or(doneWindowFilter(opts.now ?? new Date()))
    .order('position', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []).map(shapeTask)
}

/** Archive 页:全部已完成任务,不受时间窗限制。 */
export async function fetchArchivedTasks(): Promise<Task[]> {
  const { data, error } = await supabase
    .from('tasks').select(TASK_SELECT)
    .eq('status', 'done')
    .order('completed_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []).map(shapeTask)
}

export interface TaskInput {
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  project_id: string | null
  assigned_to: string | null
  due_date: string | null
  department: string | null
  position: number
}

export async function createTask(input: TaskInput, createdBy: string): Promise<WriteOutcome> {
  return writeOutcome(
    await supabase.from('tasks').insert({ ...input, created_by: createdBy }).select(),
  )
}

export async function updateTask(id: string, patch: Partial<TaskInput>): Promise<WriteOutcome> {
  return writeOutcome(await supabase.from('tasks').update(patch).eq('id', id).select())
}

export async function moveTask(
  id: string, status: TaskStatus, position: number,
): Promise<WriteOutcome> {
  return writeOutcome(
    await supabase.from('tasks').update({ status, position }).eq('id', id).select(),
  )
}

export async function deleteTask(id: string): Promise<WriteOutcome> {
  return writeOutcome(await supabase.from('tasks').delete().eq('id', id).select())
}

// ── Tags ────────────────────────────────────────────────────────────────────

export async function fetchTags(): Promise<Tag[]> {
  const { data, error } = await supabase
    .from('tags').select('id,slug,name,color').order('name')
  if (error) throw new Error(error.message)
  return (data ?? []) as Tag[]
}

/**
 * 自由输入的标签。冲突时刻意写回自己的旧 name(先到者胜),
 * 目的是让 RETURNING 回传既有列 —— 所以打 `Urgent` 会命中已存在的 `urgent`,
 * 不会产生第二笔。
 *
 * 这是唯一不经 writeOutcome 的写入:`.single()` 在零列时会回 PGRST116 error,
 * 所以 RLS 挡掉会直接 throw,不会静默通过。
 */
export async function upsertTag(raw: string, createdBy: string): Promise<Tag> {
  const norm = normalizeTagName(raw)
  if (!norm) throw new Error('Tag name cannot be empty.')
  const { data, error } = await supabase
    .from('tags')
    .upsert(
      { slug: norm.slug, name: norm.name, created_by: createdBy },
      { onConflict: 'slug', ignoreDuplicates: false },
    )
    .select('id,slug,name,color')
    .single()
  if (error) throw new Error(error.message)
  return data as Tag
}

export async function attachTag(taskId: string, tagId: string): Promise<WriteOutcome> {
  return writeOutcome(
    await supabase.from('task_tags').insert({ task_id: taskId, tag_id: tagId }).select(),
  )
}

export async function detachTag(taskId: string, tagId: string): Promise<WriteOutcome> {
  return writeOutcome(
    await supabase.from('task_tags').delete()
      .eq('task_id', taskId).eq('tag_id', tagId).select(),
  )
}

export async function updateTag(
  id: string, patch: { name?: string; slug?: string; color?: string },
): Promise<WriteOutcome> {
  return writeOutcome(await supabase.from('tags').update(patch).eq('id', id).select())
}

export async function deleteTag(id: string): Promise<WriteOutcome> {
  return writeOutcome(await supabase.from('tags').delete().eq('id', id).select())
}

// ── Checklist ───────────────────────────────────────────────────────────────

export async function fetchChecklist(taskId: string): Promise<ChecklistItem[]> {
  const { data, error } = await supabase
    .from('task_checklist_items').select('*')
    .eq('task_id', taskId).order('position')
  if (error) throw new Error(error.message)
  return (data ?? []) as ChecklistItem[]
}

export async function addChecklistItem(
  taskId: string, title: string, position: number,
): Promise<WriteOutcome> {
  return writeOutcome(
    await supabase.from('task_checklist_items')
      .insert({ task_id: taskId, title, position }).select(),
  )
}

export async function setChecklistDone(id: string, done: boolean): Promise<WriteOutcome> {
  return writeOutcome(
    await supabase.from('task_checklist_items').update({ done }).eq('id', id).select(),
  )
}

export async function deleteChecklistItem(id: string): Promise<WriteOutcome> {
  return writeOutcome(
    await supabase.from('task_checklist_items').delete().eq('id', id).select(),
  )
}

// ── Attachments ─────────────────────────────────────────────────────────────

export async function fetchAttachments(taskId: string): Promise<Attachment[]> {
  const { data, error } = await supabase
    .from('task_attachments').select('*')
    .eq('task_id', taskId).order('created_at')
  if (error) throw new Error(error.message)
  return (data ?? []) as Attachment[]
}

/** 上传后写一笔纪录。storage_path 必须留下,否则档案永远删不掉。 */
export async function uploadAttachment(
  taskId: string, file: File, uploadedBy: string,
): Promise<WriteOutcome> {
  const ext = file.name.split('.').pop() ?? 'jpg'
  const storagePath = `${taskId}/${Date.now()}.${ext}`
  const { error: upErr } = await supabase.storage
    .from('task-attachments').upload(storagePath, file, { contentType: file.type })
  if (upErr) return { ok: false, reason: upErr.message }

  const url = supabase.storage.from('task-attachments').getPublicUrl(storagePath).data.publicUrl
  const res = writeOutcome(
    await supabase.from('task_attachments').insert({
      task_id: taskId, url, storage_path: storagePath,
      file_name: file.name, mime_type: file.type, size_bytes: file.size,
      uploaded_by: uploadedBy,
    }).select(),
  )
  // 纪录写不进去就把已上传的档案收掉,不要留孤儿。
  if (!res.ok) await supabase.storage.from('task-attachments').remove([storagePath])
  return res
}

export async function deleteAttachment(att: Attachment): Promise<WriteOutcome> {
  const res = writeOutcome(
    await supabase.from('task_attachments').delete().eq('id', att.id).select(),
  )
  if (res.ok) await supabase.storage.from('task-attachments').remove([att.storage_path])
  return res
}

// ── Comments ────────────────────────────────────────────────────────────────

export async function fetchComments(taskId: string): Promise<TaskComment[]> {
  const { data, error } = await supabase
    .from('task_comments')
    .select('*, staff:staff!task_comments_staff_id_fkey(id,name,avatar)')
    .eq('task_id', taskId).order('created_at')
  if (error) throw new Error(error.message)
  return (data ?? []) as TaskComment[]
}

export async function postComment(
  taskId: string, staffId: string, comment: string,
): Promise<WriteOutcome> {
  return writeOutcome(
    await supabase.from('task_comments')
      .insert({ task_id: taskId, staff_id: staffId, comment }).select(),
  )
}

// ── Projects ────────────────────────────────────────────────────────────────

const PROJECT_SELECT = '*, owner:staff!projects_owner_id_fkey(id,name,avatar)'

export async function fetchProjects(): Promise<Project[]> {
  const [projRes, progRes] = await Promise.all([
    supabase.from('projects').select(PROJECT_SELECT).order('created_at', { ascending: false }),
    supabase.from('project_progress').select('*'),
  ])
  if (projRes.error) throw new Error(projRes.error.message)
  if (progRes.error) throw new Error(progRes.error.message)
  const byId = new Map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (progRes.data ?? []).map((r: any) => [r.project_id, r]),
  )
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (projRes.data ?? []).map((p: any) => ({
    ...p,
    total_tasks:   byId.get(p.id)?.total_tasks   ?? 0,
    done_tasks:    byId.get(p.id)?.done_tasks    ?? 0,
    overdue_tasks: byId.get(p.id)?.overdue_tasks ?? 0,
  })) as Project[]
}

export async function fetchProject(id: string): Promise<Project> {
  const [projRes, progRes] = await Promise.all([
    supabase.from('projects').select(PROJECT_SELECT).eq('id', id).single(),
    supabase.from('project_progress').select('*').eq('project_id', id).maybeSingle(),
  ])
  if (projRes.error) throw new Error(projRes.error.message)
  return {
    ...projRes.data,
    total_tasks:   progRes.data?.total_tasks   ?? 0,
    done_tasks:    progRes.data?.done_tasks    ?? 0,
    overdue_tasks: progRes.data?.overdue_tasks ?? 0,
  } as Project
}

export interface ProjectInput {
  name: string
  description: string | null
  color: string
  status: ProjectStatus
  owner_id: string | null
  start_date: string | null
  due_date: string | null
}

export async function createProject(
  input: ProjectInput, createdBy: string,
): Promise<WriteOutcome> {
  return writeOutcome(
    await supabase.from('projects').insert({ ...input, created_by: createdBy }).select(),
  )
}

export async function updateProject(
  id: string, patch: Partial<ProjectInput>,
): Promise<WriteOutcome> {
  return writeOutcome(await supabase.from('projects').update(patch).eq('id', id).select())
}

export async function deleteProject(id: string): Promise<WriteOutcome> {
  return writeOutcome(await supabase.from('projects').delete().eq('id', id).select())
}
```

- [ ] **Step 3: 型别检查**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: 无输出。(`api.ts` 目前还没有使用者,只需编得过。)

- [ ] **Step 4: Commit**

```bash
git add src/features/tasks/types.ts src/features/tasks/api.ts
git commit -m "feat(tasks): add typed data-access layer with write-outcome checking"
```

---

## Task 4:拆档,行为不变

把 `Tasks.tsx` 由 1126 行拆开并改接 `api.ts`。**这个 task 不加任何新功能**,唯一
可见变化是载入失败会显示错误横条而不是空白板。

**Files:**
- Modify: `src/features/tasks/Tasks.tsx`(1126 → ~180 行)
- Create: `src/features/tasks/TaskBoard.tsx`
- Create: `src/features/tasks/TaskCard.tsx`
- Create: `src/features/tasks/TaskDetailModal.tsx`
- Create: `src/features/tasks/TaskFormModal.tsx`
- Create: `src/features/tasks/CommentThread.tsx`

**Interfaces:**
- Consumes: Task 3 的 `api.ts` 全部函数、`types.ts` 全部型别;`Avatar`(props:`{ name: string; avatar: string | null; size?: 'sm'|'md'|'lg' }`)、`useAuth()`(回传 `{ staff }`)、`useLookups()`(用 `departmentOptions(current?)` 与 `deptName(slug)`)
- Produces:
  - `<TaskBoard tasks canManage currentStaffId onCardClick onAddClick onMove />`,其中
    `onMove: (taskId: string, status: TaskStatus, position: number) => void`
  - `<TaskCard task onClick showMobileActions onStatusChange />`
  - `<TaskDetailModal task allStaff currentStaffId onClose onChanged />`
  - `<TaskFormModal task allStaff projects currentStaffId onClose onSaved />`
  - `<CommentThread taskId currentStaffId />`

- [ ] **Step 1: 建立 `TaskCard.tsx`**

从现行 `Tasks.tsx:84-178` 的 `TaskCard` 搬过来,改用 `types.ts` 的 `Task`,并把
`isOverdue` 改成从 `src/shared/lib/tasks.ts` 汇入(移除档内那份重复实作),部门标签
改用 `useLookups().deptName(task.department)`(现行版本直接印 slug,所以
`night bar (basement)` 会原样露出来)。

`PRIORITY_CFG` 与 `COL_STYLE` 两张色表整份保留,搬进 `TaskCard.tsx` 与
`TaskBoard.tsx`。

- [ ] **Step 2: 建立 `TaskBoard.tsx`**

从 `Tasks.tsx:182-266` 的 `KanbanColumn` 搬过来,外层再包一个 `TaskBoard`,负责
三栏排版、拖放状态与 mobile 单栏切换(现行 `Tasks.tsx:1040-1120` 那两块)。
`TaskBoard` 只吃 `tasks` 阵列,不自己查资料 —— 这样 `/team/tasks` 与
`/team/projects/:id` 能共用。

- [ ] **Step 3: 建立 `CommentThread.tsx`、`TaskDetailModal.tsx`、`TaskFormModal.tsx`**

分别从现行 `Tasks.tsx` 的评论区块、`TaskDetailModal`(408-800)、`CreateEditModal`
(268-404)搬出。所有 `supabase.from(...)` 直接呼叫改成 `api.ts` 的函数,并检查
`WriteOutcome`:

```tsx
const res = await updateTask(task.id, patch)
if (!res.ok) { setError(res.reason); return }
onChanged()
```

- [ ] **Step 4: 改写 `Tasks.tsx` 成页面外壳**

保留 header、筛选列(search / My Tasks / Department / Assignee)、`TaskBoard`、
两个 modal 的开合。载入改成:

```tsx
const [error, setError] = useState('')

async function load() {
  setLoading(true)
  try {
    const [t, s] = await Promise.all([
      fetchBoardTasks(),
      supabase.from('staff').select('id,name,avatar,rank,department').order('name'),
    ])
    setTasks(t)
    setAllStaff((s.data ?? []) as Staff[])
    setError('')
  } catch (e) {
    setError(e instanceof Error ? e.message : 'Could not load tasks.')
  } finally {
    setLoading(false)
  }
}
```

错误横条(放在 header 下方,`TaskBoard` 上方):

```tsx
{error && (
  <div className="flex items-center justify-between gap-3 mb-4 px-4 py-3 rounded-xl bg-red-50 border border-red-200">
    <p className="text-sm text-red-700">{error}</p>
    <button
      onClick={load}
      className="text-xs font-semibold text-red-700 underline flex-shrink-0"
    >
      Retry
    </button>
  </div>
)}
```

部门筛选下拉改用 `useLookups().departmentOptions()`,**删掉档内写死的 `TASK_DEPTS`**
——它只有 barista / bakery / kitchen / general 四项,live `departments` 表实际有
Front House、Bakery、Kitchen、Craftale Night Bar、Management、Other 六项。

- [ ] **Step 5: 确认行数下降且无残留**

```bash
wc -l src/features/tasks/*.tsx && grep -rn "supabase.from" src/features/tasks/*.tsx
```

Expected: `Tasks.tsx` 在 200 行以内;`grep` 只在 `Tasks.tsx` 命中 `staff` 那一句,
其余 `.tsx` 皆无 —— 所有资料表存取都在 `api.ts`。

- [ ] **Step 6: 型别检查与测试**

Run: `npx tsc --noEmit -p tsconfig.app.json && npx vitest run`
Expected: 两者皆无错误,既有测试全绿。

- [ ] **Step 7: 浏览器验证**

用 preview 工具开 `/team/tasks`,确认:板会显示(不再是空的)、可以新增任务、拖卡
换栏有效、评论可发、筛选可用。

- [ ] **Step 8: Commit**

```bash
git add src/features/tasks/
git commit -m "refactor(tasks): split the 1126-line board into focused files and surface load errors"
```

---

## Task 5:拖卡写入失败必须回滚

现行乐观更新只在 `error` 非空时回滚。RLS 静默挡掉的写入回传
`{ data: [], error: null }`,卡片会停在新栏位直到重整 —— 与 clock-out 那个已修 bug
(`f1240b2`)是同一个形状。

**Files:**
- Create: `src/features/tasks/Tasks.drag-failure.test.tsx`
- Modify: `src/features/tasks/Tasks.tsx`

**Interfaces:**
- Consumes: Task 4 的 `Tasks.tsx`、`api.ts` 的 `moveTask`
- Produces: 无新公开介面;`Tasks.tsx` 的 `handleMove` 改为依 `WriteOutcome` 回滚

- [ ] **Step 1: 写失败的测试**

Create `src/features/tasks/Tasks.drag-failure.test.tsx`:

```tsx
// @vitest-environment jsdom
//
// 证明看板的乐观更新在「RLS 静默挡掉」这个形状下会回滚。
// 纯排序数学在 shared/lib/tasks.test.ts;这里测的是 WIRING:
// moveTask 回 { ok: false } 时卡片要回到原栏,并显示错误。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

const moveTask = vi.fn()

vi.mock('./api', () => ({
  fetchBoardTasks: () => Promise.resolve([{
    id: 'task-1', title: 'Refill the beans', description: null,
    status: 'todo', priority: 'medium', project_id: null,
    assigned_to: 'staff-1', created_by: 'staff-1', due_date: null,
    department: null, position: 1024, completed_at: null,
    created_at: '2026-08-14T00:00:00Z', updated_at: '2026-08-14T00:00:00Z',
    tags: [], _comment_count: 0, _attachment_count: 0,
    _checklist_done: 0, _checklist_total: 0,
  }]),
  moveTask,
}))

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ staff: { id: 'staff-1', name: 'Amy', avatar: null, rank: 'manager' } }),
}))

vi.mock('../../shared/lib/lookups', () => ({
  useLookups: () => ({
    departmentOptions: () => [],
    deptName: (s: string) => s,
  }),
}))

vi.mock('../../shared/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }),
    }),
    channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
    removeChannel: () => {},
  },
}))

import TasksPage from './Tasks'

describe('board drag persistence', () => {
  beforeEach(() => { moveTask.mockReset() })

  it('rolls the card back when the write is silently filtered by RLS', async () => {
    // 这是 RLS 挡掉时的真实形状:没有 error,也没有 rows。
    moveTask.mockResolvedValue({ ok: false, reason: 'it was not saved — you may have been signed out.' })

    render(<TasksPage />)
    await screen.findByText('Refill the beans')

    // 直接呼叫暴露给板的搬移处理器,绕开 jsdom 不支援的 HTML5 拖放。
    await window.__taskBoardMove!('task-1', 'done', 2048)

    await waitFor(() => {
      expect(screen.getByTestId('column-todo').textContent).toMatch(/Refill the beans/)
    })
    expect(screen.getByTestId('column-done').textContent).not.toMatch(/Refill the beans/)
    expect(screen.getByText(/not saved/i)).toBeTruthy()
  })

  it('leaves the card in the new column when the write lands', async () => {
    moveTask.mockResolvedValue({ ok: true })

    render(<TasksPage />)
    await screen.findByText('Refill the beans')

    await window.__taskBoardMove!('task-1', 'done', 2048)

    await waitFor(() => {
      expect(screen.getByTestId('column-done').textContent).toMatch(/Refill the beans/)
    })
  })
})
```

测试透过 `window.__taskBoardMove` 呼叫搬移处理器,因为 jsdom 不实作 HTML5 拖放
事件。在 `Tasks.tsx` 里加一行仅测试环境用的挂载:

```tsx
useEffect(() => {
  if (import.meta.env.MODE === 'test') {
    (window as unknown as { __taskBoardMove?: typeof handleMove }).__taskBoardMove = handleMove
  }
})
```

并在 `TaskBoard.tsx` 的每一栏外层加 `data-testid={`column-${colKey}`}`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/features/tasks/Tasks.drag-failure.test.tsx`
Expected: FAIL — 第一个案例失败,卡片留在 `column-done`(现行逻辑只看 `error`)。

- [ ] **Step 3: 改 `handleMove` 依 `WriteOutcome` 回滚**

```tsx
async function handleMove(taskId: string, status: TaskStatus, position: number) {
  const before = tasks.find(t => t.id === taskId)
  if (!before) return

  setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status, position } : t))

  const res = await moveTask(taskId, status, position)
  if (!res.ok) {
    // 写入没落地就把卡片放回原栏原位置,否则画面会一直骗人到下次重整。
    setTasks(prev => prev.map(t =>
      t.id === taskId ? { ...t, status: before.status, position: before.position } : t,
    ))
    setError(res.reason)
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/features/tasks/Tasks.drag-failure.test.tsx`
Expected: PASS,两个案例皆绿。

- [ ] **Step 5: 全测试 + 型别检查**

Run: `npx tsc --noEmit -p tsconfig.app.json && npx vitest run`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/features/tasks/Tasks.tsx src/features/tasks/TaskBoard.tsx src/features/tasks/Tasks.drag-failure.test.tsx
git commit -m "fix(tasks): roll dragged cards back when the move is silently rejected"
```

---

## Task 6:Tags

**Files:**
- Create: `src/features/tasks/TagInput.tsx`
- Modify: `src/features/tasks/TaskCard.tsx`(tags 列)
- Modify: `src/features/tasks/TaskDetailModal.tsx`(Tags 区块)
- Modify: `src/features/tasks/Tasks.tsx`(Tag 筛选下拉)

**Interfaces:**
- Consumes: `fetchTags` / `upsertTag` / `attachTag` / `detachTag`(Task 3)、`normalizeTagName`(Task 2)
- Produces: `<TagInput value={Tag[]} allTags={Tag[]} onAdd={(raw: string) => void} onRemove={(tagId: string) => void} />`

- [ ] **Step 1: 建立 `TagInput.tsx`**

```tsx
import { useState } from 'react'
import { X } from 'lucide-react'
import { normalizeTagName } from '../../shared/lib/tasks'
import type { Tag } from './types'

export function TagInput({ value, allTags, onAdd, onRemove }: {
  value: Tag[]
  allTags: Tag[]
  onAdd: (raw: string) => void
  onRemove: (tagId: string) => void
}) {
  const [draft, setDraft] = useState('')

  const norm = normalizeTagName(draft)
  const chosen = new Set(value.map(t => t.id))
  // 已经挂在这个任务上的不再建议;比对 slug 而非显示名,
  // 这样打 "Urg" 也能命中 name 是 "URGENT" 的那一笔。
  const suggestions = norm
    ? allTags.filter(t => !chosen.has(t.id) && t.slug.includes(norm.slug)).slice(0, 6)
    : []

  function commit(raw: string) {
    if (!normalizeTagName(raw)) return
    onAdd(raw)
    setDraft('')
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {value.map(t => (
          <span
            key={t.id}
            className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full"
            style={{ color: t.color, background: `${t.color}1A` }}
          >
            {t.name}
            <button
              type="button"
              onClick={() => onRemove(t.id)}
              aria-label={`Remove ${t.name}`}
              className="hover:opacity-70"
            >
              <X size={11} />
            </button>
          </span>
        ))}
        {value.length === 0 && <span className="text-xs text-[#A09080]">No tags</span>}
      </div>

      <div className="relative">
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            commit(draft)
          }}
          placeholder="Add a tag…"
          className="w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-[#3D2B1F] focus:outline-none focus:ring-2 focus:ring-[#C4813A40]"
        />
        {suggestions.length > 0 && (
          <ul className="absolute z-10 left-0 right-0 mt-1 bg-white border border-[#D4C5B0] rounded-lg shadow-lg overflow-hidden">
            {suggestions.map(t => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => commit(t.name)}
                  className="w-full text-left px-3 py-1.5 text-sm text-[#3D2B1F] hover:bg-[#F5EDE0]"
                >
                  {t.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 接进 `TaskDetailModal.tsx`**

在 Description 之下新增 Tags 区块。`onAdd` 走 upsert → attach → 重新载入任务:

```tsx
async function handleAddTag(raw: string) {
  try {
    const tag = await upsertTag(raw, currentStaffId)
    if (task.tags.some(t => t.id === tag.id)) return   // 已经挂上了,不重复
    const res = await attachTag(task.id, tag.id)
    if (!res.ok) { setError(res.reason); return }
    onChanged()
  } catch (e) {
    setError(e instanceof Error ? e.message : 'Could not add the tag.')
  }
}
```

- [ ] **Step 3: 卡片显示 tags**

在标题下方、footer 上方插入一列,最多两个:

```tsx
{task.tags.length > 0 && (
  <div className="flex flex-wrap items-center gap-1 mb-2">
    {task.tags.slice(0, 2).map(t => (
      <span
        key={t.id}
        className="text-[11px] font-medium px-1.5 py-0.5 rounded-full"
        style={{ color: t.color, background: `${t.color}1A` }}
      >
        {t.name}
      </span>
    ))}
    {task.tags.length > 2 && (
      <span className="text-[11px] font-medium text-[#A09080]">
        +{task.tags.length - 2}
      </span>
    )}
  </div>
)}
```

- [ ] **Step 4: 筛选列加 Tag 下拉**

`Tasks.tsx` 载入 `fetchTags()` 存进 `allTags`,新增 `filterTag` state,并在
`filteredTasks` 的判断链补一句:

```tsx
if (filterTag && !t.tags.some(tg => tg.id === filterTag)) return false
```

- [ ] **Step 5: 型别检查与测试**

Run: `npx tsc --noEmit -p tsconfig.app.json && npx vitest run`
Expected: 全绿。

- [ ] **Step 6: 浏览器验证**

开一个任务,加 tag `Urgent`;关掉再开另一个任务,打 `urg` 应该在下拉看到
`Urgent`;选它,两个任务应共用同一个 tag(筛选该 tag 时两个都在)。

- [ ] **Step 7: Commit**

```bash
git add src/features/tasks/
git commit -m "feat(tasks): add free-form tags with typeahead and slug de-duplication"
```

---

## Task 7:Tag 管理

自由输入必须配一条修正打错字的路,否则 `urgnet` 会永远躺在下拉里。

**Files:**
- Create: `src/features/tasks/TagManagerModal.tsx`
- Modify: `src/features/tasks/Tasks.tsx`(Tag 下拉底部加入口)

**Interfaces:**
- Consumes: `fetchTags` / `updateTag` / `deleteTag`(Task 3)、`normalizeTagName`(Task 2)、`useCan()`
- Produces: `<TagManagerModal tags onClose onChanged />`

- [ ] **Step 1: 建立 `TagManagerModal.tsx`**

一列一个 tag:名称输入框、颜色输入(`<input type="color">`)、Delete 按钮。
改名时 `slug` 必须一起更新,否则去重会失效:

```tsx
async function saveTag(tag: Tag, name: string, color: string) {
  const norm = normalizeTagName(name)
  if (!norm) { setError('Tag name cannot be empty.'); return }
  // slug 必须跟着 name 走,否则改名后新旧写法不再收敛到同一笔。
  const res = await updateTag(tag.id, { name: norm.name, slug: norm.slug, color })
  if (!res.ok) { setError(res.reason); return }
  onChanged()
}
```

删除时提示会一并从所有任务移除(`task_tags` 是 `on delete cascade`):

```tsx
if (!window.confirm(`Delete "${tag.name}"? It will be removed from every task.`)) return
```

- [ ] **Step 2: 加入口**

`Tasks.tsx` 的 Tag 下拉旁,仅 `can('manage_projects')` 时显示一个
`Manage tags` 小按钮。

- [ ] **Step 3: 型别检查与测试**

Run: `npx tsc --noEmit -p tsconfig.app.json && npx vitest run`
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add src/features/tasks/
git commit -m "feat(tasks): add tag rename, recolour and delete"
```

---

## Task 8:Checklist

**Files:**
- Create: `src/features/tasks/ChecklistEditor.tsx`
- Modify: `src/features/tasks/TaskDetailModal.tsx`
- Modify: `src/features/tasks/TaskCard.tsx`

**Interfaces:**
- Consumes: `fetchChecklist` / `addChecklistItem` / `setChecklistDone` / `deleteChecklistItem`(Task 3)、`POSITION_STEP`(Task 2)
- Produces: `<ChecklistEditor taskId onChanged />`

- [ ] **Step 1: 建立 `ChecklistEditor.tsx`**

自行载入自己的 items(不放进 board 查询,避免每张卡都拖一串子项)。新项目的
position 取现有最大值加一步:

```tsx
const nextPosition = items.length
  ? Math.max(...items.map(i => i.position)) + POSITION_STEP
  : POSITION_STEP
```

顶部显示 `3/7` 与一条细进度条,用 `projectProgress(done, total)` 算宽度百分比 ——
同一个函数,不要另写一份除法。

打勾是乐观更新,失败要滚回:

```tsx
async function toggle(item: ChecklistItem) {
  setItems(prev => prev.map(i => i.id === item.id ? { ...i, done: !i.done } : i))
  const res = await setChecklistDone(item.id, !item.done)
  if (!res.ok) {
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, done: item.done } : i))
    setError(res.reason)
    return
  }
  onChanged()
}
```

- [ ] **Step 2: 卡片显示 `3/7`**

footer 的 assignee 之后,`_checklist_total > 0` 才显示:

```tsx
{task._checklist_total > 0 && (
  <span className="flex items-center gap-0.5 text-xs font-medium text-[#8B7355]">
    <CheckSquare size={11} />
    {task._checklist_done}/{task._checklist_total}
  </span>
)}
```

- [ ] **Step 3: 型别检查与测试**

Run: `npx tsc --noEmit -p tsconfig.app.json && npx vitest run`
Expected: 全绿。

- [ ] **Step 4: 浏览器验证**

新增三个子项、勾掉一个,卡片应显示 `1/3`;重整后仍是 `1/3`。

- [ ] **Step 5: Commit**

```bash
git add src/features/tasks/
git commit -m "feat(tasks): add per-task checklists with progress on the card"
```

---

## Task 9:多附件

**Files:**
- Create: `src/features/tasks/AttachmentGallery.tsx`
- Modify: `src/features/tasks/TaskDetailModal.tsx`
- Modify: `src/features/tasks/TaskCard.tsx`

**Interfaces:**
- Consumes: `fetchAttachments` / `uploadAttachment` / `deleteAttachment`(Task 3)
- Produces: `<AttachmentGallery taskId currentStaffId canEdit onChanged />`

- [ ] **Step 1: 建立 `AttachmentGallery.tsx`**

缩图网格 + `+ Add Image` + 点击开 lightbox。删除走 `deleteAttachment(att)`,该函数
会用 `storage_path` 把 bucket 里的档案一并清掉 —— 旧版只清 DB 栏位,档案永远留着。

上传后重新 `fetchAttachments`,并呼叫 `onChanged()` 让板上的附件数更新。

- [ ] **Step 2: 卡片改用附件数**

把旧的 `{task.attachment_url && <Paperclip/>}` 换成:

```tsx
{task._attachment_count > 0 && (
  <span className="flex items-center gap-0.5 text-xs font-medium text-[#8B7355]">
    <Paperclip size={11} />
    {task._attachment_count}
  </span>
)}
```

- [ ] **Step 3: 型别检查与测试**

Run: `npx tsc --noEmit -p tsconfig.app.json && npx vitest run`
Expected: 全绿。

- [ ] **Step 4: 验证档案真的被删掉**

上传两张图,删掉一张,然后确认 bucket 里也不见了:

```bash
set -a && source .env.local && set +a && curl -s -X POST "$VITE_SUPABASE_URL/storage/v1/object/list/task-attachments" -H "apikey: $VITE_SUPABASE_ANON_KEY" -H "Content-Type: application/json" -d '{"prefix":"","limit":100}' | python3 -m json.tool | grep -c name
```

Expected: 数量比删除前少一。

- [ ] **Step 5: Commit**

```bash
git add src/features/tasks/
git commit -m "feat(tasks): support multiple attachments and delete the stored file too"
```

---

## Task 10:栏内手动排序

**Files:**
- Modify: `src/features/tasks/TaskBoard.tsx`
- Modify: `src/features/tasks/Tasks.tsx`

**Interfaces:**
- Consumes: `computeDropPosition` / `needsRebalance` / `rebalance`(Task 2)、`moveTask` / `updateTask`(Task 3)
- Produces: `TaskBoard` 的 `onMove` 改为带落点索引:
  `onMove(taskId: string, status: TaskStatus, beforeTaskId: string | null)`

- [ ] **Step 1: 让栏位辨识落点**

`TaskBoard.tsx` 的每张卡上下各放一条 drop zone(高度 8px,`dragOver` 时高亮),
记录「要插在哪张卡之前」。放开时呼叫
`onMove(draggingId, colKey, beforeTaskId)`,`beforeTaskId` 为 `null` 表示放到栏尾。

- [ ] **Step 2: `Tasks.tsx` 算出新 position**

```tsx
async function handleMove(taskId: string, status: TaskStatus, beforeTaskId: string | null) {
  const before = tasks.find(t => t.id === taskId)
  if (!before) return

  // 目标栏现有的卡(排除被拖的那张),已依 position 排序。
  const column = tasks
    .filter(t => t.status === status && t.id !== taskId)
    .sort((a, b) => a.position - b.position)

  const idx = beforeTaskId ? column.findIndex(t => t.id === beforeTaskId) : column.length
  const prev = idx > 0 ? column[idx - 1].position : undefined
  const next = idx < column.length ? column[idx].position : undefined
  const position = computeDropPosition(prev, next)

  setTasks(p => p.map(t => t.id === taskId ? { ...t, status, position } : t))

  const res = await moveTask(taskId, status, position)
  if (!res.ok) {
    setTasks(p => p.map(t =>
      t.id === taskId ? { ...t, status: before.status, position: before.position } : t,
    ))
    setError(res.reason)
    return
  }

  // 中点反覆二分后 double 精度会开始吃掉间距,整栏重新编号一次。
  const after = [...column.slice(0, idx), { id: taskId, position }, ...column.slice(idx)]
  if (needsRebalance(after.map(t => t.position))) await rebalanceColumn(status)
}

async function rebalanceColumn(status: TaskStatus) {
  const column = tasks
    .filter(t => t.status === status)
    .sort((a, b) => a.position - b.position)
  for (const item of rebalance(column)) {
    await updateTask(item.id, { position: item.position })
  }
  await load()
}
```

- [ ] **Step 3: 把上述逻辑抽成 `useBoardTasks.ts`**

`/team/tasks` 与 `/team/projects/:id` 会用到同一套载入 / 搬移 / 重编号逻辑,
Task 12 直接消费,不要复制贴上。签章:

```ts
export function useBoardTasks(projectId?: string): {
  tasks: Task[]
  loading: boolean
  error: string
  load: () => Promise<void>
  handleMove: (taskId: string, status: TaskStatus, beforeTaskId: string | null) => Promise<void>
}
```

`Tasks.tsx` 改成 `const { tasks, loading, error, load, handleMove } = useBoardTasks()`。

- [ ] **Step 4: 新任务进栏底**

`TaskFormModal` 建立任务时,`position` 取该栏最大值 + `POSITION_STEP`,空栏用
`POSITION_STEP`。

- [ ] **Step 5: 型别检查与测试**

Run: `npx tsc --noEmit -p tsconfig.app.json && npx vitest run`
Expected: 全绿 —— 包含 Task 5 那两个案例(`handleMove` 签章改了,测试呼叫要跟着
改成 `window.__taskBoardMove!('task-1', 'done', null)`)。

- [ ] **Step 6: Commit**

```bash
git add src/features/tasks/
git commit -m "feat(tasks): let cards be reordered inside a column"
```

---

## Task 11:`manage_projects` 能力与 Projects 列表

**Files:**
- Modify: `src/shared/types/index.ts`
- Modify: `src/shared/lib/nav.ts`
- Modify: `src/shared/lib/nav.test.ts`
- Modify: `src/shared/components/Sidebar.tsx`
- Modify: `src/App.tsx`
- Create: `src/features/tasks/Projects.tsx`
- Create: `src/features/tasks/ProjectFormModal.tsx`

**Interfaces:**
- Consumes: `fetchProjects` / `createProject` / `updateProject` / `deleteProject`(Task 3)、`projectProgress`(Task 2)、`useCan()`
- Produces: 路由 `/team/projects`;capability `manage_projects`

- [ ] **Step 1: 写失败的导航测试**

在 `src/shared/lib/nav.test.ts` 追加:

```ts
it('shows Projects to anyone who can see the team area', () => {
  const nav = visibleNav(cap => cap === 'view_team')
  const team = nav.find(e => e.id === 'team')
  expect(team && isGroup(team) ? team.children.map(c => c.id) : []).toContain('team-projects')
})

it('hides Projects from staff, along with the whole team group', () => {
  const nav = visibleNav(() => false)
  expect(nav.find(e => e.id === 'team')).toBeUndefined()
})
```

(若既有档案尚未汇入 `isGroup`,一并加进 import。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/shared/lib/nav.test.ts`
Expected: FAIL — 第一个案例找不到 `team-projects`。

- [ ] **Step 3: 加能力与导航**

`src/shared/types/index.ts` 三处:

```ts
// Capability 联合类型,接在 manage_system_roles 之后
  | 'manage_projects'  // 建立 / 编辑 / 删除 Project;编辑 tag 词表

// CAPABILITIES 阵列
  { key: 'manage_projects',     label: 'Manage Projects' },

// DEFAULT_SYSTEM_ROLE_CAPS:owner / admin / hr / manager / supervisor 各加
    manage_projects: true,
// staff 加
    manage_projects: false,
```

`src/shared/lib/nav.ts`,`team` 群组内接在 `team-tasks` 之后:

```ts
      { id: 'team-projects', label: 'Projects', to: '/team/projects' },
```

不加 `cap` —— 群组本身的 `cap: 'view_team'` 已经挡好了。`team-tasks` **不需要改**:
`activeEntry` 没有 `activePaths` 时回落到 `[leaf.to]` 做前缀比对,
`/team/tasks/archive` 本来就会点亮 Tasks;而 `/team/projects` 虽然也命中 directory
叶子的 `activePaths: ['/team', ...]`,但 `activeEntry` 取最长前缀,不会误点亮。

`src/shared/components/Sidebar.tsx`:import 加 `FolderKanban`,`ICONS` 加一行

```ts
  'team-projects': FolderKanban,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/shared/lib/nav.test.ts`
Expected: PASS。

- [ ] **Step 5: 建立 `ProjectFormModal.tsx`**

栏位:Name(必填)、Description、Color(六个预设色票 + `<input type="color">`)、
Status(四选一,标签取自 `PROJECT_STATUS_LABELS`)、Owner(staff 下拉)、
Start Date、Due Date。存档走 `createProject` / `updateProject` 并检查 `WriteOutcome`。

- [ ] **Step 6: 建立 `Projects.tsx`**

顶部 `Active / On Hold / Completed / All` 切换(预设 Active),右上
`+ New Project`(`can('manage_projects')` 才显示)。一行一个项目:

```tsx
<Link to={`/team/projects/${p.id}`} className="...">
  <span className="w-2.5 h-2.5 rounded-full" style={{ background: p.color }} />
  <span className="font-semibold text-[#3D2B1F] truncate">{p.name}</span>
  {p.owner && <Avatar name={p.owner.name} avatar={p.owner.avatar} size="sm" />}
  <span className="...">{PROJECT_STATUS_LABELS[p.status]}</span>
  <div className="h-1.5 w-24 rounded-full bg-[#EDE5D8] overflow-hidden">
    <div
      className="h-full bg-[#C4813A]"
      style={{ width: `${projectProgress(p.done_tasks, p.total_tasks)}%` }}
    />
  </div>
  <span className="text-xs text-[#8B7355]">{p.done_tasks}/{p.total_tasks}</span>
  {p.overdue_tasks > 0 && (
    <span className="text-xs font-medium text-red-600">⚠ {p.overdue_tasks} overdue</span>
  )}
</Link>
```

载入错误沿用 Task 4 的红色横条 + Retry。

- [ ] **Step 7: 加路由**

`src/App.tsx`,接在 `/team/missions` 那块之后:

```tsx
      <Route
        path="/team/projects"
        element={
          <ProtectedRoute requireCap="view_team">
            <AppLayout><ProjectsPage /></AppLayout>
          </ProtectedRoute>
        }
      />
```

档案顶部 `import ProjectsPage from './features/tasks/Projects'`。

- [ ] **Step 8: 型别检查与全测试**

Run: `npx tsc --noEmit -p tsconfig.app.json && npx vitest run`
Expected: 全绿,含 `Sidebar.test.tsx` 既有断言。

- [ ] **Step 9: 浏览器验证**

侧栏 Team 群组下应出现 Projects;点进去能建立项目;新建的项目显示 `0/0` 与 0%。

- [ ] **Step 10: Commit**

```bash
git add src/shared/types/index.ts src/shared/lib/nav.ts src/shared/lib/nav.test.ts src/shared/components/Sidebar.tsx src/App.tsx src/features/tasks/
git commit -m "feat(projects): add manage_projects capability and the project list page"
```

---

## Task 12:Project 详情页

**Files:**
- Create: `src/features/tasks/ProjectDetail.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `fetchProject`(Task 3)、`useBoardTasks(projectId)`(Task 10)、`deriveParticipants` / `projectProgress`(Task 2)、`TaskBoard`(Task 4)
- Produces: 路由 `/team/projects/:id`

- [ ] **Step 1: 建立 `ProjectDetail.tsx`**

上半:名称 + 色点、描述、owner、start/due date、status pill、进度条 + `8/15` +
逾期数、参与者头像组。参与者由任务推导,不查另一张表:

```tsx
const participantIds = deriveParticipants(tasks, project.owner_id)
const participants = allStaff.filter(s => participantIds.includes(s.id))
```

右上 `Edit`(`can('manage_projects')`)开 `ProjectFormModal`。

下半直接重用 `TaskBoard`,资料来自 `fetchBoardTasks({ projectId: id })`。搬移与新增
的处理器直接用 Task 10 建立的 `useBoardTasks(id)`:

```tsx
const { tasks, loading, error, load, handleMove } = useBoardTasks(id)
```

- [ ] **Step 2: 加路由**

```tsx
      <Route
        path="/team/projects/:id"
        element={
          <ProtectedRoute requireCap="view_team">
            <AppLayout><ProjectDetailPage /></AppLayout>
          </ProtectedRoute>
        }
      />
```

- [ ] **Step 3: 型别检查与测试**

Run: `npx tsc --noEmit -p tsconfig.app.json && npx vitest run`
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add src/features/tasks/ src/App.tsx
git commit -m "feat(projects): add the project detail page with its own board"
```

---

## Task 13:把 Task 接上 Project

**Files:**
- Modify: `src/features/tasks/TaskFormModal.tsx`
- Modify: `src/features/tasks/TaskDetailModal.tsx`
- Modify: `src/features/tasks/TaskCard.tsx`
- Modify: `src/features/tasks/Tasks.tsx`

**Interfaces:**
- Consumes: `fetchProjects`(Task 3)
- Produces: 无新介面

- [ ] **Step 1: 表单加 Project 下拉**

`TaskFormModal` 与 `TaskDetailModal` 的编辑态各加一个:

```tsx
<select value={form.project_id} onChange={set('project_id')} className={inputCls}>
  <option value="">No project</option>
  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
</select>
```

在 `/team/projects/:id` 里开的新任务预设带入该项目。

- [ ] **Step 2: 卡片显示 project**

第一列 priority / department 之后:

```tsx
{task.project && (
  <span
    className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-[#F5EDE0] text-[#8B6344] max-w-[120px]"
  >
    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: task.project.color }} />
    <span className="truncate">{task.project.name}</span>
  </span>
)}
```

在 `/team/projects/:id` 的板上**不显示**这个标签(全部都是同一个项目,是噪音)——
`TaskBoard` 加一个 `showProject?: boolean` prop,专属板传 `false`。

- [ ] **Step 3: 筛选列加 Project 下拉**

`filteredTasks` 补一句:

```tsx
if (filterProject && t.project_id !== filterProject) return false
```

- [ ] **Step 4: 型别检查与测试**

Run: `npx tsc --noEmit -p tsconfig.app.json && npx vitest run`
Expected: 全绿。

- [ ] **Step 5: 浏览器验证**

在总板建一个任务并指定项目;项目详情页的进度条应从 `0/0` 变 `0/1`;总板卡片上
应出现项目标签,项目板上不应出现。

- [ ] **Step 6: Commit**

```bash
git add src/features/tasks/
git commit -m "feat(tasks): assign tasks to projects and filter the board by project"
```

---

## Task 14:Done 时间窗与 Archive 页

**Files:**
- Create: `src/features/tasks/TasksArchive.tsx`
- Modify: `src/features/tasks/TaskBoard.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `fetchArchivedTasks` / `doneWindowFilter`(Task 3,`fetchBoardTasks` 已内建时间窗)
- Produces: 路由 `/team/tasks/archive`

- [ ] **Step 1: Done 栏底加连结**

`TaskBoard.tsx`,`colKey === 'done'` 且 `showArchiveLink` 时,栏底显示:

```tsx
<Link
  to="/team/tasks/archive"
  className="mt-2 text-center text-xs font-semibold text-[#8B6344] hover:underline"
>
  View archive →
</Link>
```

栏首的空状态文案改成 `Nothing completed in the last 14 days`。

- [ ] **Step 2: 建立 `TasksArchive.tsx`**

一个简单列表(非看板):标题、项目、assignee、完成日期,顶部一个搜寻框。资料来自
`fetchArchivedTasks()`,错误横条同前。

- [ ] **Step 3: 加路由**

```tsx
      <Route
        path="/team/tasks/archive"
        element={
          <ProtectedRoute requireCap="view_team">
            <AppLayout><TasksArchivePage /></AppLayout>
          </ProtectedRoute>
        }
      />
```

**必须放在 `/team/tasks` 那条之后**,并确认 `/team/tasks` 没有用 `path="/team/tasks/*"`
之类的通配写法把它吃掉。

- [ ] **Step 4: 验证时间窗真的在 server 端**

开 DevTools Network,重整 `/team/tasks`,找 `tasks?select=` 那笔请求,query string
里应含 `or=(status.neq.done,completed_at.gte.2026-...)`。

- [ ] **Step 5: 型别检查与测试**

Run: `npx tsc --noEmit -p tsconfig.app.json && npx vitest run`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/features/tasks/ src/App.tsx
git commit -m "feat(tasks): cap the Done column at 14 days and add an archive page"
```

---

## Task 15:Realtime 同步

**Files:**
- Modify: `src/features/tasks/Tasks.tsx`(或 Task 12 抽出的 `useBoardTasks`)

**Interfaces:**
- Consumes: `supabase.channel`、Task 3 的 `fetchBoardTasks`
- Produces: 无新介面

- [ ] **Step 1: 订阅 `tasks` 变更**

```tsx
useEffect(() => {
  const channel = supabase
    .channel('tasks-board')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => {
      // 事件本身不带 join 进来的 assignee / project / tags,所以重拉一次
      // 而不是就地打补丁 —— 板子最多几十张卡,一次查询比维护补丁逻辑便宜。
      load()
    })
    .subscribe()
  return () => { supabase.removeChannel(channel) }
}, [])
```

- [ ] **Step 2: 验证**

同时开两个浏览器视窗(或一个无痕),在 A 拖一张卡换栏,B 应在一两秒内跟着动,
不需要重整。

- [ ] **Step 3: 确认离开页面会退订**

在 DevTools Console 观察:切到别的页面再回来,不应累积多条 channel。

- [ ] **Step 4: 型别检查与测试**

Run: `npx tsc --noEmit -p tsconfig.app.json && npx vitest run`
Expected: 全绿。Task 5 的测试已经 mock 掉 `supabase.channel`,不受影响。

- [ ] **Step 5: Commit**

```bash
git add src/features/tasks/
git commit -m "feat(tasks): keep the board in sync across sessions via realtime"
```

---

## Task 16:更新专案文件

**Files:**
- Modify: `PROJECT_NOTES.md`

- [ ] **Step 1: 更正存取说明**

§2 的「**Everyone (logged in):** `/profile`, `/tasks`, `/hr/*`」把 `/tasks` 拿掉,
另起一句说明 Tasks 与 Projects 位于 `/team/*` 之下、需 `view_team`,仅供
management 使用。

- [ ] **Step 2: 更新功能清单**

§3 的「**Task management (Kanban)** (`/tasks`)」改成:

```markdown
- **Tasks & Projects** (`/team/tasks`, `/team/projects`) — Kanban task board with
  free-form tags, checklists, multiple attachments and manual ordering; projects
  group tasks and track progress. Management only (`view_team`).
```

- [ ] **Step 3: 补表清单**

§4 的表格加七列:`projects`、`tasks`、`tags`、`task_tags`、
`task_checklist_items`、`task_attachments`、`task_comments`,并注明 migration 档名。

- [ ] **Step 4: Commit**

```bash
git add PROJECT_NOTES.md
git commit -m "docs: record the tasks & projects module and its tables"
```

---

## 收尾检查

- [ ] `npx tsc --noEmit -p tsconfig.app.json` 无输出
- [ ] `npx vitest run` 全绿
- [ ] `npm run build` 成功
- [ ] `wc -l src/features/tasks/*.tsx` 每个档案都在 250 行以内
- [ ] `grep -rn "supabase.from" src/features/tasks/*.tsx` 只在 `Tasks.tsx` 命中 staff 查询
- [ ] `grep -rn "TASK_DEPTS" src/` 无结果(写死的部门清单已移除)
- [ ] 浏览器走一遍:建项目 → 在项目下建任务 → 加 tag → 加子项 → 上传两张图 →
      拖动排序 → 标记完成 → 确认项目进度条更新 → 开 Archive 页看得到
- [ ] `git log --oneline` 应有 15 个 commit,每个都对应一个 task
