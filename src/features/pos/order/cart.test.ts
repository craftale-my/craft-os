// src/features/pos/order/cart.test.ts
import { describe, it, expect } from 'vitest'
import {
  buildPosMenu, posMenuFromQr, defaultLine, linePriceSen, validateLine, lineLabel, cartSubtotalSen, cartKey, formatSen,
  type ProductRow, type GroupRow, type LinkRow,
} from './cart'

const latte: ProductRow = {
  id: 'p-latte', name: 'Coffee Latte ', description: null, availability: 'all', is_addon: false, is_active: true, sort_order: 2,
  category: { name: 'MILK COFFEE', sort_order: 1 },
  menu_variants: [
    { id: 'v-cold', name: 'COLD', price_sen: 1400, is_active: true, sort_order: 1, feedme_variant_key: 'v/cold' },
    { id: 'v-hot', name: 'HOT', price_sen: 1200, is_active: true, sort_order: 0, feedme_variant_key: 'v/hot' },
    { id: 'v-old', name: 'OLD', price_sen: 1, is_active: false, sort_order: 9, feedme_variant_key: 'v/old' },
  ],
}
const water: ProductRow = {
  id: 'p-water', name: 'Sky Juice', description: null, availability: 'counter_only', is_addon: false, is_active: true, sort_order: 0,
  category: { name: 'TEA', sort_order: 2 },
  menu_variants: [{ id: 'v-water', name: 'Sky Juice', price_sen: 100, is_active: true, sort_order: 0, feedme_variant_key: '' }],
}
const oat: ProductRow = { ...water, id: 'p-oat', name: 'Oat milk', is_addon: true, availability: 'all', menu_variants: [] }
const hidden: ProductRow = { ...water, id: 'p-hidden', name: 'Secret', availability: 'hidden' }
const milk: GroupRow = {
  id: 'g-milk', name: 'Milk', min_select: 0, max_select: 1, is_active: true, sort_order: 0,
  modifier_options: [
    { id: 'o-oat', name: 'Oat milk', price_delta_sen: 200, is_default: false, availability: 'all', sort_order: 1, product_id: 'p-oat' },
    { id: 'o-full', name: 'Full cream', price_delta_sen: 0, is_default: true, availability: 'all', sort_order: 0, product_id: null },
    { id: 'o-secret', name: 'Hidden', price_delta_sen: 0, is_default: false, availability: 'hidden', sort_order: 2, product_id: null },
  ],
}
const links: LinkRow[] = [{ product_id: 'p-latte', group_id: 'g-milk', sort_order: 0 }]

describe('buildPosMenu', () => {
  it('groups by category in sort order, hides add-ons, hidden and variant-less products', () => {
    const m = buildPosMenu([water, latte, oat, hidden], [milk], links, [], 'counter')
    expect(m.categories.map((c) => c.name)).toEqual(['MILK COFFEE', 'TEA'])
    expect(m.categories[1].products.map((p) => p.name)).toEqual(['Sky Juice'])
    const p = m.categories[0].products[0]
    expect(p.name).toBe('Coffee Latte')                       // trimmed
    expect(p.variants.map((v) => v.name)).toEqual(['HOT', 'COLD'])  // active only, by sort_order
    expect(p.groups[0].options.map((o) => o.name)).toEqual(['Full cream', 'Oat milk'])  // hidden option dropped
  })

  it('qr mode drops counter_only products and marks sold-out products and options', () => {
    const m = buildPosMenu([water, latte, oat], [milk], links, [{ product_id: 'p-oat', is_sold_out: true }], 'qr')
    expect(m.categories.map((c) => c.name)).toEqual(['MILK COFFEE'])
    const p = m.categories[0].products[0]
    expect(p.soldOut).toBe(false)
    expect(p.groups[0].options.find((o) => o.id === 'o-oat')?.available).toBe(false)
  })
})

describe('lines', () => {
  const menu = buildPosMenu([latte], [milk], links, [], 'counter')
  const p = menu.categories[0].products[0]

  it('defaultLine picks the first variant and the default options', () => {
    expect(defaultLine(p)).toEqual({ productId: 'p-latte', variantId: 'v-hot', qty: 1, note: null, optionIds: ['o-full'] })
  })

  it('prices variant + modifiers', () => {
    expect(linePriceSen(p, { ...defaultLine(p), variantId: 'v-cold', optionIds: ['o-oat'] })).toBe(1600)
    expect(linePriceSen(p, { ...defaultLine(p), variantId: 'v-nope' })).toBeNull()
  })

  it('validates with the server’s words', () => {
    const ok = defaultLine(p)
    expect(validateLine(p, ok)).toBeNull()
    expect(validateLine(p, { ...ok, optionIds: ['o-oat', 'o-oat'] })).toBe('Invalid add-ons')
    expect(validateLine(p, { ...ok, optionIds: ['o-oat', 'o-full'] })).toBe('Choose at most 1 for Coffee Latte: Milk')
    expect(validateLine({ ...p, groups: [{ ...p.groups[0], min: 1 }] }, { ...ok, optionIds: [] })).toBe('Choose at least 1 for Coffee Latte: Milk')
    expect(validateLine(p, { ...ok, optionIds: ['o-nope'] })).toBe('Add-on is not available for Coffee Latte')
    expect(validateLine(p, { ...ok, qty: 21 })).toBe('Invalid quantity')
    expect(validateLine({ ...p, soldOut: true }, ok)).toBe('Sold out: Coffee Latte')
  })

  it('labels like the server snapshot', () => {
    expect(lineLabel(p, { ...defaultLine(p), variantId: 'v-cold', optionIds: ['o-oat'] })).toEqual({ name: 'Coffee Latte (COLD)', mods: ['Oat milk'] })
    const single = buildPosMenu([water], [], [], [], 'counter').categories[0].products[0]
    expect(lineLabel(single, defaultLine(single)).name).toBe('Sky Juice')   // base variant: no suffix
  })

  it('subtotal and a stable key', () => {
    const lines = [{ ...defaultLine(p), qty: 2 }, { ...defaultLine(p), variantId: 'v-cold', optionIds: ['o-oat'] }]
    expect(cartSubtotalSen(menu, lines)).toBe(2400 + 1600)
    expect(cartKey(lines)).toBe(cartKey([...lines].map((l) => ({ ...l, optionIds: [...l.optionIds] }))))
    expect(cartKey(lines)).not.toBe(cartKey(lines.slice(1)))
  })

  it('formats sen as ringgit', () => {
    expect(formatSen(1250)).toBe('RM 12.50')
    expect(formatSen(0)).toBe('RM 0.00')
  })
})

describe('posMenuFromQr', () => {
  it('maps the qr_menu json', () => {
    const m = posMenuFromQr({
      tableLabel: 'T1', paused: false, needsPax: true,
      categories: [{ name: 'TEA', products: [{ id: 'p', name: 'Tea', description: null, soldOut: true,
        variants: [{ id: 'v', name: 'HOT', priceSen: 1000, isBase: true }],
        groups: [{ id: 'g', name: 'Sugar', min: 1, max: 1, options: [{ id: 'o', name: 'Less', priceDeltaSen: 0, isDefault: true, available: true }] }] }] }],
    })
    const p = m.categories[0].products[0]
    expect(p.soldOut).toBe(true)
    expect(p.variants[0].isBase).toBe(true)      // the server says which variant is the base (feedme key '')
    expect(defaultLine(p).optionIds).toEqual(['o'])
  })
})
