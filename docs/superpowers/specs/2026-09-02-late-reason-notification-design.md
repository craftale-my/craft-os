# 迟到申诉(Late Reason)+ 站内通知设计

Status: Approved
Date: 2026-09-02

> 文档正文沿用同目录 2026-07-08 考勤设计的中文体例;所有 UI 文案、字段名、通知内容一律英文。

## 背景

用户最初的诉求是「员工迟到时,让上司和员工本人都收到提醒」。追问后确认真正的缺口不是「有没有显示」——
打卡后已经会弹 `Clocked in at 09:31 — late by 1 min ⚠️`(`HrAttendance.tsx:855`)且 TODAY 卡片有红 chip
(`:987`)——而是**员工没有渠道说明原因**。堵车、看医生、公事外出,现在全都变成一个干巴巴的数字,
到月底才在考核里变成争议。

所以这个功能的本体是**迟到申诉流程**,站内通知是它的载体。

### 现状核实(动手前逐条 grep 确认)

- **没有上司字段**。全仓库无 `supervisor_id` / `manager_id` / `reports_to`。现有上下级是推导的:
  `can_review_staff()`(`supabase/migration-2026-07-10-supervisor-review-scope.sql:13`)= 同分店 + 同部门
  (字符串相等)+ 对方 rank 属于 trainee/junior/senior。部门数据已知不干净(表上 CHECK 只允许
  barista/bakery/kitchen,实际库里另有 service crew、management),某个分店某部门无人挂 supervisor 时,
  通知会**静默送达不了任何人**。
- **没有 notifications 表**。完全不存在。
- **`notification_settings` 是空壳**。表在(`schema.sql:426`),带 `notify_staff / notify_supervisor /
  notify_manager` 三个开关,但没有任何代码读它去发东西——全仓库只有设置页读写它自己
  (`Settings.tsx:1582`、`1941`)。该网格是 map 现有行渲染,**加一行种子数据,开关自动出现,零 UI 代码**。
- **realtime publication 里只有 `tasks`**(`migration-2026-08-14-tasks-projects.sql:282`)。
- 打卡本来就是模态流程(自拍 + GPS → `handleClockDone` 拿 `ClockResult` 才写库,`HrAttendance.tsx:834`),
  且迟到判定就在写库之前算好(`:839`)。申诉是插进已有流程的一步,不是新增打断。

## 决定(用户已确认)

1. **目的**:员工本人当场知情为主(避免月底才发现有争议),上司同步知情。
2. **缺口**:员工无法申诉 → 迟到时必须能说明原因。
3. **理由的效力**:上司可豁免,但**留痕**——记录仍是 `status='late'`,另打 `late_excused` 标记;
   月度评分排除已豁免的天。不改写历史。
4. **时机**:强制填,不填不能完成打卡。
5. **门槛分档**:迟到 ≤15 分钟点选快捷原因即可;>15 分钟必须手打文字说明。15 可在设置页调。
6. **范围**:申诉 + 站内通知台(建 notifications 表 + 未读铃铛)。**不做**服务器巡检。
7. **收件人**:新增 `staff.supervisor_id` 明确指定,不沿用推导规则。

### 8. 兜底规则(设计者补充,用户已授权决定 → 保留)

`supervisor_id` 可空,回填后必然残留 null。为避免退回「静默送达不了任何人」的老问题,
当 `supervisor_id` 为空时**兜底送给该分店的 manager/owner**。

关键在于**兜底必须是可见的,不是静默的**:这类通知的正文追加一句
`No supervisor is assigned to this staff member.`,并在通知里带一个指向该员工资料页的链接。
这样一条本会消失的提醒,变成一次「去把上司关系补上」的提示——数据缺口会被自己暴露出来并逐步收敛,
而不是安静地烂在库里。

## 改动

### 1. 数据库(一段幂等 SQL,按 `PROJECT_NOTES.md` 惯例手贴生产库)

