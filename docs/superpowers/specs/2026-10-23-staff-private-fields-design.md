# 员工敏感资料拆表(第二层 PDPA 修复)设计

Status: Approved
Date: 2026-10-23

> 沿用同目录既有体例:正文中文,所有 UI 文案、字段名、错误提示一律英文。

## 背景

2026-10-23 先修了第一层:`staff` / `missions` / `skill_ratings` 三条 SELECT policy 原本是
`using (true)` 不带角色,连 `anon` 都放行,网站 bundle 里的 publishable key 就能读全部 61 位员工。
已改成 `to authenticated`(main `27d03c8`,prod 已执行并验证)。

剩下的第二层:`staff_select` 对已登录用户仍是 `using (true)`,所以**任何登录的员工(包括 trainee)
都能读到每位同事的身份证、地址、生日、电话**,以及管理者写的私人备注 `manager_notes`。
这在马来西亚个人资料保护法(PDPA)下是风险。

### 现状核实

- **五个栏位都在 `staff` 表上**:`ic_number text`、`address text`、`date_of_birth date`、
  `contact_number text`(`schema.sql:174-178`,onboarding 一批加入)、`manager_notes text`(`schema.sql:193`)。
- **读取**:全 app 有 12 处 `from('staff').select('*')`(AuthContext、Settings ×3、Schedule、useTeamData、
  HrLeave、HrSalary、HrAttendance、Directory、StaffProfile ×2、ProbationReview ×2),另有
  `mission_completions` 嵌入 `staff!…_fkey(*)`。真正**显示**这几栏的只有:
  - `StaffProfile.tsx` Personal 区块(`:1354-1384`,查看 + 编辑)
  - `StaffProfile.tsx` `ManagerNotesCard`(`:1565`),外层门槛是 `isManager && !isSelf`,
    而 `isManager = currentStaff?.rank === 'manager'`(`:67`)—— 只看 rank,不看 system_role。
  - `Onboarding.tsx`(`:76-119` 读写,`:543` 确认页)
- **写入**:
  - `Onboarding.tsx:109` 一次 `update` 写入四项 + 其他 onboarding 栏位
  - `StaffProfile.tsx:1218` 编辑个人资料写 `contact_number` / `address`(IC、生日标 "Cannot be changed")
  - `StaffProfile.tsx:1587` 写 `manager_notes`
  - Edge Function `provision-staff/index.ts:263` 新增员工时 upsert `contact_number: phone`(service role,绕过 RLS)
- **`staff_update` policy** 允许本人更新自己整行;越权栏位(system_role 等)由
  `staff_guard_authority_update_trg` 挡住(`migration-2026-09-02-late-reason-notifications.sql:923`)。本次不动。
- **薪资档的角色集合**:`current_rank() = 'manager' or current_system_role() in ('hr','manager','admin','owner')`
  (`migration-2026-07-08-rls-system-role.sql` 的 salary 档)。

## 范围决策

用户 2026-10-23 拍板:

1. **四项敏感资料**(IC、地址、生日、电话):本人 + **HR、经理、管理员、老板**可读。
   与薪资同一批人。**Supervisor 看不到任何人的这四项**(包括本分行)。
2. **`manager_notes` 一起处理**:只有 HR、经理、管理员、老板可读写,**被写的员工本人也看不到**。
3. 做法选 A(拆两张新表),否决:
   - B 栏位级 `revoke select (…)`:12 处 `select('*')` 会报 permission denied,且做不到"本人能看自己那行"。
   - C 锁 `staff` 表 + 公开 view:要改 15 个文件和嵌入查询,改动面最大。

**范围外**:`gender`、`education`、`working_experience` 等维持对已登录员工可见;
`registration_requests.phone` 本来就只有 supervisor/manager 可读,维持原样。

## 设计

### 1. 权限函数

```sql
create or replace function can_read_staff_private() returns boolean
language sql security definer stable set search_path = public as $$
  select current_rank() = 'manager'
      or current_system_role() in ('hr','manager','admin','owner');
$$;
```

