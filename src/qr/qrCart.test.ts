import { describe, expect, it } from 'vitest'
import type { PosMenu } from '../features/pos/order/cart'
import {
  additionsToast, cartChannel, cartTotalSen, groupCart, groupOrdered, isNetworkError, lineAvailable, parseCart,
  sendGroups, skipIds, type CartLine, type CartState, type OrderedItem,
} from './qrCart'

const menu: PosMenu = { categories: [{ name: 'Drinks', products: [
  { id: 'latte', name: 'Latte', description: null, soldOut: false,
    variants: [{ id: 'hot', name: 'Hot', priceSen: 900, isBase: true }],
    groups: [{ id: 'milk', name: 'Milk', min: 0, max: 1, options: [
      { id: 'oat', name: 'Oat', priceDeltaSen: 200, isDefault: false, available: true },
      { id: 'soy', name: 'Soy', priceDeltaSen: 0, isDefault: false, available: false },
    ] }] },
  { id: 'cake', name: 'Cake', description: null, soldOut: true,
    variants: [{ id: 'slice', name: 'Slice', priceSen: 1500, isBase: true }], groups: [] },
] }] }

const ME = 'me', MEI = 'mei', BO = 'bo'
const line = (id: string, guestId: string, over: Partial<CartLine> = {}): CartLine => ({
  id, guestId, guestLabel: guestId === ME ? 'Eric' : guestId === MEI ? 'Mei' : 'Bo', guestAvatar: guestId === ME ? 'a1' : 'a3',
  productId: 'latte', variantId: 'hot', qty: 1, note: null, optionIds: [], ...over,
})
const cart = (...lines: CartLine[]): CartState => ({ version: 'v', lines })

describe('parseCart', () => {
  it('reads the server reply', () => {
    const raw = { version: 'abc', lines: [{ id: 'l1', guestId: ME, guestLabel: 'Eric', guestAvatar: 'a1',
      productId: 'latte', variantId: 'hot', optionIds: ['oat'], qty: 2, note: null }] }
    expect(parseCart(raw)).toEqual({ version: 'abc', lines: [line('l1', ME, { optionIds: ['oat'], qty: 2 })] })
  })
  it('refuses anything else', () => {
    expect(parseCart(null)).toBeNull()
    expect(parseCart({ version: 1, lines: [] })).toBeNull()
    expect(parseCart({ version: 'v', lines: [{ id: 'l1' }] })).toBeNull()
  })
})

describe('lineAvailable', () => {
  it('needs the product on the menu, not sold out, its variant and options offered', () => {
    expect(lineAvailable(menu, line('a', ME))).toBe(true)
    expect(lineAvailable(menu, line('a', ME, { optionIds: ['oat'] }))).toBe(true)
    expect(lineAvailable(menu, line('a', ME, { optionIds: ['soy'] }))).toBe(false)     // option sold out
    expect(lineAvailable(menu, line('a', ME, { optionIds: ['gone'] }))).toBe(false)    // option removed
    expect(lineAvailable(menu, line('a', ME, { variantId: 'iced' }))).toBe(false)      // variant removed
    expect(lineAvailable(menu, line('a', ME, { productId: 'cake', variantId: 'slice' }))).toBe(false)   // sold out
    expect(lineAvailable(menu, line('a', ME, { productId: 'tea' }))).toBe(false)       // left the menu
  })
})

