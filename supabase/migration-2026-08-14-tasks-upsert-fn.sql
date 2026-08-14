-- ============================================================================
-- Craft OS — Tasks:标签 upsert 改走 Postgres function (2026-08-14)
--
-- 在 Supabase SQL editor 里整份执行。幂等 — 可重复运行。
-- 前置:migration-2026-08-14-tasks-projects.sql(需要 tags 表与 has_task_cap)。
--
-- 为什么需要这支 function:
--   supabase-js 的 .upsert() 只能送出
--     `on conflict (<target>) do update set <每个给定栏位> = excluded.<栏位>`,
--   它没有任何语法能表达「冲突时保留既有值」。所以旧的
--     .upsert({ slug, name, created_by }, { onConflict: 'slug' })
--   在撞到既有 slug 时,会把那一列的 name 换成后来者敲的大小写、created_by
--   换成后来者本人 —— 结果是 A 建的 `Urgent`,只因为 B 在别的任务上打了
--   `urgent`,全板的 pill 就无声变成 `urgent`,溯源栏位也一并被改掉。
--   tasks 那边的 tasks_touch() 已经把 created_by 锁死正是为了挡这类改写,
--   tags 不该是例外。
-- ============================================================================

-- ── upsert_tag ──────────────────────────────────────────────────────────────
-- `do update set name = tags.name` 是刻意写回既有值的 no-op:ON CONFLICT DO
-- NOTHING 不会回传任何列,而呼叫端需要拿到那一列的 id 才能挂上 task_tags。
-- 写回自己的旧值,既让 RETURNING 有列可回,又保证 name / created_by 归先写入者。
-- 整段是单一 statement,不存在「先 select 再 insert」那种两个 client 同时看到
-- 空结果的空窗。
--
-- security definer 的理由与 has_task_cap 同款:函式必须绕过 tags 的 RLS 才能走
-- DO UPDATE 那条路 —— tags_update policy 只放行 manage_projects,但建标签这件事
-- 是 view_team 就能做的(见 tags_insert)。绕过之后授权检查得自己补回来,
-- 所以进门先问 has_task_cap('view_team'),语义对齐 tags_insert 的 with check。
-- 注意 created_by 一样不绑 auth.uid(),与 tags_insert 现况一致(该 policy 本来
-- 就没有检查这栏);这支函式没有放宽任何既有权限。
create or replace function upsert_tag(p_slug text, p_name text, p_created_by uuid)
returns setof tags
language plpgsql security definer as $$
begin
  if not has_task_cap('view_team') then
    raise exception 'You do not have permission to create tags.' using errcode = '42501';
  end if;

  return query
    with upserted as (
      insert into tags (slug, name, created_by)
      values (p_slug, p_name, p_created_by)
      on conflict (slug) do update set name = tags.name
      returning *
    )
    select * from upserted;
end $$;

-- PostgREST 的 schema cache 不重载就看不到新函式,呼叫端会拿到 PGRST202。
-- Supabase 平时靠 event trigger 自动重载,这里显式补一次,手动跑迁移时才不用等。
notify pgrst, 'reload schema';
