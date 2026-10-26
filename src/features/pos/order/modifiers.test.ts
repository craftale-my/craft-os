import { describe, expect, it } from 'vitest'
import { groupBadge, tileInitials, toggleOption } from './modifiers'

describe('groupBadge', () => {
  it('required groups say how many to select', () => {
    expect(groupBadge({ min: 1, max: 1 })).toEqual({ text: 'SELECT 1', required: true })
    expect(groupBadge({ min: 1, max: 2 })).toEqual({ text: 'SELECT 1–2', required: true })
  })
  it('optional groups say so', () => {
    expect(groupBadge({ min: 0, max: 1 })).toEqual({ text: 'OPTIONAL', required: false })
    expect(groupBadge({ min: 0, max: 3 })).toEqual({ text: 'UP TO 3', required: false })
  })
})

describe('toggleOption', () => {
  const line = { productId: 'p', variantId: 'v', qty: 1, note: null, optionIds: ['x1'] }
  const ice = ['i1', 'i2']
  it('a one-choice group swaps its choice, and a second tap clears it; other groups keep theirs', () => {
    const a = toggleOption(line, 1, ice, 'i1')
    expect(a.optionIds).toEqual(['x1', 'i1'])
    expect(toggleOption(a, 1, ice, 'i2').optionIds).toEqual(['x1', 'i2'])
    expect(toggleOption(a, 1, ice, 'i1').optionIds).toEqual(['x1'])
  })
  it('a many-choice group adds and removes', () => {
    const a = toggleOption(line, 3, ice, 'i1')
    const b = toggleOption(a, 3, ice, 'i2')
    expect(b.optionIds).toEqual(['x1', 'i1', 'i2'])
    expect(toggleOption(b, 3, ice, 'i1').optionIds).toEqual(['x1', 'i2'])
  })
})

describe('tileInitials', () => {
  it('the first three letters, spaces left out', () => {
    expect(tileInitials('Custom Cake')).toBe('Cus')
    expect(tileInitials('  Iced Latte')).toBe('Ice')
    expect(tileInitials('Te')).toBe('Te')
  })
})
