# Feedback 功能设计

Status: Approved
Date: 2026-10-29

> 沿用同目录既有体例:正文中文,所有 UI 文案、字段名、错误提示一律英文。

## 背景

Owner 想让员工遇到问题时能很快反馈,自己也能集中收到。入口要明显。

已和 Owner 逐条确认的决定:

1. **四个分类**:出品品质、新品/菜单建议、Craft OS 系统问题、公司/职场(含投诉)。
2. **只有 Owner 能看和处理**,四类都进 Owner 一个人的 Inbox。以后要放开再加 capability。
3. **只有 Workplace 分类可以匿名**。匿名 = 连 Owner 也看不到是谁,数据库不存提交人。
4. **沟通方式 = 状态 + Owner 的一条回复**。员工收到通知;要追问就线下找人,不做来回对话。

### 现状核实

- **没有任何反馈入口**。
- **侧栏**(`Sidebar.tsx`):电脑是固定左栏,手机是顶栏 + 汉堡抽屉。通知铃铛在 `Sidebar()` 里只挂一次、
  `fixed` 定位(`Sidebar.tsx:201`)。手机上抽屉默认收起,**只放侧栏项的话员工看不到**。
- **导航树**在 `nav.ts` 的 `NAV`,按 capability 过滤。没有 owner-only 的 capability
  (`manage_system_roles` 语义不对),所以 Owner 判断直接用 `staff.system_role === 'owner'`,
  和 SQL 侧 `current_system_role() = 'owner'` 一致。
- **固定在底部的元素只有一个**:Settings 的 toast,`fixed bottom-6 right-6 z-50`(`Settings.tsx:58`)。
- **`ErrorBoundary` 只包了 `StaffProfile`**(`StaffProfile.tsx:201`),App 其余页面出错时没有兜底。
- **`notifications` 表**有 `unique (recipient_id, event_type, subject_staff_id, subject_date)`
  (`migration-2026-09-02-late-reason-notifications.sql:972`)。反馈通知把 `subject_staff_id`
  和 `subject_date` 都留 null:NULL 在 unique 里互不相等,同一人同一天多条反馈不会互相顶掉。
  RLS 只让收件人读自己的通知,写入走 security definer 函数(与 `notify_late()` 同一套路)。
- **附件现状**:Tasks 用公开 bucket `task-attachments` + `getPublicUrl`(`tasks/api.ts:288`)。
  反馈里有投诉和品质照片,**不能用公开链接**。

## 方案选择

| 方案 | 结论 |
|---|---|
| **A. 新表 `feedback`,写入只走 security definer 函数** | **采用**。匿名在数据库层真匿名,权限最干净 |
| B. 每条反馈变成派给 Owner 的 Task | 不采用:做不了匿名,和工作任务混在一起 |
| C. 外接 Google Form / Notion | 不采用:带不上页面信息,员工看不到进度 |

## 数据层

新文件 `supabase/migration-2026-10-29-feedback.sql`,幂等,沿用 drop-if-exists-then-add 的约束写法。

### `feedback` 表

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | `uuid` pk | **由客户端生成**(`crypto.randomUUID()`),好让照片先按 id 上传 |
| `category` | `text not null` | check in `('product_quality','product_idea','system','workplace')` |
| `message` | `text not null` | check `char_length(btrim(message)) between 1 and 2000` |
| `branch` | `text` | 可空。默认填员工所在分店,员工可改 |
| `page_path` | `text` | 提交时所在页面,如 `/hr/leave` |
| `context` | `jsonb not null default '{}'` | `userAgent`、`appVersion`,报错页来的再加 `errorMessage` |
| `photo_paths` | `text[] not null default '{}'` | check `cardinality(photo_paths) <= 3` |
| `is_anonymous` | `boolean not null default false` | |
| `submitted_by` | `uuid references staff(id) on delete set null` | 匿名时为 null |
| `status` | `text not null default 'new'` | check in `('new','in_review','resolved')` |
| `owner_reply` | `text` | check 长度 ≤ 2000 |
| `replied_at` | `timestamptz` | |
| `created_at` / `updated_at` | `timestamptz not null default now()` | |

约束:

- `feedback_anonymous_only_workplace`:`not is_anonymous or category = 'workplace'`
- `feedback_anonymous_no_submitter`:`not is_anonymous or submitted_by is null`
- `feedback_anonymous_no_photos`:`not is_anonymous or cardinality(photo_paths) = 0`

索引:`(status, created_at desc)`,`(submitted_by, created_at desc)`。

### RLS

- `feedback_select`:`submitted_by = auth.uid() or current_system_role() = 'owner'`
- **不建 insert / update / delete policy**。所有写入只能走下面两个函数。

### `submit_feedback(...)` — security definer

