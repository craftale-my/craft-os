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
  it('is a two-column grid of tiles with name and price, and no description', () => {
    const { container } = render(<MenuGrid {...base} />)
    expect(container.firstElementChild?.className).toContain('grid-cols-2')
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
    expect(tile.textContent).toContain('Sold out')
    expect(tile.getAttribute('aria-label')).toBe('Cake, RM 12.00, sold out')
  })
  it('marks Popular products with the pill', () => {
    render(<MenuGrid {...base} popularIds={new Set(['latte'])} />)
    expect(screen.getByRole('button', { name: /Latte/ }).textContent).toContain('Popular')
    expect(screen.getByRole('button', { name: /Tea/ }).textContent).not.toContain('Popular')
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
})
