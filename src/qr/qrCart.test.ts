import { describe, expect, it } from 'vitest'
import type { PosMenu } from '../features/pos/order/cart'
import type { MenuPicks } from '../features/pos/order/picks'
import {
  additionsToast, cartChannel, cartPairs, cartTotalSen, cartUnits, unitsByProduct, groupCart, groupOrdered, isNetworkError, lineAvailable, orderWasSent, parseCart,
  itemPairs, sendGroups, sentKey, skipIds, type CartLine, type CartState, type OrderedItem,
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
    expect(parseCart(raw)).toEqual({ version: 'abc', lines: [line('l1', ME, { optionIds: ['oat'], qty: 2 })], lastOrder: null })
  })
  it('reads lastOrder when the reply has one', () => {
    expect(parseCart({ version: 'abc', lines: [], lastOrder: 'o1' })?.lastOrder).toBe('o1')
    expect(parseCart({ version: 'abc', lines: [] })?.lastOrder).toBeNull()
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
  it('a line the item sheet would refuse is unavailable: missing required choice, duplicate add-on, too many in a group', () => {
    const m: PosMenu = { categories: [{ name: 'Drinks', products: [
      { id: 'mocha', name: 'Mocha', description: null, soldOut: false,
        variants: [{ id: 'hot', name: 'Hot', priceSen: 900, isBase: true }],
        groups: [{ id: 'size', name: 'Size', min: 1, max: 1, options: [
          { id: 's', name: 'Small', priceDeltaSen: 0, isDefault: false, available: true },
          { id: 'l', name: 'Large', priceDeltaSen: 300, isDefault: false, available: true },
        ] }, { id: 'extra', name: 'Extra', min: 0, max: 2, options: [
          { id: 'shot', name: 'Shot', priceDeltaSen: 200, isDefault: false, available: true },
        ] }] },
    ] }] }
    const mocha = (optionIds: string[]) => line('a', ME, { productId: 'mocha', optionIds })
    expect(lineAvailable(m, mocha(['s']))).toBe(true)
    expect(lineAvailable(m, mocha([]))).toBe(false)             // required Size missing
    expect(lineAvailable(m, mocha(['s', 'shot', 'shot']))).toBe(false)   // duplicate add-on
    expect(lineAvailable(m, mocha(['s', 'l']))).toBe(false)     // two in a max-1 group
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
  it('knows postgrest-js\'s "name: message" form on every browser', () => {
    expect(isNetworkError('TypeError: Failed to fetch')).toBe(true)
    expect(isNetworkError('TypeError: Load failed')).toBe(true)
    expect(isNetworkError('TypeError: NetworkError when attempting to fetch resource.')).toBe(true)
    expect(isNetworkError('AbortError: signal is aborted without reason')).toBe(true)
  })
  it('is not fooled by the cart\'s own words', () => {
    expect(isNetworkError('You can only change your own items.')).toBe(false)
    expect(isNetworkError('This table\'s order is full. Please send it first.')).toBe(false)
    expect(isNetworkError('The order is still loading.')).toBe(false)
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

describe('orderWasSent', () => {
  const at = (lastOrder: string | null | undefined): CartState => ({ version: 'v', lines: [], lastOrder })
  it('the first read is the baseline, never sent', () => { expect(orderWasSent(null, at('o1'))).toBe(false) })
  it('same id: not sent', () => { expect(orderWasSent(at('o1'), at('o1'))).toBe(false) })
  it('null or missing before, id after: sent', () => {
    expect(orderWasSent(at(null), at('o1'))).toBe(true)
    expect(orderWasSent(at(undefined), at('o1'))).toBe(true)
  })
  it('id A to id B: sent', () => { expect(orderWasSent(at('a'), at('b'))).toBe(true) })
  it('id to null: not sent', () => { expect(orderWasSent(at('a'), at(null))).toBe(false) })
})

describe('sentKey', () => {
  it('same cart and skip list give the same key; a different version or skip list another', () => {
    const c: CartState = { version: 'v1', lines: [] }
    expect(sentKey(c, ['a', 'b'])).toBe(sentKey({ version: 'v1', lines: [] }, ['a', 'b']))
    expect(sentKey(c, [])).not.toBe(sentKey({ version: 'v2', lines: [] }, []))
    expect(sentKey(c, ['a'])).not.toBe(sentKey(c, ['a', 'b']))
  })
})

describe('unitsByProduct / cartUnits', () => {
  it('adds up the units of each product over available lines only', () => {
    const lines = [
      line('a', ME, { qty: 2 }), line('b', MEI, { qty: 1, optionIds: ['oat'] }),
      line('c', ME, { optionIds: ['soy'], qty: 5 }),                                // option sold out: not counted
      line('d', ME, { productId: 'cake', variantId: 'slice', qty: 3 }),             // sold out: not counted
    ]
    expect(unitsByProduct(menu, lines)).toEqual(new Map([['latte', 3]]))
    expect(cartUnits(menu, lines)).toBe(3)
  })
  it('is empty for an empty cart', () => {
    expect(unitsByProduct(menu, []).size).toBe(0)
    expect(cartUnits(menu, [])).toBe(0)
  })
})

describe('cartPairs', () => {
  const mk = (ids: string[]) => ids.map((id) => ({ id, name: id, description: null, soldOut: false,
    variants: [{ id: 'v', name: 'V', priceSen: 100, isBase: true }], groups: [] }))
  const big: PosMenu = { categories: [{ name: 'All', products: mk(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) }] }
  const picks = (pairs: Record<string, string[]>): MenuPicks => ({ popular: [], pairs, mostPicked: {}, fromSales: true })
  const ln = (id: string, productId: string): CartLine => line(id, ME, { productId, variantId: 'v' })
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id)

  it('follows my lines in cart order and drops duplicates', () => {
    const mine = [ln('1', 'a'), ln('2', 'b')]
    const r = cartPairs(big, picks({ a: ['c', 'd'], b: ['d', 'e'] }), mine, mine)
    expect(ids(r)).toEqual(['c', 'd', 'e'])
  })
  it('leaves out anything already in the table\'s cart, mine or not', () => {
    const mine = [ln('1', 'a')]
    const all = [...mine, ln('2', 'c')]
    expect(ids(cartPairs(big, picks({ a: ['c', 'd'] }), mine, all))).toEqual(['d'])
  })
  it('keeps the first 6', () => {
    const mine = [ln('1', 'a'), ln('2', 'b'), ln('3', 'c')]
    const r = cartPairs(big, picks({ a: ['d', 'e', 'f'], b: ['g', 'h', 'i'], c: ['j'] }), mine, mine)
    expect(ids(r)).toEqual(['d', 'e', 'f', 'g', 'h', 'i'])
  })
  it('is empty without picks or without lines of mine', () => {
    const mine = [ln('1', 'a')]
    expect(cartPairs(big, null, mine, mine)).toEqual([])
    expect(cartPairs(big, picks({ a: ['c'] }), [], [])).toEqual([])
    expect(cartPairs(big, picks({}), mine, mine)).toEqual([])
  })
})

describe('itemPairs (the item page\'s Goes well with)', () => {
  const mk = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id, description: null, soldOut: false,
    variants: [{ id: 'v', name: 'V', priceSen: 100, isBase: true }], groups: [], ...over })
  const needsChoice = { groups: [{ id: 'g', name: 'G', min: 1, max: 1, options: [
    { id: 'o', name: 'O', priceDeltaSen: 0, isDefault: false, available: true }] }] }
  const big: PosMenu = { categories: [{ name: 'All', products: [
    mk('a'), mk('b'), mk('c'), mk('d'), mk('e'), mk('f'), mk('g'), mk('h'),
    mk('sold', { soldOut: true }), mk('choice', needsChoice),
  ] }] }
  const picks = (pairs: Record<string, string[]>): MenuPicks => ({ popular: [], pairs, mostPicked: {}, fromSales: true })
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id)

  it('lists the product\'s pairs that can be added without a choice, in the server\'s order', () => {
    expect(ids(itemPairs(big, picks({ a: ['choice', 'c', 'sold', 'b', 'gone'] }), 'a', []))).toEqual(['c', 'b'])
  })
  it('leaves out the product itself and anything already in the table\'s cart', () => {
    const inCart = [line('1', MEI, { productId: 'c', variantId: 'v' })]
    expect(ids(itemPairs(big, picks({ a: ['a', 'c', 'd'] }), 'a', inCart))).toEqual(['d'])
  })
  it('keeps at most 6', () => {
    expect(itemPairs(big, picks({ a: ['b', 'c', 'd', 'e', 'f', 'g', 'h'] }), 'a', []).length).toBe(6)
  })
  it('is empty without picks or pairs', () => {
    expect(itemPairs(big, null, 'a', [])).toEqual([])
    expect(itemPairs(big, picks({}), 'a', [])).toEqual([])
  })
})
