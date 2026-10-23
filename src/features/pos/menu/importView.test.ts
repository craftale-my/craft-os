import { describe, expect, it } from 'vitest'
import { MASTER_WARNING, MASTER_WARNING_INTRO, MASTER_WARNING_KEPT, MASTER_WARNING_LOSSES, canImport, catalogSummary } from './importView'

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

describe('MASTER_WARNING', () => {
  it('names everything a re-import overwrites, deletes or resets', () => {
    for (const part of [
      // imported products
      'name, description, internal name, category, takeaway fee and order are overwritten',
      'imported products you switched off come back on',
      // variants
      'variant name and price Feedme lists is overwritten',
      'variants of an imported product that you added here are switched off',
      // categories
      'a category you renamed here comes back under its Feedme name and the imported products move back into it',
      'categories you switched off come back on',
      // add-on groups
      'name, minimum, maximum and stackable setting overwritten',
      'groups you switched off come back on',
      // options
      'Every option of an imported add-on group is deleted and recreated',
      'option edits and option prices in all catalogs are lost',
      'the options get new ids',
      // links
      'add-on groups linked to each imported product are replaced',
      // catalogs
      'catalogs you switched off come back on and their order is reset',
      'the products each one sells',
      'counter only or also by QR',
      'their variant prices are overwritten',
      'including ones made only here, is hidden in it',
      // kept
      'Kept: SST rates and print routes',
      'made only in Craft OS',
      'each branch\'s catalog settings',
      'past orders',
      'may lack a price',
    ]) expect(MASTER_WARNING, part).toContain(part)
  })

  it('lists every loss and the kept line in the full text', () => {
    for (const item of MASTER_WARNING_LOSSES) expect(MASTER_WARNING).toContain(item)
    expect(MASTER_WARNING).toContain(MASTER_WARNING_INTRO)
    expect(MASTER_WARNING).toContain(MASTER_WARNING_KEPT)
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
