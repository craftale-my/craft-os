// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { RosterReply } from './roster'

const api = vi.hoisted(() => ({ startSession: vi.fn() }))
vi.mock('./sessionApi', () => api)

import LockScreen from './LockScreen'

const roster = (o: Partial<RosterReply['outlet']> = {}): RosterReply => ({
  device: { id: 'd1', name: 'Counter 1', prints: true },
  outlet: { id: 'b1', name: 'Craft Cafe Kepong', kind: 'branch', opensOn: null, closesOn: null, isActive: true, open: true, ...o },
  idleLockMinutes: 10,
  session: null,
  staff: [{ id: 's1', name: 'Aina', hasPin: true }, { id: 's2', name: 'Ben', hasPin: false }],
})

const typePin = (digits: string) => { for (const d of digits) fireEvent.click(screen.getByRole('button', { name: d })) }

beforeEach(() => api.startSession.mockReset())
afterEach(cleanup)

describe('LockScreen', () => {
  it('shows the outlet, the device and the roster; a name with no PIN is greyed with the note', () => {
    render(<LockScreen roster={roster()} note={null} offline={false} loadError={null} onSignedIn={vi.fn()} onRefresh={vi.fn()} />)
    expect(screen.getByText('Craft Cafe Kepong')).toBeTruthy()
    expect(screen.getByText('Counter 1')).toBeTruthy()
    expect((screen.getByRole('button', { name: /Ben/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Set a PIN in Craft OS first')).toBeTruthy()
  })

  it('a closed outlet shows why and nobody to tap', () => {
    render(<LockScreen roster={roster({ kind: 'popup', opensOn: '2020-01-01', closesOn: '2020-01-31', open: false })} note={null}
      offline={false} loadError={null} onSignedIn={vi.fn()} onRefresh={vi.fn()} />)
    expect(screen.getByText('This outlet closed on 31 Jan 2020.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Aina/ })).toBeNull()
  })

  it('a wrong PIN keeps the keypad open with the tries left', async () => {
    api.startSession.mockResolvedValue({ ok: false, code: 'wrong_pin', error: 'Wrong PIN · 4 tries left' })
    render(<LockScreen roster={roster()} note={null} offline={false} loadError={null} onSignedIn={vi.fn()} onRefresh={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Aina/ }))
    typePin('1234')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(screen.getByText('Wrong PIN · 4 tries left')).toBeTruthy())
    expect(api.startSession).toHaveBeenCalledWith('s1', '1234')
    expect(screen.getByRole('dialog', { name: 'PIN for Aina' })).toBeTruthy()
  })

  it('too many tries closes the keypad and says so on the lock screen', async () => {
    api.startSession.mockResolvedValue({ ok: false, code: 'pin_locked', error: 'Too many tries. Try again in 10 minutes.' })
    render(<LockScreen roster={roster()} note={null} offline={false} loadError={null} onSignedIn={vi.fn()} onRefresh={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Aina/ }))
    typePin('9999')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Too many tries. Try again in 10 minutes.'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a right PIN signs in; Sign in waits for four digits', async () => {
    api.startSession.mockResolvedValue({ ok: true, sessionId: 'x', staff: { id: 's1', name: 'Aina' } })
    const onSignedIn = vi.fn()
    render(<LockScreen roster={roster()} note={null} offline={false} loadError={null} onSignedIn={onSignedIn} onRefresh={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Aina/ }))
    typePin('123')
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(true)
    typePin('4')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))
  })

  it('the keypad stays up while a PIN is checked; a late reply for a closed keypad shows nothing', async () => {
    let reply!: (v: unknown) => void
    api.startSession.mockReturnValue(new Promise((r) => { reply = r }))
    const r = roster()
    r.staff.push({ id: 's3', name: 'Cara', hasPin: true })
    render(<LockScreen roster={r} note={null} offline={false} loadError={null} onSignedIn={vi.fn()} onRefresh={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Aina/ }))
    typePin('1234')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    fireEvent.click(screen.getByRole('dialog').parentElement as HTMLElement)          // the backdrop, while busy
    expect(screen.getByRole('dialog', { name: 'PIN for Aina' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Cara/ }))                     // Aina's keypad is gone
    expect(screen.getByRole('dialog', { name: 'PIN for Cara' })).toBeTruthy()
    await act(async () => { reply({ ok: false, code: 'wrong_pin', error: 'Wrong PIN · 4 tries left' }) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'PIN for Cara' })).toBeTruthy()
  })

  it('shows why the last session ended, and the offline note', () => {
    render(<LockScreen roster={roster()} note="Your access here has changed. Ask your manager." offline loadError={null}
      onSignedIn={vi.fn()} onRefresh={vi.fn()} />)
    expect(screen.getByText('Your access here has changed. Ask your manager.')).toBeTruthy()
    expect(screen.getByText("You're offline — nobody can sign in until the network is back.")).toBeTruthy()
  })
})
