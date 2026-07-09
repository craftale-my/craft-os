# 考勤显示当天班次 + 迟到自动判定设计

Status: Approved
Date: 2026-07-08

## 背景

两个用户反馈:①员工看不到自己被排的班(考勤页不显示;`/schedule` 路由被 `manage_schedule` 权限锁住,员工侧边栏无入口——尽管 `SchedulePage` 内部早已实现员工版 `MyScheduleView`);②打卡晚于排班开始时间不会自动标 Late、不显示迟到分钟数(clock-in 写死 `status: 'present'`,`HrAttendance.tsx` ~767)。

现状有利条件:`attendance` 表已有 `late_minutes int default 0` 且 status 枚举含 `late`(**零数据库迁移**);`MyAttendance.loadBreakAllowance()`(~674)已按 `staff_id + 今天` 查询排班行,只是 select 只取了休息时长。

## 决定(用户已确认)

- **迟到严格判定,无宽限期**:打卡时间 > 班次 `start_time` 即 late,哪怕 1 秒。
- **两处可见**:考勤页显示当天班次 + 开放员工访问 My Schedule(未来 4 周)。

## 改动

### 1. 纯函数(可单测)— `src/shared/lib/attendance.ts`(新)

```ts
export function calcLateness(clockInIso: string, dateStr: string, startTime: string):
  { isLate: boolean; lateMinutes: number }
```

- 基准 = `new Date(`${dateStr}T${startTime}`)`(本地时区,与全 app 的 todayStr/fmtTime 一致)。
- `diffMs = clockIn - 基准`;`isLate = diffMs > 0`;`lateMinutes = isLate ? Math.ceil(diffMs / 60000) : 0`(晚 30 秒 → 1 分钟,不出现 "Late 却 0 分钟")。
- Vitest:准点(不迟到)、晚 30 秒(1)、晚 12 分(12)、早到(0)、跨午夜不考虑(班次不跨天,现状约束)。

### 2. 考勤页(`HrAttendance.tsx` — `MyAttendance`)

- `loadBreakAllowance()` 的 select 扩为 `leave_type, shift_type:shift_types(*)`,新增 state `todayShift: ShiftType | null`、`todayLeave: LeaveType | null`(休息时长逻辑不变,从同一结果取)。
- **TODAY 卡片**日期下方新增一行:
  - 有班 → 班次徽章:名称 + `fmtTime(start)–fmtTime(end)` + 时长(部门配色,同排班页 ShiftBadge 风格,可就地小实现不强求复用);
  - `todayLeave` 非空 → `🌴 {SCHEDULE_LEAVE_LABELS[leave]}`;
  - 都无 → 灰字 `No shift scheduled today`。
- **clock-in 写入**:upsert 前若 `todayShift` 存在,用 `calcLateness(now, todayStr(), todayShift.start_time)`;isLate → `status: 'late', late_minutes`,否则 `status: 'present', late_minutes: 0`。无班次 → 照旧 present(无基准不判迟到)。
- **显示迟到**:今天已打卡且 `today.status === 'late'` → "Clocked in at …" 行旁红色 chip `Late by {late_minutes} min`。

### 3. 经理端显示(`HrAttendance.tsx` — `DailyRoster`)

- 状态徽章为 late 时追加分钟数:`Late · 12m`(读 `rec.late_minutes`,已在 `select *` 里)。月度网格/员工月历史沿用现有状态章,自动显示 Late,不另改。

### 4. 员工开放 My Schedule

- `App.tsx`:`/schedule` 路由去掉 `requireCap="manage_schedule"`,改普通登录保护(页面内部已按 `isManager` 分流:员工只看到 "My Upcoming Schedule",经理功能不受影响)。
- `Sidebar.tsx`:员工区(STAFF nav)新增 `My Schedule` 项指向 `/schedule`,**仅当用户没有 `manage_schedule` 能力时显示**(经理保留原 MGMT 区 "Schedule" 项,不出现重复)。

## 不做

- 不动 GPS/自拍与 clock-out 逻辑;不做迟到扣薪或与月度 review `late_count` 联动;经理手动改状态/Mark all present 照旧(误判可人工纠正);不处理跨午夜班次;请假日打卡覆盖状态的既有行为不变。

## 测试要点

`calcLateness` 全边界(上述);构建 0 错;手动:排班 9:30 的账号 9:31 打卡 → TODAY 卡片红 chip + 经理日视图 `Late · 1m`;无排班账号打卡 → present;员工侧边栏出现 My Schedule 且能看四周排班,经理侧边栏无重复项。

## 范围

`HrAttendance.tsx`、`App.tsx`(1 行)、`Sidebar.tsx`(1 项)、新纯函数+测试。零 SQL。
