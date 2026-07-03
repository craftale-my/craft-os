# 两段式休息打卡(Two-Break Attendance)设计

Status: Approved
Date: 2026-07-03

## 背景

Craft OS 目前的休息(break)是**单段**设计:

- `shift_types.break_minutes` 定义每个班次允许的休息时长(分钟)。
- 员工在 [HrAttendance.tsx](../../../src/features/hr/HrAttendance.tsx) 的 `MyAttendance` 里,clock-in 之后出现一组"Break Clock-Out / Break Clock-In"按钮,配一个实时倒计时;结束时把实际时长、是否超时写回 `attendance` 行本身的 `break_start / break_end / break_minutes / break_late / break_overrun_minutes` 五个字段。
- 主管端(`DailyRoster`/`MonthlyGrid`)读 `attendance.break_minutes / break_late` 显示一个休息徽章。
- Shift 设定在 [Settings.tsx](../../../src/features/settings/Settings.tsx) 的 `ShiftTypesTab`,只有一个「Break Duration」输入框。
- 排班 [Schedule.tsx](../../../src/features/schedule/Schedule.tsx) 的 `shiftHours()` 用 `break_minutes` 扣除工时。

需求:改为**两段独立休息**(Break 1 / Break 2),每段有独立的允许时长、独立的打卡出/打卡回、独立的超时判定。典型场景:

- 12 小时班 → break1: 60min, break2: 60min
- 短班 → break1: 30min, break2: 0min(无第二段)
- 无休息 → break1: 0min, break2: 0min

## 目标

1. 每个 shift 可配置两段休息时长 `break1_duration_minutes`、`break2_duration_minutes`(整数,0 = 该段不存在)。
2. 员工打卡界面把「上下班」和「休息」两组按钮完全分开(上下班逻辑不动)。
3. 休息按顺序进行:先完整走完 Break 1(打卡出 → 倒计时 → 打卡回),Break 1 完成且 shift 配置了 `break2 > 0` 时,才出现 Break 2 的按钮;同样一套流程。
4. 每段休息记录实际时长、超时分钟数、是否超时,存入新表 `attendance_breaks`。
5. 超时(实际 > 设定)在主管端 Team Attendance 显示醒目标记。
6. 倒计时超时后界面变红警告。

## 非目标(明确排除)

- **不自动修改 `attendance.status`**。需求提到"标记 Late",但本项目 `status` 字段一直由主管手动控管(present/late/absent/half_day/on_leave),现有单休逻辑也从不自动改它。超时只记录在 `attendance_breaks`(`is_overtime` + `overtime_minutes`)并在 UI 上以徽章呈现,供主管参考。这与需求最后一句"不自动扣薪,只记录供参考"一致。
- **不自动扣薪**。
- **不回填历史数据**。现有 `attendance.break_*` 旧字段保留为历史记录原样呈现,新逻辑一律走新表,不写脚本把旧单休记录搬进 `attendance_breaks`。
- 不改动 GPS / 自拍 / 上下班打卡本身的任何逻辑。
- 不引入第三段或可变段数;固定最多两段。

## 数据模型改动

### `shift_types` 表(新增两列)

```sql
alter table shift_types add column if not exists break1_duration_minutes int not null default 0;
alter table shift_types add column if not exists break2_duration_minutes int not null default 0;
-- 一次性把现有单段时长迁到 break1(仅当 break1 仍为默认 0 且旧值 > 0)
update shift_types set break1_duration_minutes = break_minutes
  where break1_duration_minutes = 0 and coalesce(break_minutes, 0) > 0;
```

- 旧列 `break_minutes`(以及更早的 legacy `break_start / break_end`)保留但新代码不再写入,沿用本文件既有的 legacy-列处理惯例。
- 语义:`break1_duration_minutes = 60, break2_duration_minutes = 60` → 两段各 60 分钟;`break2 = 0` → 没有第二段;两者都 0 → 该班次无休息。

### 新表 `attendance_breaks`

