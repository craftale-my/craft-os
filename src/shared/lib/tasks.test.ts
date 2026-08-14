import { describe, it, expect } from 'vitest'
import {
  normalizeTagName, computeDropPosition, insertPosition, needsRebalance, rebalance,
  projectProgress, isOverdue, deriveParticipants, openChecklistCount, POSITION_STEP,
} from './tasks'

describe('normalizeTagName', () => {
  it('collapses case and surrounding space into one slug', () => {
    expect(normalizeTagName('Urgent')!.slug).toBe('urgent')
    expect(normalizeTagName(' urgent ')!.slug).toBe('urgent')
    expect(normalizeTagName('URGENT')!.slug).toBe('urgent')
  })

  it('collapses runs of inner whitespace', () => {
    expect(normalizeTagName('new   store')!.slug).toBe('new store')
  })

  it('keeps the typed casing as the display name', () => {
    expect(normalizeTagName('  Urgent ')!.name).toBe('Urgent')
  })

  it('returns null for blank input', () => {
    expect(normalizeTagName('   ')).toBeNull()
  })

  it('collapses precomposed and combining-mark Unicode forms to the same slug', () => {
    // 用明确的 \u 转义而非直接贴字元，避免编辑器/存档时把两种编码悄悄改写成
    // 同一种正规化形式，那样测试就测不出这个 bug 了
    // precomposed: 'Caf' + U+00E9（预组合的 é）
    const precomposed = normalizeTagName('Caf\u00e9')!
    // decomposed: 'Cafe' + U+0301（combining acute accent），画面上和上面一模一样
    const decomposed = normalizeTagName('Cafe\u0301')!
    expect(precomposed.slug).toBe(decomposed.slug)
    expect(precomposed.slug).toBe('caf\u00e9')
  })

  it('round-trips a Chinese tag unchanged', () => {
    const tag = normalizeTagName('奶茶')!
    expect(tag.name).toBe('奶茶')
    expect(tag.slug).toBe('奶茶')
  })
})

describe('computeDropPosition', () => {
  it('seeds an empty column', () => {
    expect(computeDropPosition(undefined, undefined)).toBe(POSITION_STEP)
  })

  it('drops above the first card', () => {
    expect(computeDropPosition(undefined, 1024)).toBe(1024 - POSITION_STEP)
  })

  it('drops below the last card', () => {
    expect(computeDropPosition(2048, undefined)).toBe(2048 + POSITION_STEP)
  })

  it('splits the gap between two cards', () => {
    expect(computeDropPosition(1024, 2048)).toBe(1536)
  })
})

describe('insertPosition', () => {
  const column = [{ position: 1024 }, { position: 2048 }, { position: 3072 }]

  it('seeds an empty column', () => {
    expect(insertPosition([], 0)).toBe(POSITION_STEP)
  })

  it('lands above the first card', () => {
    expect(insertPosition(column, 0)).toBe(1024 - POSITION_STEP)
  })

  it('lands between the two cards it was dropped between', () => {
    expect(insertPosition(column, 1)).toBe(1536)
    expect(insertPosition(column, 2)).toBe(2560)
  })

  it('lands at the bottom when the index is the length', () => {
    expect(insertPosition(column, 3)).toBe(3072 + POSITION_STEP)
  })

  /** 落点是从 DOM 事件来的,一个过期的索引不该算出 NaN,只该退回栏尾 / 栏首。 */
  it('clamps an out-of-range index to the ends of the column', () => {
    expect(insertPosition(column, 99)).toBe(3072 + POSITION_STEP)
    expect(insertPosition(column, -3)).toBe(1024 - POSITION_STEP)
  })
})

describe('needsRebalance', () => {
  it('is false for a freshly stepped column', () => {
    expect(needsRebalance([1024, 2048, 3072])).toBe(false)
  })

  it('becomes true after repeated splits into the same gap', () => {
    let lo = 1024
    const hi = 2048
    for (let i = 0; i < 60; i++) lo = computeDropPosition(lo, hi)
    expect(needsRebalance([lo, hi])).toBe(true)
  })
})

describe('rebalance', () => {
  it('renumbers in order with a full step between neighbours', () => {
    const out = rebalance([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    expect(out.map(o => o.position)).toEqual([1024, 2048, 3072])
    expect(out.map(o => o.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('projectProgress', () => {
  it('never divides by zero', () => {
    expect(projectProgress(0, 0)).toBe(0)
  })

  it('rounds to a whole percent', () => {
    expect(projectProgress(1, 3)).toBe(33)
    expect(projectProgress(8, 15)).toBe(53)
    expect(projectProgress(6, 6)).toBe(100)
  })

  it('clamps to 100 when done exceeds total (stale counts from a race)', () => {
    expect(projectProgress(9, 6)).toBe(100)
  })
})

describe('isOverdue', () => {
  // 以本地时间建构,否则 runner 的时区会改变「今天」是哪一天。
  const today = new Date(2026, 7, 14, 9, 0, 0)

  it('is false on the due date itself', () => {
    expect(isOverdue('2026-08-14', today)).toBe(false)
  })

  it('is true the day after', () => {
    expect(isOverdue('2026-08-13', today)).toBe(true)
  })

  it('is false with no due date', () => {
    expect(isOverdue(null, today)).toBe(false)
  })
})

describe('deriveParticipants', () => {
  it('dedupes assignees, drops nulls, and always includes the owner', () => {
    const tasks = [
      { assigned_to: 'amy' }, { assigned_to: 'amy' },
      { assigned_to: null }, { assigned_to: 'ben' },
    ]
    expect(deriveParticipants(tasks, 'jason').sort()).toEqual(['amy', 'ben', 'jason'])
  })

  it('does not duplicate the owner when they also hold a task', () => {
    expect(deriveParticipants([{ assigned_to: 'jason' }], 'jason')).toEqual(['jason'])
  })

  it('copes with no owner', () => {
    expect(deriveParticipants([{ assigned_to: 'amy' }], null)).toEqual(['amy'])
  })
})

describe('openChecklistCount', () => {
  const task = (total: number, done: number) => ({ _checklist_total: total, _checklist_done: done })

  it('counts the items still to be ticked', () => {
    expect(openChecklistCount(task(7, 4))).toBe(3)
  })

  it('is 0 for a task with no checklist at all', () => {
    expect(openChecklistCount(task(0, 0))).toBe(0)
  })

  it('is 0 once every item is ticked', () => {
    expect(openChecklistCount(task(7, 7))).toBe(0)
  })

  /**
   * 两个分页同时开着时,done 的计数可能比 total 新,一瞬间会大於 total。
   * 若让它变成负数,「Still -1 of 7 items open」会跳到使用者面前,
   * 而且 `open > 0` 的闸门判断会翻转 —— 一个真的还没做完的任务反而不问就放行。
   */
  it('never goes negative when done outruns total', () => {
    expect(openChecklistCount(task(7, 9))).toBe(0)
  })
})
