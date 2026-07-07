# 排班请假指派(Schedule Leave Assignment)设计

Status: Approved
Date: 2026-07-07

## 背景

排班模块的选班弹窗(`ShiftPickerModal`,[Schedule.tsx](../../../src/features/schedule/Schedule.tsx))目前只有两种动作:选一个工作班次,或 "Remove shift (mark as Off)"。经理无法在排班时直接标记员工当天请假,导致排班表和考勤对不上(请假的人显示为 Off 或仍挂着班次)。

`scheduled_shifts` 表(schema.sql:682)一行代表"某员工某天的排班",`shift_type_id` 目前 **not null**,`unique (staff_id, date)`,应用侧按 `staff_id,date` upsert(`assignShift()`,Schedule.tsx:620)。

现有请假审批流(HrLeave `approve()`)批准后把当天考勤 upsert 成 `status='on_leave'`,并扣减 `leave_entitlements` 计数。

## 目标

1. 选班弹窗新增 **LEAVE** 分组,可直接指派 5 种假型:
   - `medical` — Medical Leave (MC)
   - `emergency` — Emergency Leave
   - `unpaid` — Unpaid Leave
   - `maternity` — Maternity Leave
   - `public_holiday` — 界面文案 **Public Holiday Replacement**(存储值沿用现有 `public_holiday`)
2. 指派请假后,当天考勤自动 upsert 为 `on_leave`(与请假审批流同一写法)。
3. 把请假格改回班次/Off 时,若当天考勤仍是"干净的 on_leave"(没有 `clock_in` 数据),自动删除该考勤行;有打卡数据则不动。
4. 经理排班网格 + 员工 My Schedule 都以区别于班次的样式显示假型标签;请假天不计入每周工时。

## 非目标(用户已确认选"排班 + 考勤同步"方案)

- **不写入** `leave_requests`(不出现在 HR Leave 的申请历史里)。
- **不扣减** `leave_entitlements` 余额/计数 —— 余额仍由员工申请 → 审批流负责。
- **不含 Annual Leave 和 Paternity Leave**:年假有累计余额上限,必须走申请流;paternity 不在用户需求清单内。选班弹窗只出现上述 5 种。
- 不做多天区间指派(经理逐天点即可;多天请假走申请流更合适)。
- 不改 `scheduled_shifts` RLS(supervisor/manager 已可管理)。

## 数据模型

追加到 [schema.sql](../../../supabase/schema.sql) 末尾的幂等迁移块(照惯例由用户手动在 Supabase SQL Editor 执行):

```sql
-- Phase 5 migration: Schedule leave assignment
alter table scheduled_shifts alter column shift_type_id drop not null;
alter table scheduled_shifts add column if not exists leave_type text
  check (leave_type in ('medical','emergency','unpaid','maternity','public_holiday'));
-- 一行要么是班次、要么是请假,二选一
alter table scheduled_shifts drop constraint if exists scheduled_shifts_shift_or_leave;
alter table scheduled_shifts add constraint scheduled_shifts_shift_or_leave
  check (
    (shift_type_id is not null and leave_type is null)
    or (shift_type_id is null and leave_type is not null)
  );
```

现有数据全部满足新约束(所有行都有 shift_type_id、无 leave_type),迁移零风险。

## 类型改动(`src/shared/types/index.ts`)

- `ScheduledShift.shift_type_id: string | null`(原 `string`)
- `ScheduledShift.leave_type: LeaveType | null`(新增)
- 新增常量(数据,供弹窗/徽章渲染):

```ts
export const SCHEDULE_LEAVE_OPTIONS: { type: LeaveType; label: string }[] = [
  { type: 'medical',        label: 'Medical Leave (MC)' },
  { type: 'emergency',      label: 'Emergency Leave' },
  { type: 'unpaid',         label: 'Unpaid Leave' },
  { type: 'maternity',      label: 'Maternity Leave' },
  { type: 'public_holiday', label: 'Public Holiday Replacement' },
]
```

- 新增纯函数(可单测):`shouldClearLeaveAttendance(att: Pick<Attendance,'status'|'clock_in'> | null | undefined): boolean` —— 仅当考勤行存在、`status === 'on_leave'` 且 `clock_in` 为空时返回 true。

## UI 与数据流(全部在 [Schedule.tsx](../../../src/features/schedule/Schedule.tsx))

### 选班弹窗 `ShiftPickerModal`

- `onAssign` 回调签名从 `(shiftTypeId: string | null)` 改为 `(a: { shiftTypeId: string | null; leaveType: LeaveType | null })`(Off = 两者皆 null,沿用现有"删除行"路径)。
- 班次分组之后、"Remove shift" 之前,渲染 **LEAVE** 分组:遍历 `SCHEDULE_LEAVE_OPTIONS`,样式与班次按钮一致但用中性棕灰色系;当前选中的假型打 ✓。

### `assignShift()`

```
off:    删除 scheduled_shifts 行(现状)         + 清理考勤(见下)
shift:  upsert { shift_type_id, leave_type: null } + 清理考勤
leave:  upsert { shift_type_id: null, leave_type } + upsert 考勤 on_leave
```

- 请假 → 考勤:`supabase.from('attendance').upsert({ staff_id, date, status: 'on_leave', recorded_by: 当前经理 id }, { onConflict: 'staff_id,date' })` —— 与 HrLeave `approve()` 逐字段一致。
- 清理考勤:仅当"这天原本是请假格"(existing.leave_type 非空)时才查当天考勤行;`shouldClearLeaveAttendance()` 为 true 才 delete。
- upsert 班次时必须显式写 `leave_type: null`(覆盖同一行上旧的请假值,否则约束违规)。
- 所有 Supabase 错误显示出来(沿用 Dashboard 的红色横幅惯例),不静默。

### 显示

- 经理网格格子:请假行渲染 `LeaveBadge`(假型完整标签,中性棕灰底 + 虚线边,与彩色班次徽章一眼区分);格子仍可点击打开弹窗改动。
- 员工 My Schedule 周列表:请假行同样显示假型标签,不显示时间/工时。
- 每周工时合计:请假行没有 `shift_type_id`,现有 `shiftTypes.find()` 查不到即不计时 —— 实现时验证此路径,勿让 `null` 崩溃。
- 日覆盖视图(按班次分组):请假行天然不属于任何班次组,不显示,不改。

## 错误处理

- 迁移未跑时(线上缺 `leave_type` 列),指派请假会得到明确的 Supabase 错误并显示在弹窗/页面,不静默失败。
- 约束 `scheduled_shifts_shift_or_leave` 兜底防脏数据。

## 测试要点

- `shouldClearLeaveAttendance`:null/undefined 行、on_leave 无打卡(true)、on_leave 有 clock_in(false)、present 状态(false)。Vitest。
- 手动走查:指派 MC → 网格显示标签、考勤日视图当天变 On Leave;改回班次 → 考勤行消失;有打卡数据的天改动 → 考勤不被误删;员工端 My Schedule 显示正确;周工时不含请假天。

## 范围确认

一个 SQL 块 + `types/index.ts` + `Schedule.tsx` + 一个小测试文件。不触碰 HrLeave、attendance 之外的模块。
