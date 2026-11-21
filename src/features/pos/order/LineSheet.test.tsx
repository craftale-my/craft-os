// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

describe('LineSheet busy and error (QR table cart)', () => {
  it('while busy, Add is off and says Adding…', () => {
    render(<LineSheet product={latte} busy onCancel={() => {}} onDone={() => {}} />)
    expect((screen.getByRole('button', { name: 'Adding…' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the error it is given', () => {
    render(<LineSheet product={latte} error="Not added — no connection. Tap Add to try again." onCancel={() => {}} onDone={() => {}} />)
    expect(screen.getByRole('alert').textContent).toBe('Not added — no connection. Tap Add to try again.')
  })

  it('confirmLabel Save names the button, and its busy label', () => {
    const one = { ...latte, groups: [] }
    render(<LineSheet product={one} confirmLabel="Save" onCancel={() => {}} onDone={() => {}} />)
    expect(screen.getByRole('button', { name: /^Save · RM 9\.00/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Add/ })).toBeNull()
    cleanup()
    render(<LineSheet product={one} confirmLabel="Save" busy onCancel={() => {}} onDone={() => {}} />)
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeTruthy()
  })
})

describe('LineSheet remark and last orders (W7 spec §2, §3)', () => {
  const tea: PosProduct = {
    id: 'p2', name: 'Tea', description: null, soldOut: false,
    variants: [{ id: 't', name: 'Regular', priceSen: 500, isBase: true }], groups: [],
  }
  it('a Remark (optional) field, up to 120 characters, goes into the line', () => {
    const onDone = vi.fn()
    render(<LineSheet product={tea} onCancel={() => {}} onDone={onDone} />)
    const box = screen.getByLabelText('Remark (optional)') as HTMLInputElement
    expect(box.maxLength).toBe(120)
    fireEvent.change(box, { target: { value: 'less sweet' } })
    fireEvent.click(screen.getByRole('button', { name: /^Add/ }))
    expect(onDone).toHaveBeenCalledWith({ productId: 'p2', variantId: 't', qty: 1, note: 'less sweet', optionIds: [] })
  })
  it('editing a line shows its remark', () => {
    render(<LineSheet product={tea} initial={{ productId: 'p2', variantId: 't', qty: 1, note: 'no sugar', optionIds: [] }}
      confirmLabel="Save" onCancel={() => {}} onDone={() => {}} />)
    expect((screen.getByLabelText('Remark (optional)') as HTMLInputElement).value).toBe('no sugar')
  })
  it('past the last-order time: Add is off and the sentence shows', () => {
    render(<LineSheet product={tea} closed="Last orders were at 21:30. Ordering opens again at 09:00." onCancel={() => {}} onDone={() => {}} />)
    expect((screen.getByRole('button', { name: /^Add/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('alert').textContent).toBe('Last orders were at 21:30. Ordering opens again at 09:00.')
  })
})
