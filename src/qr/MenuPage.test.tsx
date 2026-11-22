// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { PosProduct } from '../features/pos/order/cart'
import MenuPage, { MENU_VIEW_KEY } from './MenuPage'

afterEach(cleanup)
beforeEach(() => { try { localStorage.clear() } catch { /* none */ } })

const prod = (id: string, name: string, over: Partial<PosProduct> = {}): PosProduct => ({
  id, name, description: `about ${name}`, soldOut: false,
  variants: [{ id: 'v', name: 'V', priceSen: 1200, isBase: true }], groups: [], ...over,
})
const latte = prod('latte', 'Latte'), tea = prod('tea', 'Tea'), cake = prod('cake', 'Cake')

type Props = Parameters<typeof MenuPage>[0]
const make = (over: Partial<Props> = {}): Props => ({
  tableLabel: 'T3', guest: { id: 'g', name: 'Eric', avatar: 'a1' }, onGuest: () => {}, closed: null, placed: false,
  sections: [{ name: 'Popular', products: [latte], popular: true }, { name: 'Coffee', products: [latte] }, { name: 'Cakes', products: [tea, cake] }],
  popularIds: new Set(['latte']), units: new Map(), onOpen: () => {},
  cartLines: 0, subtotalSen: 0, status: 'ready', ordered: false, onCart: () => {}, onOrders: () => {}, ...over,
})

describe('MenuPage', () => {
  it('shows the shop name, the table, the guest chip and the Menu heading, in that order', () => {
    const onGuest = vi.fn()
    render(<MenuPage {...make({ onGuest })} />)
    const text = document.body.textContent ?? ''
    expect(screen.getByRole('heading', { name: 'Craft Cafe', level: 1 })).toBeTruthy()
    expect(screen.getByText('Table T3')).toBeTruthy()
    expect(text.indexOf('Craft Cafe')).toBeLessThan(text.indexOf('Table T3'))
    expect(text.indexOf('Table T3')).toBeLessThan(text.indexOf('Menu'))
    fireEvent.click(screen.getByRole('button', { name: /You are Eric/ }))
    expect(onGuest).toHaveBeenCalled()
  })
  it('every category is a section with its heading, in order; Popular first without its pill inside', () => {
    render(<MenuPage {...make()} />)
    const heads = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(heads).toEqual(['Menu', 'Popular', 'Coffee', 'Cakes'])
    const popular = screen.getByRole('region', { name: 'Popular' })
    expect(within(popular).getByRole('button', { name: 'Latte, RM 12.00' })).toBeTruthy()
    const coffee = screen.getByRole('region', { name: 'Coffee' })
    expect(within(coffee).getByRole('button', { name: 'Latte, RM 12.00, Popular' })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Categories' })).toBeTruthy()
  })
  it('the view switch defaults to grid, switches to list and is remembered', () => {
    render(<MenuPage {...make()} />)
    const grid = screen.getByRole('button', { name: 'Grid view' }), list = screen.getByRole('button', { name: 'List view' })
    expect(grid.getAttribute('aria-pressed')).toBe('true')
    expect(list.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('region', { name: 'Coffee' }).querySelector('.grid-cols-2')).toBeTruthy()
    fireEvent.click(list)
    expect(list.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('region', { name: 'Coffee' }).querySelector('.grid-cols-2')).toBeNull()
    expect(localStorage.getItem(MENU_VIEW_KEY)).toBe('list')
    cleanup()
    render(<MenuPage {...make()} />)
    expect(screen.getByRole('button', { name: 'List view' }).getAttribute('aria-pressed')).toBe('true')
  })
  it('shows the last-order sentence and the Order placed banner', () => {
    render(<MenuPage {...make({ closed: 'Last orders were at 21:30.', placed: true })} />)
    expect(screen.getByText('Last orders were at 21:30.')).toBeTruthy()
    expect(screen.getByText(/Order placed/)).toBeTruthy()
  })
})

describe('MenuPage bottom bar', () => {
  it('is absent when the cart is empty and nothing was ordered', () => {
    render(<MenuPage {...make()} />)
    expect(screen.queryByRole('button', { name: /Cart/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Orders/ })).toBeNull()
  })
  it('with lines: one wide Cart button with the amount', () => {
    const onCart = vi.fn()
    render(<MenuPage {...make({ cartLines: 2, subtotalSen: 11700, onCart })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cart · RM 117.00' }))
    expect(onCart).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Orders/ })).toBeNull()
  })
  it('once ordered: an Orders button beside it, or alone when the cart is empty', () => {
    const onOrders = vi.fn()
    render(<MenuPage {...make({ cartLines: 1, subtotalSen: 900, ordered: true, onOrders })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Orders' }))
    expect(onOrders).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Cart · RM 9.00' })).toBeTruthy()
    cleanup()
    render(<MenuPage {...make({ ordered: true })} />)
    expect(screen.getByRole('button', { name: 'Orders' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Cart/ })).toBeNull()
  })
  it('offline: the cart button says Reconnecting… and is off', () => {
    render(<MenuPage {...make({ cartLines: 1, subtotalSen: 900, status: 'offline' })} />)
    expect((screen.getByRole('button', { name: 'Reconnecting…' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('the member button: nothing when off, Join & earn points when out, ★ n pts when in, left of the guest chip', () => {
    const onMember = vi.fn()
    const { rerender } = render(<MenuPage {...make({ member: 'off', onMember })} />)
    expect(screen.queryByRole('button', { name: 'Join & earn points' })).toBeNull()
    expect(screen.queryByText(/pts$/)).toBeNull()
    rerender(<MenuPage {...make({ member: 'out', onMember })} />)
    const join = screen.getByRole('button', { name: 'Join & earn points' })
    const chip = screen.getByRole('button', { name: /You are Eric/ })
    expect(join.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(join)
    expect(onMember).toHaveBeenCalledTimes(1)
    rerender(<MenuPage {...make({ member: 'in', memberPoints: 1200, onMember })} />)
    expect(screen.getByText('★ 1,200 pts')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Your points: 1200' }))
    expect(onMember).toHaveBeenCalledTimes(2)
  })
})
