// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import BottomBar from './BottomBar'

afterEach(cleanup)

describe('BottomBar', () => {
  it('no printer problem: no badge on the staff button', () => {
    render(<BottomBar title="Tables" staffName="Aina" printProblems={0} onMenu={() => {}} onStaff={() => {}} />)
    expect(screen.queryByText(/Printer problem/)).toBeNull()
  })

  it('printer problems show a red badge on the staff button, and tapping it opens the staff panel', () => {
    const onStaff = vi.fn()
    render(<BottomBar title="Tables" staffName="Aina" printProblems={3} onMenu={() => {}} onStaff={onStaff} />)
    const badge = screen.getByText('Printer problem · 3')
    expect(badge.className).toContain('bg-red-600')
    expect(screen.getByRole('button', { name: /Staff panel/ }).contains(badge)).toBe(true)
    fireEvent.click(badge)
    expect(onStaff).toHaveBeenCalledTimes(1)
  })
})
