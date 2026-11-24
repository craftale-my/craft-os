import { describe, expect, it } from 'vitest'
import { goesWellVisible, MAX_PAIRS, MAX_POPULAR, mostPickedFor, offerPairs, pairsFor, parsePicks, visiblePopular, type MenuPicks } from './picks'
import type { OrderLine, PosMenu, PosProduct } from './cart'

const product = (id: string, extra: Partial<PosProduct> = {}): PosProduct => ({
  id, name: id.toUpperCase(), description: null, soldOut: false,
  variants: [{ id: `${id}-v`, name: 'Regular', priceSen: 1000, isBase: true }], groups: [], ...extra,
})
const menu: PosMenu = {
  categories: [
    { name: 'COFFEE', products: [product('latte'), product('mocha')] },
    { name: 'CAKE', products: [product('cake'), product('brownie', { soldOut: true }), product('tart', { variants: [] })] },
    { name: 'BREAD', products: [product('croissant'), product('bagel'), product('scone')] },
  ],
}
const picks: MenuPicks = {
  popular: ['gone', 'cake', 'brownie', 'latte', 'tart', 'croissant'],
  pairs: { latte: ['brownie', 'cake', 'gone', 'latte', 'croissant', 'bagel', 'scone'], mocha: [] },
  mostPicked: { latte: { milk: 'oat' } },
  fromSales: true,
}
const line = (productId: string): OrderLine => ({ productId, variantId: `${productId}-v`, qty: 1, note: null, optionIds: [] })

describe('parsePicks', () => {
  it('reads the server payload', () => {
    expect(parsePicks(picks)).toEqual(picks)
  })
  it('null (an unknown table), text or a half payload is no picks', () => {
    expect(parsePicks(null)).toBeNull()
    expect(parsePicks('nope')).toBeNull()
    expect(parsePicks({ popular: [] })).toBeNull()
  })
  it('drops what is not an id and reads a missing fromSales as false', () => {
    expect(parsePicks({ popular: ['a', 3, null], pairs: { a: ['b', 4], c: 'x' }, mostPicked: { a: { g: 'o', h: 5 }, b: 'x' } }))
      .toEqual({ popular: ['a'], pairs: { a: ['b'], c: [] }, mostPicked: { a: { g: 'o' } }, fromSales: false })
  })
})

describe('visiblePopular', () => {
  it('keeps the server order and only what the menu offers now', () => {
    // gone: not on this menu (catalog or time slot) · brownie: sold out · tart: no price in this catalog
    expect(visiblePopular(menu, picks).map((p) => p.id)).toEqual(['cake', 'latte', 'croissant'])
  })
  it('cuts to MAX_POPULAR after filtering, so a dropped product lets the next one in', () => {
    const many: PosMenu = { categories: [{ name: 'ALL', products: Array.from({ length: 10 }, (_, i) => product(`p${i}`)) }] }
    const ids = many.categories[0].products.map((p) => p.id)
    expect(MAX_POPULAR).toBe(8)
    expect(visiblePopular(many, { ...picks, popular: ids }).map((p) => p.id)).toEqual(ids.slice(0, 8))
    const withGone = ['p0', 'p1', 'gone', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9']
    expect(visiblePopular(many, { ...picks, popular: withGone }).map((p) => p.id)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'])
  })
  it('no picks, no row', () => {
    expect(visiblePopular(menu, null)).toEqual([])
  })
})

describe('pairsFor', () => {
  it('leaves out what is not offered, sold out, in the cart or the product itself, and keeps at most 3', () => {
    expect(pairsFor(menu, picks, 'latte', []).map((p) => p.id)).toEqual(['cake', 'croissant', 'bagel'])
    expect(pairsFor(menu, picks, 'latte', [line('latte'), line('cake')]).map((p) => p.id)).toEqual(['croissant', 'bagel', 'scone'])
    expect(MAX_PAIRS).toBe(3)
  })
  it('a product without pairs, or no picks, gives nothing', () => {
    expect(pairsFor(menu, picks, 'mocha', [])).toEqual([])
    expect(pairsFor(menu, picks, 'scone', [])).toEqual([])
    expect(pairsFor(menu, null, 'latte', [])).toEqual([])
  })
})

describe('offerPairs', () => {
  it('once per product per visit, and only with something to show', () => {
    expect(offerPairs(menu, picks, 'latte', [line('latte')], new Set())).toBe(true)
    expect(offerPairs(menu, picks, 'latte', [line('latte')], new Set(['latte']))).toBe(false)
    expect(offerPairs(menu, picks, 'mocha', [line('mocha')], new Set())).toBe(false)
  })
})

describe('mostPickedFor', () => {
  it("the product's group → option map, or nothing", () => {
    expect(mostPickedFor(picks, 'latte')).toEqual({ milk: 'oat' })
    expect(mostPickedFor(picks, 'mocha')).toBeUndefined()
    expect(mostPickedFor(null, 'latte')).toBeUndefined()
  })
})

describe('goesWellVisible', () => {
  const line = (productId: string) => ({ productId }) as OrderLine
  it('is true only while the product is still in the cart', () => {
    expect(goesWellVisible('latte', [line('latte'), line('cake')])).toBe(true)
    expect(goesWellVisible('latte', [line('cake')])).toBe(false)
    expect(goesWellVisible('latte', [])).toBe(false)
    expect(goesWellVisible(null, [line('latte')])).toBe(false)
  })
})
