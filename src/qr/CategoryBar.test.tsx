// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import CategoryBar from './CategoryBar'

afterEach(cleanup)

const names = ['Popular', 'Coffee', 'Tea', 'Cakes']

describe('CategoryBar', () => {
  it('shows a pill per category; the active one is filled and marked current', () => {
    render(<CategoryBar names={names} active={2} onPick={() => {}} />)
    const nav = screen.getByRole('navigation', { name: 'Categories' })
    const pills = within(nav).getAllByRole('button').filter((b) => b.getAttribute('aria-label') !== 'All categories')
    expect(pills.map((b) => b.textContent)).toEqual(names)
    expect(pills[2].getAttribute('aria-current')).toBe('true')
    expect(pills[2].className).toContain('bg-brown-btn')
    expect(pills[0].getAttribute('aria-current')).toBeNull()
  })
  it('sticks to the top of the page', () => {
    render(<CategoryBar names={names} active={0} onPick={() => {}} />)
    const nav = screen.getByRole('navigation', { name: 'Categories' })
    expect(nav.className).toContain('sticky')
    expect(nav.className).toContain('top-0')
  })
  it('a tap on a pill picks that section', () => {
    const onPick = vi.fn()
    render(<CategoryBar names={names} active={0} onPick={onPick} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cakes' }))
    expect(onPick).toHaveBeenCalledWith(3)
  })
  it('the chevron opens a panel listing every category; a tap jumps there and closes it', () => {
    const onPick = vi.fn()
    render(<CategoryBar names={names} active={0} onPick={onPick} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    const chevron = screen.getByRole('button', { name: 'All categories' })
    expect(chevron.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(chevron)
    const panel = screen.getByRole('dialog', { name: 'All categories' })
    expect(within(panel).getAllByRole('button').map((b) => b.textContent)).toEqual(expect.arrayContaining(names))
    fireEvent.click(within(panel).getByRole('button', { name: 'Tea' }))
    expect(onPick).toHaveBeenCalledWith(2)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
