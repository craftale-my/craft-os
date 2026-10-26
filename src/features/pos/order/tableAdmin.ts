import type { TableRow } from './posApi'

export type AddAction = 'insert' | 'reactivate' | 'exists'

/** What to do when a manager adds a table with this label. */
export function addTableAction(label: string, active: Pick<TableRow, 'label'>[], inactiveExists: boolean): AddAction {
  if (active.some((t) => t.label === label)) return 'exists'
  return inactiveExists ? 'reactivate' : 'insert'
}

/** Error text if renaming table `selfId` to `label` would collide, else null. */
export function renameConflict(label: string, selfId: string, active: Pick<TableRow, 'id' | 'label'>[], inactiveExists: boolean): string | null {
  const clash = active.some((t) => t.id !== selfId && t.label === label) || inactiveExists
  return clash ? `Another table is already called ${label}.` : null
}

export function openBillMessage(label: string, billNo: string): string {
  return `Table ${label} has an open bill (${billNo}) — close it before removing the table.`
}

export function friendlyDbMessage(msg: string): string {
  return msg.includes('duplicate key value') ? 'That label is already used by another table.' : msg
}

export const AREA_MAX = 40

/** A table's area as typed in POS settings: trimmed with inner spaces collapsed; empty = no area
 *  (null). At most 40 characters, the dining_tables_area_check limit (counted as Postgres does). */
export function normalizeArea(text: string): { area: string | null } | { problem: string } {
  const area = text.trim().replace(/\s+/g, ' ')
  if (!area) return { area: null }
  if ([...area].length > AREA_MAX) return { problem: `An area name is at most ${AREA_MAX} characters` }
  return { area }
}
