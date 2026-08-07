import { describe, it, expect } from 'vitest'
import { pickTabIds, MAX_TABS } from './tabs'
import type { Capability } from '../types'

const withCaps = (...caps: Capability[]) =>
  (cap: Capability) => caps.includes(cap)

describe('pickTabIds', () => {
  it('gives plain staff the four pages they use on shift', () => {
    expect(pickTabIds(withCaps())).toEqual([
      'profile', 'attendance', 'schedule', 'missions',
    ])
  })

  it('gives a manager the team pages and procurement', () => {
    expect(pickTabIds(withCaps('view_team', 'use_procurement'))).toEqual([
      'team', 'schedule', 'tasks', 'orders',
    ])
  })

  it('backfills attendance for a supervisor with no procurement access', () => {
    expect(pickTabIds(withCaps('view_team'))).toEqual([
      'team', 'schedule', 'tasks', 'attendance',
    ])
  })

  it('never returns more entries than the bar has room for', () => {
    const everything = withCaps(
      'view_team', 'use_procurement', 'manage_procurement',
      'manage_schedule', 'access_settings', 'manage_hr',
    )
    expect(pickTabIds(everything)).toHaveLength(MAX_TABS)
  })

  it('never returns duplicates', () => {
    for (const can of [withCaps(), withCaps('view_team'), withCaps('view_team', 'use_procurement')]) {
      const ids = pickTabIds(can)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })
})
