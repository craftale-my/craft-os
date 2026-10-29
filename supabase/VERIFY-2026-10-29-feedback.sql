-- ============================================================================
-- VERIFY feedback (2026-10-29). 整段在一个事务里跑,最后 rollback,不留数据。
-- 任一检查失败都会 raise 'VERIFY FAIL: …',整个请求报错。
-- 需要:1 个在职 owner + 2 个在职 staff(dev 和 prod 都满足)。
-- ============================================================================
begin;

create temp table _v on commit drop as
select
  (select id from staff where system_role = 'owner' and is_active order by created_at limit 1)          as owner_id,
  (select id from staff where system_role = 'staff' and is_active order by created_at limit 1)          as staff_id,
  (select id from staff where system_role = 'staff' and is_active order by created_at offset 1 limit 1) as other_id;

do $$ begin
  if (select owner_id is null or staff_id is null or other_id is null from _v) then
    raise exception 'VERIFY SETUP: need 1 active owner and 2 active staff';
  end if;
end $$;

-- ---- 1. 以 staff 身份提交:两条实名 + 一条匿名 ---------------------------------
select set_config('request.jwt.claims', json_build_object('sub', staff_id, 'role', 'authenticated')::text, true) from _v;
set local role authenticated;

select submit_feedback('11111111-1111-4111-8111-111111111111', 'product_quality', 'Latte too sour today',
  'Cheras (Taman Connaught)', '/profile', '{"userAgent":"verify","appVersion":"v"}', '{}', false);
select submit_feedback('22222222-2222-4222-8222-222222222222', 'system', 'Leave page crashed',
  null, '/hr/leave', '{"appVersion":"v"}', '{}', false);
select submit_feedback('33333333-3333-4333-8333-333333333333', 'workplace', 'Anonymous complaint',
  null, '/profile', '{"userAgent":"verify","appVersion":"v","errorMessage":"x"}', '{}', true);

-- ---- 2. 非 Workplace 匿名被拒 -------------------------------------------------
do $$ begin
  begin
    perform submit_feedback('44444444-4444-4444-8444-444444444444', 'system', 'x', null, null, '{}', '{}', true);
    raise exception 'VERIFY FAIL: anonymous system feedback was accepted';
  exception when others then
    if sqlerrm = 'Only Workplace feedback can be anonymous.' then null;
    elsif sqlerrm like 'VERIFY FAIL%' then raise;
    else raise exception 'VERIFY FAIL: check 2 got unexpected error: %', sqlerrm;
    end if;
  end;
end $$;

