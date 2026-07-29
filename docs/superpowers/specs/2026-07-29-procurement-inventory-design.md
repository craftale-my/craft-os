# Procurement & Inventory(采购与库存)Phase 1 设计

Status: Pending approval
Date: 2026-07-29
Branch: `feature/po-system`(不 merge 进 main)

## 背景与范围

Craft OS 现有模块围绕「人」(staff / HR / schedule / reviews)。本模块引入第一个围绕「物」的子系统:供应商、物料、采购单、收货、库存。

Phase 1 范围:
- Suppliers / Items 基础管理
- Purchase Order 下单 + 可分享文本(WhatsApp)
- Receiving 收货(含短缺与实际单价录入)
- Inventory 库存总览 + 流水

Phase 1 **不做**:成品/半成品物料、生产(production)、销售扣减(sales)、损耗(wastage)、盘点(stocktake)、PDF 生成、多次分批收货、Staff 角色开放。

## 关键决策(已与用户确认)

| 决策 | 选择 | 理由 |
|---|---|---|
| 价格历史图表 | 手写 SVG,不引入 recharts | 现有唯一图表 `ScoreChart.tsx` 就是手写 SVG;零新依赖,视觉统一 |
| 收货模型 | 一张 PO 只收一次 | 短缺记录后关单(`partially_received`),后续人工跟供应商;DB 层用唯一索引强制 |
| 权限接法 | 新增 2 个 capability | 沿用 `DEFAULT_SYSTEM_ROLE_CAPS` + Settings → System Roles 矩阵 |
| Git | 先把 auth 改动 commit 到 main | 再从干净 main 开 `feature/po-system` |

## 一、权限模型

新增两个 capability,加入 `src/shared/types/index.ts` 的 `Capability` 联合类型、`CAPABILITIES` 列表和 `DEFAULT_SYSTEM_ROLE_CAPS`:

| Capability | 含义 | owner | admin | hr | manager | supervisor | staff |
|---|---|---|---|---|---|---|---|
| `manage_procurement` | 供应商 / 物料主数据管理 | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |
| `use_procurement` | 下单 / 收货 / 看库存 | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ |

分店范围沿用现有 `all_branches`:supervisor 该项为 `false`,只能看自己 `branch_id` 的采购单、收货、库存。

前端用现有 `useCan()` / `<ProtectedRoute requireCap>` 门禁;SQL 侧由 `has_procurement_cap()` 与 `can_access_branch()` 两个 security definer 函数兜底(RLS 才是安全边界,能力矩阵是 UI 门禁)。

`has_procurement_cap()` 会读 `system_role_permissions` 表:Owner 在 Settings 里显式打开某能力时,RLS 也会跟着放行。反向(矩阵里关掉)只影响 UI,不收紧 RLS——因为代码默认值不在 SQL 里,无法在 DB 侧完整复现「默认然后被覆盖」的语义。这是刻意的取舍,记录在此。

## 二、数据库设计

完整 migration 见 `supabase/migration-2026-07-29-procurement.sql`(单独交付,由你在 dev Supabase 项目执行)。以下是设计要点。

### 表关系

```
suppliers ──< items ──< item_price_history
    │            │              │
    │            │              └──> receivings (可空)
    ▼            ▼
purchase_orders ──< purchase_order_items ──< receiving_items
    │  (branch_id)                                  │
    └──< receivings ────────────────────────────────┘
                 │
                 └──> inventory_transactions (reference_type='receiving')
```

### 设计要点

**1. `po_number` 由 DB 生成,不由客户端算**

`PO-YYYYMMDD-XXX`,BEFORE INSERT 触发器调用 `next_po_number()`。函数内用 `pg_advisory_xact_lock` 序列化同一天的并发插入,避免两个用户同时下单撞号。日期用 `Asia/Kuala_Lumpur` 时区。

**2. 库存余额用 view,不存表**

```sql
create or replace view inventory_balances with (security_invoker = true) as ...
```

`items × branches` 做 cross join,左连 `inventory_transactions` 求和——这样零库存的物料也会出现在列表里(否则新物料在库存页看不到,警戒线也无从比较)。

⚠️ `security_invoker = true` 必须加:Postgres 视图默认以视图 owner 权限执行,会绕过底层表 RLS。加上它才让 supervisor 的分店过滤生效。

