# 累计式年假(Accrued Annual Leave)设计

Status: Approved
Date: 2026-07-02

## 背景

Craft OS 目前的年假(annual leave)额度是按年资一次性分级发放的：`calcAnnualEntitlement()`(`src/shared/types/index.ts:596`）在员工提出申请当年直接给出整年额度（<2 年 = 8 天，2–5 年 = 12 天，≥5 年 = 16 天），且 [HrLeave.tsx](../../../src/features/hr/HrLeave.tsx) 申请年假时完全不检查余额，允许超额申请。

需求：年假改为按月累计。以 8 天/年档位为例，工作满一个月累计 `8 / 12 ≈ 0.6667` 天；工龄跨档时，累计速率随之提高（12 天/年、16 天/年档位同理按 `档位天数 / 12` 逐月累计）。

## 目标

1. 年假额度不再一次性发放，而是随司龄逐月累计到账。
2. 累计速率保留现有年资分级（<2 年 / 2–5 年 / ≥5 年）。
3. 申请年假时硬性校验：申请天数不得超过当前可用余额。
4. 年度不清零，全部结转，长期累计。
5. 系统上线前入职的老员工，允许 HR/经理手动录入期初结转余额，避免历史请假数据缺失导致算错。

## 非目标

- 不改动病假（medical）、紧急假（emergency）、无薪假（unpaid）等其他假期类型的额度逻辑，它们继续沿用现有的 `leave_entitlements.*_entitled` 整年额度模式。
- 不引入定时任务（如 pg_cron）按月自动写入台账，累计天数改为**实时计算**，不落库中间状态。
- 不做年假过期/失效机制。

## 数据模型改动

### `staff` 表新增列

```sql
alter table staff add column if not exists annual_leave_opening numeric not null default 0;
```

- 语义：该员工在"累计起算点"（见下）之前，已经结转、应计入可用余额的年假天数。
- 仅 HR / 经理（`current_rank() in ('supervisor','manager')`）可编辑；普通员工只读。
- 默认 0，对系统上线后入职的新员工无需填写。

### `leave_entitlements` 表

- 保留不变。`annual_entitled` 列对**年假类型不再读取**（避免破坏其他假期类型共用的表结构，字段保留但年假计算路径不使用它）。
- `annual_used` 含义不变：该员工当年已批准使用的年假天数。终身已用年假 = 该员工所有年份 `annual_used` 之和。

不新建表，不新增迁移之外的 schema 对象。

## 计算逻辑

新增共享函数，替换 `calcAnnualEntitlement`（该函数删除，全部调用点迁移到新函数）：

```ts
// src/shared/types/index.ts
const ACCRUAL_START = '2026-01-01' // 系统累计制上线日

function annualRateForTenureYears(years: number): number {
  if (years >= 5) return 16
  if (years >= 2) return 12
  return 8
}

// 返回从入职日起，截至 asOf，逐月周年日累计的年假天数（不含 opening balance）
export function calcAccruedAnnual(joinedAt: string | null, asOf: Date = new Date()): number {
  if (!joinedAt) return 0
  const joined = new Date(joinedAt)
  const start = new Date(Math.max(joined.getTime(), new Date(ACCRUAL_START).getTime()))
  if (start > asOf) return 0

  let accrued = 0
  // 从 joined 开始逐月找"月周年日"，只累计落在 [start, asOf] 区间内的
  const cursor = new Date(joined)
  cursor.setMonth(cursor.getMonth() + 1) // 第一个月周年日
  while (cursor <= asOf) {
    if (cursor >= start) {
      const tenureYears = (cursor.getTime() - joined.getTime()) / (1000 * 60 * 60 * 24 * 365.25)
      accrued += annualRateForTenureYears(tenureYears) / 12
    }
    cursor.setMonth(cursor.getMonth() + 1)
  }
  return accrued
}
```

- **累计起点**：`max(入职日, 2026-01-01)`。2026-01-01 前的司龄不逐月回溯累计，改由 `annual_leave_opening` 手动补齐。
- **到账时点**：入职周年日滚动计算（1 月 15 日入职 → 2 月 15 日到账第一份，3 月 15 日到账第二份……），不是每月固定 1 号发放。
- **档位判断**：以该月周年日当天的司龄判断使用哪个年资档位（8/12/16 天年档）。跨档位的当月按新档位计算，不追溯调整已到账的月份。
- **小数精度**：不做整数取整，保留精确分数；界面显示时四舍五入到 2 位小数。满 12 个月累计后正好等于该档位整年天数（8 / 12 / 16），不会短少。
- **可用余额** = `annual_leave_opening + calcAccruedAnnual(joined_at) − Σ(annual_used across all years) − Σ(该员工当前 pending 状态年假申请的 total_days)`
  - 减去 pending 天数是为了防止员工连续提交多笔年假申请、在前一笔尚未审批时把余额透支。
  - 已离职（`status = 'resigned'`）员工不再计入任何管理端余额总览列表。

## 申请校验（硬性限制）

`ApplyLeaveModal`（[HrLeave.tsx:55](../../../src/features/hr/HrLeave.tsx)）在 `leave_type === 'annual'` 时：

1. 加载当前员工的可用余额（如上公式）。
2. 实时显示："可用年假：X.XX 天"。
3. 若 `totalDays > 可用余额`，提交按钮禁用，并显示错误："超出可用年假余额（剩余 X.XX 天）"。
4. 其他假期类型（medical/emergency/unpaid/maternity/paternity）行为不变，不做余额校验。

## UI 改动

均在 [HrLeave.tsx](../../../src/features/hr/HrLeave.tsx)：

### 员工视图 `MyLeaveView`

- "Annual Leave" 卡片：原先显示 `entitled - used / entitled`，改为显示 `可用余额（2 位小数）`，副标题从 "days remaining" 改为 "days accrued"，卡片下方加一行小字："每月按司龄累计"。
- `joined_at` 为空时，卡片显示 "—" 并提示 "请联系 HR 设置入职日期"。

### 申请弹窗 `ApplyLeaveModal`

- 新增可用余额展示 + 超额时禁用提交（见上）。

### 经理视图 `ManagerLeaveView`

- "Leave Balance Overview" 表格 Annual 列，从 `used/entitled` 改为 `可用 / 已累计(含期初)`。
- 新增 "期初结转" 列，经理/主管可内联编辑（写入 `staff.annual_leave_opening`），保存后立即重新计算该行余额。
- 审批（`approve()`）时，若该笔通过后会导致该员工年假余额为负（例如两笔 pending 被先后批准），审批前给出确认提示，但不阻止审批（管理端保留最终裁量权，硬性拦截只发生在员工提交阶段）。

## 数据流影响点

- `ensureEntitlement()`（[HrLeave.tsx:41](../../../src/features/hr/HrLeave.tsx)）目前会在没有当年 `leave_entitlements` 记录时插入一条、并把 `annual_entitled` 设为 `calcAnnualEntitlement()` 的返回值。年假改为累计制后，`annual_entitled` 字段不再对年假计算生效，但该函数仍需要为 medical/emergency 类型保留创建逻辑（那两类维持原年度整额模式），因此 `ensureEntitlement` 保留，只是插入时 `annual_entitled` 可以固定写 0 或保留旧值（不影响任何读取路径）。
- `approve()` 里原本按 `leave_type` 动态更新 `${req.leave_type}_used` 字段的逻辑不变，年假批准后仍然写入当年 `leave_entitlements.annual_used`，用于终身已用天数的累加来源。

## 数据库迁移

```sql
-- supabase migration: accrued annual leave
alter table staff add column if not exists annual_leave_opening numeric not null default 0;
```

追加到 [schema.sql](../../../supabase/schema.sql)，并单独提供一条迁移语句由用户在 Supabase SQL Editor 手动执行（沿用本项目现有的手动迁移流程，见项目记忆 "Pending DB migration"）。

## 测试要点

- `calcAccruedAnnual`：入职当月不到账；入职满 1/6/12/13/24/60 个月的边界值；`ACCRUAL_START` 之前/之后入职两种情形；跨年资档位（如入职第 23 个月和第 25 个月）。
- 余额计算：期初余额 + 累计 − 历年已用 − pending 之和，多笔混合场景。
- 申请校验：余额充足/不足/恰好相等三种边界下提交按钮状态。
- 经理端编辑期初结转后，员工端余额同步刷新。

## 范围确认

本设计仅覆盖年假（annual）累计逻辑与相关 UI/校验改动，不涉及其他假期类型、不涉及自动化任务、不涉及历史数据回填之外的 schema 变更。
