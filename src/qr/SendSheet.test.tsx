// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PosMenu } from '../features/pos/order/cart'
import type { CartLine, GuestGroup } from './qrCart'
import SendSheet from './SendSheet'

afterEach(cleanup)

const menu: PosMenu = { categories: [{ name: 'Drinks', products: [
  { id: 'latte', name: 'Latte', description: null, soldOut: false,
    variants: [{ id: 'hot', name: 'Hot', priceSen: 900, isBase: true }], groups: [] },
] }] }
const line = (id: string, qty: number): CartLine =>
  ({ id, guestId: 'g', guestLabel: 'x', guestAvatar: 'a1', productId: 'latte', variantId: 'hot', qty, note: null, optionIds: [] })
const groups: GuestGroup[] = [
  { guestId: 'me', label: 'Eric', avatar: 'a1', isMe: true, lines: [line('1', 1)] },
  { guestId: 'mei', label: 'Mei', avatar: 'a3', isMe: false, lines: [line('2', 2)] },
]
type Props = Parameters<typeof SendSheet>[0]
const base: Props = {
  groups, menu, totalSen: 2700, needsPax: false, pax: '', onPax: () => {}, sending: false, message: null, error: null,
  onSend: () => {}, onCancel: () => {},
}

describe('SendSheet', () => {
  it('lists the table\'s items by guest with the subtotal', () => {
    render(<SendSheet {...base} />)
    expect(screen.getByRole('dialog', { name: 'Has everyone ordered?' })).toBeTruthy()
    expect(screen.getByText(/Eric/).textContent).toContain('(you)')
    expect(screen.getByText(/Mei/)).toBeTruthy()
    expect(screen.getByText('1 × Latte')).toBeTruthy()
    expect(screen.getByText('2 × Latte')).toBeTruthy()
    expect(screen.getByText('RM 27.00')).toBeTruthy()
    expect(screen.queryByLabelText(/How many people/)).toBeNull()
  })

  it('sends and cancels', () => {
    const onSend = vi.fn(), onCancel = vi.fn()
    render(<SendSheet {...base} onSend={onSend} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: 'Send order for the table' }))
    expect(onSend).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Not yet' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('asks the pax when the table needs it', () => {
    const onPax = vi.fn()
    render(<SendSheet {...base} needsPax pax="2" onPax={onPax} />)
    const input = screen.getByLabelText(/How many people/) as HTMLInputElement
    expect(input.value).toBe('2')
    fireEvent.change(input, { target: { value: '3' } })
    expect(onPax).toHaveBeenCalledWith('3')
  })

  it('while sending, both buttons are off', () => {
    render(<SendSheet {...base} sending />)
    expect((screen.getByRole('button', { name: 'Sending…' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Not yet' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the changed notice and an error', () => {
    render(<SendSheet {...base} message="The order changed — please check again." error="Not sent: Sold out: Latte" />)
    expect(screen.getByRole('status').textContent).toBe('The order changed — please check again.')
    expect(screen.getByRole('alert').textContent).toBe('Not sent: Sold out: Latte')
  })
})
