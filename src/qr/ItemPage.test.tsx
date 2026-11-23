// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { PosProduct } from '../features/pos/order/cart'
import ItemPage from './ItemPage'

afterEach(cleanup)

const pasta: PosProduct = {
  id: 'pasta', name: 'Aglio Olio', description: 'Garlic, chilli and olive oil.', soldOut: false, imageUrl: 'https://x/pasta.jpg',
  variants: [{ id: 'reg', name: 'Regular', priceSen: 1500, isBase: true }, { id: 'lg', name: 'Large', priceSen: 1900, isBase: false }],
  groups: [
    { id: 'prot', name: 'Protein', min: 1, max: 1, options: [
      { id: 'chk', name: 'Chicken', priceDeltaSen: 0, isDefault: false, available: true },
      { id: 'prawn', name: 'Prawn', priceDeltaSen: 300, isDefault: false, available: true },
      { id: 'beef', name: 'Beef', priceDeltaSen: 400, isDefault: false, available: false },
    ] },
    { id: 'top', name: 'Toppings', min: 0, max: 2, options: [
      { id: 'egg', name: 'Egg', priceDeltaSen: 200, isDefault: false, available: true },
      { id: 'chs', name: 'Cheese', priceDeltaSen: 200, isDefault: false, available: true },
      { id: 'mush', name: 'Mushroom', priceDeltaSen: 150, isDefault: false, available: true },
    ] },
  ],
}
const tea: PosProduct = { id: 'tea', name: 'Iced Tea', description: null, soldOut: false, imageUrl: 'https://x/tea.jpg',
  variants: [{ id: 't', name: 'Regular', priceSen: 400, isBase: true }], groups: [] }
const cookie: PosProduct = { id: 'cookie', name: 'Cookie', description: null, soldOut: false,
  variants: [{ id: 'c', name: 'Regular', priceSen: 600, isBase: true }], groups: [] }

type Props = Parameters<typeof ItemPage>[0]
const make = (over: Partial<Props> = {}): Props => ({
  product: pasta, from: 'menu', pairs: [], busy: false, error: null, closed: null, onBack: () => {}, onAdd: () => {}, ...over,
})
const addButton = () => screen.getByRole('button', { name: /^(Add|Save|Adding|Saving)/ }) as HTMLButtonElement

describe('ItemPage top', () => {
  it('a photo across the top with a round back button on it, then the name and the full description', () => {
    const onBack = vi.fn()
    const { container } = render(<ItemPage {...make({ onBack })} />)
    const img = container.querySelector('img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('https://x/pasta.jpg')
    const back = screen.getByRole('button', { name: 'Back to menu' })
    expect(back.className).toContain('rounded-full')
    expect(back.parentElement?.contains(img)).toBe(true)
    expect(screen.getByRole('heading', { name: 'Aglio Olio', level: 1 })).toBeTruthy()
    expect(screen.getByText('Garlic, chilli and olive oil.')).toBeTruthy()
    fireEvent.click(back)
    expect(onBack).toHaveBeenCalled()
  })
  it('without a photo: a plain row with the back button; opened from the cart it says Back to cart', () => {
    const { container } = render(<ItemPage {...make({ product: { ...tea, imageUrl: null }, from: 'cart' })} />)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByRole('button', { name: 'Back to cart' })).toBeTruthy()
  })
})

describe('ItemPage groups', () => {
  it('sizes first as radios with their prices, then each group with its rule and a Selected badge', () => {
    render(<ItemPage {...make()} />)
    const size = screen.getByRole('group', { name: 'Size' })
    expect(within(size).getByText('Required · choose 1')).toBeTruthy()
    expect(within(size).getAllByRole('radio')).toHaveLength(2)
    expect(within(size).getByText('RM 19.00')).toBeTruthy()
    expect(within(size).getByText('Selected 1')).toBeTruthy()
    const prot = screen.getByRole('group', { name: 'Protein' })
    expect(within(prot).getByText('Required · choose 1')).toBeTruthy()
    expect(within(prot).getAllByRole('radio')).toHaveLength(3)
    expect(within(prot).getByText('Selected 0')).toBeTruthy()
    expect(within(prot).getByText('+RM 3.00')).toBeTruthy()
    const top = screen.getByRole('group', { name: 'Toppings' })
    expect(within(top).getByText('Optional · up to 2')).toBeTruthy()
    expect(within(top).getAllByRole('checkbox')).toHaveLength(3)
  })
  it('a range rule reads choose 1–2', () => {
    render(<ItemPage {...make({ product: { ...pasta, groups: [{ ...pasta.groups[1], min: 1 }] } })} />)
    expect(screen.getByText('Required · choose 1–2')).toBeTruthy()
  })
  it('a sold-out option is disabled and says so', () => {
    render(<ItemPage {...make()} />)
    const beef = screen.getByRole('radio', { name: /Beef/ }) as HTMLInputElement
    expect(beef.disabled).toBe(true)
    expect(screen.getByText(/\(sold out\)/)).toBeTruthy()
  })
  it('ticking options counts them; a one-of group swaps; a several-of group stops at nothing but validates', () => {
    render(<ItemPage {...make()} />)
    fireEvent.click(screen.getByRole('radio', { name: /Chicken/ }))
    fireEvent.click(screen.getByRole('radio', { name: /Prawn/ }))
    expect((screen.getByRole('radio', { name: /Prawn/ }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: /Chicken/ }) as HTMLInputElement).checked).toBe(false)
    expect(within(screen.getByRole('group', { name: 'Protein' })).getByText('Selected 1')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: /Egg/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Cheese/ }))
    expect(within(screen.getByRole('group', { name: 'Toppings' })).getByText('Selected 2')).toBeTruthy()
  })
  it('marks the Most picked option', () => {
    render(<ItemPage {...make({ mostPicked: { prot: 'prawn' } })} />)
    expect(screen.getByRole('radio', { name: /Prawn/ }).closest('label')?.textContent).toContain('Most picked')
  })
})

