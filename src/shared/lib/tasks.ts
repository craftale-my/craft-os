/**
 * Tasks 模块的纯逻辑。刻意不含 React 与 Supabase,
 * 好让排序、进度与日期规则能脱离渲染与网路单测。
 */

/** 栏内排序的基础步长。以 2 的幂次为步长,让「插入中点」能反覆二分。 */
export const POSITION_STEP = 1024

/** 相邻 position 小于此值就该重新编号,否则 double 精度会开始吃掉中点。 */
const MIN_GAP = 0.0001

/**
 * 使用者输入的标签 → 去重用的 slug 与显示用的原文。
 * slug 决定同一性(`Urgent` 与 ` urgent ` 是同一个标签),
 * name 保留使用者敲的大小写,由 upsert 决定先到者胜。
 */
export function normalizeTagName(input: string): { slug: string; name: string } | null {
  const name = input.trim().replace(/\s+/g, ' ')
  if (!name) return null
  return { slug: name.toLowerCase(), name }
}

/** 拖放落点的新 position。prev/next 是落点上下相邻卡片的 position。 */
export function computeDropPosition(prev: number | undefined, next: number | undefined): number {
  if (prev === undefined && next === undefined) return POSITION_STEP
  if (prev === undefined) return next! - POSITION_STEP
  if (next === undefined) return prev + POSITION_STEP
  return (prev + next) / 2
}

/** 该栏是否已经挤到需要整栏重新编号。 */
export function needsRebalance(positions: number[]): boolean {
  const sorted = [...positions].sort((a, b) => a - b)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] < MIN_GAP) return true
  }
  return false
}

/** 依现有顺序以 POSITION_STEP 重新编号。 */
export function rebalance<T>(items: T[]): Array<T & { position: number }> {
  return items.map((item, i) => ({ ...item, position: (i + 1) * POSITION_STEP }))
}

/** 完成百分比,0–100 整数。总数为 0 时回 0,不得除以零。 */
export function projectProgress(done: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((done / total) * 100)
}

/** 到期当日不算逾期;只比日期,不比时刻。 */
export function isOverdue(dueDate: string | null, today: Date): boolean {
  if (!dueDate) return false
  return dueDate < toLocalDateString(today)
}

/** 项目参与者 = 所有任务的 assignee 去重,加上 owner。 */
export function deriveParticipants<T extends { assigned_to: string | null }>(
  tasks: T[],
  ownerId: string | null,
): string[] {
  const out = new Set<string>()
  if (ownerId) out.add(ownerId)
  for (const t of tasks) if (t.assigned_to) out.add(t.assigned_to)
  return [...out]
}

/** 本地时区的 YYYY-MM-DD。date 栏位是无时区的日期,不能用 toISOString。 */
function toLocalDateString(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
