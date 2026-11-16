// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import LineSheet from './LineSheet'
import type { PosProduct } from './cart'

afterEach(cleanup)

const latte: PosProduct = {
  id: 'p1', name: 'Latte', description: null, soldOut: false,
  variants: [{ id: 'hot', name: 'Hot', priceSen: 900, isBase: true }],
  groups: [{ id: 'milk', name: 'Milk', min: 1, max: 1, options: [
    { id: 'oat', name: 'Oat', priceDeltaSen: 200, isDefault: false, available: true },
    { id: 'soy', name: 'Soy', priceDeltaSen: 0, isDefault: false, available: false },
    { id: 'dairy', name: 'Dairy', priceDeltaSen: 0, isDefault: false, available: true },
  ] }],
}

describe('LineSheet Most picked', () => {
  it('marks the most picked option and chooses nothing for the guest', () => {
    render(<LineSheet product={latte} mostPicked={{ milk: 'oat' }} onCancel={() => {}} onDone={() => {}} />)
    expect(screen.getByRole('button', { name: /Oat/ }).textContent).toContain('Most picked')
    expect(screen.getAllByText('Most picked')).toHaveLength(1)
    // Milk is still to be chosen: Add stays off until the guest picks one
    expect((screen.getByRole('button', { name: /^Add/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('no pill on a sold-out option, and none without picks', () => {
    render(<LineSheet product={latte} mostPicked={{ milk: 'soy' }} onCancel={() => {}} onDone={() => {}} />)
    expect(screen.queryByText('Most picked')).toBeNull()
    cleanup()
    render(<LineSheet product={latte} onCancel={() => {}} onDone={() => {}} />)
    expect(screen.queryByText('Most picked')).toBeNull()
  })
})
