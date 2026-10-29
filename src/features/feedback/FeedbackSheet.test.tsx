// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const submitFeedback = vi.fn()
const feedbackContext = vi.fn((e?: string) => ({ appVersion: 't', ...(e ? { errorMessage: e } : {}) }))
vi.mock('./api', () => ({
  submitFeedback: (...a: unknown[]) => submitFeedback(...a),
  feedbackContext: (e?: string) => feedbackContext(e),
}))
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ staff: { id: 's1', name: 'Yong', branch: 'Cheras (Taman Connaught)' } }),
}))

const { FeedbackSheet } = await import('./FeedbackSheet')

afterEach(() => { cleanup(); submitFeedback.mockReset(); feedbackContext.mockClear() })

function renderSheet(prefill = {}, onSent = vi.fn()) {
  render(
    <MemoryRouter initialEntries={['/hr/leave']}>
      <FeedbackSheet prefill={prefill} onClose={vi.fn()} onSent={onSent} />
    </MemoryRouter>,
  )
  return { onSent }
}

describe('FeedbackSheet', () => {
  it('匿名开关只在选了 Workplace 后出现', () => {
    renderSheet()
    expect(screen.queryByLabelText('Submit anonymously')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Product Quality/ }))
    expect(screen.queryByLabelText('Submit anonymously')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Workplace \/ Complaint/ }))
    expect(screen.getByLabelText('Submit anonymously')).toBeTruthy()
  })

  it('打开匿名后照片区隐藏并出现提示', () => {
    renderSheet()
    fireEvent.click(screen.getByRole('button', { name: /Workplace \/ Complaint/ }))
    expect(screen.getByLabelText('Add photos')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Submit anonymously'))
    expect(screen.queryByLabelText('Add photos')).toBeNull()
    expect(screen.getByText("Photos can't be attached to anonymous feedback.")).toBeTruthy()
    expect(screen.getByText("You won't see this in My Feedback or get a reply.")).toBeTruthy()
  })

  it('没写内容时显示错误且不提交', () => {
    renderSheet()
    fireEvent.click(screen.getByRole('button', { name: /Product Idea/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }))
    expect(screen.getByRole('alert').textContent).toBe('Write a message.')
    expect(submitFeedback).not.toHaveBeenCalled()
  })

  it('提交成功带上分类、内容、分店与当前页面', async () => {
    submitFeedback.mockResolvedValue({ ok: true, id: 'x' })
    const { onSent } = renderSheet()
    fireEvent.click(screen.getByRole('button', { name: /Product Quality/ }))
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Ice is cloudy' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }))
    await waitFor(() => expect(onSent).toHaveBeenCalled())
    expect(submitFeedback).toHaveBeenCalledWith(expect.objectContaining({
      category: 'product_quality',
      message: 'Ice is cloudy',
      branch: 'Cheras (Taman Connaught)',
      anonymous: false,
      pagePath: '/hr/leave',
    }))
  })

  it('提交失败时保留内容并显示服务器信息', async () => {
    submitFeedback.mockResolvedValue({ ok: false, reason: 'Only active staff can send feedback.' })
    const { onSent } = renderSheet()
    fireEvent.click(screen.getByRole('button', { name: /Product Quality/ }))
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Ice is cloudy' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Only active staff can send feedback.'))
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Ice is cloudy')
    expect(onSent).not.toHaveBeenCalled()
  })

  it('从报错页打开时预选 System,并把报错信息放进 context', async () => {
    submitFeedback.mockResolvedValue({ ok: true, id: 'x' })
    renderSheet({ category: 'system', errorMessage: 'x is undefined' })
    expect(screen.getByRole('button', { name: /App \/ System Issue/ }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Crashed on open' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }))
    await waitFor(() => expect(submitFeedback).toHaveBeenCalled())
    expect(feedbackContext).toHaveBeenCalledWith('x is undefined')
    expect(submitFeedback.mock.calls[0][0].context).toEqual({ appVersion: 't', errorMessage: 'x is undefined' })
  })
})
