import { describe, expect, it } from 'vitest'
import {
  addGroup, addVariant, emptyProductForm, fillCatalogBlanks, moveGroup, moveVariant, productFormDirty, productFormFromDetail,
  productPayload, productProblems, removeGroup, removeNewVariant, setCatalogAvailability, setCatalogPrice, updateVariant, type ProductForm,
} from './productForm'
import type { ProductDetail } from './menuEditorApi'

const names: Record<string, string> = { cafe: 'Craft Cafe', grab: 'Grab Food', staff: 'Staff Meal' }
const catalogName = (id: string) => names[id] ?? id
const problems = (f: ProductForm) => productProblems(f, catalogName)
const messages = (f: ProductForm) => problems(f).map((p) => p.message)

const detail: ProductDetail = {
  id: 'p1', name: 'Latte', internalName: null, description: 'Double shot', categoryId: 'coffee', sstRateBp: 600,
  printRoute: 'Bar', takeawayFeeSen: 50, isActive: true, isAddon: false, feedmeProductId: 'fm-1',
  variants: [
    { id: 'v-hot', name: 'Hot', priceSen: 1200, isActive: true },
    { id: 'v-cold', name: 'Cold', priceSen: 1300, isActive: true },
    { id: 'v-old', name: 'Large', priceSen: 1500, isActive: false },
  ],
  groupIds: ['g-milk', 'g-sugar'],
  catalogs: [
    { catalogId: 'grab', availability: 'counter_only', prices: { 'v-hot': 1700, 'v-cold': 1800 } },
    { catalogId: 'cafe', availability: 'all', prices: { 'v-hot': 1210, 'v-cold': 1310, 'v-old': 1 } },
  ],
}
const saved = () => productFormFromDetail(detail, ['cafe', 'staff', 'grab'])

describe('the form of a saved product', () => {
  it('shows prices as RM text and lists every catalog in the given order, hidden where it is not sold', () => {
    const f = saved()
    expect(f.takeawayFee).toBe('0.50')
    expect(f.variants.map((v) => [v.ref, v.price])).toEqual([['v-hot', '12.00'], ['v-cold', '13.00'], ['v-old', '15.00']])
    expect(f.catalogs.map((c) => [c.catalogId, c.availability])).toEqual([['cafe', 'all'], ['staff', 'hidden'], ['grab', 'counter_only']])
    expect(f.catalogs[0].prices).toEqual({ 'v-hot': '12.10', 'v-cold': '13.10', 'v-old': '0.01' })
    expect(problems(f)).toEqual([])
  })

  it('turns back into the payload menu_save_product takes, ids as refs, prices in sen', () => {
    const p = productPayload(saved())                                       // nothing to compare with: everything is sent
    expect(p.id).toBe('p1')
    expect(p.takeawayFeeSen).toBe(50)
    expect(p.variants[0]).toEqual({ ref: 'v-hot', id: 'v-hot', name: 'Hot', priceSen: 1200, isActive: true })
    // a switched-off variant's price is not shown, so it is not sent (the server keeps it)
    expect(p.catalogs[0]).toEqual({ catalogId: 'cafe', availability: 'all', prices: [
      { ref: 'v-hot', priceSen: 1210 }, { ref: 'v-cold', priceSen: 1310 },
    ] })
    expect(p.catalogs[1]).toEqual({ catalogId: 'staff', availability: 'hidden', prices: [] })
    expect(p.groupIds).toEqual(['g-milk', 'g-sugar'])
  })
})

