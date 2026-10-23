import { describe, expect, it } from 'vitest'
import {
  gridProductAfterSave, gridRowDirty, gridRowForm, gridRowPayload, gridRowProblem, gridSections, setGridAvailability,
} from './catalogGrid'
import type { GridProduct } from './menuEditorApi'

const latte: GridProduct = {
  id: 'p-latte', name: 'Latte', category: 'COFFEE', categorySort: 1, availability: 'all',
  variants: [
    { id: 'v-hot', name: 'Hot', isActive: true, defaultSen: 1200, priceSen: 1700 },
    { id: 'v-cold', name: 'Cold', isActive: true, defaultSen: 1300, priceSen: 1800 },
    { id: 'v-old', name: 'Large', isActive: false, defaultSen: 1500, priceSen: null },
  ],
}
const toast: GridProduct = {
  id: 'p-toast', name: 'Kaya Toast', category: 'FOOD', categorySort: 2, availability: 'hidden',
  variants: [{ id: 'v-reg', name: 'Regular', isActive: true, defaultSen: 800, priceSen: null }],
}

describe('a grid row', () => {
  it('starts from the catalog\'s prices and is clean', () => {
    const f = gridRowForm(latte)
    expect(f).toEqual({ availability: 'all', prices: { 'v-hot': '17.00', 'v-cold': '18.00' } })
    expect(gridRowDirty(f, latte)).toBe(false)
    expect(gridRowDirty({ ...f, prices: { ...f.prices, 'v-hot': '17' } }, latte)).toBe(false)
    expect(gridRowDirty({ ...f, prices: { ...f.prices, 'v-hot': '17.50' } }, latte)).toBe(true)
    expect(gridRowDirty({ ...f, availability: 'counter_only' }, latte)).toBe(true)
  })

  it('putting a product in pre-fills its default prices; a priced one keeps its prices', () => {
    expect(setGridAvailability(gridRowForm(toast), toast, 'counter_only')).toEqual({ availability: 'counter_only', prices: { 'v-reg': '8.00' } })
    expect(setGridAvailability(gridRowForm(latte), latte, 'counter_only').prices).toEqual({ 'v-hot': '17.00', 'v-cold': '18.00' })
  })

  it('needs a price for every active variant while the catalog sells it, and amounts only', () => {
    expect(gridRowProblem({ availability: 'all', prices: { 'v-hot': '17' } }, latte, 'Grab Food')).toBe('Grab Food: enter a price for Cold')
    expect(gridRowProblem({ availability: 'hidden', prices: { 'v-hot': 'abc' } }, latte, 'Grab Food')).toBeNull()
    expect(gridRowProblem({ availability: 'all', prices: { 'v-hot': '17', 'v-cold': '18', 'v-old': 'abc' } }, latte, 'Grab Food')).toBeNull()
    expect(gridRowProblem({ availability: 'all', prices: { 'v-hot': '17', 'v-cold': 'abc' } }, latte, 'Grab Food'))
      .toBe('Grab Food: the price of Cold is not an amount in RM')
  })

  it('sends ids and sen, and is clean again once saved', () => {
    const f = { availability: 'counter_only' as const, prices: { 'v-hot': '17.5', 'v-cold': '18.00' } }
    expect(gridRowPayload(f, latte, 'grab')).toEqual({
      catalogId: 'grab', productId: 'p-latte', availability: 'counter_only',
      prices: [{ variantId: 'v-hot', priceSen: 1750 }, { variantId: 'v-cold', priceSen: 1800 }],
    })
    const after = gridProductAfterSave(latte, f)
    expect(after.availability).toBe('counter_only')
    expect(after.variants.map((v) => v.priceSen)).toEqual([1750, 1800, null])
    expect(gridRowDirty(f, after)).toBe(false)
    // out of the catalog: no prices are sent, the stored ones stay
    expect(gridRowPayload({ availability: 'hidden', prices: { 'v-hot': '1' } }, latte, 'grab').prices).toEqual([])
    expect(gridProductAfterSave(latte, { availability: 'hidden', prices: {} }).variants.map((v) => v.priceSen)).toEqual([1700, 1800, null])
  })
})

describe('gridSections', () => {
  it('groups by category in the server\'s order and filters by name and in / out', () => {
    expect(gridSections([latte, toast], '', 'all').map((s) => s.title)).toEqual(['COFFEE', 'FOOD'])
    expect(gridSections([latte, toast], '', 'in').map((s) => s.products.map((p) => p.id))).toEqual([['p-latte']])
    expect(gridSections([latte, toast], '', 'out').map((s) => s.title)).toEqual(['FOOD'])
    expect(gridSections([latte, toast], 'KAYA', 'all').map((s) => s.title)).toEqual(['FOOD'])
  })

  it('keeps a just-saved product visible under the in / out filter, but search still applies', () => {
    const ids = (show: 'in' | 'out', kept?: Set<string>, q = '') =>
      gridSections([latte, toast], q, show, kept).flatMap((s) => s.products.map((p) => p.id))
    expect(ids('in')).toEqual(['p-latte'])
    expect(ids('in', new Set(['p-toast']))).toEqual(['p-latte', 'p-toast'])      // saved out of the catalog, still listed
    expect(ids('out')).toEqual(['p-toast'])
    expect(ids('out', new Set(['p-latte']))).toEqual(['p-latte', 'p-toast'])     // saved into the catalog, still listed
    expect(ids('in', new Set(['p-toast']), 'latte')).toEqual(['p-latte'])        // search still applies to kept ids
  })
})
