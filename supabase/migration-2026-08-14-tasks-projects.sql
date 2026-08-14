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
  if TG_OP = 'INSERT' then
    -- 批量汇入 / 后台工具可能直接以 status = 'done' 插入;这里若不补设 completed_at,
    -- 该笔会同时被看板(status<>done)和 14 天归档窗口(completed_at 过滤)排除,永远消失。
    if new.status = 'done' then
      new.completed_at := now();
    else
      new.completed_at := null;
    end if;
  elsif TG_OP = 'UPDATE' then
    if new.status = 'done' and old.status is distinct from 'done' then
      new.completed_at := now();
    elsif new.status <> 'done' then
      new.completed_at := null;
    end if;
    -- created_by 是建立者的溯源栏位;tasks_update policy 刻意宽松、未限制此栏,
    -- 若不锁住,任何人可先把 created_by 改成自己,再用 tasks_delete 的「建立者可删」规则删掉别人的任务。
    new.created_by := old.created_by;
  end if;
  return new;
end $$;

drop trigger if exists tasks_touch_trg on tasks;
create trigger tasks_touch_trg before insert or update on tasks
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
