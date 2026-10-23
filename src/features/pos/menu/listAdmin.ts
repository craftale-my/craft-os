// src/features/pos/menu/listAdmin.ts
/** Pure helpers for the Catalogs and Categories pages: names, order, where a catalog is used. */
import type { CatalogRole } from './menuEditorApi'
import { cleanName, moveItem, nameProblem } from './menuForms'

/** menu_save_catalog / menu_save_category's words: required, at most 60 characters,
 *  no other row of that name (letter case ignored). */
export function listNameProblem(
  what: 'Catalog' | 'Category', raw: string, rows: { id: string; name: string }[], selfId: string | null,
): string | null {
  const problem = nameProblem(what, raw, 60)
  if (problem) return problem
  const name = cleanName(raw)
  return rows.some((r) => r.id !== selfId && r.name.toLowerCase() === name.toLowerCase())
    ? `A ${what.toLowerCase()} called ${name} already exists`
    : null
}

/** The ids in their new order after moving one row, or null when it cannot move. */
export function reorderedIds(rows: { id: string }[], index: number, delta: number): string[] | null {
  const next = moveItem(rows, index, delta)
  return next === rows ? null : next.map((r) => r.id)
}

/** "Catalog copy", then "Catalog copy 2", … — the first name no row uses. */
export function copyName(name: string, rows: { name: string }[]): string {
  const taken = new Set(rows.map((r) => r.name.toLowerCase()))
  let candidate = `${name} copy`
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${name} copy ${n}`
  return candidate
}

const ROLE_WORDS: Record<CatalogRole, string> = { dine_in: 'dine-in', takeaway: 'takeaway', qr: 'QR', additional: 'additional' }
const ROLE_ORDER: CatalogRole[] = ['dine_in', 'takeaway', 'qr', 'additional']

/** Where a catalog is used, per branch: "Cheras: dine-in, takeaway, QR · Puchong: additional". */
export function catalogUseText(uses: { branch: string; role: CatalogRole }[]): string {
  if (uses.length === 0) return 'Not used by any branch'
  const byBranch = new Map<string, CatalogRole[]>()
  for (const u of uses) byBranch.set(u.branch, [...(byBranch.get(u.branch) ?? []), u.role])
  return [...byBranch.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([branch, roles]) => `${branch}: ${[...roles].sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b)).map((r) => ROLE_WORDS[r]).join(', ')}`)
    .join(' · ')
}
