# POS Demo（柜台 POS + 桌边 QR 点单）设计

Status: Approved（待用户审阅文档）
Date: 2026-10-22

> 沿用同目录既有体例：正文中文，所有 UI 文案、字段名、错误提示一律英文。

## 背景

用户想知道「能不能自己做出 POS」。这份设计的目标是**用一个 Demo 回答这个问题**，
不是直接取代 Feedme。Demo 跑通之后，才挑一家真实门店做试点。

### Feedme 现况（2026-10-22 在商户后台只读核实）

- 三家店：Cheras、Kepong、Puchong。后台没有开放 API 或 webhook，集成页只有会计软件
  （AutoCount、SQL、Xero、Bukku、Biztory、AutoCount Cloud、Codemax）。
- Feedme 目前负责：柜台 POS、QR 点单（门店超过六成的堂食单来自 QR，吃完到柜台付）、
  会员系统（约 1,014 个会员）、GrabFood/GrabMart 自动进单、Maybank 卡机对接、
  MyInvois 自动提交（单张发票、每月 consolidated invoice、consolidated refund note）。
- 菜单：409 个产品、37 组加料、5 条打印路线（Bakery / Bar / Basement / Front House / Kitchen），
  SST 率按产品设定（例如 Keychain 为 0%），外带包装费按产品设定，有时段菜单和会员价。
- 收据计算（以 Cheras 收据 #87846 核对）：Subtotal RM80.00 → SERVICE CHARGE (10%) RM8.00、
  SST (6%) RM4.80，**两者都以小计为基数**，SST 不叠在服务费上；另有 Bill rounding 一行；
  Total RM92.80。收据记录 `Table pax`、`Cashier`、连续递增的 `Invoice no`。

所以真正取代 Feedme 需要重做 Grab、MyInvois、Maybank 卡机三项对外对接，并迁移会员。
**这三项都不在 Demo 范围内。**

### Craft OS 现况

- 技术栈：React 19 + Vite + TypeScript + Tailwind + Supabase + Vercel，测试用 Vitest。
- 已有 `staff`、`roles`（RBAC）、`branches`、`company_settings`，可以直接沿用登录、
  员工角色和分店资料。
- 没有任何菜单或订单相关的表。采购模块的 `items`（原料）在未合并的 `feature/po-system` 上，
  与本设计无关。
- **没有 dev Supabase**：本地开发直接读写正式数据库。这是 Demo 的前置条件，必须先解决。

## 目标与范围

**做：** 菜单、柜台点单、桌边 QR 点单、桌位账单、结账、打印（吧台和厨房分开出单）、
作废和退款、交班、日结、每月 e-Invoice 资料导出、从 Feedme 导入菜单。

**不做（Demo 阶段）：** Grab、会员积分、Maybank 卡机对接（卡机金额手动输入）、
LHDN MyInvois API、折扣规则、会员价、时段菜单、多分店汇总报表、库存扣减。

## 三个阶段与检查点

### 阶段 0：技术验证（1–2 周）

三项各自要有明确的通过或不通过结论：

1. **网页打印**：iPad Safari 上的 POS 页面能否不经过系统打印对话框，直接打印到门店的
   LAN 热感打印机。Epson（ePOS-Print）和 Star（WebPRNT）支持从网页通过 HTTP 打印；
   其他品牌的普通 ESC/POS 打印机只开放 TCP 9100，网页无法直接连接，需要一个打印中转程序。
2. **实时出单**：QR 下单后，订单在 2 秒内出现在 POS，并自动产生吧台单和厨房单。
3. **断网恢复**：柜台在断网时下的单，恢复网络后自动同步，不丢单、不重复。

全部通过才进入阶段 1。打印不通过的话，先决定换打印机还是做中转程序。

### 阶段 1：MVP（4–6 周）

在 dev 环境建一家 `Demo` 分店，导入真实菜单，做出本文件描述的全部功能，
并在打烊后按「点单剧本」做完整的模拟营业（见「测试」）。

### 阶段 2：真实试点

另行决定门店。先在平日冷门时段使用，Feedme 保持登录作为后备，并继续接 Grab 单。

**成功标准：** 下单和结账速度不比 Feedme 慢；零丢单；每日现金和卡机 settlement 对账吻合；
员工愿意用。

## 架构

三个部分共用同一个 Supabase 数据库：

1. **菜单管理**：Craft OS 新页面 `/menu`（经理用）。
2. **POS**：Craft OS 新路由 `/pos`（员工用），为 iPad 横屏设计，加到主画面全屏使用。
   沿用现有登录；作废、退款、改价需要主管 PIN，权限沿用现有 RBAC。
3. **QR 点单**：同一个 repo 内另一个 Vite 入口，部署成独立的 Vercel 项目，
   路由 `/t/<token>`。客人端**不打包任何员工系统代码**，也**不直接写数据库**，
   只调用服务器端函数 `place_table_order`。

