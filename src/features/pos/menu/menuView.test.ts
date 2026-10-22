import { describe, expect, it } from 'vitest'
import { formatPrice, groupMenu } from './menuView'
import type { MenuProductRow } from './menuApi'

function row(over: Partial<MenuProductRow>): MenuProductRow {
  return {
    id: over.name ?? 'x', name: 'x', availability: 'all', is_addon: false, sst_rate_bp: 600, print_route: null,
    takeaway_fee_sen: 0, sort_order: 0, category: { name: 'TEA', sort_order: 0 }, menu_variants: [], ...over,
  }
}
const v = (price_sen: number, is_active = true) => ({ id: String(price_sen), name: 'v', price_sen, is_active, sort_order: 0 })

describe('formatPrice', () => {
  it('shows one price, a range, or a dash, ignoring switched-off variants', () => {
    expect(formatPrice([v(1000)])).toBe('RM 10.00')
    expect(formatPrice([v(1000), v(1150), v(900, false)])).toBe('RM 10.00 – 11.50')
    expect(formatPrice([v(900, false)])).toBe('—')
  })
})

describe('groupMenu', () => {
  const rows = [
    row({ name: 'Oat milk', is_addon: true, category: { name: 'ADDON', sort_order: 2 } }),
    row({ name: 'Smoked Duck DON', sort_order: 1, category: { name: 'DONBURI', sort_order: 1 } }),
    row({ name: 'Lychee Rose', sort_order: 2 }),
    row({ name: 'Apple Tea', sort_order: 1 }),
    row({ name: 'Mystery', category: null }),
  ]

  it('orders sections by category and products by sort order, hiding add-ons by default', () => {
    const s = groupMenu(rows, { showAddons: false, search: '' })
    expect(s.map((x) => x.title)).toEqual(['TEA', 'DONBURI', 'Uncategorised'])
    expect(s[0].products.map((p) => p.name)).toEqual(['Apple Tea', 'Lychee Rose'])
  })

  it('shows add-ons when asked', () => {
    expect(groupMenu(rows, { showAddons: true, search: '' }).map((x) => x.title)).toContain('ADDON')
  })

  it('filters by name, case-insensitively', () => {
    const s = groupMenu(rows, { showAddons: false, search: 'duck' })
    expect(s).toHaveLength(1)
    expect(s[0].products[0].name).toBe('Smoked Duck DON')
  })
})
