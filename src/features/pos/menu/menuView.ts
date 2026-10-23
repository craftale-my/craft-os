import type { Availability } from './feedmeExport'
import type { MenuProductRow, MenuVariantRow } from './menuApi'

/** Feedme's print routes at Craft Cafe (portal → Menu → Print route, 2026-10-22). */
export const PRINT_ROUTES = ['Bar', 'Kitchen', 'Bakery', 'Front House'] as const
export const SST_CHOICES = [
  { bp: 600, label: '6%' },
  { bp: 0, label: '0%' },
] as const
/** A product in one catalog; 'hidden' = the catalog does not sell it. */
export const CATALOG_AVAILABILITY_LABELS: Record<Availability, string> = {
  hidden: 'Not in this catalog',
  all: 'Counter + QR',
  counter_only: 'Counter only',
}

/** The /menu sub-navigation. `match` decides which tab a path belongs to. */
export type MenuTab = 'products' | 'catalogs' | 'groups' | 'categories' | 'import'
export const MENU_TABS: { id: Exclude<MenuTab, 'import'>; label: string; to: string }[] = [
  { id: 'products', label: 'Products', to: '/menu' },
  { id: 'catalogs', label: 'Catalogs', to: '/menu/catalogs' },
  { id: 'groups', label: 'Add-on groups', to: '/menu/groups' },
  { id: 'categories', label: 'Categories', to: '/menu/categories' },
]
export function menuTab(pathname: string): MenuTab {
  const rest = pathname.replace(/^\/menu\/?/, '')
  if (rest.startsWith('catalogs')) return 'catalogs'
  if (rest.startsWith('groups')) return 'groups'
  if (rest.startsWith('categories')) return 'categories'
  if (rest.startsWith('import')) return 'import'
  return 'products'
}

export interface MenuSection { title: string; products: MenuProductRow[] }
export interface MenuFilter {
  search: string
  showAddons: boolean
  showInactive: boolean
  categoryId: string | null
  /** only the products this catalog sells */
  catalogId: string | null
}

const rm = (sen: number) => (sen / 100).toFixed(2)

export function formatPrice(variants: Pick<MenuVariantRow, 'price_sen' | 'is_active'>[]): string {
  const prices = variants.filter((v) => v.is_active).map((v) => v.price_sen)
  if (prices.length === 0) return '—'
  const lo = Math.min(...prices)
  const hi = Math.max(...prices)
  return lo === hi ? `RM ${rm(lo)}` : `RM ${rm(lo)} – ${rm(hi)}`
}

/** The names of the catalogs that sell a product, in catalog order. */
export function soldIn(catalogIds: string[], catalogs: { id: string; name: string; sortOrder: number }[]): string[] {
  return catalogs
    .filter((c) => catalogIds.includes(c.id))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map((c) => c.name)
}

export function groupMenu(rows: MenuProductRow[], f: MenuFilter): MenuSection[] {
  const q = f.search.trim().toLowerCase()
  const sections = new Map<string, { order: number; products: MenuProductRow[] }>()
  for (const r of rows) {
    if (!f.showAddons && r.is_addon) continue
    if (!f.showInactive && !r.is_active) continue
    if (f.categoryId && r.category_id !== f.categoryId) continue
    if (f.catalogId && !r.catalog_ids.includes(f.catalogId)) continue
    if (q && !r.name.toLowerCase().includes(q)) continue
    const title = r.category?.name ?? 'Uncategorised'
    if (!sections.has(title)) sections.set(title, { order: r.category?.sort_order ?? Number.MAX_SAFE_INTEGER, products: [] })
    sections.get(title)!.products.push(r)
  }
  return [...sections.entries()]
    .sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]))
    .map(([title, s]) => ({
      title,
      products: s.products.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    }))
}
