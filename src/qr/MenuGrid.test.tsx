// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { PosProduct } from '../features/pos/order/cart'
import MenuGrid from './MenuGrid'

afterEach(cleanup)

const prod = (id: string, name: string, over: Partial<PosProduct> = {}): PosProduct => ({
  id, name, description: `about ${name}`, soldOut: false,
  variants: [{ id: 'v', name: 'V', priceSen: 1200, isBase: true }], groups: [], ...over,
})
const latte = prod('latte', 'Latte', { imageUrl: 'https://x/latte.jpg' })
const cake = prod('cake', 'Cake', { soldOut: true })
const sized = prod('tea', 'Tea', { variants: [
  { id: 's', name: 'S', priceSen: 800, isBase: true }, { id: 'l', name: 'L', priceSen: 1000, isBase: false }] })

const base = { products: [latte, cake, sized], popularIds: new Set<string>(), units: new Map<string, number>(), onOpen: () => {} }

describe('MenuGrid', () => {
  it('is a two-column grid of flat tiles (no card box) with name and price, and no description', () => {
    const { container } = render(<MenuGrid {...base} />)
    expect(container.firstElementChild?.className).toContain('grid-cols-2')
    expect(screen.getByRole('button', { name: 'Latte, RM 12.00' }).className).not.toMatch(/\bborder\b|\bshadow/)
    expect(screen.getByRole('button', { name: 'Latte, RM 12.00' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Tea, from RM 8.00' })).toBeTruthy()
    expect(screen.queryByText('about Latte')).toBeNull()
  })
  it('shows a quantity badge and says it in the label', () => {
    render(<MenuGrid {...base} units={new Map([['latte', 2]])} />)
    const tile = screen.getByRole('button', { name: 'Latte, RM 12.00, 2 in the cart' })
    expect(within(tile).getByTestId('qty-badge').textContent).toBe('2')
    expect(within(screen.getByRole('button', { name: 'Tea, from RM 8.00' })).queryByTestId('qty-badge')).toBeNull()
  })
  it('a sold-out tile is disabled, dimmed and labelled', () => {
    render(<MenuGrid {...base} />)
    const tile = screen.getByRole('button', { name: /Cake/ }) as HTMLButtonElement
    expect(tile.disabled).toBe(true)
    expect(tile.className).toContain('opacity-50')
    expect(within(tile).getByText('Sold out · RM 12.00')).toBeTruthy()
    expect(tile.getAttribute('aria-label')).toBe('Cake, RM 12.00, sold out')
  })
  it('marks Popular products with the pill', () => {
    render(<MenuGrid {...base} popularIds={new Set(['latte'])} />)
    expect(screen.getByRole('button', { name: /Latte/ }).textContent).toContain('Popular')
    expect(screen.getByRole('button', { name: /Tea/ }).textContent).not.toContain('Popular')
  })
  it('keeps the Popular pill out of the clamped name and says Popular in the label', () => {
    render(<MenuGrid {...base} popularIds={new Set(['latte'])} units={new Map([['latte', 2]])} />)
    const tile = screen.getByRole('button', { name: 'Latte, RM 12.00, Popular, 2 in the cart' })
    const name = within(tile).getByTestId('tile-name')
    expect(name.textContent).toBe('Latte')
    expect(name.contains(within(tile).getByText('Popular'))).toBe(false)
    expect(screen.getByRole('button', { name: 'Tea, from RM 8.00' })).toBeTruthy()
  })
  it('a tap opens the product', () => {
    const onOpen = vi.fn()
    render(<MenuGrid {...base} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: /Latte/ }))
    expect(onOpen).toHaveBeenCalledWith(latte)
  })
  it('shows a photo when there is one and a plain block when not', () => {
    const { container } = render(<MenuGrid {...base} />)
    expect(container.querySelectorAll('img').length).toBe(1)
    expect(container.querySelectorAll('.bg-border.aspect-square').length).toBe(2)
  })

  it('shows who picked a product: avatars on the photo and names in the label', () => {
    const p = { id: 'x', name: 'Latte', description: null, soldOut: false, variants: [{ id: 'v', name: 'V', priceSen: 1200, isBase: true }], groups: [] }
    const who = [
      { guestId: 'me', label: 'Eric', avatar: 'a1', qty: 1, isMe: true },
      { guestId: 'g', label: 'grace', avatar: 'a3', qty: 2, isMe: false },
    ]
    render(<MenuGrid products={[p]} popularIds={new Set()} units={new Map([['x', 3]])} pickers={new Map([['x', who]])} onOpen={() => {}} />)
    expect(screen.getByTestId('picker-avatars').children).toHaveLength(2)
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('3 in the cart (You × 1, grace × 2)')
  })
})
