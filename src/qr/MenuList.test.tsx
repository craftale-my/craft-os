// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { PosProduct } from '../features/pos/order/cart'
import MenuList from './MenuList'

afterEach(cleanup)

const prod = (id: string, name: string, over: Partial<PosProduct> = {}): PosProduct => ({
  id, name, description: `about ${name}`, soldOut: false,
  variants: [{ id: 'v', name: 'V', priceSen: 1200, isBase: true }], groups: [], ...over,
})
const latte = prod('latte', 'Latte', { imageUrl: 'https://x/latte.jpg' })
const cake = prod('cake', 'Cake', { soldOut: true })
const tea = prod('tea', 'Tea', { description: null, variants: [
  { id: 's', name: 'S', priceSen: 800, isBase: true }, { id: 'l', name: 'L', priceSen: 1000, isBase: false }] })

const base = { products: [latte, cake, tea], popularIds: new Set<string>(), units: new Map<string, number>(), onOpen: () => {} }

describe('MenuList', () => {
  it('is flat rows with a hairline between them: name, description (2 lines), price', () => {
    render(<MenuList {...base} />)
    const row = screen.getByRole('button', { name: 'Latte, RM 12.00' })
    expect(row.className).not.toMatch(/\brounded|\bshadow|\bborder\b(?!-b)/)
    expect(row.closest('li')?.className).toContain('border-b')
    expect(within(row).getByText('Latte').className).toContain('font-semibold')
    const desc = within(row).getByText('about Latte')
    expect(desc.className).toContain('line-clamp-2')
    expect(within(row).getByText('RM 12.00')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Tea, from RM 8.00' }).textContent).not.toContain('about')
  })
  it('puts a square photo on the right only when the product has one (no placeholder)', () => {
    const { container } = render(<MenuList {...base} />)
    const imgs = container.querySelectorAll('img')
    expect(imgs.length).toBe(1)
    expect(imgs[0].className).toContain('h-24')
    expect(imgs[0].className).toContain('w-24')
    expect(container.querySelectorAll('.bg-border').length).toBe(0)
  })
  it('shows the quantity badge on the photo, or at the row\'s right edge without one', () => {
    render(<MenuList {...base} units={new Map([['latte', 2], ['tea', 1]])} />)
    const withPhoto = screen.getByRole('button', { name: 'Latte, RM 12.00, 2 in the cart' })
    expect(within(withPhoto).getByTestId('qty-badge').textContent).toBe('2')
    expect(within(withPhoto).getByTestId('qty-badge').parentElement?.querySelector('img')).toBeTruthy()
    const noPhoto = screen.getByRole('button', { name: 'Tea, from RM 8.00, 1 in the cart' })
    expect(within(noPhoto).getByTestId('qty-badge').textContent).toBe('1')
  })
  it('a sold-out row is muted, disabled and says Sold out with the price', () => {
    render(<MenuList {...base} />)
    const row = screen.getByRole('button', { name: 'Cake, RM 12.00, sold out' }) as HTMLButtonElement
    expect(row.disabled).toBe(true)
    expect(row.className).toContain('opacity-50')
    expect(within(row).getByText('Sold out · RM 12.00')).toBeTruthy()
  })
  it('marks Popular products with the pill on its own line, outside the name', () => {
    render(<MenuList {...base} popularIds={new Set(['latte'])} />)
    const row = screen.getByRole('button', { name: 'Latte, RM 12.00, Popular' })
    expect(within(row).getByText('Popular')).toBeTruthy()
    expect(within(row).getByText('Latte').contains(within(row).getByText('Popular'))).toBe(false)
    expect(screen.getByRole('button', { name: /Tea/ }).textContent).not.toContain('Popular')
  })
  it('a tap opens the product', () => {
    const onOpen = vi.fn()
    render(<MenuList {...base} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: /Latte/ }))
    expect(onOpen).toHaveBeenCalledWith(latte)
  })
})
