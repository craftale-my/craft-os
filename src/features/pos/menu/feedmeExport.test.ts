// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { zipSync } from 'fflate'
import { buildMenuImport, clean, readFeedmeExport, toSen, type FeedmeFiles } from './feedmeExport'
import { makeXlsx } from './testing/makeXlsx'

const MENU_HEADER = [
  'Product ID (For update do not modify, left blank will create new item)', 'Order code (blank if no code)', 'Name',
  'Internal name (blank if no internal name, catalog & variant will be ignored)',
  'Description (blank if no description, catalog & variant will be ignored)',
  'Variant key (Do not modify existed key, blank for base item and added variant)',
  'Variant Name (blank for base item and added variant)', 'Category (create new category if not existed)',
  'SubCategories (comma-separated subcategory names, variant will be ignored)', 'Order from (ALL, POS_ONLY, NONE)',
  'perXUnit', 'unit', 'Open price (T, F, variant will be ignored)', 'Selling price', 'Tracking cost', 'Min price',
  'Group under parent (T, F, variant will be ignored)',
  'Takeaway name (blank if not applicable, create new takeaway if not existed)',
  'Takeaway price (blank if not applicable, create new takeaway if not existed)',
]
const GROUP_HEADER = [
  'Group ID (For update do not modify, left blank)', 'Group Name', 'Min', 'Max', 'Stackable (T for TRUE / F for FALSE)',
  'Item ID (Can get in menu file)', 'Item Code (Can get in menu file)', 'Item Name',
  'Item Name Overrider (left it blank if no)', 'Variant Key (left it blank for base item)',
  'Variant Name (left it blank for base item)', 'Item price', 'Order from (ALL, POS_ONLY, NONE) (Default ALL)',
  'isDefault (T for TRUE / F for FALSE)',
]
// row builder: only the columns the importer reads
function menuRow(id: string, name: string, key: string, variantName: string, category: string, orderFrom: string, price: string, takeaway = '') {
  const r = Array(19).fill('')
  r[0] = id; r[2] = name; r[5] = key; r[6] = variantName; r[7] = category; r[9] = orderFrom; r[13] = price; r[18] = takeaway
  return r
}
function groupRow(gid: string, gname: string, min: string, max: string, itemId: string, itemName: string, price: string) {
  const r = Array(14).fill('')
  r[0] = gid; r[1] = gname; r[2] = min; r[3] = max; r[5] = itemId; r[7] = itemName; r[11] = price; r[12] = 'ALL'
  return r
}

function files(): FeedmeFiles {
  const menu = [
    MENU_HEADER,
    menuRow('product_tea', 'Apple Tea', '', '', 'TEA', 'ALL', '10'),
    menuRow('product_tea', 'Apple Tea', 'variant_x/0', 'HOT', 'TEA', 'ALL', '10'),
    menuRow('product_tea', 'Apple Tea', 'variant_x/1', 'COLD', 'TEA', 'ALL', '11.5'),
    menuRow('product_don', 'Smoked Duck  DON ', '', '', 'DONBURI', 'POS_ONLY', '24', '1.06'),
    menuRow('item_egg', 'Salted Egg 咸蛋酱 ', '', '', 'ADDON', 'NONE', '0'),
    menuRow('item_bad', 'Broken price', '', '', 'TEA', 'ALL', 'abc'),
  ]
  return {
    menu: { 'Craft Cafe': menu, 'Grab Food': menu.map((r) => [...r]) },
    addonGroup: {
      'Craft Cafe': [
        GROUP_HEADER,
        groupRow('group_sauce', 'Sauce | Choose One', '1', '1', 'item_egg', 'Salted Egg 咸蛋酱 ', '0'),
        groupRow('group_sauce', 'Sauce | Choose One', '1', '1', 'item_ghost', 'Ghost', '0'),
      ],
    },
    itemLinkedAddon: {
      '1. Sauce | Choose One': [
        ['Group ID', 'Item ID', 'Item Name', 'Default Catalog'],
        ['group_sauce', 'product_don', 'Smoked Duck DON', 'T'],
        ['group_sauce', 'product_tea', 'Apple Tea', ''],
      ],
    },
  }
}

describe('clean / toSen', () => {
  it('collapses and trims whitespace', () => {
    expect(clean('  Smoked Duck  DON ')).toBe('Smoked Duck DON')
  })
  it('converts ringgit text to sen and rejects junk', () => {
    expect(toSen('11.5')).toBe(1150)
    expect(toSen('1.06')).toBe(106)
    expect(toSen('0')).toBe(0)
    expect(toSen('')).toBeNull()
    expect(toSen('abc')).toBeNull()
    expect(toSen('-1')).toBeNull()
  })
})

