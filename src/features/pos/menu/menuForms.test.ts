import { describe, expect, it } from 'vitest'
import { cleanName, inputToSen, moveItem, nameProblem, nextRef, senToInput } from './menuForms'

describe('names', () => {
  it('trims and collapses spaces like the server', () => {
    expect(cleanName('  Iced   Latte ')).toBe('Iced Latte')
  })
  it('treats a pasted no-break space, tab, newline and other Unicode spaces as plain spaces', () => {
    expect(cleanName('Drinks\u00a0')).toBe('Drinks')
    expect(cleanName('\u00a0\tDrinks\n')).toBe('Drinks')
    expect(cleanName('Iced\u00a0\u00a0Latte\tLarge\u3000Cold\u202fBrew\ufeff')).toBe('Iced Latte Large Cold Brew')
    expect(nameProblem('Catalog', '\u00a0\t \u3000', 60)).toBe('Catalog name is required')
  })
  it('uses the server\'s words for a blank or long name', () => {
    expect(nameProblem('Variant', '   ', 60)).toBe('Variant name is required')
    expect(nameProblem('Catalog', 'x'.repeat(61), 60)).toBe('Catalog name is too long (at most 60 characters)')
    expect(nameProblem('Catalog', ` ${'x'.repeat(60)} `, 60)).toBeNull()
  })
})

describe('money', () => {
  it('turns sen into a price box and back', () => {
    expect(senToInput(1250)).toBe('12.50')
    expect(senToInput(0)).toBe('0.00')
    expect(inputToSen('12.50')).toBe(1250)
    expect(inputToSen('12.5')).toBe(1250)
    expect(inputToSen('12')).toBe(1200)
    expect(inputToSen('RM 7.05')).toBe(705)
    expect(inputToSen('0')).toBe(0)
  })
  it('refuses what is not a whole number of sen from 0 up', () => {
    for (const bad of ['', ' ', '-1', '12.555', 'abc', '1e3', '1234567']) expect(inputToSen(bad), bad).toBeNull()
  })
})

describe('moveItem', () => {
  it('moves up and down, and leaves the list alone at the ends', () => {
    expect(moveItem(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b'])
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
    const list = ['a', 'b']
    expect(moveItem(list, 0, -1)).toBe(list)
    expect(moveItem(list, 1, 1)).toBe(list)
  })
})

describe('nextRef', () => {
  it('never reuses a ref', () => {
    expect(nextRef([])).toBe('new-1')
    expect(nextRef([{ ref: 'new-1' }, { ref: 'abc' }, { ref: 'new-3' }])).toBe('new-2')
  })
})
