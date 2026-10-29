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

function renderSheet(prefill = {}, onSent = vi.fn(), onClose = vi.fn()) {
  render(
    <MemoryRouter initialEntries={['/hr/leave']}>
      <FeedbackSheet prefill={prefill} onClose={onClose} onSent={onSent} />
    </MemoryRouter>,
  )
  return { onSent, onClose }
}

function backdrop() {
  return screen.getByRole('dialog').parentElement as HTMLElement
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

  it('file picker does not list HEIC so iOS converts to JPEG', () => {
    renderSheet()
    const accept = (screen.getByLabelText('Add photos') as HTMLInputElement).accept
    expect(accept).toBe('image/jpeg,image/png,image/webp,image/gif')
    expect(accept).not.toMatch(/heic|heif/)
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

  it('Escape 在表单为空时关闭', () => {
    const { onClose } = renderSheet()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape 在已输入内容时不关闭', () => {
    const { onClose } = renderSheet()
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'draft' } })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('点击背景在表单为空时关闭', () => {
    const { onClose } = renderSheet()
    fireEvent.click(backdrop())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('点击背景在已输入内容时不关闭', () => {
    const { onClose } = renderSheet()
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'draft' } })
    fireEvent.click(backdrop())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('提交中 Cancel 禁用、按钮显示 Sending…,且 Escape 与背景都不能关闭', async () => {
    let resolve!: (v: unknown) => void
    submitFeedback.mockReturnValue(new Promise(r => { resolve = r }))
    const { onClose, onSent } = renderSheet()
    fireEvent.click(screen.getByRole('button', { name: /Product Quality/ }))
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Ice is cloudy' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }))
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(backdrop())
    expect(onClose).not.toHaveBeenCalled()
    resolve({ ok: true, id: 'x' })
    await waitFor(() => expect(onSent).toHaveBeenCalled())
  })

  it('提交抛异常时显示通用错误、保留内容并恢复按钮', async () => {
    submitFeedback.mockRejectedValue(new Error('network down'))
    const { onSent } = renderSheet()
    fireEvent.click(screen.getByRole('button', { name: /Product Quality/ }))
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Ice is cloudy' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Something went wrong. Try again.'))
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Ice is cloudy')
    expect(screen.getByRole('button', { name: 'Send feedback' })).toBeTruthy()
    expect(onSent).not.toHaveBeenCalled()
  })

  it('匿名 Workplace 提交带 anonymous: true 且 photos 为空', async () => {
    submitFeedback.mockResolvedValue({ ok: true, id: 'x' })
    const { onSent } = renderSheet()
    fireEvent.click(screen.getByRole('button', { name: /Workplace \/ Complaint/ }))
    fireEvent.click(screen.getByLabelText('Submit anonymously'))
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Too hot in the kitchen' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }))
    await waitFor(() => expect(onSent).toHaveBeenCalled())
    expect(submitFeedback).toHaveBeenCalledWith(expect.objectContaining({
      category: 'workplace',
      anonymous: true,
      photos: [],
    }))
  })

  it('对话框是 modal 且挂载时获得焦点', () => {
    renderSheet()
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(dialog)
  })

  it('关闭时把焦点还给打开前的元素', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    renderSheet()
    expect(document.activeElement).not.toBe(opener)
    cleanup()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })
})
