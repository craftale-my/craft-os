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

/**
 * 插在 `column[index]` 之前时该拿的 position;`index` 大于等于长度就是落到栏尾。
 *
 * `column` 是目标栏**现有**的卡,依显示顺序(= position 升幂),而且**不含正在拖的
 * 那一张** —— 把被拖的卡留在里面,它自己的 position 会成为落点的邻居,算出来的
 * 中点就只是「它现在的位置附近」,毫无意义。index 会先夹回 [0, length],
 * 落点来自 DOM 事件,不该让一个过期的索引算出 NaN。
 */
export function insertPosition(column: Array<{ position: number }>, index: number): number {
  const at = Math.max(0, Math.min(index, column.length))
  return computeDropPosition(column[at - 1]?.position, column[at]?.position)
}

/** 该栏是否已经挤到需要整栏重新编号。 */
export function needsRebalance(positions: number[]): boolean {
  const sorted = [...positions].sort((a, b) => a - b)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] < MIN_GAP) return true
  }
  return false
}

/**
 * 依现有顺序重新编号,间距一律 POSITION_STEP,而且整段**排在这一栏现有最大号之上**:
 * base 是大于等于现有最大号的第一个 POSITION_STEP 倍数,第 i 张拿
 * base + (i + 1) * POSITION_STEP。
 *
 * 「排在最大号之上」不是为了好看,是为了让呼叫端能一笔一笔写、而且写到一半被挡下来
 * 也不会把顺序弄乱:任何一个新号码都大于所有还没改到的旧号码,也小于已经改好的
 * 那几张,所以只要**由下往上**写,每写完一笔整栏的顺序都还是同一个 —— 中断只会
 * 留下「号码还挤着」,不会留下「顺序被打乱」。号码固定落在 POSITION_STEP 的格子上,
 * 代价是每重新编号一次就往上长一截;一栏要连插二十几次中点才触发一次,double
 * 装得下这个速度。
 */
export function rebalance<T extends { position: number }>(
  items: T[],
): Array<T & { position: number }> {
  // 用 0 起头:整栏都是负号码(从栏首往上插能插出负数)时 base 退回 0,
  // 新号码照样在所有旧号码之上。
  const max  = items.reduce((m, item) => Math.max(m, item.position), 0)
  const base = Math.ceil(max / POSITION_STEP) * POSITION_STEP
  return items.map((item, i) => ({ ...item, position: base + (i + 1) * POSITION_STEP }))
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

/**
 * 尚未打勾的子项数。任务的 _checklist_total / _checklist_done 由看板查询聚合。
 *
 * clamp 到 0 的理由与 projectProgress 同款:两个分页同时开着时,done 的计数
 * 可能比 total 新,一瞬间会大於 total。若让它变成负数,「Still -1 of 7 items
 * open」这种确认文字就会跳到使用者面前,而且 `open > 0` 的闸门判断也会翻转。
 */
export function openChecklistCount(
  task: { _checklist_total: number; _checklist_done: number },
): number {
  return Math.max(0, task._checklist_total - task._checklist_done)
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
