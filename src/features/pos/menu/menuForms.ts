// src/features/pos/menu/menuForms.ts
/** Helpers every /menu form shares. The words match the server's
 *  (supabase/migration-2026-10-24-pos-menu-editor-fn.sql), so a problem reads the same
 *  whether the page or the server finds it. */
import { parseRinggit } from '../checkout/tender'

/** A name as the server stores it: trimmed, inner spaces collapsed (menu_clean_name). */
export const cleanName = (raw: string): string => raw.replace(/\s+/g, ' ').trim()

/** menu_clean_name's words, e.g. "Variant name is required". */
export function nameProblem(what: string, raw: string, max: number): string | null {
  const v = cleanName(raw)
  if (v === '') return `${what} name is required`
  if (v.length > max) return `${what} name is too long (at most ${max} characters)`
  return null
}

/** sen → what a price box shows ("12.50"). */
export const senToInput = (sen: number): string => (sen / 100).toFixed(2)

/** A price box → sen: "12", "12.5", "RM 12.50" (whole sen, up to RM 999 999.99); null otherwise. */
export const inputToSen = (text: string): number | null => parseRinggit(text)

/** The list with the item at `index` moved by `delta` places; the same list when it cannot move. */
export function moveItem<T>(list: T[], index: number, delta: number): T[] {
  const to = index + delta
  if (index < 0 || index >= list.length || to < 0 || to >= list.length || delta === 0) return list
  const next = [...list]
  const [item] = next.splice(index, 1)
  next.splice(to, 0, item)
  return next
}

/** A ref for a new row that no row uses yet: new-1, new-2, … */
export function nextRef(rows: { ref: string }[]): string {
  let n = 1
  while (rows.some((r) => r.ref === `new-${n}`)) n++
  return `new-${n}`
}
