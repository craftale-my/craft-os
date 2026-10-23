# 新增 Kepong 分店 + Settings 打卡围栏字段设计

Status: Approved
Date: 2026-10-12

> 沿用同目录既有体例:正文中文,所有 UI 文案、字段名、错误提示一律英文。

## 背景

用户要在 Kepong 开第三家店,员工要在那边打卡。原始诉求只有一句「增加个 Kepong 的新 Branch」,
附 Google Maps 坐标 `3.2173718, 101.6406565` 和地址
`B - G, 1, Jln Metro Perdana 1, Taman Usahawan Kepong, 52100 Kuala Lumpur`。

动手前逐条 grep 确认后发现:**加一个分店不是插一行数据**,代码里有三处硬编码的分店清单,
而且后台没有设置 GPS 围栏的入口。

### 现状核实

- **`branches` 表字段齐全**:`name / address / pic_staff_id / operating_hours / is_active`
  (`schema.sql:362`)+ `latitude / longitude / radius_meters`(`schema.sql:660`,当年 out-of-band
  加到生产后补写进 schema)。seed 只有 Cheras、Puchong(`schema.sql:372`),且 seed 带
  `where not exists (select 1 from branches)` —— 只对空库生效。
- **`Branch` TS 类型已经有三个围栏字段**(`types/index.ts:482`)。缺的只是表单。
- **打卡围栏逻辑**(`ClockModal.tsx:102`):取 `staff.branch` 的**第一个词**当 keyword,
  `ilike '%keyword%'` 匹配 `branches.name`,haversine 算距离,超过 `radius_meters`(null 则默认 100)
  就拒绝并提示 `You are Nm away from X. You must be within Rm to clock in.`
  **坐标为 null 时直接放行、不做距离校验**(`:111`)—— 这是现有的兜底行为,本次保留。
- **三处硬编码分店清单**:
  - `types/index.ts:308` `BRANCHES` → Register(`:142`)、Directory 筛选(`:137`)与新增员工(`:834`)、
    StaffProfile(`:1317`)、Schedule(`:234`)、HrAttendance(`:176`)六个入口共用。
  - `Onboarding.tsx:9` **另一份重复副本**,内容与上面相同但彼此无引用关系。
  - `Directory.tsx:40` `shortenBranch()` 硬编码 `Connaught→Cheras`、`Puteri→Puchong`;
    `Directory.tsx:742` 还有同一件事的内联三元第二实现。
- **`Settings → Branches` 弹窗无围栏字段**(`Settings.tsx:197`):表单只有
  name / address / pic_staff_id / operating_hours。所以围栏至今只能靠 SQL 设置。
- **前端从不写 `staff.branch_id`**。全仓库只读不写(`Directory.tsx:534`、`HrAttendance.tsx:1192`、
  `Schedule.tsx:652`、`permissions.ts:49`),历史数据全靠迁移脚本回填
  (`migration-2026-07-06-rbac.sql:90`、`migration-2026-07-10-supervisor-review-scope.sql:75`)。
  新员工选了分店只会有 `branch` 文本、`branch_id` 为 null;`canManageStaff` 会退回文本比对
  (`permissions.ts:48`),能用,但主管「只看本分店」的范围依赖 `branch_id`。
- **本地无 service_role key**(`.env.local` 只有 URL + anon key),无法从这里直接写生产库。
  数据变更出 migration SQL,由用户在 Supabase SQL Editor 执行 —— 与仓库既有做法一致。

## 范围决策

用户在三个选项中选了 **B**:数据 + Settings 加 GPS 字段。围栏半径选 **100m**(与 app 默认值
及其他分店保持一致)。

明确**不做**:
- 不把 `BRANCHES` 改成动态读表(选项 C)。虽然能根治三处硬编码,但要动 6 个文件,
  且要先解决「`staff.branch` 存全称还是存 `branches.name`」的格式统一问题,风险最高。
- 不改 `ClockModal` 的 keyword 匹配逻辑。
- 前端仍不写 `staff.branch_id`,沿用现状(migration 回填 + 文本兜底)。

## 设计

### 1. 数据:`supabase/migration-2026-10-12-branch-kepong.sql`

幂等,可重复执行:

| 列 | 值 |
|---|---|
| `name` | `Kepong` |
| `address` | `B-G, 1, Jln Metro Perdana 1, Taman Usahawan Kepong, 52100 Kuala Lumpur` |
| `latitude` | `3.2173718` |
| `longitude` | `101.6406565` |
| `radius_meters` | `100` |

- 插入用 `where not exists (select 1 from branches where name ilike 'Kepong')` 保护,
  重复跑不会插出第二行。
- 顺带回填一次 `staff.branch_id`,沿用既有那段
  `update staff s set branch_id = b.id from branches b where s.branch_id is null
   and s.branch is not null and s.branch ilike '%' || b.name || '%'`,
  让已经填了 Kepong 的员工立刻拿到 `branch_id`,主管范围才准。
