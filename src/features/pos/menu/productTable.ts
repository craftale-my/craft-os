// src/features/pos/menu/productTable.ts
/** The Products page's flat table (Feedme's layout), pure so it is tested: which rows show and in
 *  what order, what each cell says, and which rows the bulk bar acts on. */
import type { MenuProductRow, MenuVariantRow } from './menuApi'
import { PRINT_ROUTES, groupMenu, type MenuFilter } from './menuView'

export const NO_FILTER: MenuFilter = { search: '', showAddons: false, showInactive: false, categoryId: null, catalogId: null }

/** The rows the filters show, flat: category order, then product order (groupMenu's order). */
export function tableRows(rows: MenuProductRow[], f: MenuFilter): MenuProductRow[] {
  return groupMenu(rows, f).flatMap((s) => s.products)
}

export const ringgit = (sen: number): string => `RM ${(sen / 100).toFixed(2)}`

/** The default variant's price: the first switched-on variant in variant order; '—' when none is on. */
export function defaultPrice(variants: Pick<MenuVariantRow, 'name' | 'price_sen' | 'is_active' | 'sort_order'>[]): string {
  const first = variants
    .filter((v) => v.is_active)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))[0]
  return first ? ringgit(first.price_sen) : '—'
}

/** "3 variants" under the name when more than one variant is switched on; '' otherwise. */
export function variantCountText(variants: Pick<MenuVariantRow, 'is_active'>[]): string {
  const n = variants.filter((v) => v.is_active).length
  return n > 1 ? `${n} variants` : ''
}

/** The Sold in cell: up to two catalog names, then "+N"; "No catalog" when none sells it. */
export function soldInText(names: string[]): string {
  if (names.length === 0) return 'No catalog'
  return names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`
}

export const sstText = (bp: number): string => `${bp / 100}%`
export const feeText = (sen: number): string => (sen > 0 ? ringgit(sen) : '—')
export const routeText = (route: string | null): string => route ?? 'No ticket'

/** The print routes the bulk bar offers: Feedme's four, then any other name a product uses (A–Z). */
export function routeChoices(rows: Pick<MenuProductRow, 'print_route'>[]): string[] {
  const known: readonly string[] = PRINT_ROUTES
  const extra = new Set<string>()
  for (const r of rows) if (r.print_route && !known.includes(r.print_route)) extra.add(r.print_route)
  return [...known, ...[...extra].sort((a, b) => a.localeCompare(b))]
}

/** The filters and the ticked rows. A filter change clears the ticks: the bulk bar acts only on rows on screen. */
export interface TableState { filter: MenuFilter; selected: ReadonlySet<string> }
export type TableAction =
  | { type: 'filter'; patch: Partial<MenuFilter> }
  | { type: 'toggle'; id: string }
  | { type: 'toggleAll'; visibleIds: string[] }
  | { type: 'clear' }
  | { type: 'prune'; visible: string[] }

const NONE: ReadonlySet<string> = new Set()

export function tableReducer(s: TableState, a: TableAction): TableState {
  switch (a.type) {
    case 'filter':
      return { filter: { ...s.filter, ...a.patch }, selected: NONE }
    case 'toggle': {
      const next = new Set(s.selected)
      if (next.has(a.id)) next.delete(a.id)
      else next.add(a.id)
      return { ...s, selected: next }
    }
    case 'toggleAll': {
      const all = a.visibleIds.length > 0 && a.visibleIds.every((id) => s.selected.has(id))
      return { ...s, selected: all ? NONE : new Set(a.visibleIds) }
    }
    case 'clear':
      return { ...s, selected: NONE }
    case 'prune': {
      // after a reload: ticks on rows that are no longer shown (e.g. just switched off) are dropped
      const shown = new Set(a.visible)
      const kept = [...s.selected].filter((id) => shown.has(id))
      return kept.length === s.selected.size ? s : { ...s, selected: new Set(kept) }
    }
  }
}

/** The header tick box: every visible row ticked, some of them, or none. */
export function headerState(selected: ReadonlySet<string>, visibleIds: string[]): 'all' | 'some' | 'none' {
  const n = visibleIds.filter((id) => selected.has(id)).length
  return n === 0 ? 'none' : n === visibleIds.length ? 'all' : 'some'
}
