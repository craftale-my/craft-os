// src/features/pos/order/catalogs.ts
/** Which menu catalog prices an order. Mirrors pos_order_catalog
 *  (supabase/migration-2026-10-24-pos-catalogs-fn.sql): the branch's catalog for
 *  the order type is the default, and at the counter the cashier may switch the
 *  whole order to one of the branch's additional catalogs. Same words as the server. */
import type { OrderType } from '../offline/orderQueue'

export type CatalogRole = 'dine_in' | 'takeaway' | 'qr' | 'additional'
export type DefaultRole = Exclude<CatalogRole, 'additional'>
export interface CatalogRow { id: string; name: string; is_active: boolean; sort_order: number }
export interface BranchCatalogRow { role: CatalogRole; catalog_id: string }
export interface BranchCatalogs { catalogs: CatalogRow[]; assignments: BranchCatalogRow[] }
/** One entry of the order pad's catalog list. `offered` is false only for the catalog
 *  of an edited order that the branch no longer offers. */
export interface CatalogChoice { id: string; name: string; isDefault: boolean; offered: boolean }
/** What save_branch_catalogs takes (POS settings → Menu catalogs). */
export interface BranchCatalogSettings { dineIn: string | null; takeaway: string | null; qr: string | null; additional: string[] }

export const SWITCH_CATALOG_CONFIRM = 'Switching catalog clears the cart'

const ROLE_WORDS: Record<DefaultRole, string> = { dine_in: 'dine-in', takeaway: 'takeaway', qr: 'QR' }

/** pos_order_catalog's words when the branch has no catalog for the role. */
export function noCatalogMessage(role: DefaultRole): string {
  return `No menu catalog is set for ${ROLE_WORDS[role]} — set it in POS settings`
}

const bySort = (a: CatalogRow, b: CatalogRow) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)

/** Active catalogs in their order (what the settings selects and ticks offer). */
export function activeCatalogs(catalogs: CatalogRow[]): CatalogRow[] {
  return catalogs.filter((c) => c.is_active).sort(bySort)
}

export function defaultCatalogId(rows: BranchCatalogRow[], role: DefaultRole): string | null {
  return rows.find((r) => r.role === role)?.catalog_id ?? null
}

/** Why the order type has no usable default (null when it has one): none is set, or
 *  the one set is switched off. The pad shows this and waits for an explicit pick. */
export function defaultCatalogProblem(rows: BranchCatalogRow[], catalogs: CatalogRow[], role: DefaultRole): string | null {
  const id = defaultCatalogId(rows, role)
  if (!id) return noCatalogMessage(role)
  const c = catalogs.find((x) => x.id === id)
  if (!c) return noCatalogMessage(role)
  return c.is_active ? null : `The ${ROLE_WORDS[role]} catalog ${c.name} is switched off — choose another in POS settings`
}

/** The order pad's catalog list: the order type's default first (only when it is
 *  active), then the branch's additional catalogs in catalog order — active ones only,
 *  each once. An order being edited keeps its own catalog even when it is no longer
 *  offered (`offered: false`; the server would refuse it in its own words). */
export function selectableCatalogs(
  rows: BranchCatalogRow[], catalogs: CatalogRow[], orderType: OrderType, keepId: string | null = null,
): CatalogChoice[] {
  const byId = new Map(catalogs.map((c) => [c.id, c]))
  const out: CatalogChoice[] = []
  const def = byId.get(defaultCatalogId(rows, orderType) ?? '')
  if (def?.is_active) out.push({ id: def.id, name: def.name, isDefault: true, offered: true })
  const extra = rows
    .filter((r) => r.role === 'additional')
    .map((r) => byId.get(r.catalog_id))
    .filter((c): c is CatalogRow => c !== undefined && c.is_active)
    .sort(bySort)
  for (const c of extra) if (!out.some((o) => o.id === c.id)) out.push({ id: c.id, name: c.name, isDefault: false, offered: true })
  if (keepId && !out.some((o) => o.id === keepId)) {
    out.push({ id: keepId, name: byId.get(keepId)?.name ?? 'Unknown catalog', isDefault: false, offered: false })
  }
  return out
}

export function catalogSettingsFrom(rows: BranchCatalogRow[]): BranchCatalogSettings {
  return {
    dineIn: defaultCatalogId(rows, 'dine_in'),
    takeaway: defaultCatalogId(rows, 'takeaway'),
    qr: defaultCatalogId(rows, 'qr'),
    additional: rows.filter((r) => r.role === 'additional').map((r) => r.catalog_id),
  }
}

/** Same words as save_branch_catalogs, plus a clearer one for a default that was switched off. */
export function catalogSettingsProblem(s: BranchCatalogSettings, catalogs: CatalogRow[] = []): string | null {
  const roles: [DefaultRole, string | null][] = [['dine_in', s.dineIn], ['takeaway', s.takeaway], ['qr', s.qr]]
  for (const [role, id] of roles) {
    if (!id) return `Choose the ${ROLE_WORDS[role]} catalog`
    const c = catalogs.find((x) => x.id === id)
    if (c && !c.is_active) return `The ${ROLE_WORDS[role]} catalog ${c.name} is switched off — choose another`
  }
  return null
}

/** What Save sends: a ticked additional catalog that was switched off since is dropped
 *  (the server refuses inactive catalogs), so it never blocks saving the rest. */
export function settingsToSave(s: BranchCatalogSettings, catalogs: CatalogRow[]): BranchCatalogSettings {
  const active = new Set(catalogs.filter((c) => c.is_active).map((c) => c.id))
  return { ...s, additional: s.additional.filter((id) => active.has(id)) }
}

/** The additional tick boxes: every active catalog, plus any switched-off catalog that is
 *  still ticked (shown so it can be unticked), in catalog order. */
export function additionalChoices(s: BranchCatalogSettings, catalogs: CatalogRow[]): CatalogRow[] {
  return catalogs.filter((c) => c.is_active || s.additional.includes(c.id)).sort(bySort)
}

export function toggleAdditional(s: BranchCatalogSettings, id: string, on: boolean): BranchCatalogSettings {
  return { ...s, additional: on ? [...new Set([...s.additional, id])] : s.additional.filter((x) => x !== id) }
}
