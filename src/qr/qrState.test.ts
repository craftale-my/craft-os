import { describe, it, expect } from 'vitest'
import { tokenFromLocation, addLine, replaceLine, removeLine, leftTheMenu, leftTheMenuNotice, pruneAfterRefresh } from './qrState'
import type { PosMenu } from '../features/pos/order/cart'

describe('tokenFromLocation', () => {
  it('reads /t/<token> in production and ?t= under the dev server', () => {
    expect(tokenFromLocation('/t/abc123', '')).toBe('abc123')
    expect(tokenFromLocation('/qr/', '?t=abc123')).toBe('abc123')
    expect(tokenFromLocation('/qr/', '')).toBeNull()
    expect(tokenFromLocation('/t/', '')).toBeNull()
  })
})

describe('cart helpers', () => {
  const a = { productId: 'p', variantId: 'v', qty: 1, note: null, optionIds: [] }
  it('append, replace by index, remove by index — never mutating', () => {
    const one = addLine([], a)
    const two = addLine(one, { ...a, qty: 2 })
    expect(one).toHaveLength(1)
    expect(replaceLine(two, 0, { ...a, qty: 5 })[0].qty).toBe(5)
    expect(removeLine(two, 0)).toEqual([{ ...a, qty: 2 }])
    expect(two).toHaveLength(2)
  })
})

describe('the minute refresh', () => {
  const product = (id: string, name: string) => ({ id, name, description: null, soldOut: false, variants: [], groups: [] })
  const before: PosMenu = { categories: [{ name: 'FOOD', products: [product('a', 'Pancake'), product('b', 'Latte'), product('c', 'Soup')] }] }
  const after: PosMenu = { categories: [{ name: 'FOOD', products: [product('b', 'Latte')] }] }
  const line = (productId: string) => ({ productId, variantId: 'v', qty: 1, note: null, optionIds: [] })
  it('names each product of the cart that left the menu once, from the menu before', () => {
    expect(leftTheMenu([line('a'), line('b'), line('a'), line('c')], after, before)).toEqual(['Pancake', 'Soup'])
    expect(leftTheMenu([line('b')], after, before)).toEqual([])
  })
  it('takes out the lines that left and follows the line an open edit sheet holds', () => {
    const cart = [line('a'), line('b'), line('c'), { ...line('b'), qty: 3 }]
    const after2: PosMenu = { categories: [{ name: 'FOOD', products: [product('b', 'Latte'), product('c', 'Soup')] }] }
    // editing the Soup (index 2): Pancake left, so the Soup is now index 1
    expect(pruneAfterRefresh(cart, after2, 2)).toEqual({ lines: [line('b'), line('c'), { ...line('b'), qty: 3 }], index: 1 })
    expect(pruneAfterRefresh(cart, after2, 3).index).toBe(2)
    // the edited line itself left: the sheet closes
    expect(pruneAfterRefresh(cart, after2, 0).index).toBeNull()
    // no edit sheet (or one adding a new line)
    expect(pruneAfterRefresh(cart, after2, null).index).toBeNull()
    // nothing left: same lines, same index
    expect(pruneAfterRefresh(cart, before, 3)).toEqual({ lines: cart, index: 3 })
    expect(pruneAfterRefresh([], after, null)).toEqual({ lines: [], index: null })
  })
  it('says so in plain words', () => {
    expect(leftTheMenuNotice(['Pancake'])).toBe('Pancake is not available at this time and was taken out of your order.')
    expect(leftTheMenuNotice(['Pancake', 'Soup'])).toBe('Pancake, Soup are not available at this time and were taken out of your order.')
    expect(leftTheMenuNotice([])).toBeNull()
  })
})
