// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import MemberDialog from './MemberDialog'
import type { BillMember } from './billMember'

afterEach(cleanup)

const known: BillMember = { memberId: 'm1', phone: '+60123456789', points: 120 }

type Over = { onAttach?: (p: string) => Promise<BillMember>; onRemove?: () => Promise<void>; status?: 'loading' | 'ok' | 'error' }
function open(current: BillMember | null, over: Over = {}) {
  const onAttach = vi.fn(over.onAttach ?? (async () => known))
  const onRemove = vi.fn(over.onRemove ?? (async () => undefined))
  const onClose = vi.fn()
  const onRetry = vi.fn()
  const el = (status: Over['status'], cur: BillMember | null) => (
    <MemberDialog billNo="261123-001" status={status ?? 'ok'} current={cur} onRetry={onRetry} onAttach={onAttach} onRemove={onRemove} onClose={onClose} />
  )
  const { rerender } = render(el(over.status, current))
  return { onAttach, onRemove, onClose, onRetry, update: (status: Over['status'], cur: BillMember | null) => rerender(el(status, cur)) }
}
const type = (v: string) => fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: v } })
const attach = () => fireEvent.click(screen.getByRole('button', { name: 'Attach' }))

describe('MemberDialog', () => {
  it('a bill without a member: a phone field for the number pad, Attach; the member and points after', async () => {
    const { onAttach, onClose } = open(null)
    expect(screen.getByRole('dialog', { name: 'Member' })).toBeTruthy()
    const input = screen.getByLabelText('Phone number') as HTMLInputElement
    expect(input.getAttribute('inputmode')).toBe('tel')
    type('012-345 6789')
    attach()
    await screen.findByText(/Member \+60 12-345 6789 · 120 points/)
    expect(onAttach).toHaveBeenCalledWith('+60123456789')
    expect(screen.queryByText('New member')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('a number not yet a member: the New member badge', async () => {
    open(null, { onAttach: async () => ({ memberId: 'm2', phone: '+601100000201', points: 0, isNew: true }) })
    type('011-0000 0201')
    attach()
    await screen.findByText('New member')
    expect(screen.getByTestId('member-summary').textContent).toContain('Member +60 11-0000 0201 · 0 points')
  })

  it('an invalid number never reaches the server', () => {
    const { onAttach } = open(null)
    type('03-1234 5678')
    attach()
    expect(screen.getByRole('alert').textContent).toBe('Enter a Malaysian mobile number, like 012-345 6789.')
    expect(onAttach).not.toHaveBeenCalled()
  })

  it('the server\'s refusal is shown as it is, and the field stays', async () => {
    open(null, { onAttach: async () => { throw new Error('The member can only be changed on an open bill.') } })
    type('0123456789')
    attach()
    expect((await screen.findByRole('alert')).textContent).toBe('The member can only be changed on an open bill.')
    expect(screen.getByLabelText('Phone number')).toBeTruthy()
  })

  it('a bill with a member opens on it; Change attaches another number', async () => {
    const other: BillMember = { memberId: 'm3', phone: '+60198765432', points: 5 }
    const { onAttach } = open(known, { onAttach: async () => other })
    expect(screen.getByTestId('member-summary').textContent).toContain('Member +60 12-345 6789 · 120 points')
    expect(screen.queryByLabelText('Phone number')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))
    type('019-876 5432')
    attach()
    await screen.findByText(/Member \+60 19-876 5432 · 5 points/)
    expect(onAttach).toHaveBeenCalledWith('+60198765432')
  })

  it('Cancel on Change goes back to the member', () => {
    open(known)
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByTestId('member-summary')).toBeTruthy()
  })

  it('Remove member takes it off and closes', async () => {
    const { onRemove, onClose } = open(known)
    fireEvent.click(screen.getByRole('button', { name: 'Remove member' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(onRemove).toHaveBeenCalledOnce()
  })

  it('a refused Remove keeps the dialog open with the server\'s words', async () => {
    const { onClose } = open(known, { onRemove: async () => { throw new Error('Bill not found') } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove member' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Bill not found')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('one point reads "1 point"', () => {
    open({ ...known, points: 1 })
    expect(screen.getByTestId('member-summary').textContent).toContain('· 1 point')
  })

  it('until the read is done: Loading…, never the attach form; then the member', () => {
    const { update } = open(null, { status: 'loading' })
    expect(screen.getByRole('status').textContent).toBe('Loading…')
    expect(screen.queryByLabelText('Phone number')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Attach' })).toBeNull()
    update('ok', known)
    expect(screen.getByTestId('member-summary').textContent).toContain('Member +60 12-345 6789 · 120 points')
  })

  it('a failed read: Couldn\'t read the member. with Retry; no attach form', () => {
    const { onRetry, update } = open(null, { status: 'error' })
    expect(screen.getByRole('alert').textContent).toBe("Couldn't read the member.")
    expect(screen.queryByLabelText('Phone number')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledOnce()
    update('ok', null)
    expect(screen.getByLabelText('Phone number')).toBeTruthy()
  })

  it('a double tap on Attach sends once', async () => {
    let release: (m: BillMember) => void = () => {}
    const { onAttach } = open(null, { onAttach: () => new Promise<BillMember>((r) => { release = r }) })
    type('012-345 6789')
    const form = screen.getByLabelText('Phone number').closest('form') as HTMLFormElement
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(onAttach).toHaveBeenCalledTimes(1)
    release(known)
    await screen.findByTestId('member-summary')
  })

  it('a double tap on Remove member sends once', async () => {
    let release: () => void = () => {}
    const { onRemove } = open(known, { onRemove: () => new Promise<void>((r) => { release = r }) })
    const btn = screen.getByRole('button', { name: 'Remove member' })
    fireEvent.click(btn)
    fireEvent.click(btn)
    expect(onRemove).toHaveBeenCalledTimes(1)
    release()
  })
})
