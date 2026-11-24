// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import ProductTiles from './ProductTiles'
import type { PosProduct } from './cart'

afterEach(cleanup)

const tile = (id: string, name: string): PosProduct => ({
  id, name, description: null, soldOut: false,
  variants: [{ id: `${id}-v`, name: 'Regular', priceSen: 1000, isBase: true }], groups: [],
})

describe('ProductTiles Popular pill', () => {
  it('marks only the popular products', () => {
    render(<ProductTiles products={[tile('a', 'Latte'), tile('b', 'Mocha')]} windows={{ offsetMs: 0, byProduct: new Map() }}
      now={new Date()} soldOutMode={false} popular={new Set(['a'])} onTap={() => {}} />)
    expect(screen.getAllByText('Popular')).toHaveLength(1)
    expect(screen.getByRole('button', { name: /Latte/ }).textContent).toContain('Popular')
  })
})