```sql
alter table staff add column if not exists supervisor_id uuid references staff(id) on delete set null;

alter table attendance add column if not exists late_reason_code  text;
alter table attendance add column if not exists late_reason       text;
alter table attendance add column if not exists late_excused      boolean not null default false;
alter table attendance add column if not exists late_excused_by   uuid references staff(id);
alter table attendance add column if not exists late_excused_at   timestamptz;

create table if not exists notifications (
  id               uuid primary key default gen_random_uuid(),
  recipient_id     uuid not null references staff(id) on delete cascade,
  event_type       text not null,
  title            text not null,
  body             text,
  link             text,
  subject_staff_id uuid references staff(id) on delete cascade,
  subject_date     date,
  read_at          timestamptz,
  created_at       timestamptz not null default now(),
  unique (recipient_id, event_type, subject_staff_id, subject_date)
);
```

- `late_reason_code` 取值:`traffic / transport / medical / work_errand / personal / other`。
- **unique 约束是防刷屏的关键**:同一收件人 + 同一事件 + 同一员工 + 同一天只有一条。函数一律
  `on conflict do update`(刷新 title/body,不新增行)。注:本期没有「事后修改理由」的入口,
  该约束是为重复触发与后续扩展留的余量。
- **RLS**:`notifications` 只能 select `recipient_id = auth.uid()`;update 只允许改 `read_at`。
- **插通知必须走 `security definer` 函数 `notify_late(...)`**——员工本人没有权限往上司收件箱插行,
  直接 insert 会被 RLS 挡掉。函数内解析收件人(本人 + supervisor_id,空则兜底 manager/owner),
  按 `notification_settings` 的 `notify_staff / notify_supervisor / notify_manager` 开关决定实际发给谁。
- **豁免权限**:`late_excused*` 三列的 update 限本人的 supervisor 及 manager/owner。
- 种子:`insert into notification_settings values ('attendance_late', 'Late Arrival', true, true, false)`。
- 设置项:`late_reason_written_threshold` 默认 `15`(与已有 `late_deduction` 同一张设置表,体例一致)。
- `notifications` 加进 realtime publication,照抄 `migration-2026-08-14-tasks-projects.sql:280` 的幂等 do-block。
- **回填 `supervisor_id`**:取每人 `monthly_reviews.reviewer_id` 的最近一次;补不上的用该分店
  `branches.pic_staff_id`(`schema.sql:366`);仍为空的在员工资料页手动指定(新增一个选择器)。

### 2. 纯函数(可单测)— `src/shared/lib/lateReason.ts`(新)

```ts
export const LATE_REASON_CODES = ['traffic','transport','medical','work_errand','personal','other'] as const
export const LATE_REASON_LABELS: Record<LateReasonCode, string>   // 英文文案
export function requiresWrittenExplanation(lateMinutes: number, thresholdMinutes: number): boolean
```

`requiresWrittenExplanation` = `lateMinutes > thresholdMinutes`(15 分钟不需要打字,16 需要)。

### 3. 打卡流程(`HrAttendance.tsx` — `MyAttendance`)

**不迟到的人流程完全不变**,一步打完。仅迟到时在 `handleClockDone`(`:834`)算出 `lateness.isLate` 后
插入一步 `LateReasonStep`,拿到理由再做**同一次** upsert(理由与考勤一起落库,不存在只写一半):

- ≤ 门槛:六个快捷原因按钮,点一个即可 Submit。
- \> 门槛:额外必填 textarea,为空时 Submit 禁用。
- 该步骤**不可关闭**(无 X、点遮罩不关),对应「不填不能打卡」。
- 无排班 → 无基准、不判迟到 → 不弹,照旧直接打卡。

文案(英文):
- 标题 `You are 12 minutes late for your 09:30 shift`
- 副标题 `Please tell your supervisor why. This will be recorded.`
- textarea placeholder `Explain what happened (required for lateness over 15 min)`

**失败处理**沿用 `db-write.ts` 的 `writeOutcome`(被 RLS 挡掉的写入是「无错误也无行」,看起来像成功):
- 考勤写失败 → 报错、维持未打卡状态,理由不丢(留在输入框)。
- 考勤成功但 `notify_late` 失败 → **打卡仍算成功**,仅提示 `Clocked in, but your supervisor could not be
  notified.` 不能因为通知发不出去而让人打不了卡。

### 4. 上司端

