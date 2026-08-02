-- staff-avatars 策略清理(撤销本文件此前的版本)
--
-- 起因:移除 StaffProfile 里那段用 service_role 客户端的头像上传兜底时,我以为
-- 兜底存在是因为策略缺失,于是补了一套。查过 pg_policies 才发现策略一直都在,
-- 而且比我写的更完整:
--
--   staff_avatars_write / staff_avatars_update
--     bucket_id = 'staff-avatars' AND (
--       (storage.foldername(name))[1] = auth.uid()::text     -- 写自己的
--       OR current_rank() = 'manager'
--       OR current_system_role() IN ('hr','supervisor','manager','admin','owner')
--     )
--   staff_avatars_read  -- 公开读
--
-- RLS 策略之间是 OR 关系,所以我那三条"更严格的重复"不会收紧任何东西,只会让
-- 策略表更难读。删掉它们,恢复原本就正确的那套。
--
-- 保留 avatars_own_delete:它是这个 bucket 上唯一的 DELETE 策略。app 目前不删
-- 头像(上传走带时间戳的新路径,旧文件累积),留着是为了将来能做清理。
--
-- 教训:改 RLS 之前先 select * from pg_policies —— 假设表是白纸,加出来的东西
-- 要么无效,要么把既有的语义搅浑。

drop policy if exists "avatars_public_read" on storage.objects;
drop policy if exists "avatars_own_insert"  on storage.objects;
drop policy if exists "avatars_own_update"  on storage.objects;