```
QR 网页 ──┐
          ├──► orders / order_items ──Realtime──► POS iPad ──► print_jobs ──► 各路线打印机
柜台 POS ─┘                                          │
                                                     └──► 结账 ──► payments ──► 收据
```

**打印主机：** POS 那台 iPad 订阅 `print_jobs`，只有它负责打印，避免重复出单。
iPad 设置为不自动锁屏，并一直开着 POS 页面。打印做成可替换的 adapter
（`epson-epos` / `star-webprnt` / `relay`），阶段 0 确定用哪一个。

## 数据模型

所有金额以整数 sen 储存。所有新表启用 RLS。

### 菜单

- `menu_categories`：`id, name, sort_order, is_active`
- `menu_products`：`id, category_id, name, description, image_url, sst_rate_bp`（基点，600 = 6%），
  `takeaway_fee_sen, feedme_product_id`（导入用的稳定对应键）, `sort_order, is_active`
- `menu_variants`：`id, product_id, name`（如 `HOT` / `COLD`）, `price_sen, feedme_variant_id, sort_order, is_active`。
  **价格放在规格上**，每个产品至少一个规格。
- `modifier_groups`：`id, name, min_select, max_select, feedme_group_id`
- `modifier_options`：`id, group_id, name, price_delta_sen, feedme_option_id, sort_order, is_active`
- `product_modifier_groups`：`product_id, group_id, sort_order`
- `set_slots`：`id, product_id, name, min_select, max_select`（套餐本身也是一个产品）
- `set_slot_choices`：`id, slot_id, variant_id, upcharge_sen`
- `print_routes`：`id, branch_id, name`（如 `Bar` / `Kitchen`）, `printer_adapter, printer_address`
- `product_print_routes`：`product_id, route_name`（一个产品可以对应多条路线）
- `branch_menu_status`：`branch_id, product_id, is_hidden, is_sold_out`

### 桌位与账单

- `dining_tables`：`id, branch_id, label`（如 `B5`）, `qr_token`（随机、可重新生成）, `qr_paused, is_active`
- `bills`：`id, branch_id, bill_no`（分店内连续递增）, `table_id`（外带为 null）, `order_type`（`dine_in` / `takeaway`）,
  `pax, status`（`open` / `paid` / `voided`）, `opened_at, closed_at, closed_by`，
  结账时固定写入 `subtotal_sen, service_charge_sen, sst_sen, takeaway_fee_sen, rounding_sen, total_sen`
- `orders`：`id, bill_id, source`（`counter` / `qr`）, `placed_by`（QR 为 null）, `client_order_id`（唯一，防重复）, `placed_at`
- `order_items`：`id, order_id, parent_item_id`（套餐子品项）, `product_id, variant_id`，
  下单时复制保存 `name_snapshot, unit_price_sen, sst_rate_bp, modifiers_snapshot`（jsonb）, `print_routes_snapshot`，
  以及 `qty, note, voided_at, voided_by, void_reason`。
  **菜单之后再怎么改，都不影响历史账单**（采购模块 `conversion_rate` 缺陷的教训）。
- `payments`：`id, bill_id, method`（`cash` / `card` / `duitnow` / `ewallet`）, `amount_sen, tendered_sen, change_sen, reference, taken_by, taken_at`。
  一张账单可以有多笔付款。
- `refunds`：`id, bill_id, amount_sen, method, reason, approved_by, created_at`
- `print_jobs`：`id, branch_id, route_name, kind`（`ticket` / `receipt`）, `payload`（jsonb）, `status`（`pending` / `printed` / `failed`）, `attempts, last_error, created_at, printed_at`
- `pos_shifts`：`id, branch_id, opened_by, opened_at, opening_float_sen, closed_by, closed_at, counted_cash_sen, expected_cash_sen, variance_sen`

### 分店 POS 设置

`branch_pos_settings`：`branch_id, service_charge_bp`（1000 = 10%）, `service_charge_on_takeaway, cash_rounding`（`none` / `nearest_5_sen`）, `bill_no_prefix`。
收据抬头从 `company_settings` 和 `branches` 读取：公司名、注册号、SST 号、地址、电话、电邮。

## 金额计算

纯函数 `computeBill(items, settings, orderType)`，前端显示和服务器结账共用同一套规则，
**以服务器结果为准**：

1. 小计 = Σ（规格价 + 加料价 + 套餐补差价）× 数量，不含已作废品项
2. 服务费 = 小计 × 服务费率（外带是否收取由 `service_charge_on_takeaway` 决定）
3. SST = Σ 每个品项金额 × 该品项 SST 率（以小计为基数，不含服务费）
4. 外带包装费 = 外带单才收
5. 凑整 = 按 `cash_rounding` 处理
6. 总额 = 小计 + 服务费 + SST + 外带包装费 + 凑整