```sql
create table if not exists attendance_breaks (
  id uuid primary key default gen_random_uuid(),
  attendance_id uuid not null references attendance(id) on delete cascade,
  break_number int not null check (break_number in (1, 2)),
  clock_out_time timestamptz,          -- 员工点"Break N 打卡出"(开始休息)的时刻
  clock_in_time timestamptz,           -- 员工点"Break N 打卡回"(结束休息)的时刻
  duration_minutes int,                -- 实际休息分钟数 = round((clock_in - clock_out)/60000)
  overtime_minutes int not null default 0,
  is_overtime boolean not null default false,
  created_at timestamptz not null default now(),
  unique (attendance_id, break_number)
);

alter table attendance_breaks enable row level security;
```

RLS(沿用 `attendance` 表现有的三条策略形态):

```sql
-- 本人可读自己的休息记录，supervisor/manager 可读全部
create policy "attendance_breaks_select" on attendance_breaks for select to authenticated
  using (
    exists (select 1 from attendance a where a.id = attendance_id
            and (a.staff_id = auth.uid() or current_rank() in ('supervisor','manager')))
  );
-- 本人可对自己的 attendance 行插入/更新休息记录
create policy "attendance_breaks_self_write" on attendance_breaks for insert to authenticated
  with check (exists (select 1 from attendance a where a.id = attendance_id and a.staff_id = auth.uid()));
create policy "attendance_breaks_self_update" on attendance_breaks for update to authenticated
  using (exists (select 1 from attendance a where a.id = attendance_id and a.staff_id = auth.uid()));
-- supervisor/manager 全权管理
create policy "attendance_breaks_manage" on attendance_breaks for all to authenticated
  using (current_rank() in ('supervisor','manager'));
```

`attendance` 表原有的 `break_start / break_end / break_minutes / break_late / break_overrun_minutes` 五列不动(历史数据),新代码不再读写它们用于新逻辑。

迁移以 idempotent SQL 块追加到 [schema.sql](../../../supabase/schema.sql) 末尾("Phase 4 migration"),由用户手动在 Supabase SQL Editor 执行(沿用本项目手动迁移惯例,见 [[pending-db-migration]])。

## 类型改动(`src/shared/types/index.ts`)

- `ShiftType` 新增 `break1_duration_minutes: number`、`break2_duration_minutes: number`;`break_minutes` 保留并注释为 legacy。
- 新增:

```ts
export interface AttendanceBreak {
  id: string
  attendance_id: string
  break_number: 1 | 2
  clock_out_time: string | null
  clock_in_time: string | null
  duration_minutes: number | null
  overtime_minutes: number
  is_overtime: boolean
  created_at: string
}
```

## UI 改动

### Shift 设定 — `ShiftTypesTab`([Settings.tsx](../../../src/features/settings/Settings.tsx))

- 把单个「Break Duration (minutes)」输入框替换为两个:「Break 1 Duration (minutes)」+「Break 2 Duration (minutes)」,均 `min=0 step=5`,0 = 无该段。
- `editing` 初始值(Add Shift)默认 `break1_duration_minutes: 60, break2_duration_minutes: 0`。
- `save()`(insert 和 update 两路)写 `break1_duration_minutes` / `break2_duration_minutes`,不再写 `break_minutes`。
- 列表预览文字:`st.break1_duration_minutes > 0` 时显示 `· Break 1 60min`,`break2 > 0` 时追加 `· Break 2 60min`;都为 0 时不显示休息文字。

### 排班 — `Schedule.tsx`

- `shiftHours()` 的休息扣除从 `st.break_minutes` 改为 `(st.break1_duration_minutes ?? 0) + (st.break2_duration_minutes ?? 0)`。
- Shift 徽章(`ShiftBadge` 及 `ShiftPickerModal` 里 line ~134 的说明文字)同步用两段之和或分别显示。

### 员工打卡 — `MyAttendance`([HrAttendance.tsx](../../../src/features/hr/HrAttendance.tsx),改动最大)

数据加载:
- `loadBreakAllowance` 改名/改写为读取当天 shift 的 `break1_duration_minutes`、`break2_duration_minutes`(无 shift 时 break1 回退到 `system_rules.default_break_minutes`,break2 = 0)。
- 新增 `loadBreaks()`:查询当天 `attendance_breaks`(按 `today.id`),得到 break1、break2 各自的记录(可能不存在)。

