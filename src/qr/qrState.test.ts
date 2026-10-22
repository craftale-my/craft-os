import { describe, it, expect } from 'vitest'
import { tokenFromLocation, addLine, replaceLine, removeLine } from './qrState'

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