describe('buildMenuImport', () => {
  const { payload, warnings } = buildMenuImport(files(), 'Craft Cafe')
  const byId = new Map(payload.products.map((p) => [p.feedmeId, p]))

  it('keeps categories in first-seen order', () => {
    expect(payload.categories).toEqual([
      { name: 'TEA', sortOrder: 0 },
      { name: 'DONBURI', sortOrder: 1 },
      { name: 'ADDON', sortOrder: 2 },
    ])
  })

  it('turns variant rows into variants and drops the base price for variant products', () => {
    expect(byId.get('product_tea')!.variants).toEqual([
      { key: 'variant_x/0', name: 'HOT', priceSen: 1000, sortOrder: 0 },
      { key: 'variant_x/1', name: 'COLD', priceSen: 1150, sortOrder: 1 },
    ])
  })

  it('gives a product without variants one base variant', () => {
    expect(byId.get('product_don')).toMatchObject({
      name: 'Smoked Duck DON',
      availability: 'counter_only',
      isAddon: false,
      takeawayFeeSen: 106,
      variants: [{ key: '', name: 'Regular', priceSen: 2400, sortOrder: 0 }],
    })
  })

  it('marks ADDON items and maps NONE to hidden', () => {
    expect(byId.get('item_egg')).toMatchObject({ name: 'Salted Egg 咸蛋酱', isAddon: true, availability: 'hidden' })
  })

  it('skips a product with no valid price and says why', () => {
    expect(byId.has('item_bad')).toBe(false)
    expect(warnings).toContain('Broken price: price "abc" is not a number — skipped')
  })

  it('builds groups from the catalog sheet and skips options for unknown products', () => {
    expect(payload.groups).toEqual([
      {
        feedmeId: 'group_sauce', name: 'Sauce | Choose One', min: 1, max: 1, stackable: false, sortOrder: 0,
        options: [{ productFeedmeId: 'item_egg', variantKey: '', name: 'Salted Egg 咸蛋酱', priceSen: 0, isDefault: false, availability: 'all', sortOrder: 0 }],
      },
    ])
    expect(warnings).toContain('Sauce | Choose One: option "Ghost" is not in the menu — skipped')
  })

  it('links products flagged T and falls back to the Default Catalog column with one warning', () => {
    expect(payload.links).toEqual([{ productFeedmeId: 'product_don', groupFeedmeId: 'group_sauce', sortOrder: 0 }])
    expect(warnings.filter((w) => w.includes('Default Catalog'))).toHaveLength(1)
  })

  it('fails clearly when the catalog sheet is missing', () => {
    expect(() => buildMenuImport(files(), 'Craftale')).toThrow('Sheet "Craftale" not found in the menu file')
  })

  it('fails clearly when a column is missing', () => {
    const f = files()
    f.menu['Craft Cafe'][0] = f.menu['Craft Cafe'][0].map((h) => (h === 'Selling price' ? 'Price' : h))
    expect(() => buildMenuImport(f, 'Craft Cafe')).toThrow('Column "Selling price" not found')
  })
})

describe('readFeedmeExport', () => {
  it('finds the three workbooks in the zip by their file-name prefix', () => {
    const f = files()
    const zip = zipSync({
      'menu_22-10-2026_19-36.xlsx': makeXlsx(f.menu),
      'addonGroup_22-10-2026_19-36.xlsx': makeXlsx(f.addonGroup),
      'itemLinkedAddon_22-10-2026_19-36.xlsx': makeXlsx(f.itemLinkedAddon),
      'translationLocalization_22-10-2026_19-36.xlsx': makeXlsx({ Product: [['Product ID']] }),
    })
    const read = readFeedmeExport(zip)
    expect(Object.keys(read.menu)).toEqual(['Craft Cafe', 'Grab Food'])
    expect(read.itemLinkedAddon['1. Sauce | Choose One'][1][1]).toBe('product_don')
  })

  it('says which file is missing', () => {
    const zip = zipSync({ 'menu_x.xlsx': makeXlsx({ S: [['a']] }) })
    expect(() => readFeedmeExport(zip)).toThrow('The zip has no addonGroup_….xlsx — is this a Feedme menu export?')
  })
})
