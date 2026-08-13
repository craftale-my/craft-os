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
 *
 * slug 与 name 都先做 `.normalize('NFC')`:不同 OS / 输入法打出的同一个字,
 * 底层码位可能不同(例如预组合的 é U+00E9,对上 e + combining acute U+0301),
 * 肉眼完全看不出差异,但字串比较会当成两个不同的标签,让 slug 这个去重键失效。
 * NFC 是「标准等价」正规化 —— 只会改变码位组成方式,不会改变使用者看到的字元外观,
 * 所以连 name 也一起正规化并不违反「保留使用者敲的原文」这个职责;
 * 反而能避免同一个视觉字串,因为组字方式不同,被显示成两个不同的标签、
 * 或在下游(搜寻、排序、字串比对)被误判成两笔资料。
 */
export function normalizeTagName(input: string): { slug: string; name: string } | null {
  const name = input.trim().replace(/\s+/g, ' ').normalize('NFC')
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

/**
 * 完成百分比,0–100 整数。总数为 0 时回 0,不得除以零。
 * 会 clamp 到 [0, 100]:两个分板同时开着、done 计数比 total 还新的 race 之下,
 * done 可能暂时大于 total,若不 clamp,进度条 `width: ${n}%` 就会爆出轨道。
 */
export function projectProgress(done: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((done / total) * 100)))
}

/** 到期当日不算逾期;只比日期,不比时刻。 */
export function isOverdue(dueDate: string | null, today: Date): boolean {
  if (!dueDate) return false
  return dueDate < toLocalDateString(today)
}

/** 项目参与者 = 所有任务的 assignee 去重,加上 owner。回传顺序是 Set 插入顺序,不保证稳定,呼叫端若要做头像列要自己排序。 */
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