**3. 收货是一个 RPC,不是一串前端写入**

收货要一次性完成 5 件事:写 receiving、写 receiving_items、写 inventory_transactions、写 item_price_history + 更新 latest_price、更新 PO 状态。Supabase JS 没有客户端事务,分开写一旦中途失败就会留下「库存加了但 PO 还是 sent」这类脏数据。

因此收货走单个 `submit_receiving(p_po_id, p_invoice_photo_url, p_goods_photo_url, p_notes, p_lines jsonb) returns uuid` 的 `security definer` 函数,整个操作在一个事务里。函数内部自己做授权检查(`has_procurement_cap('use_procurement')` + `can_access_branch()`),并对 PO 行加 `for update` 锁,配合 `receivings(po_id)` 唯一索引杜绝重复收货。

`receivings` / `receiving_items` / `inventory_transactions` 的 RLS 只给 SELECT,不给前端直接 INSERT——写入只能走这个 RPC。这是刻意的:保证库存流水永远有来源单据。

**4. 收货不覆盖 PO 上的下单单价**

`purchase_order_items.unit_price` 保留下单时谈好的价;invoice 上的实际单价写进 `receiving_items.unit_price` 和 `item_price_history`。两者都留着才能做「下单价 vs 到货价」的对比。

**5. `branch_id` 在 `purchase_orders` 上是 NOT NULL**

库存按分店记,没有分店的 PO 会产生无归属库存。UI 上 manager 选分店,supervisor 自动填自己的 `branch_id`。

⚠️ 已知边界:RBAC migration 当时用模糊匹配回填 `staff.branch_id`,大部分是 NULL。**没有 `branch_id` 的 supervisor 无法下单**,页面会给明确提示(「你的账号未绑定分店,请让 manager 在 Staff Management 里设置」)而不是静默失败。上线前建议先把 supervisor 的 `branch_id` 补齐。

**6. `inventory_transactions.quantity` 一律存基础单位**

收货时按 `实收数量(采购单位) × items.conversion_rate` 换算后写入。之后即使改了 `conversion_rate`,历史流水也不受影响。入库为正,出库为负(Phase 2 用)。

### Storage

新增 bucket `receiving-photos`,public(与现有 `claim-receipts` / `leave-attachments` 一致)。

⚠️ 已知限制:public bucket 意味着知道 URL 的人就能看 invoice 照片(含供应商报价)。路径带 UUID 不可猜,且与 app 现有姿态一致(claim 收据也是 public)。Phase 2 建议整体改私有 bucket + signed URL,统一处理。

## 三、前端结构

新增 `src/features/procurement/`:

| 文件 | 职责 |
|---|---|
| `Suppliers.tsx` | 供应商列表 + 新增/编辑/停用 modal |
| `Items.tsx` | 物料列表 + 新增/编辑 modal(单位换算设置) |
| `ItemDetail.tsx` | 物料详情:基本信息 + 价格历史曲线 + 各分店库存 |
| `PurchaseOrders.tsx` | PO 列表,按状态筛选 |
| `PurchaseOrderNew.tsx` | 下单:选供应商 → 该供应商物料 → 填数量 → draft / sent |
| `PurchaseOrderDetail.tsx` | PO 详情 + 可复制的 WhatsApp 文本 + 「去收货」入口 |
| `Receiving.tsx` | 收货界面(下面单独说) |
| `Inventory.tsx` | 库存总览 + 点进去看流水 |

配套:
- `src/shared/components/PriceHistoryChart.tsx` — 手写 SVG 折线图,照搬 `ScoreChart.tsx` 的写法
- `src/shared/lib/procurement.ts` — 纯函数(单位换算、短缺计算、PO 状态推导、WhatsApp 文本格式化、价格涨跌判断)
- `src/shared/lib/procurement.test.ts` — 上述纯函数的 vitest 测试,与现有 `attendance.test.ts` / `leave.test.ts` 同一模式
- `src/shared/types/procurement.ts` — 类型单独成文件,由 `types/index.ts` re-export

类型另开文件而不是往 `index.ts` 里塞:那个文件已经 885 行,采购模块会再加 ~150 行。`export * from './procurement'` 让现有 import 路径完全不变。

### 侧边栏

