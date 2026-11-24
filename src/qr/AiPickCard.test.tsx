// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { PosMenu, PosProduct } from '../features/pos/order/cart'
import { groupCart, type CartLine } from './qrCart'
import AiPickCard from './AiPickCard'
import CartPage from './CartPage'
import Mascot from './Mascot'

afterEach(cleanup)

const cake: PosProduct = { id: 'cake', name: 'Lemon Cake', description: null, soldOut: false, imageUrl: 'https://x/cake.webp',
  variants: [{ id: 'slice', name: 'Slice', priceSen: 1500, isBase: true }], groups: [] }
const latte: PosProduct = { id: 'latte', name: 'Latte', description: null, soldOut: false,
  variants: [{ id: 'hot', name: 'Hot', priceSen: 900, isBase: true }, { id: 'iced', name: 'Iced', priceSen: 1100, isBase: false }], groups: [] }

describe('AiPickCard', () => {
  it('shows the mascot, the AI Pick pill, the line, the product with its price, and Add', () => {
    render(<AiPickCard product={cake} sentence="Something to nibble with that? Try Lemon Cake." onAdd={() => {}} onOpen={() => {}} onHide={() => {}} />)
    const card = screen.getByRole('region', { name: 'AI Pick' })
    expect(within(card).getByTestId('mascot-pick')).toBeTruthy()
    expect(card.textContent).toContain('Something to nibble with that? Try Lemon Cake.')
    expect(card.textContent).toContain('Lemon Cake')
    expect(card.textContent).toContain('RM 15.00')
    expect(card.querySelector('img')?.getAttribute('src')).toBe('https://x/cake.webp')
    expect(within(card).getByRole('button', { name: 'Add Lemon Cake' })).toBeTruthy()
  })
  it('Add adds a product without choices', () => {
    const onAdd = vi.fn(), onOpen = vi.fn()
    render(<AiPickCard product={cake} sentence="s" onAdd={onAdd} onOpen={onOpen} onHide={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add Lemon Cake' }))
    expect(onAdd).toHaveBeenCalledWith(cake)
    expect(onOpen).not.toHaveBeenCalled()
  })
  it('Add on a product with a choice opens its item page', () => {
    const onAdd = vi.fn(), onOpen = vi.fn()
    render(<AiPickCard product={latte} sentence="s" onAdd={onAdd} onOpen={onOpen} onHide={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add Latte' }))
    expect(onOpen).toHaveBeenCalledWith(latte)
    expect(onAdd).not.toHaveBeenCalled()
  })
  it('the photo opens the item page; ✕ hides the card; busy turns Add off', () => {
    const onOpen = vi.fn(), onHide = vi.fn()
    render(<AiPickCard product={cake} sentence="s" busy onAdd={() => {}} onOpen={onOpen} onHide={onHide} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Lemon Cake' }))
    expect(onOpen).toHaveBeenCalledWith(cake)
    fireEvent.click(screen.getByRole('button', { name: 'Hide AI Pick' }))
    expect(onHide).toHaveBeenCalled()
    expect((screen.getByRole('button', { name: 'Add Lemon Cake' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('Mascot', () => {
  it.each(['hello', 'pick', 'sleepy', 'cheer'] as const)('%s is a decorative inline SVG of the given size', (pose) => {
    render(<Mascot pose={pose} size={48} />)
    const svg = screen.getByTestId(`mascot-${pose}`)
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('viewBox')).toBe('0 0 96 96')
    expect(svg.getAttribute('width')).toBe('48')
    expect(svg.getAttribute('class')).toContain('motion-safe:')
  })
})

describe('CartPage with an AI Pick', () => {
  const menu: PosMenu = { categories: [{ name: 'All', products: [latte, cake] }] }
  const line: CartLine = { id: '1', guestId: 'me', guestLabel: 'Eric', guestAvatar: 'a1', productId: 'latte', variantId: 'hot', qty: 1, note: null, optionIds: [] }
  const tea: PosProduct = { ...cake, id: 'tea', name: 'Tea', imageUrl: null }
  type Props = Parameters<typeof CartPage>[0]
  const make = (over: Partial<Props> = {}): Props => {
    const { mine, others } = groupCart([line], 'me')
    return {
      menu, me: { name: 'Eric', avatar: 'a1' }, mine, others, pairs: [cake, tea], subtotalSen: 900, sendable: true, status: 'ready', error: null,
      aiPick: { product: cake, sentence: 'Try Lemon Cake.' }, onAiAdd: () => {}, onAiHide: () => {},
      onBack: () => {}, onEdit: () => {}, onRemove: () => {}, onQty: async () => {}, onOpenProduct: () => {}, onPlace: () => {}, ...over,
    }
  }
  it('sits between the lines and Goes well with, whose strip drops the picked product', () => {
    render(<CartPage {...make()} />)
    const card = screen.getByRole('region', { name: 'AI Pick' })
    const pairs = screen.getByRole('region', { name: 'Goes well with your order' })
    expect(card.compareDocumentPosition(pairs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Your items' }).compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(pairs.textContent).toContain('Tea')
    expect(pairs.textContent).not.toContain('Lemon Cake')
  })
  it('Add calls onAiAdd; ✕ calls onAiHide', () => {
    const onAiAdd = vi.fn(), onAiHide = vi.fn()
    render(<CartPage {...make({ onAiAdd, onAiHide })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add Lemon Cake' }))
    expect(onAiAdd).toHaveBeenCalledWith(cake)
    fireEvent.click(screen.getByRole('button', { name: 'Hide AI Pick' }))
    expect(onAiHide).toHaveBeenCalled()
  })
  it('is not shown past last order or offline; the strip then keeps every pairing', () => {
    render(<CartPage {...make({ closed: 'Last order was 21:30.' })} />)
    expect(screen.queryByRole('region', { name: 'AI Pick' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Goes well with your order' }).textContent).toContain('Lemon Cake')
    cleanup()
    render(<CartPage {...make({ status: 'offline' })} />)
    expect(screen.queryByRole('region', { name: 'AI Pick' })).toBeNull()
  })
  it('not shown without a pick', () => {
    render(<CartPage {...make({ aiPick: null })} />)
    expect(screen.queryByRole('region', { name: 'AI Pick' })).toBeNull()
  })
  it('the empty cart shows the sleepy mascot above its sentence', () => {
    render(<CartPage {...make({ mine: [], others: [] })} />)
    expect(screen.getByTestId('mascot-sleepy')).toBeTruthy()
    expect(screen.getByText('Your cart is empty.')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'AI Pick' })).toBeNull()
  })
})
