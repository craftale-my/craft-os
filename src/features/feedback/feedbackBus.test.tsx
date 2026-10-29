// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { notifyFeedbackSent, useFeedbackSent } from './feedbackBus'

function Probe({ cb }: { cb: () => void }) {
  useFeedbackSent(cb)
  return null
}

afterEach(cleanup)

describe('feedbackBus sent event', () => {
  it('calls subscribers when feedback is sent and stops after unmount', () => {
    const cb = vi.fn()
    const { unmount } = render(<Probe cb={cb} />)
    notifyFeedbackSent()
    expect(cb).toHaveBeenCalledTimes(1)
    unmount()
    notifyFeedbackSent()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('always calls the latest callback', () => {
    const a = vi.fn()
    const b = vi.fn()
    const { rerender } = render(<Probe cb={a} />)
    rerender(<Probe cb={b} />)
    notifyFeedbackSent()
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
  })
})
