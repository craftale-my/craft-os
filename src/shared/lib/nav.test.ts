import { describe, it, expect } from 'vitest'
import { NAV, visibleNav, activeEntry, isGroup } from './nav'
import type { Capability } from '../types'

/** 用一组 capability 造 can();未列出的一律 false。 */
const canWith = (...caps: Capability[]) => (c: Capability) => caps.includes(c)

const ids = (entries: ReturnType<typeof visibleNav>) => entries.map(e => e.id)

describe('visibleNav', () => {
  it('无任何 capability 的店员只看到 Profile 与 Time & Pay', () => {
    const nav = visibleNav(canWith())
    expect(ids(nav)).toEqual(['profile', 'time-pay'])
  })

  it('店员的 Time & Pay 保留全部五项', () => {
    const nav = visibleNav(canWith())
    const group = nav.find(e => e.id === 'time-pay')!
    expect(isGroup(group) && group.children.map(c => c.id)).toEqual([
      'schedule', 'attendance', 'leave', 'claims', 'salary',
    ])
  })

  it('有 view_team 但无 conduct_reviews 时,Team 组里没有 Reviews', () => {
    const nav = visibleNav(canWith('view_team'))
    const team = nav.find(e => e.id === 'team')!
    expect(isGroup(team) && team.children.map(c => c.id)).toEqual(['directory', 'team-tasks'])
  })

  it('子项被 capability 全部过滤掉时整个大类消失', () => {
    // view_team 是 Team 组本身的 cap;没有它,组不出现
    expect(ids(visibleNav(canWith('conduct_reviews')))).toEqual(['profile', 'time-pay'])
  })

  it('access_settings 控制 Settings 叶子项', () => {
    expect(ids(visibleNav(canWith('access_settings')))).toEqual(['profile', 'time-pay', 'settings'])
  })

  it('不修改原始 NAV', () => {
    const before = JSON.stringify(NAV)
    visibleNav(canWith())
    expect(JSON.stringify(NAV)).toBe(before)
  })
})

describe('activeEntry', () => {
  const full = visibleNav(() => true)

  it('/team/reviews 命中 Reviews 而不是 Directory(最长前缀优先)', () => {
    expect(activeEntry(full, '/team/reviews')).toEqual({ leafId: 'team-reviews', groupId: 'team' })
  })

  it('/team 命中 Directory', () => {
    expect(activeEntry(full, '/team')).toEqual({ leafId: 'directory', groupId: 'team' })
  })

  it('/staff/abc 经 activePaths 命中 Directory', () => {
    expect(activeEntry(full, '/staff/abc')).toEqual({ leafId: 'directory', groupId: 'team' })
  })

  it('顶层叶子项没有 groupId', () => {
    expect(activeEntry(full, '/profile')).toEqual({ leafId: 'profile', groupId: null })
  })

  it('未知路径返回 null', () => {
    expect(activeEntry(full, '/nowhere')).toBeNull()
  })
})

describe('visibleNav 的扁平化结果', () => {
  it('所有 to 值互不相同(即使折叠在同一个大类里)', () => {
    const full = visibleNav(() => true)
    const flatTo = full.flatMap(e => (isGroup(e) ? e.children.map(c => c.to) : [e.to]))
    expect(new Set(flatTo).size).toBe(flatTo.length)
  })
})
