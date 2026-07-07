# Leave 系统重构(AL 月累积 + 移除 EL + PH Replacement)设计

Status: Approved
Date: 2026-07-08

## 背景

现行 AL 为一次性年度发放(`leave_entitlements.annual_entitled`,由 `calcAnnualEntitlement()` 按工龄档一次给足 8/12/16 天),员工未做满一年即可用完全年额度,引发争执。本次改为**从转正日起按月累积**,同时移除 Emergency Leave、新增手动发放且有有效期的 PH Replacement,并把假期参数搬进 Settings。

线上现状(2026-07-08 核实):`leave_requests` 为空,6 行 entitlements 全部 8/8 未用 → 无负余额风险,可干净切换。已转正(probation hired)且在职:NO 2、Loke Kah Lok;经理们与 Tan chee sin 无 probation 记录,转正日需手动补填。2026-07-02 的未合并年假 worktree(按入职日+工龄档设计)与本规格冲突,**废弃**。

## 定时任务选型:pg_cron

选 pg_cron 弃 Edge Function:①本机无 supabase CLI 部署路径,pg_cron 只需 Dashboard 开扩展+一段 SQL,贴合本项目手动跑 SQL 的惯例;②累积/过期/结转是纯集合运算,适合在库内完成;③核心函数幂等可补账(catch-up),cron 漏跑可自愈,Settings 的 Recalculate 按钮调同一函数(RPC)作手动兜底。

## 数据模型(Stage 1 SQL,手动跑)

```sql
alter table staff add column if not exists confirmation_date date;

-- 回填已转正员工(取最早一次 hired 的 Day3 完成日)
update staff s set confirmation_date = sub.d
from (select staff_id, min(day3_completed_at)::date as d
      from probation_reviews where overall_result = 'hired' group by staff_id) sub
where s.id = sub.staff_id and s.confirmation_date is null;

create table if not exists leave_accrual_log (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,
  leave_type text not null default 'annual' check (leave_type = 'annual'),
  entry_type text not null default 'accrual' check (entry_type in ('accrual','forfeit','adjustment')),
  amount numeric not null,
  period_month date,             -- accrual: 所覆盖的月周年日; forfeit: 当年 1 月 1 日
  accrued_at timestamptz not null default now(),
  note text,
  unique (staff_id, entry_type, period_month)   -- 幂等去重键
);

create table if not exists ph_replacements (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,
  granted_by uuid references staff(id),
  granted_at timestamptz not null default now(),
  expires_at date not null,
  reason text,                    -- 哪个公共假期(名称/日期)
  status text not null default 'available' check (status in ('available','used','expired')),
  used_in_leave_request_id uuid references leave_requests(id),
  created_at timestamptz not null default now()
);
```

RLS:两表 select = 本人或 supervisor/manager;`ph_replacements` 的 insert/update 仅 supervisor/manager;`leave_accrual_log` 不开放客户端写(只由 security-definer 函数写)。

`system_rules` 新增 5 个 key(seed,`on conflict do nothing`):`leave_al_monthly_rate` '0.667'、`leave_al_annual_cap` '8'、`leave_al_carryover_cap` '4'、`leave_ph_expiry_months` '3'、`leave_medical_annual` '14'。

`leave_entitlements.annual_*` 与 `emergency_*` 保留不再读写(历史);medical 照旧,建行时 `medical_entitled` 读 `leave_medical_annual`。

## 累积引擎(Stage 2 SQL:函数 + pg_cron)

`process_leave_accruals()`(`security definer`;内部校验:调用者须为 cron(无 auth.uid)或 supervisor/manager):

