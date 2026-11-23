// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

const openFeedback = vi.fn()
vi.mock('../../features/feedback/feedbackBus', () => ({ openFeedback: (p: unknown) => openFeedback(p) }))

const { ErrorBoundary } = await import('./ErrorBoundary')

function Boom(): never { throw new Error('x is undefined') }

let consoleSpy: ReturnType<typeof vi.spyOn> | undefined

afterEach(() => {
  cleanup()
  openFeedback.mockReset()
  consoleSpy?.mockRestore()
  consoleSpy = undefined
})

describe('ErrorBoundary', () => {
  it('Report this problem 以 System 分类和报错信息打开反馈表单', () => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})   // React 会把被接住的错误打到 console
    render(<ErrorBoundary><Boom /></ErrorBoundary>)
    fireEvent.click(screen.getByRole('button', { name: 'Report this problem' }))
    expect(openFeedback).toHaveBeenCalledWith({ category: 'system', errorMessage: 'x is undefined' })
  })
})