describe('grouping', () => {
  const lines = [line('1', MEI), line('2', ME), line('3', BO), line('4', MEI), line('5', ME, { productId: 'cake', variantId: 'slice' })]
  it('splits mine from the others, others in order of their first line', () => {
    const g = groupCart(lines, ME)
    expect(g.mine.map((l) => l.id)).toEqual(['2', '5'])
    expect(g.others.map((o) => [o.label, o.lines.map((l) => l.id)])).toEqual([['Mei', ['1', '4']], ['Bo', ['3']]])
    expect(g.others.every((o) => !o.isMe)).toBe(true)
  })
  it('the send sheet lists available lines only, me first', () => {
    const g = sendGroups(menu, lines, ME)
    expect(g.map((x) => [x.label, x.isMe, x.lines.map((l) => l.id)])).toEqual([['Eric', true, ['2']], ['Mei', false, ['1', '4']], ['Bo', false, ['3']]])
  })
  it('a guest whose every line is unavailable is not listed', () => {
    expect(sendGroups(menu, [line('5', ME, { productId: 'cake', variantId: 'slice' }), line('1', MEI)], ME).map((x) => x.label)).toEqual(['Mei'])
  })
  it('skipIds are the unavailable lines; the total leaves them out', () => {
    expect(skipIds(menu, lines)).toEqual(['5'])
    expect(cartTotalSen(menu, [line('1', MEI, { qty: 2, optionIds: ['oat'] }), line('5', ME, { productId: 'cake', variantId: 'slice' })])).toBe(2200)
  })
})

describe('additionsToast', () => {
  const before = cart(line('1', ME))
  it('says who added what', () => {
    expect(additionsToast(before, cart(line('1', ME), line('2', MEI, { qty: 2 })), ME, menu)).toBe('🐱 Mei added 2 × Latte')
  })
  it('collapses several additions by one guest', () => {
    expect(additionsToast(before, cart(line('1', ME), line('2', MEI), line('3', MEI, { qty: 2 })), ME, menu)).toBe('🐱 Mei added 3 items')
  })
  it('collapses additions by several guests', () => {
    expect(additionsToast(before, cart(line('1', ME), line('2', MEI), line('3', BO)), ME, menu)).toBe('Others at this table added 2 items')
  })
  it('is silent for my own additions, for removals and on the first read', () => {
    expect(additionsToast(before, cart(line('1', ME), line('2', ME)), ME, menu)).toBeNull()
    expect(additionsToast(cart(line('1', ME), line('2', MEI)), cart(line('1', ME)), ME, menu)).toBeNull()
    expect(additionsToast(null, cart(line('2', MEI)), ME, menu)).toBeNull()
  })
  it('names an item the menu no longer has as "an item"', () => {
    expect(additionsToast(before, cart(line('1', ME), line('2', MEI, { productId: 'tea' })), ME, menu)).toBe('🐱 Mei added 1 × an item')
  })
})

describe('groupOrdered', () => {
  const item = (name: string, guestLabel: string | null, guestAvatar: string | null = null): OrderedItem =>
    ({ name, qty: 1, unitPriceSen: 900, mods: [], note: null, voided: false, guestLabel, guestAvatar })
  it('groups sent items by guest, counter items last', () => {
    const g = groupOrdered([item('Tea', null), item('Latte', 'Eric', 'a1'), item('Cake', 'Mei', 'a3'), item('Mocha', 'Eric', 'a1')])
    expect(g.map((x) => [x.label, x.avatar, x.items.map((i) => i.name)])).toEqual([
      ['Eric', 'a1', ['Latte', 'Mocha']], ['Mei', 'a3', ['Cake']], [null, null, ['Tea']],
    ])
  })
  it('reads items from before this feature (no guest fields) as counter items', () => {
    expect(groupOrdered([{ name: 'Tea', qty: 1, unitPriceSen: 500, mods: [], note: null, voided: false }]).map((x) => x.label)).toEqual([null])
  })
})

describe('isNetworkError', () => {
  it('knows the browsers\' words for no connection', () => {
    expect(isNetworkError('Failed to fetch')).toBe(true)
    expect(isNetworkError('NetworkError when attempting to fetch resource.')).toBe(true)
    expect(isNetworkError('Load failed')).toBe(true)
    expect(isNetworkError('Sold out: Latte')).toBe(false)
  })
})

describe('cartChannel', () => {
  it('is qr- plus 16 hex characters, the same for the same token, and never the token', async () => {
    const a = await cartChannel('abc123')
    expect(a).toMatch(/^qr-[0-9a-f]{16}$/)
    expect(await cartChannel('abc123')).toBe(a)
    expect(await cartChannel('abc124')).not.toBe(a)
    expect(a).not.toContain('abc123')
  })
})