-- ---- 3. staff 只看得到自己的两条实名 ------------------------------------------
do $$ begin
  if (select count(*) from feedback where id in (
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333')) <> 2 then
    raise exception 'VERIFY FAIL: staff should see exactly own 2 named rows';
  end if;
end $$;

-- ---- 4. staff 不能回复 --------------------------------------------------------
do $$ begin
  begin
    perform reply_feedback('11111111-1111-4111-8111-111111111111', 'resolved', 'hi');
    raise exception 'VERIFY FAIL: staff could reply';
  exception when others then
    if sqlerrm = 'Only the owner can reply to feedback.' then null;
    elsif sqlerrm like 'VERIFY FAIL%' then raise;
    else raise exception 'VERIFY FAIL: check 4 got unexpected error: %', sqlerrm;
    end if;
  end;
end $$;

-- ---- 5. 直接 insert 被 RLS 挡住 ----------------------------------------------
do $$ begin
  begin
    insert into feedback (id, category, message) values ('55555555-5555-4555-8555-555555555555', 'system', 'direct');
    raise exception 'VERIFY FAIL: direct insert allowed';
  exception when others then
    if sqlstate = '42501' then null;
    elsif sqlerrm like 'VERIFY FAIL%' then raise;
    else raise exception 'VERIFY FAIL: check 5 got unexpected error % (%)', sqlerrm, sqlstate;
    end if;
  end;
end $$;

-- ---- 5b. 孤儿照片:上传者自己看得到,别的 staff 看不到 ------------------------
-- 删除那半(storage.protect_delete 禁止 SQL 直接 delete storage.objects)改在浏览器测试里覆盖;
-- 这里只验证 select policy 的 owner_id 分支(storage remove 要先 select 才能 delete)。
insert into storage.objects (bucket_id, name, owner_id)
values ('feedback-photos', '66666666-6666-4666-8666-666666666666/1.jpg', auth.uid()::text);

do $$ begin
  if (select count(*) from storage.objects
       where bucket_id = 'feedback-photos'
         and name = '66666666-6666-4666-8666-666666666666/1.jpg') <> 1 then
    raise exception 'VERIFY FAIL: uploader cannot see own orphan photo';
  end if;
end $$;

-- ---- 6. 另一个 staff 一条都看不到 ---------------------------------------------
reset role;
select set_config('request.jwt.claims', json_build_object('sub', other_id, 'role', 'authenticated')::text, true) from _v;
set local role authenticated;

do $$ begin
  if (select count(*) from feedback where id in (
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333')) <> 0 then
    raise exception 'VERIFY FAIL: other staff can see feedback';
  end if;
  if exists (select 1 from storage.objects
              where bucket_id = 'feedback-photos'
                and name = '66666666-6666-4666-8666-666666666666/1.jpg') then
    raise exception 'VERIFY FAIL: other staff can see someone else''s orphan photo';
  end if;
end $$;

-- ---- 7. owner 看得到全部三条;匿名那条已被剥干净 -------------------------------
reset role;
select set_config('request.jwt.claims', json_build_object('sub', owner_id, 'role', 'authenticated')::text, true) from _v;
set local role authenticated;

do $$
declare r feedback%rowtype;
begin
  if (select count(*) from feedback where id in (
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333')) <> 3 then
    raise exception 'VERIFY FAIL: owner should see all 3';
  end if;
  select * into r from feedback where id = '33333333-3333-4333-8333-333333333333';
  if r.submitted_by is not null then raise exception 'VERIFY FAIL: anonymous row kept submitted_by'; end if;
  if r.context <> '{"appVersion":"v"}'::jsonb then raise exception 'VERIFY FAIL: anonymous context not stripped: %', r.context; end if;
  if cardinality(r.photo_paths) <> 0 then raise exception 'VERIFY FAIL: anonymous row has photos'; end if;
end $$;

-- ---- 8. owner 回复实名和匿名各一条 --------------------------------------------
select reply_feedback('11111111-1111-4111-8111-111111111111', 'resolved', 'Thanks, fixed the grinder');
select reply_feedback('33333333-3333-4333-8333-333333333333', 'in_review', 'Looking into it');

-- ---- 9. 通知与存储(以 postgres 身份查,绕过 RLS) -------------------------------
reset role;

do $$
declare v record;
begin
  select * into v from _v;

  if (select count(*) from notifications
       where recipient_id = v.owner_id and event_type = 'feedback_submitted'
         and link in ('/feedback?tab=inbox&id=11111111-1111-4111-8111-111111111111',
                      '/feedback?tab=inbox&id=22222222-2222-4222-8222-222222222222',
                      '/feedback?tab=inbox&id=33333333-3333-4333-8333-333333333333')) <> 3 then
    raise exception 'VERIFY FAIL: owner should get 3 feedback_submitted notifications (same staff, same day)';
  end if;

  if (select count(*) from notifications
       where recipient_id = v.staff_id and event_type = 'feedback_updated'
         and link = '/feedback?id=11111111-1111-4111-8111-111111111111') <> 1 then
    raise exception 'VERIFY FAIL: named submitter should get 1 feedback_updated notification';
  end if;

  if exists (select 1 from notifications
              where event_type = 'feedback_updated'
                and link = '/feedback?id=33333333-3333-4333-8333-333333333333') then
    raise exception 'VERIFY FAIL: anonymous feedback produced a reply notification';
  end if;

  if (select status <> 'resolved' or owner_reply <> 'Thanks, fixed the grinder' or replied_at is null
        from feedback where id = '11111111-1111-4111-8111-111111111111') then
    raise exception 'VERIFY FAIL: reply not saved';
  end if;

  if (select public from storage.buckets where id = 'feedback-photos') is distinct from false then
    raise exception 'VERIFY FAIL: feedback-photos bucket missing or public';
  end if;

  if (select count(*) from pg_policies
       where schemaname = 'storage' and tablename = 'objects'
         and policyname in ('feedback_photos_insert', 'feedback_photos_select', 'feedback_photos_delete_orphan')) <> 3 then
    raise exception 'VERIFY FAIL: feedback storage policies missing';
  end if;
end $$;

rollback;

select 'VERIFY PASSED' as result;
