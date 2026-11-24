import { describe, expect, it } from 'vitest'
import { padProductInfo, withPhotos } from './padInfo'
import type { PosMenu } from './cart'

const url = (path: string, at: string | null) => `https://img/${path}${at ? `?v=${at}` : ''}`

describe('padProductInfo', () => {
  it('keeps the SST rate and packaging fee, and turns a photo path into its URL', () => {
    const m = padProductInfo([
      { id: 'p1', sst_rate_bp: 600, takeaway_fee_sen: 100, image_path: 'p1.webp', image_updated_at: '1' },
      { id: 'p2', sst_rate_bp: 0, takeaway_fee_sen: 0, image_path: null, image_updated_at: null },
    ], url)
    expect(m.get('p1')).toEqual({ sstRateBp: 600, takeawayFeeSen: 100, imageUrl: 'https://img/p1.webp?v=1' })
    expect(m.get('p2')).toEqual({ sstRateBp: 0, takeawayFeeSen: 0, imageUrl: null })
  })
})

describe('withPhotos', () => {
  it('puts each product\'s photo on the menu; unknown products get none', () => {
    const product = (id: string) => ({ id, name: id, description: null, soldOut: false, variants: [], groups: [] })
    const menu: PosMenu = { categories: [{ name: 'TEA', products: [product('p1'), product('p9')] }] }
    const info = padProductInfo([{ id: 'p1', sst_rate_bp: 600, takeaway_fee_sen: 0, image_path: 'p1.webp', image_updated_at: null }], url)
    expect(withPhotos(menu, info).categories[0].products.map((p) => p.imageUrl)).toEqual(['https://img/p1.webp', null])
  })
})
