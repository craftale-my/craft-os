import type { Item, StorageLocation, ItemLocation, StockCountEntry, StockCountKind } from '../types'

export const UNASSIGNED = 'unassigned'

export interface CountGroup {
  key: string
  label: string
  /** null = Unassigned. */
  locationId: string | null
  items: Item[]
}

/** Packs + loose base units → base units. Both blank = not counted (null). */
export function packsLooseToBase(packs: number | null, loose: number | null, rate: number): number | null {
  if (packs == null && loose == null) return null
  // Round to 3 dp (as the server stores it) so 3 × 1.1 saves as 3.3, not 3.3000000000000003.
  return Math.round(((packs ?? 0) * rate + (loose ?? 0)) * 1000) / 1000
}

/** Base units → whole packs and the rest, for showing a saved count. */
export function baseToPacksLoose(base: number, rate: number): { packs: number; loose: number } {
  if (rate === 1) return { packs: base, loose: 0 }
  const packs = Math.floor(base / rate + 1e-9)
  const loose = Math.round((base - packs * rate) * 1000) / 1000
  return { packs, loose: loose < 0 ? 0 : loose }
}

/** Items a count of this kind must cover: weekly = active key items, full = every active item. */
export function itemsForCount(items: Item[], kind: StockCountKind): Item[] {
  return items.filter(i => i.status === 'active' && (kind === 'full' || i.count_weekly))
}

/** Key for an item at a location (null location = Unassigned). */
export function entryKey(itemId: string, locationId: string | null): string {
  return `${itemId}:${locationId ?? UNASSIGNED}`
}

/**
 * Count list in walking order: active locations by sort_order, each with its
 * items by sort_order; items in no active location go to a final Unassigned group.
 */
export function groupForCounting(
  items: Item[], locations: StorageLocation[], itemLocations: ItemLocation[],
): CountGroup[] {
  const byId = new Map(items.map(i => [i.id, i]))
  const active = locations.filter(l => l.is_active).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
  const placed = new Set<string>()
  const groups: CountGroup[] = active.map(l => {
    const links = itemLocations
      .filter(link => link.location_id === l.id && byId.has(link.item_id))
      .sort((a, b) => a.sort_order - b.sort_order)
    links.forEach(link => placed.add(link.item_id))
    return { key: l.id, label: l.name, locationId: l.id, items: links.map(link => byId.get(link.item_id)!) }
  }).filter(g => g.items.length > 0)
  const rest = items.filter(i => !placed.has(i.id)).sort((a, b) => a.name.localeCompare(b.name))
  if (rest.length > 0) groups.push({ key: UNASSIGNED, label: 'Unassigned', locationId: null, items: rest })
  return groups
}

/**
 * Entries for in-scope items saved at an (item, location) the count list no longer
 * shows — the location was removed or the item moved during the count. They still
 * add to the item's total at submit, so the screen lists them to be checked or cleared.
 */
export function strayEntries(items: Item[], groups: CountGroup[], entries: StockCountEntry[]): StockCountEntry[] {
  const inScope = new Set(items.map(i => i.id))
  const shown = new Set(groups.flatMap(g => g.items.map(i => entryKey(i.id, g.locationId))))
  return entries.filter(e => inScope.has(e.item_id) && !shown.has(entryKey(e.item_id, e.location_id)))
}

/** How many items in the group have a number at that location. */
export function groupProgress(group: CountGroup, entries: Map<string, number>): { done: number; total: number } {
  const done = group.items.filter(i => entries.has(entryKey(i.id, group.locationId))).length
  return { done, total: group.items.length }
}

/** Items with no entry at any location — submit is blocked while any remain. */
export function uncountedItems(items: Item[], entries: StockCountEntry[]): Item[] {
  const counted = new Set(entries.map(e => e.item_id))
  return items.filter(i => !counted.has(i.id))
}

export interface UncountedSpot { item: Item; locationId: string | null; label: string }

/** Total spots on the count list: one per (item, group location) pair. */
export function countSpotTotal(groups: CountGroup[]): number {
  return groups.reduce((n, g) => n + g.items.length, 0)
}

/**
 * Spots still to count — submit is blocked while any remain. An item needs a number
 * (0 is valid) at EVERY active location it is linked to; an item in the Unassigned
 * group needs an entry anywhere (tolerant of layout changes mid-count). Same rule as
 * the server's submit_stock_count.
 */
export function uncountedSpots(groups: CountGroup[], entries: StockCountEntry[]): UncountedSpot[] {
  const have = new Set(entries.map(e => entryKey(e.item_id, e.location_id)))
  const anywhere = new Set(entries.map(e => e.item_id))
  const out: UncountedSpot[] = []
  for (const g of groups) {
    for (const item of g.items) {
      const counted = g.locationId === null ? anywhere.has(item.id) : have.has(entryKey(item.id, g.locationId))
      if (!counted) out.push({ item, locationId: g.locationId, label: g.label })
    }
  }
  return out
}

/** Biggest RM difference first (loss or gain), then by name. */
export function sortResultLines<T extends { variance_value: number; name: string }>(lines: T[]): T[] {
  return [...lines].sort((a, b) =>
    Math.abs(b.variance_value) - Math.abs(a.variance_value) || a.name.localeCompare(b.name))
}
