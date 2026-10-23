import { describe, it, expect } from 'vitest'
import {
  activeCatalogs, additionalChoices, catalogSettingsFrom, catalogSettingsProblem, defaultCatalogId, defaultCatalogProblem,
  noCatalogMessage, selectableCatalogs, settingsToSave, toggleAdditional, type BranchCatalogRow, type CatalogRow,
} from './catalogs'

const cat = (id: string, name: string, sort_order: number, is_active = true): CatalogRow => ({ id, name, sort_order, is_active })
const catalogs = [
  cat('c-cafe', 'Craft Cafe', 0), cat('c-take', 'Takeaway Menu', 1), cat('c-staff', 'Staff Meal', 3),
  cat('c-grab', 'Grab Food', 2), cat('c-old', 'Old Promo', 4, false),
]
const rows: BranchCatalogRow[] = [
  { role: 'dine_in', catalog_id: 'c-cafe' }, { role: 'takeaway', catalog_id: 'c-take' }, { role: 'qr', catalog_id: 'c-cafe' },
  { role: 'additional', catalog_id: 'c-staff' }, { role: 'additional', catalog_id: 'c-grab' },
  { role: 'additional', catalog_id: 'c-old' }, { role: 'additional', catalog_id: 'c-cafe' },
]
const cafeOff = catalogs.map((c) => (c.id === 'c-cafe' ? { ...c, is_active: false } : c))

describe('defaultCatalogId', () => {
  it('is the branch catalog for the role, or null', () => {
    expect(defaultCatalogId(rows, 'dine_in')).toBe('c-cafe')
    expect(defaultCatalogId(rows, 'takeaway')).toBe('c-take')
    expect(defaultCatalogId([], 'qr')).toBeNull()
  })
})

describe('defaultCatalogProblem', () => {
  it('is null for an active default, else the reason in the pad\'s words', () => {
    expect(defaultCatalogProblem(rows, catalogs, 'dine_in')).toBeNull()
    expect(defaultCatalogProblem([], catalogs, 'takeaway')).toBe('No menu catalog is set for takeaway — set it in POS settings')
    expect(defaultCatalogProblem(rows, cafeOff, 'dine_in')).toBe('The dine-in catalog Craft Cafe is switched off — choose another in POS settings')
  })
})

describe('selectableCatalogs', () => {
  it('puts the order type default first, then active additional catalogs in catalog order, each once', () => {
    expect(selectableCatalogs(rows, catalogs, 'dine_in')).toEqual([
      { id: 'c-cafe', name: 'Craft Cafe', isDefault: true, offered: true },
      { id: 'c-grab', name: 'Grab Food', isDefault: false, offered: true },
      { id: 'c-staff', name: 'Staff Meal', isDefault: false, offered: true },
    ])
  })

  it('a takeaway starts from the takeaway catalog; another type\'s default is offered only if it is additional', () => {
    expect(selectableCatalogs(rows, catalogs, 'takeaway').map((c) => c.id)).toEqual(['c-take', 'c-cafe', 'c-grab', 'c-staff'])
  })

  it('with an inactive or missing default nothing is the default, so the pad waits for a pick', () => {
    const off = selectableCatalogs(rows, cafeOff, 'dine_in')
    expect(off.map((c) => c.id)).toEqual(['c-grab', 'c-staff'])
    expect(off.some((c) => c.isDefault)).toBe(false)
    expect(selectableCatalogs(rows.filter((r) => r.role !== 'takeaway'), catalogs, 'takeaway').some((c) => c.isDefault)).toBe(false)
    expect(selectableCatalogs([], catalogs, 'dine_in')).toEqual([])
  })

  it('keeps the catalog of an order being edited even when it is no longer offered', () => {
    expect(selectableCatalogs(rows, catalogs, 'dine_in', 'c-old')[3]).toEqual({ id: 'c-old', name: 'Old Promo', isDefault: false, offered: false })
    expect(selectableCatalogs(rows, catalogs, 'dine_in', 'c-gone')[3]).toEqual({ id: 'c-gone', name: 'Unknown catalog', isDefault: false, offered: false })
    expect(selectableCatalogs(rows, catalogs, 'dine_in', 'c-staff')).toHaveLength(3)
  })
})

describe('settings', () => {
  it('reads the branch rows into the form and lists active catalogs in order', () => {
    expect(catalogSettingsFrom(rows)).toEqual({ dineIn: 'c-cafe', takeaway: 'c-take', qr: 'c-cafe', additional: ['c-staff', 'c-grab', 'c-old', 'c-cafe'] })
    expect(activeCatalogs(catalogs).map((c) => c.id)).toEqual(['c-cafe', 'c-take', 'c-grab', 'c-staff'])
  })

  it('needs all three defaults, in the server\'s words, and says when one is switched off', () => {
    const ok = catalogSettingsFrom(rows)
    expect(catalogSettingsProblem(ok, catalogs)).toBeNull()
    expect(catalogSettingsProblem({ ...ok, dineIn: null })).toBe('Choose the dine-in catalog')
    expect(catalogSettingsProblem({ ...ok, takeaway: null })).toBe('Choose the takeaway catalog')
    expect(catalogSettingsProblem({ ...ok, qr: null })).toBe('Choose the QR catalog')
    expect(catalogSettingsProblem({ ...ok, qr: 'c-old' }, catalogs)).toBe('The QR catalog Old Promo is switched off — choose another')
  })

  it('shows a switched-off additional catalog only while it is ticked, and never sends it', () => {
    const ok = catalogSettingsFrom(rows)
    expect(additionalChoices(ok, catalogs).map((c) => c.id)).toEqual(['c-cafe', 'c-take', 'c-grab', 'c-staff', 'c-old'])
    expect(additionalChoices(toggleAdditional(ok, 'c-old', false), catalogs).map((c) => c.id)).not.toContain('c-old')
    expect(settingsToSave(ok, catalogs).additional).toEqual(['c-staff', 'c-grab', 'c-cafe'])
  })

  it('ticks and unticks an additional catalog without repeats', () => {
    const s = { dineIn: 'a', takeaway: 'a', qr: 'a', additional: ['x'] }
    expect(toggleAdditional(s, 'x', true).additional).toEqual(['x'])
    expect(toggleAdditional(s, 'y', true).additional).toEqual(['x', 'y'])
    expect(toggleAdditional(s, 'x', false).additional).toEqual([])
  })
})

describe('noCatalogMessage', () => {
  it('uses the server\'s words', () => {
    expect(noCatalogMessage('dine_in')).toBe('No menu catalog is set for dine-in — set it in POS settings')
    expect(noCatalogMessage('takeaway')).toBe('No menu catalog is set for takeaway — set it in POS settings')
    expect(noCatalogMessage('qr')).toBe('No menu catalog is set for QR — set it in POS settings')
  })
})