按钮结构(两组完全分开):
- **组 1 上下班**:现有 `Clock In / Clock Out` 区块与逻辑完全不动。
- **组 2 休息**:仅当 `today?.clock_in` 存在且(`break1_duration > 0` 或已有休息记录)时显示。按段顺序渲染:
  - **Break 1**:
    - 未开始 → 显示 `[Break 1 Clock-Out]` 按钮;点击 → 在 `attendance_breaks` upsert 一条 `break_number=1, clock_out_time=now`,倒计时从 `break1_duration` 开始。
    - 进行中(有 `clock_out_time` 无 `clock_in_time`)→ 显示实时倒计时(超时变红警告)+ `[Break 1 Clock-In]` 按钮;点击 → 更新该行 `clock_in_time=now, duration_minutes, overtime_minutes=max(0,实际-允许), is_overtime`。
    - 已完成 → 显示汇总(实际 X 分钟 / 是否超时)。
  - **Break 2**:仅当 `break2_duration > 0` **且 Break 1 已完成**(有 `clock_in_time`)时才渲染,逻辑同 Break 1(`break_number=2`,允许时长用 `break2_duration`)。
- 倒计时 tick、`fmtCountdown` 等沿用现有实现,只是数据源从 `attendance` 行改为当前进行中的那条 `attendance_breaks`。
- 写入一律针对 `attendance_breaks`(upsert on `attendance_id,break_number`),不再 update `attendance` 行的 break 字段。

### 主管视图 — `DailyRoster` / `MonthlyGrid`([HrAttendance.tsx](../../../src/features/hr/HrAttendance.tsx))

- `DailyRoster.load()` 除了查 `attendance`,额外查当天这些 attendance id 对应的 `attendance_breaks`,按 `attendance_id` 归组。
- 休息徽章从原来读 `attendance.break_minutes/break_late` 改为:对该员工当天的 break1/break2 各显示一个徽章(`Coffee` 图标 + `B1 60m ✓` 或超时 `B1 65m (+5m ⚠️)`);无休息记录则不显示。超时徽章用红色底(`#FDF3F0`/`#9E4A30`),正常用现有琥珀色。
- `MonthlyGrid`:保持每日一个状态色块即可;可选地在 title tooltip 里加"含超时"提示(优先保持简单,若实现成本低就加,否则不加,不作硬要求)。

## 数据流影响点

- `handleClockDone('in')` 仍 upsert `attendance` 行并拿到/刷新 `today`;休息记录依赖 `today.id` 作为外键,因此休息按钮必须在 clock-in(`today` 存在)之后才可用 —— 现有逻辑已满足。
- Clock-out(下班)不阻止未结束的休息;但 UI 上若某段休息进行中,建议在下班前给出提示。**保持简单**:不强制拦截,只按现状允许下班(与现有单休行为一致,现有代码也不拦截)。

## 测试要点

无纯函数级新逻辑适合单元测试的部分较少,但以下值得覆盖(用 Vitest,沿用年假功能引入的测试设施):
- 一个纯工具函数 `computeBreakOvertime(clockOutIso, clockInIso, allowedMinutes)` → 返回 `{ durationMinutes, overtimeMinutes, isOvertime }`,抽出来便于测试超时边界(恰好等于、超过 1 分钟、未超)。`MyAttendance` 的 `handleBreakIn` 调用它。
- `shiftHours()` 在 break1+break2 组合下的工时计算(0+0、60+0、60+60)。

UI 流程(手动 / 浏览器走查):Break 1 完整流程 → Break 2 仅在 break1 完成且 break2>0 时出现 → 两段都 0 时整个休息区块隐藏 → 超时倒计时变红 → 主管端超时徽章。

## 范围确认

本设计仅覆盖休息(break)从单段改为两段的数据模型、Shift 设定、员工打卡、主管展示与排班工时扣除;不涉及上下班打卡逻辑、不改 `attendance.status` 自动化、不回填历史、不做扣薪。
