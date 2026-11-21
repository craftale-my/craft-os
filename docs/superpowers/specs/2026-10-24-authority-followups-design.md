# 权限后续三项(staff.status、registration_requests、listUsers)— 设计

日期:2026-10-24
来源:`2026-10-23-staff-private-fields-design.md` 末尾列的三个后续事项(PR #7 之后)。
决定:2026-10-24 用户选定 status 规则"只限 manager-tier"、申请表"只能拒绝 pending、客户端不能删除"。

## 1. 改别人的 `staff.status`

**问题。** `staff_update` RLS 让 supervisor / hr 能 UPDATE 任何人的 staff 行,
`staff_guard_authority_update()` 只管 rank 与 system_role,status 对别人的行没设防:supervisor 或 hr
可以把 owner 标成 `resigned`,对方随即被 `App.tsx` 挡在 app 外,provision-staff 也认不得他。

**写入者盘点(2026-10-24)。**

| 写入者 | 栏位 | 谁 | 新规则下 |
|---|---|---|---|
| StaffProfile `handleSetStatus()`(Mark as Resigned / Reactivate) | status | UI 只给 rank manager | 放行 |
| ProbationReview eliminate | is_active(不碰 status) | supervisor | 不受影响 |
| provision-staff create / approve | 新行,status 用预设 | service role | 放行 |
| SQL job(auto-absent、notify-late、org chart、leave accrual) | 只读 status | — | 不受影响 |
| VERIFY-2026-09-02 | 以 postgres 写 | auth.uid() 为空 | 放行 |

**规则。** 在 `staff_guard_authority_update()` 的 UPDATE 分支加两条(只对别人的行;本人的行沿用旧规则:
非 manager-tier 不能改自己的 rank / system_role / status):

- 改别人的 `status`:调用者必须是 manager-tier(`current_rank() = 'manager'` 或
  `current_system_role() in ('manager','admin','owner')`),否则 42501
  "Only a manager can change another staff member's status."
- 对象是 owner(`old.system_role = 'owner'`):只有 owner(`current_is_owner()`)能改他的 status,
  否则 42501 "Only the owner can change the owner's status." —— admin 也不行。
- `auth.uid()` 为空(service role、SQL editor、cron)照旧放行。

做法:新 migration 用 `create or replace` 整个替换函数,trigger 不变。若日后重跑
`migration-2026-10-23-staff-authority-guard.sql`,会退回旧版,需再跑本档。

## 2. `registration_requests` RLS

**问题。** `registration_requests_manage` 是 `for all`:supervisor / hr / manager / admin / owner 能改任何申请的
email、电话、status、`reviewed_at`,把已决定的申请改回 pending,也能删除。provision-staff approve 已在服务端
重新认领、重新读取一切,所以这是纵深防御。

**新规则。**

- `registration_requests_select`(select):原来那批人(rank supervisor / manager,或 system_role
  hr / supervisor / manager / admin / owner)可读,与以前相同。
- `registration_requests_reject`(update):同一批人,USING `status = 'pending'`;WITH CHECK
  `status = 'rejected'`、`reviewed_by = auth.uid()`、`phone is null`。也就是客户端唯一能做的修改是
  "把 pending 拒绝掉,并清掉电话"。已决定的申请 UPDATE 命中 0 行。
- 不给 delete policy:客户端不能删申请(UI 本来就没有删除)。
- `registration_requests_insert`(anon / authenticated):WITH CHECK 收紧为 `status = 'pending'` 且
  `reviewed_by`、`reviewed_at`、`rejection_reason` 皆为空。防止注册页以外的人插入已决定的行,或塞一个未来的
  `reviewed_at` 让 approve 的认领永远失败。
- BEFORE UPDATE trigger `registration_requests_guard_update()`:`auth.uid()` 不为空时,`full_name`、`email`、
  `branch`、`department`、`employment_type`、`created_at` 一律不能变(42501
  "Only the reviewer decision can be changed on a registration request."),`reviewed_at` 由服务器设成
  `now()`。选 trigger 而不选 column GRANT:GRANT 会被日后的 `grant all on all tables` 冲掉,且 trigger 与
  现有 guard 写法一致、VERIFY 测得到。`auth.uid()` 为空(provision-staff 认领 / 释放 / 标记 approved)照旧放行。

**Directory reject。** `update` 加 `.eq('status', 'pending')` 与 `.select('id')`;以前完全不看结果。
现在出错就在视窗里显示错误、不关闭;0 行显示 "This request was already decided. Refresh the list."。

## 3. provision-staff 找既有 auth 用户

**问题。** approve 在 createUser 回 "already registered" 时,用 `listUsers({ page: 1, perPage: 1000 })`
找同 email 的用户,只看第一页。共用后端加入 POS / 顾客帐号后可能超过 1000 人而找不到(只会回错,不会误接管)。

**做法。** 新增 SQL 函数 `auth_user_id_by_email(p_email text) returns uuid`:security definer、
`search_path = ''`,在 `auth.users` 里以 `lower(email) = lower(trim(p_email))` 查,非 SSO 用户优先、
同等时取最早建立的一个。`execute` 只 grant 给 `service_role`(revoke from public / anon / authenticated)——
它能拿 email 换 user id,不能给客户端。function 改成先调这个 RPC 拿 id,再 `getUserById` 读
`app_metadata` 与 `last_sign_in_at`,其余逻辑不变。RPC 出错回 500 并释放认领。

不选"把 listUsers 一页页翻完":不用改 DB,但人数越多越慢,每次审批都扫全表。

## 上线顺序

1. dev(`egznnbjmicebbhwasloy`):跑 migration → 种 `[TEST]` 身份 → 跑 VERIFY(`all_pass`)→ 部署
   provision-staff → 实测 approve 的"新帐号"、"帐号已存在"、"非员工登入"三个分支 → 清掉 `[TEST]` 资料。
2. prod(`yfsoesxzurzjdwstszru`):**等用户点头**。先跑 migration + VERIFY,再部署 function(新 function 依赖
   RPC,必须在 migration 之后),再合并 PR、Vercel 部署前端。旧前端的 reject 仍送 `phone: null` 与
   `reviewed_by`,在新 RLS 下照常成功,所以 DB 可先于前端上线。

## 验收

- supervisor / hr 改别人的 status 被拒;manager-tier 能改非 owner 的;admin 改 owner 的被拒;owner 能改。
- supervisor 能拒绝 pending 申请;不能改 email;不能把已决定的申请改回 pending(0 行);不能删除;
  不能把 `reviewed_by` 写成别人。
- 匿名只能插入干净的 pending 申请。
- `authenticated` 不能执行 `auth_user_id_by_email`。
- approve 在 dev 上三个分支结果与 PR #7 相同。

## 后续事项(本分支不做)

- `is_active`:supervisor 仍能把任何人(含 owner)设 `is_active = false`(ProbationReview eliminate 用的栏位)。
  目前 `is_active` 不挡登入,只影响 org chart、通知名单等;日后若 `is_active` 变成权限条件,需比照本次收紧。
- admin(manager-tier)仍能改 owner 的 **rank**。rank 不赋予 owner 权力(owner 权力来自 system_role),
  所以本次不处理。