前端镜像 `canReadStaffPrivate(staff)` 放在 `src/shared/lib/permissions.ts`,与 SQL 同一条判断
(rank `manager` 或 system_role ∈ hr/manager/admin/owner)。它是 UI 门槛,不是安全边界 —— RLS 才是。

### 2. 数据:`supabase/migration-2026-10-23-staff-private.sql`(第一段,不删旧栏)

```sql
create table if not exists staff_private (
  staff_id       uuid primary key references staff(id) on delete cascade,
  ic_number      text,
  date_of_birth  date,
  contact_number text,
  address        text,
  updated_at     timestamptz not null default now()
);
alter table staff_private enable row level security;
-- select / insert / update:本人或 can_read_staff_private();无 delete policy(随 staff cascade)
create policy "staff_private_select" on staff_private for select to authenticated
  using (staff_id = auth.uid() or can_read_staff_private());
create policy "staff_private_insert" on staff_private for insert to authenticated
  with check (staff_id = auth.uid() or can_read_staff_private());
create policy "staff_private_update" on staff_private for update to authenticated
  using (staff_id = auth.uid() or can_read_staff_private())
  with check (staff_id = auth.uid() or can_read_staff_private());

create table if not exists staff_manager_notes (
  staff_id    uuid primary key references staff(id) on delete cascade,
  notes       text,
  updated_by  uuid references staff(id) on delete set null,
  updated_at  timestamptz not null default now()
);
alter table staff_manager_notes enable row level security;
create policy "staff_manager_notes_all" on staff_manager_notes for all to authenticated
  using (can_read_staff_private()) with check (can_read_staff_private());
```

回填(幂等,第 1 步和第 3 步都跑同一段):

```sql
insert into staff_private (staff_id, ic_number, date_of_birth, contact_number, address)
select id, ic_number, date_of_birth, contact_number, address from staff
on conflict (staff_id) do update set
  ic_number      = coalesce(staff_private.ic_number,      excluded.ic_number),
  date_of_birth  = coalesce(staff_private.date_of_birth,  excluded.date_of_birth),
  contact_number = coalesce(staff_private.contact_number, excluded.contact_number),
  address        = coalesce(staff_private.address,        excluded.address);

insert into staff_manager_notes (staff_id, notes)
select id, manager_notes from staff where manager_notes is not null
on conflict (staff_id) do update
  set notes = coalesce(staff_manager_notes.notes, excluded.notes);
```

`coalesce` 以新表为准:新版前端写进新表的值不会被旧栏覆盖;只补新表还空着的格子。

每位员工都回填一行(即使四项全空),让前端"有行 / 没行"可以直接代表"有权限 / 没权限"。

### 3. 第二段:`supabase/migration-2026-10-23-staff-private-drop-columns.sql`

```sql
alter table staff
  drop column if exists ic_number,
  drop column if exists address,
  drop column if exists date_of_birth,
  drop column if exists contact_number,
  drop column if exists manager_notes;
```

执行前先跑核对查询:`staff` 旧栏每个非空值都在新表里有相同值,差异为 0 才删。
`schema.sql` / `FRESH_BUILD_full.sql` 同步:去掉五个 `add column`,加入两张新表、函数和 policy。

### 4. 上线顺序

1. prod 跑第一段 SQL(建表 + 函数 + policy + 回填)。旧栏保留,旧版网站照常运作。
2. 部署新前端(`vercel deploy --prod`)+ 重新部署 `provision-staff`。
3. 再跑一次回填,补上第 1、2 步之间旧版网站写进旧栏的资料。
4. 跑核对查询,差异为 0 后跑第二段 SQL 删旧栏。删之前先用一句话说明删的是什么。

第 1–3 步之间旧栏仍对已登录员工可见,窗口以分钟计;不额外加同步 trigger。

### 5. 前端

