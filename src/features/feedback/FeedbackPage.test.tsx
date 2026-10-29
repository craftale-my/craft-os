// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { FeedbackRow } from './types'

const listMyFeedback = vi.fn()
const listInbox = vi.fn()
vi.mock('./api', () => ({
  listMyFeedback: (...a: unknown[]) => listMyFeedback(...a),
  listInbox: () => listInbox(),
  replyFeedback: vi.fn(),
  photoUrls: async () => [],
}))
let role = 'staff'
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ staff: { id: 's1', name: 'Yong', system_role: role } }),
}))

const { default: FeedbackPage } = await import('./FeedbackPage')

const row = (over: Partial<FeedbackRow> = {}): FeedbackRow => ({
  id: 'f1', category: 'system', message: 'Leave page is blank', branch: null, page_path: '/hr/leave',
  context: {}, photo_paths: [], is_anonymous: false, submitted_by: 's1', status: 'new',
  owner_reply: null, replied_at: null, created_at: '2026-10-29T03:00:00Z', updated_at: '2026-10-29T03:00:00Z',
  submitter: null, ...over,
})

const renderAt = (url: string) => render(<MemoryRouter initialEntries={[url]}><FeedbackPage /></MemoryRouter>)

afterEach(() => { cleanup(); listMyFeedback.mockReset(); listInbox.mockReset(); role = 'staff' })

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
})
