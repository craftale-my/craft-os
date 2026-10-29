// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Link, useLocation } from 'react-router-dom'
import type { FeedbackRow } from './types'

const listMyFeedback = vi.fn()
const listInbox = vi.fn()
const replyFeedback = vi.fn()
vi.mock('./api', () => ({
  listMyFeedback: (...a: unknown[]) => listMyFeedback(...a),
  listInbox: () => listInbox(),
  replyFeedback: (...a: unknown[]) => replyFeedback(...a),
  photoUrls: async () => [],
}))
let role = 'staff'
const staffs: Record<string, { id: string; name: string; system_role: string }> = {}
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => {
    const key = role
    return { staff: (staffs[key] ??= { id: 's1', name: 'Yong', system_role: key }) }
  },
}))

const { default: FeedbackPage } = await import('./FeedbackPage')
const { notifyFeedbackSent } = await import('./feedbackBus')

const row = (over: Partial<FeedbackRow> = {}): FeedbackRow => ({
  id: 'f1', category: 'system', message: 'Leave page is blank', branch: null, page_path: '/hr/leave',
  context: {}, photo_paths: [], is_anonymous: false, submitted_by: 's1', status: 'new',
  owner_reply: null, replied_at: null, created_at: '2026-10-29T03:00:00Z', updated_at: '2026-10-29T03:00:00Z',
  submitter: null, ...over,
})

function LocationProbe() { return <div data-testid="loc">{useLocation().search}</div> }

const renderAt = (url: string) => render(<MemoryRouter initialEntries={[url]}><FeedbackPage /></MemoryRouter>)

afterEach(() => { cleanup(); listMyFeedback.mockReset(); listInbox.mockReset(); replyFeedback.mockReset(); role = 'staff' })

