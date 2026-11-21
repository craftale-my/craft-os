// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import PaxDialog, { clampChildren, PAX_CHOICES, stepChildren } from './PaxDialog'

afterEach(cleanup)

describe('PaxDialog', () => {
  it('offers 1 to 20 and answers the one tapped', () => {
    expect(PAX_CHOICES).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    const onPick = vi.fn()
    render(<PaxDialog title="Table T3" current={null} onPick={onPick} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '4' }))
    expect(onPick).toHaveBeenCalledWith(4, null)
    expect(screen.getAllByRole('button')).toHaveLength(23)   // 20 numbers + Fewer / More children + Cancel
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

describe('PaxDialog children (W7 spec §5)', () => {
  it('Of which children: None at first; More counts up, Fewer back; the pax tap picks both', () => {
    const onPick = vi.fn()
    render(<PaxDialog title="Table T3" current={null} onPick={onPick} onClose={() => {}} />)
    expect(screen.getByText('Of which children')).toBeTruthy()
    expect(screen.getByText('None')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Fewer children' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'More children' }))
    fireEvent.click(screen.getByRole('button', { name: 'More children' }))
    expect(screen.getByText('2', { selector: 'span' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '4' }))
    expect(onPick).toHaveBeenCalledWith(4, 2)
  })
  it('children above the pax tapped are clamped to it', () => {
    const onPick = vi.fn()
    render(<PaxDialog title="Table T3" current={null} onPick={onPick} onClose={() => {}} />)
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: 'More children' }))
    fireEvent.click(screen.getByRole('button', { name: '2' }))
    expect(onPick).toHaveBeenCalledWith(2, 2)
  })
  it('opens with the bill\'s children; Fewer from 1 is None', () => {
    const onPick = vi.fn()
    render(<PaxDialog title="Table T3" current={3} currentChildren={1} onPick={onPick} onClose={() => {}} />)
    expect(screen.getByText('1', { selector: 'span' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Fewer children' }))
    expect(screen.getByText('None')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '3' }))
    expect(onPick).toHaveBeenCalledWith(3, null)
  })
  it('the stepper rule', () => {
    expect(stepChildren(null, 1)).toBe(1)
    expect(stepChildren(5, 1)).toBe(6)
    expect(stepChildren(20, 1)).toBe(20)
    expect(stepChildren(5, -1)).toBe(4)
    expect(stepChildren(1, -1)).toBeNull()
    expect(stepChildren(0, -1)).toBeNull()
    expect(stepChildren(null, -1)).toBeNull()
    expect(clampChildren(5, 3)).toBe(3)
    expect(clampChildren(2, 3)).toBe(2)
    expect(clampChildren(null, 3)).toBeNull()
  })
})
