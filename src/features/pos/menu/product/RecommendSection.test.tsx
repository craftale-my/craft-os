// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// The two RPCs are stand-ins: what is tested is the switch's load, save and refusal.
const api = { fetchProductExtras: vi.fn(), setProductRecommended: vi.fn() }
vi.mock('../slotsApi', () => ({
  fetchProductExtras: (...a: unknown[]) => api.fetchProductExtras(...a),
  setProductRecommended: (...a: unknown[]) => api.setProductRecommended(...a),
}))

import RecommendSection from './RecommendSection'

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  api.fetchProductExtras.mockResolvedValue({ imagePath: null, imageUpdatedAt: null, scheduleIds: [], isRecommended: false })
  api.setProductRecommended.mockResolvedValue(null)
})

describe('RecommendSection', () => {
  it('shows the switch with its hint and saves it on its own call', async () => {
    render(<RecommendSection productId="p1" />)
    const sw = await screen.findByRole('switch', { name: 'Recommend on QR menu' })
    expect((sw as HTMLInputElement).checked).toBe(false)
    expect(screen.getByText('Shown under Popular here, and suggested with other items, until sales are enough to choose by themselves.')).toBeTruthy()
    fireEvent.click(sw)
    await waitFor(() => expect(api.setProductRecommended).toHaveBeenCalledWith('p1', true))
    await waitFor(() => expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(true))
    expect(screen.getByRole('status').textContent).toBe('Saved')
  })

  it('a refused save says why and leaves the switch as it was', async () => {
    api.setProductRecommended.mockRejectedValue(new Error('Not allowed to edit the menu'))
    render(<RecommendSection productId="p1" />)
    fireEvent.click(await screen.findByRole('switch', { name: 'Recommend on QR menu' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Not allowed to edit the menu')
    expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(false)
  })
})
