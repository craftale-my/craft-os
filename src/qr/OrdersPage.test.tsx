// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { OrderedItem } from './qrCart'
import OrdersPage from './OrdersPage'

afterEach(cleanup)

const it_ = (name: string, over: Partial<OrderedItem> = {}): OrderedItem =>
  ({ name, qty: 1, unitPriceSen: 900, mods: [], note: null, voided: false, ...over })
const items: OrderedItem[] = [
  it_('Toast', { guestLabel: null }),
  it_('Latte', { guestLabel: 'Eric', guestAvatar: 'a1', qty: 2, mods: ['Oat'], unitPriceSen: 1100 }),
  it_('Cake', { guestLabel: 'Mei', guestAvatar: 'a3', voided: true, unitPriceSen: 1500 }),
]

describe('OrdersPage', () => {
  it('lists the table\'s orders by guest, the counter last, voided items struck through', () => {
    render(<OrdersPage items={items} subtotalSen={3100} onBack={() => {}} />)
    expect(screen.getByRole('heading', { name: 'Orders' })).toBeTruthy()
    const text = document.body.textContent ?? ''
    expect(text.indexOf('Eric')).toBeLessThan(text.indexOf('Mei'))
    expect(text.indexOf('Mei')).toBeLessThan(text.indexOf('Ordered at the counter'))
    const latte = screen.getByText('Latte').closest('[data-testid="item-line"]') as HTMLElement
    expect(within(latte).getByText('2')).toBeTruthy()
    expect(within(latte).getByText(/Oat/)).toBeTruthy()
    expect(within(latte).getByText('RM 22.00')).toBeTruthy()
    expect(screen.getByText('Cake').closest('[data-testid="item-line"]')?.className).toContain('line-through')
  })
  it('shows the subtotal and the tax note', () => {
    render(<OrdersPage items={items} subtotalSen={3100} onBack={() => {}} />)
    expect(screen.getByText('Subtotal').parentElement?.textContent).toContain('RM 31.00')
    expect(screen.getByText('Before service charge and tax.')).toBeTruthy()
  })
  it('the back chevron and the Back to menu button go back', () => {
    const onBack = vi.fn()
    render(<OrdersPage items={items} subtotalSen={3100} onBack={onBack} />)
    const backs = screen.getAllByRole('button', { name: 'Back to menu' })
    expect(backs).toHaveLength(2)
    backs.forEach((b) => fireEvent.click(b))
    expect(onBack).toHaveBeenCalledTimes(2)
  })
  it('says so when nothing has been ordered', () => {
    const onBack = vi.fn()
    render(<OrdersPage items={[]} subtotalSen={0} onBack={onBack} />)
    expect(screen.getByText('Nothing ordered yet.')).toBeTruthy()
    expect(screen.queryByText('Subtotal')).toBeNull()
    const backs = screen.getAllByRole('button', { name: 'Back to menu' })
    fireEvent.click(backs[backs.length - 1])
    expect(onBack).toHaveBeenCalled()
  })
})
