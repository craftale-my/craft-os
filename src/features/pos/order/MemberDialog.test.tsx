// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import MemberDialog from './MemberDialog'
import { INVALID_PHONE, type BillMember } from './billMember'

afterEach(cleanup)

const known: BillMember = { memberId: 'm1', phone: '+60123456789', points: 120 }

function open(current: BillMember | null, over: { onAttach?: (p: string) => Promise<BillMember>; onRemove?: () => Promise<void> } = {}) {
  const onAttach = vi.fn(over.onAttach ?? (async () => known))
  const onRemove = vi.fn(over.onRemove ?? (async () => undefined))
  const onClose = vi.fn()
  render(<MemberDialog billNo="261123-001" current={current} onAttach={onAttach} onRemove={onRemove} onClose={onClose} />)
  return { onAttach, onRemove, onClose }
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
    expect(screen.getByRole('alert').textContent).toBe(INVALID_PHONE)
    expect(INVALID_PHONE).toBe('Enter a Malaysian mobile number, like 012-345 6789.')
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
})
