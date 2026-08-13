import { describe, it, expect } from 'vitest'
import {
  normalizeTagName, computeDropPosition, needsRebalance, rebalance,
  projectProgress, isOverdue, deriveParticipants, POSITION_STEP,
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
