import type { Capability } from '../types'

/**
 * Which entries the mobile bottom tab bar shows, and in what order.
 *
 * The bar only fits five slots and the last one is always "More" (the full
 * sidebar drawer), so at most four real destinations survive. Rather than hand
 * maintaining a tab set per role, each set below is an *ordered candidate list*
 * that gets filtered by capability and truncated — so a role we haven't thought
 * of still lands on a sensible four, and adding a capability never leaves the
 * bar short.
 *
 * Presentation (label, route, icon) lives in BottomTabs; this module stays free
 * of React so the selection rule can be unit-tested on its own.
 */
export type TabId =
  | 'profile'
  | 'attendance'
  | 'schedule'
  | 'missions'
  | 'team'
  | 'tasks'
  | 'orders'

interface TabRule {
  id: TabId
  /** Omit ⇒ available to everyone. */
  cap?: Capability
}

/** Someone who oversees other people: their own pages move into More. */
const MANAGER_TABS: TabRule[] = [
  { id: 'team', cap: 'view_team' },
  { id: 'schedule' },
  { id: 'tasks', cap: 'view_team' },
  { id: 'orders', cap: 'use_procurement' },
  // Reached by a supervisor who has no procurement access.
  { id: 'attendance' },
]

/** Everyone else: the four things a barista opens during a shift. */
const STAFF_TABS: TabRule[] = [
  { id: 'profile' },
  { id: 'attendance' },
  { id: 'schedule' },
  { id: 'missions' },
]

/** Real destinations in the bar. The fifth slot is always "More". */
export const MAX_TABS = 4

export function pickTabIds(
  can: (cap: Capability) => boolean,
  limit: number = MAX_TABS,
): TabId[] {
  const candidates = can('view_team') ? MANAGER_TABS : STAFF_TABS
  return candidates
    .filter(t => !t.cap || can(t.cap))
    .slice(0, limit)
    .map(t => t.id)
}
