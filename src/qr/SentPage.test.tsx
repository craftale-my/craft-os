// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PosMenu } from '../features/pos/order/cart'
import type { CartLine, GuestGroup } from './qrCart'
import SentPage from './SentPage'

afterEach(cleanup)

const menu: PosMenu = { categories: [{ name: 'Drinks', products: [
  { id: 'latte', name: 'Latte', description: null, soldOut: false,
    variants: [{ id: 'hot', name: 'Hot', priceSen: 900, isBase: true }],
    groups: [{ id: 'milk', name: 'Milk', min: 0, max: 1, options: [
      { id: 'oat', name: 'Oat', priceDeltaSen: 200, isDefault: false, available: true }] }] },
] }] }
const L = (id: string, guestId: string, over: Partial<CartLine> = {}): CartLine => ({
  id, guestId, guestLabel: guestId === 'me' ? 'Eric' : 'Mei', guestAvatar: 'a1',
  productId: 'latte', variantId: 'hot', qty: 1, note: null, optionIds: [], ...over,
})
const groups: GuestGroup[] = [
  { guestId: 'me', label: 'Eric', avatar: 'a1', isMe: true, lines: [L('1', 'me', { qty: 2, optionIds: ['oat'] })] },
  { guestId: 'mei', label: 'Mei', avatar: 'a3', isMe: false, lines: [L('2', 'mei')] },
]
const base = { menu, groups, tableLabel: 'T3', billNo: 'B-102', onAddMore: () => {}, onViewOrders: () => {} }

describe('SentPage', () => {
  it('says the order is placed, with the table and the bill number', () => {
    render(<SentPage {...base} />)
    expect(screen.getByRole('heading', { name: 'Order placed' })).toBeTruthy()
    expect(screen.getByText('Table T3 · Bill B-102')).toBeTruthy()
    expect(screen.getByText('It is on its way.')).toBeTruthy()
  })
  it('leaves the bill out when the table state has none yet', () => {
    render(<SentPage {...base} billNo={null} />)
    expect(screen.getByText('Table T3')).toBeTruthy()
  })
  it('lists what was sent by guest, with modifiers and prices', () => {
    render(<SentPage {...base} />)
    expect(screen.getByText(/Eric/)).toBeTruthy()
    expect(screen.getByText(/Mei/)).toBeTruthy()
    expect(screen.getByText('2 × Latte')).toBeTruthy()
    expect(screen.getByText('Oat')).toBeTruthy()
    expect(screen.getByText('RM 22.00')).toBeTruthy()      // 2 × (9.00 + 2.00)
    expect(screen.getByText('RM 9.00')).toBeTruthy()
  })
  it('Add more and View orders call back', () => {
    const onAddMore = vi.fn(), onViewOrders = vi.fn()
    render(<SentPage {...base} onAddMore={onAddMore} onViewOrders={onViewOrders} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add more' }))
    fireEvent.click(screen.getByRole('button', { name: 'View orders' }))
    expect(onAddMore).toHaveBeenCalled()
    expect(onViewOrders).toHaveBeenCalled()
  })
})
