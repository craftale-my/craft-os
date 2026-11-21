// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { PosMenu } from '../features/pos/order/cart'
import { groupCart, type CartLine } from './qrCart'
import CartPage from './CartPage'

afterEach(cleanup)

const menu: PosMenu = { categories: [{ name: 'Drinks', products: [
  { id: 'latte', name: 'Latte', description: null, soldOut: false,
    variants: [{ id: 'hot', name: 'Hot', priceSen: 900, isBase: true }],
    groups: [{ id: 'milk', name: 'Milk', min: 0, max: 1, options: [
      { id: 'oat', name: 'Oat', priceDeltaSen: 200, isDefault: false, available: true }] }] },
  { id: 'cake', name: 'Cake', description: null, soldOut: true,
    variants: [{ id: 'slice', name: 'Slice', priceSen: 1500, isBase: true }], groups: [] },
  { id: 'tea', name: 'Tea', description: null, soldOut: false,
    variants: [{ id: 'v', name: 'V', priceSen: 500, isBase: true }], groups: [] },
] }] }
const L = (id: string, guestId: string, over: Partial<CartLine> = {}): CartLine => ({
  id, guestId, guestLabel: guestId === 'me' ? 'Eric' : 'Mei', guestAvatar: guestId === 'me' ? 'a1' : 'a3',
  productId: 'latte', variantId: 'hot', qty: 1, note: null, optionIds: [], ...over,
})
const tea = menu.categories[0].products[2]

type Props = Parameters<typeof CartPage>[0]
const make = (lines: CartLine[], over: Partial<Props> = {}): Props => {
  const { mine, others } = groupCart(lines, 'me')
  return {
    menu, mine, others, pairs: [], subtotalSen: 1100, sendable: true, status: 'ready', error: null,
    onBack: () => {}, onEdit: () => {}, onRemove: () => {}, onOpenProduct: () => {}, onPlace: () => {}, ...over,
  }
}
const mineLine = L('1', 'me', { qty: 2, optionIds: ['oat'], note: 'less ice' })
const meiLine = L('2', 'mei')

describe('CartPage', () => {
  it('shows my items with Edit and Remove, and the others read-only', () => {
    render(<CartPage {...make([mineLine, meiLine])} />)
    expect(screen.getByRole('heading', { name: 'Cart' })).toBeTruthy()
    const mineSec = screen.getByRole('region', { name: 'Your items' })
    expect(mineSec.textContent).toContain('2 × Latte')
    expect(mineSec.textContent).toContain('Oat')
    expect(mineSec.textContent).toContain('less ice')
    expect(within(mineSec).getByRole('button', { name: /Edit/ })).toBeTruthy()
    expect(within(mineSec).getByRole('button', { name: /Remove/ })).toBeTruthy()
    const others = screen.getByRole('region', { name: 'Others at this table' })
    expect(others.textContent).toContain('Mei')
    expect(others.textContent).toContain('1 × Latte')
    expect(within(others).queryByRole('button')).toBeNull()
  })
  it('Edit and Remove call back with the right line', () => {
    const onEdit = vi.fn(), onRemove = vi.fn()
    const second = L('3', 'me', { productId: 'tea', variantId: 'v' })
    render(<CartPage {...make([mineLine, second])} onEdit={onEdit} onRemove={onRemove} />)
    const rows = screen.getAllByRole('listitem')
    fireEvent.click(within(rows[1]).getByRole('button', { name: /Edit/ }))
    expect(onEdit).toHaveBeenCalledWith(tea, '3')
    fireEvent.click(within(rows[0]).getByRole('button', { name: /Remove/ }))
    expect(onRemove).toHaveBeenCalledWith('1')
  })
  it('an unavailable line is struck through, has no price, and its owner can still remove it', () => {
    const onRemove = vi.fn()
    const gone = L('4', 'me', { productId: 'cake', variantId: 'slice' })
    render(<CartPage {...make([gone])} sendable={false} onRemove={onRemove} />)
    expect(screen.getByText('Not available now')).toBeTruthy()
    expect(screen.queryByText('RM 15.00')).toBeNull()
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Remove/ }))
    expect(onRemove).toHaveBeenCalledWith('4')
  })
  it('shows the pairs strip when there are pairs, opening the product on a tap', () => {
    const onOpenProduct = vi.fn()
    render(<CartPage {...make([mineLine], { pairs: [tea], onOpenProduct })} />)
    const strip = screen.getByRole('region', { name: 'Goes well with your order' })
    fireEvent.click(within(strip).getByRole('button', { name: /Tea/ }))
    expect(onOpenProduct).toHaveBeenCalledWith(tea)
  })
  it('hides the pairs strip when there are none', () => {
    render(<CartPage {...make([mineLine])} />)
    expect(screen.queryByText('Goes well with your order')).toBeNull()
  })
  it('shows the subtotal and the tax note, and Place order with the total', () => {
    render(<CartPage {...make([mineLine])} />)
    expect(screen.getByText('Subtotal').parentElement?.textContent).toContain('RM 11.00')
    expect(screen.getByText('Before service charge and tax.')).toBeTruthy()
    const place = screen.getByRole('button', { name: 'Place order · RM 11.00' }) as HTMLButtonElement
    expect(place.disabled).toBe(false)
  })
  it('Place order calls back; it is off when nothing is sendable or the cart is not ready', () => {
    const onPlace = vi.fn()
    const { rerender } = render(<CartPage {...make([mineLine], { onPlace })} />)
    fireEvent.click(screen.getByRole('button', { name: /Place order/ }))
    expect(onPlace).toHaveBeenCalledTimes(1)
    rerender(<CartPage {...make([mineLine], { onPlace, sendable: false })} />)
    expect((screen.getByRole('button', { name: /Place order/ }) as HTMLButtonElement).disabled).toBe(true)
    rerender(<CartPage {...make([mineLine], { onPlace, status: 'loading' })} />)
    expect((screen.getByRole('button', { name: /Place order/ }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('says Reconnecting… when offline', () => {
    render(<CartPage {...make([mineLine], { status: 'offline' })} />)
    const b = screen.getByRole('button', { name: 'Reconnecting…' }) as HTMLButtonElement
    expect(b.disabled).toBe(true)
  })
  it('shows the removal error', () => {
    render(<CartPage {...make([mineLine], { error: 'Not removed — no connection. Try again.' })} />)
    expect(screen.getByRole('alert').textContent).toContain('Not removed')
  })
  it('the back button goes back', () => {
    const onBack = vi.fn()
    render(<CartPage {...make([mineLine], { onBack })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Back to menu' }))
    expect(onBack).toHaveBeenCalled()
  })
  it('an empty cart says so, offers Back to menu and has no Place order', () => {
    const onBack = vi.fn()
    render(<CartPage {...make([], { onBack, sendable: false })} />)
    expect(screen.getByText('Your cart is empty.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Place order/ })).toBeNull()
    const backs = screen.getAllByRole('button', { name: 'Back to menu' })
    expect(backs.length).toBe(2)
    fireEvent.click(backs[1])
    expect(onBack).toHaveBeenCalled()
  })
})
