import { describe, expect, it } from 'vitest'
import { formatPrice, groupMenu, menuTab, soldIn, type MenuFilter } from './menuView'
import type { MenuProductRow } from './menuApi'

function row(over: Partial<MenuProductRow>): MenuProductRow {
  return {
    id: over.name ?? 'x', name: 'x', is_active: true, is_addon: false, sst_rate_bp: 600, print_route: null,
    takeaway_fee_sen: 0, sort_order: 0, category_id: 'tea', category: { name: 'TEA', sort_order: 0 }, menu_variants: [],
    catalog_ids: [], ...over,
  }
}
const v = (price_sen: number, is_active = true) => ({ id: String(price_sen), name: 'v', price_sen, is_active, sort_order: 0 })
const all: MenuFilter = { search: '', showAddons: false, showInactive: false, categoryId: null, catalogId: null }

describe('formatPrice', () => {
  it('shows one price, a range, or a dash, ignoring switched-off variants', () => {
    expect(formatPrice([v(1000)])).toBe('RM 10.00')
    expect(formatPrice([v(1000), v(1150), v(900, false)])).toBe('RM 10.00 – 11.50')
    expect(formatPrice([v(900, false)])).toBe('—')
  })
})

describe('soldIn', () => {
  it('names the catalogs that sell a product, in catalog order', () => {
    const catalogs = [{ id: 'g', name: 'Grab Food', sortOrder: 6 }, { id: 'c', name: 'Craft Cafe', sortOrder: 0 }, { id: 's', name: 'Staff Meal', sortOrder: 3 }]
    expect(soldIn(['g', 'c'], catalogs)).toEqual(['Craft Cafe', 'Grab Food'])
    expect(soldIn([], catalogs)).toEqual([])
  })
})

describe('menuTab', () => {
  it('maps every /menu path to its tab', () => {
    expect(menuTab('/menu')).toBe('products')
    expect(menuTab('/menu/')).toBe('products')
    expect(menuTab('/menu/products/new')).toBe('products')
    expect(menuTab('/menu/catalogs/abc')).toBe('catalogs')
    expect(menuTab('/menu/groups/new')).toBe('groups')
    expect(menuTab('/menu/categories')).toBe('categories')
    expect(menuTab('/menu/import')).toBe('import')
  })
})

describe('groupMenu', () => {
  const rows = [
    row({ name: 'Oat milk', is_addon: true, category_id: 'addon', category: { name: 'ADDON', sort_order: 2 } }),
    row({ name: 'Smoked Duck DON', sort_order: 1, category_id: 'don', category: { name: 'DONBURI', sort_order: 1 }, catalog_ids: ['grab'] }),
    row({ name: 'Lychee Rose', sort_order: 2, catalog_ids: ['cafe', 'grab'] }),
    row({ name: 'Apple Tea', sort_order: 1, catalog_ids: ['cafe'] }),
    row({ name: 'Old Tea', is_active: false }),
    row({ name: 'Mystery', category_id: null, category: null }),
  ]

  it('orders sections by category and products by sort order, hiding add-ons and switched-off products by default', () => {
    const s = groupMenu(rows, all)
    expect(s.map((x) => x.title)).toEqual(['TEA', 'DONBURI', 'Uncategorised'])
    expect(s[0].products.map((p) => p.name)).toEqual(['Apple Tea', 'Lychee Rose'])
  })

  it('shows add-ons and switched-off products when asked', () => {
    expect(groupMenu(rows, { ...all, showAddons: true }).map((x) => x.title)).toContain('ADDON')
    expect(groupMenu(rows, { ...all, showInactive: true })[0].products.map((p) => p.name)).toContain('Old Tea')
  })

  it('filters by name, case-insensitively', () => {
    const s = groupMenu(rows, { ...all, search: 'duck' })
    expect(s).toHaveLength(1)
    expect(s[0].products[0].name).toBe('Smoked Duck DON')
  })

  it('filters by category and by the catalog that sells it', () => {
    expect(groupMenu(rows, { ...all, categoryId: 'don' }).map((x) => x.title)).toEqual(['DONBURI'])
    expect(groupMenu(rows, { ...all, catalogId: 'grab' }).flatMap((x) => x.products.map((p) => p.name)))
      .toEqual(['Lychee Rose', 'Smoked Duck DON'])
  })
})
