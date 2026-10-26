// src/features/pos/order/home.ts
/** The home screen's pure rules (spec §1): the area tabs, which tables a tab or the search
 *  shows, and how long a bill has been open. */
import type { OpenBillRow, TableRow } from './posApi'

/** One area tab. `area` null = All. `openCount` = tables of the tab that have an open bill. */
export interface AreaTab { area: string | null; label: string; openCount: number }

/** All first, then one tab per area in table order: an area sits where its lowest sort_order
 *  is (ties by name). A table with no area is only under All. */
export function areaTabs(tables: TableRow[], bills: OpenBillRow[]): AreaTab[] {
  const busy = new Set(bills.flatMap((b) => (b.table_id ? [b.table_id] : [])))
  const areas = new Map<string, { sort: number; open: number }>()
  for (const t of tables) {
    if (!t.area) continue
    const a = areas.get(t.area) ?? { sort: t.sort_order, open: 0 }
    a.sort = Math.min(a.sort, t.sort_order)
    if (busy.has(t.id)) a.open++
    areas.set(t.area, a)
  }
  return [
    { area: null, label: 'All', openCount: tables.filter((t) => busy.has(t.id)).length },
    ...[...areas.entries()]
      .sort((x, y) => x[1].sort - y[1].sort || x[0].localeCompare(y[0]))
      .map(([area, a]) => ({ area, label: area, openCount: a.open })),
  ]
}

/** A tab that no longer exists (its last table moved to another area) falls back to All. */
export function currentArea(tabs: AreaTab[], area: string | null): string | null {
  return tabs.some((t) => t.area === area) ? area : null
}

/** The tables the tab shows. A search (on the label, any case) looks in every area, so a table
 *  is found from whichever tab is open. */
export function visibleTables(tables: TableRow[], area: string | null, search: string): TableRow[] {
  const q = search.trim().toLowerCase()
  if (q) return tables.filter((t) => t.label.toLowerCase().includes(q))
  return area === null ? tables : tables.filter((t) => t.area === area)
}

/** "12m" under an hour, "1h 05m" from an hour; never negative (an iPad clock a little behind). */
export function elapsedLabel(openedAtIso: string, nowMs: number): string {
  const min = Math.max(0, Math.floor((nowMs - Date.parse(openedAtIso)) / 60_000))
  if (min < 60) return `${min}m`
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`
}