describe('FeedbackPage', () => {
  it('普通员工没有 Inbox 标签,?tab=inbox 回落到 My Feedback', async () => {
    listMyFeedback.mockResolvedValue([])
    renderAt('/feedback?tab=inbox')
    await waitFor(() => expect(listMyFeedback).toHaveBeenCalledWith('s1'))
    expect(listInbox).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Inbox' })).toBeNull()
    expect(await screen.findByText('No feedback yet. Tap Feedback to send one.')).toBeTruthy()
  })

  it('owner 打开 ?tab=inbox 读 Inbox', async () => {
    role = 'owner'
    listInbox.mockResolvedValue([row({ is_anonymous: true, submitted_by: null, category: 'workplace' })])
    renderAt('/feedback?tab=inbox')
    await waitFor(() => expect(listInbox).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Inbox' })).toBeTruthy()
    expect(await screen.findByText('Anonymous')).toBeTruthy()
  })

  it('?id= 直接打开详情并显示 owner 回复', async () => {
    listMyFeedback.mockResolvedValue([row({ status: 'resolved', owner_reply: 'Fixed, thanks!' })])
    renderAt('/feedback?id=f1')
    expect(await screen.findByText('Fixed, thanks!')).toBeTruthy()
    expect(screen.getByText('Resolved')).toBeTruthy()
  })

  it('owner 详情里有状态与回复表单,员工没有', async () => {
    role = 'owner'
    listInbox.mockResolvedValue([row({ submitter: { name: 'Ali' } })])
    renderAt('/feedback?tab=inbox&id=f1')
    expect(await screen.findByLabelText('Status')).toBeTruthy()
    expect(screen.getByLabelText('Reply')).toBeTruthy()
    cleanup()
    role = 'staff'
    listMyFeedback.mockResolvedValue([row()])
    renderAt('/feedback?id=f1')
    await screen.findByText('Leave page is blank')
    expect(screen.queryByLabelText('Reply')).toBeNull()
  })

  it('owner Save sends status and reply, reloads the inbox and returns to the list', async () => {
    role = 'owner'
    listInbox.mockResolvedValue([row({ submitter: { name: 'Ali' } })])
    replyFeedback.mockResolvedValue({ ok: true })
    renderAt('/feedback?tab=inbox&id=f1')
    fireEvent.change(await screen.findByLabelText('Status'), { target: { value: 'resolved' } })
    fireEvent.change(screen.getByLabelText('Reply'), { target: { value: 'Fixed in v2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(replyFeedback).toHaveBeenCalledWith('f1', 'resolved', 'Fixed in v2'))
    await waitFor(() => expect(listInbox).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByLabelText('Reply')).toBeNull())
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Filter by status' })).toBeTruthy()
  })

  it('owner Save failure shows the reason, keeps the reply and stays on the detail', async () => {
    role = 'owner'
    listInbox.mockResolvedValue([row({ submitter: { name: 'Ali' } })])
    replyFeedback.mockResolvedValue({ ok: false, reason: 'Only the owner can reply to feedback.' })
    renderAt('/feedback?tab=inbox&id=f1')
    fireEvent.change(await screen.findByLabelText('Reply'), { target: { value: 'Draft reply' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Only the owner can reply to feedback.')
    expect((screen.getByLabelText('Reply') as HTMLTextAreaElement).value).toBe('Draft reply')
    expect(listInbox).toHaveBeenCalledTimes(1)
  })

  it('Inbox hides resolved by default and All shows them', async () => {
    role = 'owner'
    listInbox.mockResolvedValue([
      row({ id: 'a', message: 'Fresh item' }),
      row({ id: 'b', message: 'Done item', status: 'resolved' }),
    ])
    renderAt('/feedback?tab=inbox')
    expect(await screen.findByText('Fresh item')).toBeTruthy()
    expect(screen.queryByText('Done item')).toBeNull()
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'all' } })
    expect(screen.getByText('Fresh item')).toBeTruthy()
    expect(screen.getByText('Done item')).toBeTruthy()
  })

  it('Inbox category filter hides other categories', async () => {
    role = 'owner'
    listInbox.mockResolvedValue([
      row({ id: 'a', message: 'System thing', category: 'system' }),
      row({ id: 'b', message: 'Idea thing', category: 'product_idea' }),
    ])
    renderAt('/feedback?tab=inbox')
    expect(await screen.findByText('System thing')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Filter by category'), { target: { value: 'product_idea' } })
    expect(screen.queryByText('System thing')).toBeNull()
    expect(screen.getByText('Idea thing')).toBeTruthy()
  })

  it('shows the load error', async () => {
    listMyFeedback.mockRejectedValue(new Error('boom'))
    renderAt('/feedback')
    expect((await screen.findByRole('alert')).textContent).toBe('boom')
  })

  it('reloads when a Link inside /feedback changes only the query (notification click)', async () => {
    role = 'owner'
    listInbox.mockResolvedValueOnce([row({ id: 'f1', message: 'First item' })])
    listInbox.mockResolvedValueOnce([row({ id: 'f1', message: 'First item' }), row({ id: 'f2', message: 'Second item' })])
    render(
      <MemoryRouter initialEntries={['/feedback?tab=inbox']}>
        <Link to="/feedback?tab=inbox&id=f2">bell</Link>
        <FeedbackPage />
      </MemoryRouter>,
    )
    expect(await screen.findByText('First item')).toBeTruthy()
    fireEvent.click(screen.getByText('bell'))
    expect(await screen.findByText('Second item')).toBeTruthy()
    expect(screen.queryByText("This feedback isn't available.")).toBeNull()
    expect(listInbox).toHaveBeenCalledTimes(2)
  })

  it('reloads My Feedback when feedback is sent from the floating button', async () => {
    listMyFeedback.mockResolvedValueOnce([])
    listMyFeedback.mockResolvedValueOnce([row({ message: 'Just sent' })])
    renderAt('/feedback')
    expect(await screen.findByText('No feedback yet. Tap Feedback to send one.')).toBeTruthy()
    act(() => { notifyFeedbackSent() })
    expect(await screen.findByText('Just sent')).toBeTruthy()
    expect(listMyFeedback).toHaveBeenCalledTimes(2)
  })

  it('owner at /feedback with no tab param opens the Inbox', async () => {
    role = 'owner'
    listInbox.mockResolvedValue([row({ message: 'Inbox item' })])
    renderAt('/feedback')
    expect(await screen.findByText('Inbox item')).toBeTruthy()
    expect(listInbox).toHaveBeenCalled()
    expect(listMyFeedback).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Inbox' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('owner at ?tab=mine sees My Feedback', async () => {
    role = 'owner'
    listMyFeedback.mockResolvedValue([row({ message: 'My own item' })])
    renderAt('/feedback?tab=mine')
    expect(await screen.findByText('My own item')).toBeTruthy()
    expect(listInbox).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'My Feedback' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('owner clicking My Feedback stays on My Feedback and can go back to Inbox', async () => {
    role = 'owner'
    listInbox.mockResolvedValue([row({ message: 'Inbox item' })])
    listMyFeedback.mockResolvedValue([row({ message: 'My own item' })])
    renderAt('/feedback')
    await screen.findByText('Inbox item')
    fireEvent.click(screen.getByRole('button', { name: 'My Feedback' }))
    expect(await screen.findByText('My own item')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'My Feedback' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByText('Inbox item')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Inbox' }))
    expect(await screen.findByText('Inbox item')).toBeTruthy()
  })

  it('non-owner at /feedback gets My Feedback and the URL stays free of a tab param', async () => {
    listMyFeedback.mockResolvedValue([row({ message: 'Mine' })])
    render(
      <MemoryRouter initialEntries={['/feedback']}>
        <FeedbackPage />
        <LocationProbe />
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByText('Mine'))
    expect(screen.getByTestId('loc').textContent).toBe('?id=f1')
    expect(listInbox).not.toHaveBeenCalled()
  })

  it('owner notification link /feedback?id= opens the Inbox detail', async () => {
    role = 'owner'
    listInbox.mockResolvedValue([row({ message: 'Notified item' })])
    renderAt('/feedback?id=f1')
    expect(await screen.findByText('Notified item')).toBeTruthy()
    expect(screen.getByLabelText('Reply')).toBeTruthy()
  })
})