- 侧边栏未读铃铛 + 角标,realtime 订阅 `notifications`;点开为通知列表,点条目跳 `link`。
- 日视图(`DailyRoster`)迟到行显示理由 chip,并加 `Excuse` 按钮 → 写 `late_excused/by/at`,
  显示变为 `Late · 12m · Excused`。
  - 可达性已确认:`supervisor` 默认带 `manage_hr: true` + `all_branches: false`
    (`src/shared/types/index.ts:84`),即能进经理视图、范围限本分店(`HrAttendance.tsx:1202` 的
    `scopedStaff`)。但该矩阵是**默认值**,owner 可在 Settings → System Roles 覆盖,不能当常量写死。
  - **`Excuse` 的 UI 门必须与 RLS 判据逐字一致**(`me.id === target.supervisor_id` 或 manager/owner)。
    注意 `manage_hr` 的范围是整个分店,比 `supervisor_id` 宽——若照 `manage_hr` 显示按钮,
    就会出现「按钮能点、RLS 挡掉、界面却显示成功」,正是 commit 0ccfda3 刚修过的那类缺陷。
- 通知文案(英文):
  - 给上司 `Late arrival — Ahmad Faiz` / `Clocked in 12 min late for the 09:30 shift. Reason: Traffic.`
  - 给员工本人 `You were marked late today` / `Clocked in 12 min late for the 09:30 shift. Reason recorded: Traffic.`

### 5. 月度评分

`src/features/team/Reviews.tsx:389` 的 late 计数查询加一个条件 `.eq('late_excused', false)`。
**全系统仅此一处**碰评分,已豁免的天不再计入 `late_count`,也就不触发 `attendance_score`
每迟到日 10 分的扣分(`schema.sql:209`)。

## 不做

- 不做服务器巡检(pg_cron 扫「班次已开始 N 分钟仍未打卡」)——用户明确选择不做,盲区见下。
- 不做 email / WhatsApp / Web Push。notifications 表是公共脊椎,日后接任何渠道只换发送端,检测逻辑不重建。
- 不回填历史考勤记录(旧规则下产生的迟到日与扣分保持原样,另行决定)。
- 不动 GPS/自拍、clock-out、`mark_absent_for_missed_shifts`。

## 已知盲区与风险

1. **抓不到「根本没来」和「忘记打卡」**。理由是在打卡那一刻问的,没打卡就没有事件。现有服务端兜底
   `mark_absent_for_missed_shifts` 要等**班次结束**才跑(`migration-2026-07-09-auto-absent.sql:49`,每小时 :10),
   9:30–18:00 的班,没来的人要到 **18:10** 才变成 absent。这是本方案范围外的洞,用户已知悉。
2. **排班表升级为纪律依据**。没排班 → 不可能判迟到 → 功能对该员工静默失效。以前排班填漏只是不方便。
3. **`supervisor_id` 回填质量**决定通知覆盖率;兜底规则是防止静默丢失的最后一道。
4. SQL 手贴生产库、无 staging 演练(`PROJECT_NOTES.md`),迁移必须幂等、可重复执行。

## 测试要点

- `requiresWrittenExplanation` 边界:15 → false,16 → true。
- 迟到 → 必须选理由才能提交;>门槛 → 文本为空时 Submit 禁用。
- 不迟到 / 无排班 → 不弹申诉步骤,打卡流程与现状逐字一致。
- 写失败不被静默吞掉(沿用 `HrAttendance.write-failure.test.tsx` 既有模式)。
- 通知去重:同一员工同一天两次触发只有一条。
- `Excuse` 按钮只对 RLS 真正放行的人显示(非该员工 supervisor 的同分店 supervisor 看不到按钮)。
- 通知失败不阻断打卡成功。
- `Reviews` late 计数排除 `late_excused = true`。

## 范围

一段 SQL 迁移(含回填与 RLS)、`src/shared/lib/lateReason.ts`(新)+ 测试、`HrAttendance.tsx`
(申诉步骤 + 上司端 Excuse)、`Sidebar.tsx`(铃铛)、通知列表组件(新)、员工资料页 supervisor 选择器、
`Reviews.tsx`(一个条件)。