- 同步把 Kepong 写进 `schema.sql` 与 `FRESH_BUILD_full.sql` 的 seed(`:372` / `:371`),
  让全新库建出来也带这家店。seed 的列从 `(name, address)` 扩成
  `(name, address, latitude, longitude, radius_meters)`,Cheras / Puchong 两行坐标填 `null`
  (本地无从得知其真实坐标,保持现状不猜)。

**为什么 `branches.name` 用 `Kepong` 而不是全称**:`ClockModal` 拿 `staff.branch` 的第一个词
做 keyword,`'Kepong (Taman Usahawan)'.split(' ')[0]` = `Kepong`,`ilike '%Kepong%'` 命中。
与 Cheras / Puchong 完全同构,打卡逻辑零改动。

### 2. 下拉清单

- `types/index.ts:308` `BRANCHES` 插入 `'Kepong (Taman Usahawan)'`,位置在 `'Other'` 之前
  → 上述六个入口一次全通。
- `Onboarding.tsx:9` 删掉本地副本,改成 `import { BRANCHES } from '../../shared/types'`。
  **理由**:两份清单无任何机制保证同步,这次就是它漏了才会被发现;以后开店只改一处。
  代价是改 `BRANCHES` 会同时影响入职页 —— 用户已确认接受。
- `Directory.tsx:40` `shortenBranch()` 加 `if (branch.includes('Usahawan')) return 'Kepong'`;
  `Directory.tsx:742` 的内联三元改为调用 `shortenBranch()`(消掉同一件事的第二实现)。

### 3. Settings → Branches 增加围栏字段

`Settings.tsx` 的 `BranchModal`(`:190`)在 Operating Hours 之后新增一节 **Clock-In Geofence**:

- `Latitude`、`Longitude`、`Radius (meters)` 三个输入框
- 一个 `Use my current location` 按钮,调 `navigator.geolocation.getCurrentPosition` 填入当前坐标
  (开新店的人通常就站在店里用手机操作)
- 一行说明文案:`Leave blank to allow clock-in from anywhere.`(把现有的 null 放行行为讲明)
- 校验不通过时弹窗内红字提示、**不保存**

`form` 新增三个 string 字段(受控输入一律按字符串存,保存时才解析),
`payload` 展开 `parseBranchGeofence` 的结果。

### 4. 纯函数 `src/shared/lib/geofence.ts`

```ts
export type GeofenceParseResult =
  | { ok: true; latitude: number | null; longitude: number | null; radius_meters: number | null }
  | { ok: false; error: string }

export function parseBranchGeofence(lat: string, lng: string, radius: string): GeofenceParseResult
```

规则:

| 输入 | 结果 |
|---|---|
| 三个都空白 | `ok`,三个值全 `null`(打卡跳过距离校验,保持现有行为) |
| Latitude 栏粘贴 `3.2173718,101.6406565` 且 Longitude 栏为空 | 自动拆分成两个值(用户就是这么从 Google Maps 复制的) |
| 只填了 lat 或只填了 lng | `error: 'Enter both latitude and longitude, or leave both blank.'` |
| lat 不在 −90~90 | `error: 'Latitude must be between -90 and 90.'` |
| lng 不在 −180~180 | `error: 'Longitude must be between -180 and 180.'` |
| 非数字 | `error: 'Latitude and longitude must be numbers.'` |
| radius 空但坐标已填 | `ok`,`radius_meters: null`(`ClockModal` 会用默认 100) |
| radius 不在 20~2000 或非整数 | `error: 'Radius must be a whole number between 20 and 2000 meters.'` |

**这个校验是必须的,不是锦上添花**:坐标写错一位,整间店的人全被挡在打卡外面,
而员工看到的错误只会说 `You are 8000m away from Kepong` —— 没有人查得到是后台填错了。
半径下限 20m 同理:填个 `1` 会让所有人都打不了卡。

### 5. 测试

`src/shared/lib/geofence.test.ts`(vitest,仓库已有 `vitest.config.ts` 与同类
`permissions.test.ts` 可照抄体例),覆盖上表每一行:全空、正常值、粘贴逗号对、
只填一半(两个方向)、lat/lng 超范围、非数字、radius 空、radius 超范围、radius 非整数。

`BranchModal` 本身跟随现有弹窗模式(直接 `supabase.from('branches').insert/update`),
无分支逻辑,不加组件测试 —— 与同文件其他弹窗一致。

## 验收

1. migration 在 Supabase SQL Editor 跑完,`select * from branches` 能看到 Kepong 带坐标与 100m 半径;
   重复跑一次不会出现第二行 Kepong。
2. `Settings → Branches` 能看到 Kepong,点 Edit 能看到并修改经纬度/半径;
   故意把 latitude 填成 `91` 会被红字拦下、不写库。
3. Register / Onboarding / Directory 新增员工 / StaffProfile / Schedule 筛选 / HrAttendance 筛选
   六处下拉都出现 `Kepong (Taman Usahawan)`。
4. 一名 branch 设为 Kepong 的员工,在店内(距坐标 100m 内)能完成 GPS + 自拍打卡;
   在 100m 外会收到 `You are Nm away from Kepong.` 的拒绝。
5. `npx vitest run` 全绿。
