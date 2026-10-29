# 考勤报表(Attendance Report)设计

Status: Approved
Date: 2026-08-01

## 背景

经理要判断某人一段时间的出勤情况,目前只能在 Daily 视图里一天天翻页。现有 Monthly 视图是"整月×全员"的色块矩阵,适合扫缺勤,但没有汇总数字、不能自定义日期范围、看不到具体打卡时刻与休息时间。

## 目标

考勤页新增第三个视图 **Report**,一次看清一段时间内的出勤全貌:汇总统计 + 每日明细(含上下班时刻、休息时段),支持自定义日期范围与 CSV 导出。

## UI

顶部 tab:`Daily | Monthly | Report`(新增第三项)。

**筛选条**
- 日期范围快捷键:过去 7 天 / 过去 30 天 / 本月 / 上月;另有自定义起止日期输入(两个 date input)
- 员工:全部 / 指定单人(下拉)
- 沿用现有分店/部门筛选器

**汇总表(一人一行)**
列:员工 | 出勤天数 | 迟到次数 | 迟到总分钟 | 缺勤 | 请假 | 半日 | 未打卡 | 休息超时次数
- 迟到次数/分钟、缺勤、未打卡、休息超时 为非零时高亮(红/琥珀),零则淡显
- **未打卡** = 当天有排班(scheduled_shifts 有该员工该日的班次行,leave_type 为空)但 attendance 无 clock_in 的天数
- 点行展开该员工的每日明细

**每日明细(展开区 / 选中单人时直接铺开)**
列:日期 | 星期 | 班次(名称+计划时间) | 上班打卡 | 下班打卡 | 工时 | 休息 1 | 休息 2 | 迟到 | 状态 | GPS
- 上班/下班打卡:`9:32am` 格式;无记录显示 `—`
- 休息 N:`12:05pm–12:38pm (33m)`,超时追加红色 `+3m`;无该段显示 `—`
- 工时:clock_out − clock_in − 休息实际总时长;缺任一端显示 `—`
- 迟到:`+12m` 红色;准时留空
- 状态:沿用现有 ATTENDANCE_STATUS_LABELS 徽章

**导出 CSV**:两个按钮 —— 汇总 CSV / 明细 CSV,导出当前筛选范围(复用 toCSV/downloadCSV)

## 数据

三个查询(按日期范围 + 范围内员工):
1. `attendance` — 主数据
2. `attendance_breaks` — `.in('attendance_id', attIds)`(复用 DailyRoster 写法)
3. `scheduled_shifts` + `shift_types` — 用于"未打卡"判定与明细里的班次列

纯计算抽成可单测函数(`src/shared/lib/attendance-report.ts`):
- `summarizeAttendance(rows, breaks, shifts)` → 每人一行的汇总对象
- `computeWorkedMinutes(clockIn, clockOut, breakMinutesTotal)` → 工时(缺端返回 null)
- `formatBreakWindow(b)` → 明细里的休息展示字符串

## 权限

沿用 canReviewStaff 之外的既有考勤规则:manager 级看全部;supervisor 沿用现有 `ownBranchOnly` + branch 过滤(与 Daily/Monthly 视图一致,不在本次改变考勤的可见范围规则)。

## 不做

- 不改数据库(零 SQL)
- 不动 Daily / Monthly 现有视图与行为
- 不做工资/加班费计算;不做图表(纯表格)
- 不做跨月自动分页(范围过大时按查询上限自然截断,UI 提示)

## 测试要点

`summarizeAttendance` 单测:迟到累计、缺勤/请假/半日计数、未打卡判定(有班无打卡 vs 请假标记不算)、休息超时计数、空数据。`computeWorkedMinutes`:正常、缺 clock_out、跨午夜班次(clock_out < clock_in 视为跨日 +24h)。

## 范围

`src/features/hr/HrAttendance.tsx`(新增 Report 组件 + tab)、新纯函数文件 + 测试。零 SQL、零迁移。