describe('ItemPage button', () => {
  it('is off until the choices are valid; the reason shows once the guest touched something', () => {
    render(<ItemPage {...make()} />)
    expect(addButton().disabled).toBe(true)
    expect(screen.queryByText(/Choose at least 1/)).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Large RM 19.00' }))
    expect(screen.getByText('Choose at least 1 for Aglio Olio: Protein')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /Chicken/ }))
    expect(addButton().disabled).toBe(false)
  })
  it('says Add n to cart with the amount, following the quantity stepper', () => {
    render(<ItemPage {...make({ product: tea })} />)
    expect(addButton().textContent).toBe('Add 1 to cart · RM 4.00')
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.getByTestId('qty').textContent).toBe('3')
    expect(addButton().textContent).toBe('Add 3 to cart · RM 12.00')
    fireEvent.click(screen.getByRole('button', { name: 'Fewer' }))
    expect(addButton().textContent).toBe('Add 2 to cart · RM 8.00')
  })
  it('the remark goes into the line', () => {
    const onAdd = vi.fn()
    render(<ItemPage {...make({ product: tea, onAdd })} />)
    const box = screen.getByLabelText('Remark (optional)') as HTMLInputElement
    expect(box.maxLength).toBe(120)
    fireEvent.change(box, { target: { value: 'less ice' } })
    fireEvent.click(addButton())
    expect(onAdd).toHaveBeenCalledWith({ productId: 'tea', variantId: 't', qty: 1, note: 'less ice', optionIds: [] }, [])
  })
  it('editing a line: its values, Save with the amount, no pairings', () => {
    render(<ItemPage {...make({ product: tea, pairs: [cookie], initial: { productId: 'tea', variantId: 't', qty: 2, note: 'no sugar', optionIds: [] } })} />)
    expect(addButton().textContent).toBe('Save · RM 8.00')
    expect((screen.getByLabelText('Remark (optional)') as HTMLInputElement).value).toBe('no sugar')
    expect(screen.queryByRole('group', { name: 'Goes well with' })).toBeNull()
  })
  it('busy: Adding… / Saving…, off', () => {
    render(<ItemPage {...make({ product: tea, busy: true })} />)
    expect(addButton().textContent).toBe('Adding…')
    expect(addButton().disabled).toBe(true)
    cleanup()
    render(<ItemPage {...make({ product: tea, busy: true, initial: { productId: 'tea', variantId: 't', qty: 1, note: null, optionIds: [] } })} />)
    expect(addButton().textContent).toBe('Saving…')
  })
  it('shows the error it is given', () => {
    render(<ItemPage {...make({ product: tea, error: 'Not added — no connection. Tap Add to try again.' })} />)
    expect(screen.getByRole('alert').textContent).toBe('Not added — no connection. Tap Add to try again.')
  })
  it('past the last-order time: Add is off and the sentence shows', () => {
    render(<ItemPage {...make({ product: tea, closed: 'Last orders were at 21:30.' })} />)
    expect(addButton().disabled).toBe(true)
    expect(screen.getByText('Last orders were at 21:30.')).toBeTruthy()
  })
})

describe('ItemPage Goes well with', () => {
  it('lists the pairings as tick rows; ticked ones go with the item and into the amount', () => {
    const onAdd = vi.fn()
    render(<ItemPage {...make({ product: tea, pairs: [cookie, { ...cookie, id: 'c2', name: 'Brownie' }], onAdd })} />)
    const box = screen.getByRole('group', { name: 'Goes well with' })
    expect(within(box).getAllByRole('checkbox')).toHaveLength(2)
    expect(within(box).getAllByText('+RM 6.00')).toHaveLength(2)
    fireEvent.click(within(box).getByRole('checkbox', { name: /Cookie/ }))
    expect(addButton().textContent).toBe('Add 1 to cart · RM 10.00')
    fireEvent.click(addButton())
    expect(onAdd).toHaveBeenCalledWith({ productId: 'tea', variantId: 't', qty: 1, note: null, optionIds: [] }, [cookie])
  })
  it('is hidden when there are none', () => {
    render(<ItemPage {...make({ product: tea })} />)
    expect(screen.queryByText('Goes well with')).toBeNull()
  })
})
