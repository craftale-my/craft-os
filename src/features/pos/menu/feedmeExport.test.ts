// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { zipSync } from 'fflate'
import { buildCatalogsImport, buildMenuImport, clean, readFeedmeExport, toSen, type FeedmeFiles } from './feedmeExport'
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

  it('skips a repeated variant key and a repeated base row, keeping the first', () => {
    const f = files()
    f.menu['Craft Cafe'].push(
      menuRow('product_tea', 'Apple Tea', 'variant_x/1', 'COLD AGAIN', 'TEA', 'ALL', '99'),
      menuRow('product_don', 'Smoked Duck DON v2', '', '', 'DONBURI', 'ALL', '1'),
    )
    const r = buildMenuImport(f, 'Craft Cafe')
    const tea = r.payload.products.find((p) => p.feedmeId === 'product_tea')!
    expect(tea.variants.map((v) => v.priceSen)).toEqual([1000, 1150])
    expect(r.payload.products.find((p) => p.feedmeId === 'product_don')!.variants[0].priceSen).toBe(2400)
    expect(r.warnings).toContain('Apple Tea / COLD AGAIN: duplicate variant key — skipped')
    expect(r.warnings).toContain('Smoked Duck DON v2: second base row for the same Product ID — skipped')
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

  it('refuses a link sheet with no catalog column, since importing would remove every link', () => {
    const f = files()
    f.itemLinkedAddon = {
      '1. Sauce | Choose One': [
        ['Group ID', 'Item ID', 'Item Name', 'Grab Food'],
        ['group_sauce', 'product_don', 'Smoked Duck DON', 'T'],
      ],
    }
    expect(() => buildMenuImport(f, 'Craft Cafe')).toThrow(
      'Invalid import file: no add-on link sheet has a "Craft Cafe" column — importing would remove every add-on link',
    )
  })

  it('refuses an export with no link sheets at all while groups exist', () => {
    const f = files()
    f.itemLinkedAddon = {}
    expect(() => buildMenuImport(f, 'Craft Cafe')).toThrow('no add-on link sheet has a "Craft Cafe" column')
  })

  it('warns when readable link sheets yield no links', () => {
    const f = files()
    f.itemLinkedAddon['1. Sauce | Choose One'][1][3] = ''
    const r = buildMenuImport(f, 'Craft Cafe')
    expect(r.payload.links).toEqual([])
    expect(r.warnings).toContain('No product ↔ add-on links found — importing will remove every add-on link')
  })

  it('does not warn about links when the normal path produces some', () => {
    expect(warnings.some((w) => w.includes('No product ↔ add-on links'))).toBe(false)
  })

  it('warns about a group whose options were all skipped', () => {
    const f = files()
    f.addonGroup['Craft Cafe'] = [GROUP_HEADER, groupRow('group_sauce', 'Sauce | Choose One', '1', '1', 'item_ghost', 'Ghost', '0')]
    const r = buildMenuImport(f, 'Craft Cafe')
    expect(r.warnings).toContain('Sauce | Choose One: no usable options — importing will remove all its options')
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

// Three catalogs, as Feedme exports them: every sheet lists every product with its own
// "Order from" and price; NONE leaves a product out of that catalog.
function catalogFiles(): FeedmeFiles {
  const sheet = (rows: { tea: [string, string, string]; don: [string, string]; cake: [string, string] }) => [
    MENU_HEADER,
    menuRow('product_tea', 'Apple Tea', '', '', 'TEA', rows.tea[0], '10'),
    menuRow('product_tea', 'Apple Tea', 'variant_x/0', 'HOT', 'TEA', rows.tea[0], rows.tea[1]),
    menuRow('product_tea', 'Apple Tea', 'variant_x/1', 'COLD', 'TEA', rows.tea[0], rows.tea[2]),
    menuRow('product_don', 'Smoked Duck DON', '', '', 'DONBURI', rows.don[0], rows.don[1], '1.06'),
    menuRow('product_cake', 'Burnt Cheesecake', '', '', 'CAKE', rows.cake[0], rows.cake[1]),
    menuRow('item_egg', 'Salted Egg', '', '', 'ADDON', 'ALL', '0'),
  ]
  const addon = (eggPrice: string) => [GROUP_HEADER, groupRow('group_sauce', 'Sauce | Choose One', '1', '1', 'item_egg', 'Salted Egg', eggPrice)]
  return {
    menu: {
      'Default Catalog': sheet({ tea: ['ALL', '10', '11.5'], don: ['ALL', '24'], cake: ['NONE', '15'] }),
      'Craft Cafe': sheet({ tea: ['ALL', '10', '11.5'], don: ['POS_ONLY', '24'], cake: ['NONE', '15'] }),
      'Grab Food': sheet({ tea: ['ALL', '11', '13'], don: ['NONE', '24'], cake: ['ALL', '17'] }),
      'Staff Meal': sheet({ tea: ['POS_ONLY', '10', '11.5'], don: ['ALL', '20'], cake: ['NONE', '15'] }),
    },
    addonGroup: { 'Default AddonGroup': addon('0'), 'Craft Cafe': addon('0'), 'Grab Food': addon('1.5') },
    itemLinkedAddon: {
      '1. Sauce | Choose One': [
        ['Group ID', 'Item ID', 'Item Name', 'Default Catalog', 'Grab Food'],
        ['group_sauce', 'product_don', 'Smoked Duck DON', 'T', ''],
      ],
    },
  }
}

describe('buildCatalogsImport', () => {
  const { payload, warnings } = buildCatalogsImport(catalogFiles())
  const catalog = (name: string) => payload.catalogs.find((c) => c.name === name)!

  it('takes the master list from the Default sheets, every product included', () => {
    expect(payload.products.map((p) => p.feedmeId)).toEqual(['product_tea', 'product_don', 'product_cake', 'item_egg'])
    expect(payload.groups.map((g) => g.feedmeId)).toEqual(['group_sauce'])
    expect(payload.links).toEqual([{ productFeedmeId: 'product_don', groupFeedmeId: 'group_sauce', sortOrder: 0 }])
  })

  it('makes one catalog per other sheet, in sheet order', () => {
    expect(payload.catalogs.map((c) => [c.name, c.sortOrder])).toEqual([['Craft Cafe', 0], ['Grab Food', 1], ['Staff Meal', 2]])
  })

  it('includes ALL and POS_ONLY products with a price for every variant, and leaves NONE out', () => {
    expect(catalog('Craft Cafe').products).toEqual([
      { feedmeId: 'product_tea', availability: 'all', sortOrder: 0, prices: [{ key: 'variant_x/0', priceSen: 1000 }, { key: 'variant_x/1', priceSen: 1150 }] },
      { feedmeId: 'product_don', availability: 'counter_only', sortOrder: 3, prices: [{ key: '', priceSen: 2400 }] },
      { feedmeId: 'item_egg', availability: 'all', sortOrder: 5, prices: [{ key: '', priceSen: 0 }] },
    ])
    expect(catalog('Staff Meal').products.map((p) => [p.feedmeId, p.availability])).toEqual(
      [['product_tea', 'counter_only'], ['product_don', 'all'], ['item_egg', 'all']])
  })

  it('takes each catalog\'s own prices', () => {
    expect(catalog('Grab Food').products.find((p) => p.feedmeId === 'product_tea')!.prices)
      .toEqual([{ key: 'variant_x/0', priceSen: 1100 }, { key: 'variant_x/1', priceSen: 1300 }])
    expect(catalog('Grab Food').products.find((p) => p.feedmeId === 'product_cake')!.prices).toEqual([{ key: '', priceSen: 1700 }])
    expect(catalog('Staff Meal').products.find((p) => p.feedmeId === 'product_don')!.prices).toEqual([{ key: '', priceSen: 2000 }])
  })

  it('keeps only the add-on prices that differ from the default, and says when a catalog has no add-on sheet', () => {
    expect(catalog('Grab Food').optionPrices).toEqual([{ groupFeedmeId: 'group_sauce', productFeedmeId: 'item_egg', variantKey: '', priceSen: 150 }])
    expect(catalog('Craft Cafe').optionPrices).toEqual([])
    expect(warnings).toContain('Staff Meal: no add-on price sheet — add-ons use their default prices')
  })

  it('takes the first of a repeated default add-on option as its default price, as menu_import keeps the first', () => {
    const f = catalogFiles()
    const egg = (price: string) => groupRow('group_sauce', 'Sauce | Choose One', '1', '1', 'item_egg', 'Salted Egg', price)
    f.addonGroup['Default AddonGroup'] = [GROUP_HEADER, egg('0'), egg('2')]
    f.addonGroup['Grab Food'] = [GROUP_HEADER, egg('2')]           // equal to the LAST duplicate, not the default
    const r = buildCatalogsImport(f)
    expect(r.payload.catalogs.find((c) => c.name === 'Grab Food')!.optionPrices)
      .toEqual([{ groupFeedmeId: 'group_sauce', productFeedmeId: 'item_egg', variantKey: '', priceSen: 200 }])
    expect(r.payload.catalogs.find((c) => c.name === 'Craft Cafe')!.optionPrices).toEqual([])
  })

  it('reports catalog link columns that differ from the Default Catalog', () => {
    expect(warnings).toContain('Grab Food: 1 add-on link differs from the Default Catalog — Craft OS uses the Default Catalog links for every catalog')
  })

  it('leaves out a product with a variant that has no usable price, and says so', () => {
    const f = catalogFiles()
    f.menu['Grab Food'][3][13] = 'abc'                       // Apple Tea / COLD
    const r = buildCatalogsImport(f)
    expect(r.payload.catalogs.find((c) => c.name === 'Grab Food')!.products.map((p) => p.feedmeId)).toEqual(['product_cake', 'item_egg'])
    expect(r.warnings).toContain('Grab Food: Apple Tea / COLD has no price — left out of this catalog')
  })

  it('fails clearly without the master sheet or without any catalog sheet', () => {
    const noMaster = catalogFiles()
    delete noMaster.menu['Default Catalog']
    expect(() => buildCatalogsImport(noMaster)).toThrow('Sheet "Default Catalog" not found in the menu file')
    const onlyMaster = catalogFiles()
    onlyMaster.menu = { 'Default Catalog': onlyMaster.menu['Default Catalog'] }
    expect(() => buildCatalogsImport(onlyMaster)).toThrow('The menu file has no catalog sheets — is this a Feedme menu export?')
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