参数:`p_id, p_category, p_message, p_branch, p_page_path, p_context, p_photo_paths, p_anonymous`。

1. `auth.uid()` 为 null → 拒绝。
2. `p_anonymous and p_category <> 'workplace'` → 拒绝 `Only Workplace feedback can be anonymous.`
3. 插入一行:`submitted_by = case when p_anonymous then null else auth.uid() end`。
   匿名时 `photo_paths` 强制 `'{}'`,`context` 只保留 `appVersion`(userAgent 也可能认出人)。
4. 给每个 `system_role = 'owner'` 且在职的员工插一条通知:
   - `event_type = 'feedback_submitted'`
   - `title = 'New feedback: <Category label>'`
   - `body` = message 前 120 字
   - `link = '/feedback?tab=inbox&id=<id>'`
   - `subject_staff_id`、`subject_date` 留 null
5. 返回新行 id。

### `reply_feedback(p_id, p_status, p_reply)` — security definer

1. 调用者 `current_system_role() <> 'owner'` → 拒绝 `Only the owner can reply to feedback.`
2. 更新 `status`、`updated_at`;`p_reply` 非空且与原值不同时写 `owner_reply` + `replied_at = now()`。
3. `submitted_by` 非 null 时给提交人发通知:`event_type = 'feedback_updated'`,
   `title = 'Your feedback was updated'`,`body` = 新状态 + 回复前 120 字,`link = '/feedback?id=<id>'`。
   匿名的不发(没有收件人)。

两个函数都显式 `revoke all ... from public` + `grant execute ... to authenticated`,沿用 `notify_late()` 的做法。

### 照片存储

- **私有** bucket `feedback-photos`,路径 `<feedback_id>/<n>.<ext>`,单张 ≤ 5 MB,只收 `image/*`。
- storage policy:
  - insert:authenticated,且路径第一段是合法 uuid。
  - select:Owner;或该 `feedback.submitted_by = auth.uid()`。
- 查看用 `createSignedUrl`(1 小时有效)。
- **匿名不能附照片**:`storage.objects.owner` 会记下上传人的 uid,照片会暴露身份。表单里写明。
- 提交流程:先传照片,再调 `submit_feedback`。函数失败时客户端删掉刚传的照片(同 `tasks/api.ts:302` 的清理做法)。

### 匿名的边界(要在 UI 和交付说明里讲清楚)

App 和数据库层面,连 Owner 也查不到是谁。但 Supabase 的 API 日志会短期保留请求元数据,
所以不是绝对不可追溯。UI 文案不承诺「完全无法追溯」。

## 前端

新目录 `src/features/feedback/`。

### 文件

| 文件 | 职责 |
|---|---|
| `types.ts` | `FeedbackCategory`、`FeedbackStatus`、`Feedback` 类型;`CATEGORY_LABELS`、`STATUS_LABELS` |
| `api.ts` | `submitFeedback()`(上传照片 → RPC → 失败清理)、`replyFeedback()`、`listMyFeedback()`、`listInbox()`、`photoUrls()` |
| `validate.ts` | 纯函数 `validateFeedbackDraft(draft)`,返回错误列表;单测覆盖 |
| `feedbackBus.ts` | `openFeedback(prefill?)` / `useFeedbackRequests()`:极小的事件总线,让报错页和悬浮按钮打开同一个表单 |
| `FeedbackButton.tsx` | 悬浮按钮 + 挂载 `FeedbackSheet`,在 `Sidebar()` 里和铃铛一样只挂一次 |
| `FeedbackSheet.tsx` | 底部弹出的提交表单 |
| `FeedbackPage.tsx` | `/feedback` 页面:`My Feedback` 标签;Owner 多一个 `Inbox` 标签 |
| `FeedbackDetail.tsx` | 单条详情;Owner 视图带状态下拉和回复框 |

### 分类文案

| 值 | Label | 说明文字 |
|---|---|---|
| `product_quality` | `Product Quality` | `Food, drinks or ingredients not up to standard` |
| `product_idea` | `Product Idea` | `Menu ideas or new product suggestions` |
| `system` | `App / System Issue` | `Something in Craft OS is broken or hard to use` |
| `workplace` | `Workplace / Complaint` | `Company, policies, or colleagues` |

状态:`New` / `In review` / `Resolved`。

### 悬浮按钮

- 胶囊样式,图标 + 文字 `Feedback`。不做纯图标按钮。
- 位置 `fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-30`。
  低于抽屉遮罩(z-40):手机抽屉打开时按钮被遮住是对的。
- 所有已登录页面都显示,`/login`、`/register` 等页面不显示(它们不渲染 `Sidebar`)。
- **Settings toast 上移**到 `bottom-20`,避免两者重叠。