每一项先算到 sen 再四舍五入。服务费和 SST 是先逐项算再加总，还是加总后再算，
用 Feedme 多品项收据核对后决定（见「待确认」）。

## 主要流程

### QR 点单

1. 客人扫码打开 `/t/<token>`，显示桌号和菜单，售罄品项变灰。
2. 选规格、加料、备注；该桌第一次下单时填 `pax`。
3. 按 `Place order` 后调用 `place_table_order(token, items, client_order_id)`。函数会：
   验证 token 和 `qr_paused`；确认品项上架而且未售罄；**在服务器端重新计算价格**；
   找到该桌 `open` 状态的账单（没有就新开）；写入 `orders` 和 `order_items`；
   按路线写入 `print_jobs`。
4. 网页显示 `Order placed`，并列出这桌目前点过的品项，之后可以继续加点。
5. 防滥用：每张桌子每分钟的下单次数有上限；员工可以在 POS 暂停某张桌子的 QR。

### 柜台点单

员工选 `Takeaway` 或桌号后点单，流程同上，`source = counter`，`placed_by` 记录员工。

### POS 主画面

桌位列表，状态分为空桌、有未结账单、有新单（新 QR 单进来时提示）。
点进桌子可以看完整账单：加点、作废品项（主管 PIN 加原因）、换桌、合并账单。

### 结账

选桌 → `Checkout` → 显示小计、服务费、SST、外带包装费、凑整、总额 → 选付款方式
（现金输入收到多少并计算找零；刷卡、DuitNow、e-wallet 可选填参考号）→ 可以分开付 →
付清后账单锁定、打印收据、桌子变回空桌。
已付账单不能修改，只能走退款：需要主管权限和原因，写入 `refunds`。

### 打印

iPad 订阅 `print_jobs` 的新记录，按 `route_name` 送到对应打印机，成功后标记 `printed`。
失败时 POS 顶部显示红色提示，修好后可以一键重印。出单内容包括桌号、单号、时间、来源（QR 或柜台）。

### 断网

- 柜台：订单先存进 IndexedDB（带 `client_order_id`），恢复网络后自动同步，期间可以收现金。
- QR：客人手机连不到服务器就无法下单，页面提示到柜台点单。
- 最坏情况：切回 Feedme。

## 交班、日结与 e-Invoice

- **交班**：开班输入备用金；关班点现金，系统计算应有现金和差额，写入 `pos_shifts`。
- **日结（Z 报表）**：总营业额、按付款方式分列（方便与卡机 settlement 对账）、服务费、SST、
  凑整、作废和退款明细、按产品统计的销量。
- **e-Invoice**：每月导出 consolidated invoice 资料，格式按 MyInvois 网站的批量上传格式；
  单张发票先手动处理。Demo 不对接 LHDN API。

## 菜单导入

读取 Feedme 菜单页「导出」的文件，产品、规格、加料组用 Feedme 的 ID 对应
（`feedme_*_id` 字段），**绝不用名称配对**（Feedme 的名称有尾随空格、中英混写、全角括号）。
导入可以重复执行：已存在的就更新，新的就新增，不会删除。

## 错误处理原则

- 价格和金额以服务器计算的为准。
- 已付账单不可修改，只能退款。
- 作废、退款、改价都记录谁、何时、原因。
- `client_order_id` 唯一约束，保证重送不会重复下单。

## 测试

- **金额计算**：`computeBill` 写 Vitest 单元测试。第一个案例就是收据 #87846：
  小计 RM80.00 → 服务费 RM8.00、SST RM4.80、总额 RM92.80。另加 0% SST 品项、外带包装费、
  凑整、作废品项、套餐补差价。
- **服务器函数**：`place_table_order` 拒绝无效 token、已暂停的桌子、售罄品项、被篡改的价格；
  同一个 `client_order_id` 送两次只会产生一笔订单。
- **阶段 0**：三项技术验证各自记录通过或不通过，以及测试条件（打印机型号、网络环境）。
- **模拟营业剧本**：多桌同时点单、QR 加点、套餐、作废、换桌、合并账单、分开付款、退款、
  断网后恢复、交班、日结，逐项照剧本操作并核对 Z 报表。

## 前置条件

1. 新建 dev Supabase 项目，本地 `.env.local` 指向它；所有 Demo 开发和测试都在 dev 进行。
2. 用户从 Feedme 导出菜单文件。
3. 确认门店打印机的品牌和型号。

## 待确认

- 打印机品牌和型号（决定 printer adapter）。
- 外带单是否收服务费；现金是否做 5 sen 凑整（用 Feedme 的外带收据和现金收据核对）。
- 服务费和 SST 是逐项计算还是对小计计算（用多品项收据核对凑整差异）。
- Feedme 菜单导出的文件格式与字段（拿到文件后确认，并据此定案导入器）。
- MyInvois 批量上传的确切格式（跟会计确认）。
