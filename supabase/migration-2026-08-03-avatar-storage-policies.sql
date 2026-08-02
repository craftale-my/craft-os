-- staff-avatars 存储策略
--
-- 背景:这些策略一直没配,于是 StaffProfile 的头像上传在 RLS 被拒后会退回用
-- service_role 客户端重试。那把 key 通过 VITE_ 前缀被内联进了前端构建产物,
-- 等于对外公开一把绕过全部 RLS 的钥匙。策略补齐后兜底已移除。
--
-- 路径约定:`<staff_id>/<timestamp>.<ext>`,与 StaffProfile 的 filePath 一致。
-- storage.foldername(name) 取路径的目录段,[1] 即首段 staff id。
--
-- 应用方式:在 Supabase SQL Editor 里执行,或 supabase db push。

-- bucket 设为 public:头像 URL 直接嵌在 <img> 里,与现有 getPublicUrl 用法一致。
insert into storage.buckets (id, name, public)
values ('staff-avatars', 'staff-avatars', true)
on conflict (id) do update set public = true;

-- 读:公开。头像会出现在名册、排班表、任务列表等处,且 URL 已是 public。
drop policy if exists "avatars_public_read" on storage.objects;
create policy "avatars_public_read" on storage.objects
  for select
  using (bucket_id = 'staff-avatars');

-- 写:只能写自己的目录。upsert 需要 insert 与 update 两条。
drop policy if exists "avatars_own_insert" on storage.objects;
create policy "avatars_own_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'staff-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "avatars_own_update" on storage.objects;
create policy "avatars_own_update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'staff-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'staff-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "avatars_own_delete" on storage.objects;
create policy "avatars_own_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'staff-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- 注意:经理在 StaffProfile 里替别人改头像会被这套策略拒绝。改造前那条路径
-- 走的是 service_role 兜底,现在没有了。若确实需要,应新增一条以
-- can_review_staff() 或 manage_staff 为谓词的策略,而不是把 key 放回前端。
