import { describe, expect, it } from 'vitest'
import type { PosMenu, PosProduct } from '../features/pos/order/cart'
import type { MenuPicks } from '../features/pos/order/picks'
import type { CartLine } from './qrCart'
import { aiPick, aiPickOpens, kindsOf, situationOf } from './aiPick'
import { AI_PICK_COPY } from './aiPickCopy'

const P = (id: string, over: Partial<PosProduct> = {}): PosProduct => ({
  id, name: id[0].toUpperCase() + id.slice(1), description: null, soldOut: false,
  variants: [{ id: `${id}-v`, name: 'Regular', priceSen: 900, isBase: true }], groups: [], ...over,
})
const menu: PosMenu = { categories: [
  { name: 'Coffee', kind: 'drink', products: [P('latte'), P('mocha'), P('tea'), P('soda', { soldOut: true })] },
  { name: 'Cakes', kind: 'food', products: [P('cake'), P('tart'), P('scone', {
    groups: [{ id: 'jam', name: 'Jam', min: 1, max: 1, options: [{ id: 'j1', name: 'Strawberry', priceDeltaSen: 0, isDefault: false, available: true }] }] })] },
  { name: 'Flowers', kind: null, products: [P('rose'), P('tulip')] },
] }
const picks = (over: Partial<MenuPicks> = {}): MenuPicks => ({ popular: [], pairs: {}, mostPicked: {}, fromSales: true, ...over })
const L = (id: string, productId: string, over: Partial<CartLine> = {}): CartLine => ({
  id, guestId: 'me', guestLabel: 'Eric', guestAvatar: 'a1', productId, variantId: `${productId}-v`, qty: 1, note: null, optionIds: [], ...over,
})
const kinds = kindsOf(menu)

describe('kindsOf', () => {
  it('maps each product to its category kind; no kind = absent', () => {
    expect(kinds.get('latte')).toBe('drink')
    expect(kinds.get('cake')).toBe('food')
    expect(kinds.has('rose')).toBe(false)
  })
})

describe('situationOf', () => {
  it('drinks only, food only, one unit at the table, otherwise mixed', () => {
    expect(situationOf([L('1', 'latte'), L('2', 'mocha')], [L('1', 'latte'), L('2', 'mocha')], kinds)).toBe('drinks_only')
    expect(situationOf([L('1', 'cake', { qty: 2 })], [L('1', 'cake', { qty: 2 })], kinds)).toBe('food_only')
    expect(situationOf([L('1', 'rose')], [L('1', 'rose')], kinds)).toBe('solo_small')
    expect(situationOf([L('1', 'latte'), L('2', 'cake')], [L('1', 'latte'), L('2', 'cake')], kinds)).toBe('mixed')
    expect(situationOf([L('1', 'rose', { qty: 2 })], [L('1', 'rose', { qty: 2 })], kinds)).toBe('mixed')
    // one drink is drinks_only before it is solo_small
    expect(situationOf([L('1', 'latte')], [L('1', 'latte')], kinds)).toBe('drinks_only')
    // solo_small counts the whole table
    expect(situationOf([L('1', 'rose')], [L('1', 'rose'), L('2', 'tulip', { guestId: 'mei' })], kinds)).toBe('mixed')
  })
  it('without kinds at all: solo_small or mixed', () => {
    const none = kindsOf({ categories: menu.categories.map((c) => ({ ...c, kind: undefined })) })
    expect(situationOf([L('1', 'latte')], [L('1', 'latte')], none)).toBe('solo_small')
    expect(situationOf([L('1', 'latte'), L('2', 'mocha')], [L('1', 'latte'), L('2', 'mocha')], none)).toBe('mixed')
  })
})

