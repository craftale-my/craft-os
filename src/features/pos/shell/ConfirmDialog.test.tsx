// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ConfirmDialog from './ConfirmDialog'

afterEach(cleanup)

describe('ConfirmDialog', () => {
  it('asks the question and answers each button once', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<ConfirmDialog title="Merge into B4?" message="Every item moves onto bill 261026-004." confirmLabel="Merge"
      onConfirm={onConfirm} onCancel={onCancel} />)
    expect(screen.getByRole('dialog', { name: 'Merge into B4?' })).toBeTruthy()
    expect(screen.getByText('Every item moves onto bill 261026-004.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('a tap outside cancels, a tap inside does not; while busy nothing answers', () => {
    const onCancel = vi.fn()
    const { container, rerender } = render(<ConfirmDialog title="Close bill?" confirmLabel="Close bill" onConfirm={() => {}} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('dialog'))
    expect(onCancel).not.toHaveBeenCalled()
    fireEvent.click(container.firstChild as Element)
    expect(onCancel).toHaveBeenCalledTimes(1)
    rerender(<ConfirmDialog title="Close bill?" confirmLabel="Close bill" busy onConfirm={() => {}} onCancel={onCancel} />)
    fireEvent.click(container.firstChild as Element)
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button', { name: 'Close bill' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
