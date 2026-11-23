import { describe, it, expect } from 'vitest'
import {
  buildOrgTree, chainOf, descendantsOf, supervisorChoices, initialExpanded, searchPeople, scrollLeftToCenter,
  type OrgPerson,
} from './orgTree'

const p = (id: string, over: Partial<OrgPerson> = {}): OrgPerson => ({
  id, name: id, nickname: null, avatar: null, rank: 'junior', system_role: 'staff',
  job_title: null, branch: null, department: null, supervisor_id: null, ...over,
})

// owner → mgr → sup → {jun, ali}; u1 (no supervisor) → u1kid; gone-sup points at a missing id
const ROWS: OrgPerson[] = [
  p('owner', { system_role: 'owner', rank: 'manager', name: 'Owner' }),
  p('mgr', { rank: 'manager', supervisor_id: 'owner', name: 'Mgr' }),
  p('sup', { rank: 'supervisor', supervisor_id: 'mgr', name: 'Sup' }),
  p('jun', { rank: 'junior', supervisor_id: 'sup', name: 'Zed' }),
  p('ali', { rank: 'senior', supervisor_id: 'sup', name: 'Ali', nickname: 'Ally' }),
  p('u1', { rank: 'senior', name: 'U1' }),
  p('u1kid', { supervisor_id: 'u1', name: 'U1 Kid' }),
  p('gone', { supervisor_id: 'resigned-id', name: 'Gone' }),
]

describe('buildOrgTree', () => {
  it('uses owners as roots', () => {
    expect(buildOrgTree(ROWS).roots.map(r => r.id)).toEqual(['owner'])
  })

  it('sorts children by rank (senior before junior), then name', () => {
    expect(buildOrgTree(ROWS).childrenOf('sup').map(c => c.id)).toEqual(['ali', 'jun'])
  })

  it('lists people with no supervisor and with an inactive one, but not their reports', () => {
    const u = buildOrgTree(ROWS).unassigned
    expect(u.map(e => [e.person.id, e.reason])).toEqual([
      ['gone', 'inactive'],
      ['u1', 'none'],
    ])
  })

  it('lists only the top of a chain that hangs under an unassigned person', () => {
    const ids = buildOrgTree(ROWS).unassigned.map(e => e.person.id)
    expect(ids).not.toContain('u1kid')
  })

  it('lists every member of a loop as broken, but not people below the loop', () => {
    const rows = [
      p('owner', { system_role: 'owner' }),
      p('a', { supervisor_id: 'b', name: 'A' }),
      p('b', { supervisor_id: 'a', name: 'B' }),
      p('c', { supervisor_id: 'a', name: 'C' }),
    ]
    const u = buildOrgTree(rows).unassigned
    expect(u.map(e => [e.person.id, e.reason])).toEqual([['a', 'broken'], ['b', 'broken']])
  })

  it('never lists the owner, even if the owner has a supervisor_id', () => {
    const rows = [p('owner', { system_role: 'owner', supervisor_id: 'x' })]
    expect(buildOrgTree(rows).unassigned).toEqual([])
  })

  it('with no owner, everyone at the top of a chain is unassigned', () => {
    const rows = [p('a'), p('b', { supervisor_id: 'a' })]
    const t = buildOrgTree(rows)
    expect(t.roots).toEqual([])
    expect(t.unassigned.map(e => e.person.id)).toEqual(['a'])
  })
})

describe('chainOf', () => {
  it('walks from the direct supervisor up to the owner', () => {
    expect(chainOf(buildOrgTree(ROWS), 'jun').map(x => x.id)).toEqual(['sup', 'mgr', 'owner'])
  })

  it('is empty for the owner and for someone with no supervisor', () => {
    const t = buildOrgTree(ROWS)
    expect(chainOf(t, 'owner')).toEqual([])
    expect(chainOf(t, 'u1')).toEqual([])
  })

  it('stops at a loop instead of running forever', () => {
    const t = buildOrgTree([p('a', { supervisor_id: 'b' }), p('b', { supervisor_id: 'a' })])
    expect(chainOf(t, 'a').map(x => x.id)).toEqual(['b'])
  })
})

describe('descendantsOf / supervisorChoices', () => {
  it('collects every report below a person', () => {
    expect([...descendantsOf(buildOrgTree(ROWS), 'mgr')].sort()).toEqual(['ali', 'jun', 'sup'])
  })

  it('offers everyone except the person and their own reports', () => {
    const ids = supervisorChoices(buildOrgTree(ROWS), 'u1').map(x => x.id)
    expect(ids).not.toContain('u1')
    expect(ids).not.toContain('u1kid')
    expect(ids).toContain('owner')
    expect(ids[0]).toBe('mgr') // managers first, then by name: Mgr < Owner
  })
})

describe('initialExpanded', () => {
  it('expands roots and the next level, so two levels below the owner show', () => {
    expect([...initialExpanded(buildOrgTree(ROWS), 2)].sort()).toEqual(['mgr', 'owner'])
  })
})

describe('searchPeople', () => {
  it('matches name or nickname, case-insensitive', () => {
    const t = buildOrgTree(ROWS)
    expect(searchPeople(t, 'ally').map(x => x.id)).toEqual(['ali'])
    expect(searchPeople(t, 'ZED').map(x => x.id)).toEqual(['jun'])
  })

  it('returns nothing for a blank query and respects the limit', () => {
    const t = buildOrgTree(ROWS)
    expect(searchPeople(t, '  ')).toEqual([])
    expect(searchPeople(t, 'u', 1)).toHaveLength(1)
  })
})

describe('scrollLeftToCenter', () => {
  it('scrolls so the card sits in the middle of the container', () => {
    // card's centre is 1100 + 88 = 1188px into the content; half the view is 250
    expect(scrollLeftToCenter({ left: 100, scrollLeft: 0, clientWidth: 500 }, { left: 1200, width: 176 })).toBe(938)
  })

  it('accounts for the current scroll position', () => {
    expect(scrollLeftToCenter({ left: 100, scrollLeft: 300, clientWidth: 500 }, { left: 900, width: 176 })).toBe(938)
  })

  it('never returns a negative scroll', () => {
    expect(scrollLeftToCenter({ left: 0, scrollLeft: 0, clientWidth: 800 }, { left: 100, width: 176 })).toBe(0)
  })
})
