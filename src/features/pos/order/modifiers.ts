// src/features/pos/order/modifiers.ts
/** Pure parts of the Feedme modifier sheet and product tiles (spec §2). */
import type { OrderLine, PosGroup } from './cart'

/** A required group shows a red "SELECT n" ("SELECT 1–2" for a range); an optional one a grey
 *  "OPTIONAL" or "UP TO n". */
export function groupBadge(g: Pick<PosGroup, 'min' | 'max'>): { text: string; required: boolean } {
  if (g.min > 0) return { text: g.min === g.max ? `SELECT ${g.min}` : `SELECT ${g.min}–${g.max}`, required: true }
  return { text: g.max === 1 ? 'OPTIONAL' : `UP TO ${g.max}`, required: false }
}

/** Tap an option — LineSheet's rule, unchanged: in a one-choice group it takes the place of the
 *  choice (or clears it when tapped again); in a many-choice group it is added or removed. Other
 *  groups keep theirs. validateLine still judges the counts. */
export function toggleOption(line: OrderLine, groupMax: number, groupOptionIds: string[], id: string): OrderLine {
  const inGroup = line.optionIds.filter((x) => groupOptionIds.includes(x))
  const others = line.optionIds.filter((x) => !groupOptionIds.includes(x))
  if (groupMax === 1) return { ...line, optionIds: inGroup[0] === id ? others : [...others, id] }
  return { ...line, optionIds: inGroup.includes(id) ? [...others, ...inGroup.filter((x) => x !== id)] : [...others, ...inGroup, id] }
}

/** A product with no photo shows its first three letters on a grey block (Feedme's "Cus"). */
export function tileInitials(name: string): string {
  return name.replace(/\s+/g, '').slice(0, 3)
}

/** W7 spec §4: the item sheet's Takeaway switch. On: the line carries takeaway: true (a takeaway line inside a
 *  dine-in bill); off: the key is gone, so the line is exactly what it was before W7. */
export function withTakeaway(line: OrderLine, on: boolean): OrderLine {
  const { takeaway: _drop, ...rest } = line
  void _drop
  return on ? { ...rest, takeaway: true } : rest
}
