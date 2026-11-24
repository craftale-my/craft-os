// @vitest-environment jsdom
// Craft OS /pos after C3: the till moved to the POS app; the page says where and keeps My PIN.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

// MyPinDialog reaches Supabase through checkoutApi
vi.mock('../checkout/MyPinDialog', () => ({ default: () => <div>My POS PIN dialog</div> }))

import PosPage from './PosPage'

afterEach(cleanup)

describe('PosPage — the POS has moved', () => {
  it('shows the notice, the address as a link and how to activate a tablet', () => {
    render(<PosPage appUrl="https://craft-pos-dev.vercel.app" />)
    expect(screen.getByRole('heading', { name: 'The POS has moved to its own app.' })).toBeTruthy()
    const link = screen.getByRole('link', { name: 'https://craft-pos-dev.vercel.app' })
    expect(link.getAttribute('href')).toBe('https://craft-pos-dev.vercel.app')
    expect(screen.getByText('Activate a tablet: open the address on it and approve it in Devices.')).toBeTruthy()
  })
  it('without an address: the fallback text, no link', () => {
    render(<PosPage appUrl={null} />)
    expect(screen.getByText('Ask HQ for the POS app address.')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })
  it('keeps My PIN', () => {
    render(<PosPage appUrl={null} />)
    expect(screen.getByText('Staff sign in on the tablet with their name and POS PIN.')).toBeTruthy()
    expect(screen.queryByText('My POS PIN dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'My PIN' }))
    expect(screen.getByText('My POS PIN dialog')).toBeTruthy()
  })
})
