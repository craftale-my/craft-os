import type { Availability } from './feedmeExport'
import type { MenuProductRow, MenuVariantRow } from './menuApi'

/** Feedme's print routes at Craft Cafe (portal → Menu → Print route, 2026-10-22). */
export const PRINT_ROUTES = ['Bar', 'Kitchen', 'Bakery', 'Front House'] as const
export const SST_CHOICES = [
  { bp: 600, label: '6%' },
  { bp: 0, label: '0%' },
] as const
export const AVAILABILITY_LABELS: Record<Availability, string> = {
  all: 'Counter + QR',
  counter_only: 'Counter only',
  hidden: 'Hidden',
}

export interface MenuSection { title: string; products: MenuProductRow[] }

const rm = (sen: number) => (sen / 100).toFixed(2)

export function formatPrice(variants: Pick<MenuVariantRow, 'price_sen' | 'is_active'>[]): string {
  const prices = variants.filter((v) => v.is_active).map((v) => v.price_sen)
  if (prices.length === 0) return '—'
  const lo = Math.min(...prices)
  const hi = Math.max(...prices)
  return lo === hi ? `RM ${rm(lo)}` : `RM ${rm(lo)} – ${rm(hi)}`
}

export function groupMenu(rows: MenuProductRow[], opts: { showAddons: boolean; search: string }): MenuSection[] {
  const q = opts.search.trim().toLowerCase()
  const sections = new Map<string, { order: number; products: MenuProductRow[] }>()
  for (const r of rows) {
    if (!opts.showAddons && r.is_addon) continue
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