- **类型**(`src/shared/types/index.ts`):`Staff` 删掉五个栏位;新增
  `StaffPrivate { staff_id; ic_number; date_of_birth; contact_number; address; updated_at }`。
  删掉后 `tsc` 会标出所有残留用法,作为改动清单。
- **数据存取**:新文件 `src/features/staff/privateApi.ts`
  - `fetchStaffPrivate(staffId): Promise<StaffPrivate | null>` —— `maybeSingle()`,无权限时 RLS 返回 0 行 → `null`
  - `saveStaffPrivate(staffId, patch)` —— `upsert`,`onConflict: 'staff_id'`,`.select('staff_id')` 并把 0 行视为权限错误
    (沿用 StaffProfile 现有"成功但 0 行 = 没权限"的处理)
  - `fetchManagerNotes(staffId)` / `saveManagerNotes(staffId, notes, actorId)` 同理
- **StaffProfile Personal 区块**:进页面时并行 `fetchStaffPrivate`。
  - 有行:照旧显示 / 编辑;编辑保存时 `contact_number`、`address` 走 `saveStaffPrivate`,其余栏位照旧写 `staff`。
  - 没行(看别人且无权限):IC Number、Date of Birth、Contact、Address 四行显示 `Restricted`,不显示编辑入口。
- **ManagerNotesCard**:改读写 `staff_manager_notes`;外层门槛由 `isManager` 改为
  `canReadStaffPrivate(currentStaff) && !isSelf`,修正现在 hr/admin/owner(rank 非 manager)看不到卡片的落差。
  `EmploymentStatusCard`、`DangerZoneCard` 的门槛不变。
- **Onboarding**:提交时拆两次写,**顺序固定**:先 `saveStaffPrivate(user.id, …)` 写四项,
  成功后才 `update staff`(其余栏位 + `onboarding_completed: true`)。第一步失败就停在当前页显示错误,
  `onboarding_completed` 保持 false,员工可直接重新提交(upsert 幂等)。预填从 `fetchStaffPrivate(user.id)` 取。
- **provision-staff**:`staff` upsert 拿掉 `contact_number`;成功后**无论 phone 是否为空**都 upsert
  `staff_private { staff_id: userId, contact_number: phone }`,保证每位员工都有一行
  (前端靠"有行 / 没行"判断权限)。失败时与现有 profile 失败同样回滚(删 auth user)。

### 6. 测试

- **SQL 角色模拟**(`set local role authenticated` + `request.jwt.claims`,包在 `begin … rollback`):
  | 身份 | `staff_private` 可见行数 | `staff_manager_notes` 可见行数 |
  |---|---|---|
  | anon(REST + publishable key) | 0 | 0 |
  | trainee 本人 | 1(自己) | 0 |
  | supervisor | 1(自己) | 0 |
  | hr | 全部(61) | 全部 |
  | owner | 全部(61) | 全部 |
  另测:trainee 对别人的 `staff_private` 做 update → 0 行受影响。
- **单元测试**:`privateApi.ts` 的 `null` / 0 行 → 权限错误分支(vitest,mock supabase,沿用 `Tasks.staffRead.test.tsx` 体例)。
- **构建**:`tsc --noEmit` 与 `npm run build` 通过。
- **线上走查**:员工改自己的电话;supervisor 打开同事资料看到 `Restricted`、看不到备注卡
  (trainee 没有 `view_team`,本来就进不了 `/staff/:id`,他们的风险只在直接打 REST,由上面 SQL 测试覆盖);
  HR 看得到四项与备注;
  新员工完成 Onboarding;manager 新增员工后电话出现在新表。

## 验收

- trainee / supervisor 登录后,无论 UI 还是直接打 REST,都读不到同事的四项与任何备注。
- 本人能看、能改自己的电话与地址;IC 与生日仍只读。
- HR、经理、管理员、老板(不论 rank)能看所有人的四项和备注,并能写备注。
- `staff` 表上五个旧栏位已删除,`schema.sql` / `FRESH_BUILD_full.sql` 重建出来的库与 prod 一致。
- 资料零丢失:删栏前核对查询差异为 0。