describe('a new product', () => {
  it('starts with one Regular variant, in no catalog, and asks for a name, a category and a price', () => {
    const f = emptyProductForm(['cafe', 'grab'])
    expect(f.variants).toEqual([{ ref: 'new-1', id: null, name: 'Regular', price: '', isActive: true }])
    expect(f.catalogs.every((c) => c.availability === 'hidden')).toBe(true)
    expect(messages(f)).toEqual([
      'Product name is required', 'Choose a category', 'Enter the default price of Regular in RM, e.g. 12.50',
    ])
  })

  it('cleans names and drops blank optional text in the payload', () => {
    const f = { ...emptyProductForm(['cafe'], 'coffee'), name: '  Iced   Latte ', internalName: '  ', variants: [
      { ref: 'new-1', id: null, name: ' Regular ', price: '9.5', isActive: true },
    ] }
    const p = productPayload(f)
    expect(p.name).toBe('Iced Latte')
    expect(p.internalName).toBeNull()
    expect(p.description).toBeNull()
    expect(p.variants).toEqual([{ ref: 'new-1', id: null, name: 'Regular', priceSen: 950, isActive: true }])
  })
})

describe('variants', () => {
  it('adds a blank variant with a fresh ref and moves it', () => {
    let f = addVariant(saved())
    expect(f.variants[3]).toEqual({ ref: 'new-1', id: null, name: '', price: '', isActive: true })
    f = moveVariant(f, 3, -1)
    expect(f.variants.map((v) => v.ref)).toEqual(['v-hot', 'v-cold', 'new-1', 'v-old'])
  })

  it('removes only an unsaved variant (with its catalog prices); a saved one is switched off instead', () => {
    let f = setCatalogPrice(addVariant(saved()), 'cafe', 'new-1', '14.00')
    f = removeNewVariant(f, 'new-1')
    expect(f.variants).toHaveLength(3)
    expect(f.catalogs[0].prices['new-1']).toBeUndefined()
    expect(removeNewVariant(f, 'v-hot')).toBe(f)
  })

  it('needs at least one active variant, a name and an amount for each, no twins among the active ones', () => {
    let f = updateVariant(updateVariant(saved(), 'v-hot', { isActive: false }), 'v-cold', { isActive: false })
    expect(messages(f)).toEqual(['A product needs at least one active variant'])
    f = updateVariant(saved(), 'v-cold', { name: ' hot ' })
    expect(messages(f)).toEqual(['Two variants are called Hot'])
    f = updateVariant(saved(), 'v-old', { name: 'hot' })                    // a switched-off twin is fine
    expect(messages(f)).toEqual([])
    f = updateVariant(addVariant(saved()), 'new-1', { price: '1.234' })
    expect(problems(f).filter((p) => p.section === 'variants').map((p) => p.message)).toEqual([
      'Variant name is required', 'Enter the default price of the new variant in RM, e.g. 12.50',
    ])
  })
})

describe('catalogs', () => {
  it('putting the product in a catalog pre-fills blank prices of active variants with their default prices', () => {
    const f = setCatalogAvailability(saved(), 'staff', 'all')
    expect(f.catalogs[1]).toEqual({ catalogId: 'staff', availability: 'all', prices: { 'v-hot': '12.00', 'v-cold': '13.00' } })
    // switching channel inside a catalog keeps its own prices
    const g = setCatalogAvailability(saved(), 'grab', 'all')
    expect(g.catalogs[2].prices).toEqual({ 'v-hot': '17.00', 'v-cold': '18.00' })
  })

  it('requires a price for every active variant in every catalog that sells the product', () => {
    let f = addVariant(saved())
    f = updateVariant(f, 'new-1', { name: 'Large', price: '15' })
    expect(messages(f)).toEqual(['Craft Cafe: enter a price for Large', 'Grab Food: enter a price for Large'])
    expect(problems(f).every((p) => p.section === 'catalogs')).toBe(true)
    f = fillCatalogBlanks(fillCatalogBlanks(f, 'cafe'), 'grab')
    expect(f.catalogs[0].prices['new-1']).toBe('15.00')
    expect(messages(f)).toEqual([])
  })

  it('ignores what is typed in a catalog that does not sell the product, and sends no prices for it', () => {
    let f = setCatalogPrice(saved(), 'cafe', 'v-hot', 'twelve')
    expect(messages(f)).toEqual(['Craft Cafe: the price of Hot is not an amount in RM'])
    f = setCatalogAvailability(f, 'cafe', 'hidden')                          // the box is disabled now
    expect(messages(f)).toEqual([])
    expect(productPayload(f, saved()).catalogs).toEqual([{ catalogId: 'cafe', availability: 'hidden', prices: [] }])
  })
})

