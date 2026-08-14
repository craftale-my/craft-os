-- ============================================================================
-- Craft OS — Tasks:checklist 子项加负责人 (2026-08-14)
--
-- 在 Supabase SQL editor 里整份执行。幂等 — 可重复运行。
-- 前置:migration-2026-08-14-tasks-projects.sql(需要 task_checklist_items 与 staff)。
--
-- 一个任务由多人分工时,「谁负责哪一条」原本只能写在子项文字里。加一栏
-- assigned_to 让它成为结构化资料,卡片与筛选才有得依据。
-- on delete set null:员工离职删档不该连带删掉工作纪录——那条子项本身还在,
-- 只是没人认领,跟 task_attachments.uploaded_by / tasks.assigned_to 同一个规则。
--
-- 不另开 RLS policy:task_checklist_all 是 for all,已经涵盖这一栏的读写,
-- 而 assigned_to 不是授权栏位(挂谁的名字不改变谁能改这一列)。
-- ============================================================================
alter table task_checklist_items
  add column if not exists assigned_to uuid references staff(id) on delete set null;

-- 前端会以「某人名下的子项」反查(ChecklistEditor 之后的筛选),而且这一栏
-- 大多是 null,B-tree 索引在这种稀疏分布上仍然是最省事的选择。
create index if not exists task_checklist_assignee_idx
  on task_checklist_items (assigned_to);

-- PostgREST 的 schema cache 不重载就看不到新栏位,前端会拿到
-- "column task_checklist_items.assigned_to does not exist";
-- 内嵌 assignee:staff!task_checklist_items_assigned_to_fkey(...) 也会一并失败。
notify pgrst, 'reload schema';
