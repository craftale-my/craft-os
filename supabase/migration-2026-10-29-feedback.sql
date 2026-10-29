-- ============================================================================
-- Feedback (2026-10-29). Idempotent.
-- Spec: docs/superpowers/specs/2026-10-29-feedback-design.md
--
-- 写入只走两个 security definer 函数:表上刻意不建 insert/update/delete policy。
-- 匿名(只限 workplace)时由服务器丢掉提交人、照片和 userAgent,
-- 而不是信任客户端传来的值。
-- ============================================================================

create table if not exists feedback (
  id            uuid primary key,              -- 客户端生成,照片先按 id 上传
  category      text not null,
  message       text not null,
  branch        text,
  page_path     text,
  context       jsonb not null default '{}'::jsonb,
  photo_paths   text[] not null default '{}',
  is_anonymous  boolean not null default false,
  submitted_by  uuid references staff(id) on delete set null,
  status        text not null default 'new',
  owner_reply   text,
  replied_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table feedback drop constraint if exists feedback_category_check;
alter table feedback add  constraint feedback_category_check
  check (category in ('product_quality', 'product_idea', 'system', 'workplace'));

alter table feedback drop constraint if exists feedback_message_check;
alter table feedback add  constraint feedback_message_check
  check (char_length(btrim(message)) between 1 and 2000);

alter table feedback drop constraint if exists feedback_status_check;
alter table feedback add  constraint feedback_status_check
  check (status in ('new', 'in_review', 'resolved'));

alter table feedback drop constraint if exists feedback_reply_check;
alter table feedback add  constraint feedback_reply_check
  check (owner_reply is null or char_length(owner_reply) <= 2000);

alter table feedback drop constraint if exists feedback_photos_check;
alter table feedback add  constraint feedback_photos_check
  check (cardinality(photo_paths) <= 3);

alter table feedback drop constraint if exists feedback_anonymous_only_workplace;
alter table feedback add  constraint feedback_anonymous_only_workplace
  check (not is_anonymous or category = 'workplace');

alter table feedback drop constraint if exists feedback_anonymous_no_submitter;
alter table feedback add  constraint feedback_anonymous_no_submitter
  check (not is_anonymous or submitted_by is null);

alter table feedback drop constraint if exists feedback_anonymous_no_photos;
alter table feedback add  constraint feedback_anonymous_no_photos
  check (not is_anonymous or cardinality(photo_paths) = 0);

create index if not exists feedback_status_idx    on feedback (status, created_at desc);
create index if not exists feedback_submitter_idx on feedback (submitted_by, created_at desc);

alter table feedback enable row level security;

drop policy if exists "feedback_select" on feedback;
create policy "feedback_select" on feedback for select
  using (submitted_by = auth.uid() or current_is_owner());

-- ---------------------------------------------------------------------------
-- submit_feedback
-- ---------------------------------------------------------------------------
create or replace function submit_feedback(
  p_id          uuid,
  p_category    text,
  p_message     text,
  p_branch      text,
  p_page_path   text,
  p_context     jsonb,
  p_photo_paths text[],
  p_anonymous   boolean
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid    := auth.uid();
  v_anon  boolean := coalesce(p_anonymous, false);
  v_label text;
begin
  if v_uid is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if not exists (select 1 from staff where id = v_uid and is_active) then
    raise exception 'Only active staff can send feedback.' using errcode = '42501';
  end if;
  if v_anon and p_category is distinct from 'workplace' then
    raise exception 'Only Workplace feedback can be anonymous.' using errcode = '22023';
  end if;
  -- 照片必须放在这条反馈自己的文件夹下,不能指向别人的
  if exists (select 1 from unnest(coalesce(p_photo_paths, '{}')) as p(path)
              where p.path not like p_id::text || '/%') then
    raise exception 'Invalid photo path.' using errcode = '22023';
  end if;

  insert into feedback (id, category, message, branch, page_path, context, photo_paths, is_anonymous, submitted_by)
  values (
    p_id,
    p_category,
    btrim(p_message),
    nullif(btrim(coalesce(p_branch, '')), ''),
    p_page_path,
    case when v_anon
      then jsonb_strip_nulls(jsonb_build_object('appVersion', p_context -> 'appVersion'))
      else coalesce(p_context, '{}'::jsonb) end,
    case when v_anon then '{}'::text[] else coalesce(p_photo_paths, '{}') end,
    v_anon,
    case when v_anon then null else v_uid end
  );

  v_label := case p_category
    when 'product_quality' then 'Product Quality'
    when 'product_idea'    then 'Product Idea'
    when 'system'          then 'App / System Issue'
    else                        'Workplace / Complaint'
  end;

  -- subject_staff_id / subject_date 留 null:notifications 的 unique 键里 NULL 互不相等,
  -- 同一人同一天的多条反馈不会互相顶掉。
  insert into notifications (recipient_id, event_type, title, body, link)
  select s.id,
         'feedback_submitted',
         'New feedback: ' || v_label,
         left(btrim(p_message), 120),
         '/feedback?tab=inbox&id=' || p_id::text
    from staff s
   where s.system_role = 'owner'
     and s.is_active
     and (v_anon or s.id <> v_uid);   -- owner 自己实名提交时不通知自己

  return p_id;
end;
$$;

revoke execute on function submit_feedback(uuid, text, text, text, text, jsonb, text[], boolean) from public;
revoke execute on function submit_feedback(uuid, text, text, text, text, jsonb, text[], boolean) from anon;
grant  execute on function submit_feedback(uuid, text, text, text, text, jsonb, text[], boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- reply_feedback
-- ---------------------------------------------------------------------------
create or replace function reply_feedback(p_id uuid, p_status text, p_reply text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row           feedback%rowtype;
  v_reply         text := nullif(btrim(coalesce(p_reply, '')), '');
  v_reply_changed boolean;
  v_status_label  text;
begin
  if not current_is_owner() then
    raise exception 'Only the owner can reply to feedback.' using errcode = '42501';
  end if;

  select * into v_row from feedback where id = p_id for update;
  if not found then
    raise exception 'Feedback not found.' using errcode = 'P0002';
  end if;

  -- 空回复 = 不动原回复(只改状态)
  v_reply_changed := v_reply is not null and v_reply is distinct from v_row.owner_reply;

  update feedback set
    status      = p_status,
    owner_reply = case when v_reply_changed then v_reply else owner_reply end,
    replied_at  = case when v_reply_changed then now()   else replied_at  end,
    updated_at  = now()
  where id = p_id;

  if v_row.submitted_by is not null and (v_reply_changed or p_status <> v_row.status) then
    v_status_label := case p_status when 'new' then 'New' when 'in_review' then 'In review' else 'Resolved' end;
    insert into notifications (recipient_id, event_type, title, body, link)
    values (
      v_row.submitted_by,
      'feedback_updated',
      'Your feedback was updated',
      v_status_label || case when v_reply_changed then ' — ' || left(v_reply, 120) else '' end,
      '/feedback?id=' || p_id::text
    );
  end if;
end;
$$;

revoke execute on function reply_feedback(uuid, text, text) from public;
revoke execute on function reply_feedback(uuid, text, text) from anon;
grant  execute on function reply_feedback(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Photos: private bucket, signed URLs only
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('feedback-photos', 'feedback-photos', false, 5242880, array['image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 上传:路径第一段必须是 uuid。这里不查「那条反馈是否已存在」:policy 里的子查询
-- 受调用者自己的 RLS 限制,看不到别人的反馈,查了也拦不住。往别人的文件夹里多塞
-- 一张图也无害 —— photo_paths 在提交那一刻就定死了,多出来的文件永远不会被引用。
drop policy if exists "feedback_photos_insert" on storage.objects;
create policy "feedback_photos_insert" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'feedback-photos'
    and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );

drop policy if exists "feedback_photos_select" on storage.objects;
create policy "feedback_photos_select" on storage.objects for select to authenticated
  using (
    bucket_id = 'feedback-photos'
    and (
      public.current_is_owner()
      -- 上传者永远看得到自己传的文件。删除(storage remove)要先 select 再 delete,
      -- 孤儿照片没有对应的 feedback 行,没有这一条的话清理会静默删 0 行。
      or owner_id = auth.uid()::text
      or exists (select 1 from public.feedback f
                  where f.id::text = (storage.foldername(name))[1]
                    and f.submitted_by = auth.uid())
    )
  );

-- 提交失败时的清理:只能删自己传的、还没挂到任何反馈上的照片
drop policy if exists "feedback_photos_delete_orphan" on storage.objects;
create policy "feedback_photos_delete_orphan" on storage.objects for delete to authenticated
  using (
    bucket_id = 'feedback-photos'
    and owner_id = auth.uid()::text
    and not exists (select 1 from public.feedback f where f.id::text = (storage.foldername(name))[1])
  );