1. **AL 月累积(幂等补账)**:对每个 `status='active' and is_active and confirmation_date is not null` 的员工,枚举转正日之后、不晚于今天的每个"月周年日"(3月15转正→4月15第一笔;月底顺延由 `+ interval '1 month'` 语义处理);对 `unique(staff_id,'accrual',period_month)` 尚无记录的,插入 `amount = least(月累积率, 年度上限 − 该自然年已累积合计)`(≤0 则跳过)。**年度上限=同一自然年内累积封顶**(用户已确认)。
2. **年结转清零(幂等)**:若今天 ≥ 当年 1 月 1 日且该员工无当年 forfeit 行:算截至 1 月 1 日的余额(period_month < 1/1 的 accrual+forfeit+adjustment 合计 − start_date < 1/1 的已批准 annual 请假天数);若 > 结转上限,插入 forfeit 行 `amount = -(超出部分)`,`period_month = 当年1月1日`,note `forfeited YYYY carryover`。
3. **PH 过期**:`update ph_replacements set status='expired' where status='available' and expires_at < current_date`。

调度:`select cron.schedule('leave-daily', '0 20 * * *', $$select process_leave_accruals()$$);`(20:00 UTC = 大马时间凌晨 4 点;同名重复 schedule 会覆盖,幂等)。前提:Dashboard → Database → Extensions 开启 `pg_cron`。

**AL 可用余额(前端统一公式)** = `Σ leave_accrual_log.amount` − `Σ 已批准 annual 请假 total_days`。0.667×12 ≈ 8.004 的微小漂移显示时四舍五入到 1 位小数,不做特殊修正。

## 前端(Stage 3-5,全在 HrLeave.tsx / Settings.tsx / StaffProfile.tsx)

**Stage 3 — EL 移除 + AL 卡片改造**:
- 移除 Emergency 卡片、Apply 表单的 emergency 选项、经理总览表 Emergency 列(历史数据保留在库)。
- AL 卡片改为 `X.X days available` + 小字 `accruing 0.67/month since [转正日]`;无转正日显示 "Awaiting confirmation date — not accruing yet"。余额按上式由 log+requests 算;Apply 时 AL 硬性校验不超余额(沿用现有 pending 也计入占用的思路:可用 = 余额 − pending annual 天数)。

**Stage 4 — PH Replacement**:
- 员工卡片:可用笔数 + 逐笔到期日(30 天内到期标黄)。
- 经理端 Grant PH Replacement:多选员工 + 假期名称/日期 → 批量 insert,`expires_at = granted_at + leave_ph_expiry_months 个月`。
- Apply 表单加 "PH Replacement"(存 `public_holiday` 类型);提交校验可用笔数 ≥ 天数,显示最早到期日。
- **批准时**才消耗:按 `expires_at` 升序取 N 笔标 `used` + 关联 request id;不足(如期间过期)则拦截并提示。拒绝/取消不消耗。
- 交叉说明:排班模块的 PH 标记(上一功能)只做排班+考勤展示,不消耗额度;正式扣额走 Apply 流。

**Stage 5 — Settings Leave Settings + 迁移工具**:
- Settings 新增 "Leave Settings" 分区(manager 可见):编辑上述 5 个 system_rules。
- **Recalculate All AL Balances** 按钮:`supabase.rpc('process_leave_accruals')` 后刷新。
- **缺转正日名单**:列出 active 且 `confirmation_date is null` 的员工,行内日期输入直接补填(写 `staff.confirmation_date`)。StaffProfile 的经理编辑区同步加 Confirmation Date 字段。

## 存量迁移(Stage 6,极简)

线上无任何请假记录:跑 Stage 1/2 SQL → UI 补填经理们的转正日 → 按 Recalculate 即完成。无需重算已用、无负余额场景。

## 测试要点

纯函数(Vitest):余额计算 `calcAlBalance(logs, approvedDays, pendingDays)`;PH FIFO 选取 `pickPhGrantsFifo(grants, days)`(不足返回 null);到期高亮判定。SQL 幂等性靠 unique 键保证,人工验证:连跑两次函数结果不变。手动走查每个 Stage 后由用户本地验证再进下一步(用户要求)。

## 部署注意

`git push` 不触发 Vercel 部署(commit 邮箱校验),上线用 `vercel deploy --prod`。SQL 均由用户在 Dashboard SQL Editor 手动执行。

## 范围确认

不改 medical/maternity/paternity/unpaid 的申请与审批行为;不动排班 PH 标记;不迁移旧库数据。
