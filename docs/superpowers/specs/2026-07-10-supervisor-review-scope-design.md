# Supervisor 考核管辖范围(Review Scope)设计

Status: Approved
Date: 2026-07-10

## 背景

三个考核模块(Monthly Reviews / Skill Assessments / Probation Reviews)目前:路由按 `conduct_reviews` 能力(supervisor 已有);页面内部按旧 rank 判;**RLS 层 supervisor 及以上可读写全公司**,无任何分店/部门/职级过滤(前端只有技能验收有仅本店过滤)。需求:supervisor 只能考核"自己管辖范围"= 同 branch + 同 department + rank 低于 supervisor(trainee/junior/senior);manager 级不变看全部;RLS 与前端双层过滤。

数据现状:`department` 全员已填;`branch` 文本全员有,`branch_id` 大多为 NULL(RBAC 回填是模糊匹配,没配上)。

用户已确认:supervisor **可以**淘汰(eliminate)试用期员工;只有转正(Hire)留给 Manager 级。

## 核心:同一规则的两个实现

**SQL 辅助(新,security definer)`can_review_staff(target uuid) returns boolean`:**

```sql
create or replace function can_review_staff(target uuid)
returns boolean language sql security definer stable as $$
  select coalesce((
    select
      (me.rank = 'manager' or me.system_role in ('manager','admin','owner'))
      or (
        (me.rank = 'supervisor' or me.system_role = 'supervisor')
        and t.rank in ('trainee','junior','senior')
        and t.department is not null and t.department = me.department
        and (
          (me.branch_id is not null and t.branch_id is not null and me.branch_id = t.branch_id)
          or ((me.branch_id is null or t.branch_id is null) and me.branch is not null and me.branch = t.branch)
        )
      )
    from staff me, staff t
    where me.id = auth.uid() and t.id = target
  ), false)
$$;
```

要点:manager 级(rank=manager 或 system_role∈manager/admin/owner)恒真——所以管理向策略可直接写 `can_review_staff(staff_id)`,无需再并列 manager 条件;supervisor 级按三条件;branch 比对优先 `branch_id`(双方都有才比),否则退回文本 `branch` 相等;目标不存在/未登录 → false。hr 不在集合内(能力矩阵 conduct_reviews=false,维持)。

**前端镜像(`src/shared/lib/permissions.ts` 新增,纯函数可单测):**

```ts
export function canReviewStaff(
  me: Pick<Staff, 'rank' | 'system_role' | 'department' | 'branch' | 'branch_id'> | null | undefined,
  target: Pick<Staff, 'rank' | 'department' | 'branch' | 'branch_id'> | null | undefined,
): boolean
```
逻辑与 SQL 逐行对应(mgr 级 true;sup 级三条件;branch_id 优先、文本兜底)。

## RLS 改动(单独 SQL 给用户手动跑,幂等)

- `monthly_reviews`:`reviews_select` → `staff_id = auth.uid() or can_review_staff(staff_id)`;`reviews_insert` with check `can_review_staff(staff_id)`;`reviews_update_sup` using `can_review_staff(staff_id)`。`reviews_update_self` 不动。
- `skill_assessments`:`sa_select` → self or can_review;`sa_insert_mgmt` with check can_review;`sa_update_mgmt` using can_review。`sa_update_own` 不动。
- `probation_reviews`:`probation_select` → self or can_review;`probation_insert` with check can_review;`probation_update` → using `can_review_staff(staff_id)` **with check**:

```sql
  with check (
    can_review_staff(staff_id)
    and (
      (day3_result is distinct from 'hire' and overall_result is distinct from 'hired')
      or current_rank() = 'manager' or current_system_role() in ('manager','admin','owner')
    )
  )
```
即 supervisor 级写入 `hire/hired` 会被数据库硬性拒绝(不只前端藏按钮);淘汰不受限。
- 附带数据卫生:`update staff s set branch_id = b.id from branches b where s.branch_id is null and s.branch = b.name;`(精确匹配,配不上保持 NULL,由文本兜底承担)。

## 前端改动

1. **Dashboard**(考核三区块):区块显示条件从 rank 的 `isSupervisor` 改为 `can('conduct_reviews')`;三个列表(月度自评待评、技能待验收、试用期卡片+trainee 名单)对非 manager 级调用 `canReviewStaff(currentStaff, s)` 过滤(替换现有仅-branch 过滤);manager 级不变看全部。
2. **StaffProfile**:评分/技能打分入口(现 `isSupervisor`/`canRateSkills` rank 判)改为 `canReviewStaff(currentStaff, staff)`;范围外的 supervisor 看不到评分 UI。
3. **ProbationReview 页**:Day 3 的 `✓ Hire` 按钮仅 manager 级渲染;supervisor 级看到替代提示 "Day 3 assessment saved — hiring approval is done by a Manager",`Not Suitable`(eliminate)保留。页面顶部对范围外目标显示无权限提示(RLS 会挡数据,前端给友好文案)。

## 不做

- 不引入 manager_id/汇报线字段(范围=branch+department+rank 规则,按需求原文);不改 hr/admin/owner 行为;不动员工自评/自更新路径;不做部门规范化(沿用文本);promotion_requests 审批仍 manager 级(现状)。

## 测试要点

`canReviewStaff` 单测:mgr 级恒真(含 system_role 提权者);sup 级同店同部门低职级 true;跨店/跨部门/同级 supervisor/目标 manager false;branch_id 一有一无回落文本;文本也缺 → false。RLS 由用户跑 SQL 后我用临时 supervisor JWT 实测(范围内 1 行、范围外 0 行、写 hired 被拒)。

## 交付

代码:worktree → 子代理实现+审查 → 合并 → vercel 部署 → push GitHub。SQL 单独整段交付用户在 Supabase SQL Editor 跑,跑完我做 JWT 实测核验。
