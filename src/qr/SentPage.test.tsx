// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
  it('is Order details: a check and Order sent, then Table and Bill no. side by side', () => {
    render(<SentPage {...base} />)
    expect(screen.getByRole('heading', { name: 'Order details', level: 1 })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Order sent' })).toBeTruthy()
    const cols = screen.getByTestId('sent-columns')
    expect(cols.className).toContain('grid-cols-2')
    expect(within(cols).getByText('Table').nextElementSibling?.textContent).toBe('T3')
    expect(within(cols).getByText('Bill no.').nextElementSibling?.textContent).toBe('B-102')
  })
  it('leaves the bill column out when the table state has none yet', () => {
    render(<SentPage {...base} billNo={null} />)
    expect(screen.queryByText('Bill no.')).toBeNull()
    expect(screen.getByText('T3')).toBeTruthy()
  })
  it('lists the Items by guest: quantity box, name with modifiers, price', () => {
    render(<SentPage {...base} />)
    expect(screen.getByRole('heading', { name: 'Items' })).toBeTruthy()
    const text = document.body.textContent ?? ''
    expect(text.indexOf('Eric')).toBeLessThan(text.indexOf('Mei'))
    const lines = screen.getAllByTestId('item-line')
    expect(lines).toHaveLength(2)
    expect(within(lines[0]).getByText('2')).toBeTruthy()
    expect(within(lines[0]).getByText('Latte')).toBeTruthy()
    expect(within(lines[0]).getByText('Oat')).toBeTruthy()
    expect(within(lines[0]).getByText('RM 22.00')).toBeTruthy()      // 2 × (9.00 + 2.00)
    expect(within(lines[1]).getByText('RM 9.00')).toBeTruthy()
  })
  it('Add more, Orders and the close button call back', () => {
    const onAddMore = vi.fn(), onViewOrders = vi.fn()
    render(<SentPage {...base} onAddMore={onAddMore} onViewOrders={onViewOrders} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add more' }))
    fireEvent.click(screen.getByRole('button', { name: 'Orders' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onAddMore).toHaveBeenCalledTimes(2)
    expect(onViewOrders).toHaveBeenCalled()
  })
})
