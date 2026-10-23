import { describe, expect, it } from 'vitest'
import { canImport, catalogSummary } from './importView'

describe('catalogSummary', () => {
  it('counts the products, the counter-only ones and the add-on prices of a catalog', () => {
    expect(catalogSummary({
      name: 'Grab Food', sortOrder: 1,
      products: [
        { feedmeId: 'a', availability: 'all', sortOrder: 0, prices: [] },
        { feedmeId: 'b', availability: 'counter_only', sortOrder: 1, prices: [] },
      ],
      optionPrices: [{ groupFeedmeId: 'g', productFeedmeId: 'x', variantKey: '', priceSen: 150 }],
    })).toEqual({ name: 'Grab Food', products: 2, counterOnly: 1, optionPrices: 1 })
  })
})

describe('canImport', () => {
  it('needs the typed word only when catalogs already exist', () => {
    expect(canImport(0, '')).toBe(true)
    expect(canImport(1, '')).toBe(false)
    expect(canImport(1, 'import')).toBe(false)
    expect(canImport(1, ' IMPORT ')).toBe(true)
  })
})