describe('aiPick', () => {
  it('drinks only: a food pairing first, skipping drink pairings', () => {
    const mine = [L('1', 'latte')]
    const r = aiPick(menu, picks({ pairs: { latte: ['mocha', 'tart', 'cake'] }, popular: ['cake'] }), mine, mine, kinds, 1)
    expect(r?.product.id).toBe('tart')
    expect(r?.situation).toBe('drinks_only')
    expect(AI_PICK_COPY.drinks_only.map((t) => t.replace('{name}', 'Tart'))).toContain(r?.sentence)
  })
  it('drinks only with no food pairing: popular food', () => {
    const mine = [L('1', 'latte')]
    expect(aiPick(menu, picks({ pairs: { latte: ['mocha'] }, popular: ['tea', 'rose', 'cake'] }), mine, mine, kinds, 1)?.product.id).toBe('cake')
  })
  it('food only: a drink pairing, then popular drinks', () => {
    const mine = [L('1', 'cake')]
    expect(aiPick(menu, picks({ pairs: { cake: ['tart', 'tea'] } }), mine, mine, kinds, 1)?.product.id).toBe('tea')
    expect(aiPick(menu, picks({ pairs: { cake: ['tart'] }, popular: ['tart', 'mocha'] }), mine, mine, kinds, 1)?.product.id).toBe('mocha')
  })
  it('mixed and solo_small: any pairing of my lines in cart order, then popular', () => {
    const mine = [L('1', 'rose')]
    expect(aiPick(menu, picks({ pairs: { rose: ['tulip'] } }), mine, mine, kinds, 1)?.product.id).toBe('tulip')
    expect(aiPick(menu, picks({ popular: ['rose', 'latte'] }), mine, mine, kinds, 1)?.product.id).toBe('latte')
    const two = [L('1', 'latte'), L('2', 'cake')]
    expect(aiPick(menu, picks({ pairs: { latte: ['rose'], cake: ['tulip'] } }), two, two, kinds, 1)?.product.id).toBe('rose')
  })
  it('never suggests what the table has, a sold-out product or one off the menu now (out of its slot)', () => {
    const mine = [L('1', 'latte')]
    const all = [...mine, L('2', 'tart', { guestId: 'mei' })]
    const p = picks({ pairs: { latte: ['soda', 'gone', 'tart', 'cake'] } })
    expect(aiPick(menu, p, mine, all, kinds, 1)?.product.id).toBe('cake')
    expect(aiPick(menu, picks({ pairs: { latte: ['soda', 'gone'] } }), [L('1', 'rose')], [L('1', 'rose')], kinds, 1)).toBeNull()
  })
  it('a product with a required choice is offered (the card opens its page)', () => {
    const mine = [L('1', 'latte')]
    const r = aiPick(menu, picks({ pairs: { latte: ['scone'] } }), mine, mine, kinds, 1)
    expect(r?.product.id).toBe('scone')
    expect(aiPickOpens(r!.product)).toBe(true)
    expect(aiPickOpens(menu.categories[1].products[0])).toBe(false)
  })
  it('several sizes or a required group opens the page; optional add-ons do not', () => {
    expect(aiPickOpens(P('x', { variants: [
      { id: 'a', name: 'S', priceSen: 1, isBase: true }, { id: 'b', name: 'L', priceSen: 2, isBase: false }] }))).toBe(true)
    expect(aiPickOpens(P('x', { groups: [{ id: 'g', name: 'Milk', min: 0, max: 1, options: [] }] }))).toBe(false)
  })
  it('no card: no picks, no lines of mine, nothing left', () => {
    const mine = [L('1', 'latte')]
    expect(aiPick(menu, null, mine, mine, kinds, 1)).toBeNull()
    expect(aiPick(menu, picks({ popular: ['cake'] }), [], [L('2', 'tea', { guestId: 'mei' })], kinds, 1)).toBeNull()
    expect(aiPick(menu, picks(), mine, mine, kinds, 1)).toBeNull()
  })
  it('only my available lines decide; an unavailable one is ignored', () => {
    const mine = [L('1', 'latte'), L('2', 'soda')]   // soda is sold out
    expect(aiPick(menu, picks({ pairs: { latte: ['cake'] } }), mine, mine, kinds, 1)?.situation).toBe('drinks_only')
    expect(aiPick(menu, picks({ popular: ['cake'] }), [L('2', 'soda')], [L('2', 'soda')], kinds, 1)).toBeNull()
  })
  it('the same seed keeps the same line; the pick moves on after an add', () => {
    const mine = [L('1', 'latte')]
    const p = picks({ pairs: { latte: ['cake', 'tart'] } })
    const a = aiPick(menu, p, mine, mine, kinds, 99)
    expect(aiPick(menu, p, mine, mine, kinds, 99)).toEqual(a)
    const after = [...mine, L('3', 'cake')]
    expect(aiPick(menu, p, [L('1', 'latte')], after, kinds, 99)?.product.id).toBe('tart')
  })
})