在 Management 区块**下方**新增 PROCUREMENT 区块:

| 项 | 路由 | Capability |
|---|---|---|
| Suppliers | `/procurement/suppliers` | `manage_procurement` |
| Items | `/procurement/items` | `manage_procurement` |
| Purchase Orders | `/procurement/orders` | `use_procurement` |
| Receiving | `/procurement/receiving` | `use_procurement` |
| Inventory | `/procurement/inventory` | `use_procurement` |

Supervisor 看到后三项。物料主数据虽然管理页对 supervisor 隐藏,但 RLS 的 SELECT 给了 `use_procurement`——因为下单必须能读到物料和价格。

### UI 风格

沿用现有约定:`inputCls` / `labelCls` 常量、`fixed inset-0 z-50 bg-black/40` modal、`#C4813A` 主按钮、`bg-white rounded-xl border-[#E8DDD0]` 卡片、`useToast()`。不引入新 UI 依赖。

## 四、收货界面(重点交互)

每个 item 一行:

```
┌────────────────────────────────────────────────┐
│ 咖啡豆 Coffee Beans                             │
│                                                │
│   应到   12 包        ← 大字,视觉基准           │
│                                                │
│  [ ✓ 数量一致 ]  [ 数量不符 ]                   │
│                                                │
│  本次单价  RM [ 45.00 ]   下单价 RM 45.00       │
└────────────────────────────────────────────────┘
```

点「数量不符」展开数量输入框,实时算差额并标红 `短缺 2 包`。

单价输入框预填 `purchase_order_items.unit_price`(下单时谈好的价),不是 `items.latest_price`——对比基准应该是本单谈好的价格。改动时右侧显示 `↑ +RM 3.00 (+7.1%)` 红色 / `↓ -RM 2.00 (-4.4%)` 绿色。

整单:
- Invoice/DO 照片 **必填**(未上传时提交按钮 disabled + 提示)
- 货物照片可选
- 签收人 = 当前登录用户,自动记录,不可改

提交 → 调 `submit_receiving` RPC → 成功后跳回 PO 详情,显示收货结果摘要。

## 五、库存总览

按分店筛选(supervisor 锁死自己分店,manager 可切换 / 看全部)。列表字段:物料 / 当前库存(基础单位)/ 警戒线 / 状态。

低于警戒线的标红并排在最前。点进物料看该分店流水明细(时间、类型、数量、来源单据、操作人)。

## 六、实施顺序

1. **Git 准备** — auth 改动 commit 到 main;开 `feature/po-system`
2. **DB** — 输出 migration SQL 给你在 dev Supabase 跑;同步 `schema.sql`
3. **类型 + 权限 + 路由 + 侧边栏骨架** — 两个新 capability 接进矩阵
4. **Suppliers** — 最简单,先跑通 CRUD + RLS
5. **Items** — 含单位换算表单 + 价格历史图表 + 详情页
6. **Purchase Orders** — 下单流程 + 列表 + WhatsApp 文本
7. **Receiving** — RPC 对接 + 交互
8. **Inventory** — 总览 + 流水

每步完成后你在 Preview 验证,通过再进下一步。

## 七、测试

纯函数走 vitest(现有模式);UI 靠 Preview 人工验证。要覆盖的纯函数:

- `toBaseUnits(qty, conversionRate)` — 单位换算
- `calcShortage(ordered, actual)` — 短缺(不为负)
- `derivePoStatus(lines)` — 全收 → received;有短缺 → partially_received
- `formatPoText(po, supplier, branch, lines)` — WhatsApp 文本格式
- `priceDelta(ordered, actual)` — 涨跌方向与百分比
- `isBelowAlert(balance, minStockAlert)` — 警戒线判断

## 八、风险与待确认

1. **supervisor 的 `branch_id` 大多为 NULL** — 上线前需补齐,否则 supervisor 无法下单。UI 会明确提示而非静默失败。
2. **invoice 照片存 public bucket** — 与 app 现有姿态一致,但含供应商报价。Phase 2 统一改私有 + signed URL。
3. **能力矩阵的「关闭」不收紧 RLS** — 见第一节说明,刻意取舍。
4. **一张 PO 只收一次** — 供应商分批到货的场景 Phase 1 不支持,需人工另开 PO。