### 提交表单 `FeedbackSheet`

从底部弹出(电脑上是居中弹窗)。字段依次为:

1. 分类:四张卡片单选,必选。
2. `Message`:多行文本,必填,最多 2000 字,显示剩余字数。
3. `Photos (optional)`:最多 3 张,可拍照或选图。
4. `Branch`:默认员工所在分店,可改,可清空。
5. 只有选了 Workplace 才出现 `Submit anonymously` 开关。打开后:
   - 照片区隐藏(已选的照片清空),提示 `Photos can't be attached to anonymous feedback.`
   - 提示 `You won't see this in My Feedback or get a reply.`

提交按钮 `Send feedback`。成功后提示 `Thanks — your feedback was sent.` 并关闭。
失败时表单内容保留,显示错误信息。

`page_path` 和 `context` 自动带上,不显示给员工。

### `/feedback` 页面

- 侧栏 `NAV` 末尾加叶子 `{ id: 'feedback', label: 'Feedback', to: '/feedback' }`,所有人可见。
  Sidebar 渲染时,Owner 在这一项旁显示 `status = 'new'` 的数量徽标。
- **`My Feedback`**:自己实名提交的列表,显示分类、摘要、状态、日期;点开看全文、照片和 Owner 回复。
  空状态:`No feedback yet. Tap Feedback to send one.`
- **`Inbox`**(仅 Owner):
  - 按状态(默认 `New` + `In review`)和分类筛选,新的在前。
  - 详情显示提交人姓名(匿名显示 `Anonymous`)、分店、页面、时间、照片、context。
  - 状态下拉 + 回复框,按钮 `Save`。
- URL 参数 `?tab=inbox&id=<id>` 直接打开对应详情,通知链接靠它。
- 非 Owner 访问 `?tab=inbox` 时回落到 `My Feedback`。

### 报错页入口

- `AppLayout` 里把 `<main>` 的内容包进 `ErrorBoundary`,`key={pathname}`,换页时自动复位。
  `Sidebar` 和悬浮按钮在 boundary **之外**,页面崩了它们照样能用。
- `ErrorBoundary` 加一个按钮 `Report this problem`,调用
  `openFeedback({ category: 'system', errorMessage })`,打开同一个表单,分类预选为 System。
- `StaffProfile` 里原有的 `ErrorBoundary` 保留,它也会显示这个按钮。

## 错误处理

| 情况 | 处理 |
|---|---|
| 照片上传失败 | 不调 RPC,提示 `Couldn't upload photo. Try again.`,表单保留 |
| RPC 失败 | 删除已上传照片,显示服务器错误信息,表单保留 |
| 照片清理失败 | `console.error` 留路径,不打扰用户(同 Tasks 做法) |
| 照片超过 5 MB 或不是图片 | 选图时拦下,提示 `Photos must be images under 5 MB.` |
| 非 Owner 直接调 `reply_feedback` | 函数拒绝 |
| 非 Workplace 带匿名直接调 `submit_feedback` | 函数拒绝,表约束兜底 |

## 测试

**Vitest**

- `validate.test.ts`:空 message、超长、照片超过 3 张、非 Workplace 匿名、匿名带照片。
- `nav.test.ts`:`Feedback` 对所有角色可见。
- `FeedbackSheet.test.tsx`:匿名开关只在 Workplace 出现;打开后照片区隐藏。
- `FeedbackPage.test.tsx`:非 Owner 看不到 `Inbox` 标签,`?tab=inbox` 回落。

**SQL 验证**:`supabase/VERIFY-2026-10-29-feedback.sql`,在 dev 跑:

- 匿名提交后 `submitted_by` 为 null、`photo_paths` 为空、`context` 只剩 `appVersion`。
- 非 Workplace 匿名被拒。
- 普通员工 select 不到别人的反馈;Owner 能看到全部。
- 普通员工调 `reply_feedback` 被拒。
- 提交后每个 Owner 收到 `feedback_submitted`;回复后实名提交人收到 `feedback_updated`,匿名的没有通知。
- 同一员工同一天提交两条,两条通知都在。

**浏览器实测(dev)**:手机尺寸下按钮位置、提交带照片、Owner 回复后员工收到通知、
故意触发页面报错后 `Report this problem` 能提交。

## 上线顺序

1. 在 dev(craft-os-dev)跑 migration + VERIFY,浏览器实测。
2. prod 跑 migration + VERIFY(Claude 直接执行)。
3. 开 PR 合并到 `main`,push。

## 不做(YAGNI)

- 来回对话、员工追加留言。
- 按分类分派给其他角色;`manage_feedback` capability。
- 匿名反馈的回复或追踪码。
- 邮件 / WhatsApp 通知。
- 反馈统计报表。
