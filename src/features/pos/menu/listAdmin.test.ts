import { describe, expect, it } from 'vitest'
import { catalogUseText, copyName, listNameProblem, reorderedIds } from './listAdmin'

const rows = [{ id: 'c', name: 'Craft Cafe' }, { id: 'g', name: 'Grab Food' }, { id: 's', name: 'Staff Meal' }]

describe('listNameProblem', () => {
  it('uses the server\'s words: required, too long, taken (letter case ignored)', () => {
    expect(listNameProblem('Catalog', '  ', rows, null)).toBe('Catalog name is required')
    expect(listNameProblem('Category', 'x'.repeat(61), rows, null)).toBe('Category name is too long (at most 60 characters)')
    expect(listNameProblem('Catalog', ' grab  food ', rows, null)).toBe('A catalog called grab food already exists')
    expect(listNameProblem('Catalog', 'Grab Mart', rows, null)).toBeNull()
  })
  it('lets a row keep its own name in other letters', () => {
    expect(listNameProblem('Catalog', 'GRAB FOOD', rows, 'g')).toBeNull()
  })
})

describe('reorderedIds', () => {
  it('gives the full new order, or null at the ends', () => {
    expect(reorderedIds(rows, 1, -1)).toEqual(['g', 'c', 's'])
    expect(reorderedIds(rows, 2, 1)).toBeNull()
  })
})

describe('copyName', () => {
  it('finds the first free "copy" name', () => {
    expect(copyName('Grab Food', rows)).toBe('Grab Food copy')
    expect(copyName('Grab Food', [...rows, { name: 'grab food COPY' }, { name: 'Grab Food copy 2' }])).toBe('Grab Food copy 3')
  })
})

describe('catalogUseText', () => {
  it('lists each branch once, roles in a fixed order', () => {
    expect(catalogUseText([
      { branch: 'Puchong', role: 'additional' }, { branch: 'Cheras', role: 'qr' },
      { branch: 'Cheras', role: 'dine_in' }, { branch: 'Cheras', role: 'takeaway' },
    ])).toBe('Cheras: dine-in, takeaway, QR · Puchong: additional')
    expect(catalogUseText([])).toBe('Not used by any branch')
  })
})
