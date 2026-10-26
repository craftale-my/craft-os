// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import PaxDialog, { PAX_CHOICES } from './PaxDialog'

afterEach(cleanup)

describe('PaxDialog', () => {
  it('offers 1 to 20 and answers the one tapped', () => {
    expect(PAX_CHOICES).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    const onPick = vi.fn()
    render(<PaxDialog title="Table T3" current={null} onPick={onPick} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '4' }))
    expect(onPick).toHaveBeenCalledWith(4)
    expect(screen.getAllByRole('button')).toHaveLength(21)   // 20 numbers + Cancel
  })

  it('marks the current pax, and Cancel closes', () => {
    const onClose = vi.fn()
    render(<PaxDialog title="Table T3" current={6} onPick={() => {}} onClose={onClose} />)
    expect(screen.getByRole('button', { name: '6' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '5' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
