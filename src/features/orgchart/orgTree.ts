import type { Rank, SystemRole } from '../../shared/types'
import { RANK_ORDER } from '../../shared/types'

/** One row of get_org_chart(): only what the chart shows, never IC/phone/address. */
export interface OrgPerson {
  id: string
  name: string
  nickname: string | null
  avatar: string | null
  rank: Rank
  system_role: SystemRole
  job_title: string | null
  branch: string | null
  department: string | null
  supervisor_id: string | null
}

/** none: supervisor_id is null. inactive: it points at someone not in the
 *  active list. broken: has a supervisor, but the chain loops. */
export type UnassignedReason = 'none' | 'inactive' | 'broken'

export interface UnassignedEntry {
  person: OrgPerson
  reason: UnassignedReason
}

export interface OrgTree {
  byId: Map<string, OrgPerson>
  roots: OrgPerson[]
  /** Non-owners not reachable from an owner. Only the top of each detached
   *  chain is listed; people below it stay under it. */
  unassigned: UnassignedEntry[]
  childrenOf(id: string): OrgPerson[]
}

const isOwner = (p: OrgPerson) => p.system_role === 'owner'

/** Higher rank first, then name. */
export function compareStaff(a: OrgPerson, b: OrgPerson): number {
  const byRank = RANK_ORDER.indexOf(b.rank) - RANK_ORDER.indexOf(a.rank)
  return byRank !== 0 ? byRank : a.name.localeCompare(b.name)
}

export function buildOrgTree(rows: OrgPerson[]): OrgTree {
  const byId = new Map(rows.map(r => [r.id, r]))
  const children = new Map<string, OrgPerson[]>()
  for (const r of rows) {
    // An owner is always a root, even if someone set a supervisor on them.
    if (isOwner(r) || !r.supervisor_id || r.supervisor_id === r.id || !byId.has(r.supervisor_id)) continue
    const list = children.get(r.supervisor_id) ?? []
    list.push(r)
    children.set(r.supervisor_id, list)
  }
  for (const list of children.values()) list.sort(compareStaff)
  const childrenOf = (id: string) => children.get(id) ?? []

  const roots = rows.filter(isOwner).sort(compareStaff)

  const reached = new Set<string>()
  const queue = roots.map(r => r.id)
  while (queue.length) {
    const id = queue.shift()!
    if (reached.has(id)) continue
    reached.add(id)
    for (const c of childrenOf(id)) queue.push(c.id)
  }

  const unassigned: UnassignedEntry[] = []
  for (const r of rows) {
    if (isOwner(r) || reached.has(r.id)) continue
    if (!r.supervisor_id || r.supervisor_id === r.id) {
      unassigned.push({ person: r, reason: 'none' })
      continue
    }
    if (!byId.has(r.supervisor_id)) {
      unassigned.push({ person: r, reason: 'inactive' })
      continue
    }
    // Has a live supervisor but is unreached: walk up. If the walk ends at
    // someone with no valid supervisor, that person is the listed top, not r.
    // If it loops, list r only when r is part of the loop itself.
    // (Chains that reach an owner are already in `reached`.)
    let node: OrgPerson = r
    const seen: string[] = []
    let loopStart = -1
    for (;;) {
      seen.push(node.id)
      const next = node.supervisor_id ? byId.get(node.supervisor_id) : undefined
      if (!next || next.id === node.id) break          // ends at an unassigned top
      const at = seen.indexOf(next.id)
      if (at >= 0) { loopStart = at; break }           // found a loop
      node = next
    }
    if (loopStart >= 0 && seen.slice(loopStart).includes(r.id)) {
      unassigned.push({ person: r, reason: 'broken' })
    }
  }
  unassigned.sort((a, b) => a.person.name.localeCompare(b.person.name))

  return { byId, roots, unassigned, childrenOf }
}

/** Direct supervisor first, the top of the chain last. Stops at an owner, at
 *  a missing supervisor, or at the first repeat (bad data never loops). */
export function chainOf(tree: OrgTree, id: string): OrgPerson[] {
  const out: OrgPerson[] = []
  const seen = new Set<string>([id])
  let cur = tree.byId.get(id)
  while (cur && !isOwner(cur) && cur.supervisor_id) {
    const sup = tree.byId.get(cur.supervisor_id)
    if (!sup || seen.has(sup.id)) break
    out.push(sup)
    seen.add(sup.id)
    cur = sup
  }
  return out
}

export function descendantsOf(tree: OrgTree, id: string): Set<string> {
  const out = new Set<string>()
  const queue = tree.childrenOf(id).map(c => c.id)
  while (queue.length) {
    const next = queue.shift()!
    if (out.has(next) || next === id) continue
    out.add(next)
    for (const c of tree.childrenOf(next)) queue.push(c.id)
  }
  return out
}

/** Who may be picked as this person's supervisor: anyone active except the
 *  person and their own reports (picking one of those would make a loop). */
export function supervisorChoices(tree: OrgTree, personId: string): OrgPerson[] {
  const blocked = descendantsOf(tree, personId)
  blocked.add(personId)
  return [...tree.byId.values()].filter(p => !blocked.has(p.id)).sort(compareStaff)
}

/** Ids to expand so `levels` levels below each root are visible. */
export function initialExpanded(tree: OrgTree, levels: number): Set<string> {
  const out = new Set<string>()
  let frontier = tree.roots
  for (let depth = 0; depth < levels && frontier.length; depth++) {
    const next: OrgPerson[] = []
    for (const p of frontier) {
      if (out.has(p.id)) continue
      out.add(p.id)
      next.push(...tree.childrenOf(p.id))
    }
    frontier = next
  }
  return out
}

export function searchPeople(tree: OrgTree, query: string, limit = 8): OrgPerson[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return [...tree.byId.values()]
    .filter(p => p.name.toLowerCase().includes(q) || (p.nickname ?? '').toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit)
}