describe('a save sends only what changed (an edit made meanwhile elsewhere survives)', () => {
  it('sends no detail and no catalog when only a variant name changed', () => {
    const p = productPayload(updateVariant(saved(), 'v-hot', { name: 'Hot drink' }), saved())
    expect(p).toEqual({
      id: 'p1',
      variants: [
        { ref: 'v-hot', id: 'v-hot', name: 'Hot drink', priceSen: 1200, isActive: true },
        { ref: 'v-cold', id: 'v-cold', name: 'Cold', priceSen: 1300, isActive: true },
        { ref: 'v-old', id: 'v-old', name: 'Large', priceSen: 1500, isActive: false },
      ],
      groupIds: ['g-milk', 'g-sugar'],
      catalogs: [],
    })
  })

  it('sends a changed detail and a changed catalog only ("17" and "17.00" are the same price)', () => {
    let f = { ...saved(), sstRateBp: 0, takeawayFee: '0.5' }
    f = setCatalogPrice(f, 'grab', 'v-hot', '17')
    expect(productPayload(f, saved())).toMatchObject({ sstRateBp: 0, catalogs: [] })
    expect(productPayload(f, saved()).name).toBeUndefined()
    f = setCatalogPrice(f, 'cafe', 'v-cold', '13.50')
    expect(productPayload(f, saved()).catalogs.map((c) => c.catalogId)).toEqual(['cafe'])
  })

  it('sends every catalog when a variant was added or switched on', () => {
    const added = productPayload(updateVariant(addVariant(saved()), 'new-1', { name: 'Large', price: '15' }), saved())
    expect(added.catalogs.map((c) => c.catalogId)).toEqual(['cafe', 'staff', 'grab'])
    const on = productPayload(updateVariant(saved(), 'v-old', { isActive: true }), saved())
    expect(on.catalogs).toHaveLength(3)
  })

  it('a new product sends everything', () => {
    const f = { ...emptyProductForm(['cafe'], 'coffee'), name: 'Mocha', variants: [{ ref: 'new-1', id: null, name: 'Regular', price: '9', isActive: true }] }
    expect(productPayload(f, f)).toMatchObject({ id: null, name: 'Mocha', categoryId: 'coffee', sstRateBp: 600, takeawayFeeSen: 0 })
  })

  it('knows when the form differs from the one loaded', () => {
    expect(productFormDirty(saved(), saved())).toBe(false)
    expect(productFormDirty({ ...saved(), name: 'Latte!' }, saved())).toBe(true)
    expect(productFormDirty(saved(), null)).toBe(true)
  })
})

describe('add-on groups', () => {
  it('adds once, removes and reorders', () => {
    let f = addGroup(saved(), 'g-milk')
    expect(f.groupIds).toEqual(['g-milk', 'g-sugar'])
    f = moveGroup(addGroup(f, 'g-syrup'), 2, -2)
    expect(f.groupIds).toEqual(['g-syrup', 'g-milk', 'g-sugar'])
    expect(removeGroup(f, 'g-milk').groupIds).toEqual(['g-syrup', 'g-sugar'])
  })
})

describe('details', () => {
  it('checks the takeaway fee and the lengths the server allows', () => {
    const f = { ...saved(), takeawayFee: '-1', internalName: 'x'.repeat(121), name: 'y'.repeat(121) }
    expect(problems(f)).toEqual([
      { section: 'details', message: 'Product name is too long (at most 120 characters)' },
      { section: 'details', message: 'Internal name is too long (at most 120 characters)' },
      { section: 'details', message: 'Enter the takeaway fee in RM, e.g. 0.50' },
    ])
  })
})
