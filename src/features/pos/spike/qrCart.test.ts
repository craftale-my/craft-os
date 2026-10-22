import { describe, expect, it } from 'vitest'
import { cartItems, cartKey } from './qrCart'

describe('qrCart', () => {
  it('drops zero quantities', () => {
    expect(cartItems({ a: 1, b: 0, c: 2 })).toEqual([
      { menuItemId: 'a', qty: 1, note: null },
      { menuItemId: 'c', qty: 2, note: null },
    ])
  })

  it('key is independent of insertion order', () => {
    expect(cartKey({ a: 1, b: 2 })).toBe(cartKey({ b: 2, a: 1 }))
  })

  it('key changes when a quantity changes', () => {
    expect(cartKey({ a: 1, b: 2 })).not.toBe(cartKey({ a: 1, b: 3 }))
  })

  it('treats a zero entry like a missing one', () => {
    expect(cartKey({ a: 1, b: 0 })).toBe(cartKey({ a: 1 }))
  })
})
