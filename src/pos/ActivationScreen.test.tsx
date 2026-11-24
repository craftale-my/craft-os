// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { newQueuedOrder } from '../features/pos/offline/orderQueue'

const api = vi.hoisted(() => ({ requestActivation: vi.fn(), pollActivation: vi.fn(), signInDevice: vi.fn() }))
vi.mock('./sessionApi', () => api)

import ActivationScreen from './ActivationScreen'

const pending = { code: 'K7M-2QX', secret: 'sec', expiresAt: '2026-10-31T10:00:00Z', name: 'Counter 1' }

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  for (const f of Object.values(api)) f.mockReset()
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('ActivationScreen', () => {
  it('POS → shows the code, polls every 5 s, and signs in as the device when approved', async () => {
    api.requestActivation.mockResolvedValue(pending)
    api.pollActivation.mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'approved', deviceId: 'd', email: 'device-1@devices.invalid', password: 'pw', branchId: 'b', kind: 'pos', name: 'Counter 1' })
    api.signInDevice.mockResolvedValue(undefined)
    const onActivated = vi.fn()
    render(<ActivationScreen start={{ kind: 'choose' }} unsent={[]} names={new Map()} onActivated={onActivated} />)
    fireEvent.change(screen.getByPlaceholderText('e.g. Counter 1'), { target: { value: 'Counter 1' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'POS' })) })
    expect(screen.getByTestId('activation-code').textContent).toBe('K7M-2QX')
    expect(api.requestActivation).toHaveBeenCalledWith('Counter 1', expect.any(String))
    expect(JSON.parse(localStorage.getItem('craft-pos-activation') ?? 'null')).toEqual(pending)
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(api.pollActivation).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(api.signInDevice).toHaveBeenCalledWith('device-1@devices.invalid', 'pw')
    expect(onActivated).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('craft-pos-activation')).toBeNull()
  })

  it('a reply that never arrived: the next poll says unknown, and HQ is asked to activate again', async () => {
    api.pollActivation.mockResolvedValue({ status: 'unknown' })
    render(<ActivationScreen start={{ kind: 'waiting', pending, note: null }} unsent={[]} names={new Map()} onActivated={vi.fn()} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(screen.getByText(/ask HQ to unpair this device in Devices and approve a new request/)).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(api.pollActivation).toHaveBeenCalledTimes(1)                     // polling stopped
    fireEvent.click(screen.getByRole('button', { name: 'Request again' }))
    expect(screen.getByRole('button', { name: 'POS' })).toBeTruthy()
  })

  it('a failed poll keeps waiting with a note', async () => {
    api.pollActivation.mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValue({ status: 'pending' })
    render(<ActivationScreen start={{ kind: 'waiting', pending, note: null }} unsent={[]} names={new Map()} onActivated={vi.fn()} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(screen.getByText(/Can't reach the server — still trying/)).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(api.pollActivation).toHaveBeenCalledTimes(2)
  })

  it('unpaired: says so and lists the orders that were not sent', () => {
    const order = newQueuedOrder('takeaway', null, null, [{ productId: 'p1', variantId: 'v1', qty: 2, note: 'less ice', optionIds: [] }], 1, 'a')
    render(<ActivationScreen start={{ kind: 'ended', reason: 'unpaired' }} unsent={[order]} names={new Map([['p1', 'Iced Latte']])} onActivated={vi.fn()} />)
    expect(screen.getByText('This device was unpaired. Ask HQ to activate it again.')).toBeTruthy()
    expect(screen.getByText('1 order was not sent')).toBeTruthy()
    expect(screen.getByText('2 × Iced Latte — less ice')).toBeTruthy()
  })

  it('a network failure signing in tries the same credentials again, and keeps the request until it works', async () => {
    api.pollActivation.mockResolvedValue({ status: 'approved', deviceId: 'd', email: 'device-1@devices.invalid', password: 'pw', branchId: 'b', kind: 'pos', name: 'Counter 1' })
    const blip = Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError' })
    api.signInDevice.mockRejectedValueOnce(blip).mockRejectedValueOnce(blip).mockResolvedValue(undefined)
    localStorage.setItem('craft-pos-activation', JSON.stringify(pending))
    const onActivated = vi.fn()
    render(<ActivationScreen start={{ kind: 'waiting', pending, note: null }} unsent={[]} names={new Map()} onActivated={onActivated} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(api.signInDevice).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(api.signInDevice).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Approved — signing in… (retrying)')).toBeTruthy()
    expect(localStorage.getItem('craft-pos-activation')).not.toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(4_999) })
    expect(api.signInDevice).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(api.signInDevice).toHaveBeenCalledTimes(3)
    expect(api.signInDevice).toHaveBeenLastCalledWith('device-1@devices.invalid', 'pw')
    expect(onActivated).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('craft-pos-activation')).toBeNull()
  })

  it('a refused sign-in stops with the message', async () => {
    api.signInDevice.mockRejectedValue(Object.assign(new Error('Invalid login credentials'), { name: 'AuthApiError' }))
    render(<ActivationScreen start={{ kind: 'signing_in', email: 'e', password: 'p' }} unsent={[]} names={new Map()} onActivated={vi.fn()} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText(/Could not sign in as this device \(Invalid login credentials\)/)).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(api.signInDevice).toHaveBeenCalledTimes(1)
  })

  it('on iPad in Safari: asks to add it to the Home Screen first, and still allows activating', () => {
    const ua = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')
    try {
      render(<ActivationScreen start={{ kind: 'choose' }} unsent={[]} names={new Map()} onActivated={vi.fn()} />)
      expect(screen.getByText('On iPad, add Craft POS to the Home Screen first (Share → Add to Home Screen), then activate from the icon.')).toBeTruthy()
      expect((screen.getByRole('button', { name: 'POS' }) as HTMLButtonElement).disabled).toBe(false)
    } finally { ua.mockRestore() }
  })

  it('not on iPad: no Home Screen note', () => {
    render(<ActivationScreen start={{ kind: 'choose' }} unsent={[]} names={new Map()} onActivated={vi.fn()} />)
    expect(screen.queryByText(/add Craft POS to the Home Screen/)).toBeNull()
  })
})
