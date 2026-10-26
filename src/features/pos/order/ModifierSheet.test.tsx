// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ModifierSheet from './ModifierSheet'
import type { PosProduct } from './cart'

afterEach(cleanup)

const latte: PosProduct = {
  id: 'p1', name: 'Latte', description: null, soldOut: false,
  variants: [{ id: 'hot', name: 'Hot', priceSen: 900, isBase: true }, { id: 'cold', name: 'Cold', priceSen: 1100, isBase: false }],
  groups: [
    { id: 'milk', name: 'Milk', min: 1, max: 1, options: [
      { id: 'oat', name: 'Oat', priceDeltaSen: 200, isDefault: false, available: true },
      { id: 'soy', name: 'Soy', priceDeltaSen: 0, isDefault: false, available: false },
    ] },
    { id: 'extra', name: 'Extras', min: 0, max: 2, options: [{ id: 'shot', name: 'Extra shot', priceDeltaSen: 300, isDefault: false, available: true }] },
  ],
}

describe('ModifierSheet', () => {
  it('shows a red SELECT badge on required groups and greys a sold-out option', () => {
    render(<ModifierSheet product={latte} onCancel={() => {}} onDone={() => {}} />)
    expect(screen.getAllByText('SELECT 1')).toHaveLength(2)           // the variant and Milk
    expect(screen.getByText('UP TO 2')).toBeTruthy()
    expect((screen.getByRole('button', { name: /Soy/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('Confirm with a required group missing says what is missing; once chosen it answers the line', () => {
    const onDone = vi.fn()
    render(<ModifierSheet product={latte} onCancel={() => {}} onDone={onDone} />)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm · RM 9.00' }))
    expect(onDone).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('Choose at least 1 for Latte: Milk')
    fireEvent.click(screen.getByRole('button', { name: /Cold/ }))
    fireEvent.click(screen.getByRole('button', { name: /Oat/ }))
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm · RM 26.00' }))
    expect(onDone).toHaveBeenCalledWith({ productId: 'p1', variantId: 'cold', qty: 2, note: null, optionIds: ['oat'] })
  })

  it('a draft being edited offers Remove', () => {
    const onRemove = vi.fn()
    render(<ModifierSheet product={latte} initial={{ productId: 'p1', variantId: 'hot', qty: 1, note: null, optionIds: ['oat'] }}
      onCancel={() => {}} onDone={() => {}} onRemove={onRemove} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onRemove).toHaveBeenCalledTimes(1)
  })
})
