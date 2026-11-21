// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import GuestCard from './GuestCard'

afterEach(cleanup)

describe('GuestCard', () => {
  it('a new guest picks an avatar, may type a name, and starts', () => {
    const onDone = vi.fn()
    render(<GuestCard initial={null} onDone={onDone} />)
    expect(screen.getByRole('heading', { name: "Who's ordering?" })).toBeTruthy()
    expect(screen.getAllByRole('radio')).toHaveLength(8)
    expect(screen.getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(1)
    fireEvent.click(screen.getAllByRole('radio')[2])
    fireEvent.change(screen.getByLabelText('Your name (optional)'), { target: { value: '  Mei ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start ordering' }))
    expect(onDone).toHaveBeenCalledWith('Mei', 'a3')
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('an empty name is Guest', () => {
    const onDone = vi.fn()
    render(<GuestCard initial={null} onDone={onDone} />)
    fireEvent.click(screen.getAllByRole('radio')[0])
    fireEvent.click(screen.getByRole('button', { name: 'Start ordering' }))
    expect(onDone).toHaveBeenCalledWith('Guest', 'a1')
  })

  it('editing shows the current name and avatar, Save and Cancel', () => {
    const onDone = vi.fn(), onCancel = vi.fn()
    render(<GuestCard initial={{ id: 'x', name: 'Eric', avatar: 'a5' }} onDone={onDone} onCancel={onCancel} />)
    expect((screen.getByLabelText('Your name (optional)') as HTMLInputElement).value).toBe('Eric')
    expect(screen.getAllByRole('radio')[4].getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onDone).toHaveBeenCalledWith('Eric', 'a5')
  })

  it('a guest called Guest edits an empty field', () => {
    render(<GuestCard initial={{ id: 'x', name: 'Guest', avatar: 'a1' }} onDone={() => {}} />)
    expect((screen.getByLabelText('Your name (optional)') as HTMLInputElement).value).toBe('')
  })
})
