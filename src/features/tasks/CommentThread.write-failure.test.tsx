// @vitest-environment jsdom
//
// 评论是这个模块里最像 clock-out 的一条路径:按下 Post,草稿清空、清单重新载入,
// 画面从头到尾没有任何一个字提到写入。RLS 挡掉的 insert 回 { data: [], error: null }
// —— 没有 error,也没有列 —— 所以少了 `if (!res.ok)` 那一段,使用者会看着一份
// **不含自己刚打那句话**的清单,以为只是自己眼花。经理在这里记下一个决定,
// 而那个决定根本没进资料库。
//
// 这支组件之前一个测试都没有:把 postComment 的 .ok 判断整段删掉,全套 337 则
// 依然全绿。这里钉的就是那一段。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { TaskComment } from './types'

const h = vi.hoisted(() => ({
  fetchComments: vi.fn(),
  postComment:   vi.fn(),
}))

vi.mock('./api', () => ({
  fetchComments: h.fetchComments,
  postComment:   h.postComment,
}))

const { CommentThread } = await import('./CommentThread')

const EXISTING: TaskComment = {
  id: 'c-1',
  task_id: 'task-1',
  staff_id: 'staff-2',
  comment: 'Ordered a replacement gasket.',
  created_at: '2026-08-01T00:00:00.000Z',
  staff: { id: 'staff-2', name: 'Amy Cheah', avatar: null },
}

/** RLS 静静挡掉的写入,经 writeOutcome 判定之后的样子。 */
const BLOCKED = { ok: false, reason: 'it was not saved — you may have been signed out.' } as const

function renderThread() {
  const onPosted = vi.fn()
  render(<CommentThread taskId="task-1" currentStaffId="staff-1" onPosted={onPosted} />)
  return { onPosted }
}

async function typeAndPost(body: string) {
  const input = await screen.findByPlaceholderText('Add a comment...')
  fireEvent.change(input, { target: { value: body } })
  fireEvent.click(screen.getByText('Post'))
  return input as HTMLInputElement
}

beforeEach(() => {
  vi.resetAllMocks()
  h.fetchComments.mockResolvedValue([EXISTING])
})
afterEach(cleanup)

describe('CommentThread 的张贴', () => {
  it('says so when the write is silently dropped, and keeps the draft in the box', async () => {
    h.postComment.mockResolvedValue(BLOCKED)
    const { onPosted } = renderThread()

    const input = await typeAndPost('Approved — order two.')

    expect(await screen.findByText(/Could not post the comment/)).toBeTruthy()
    expect(screen.getByText(/you may have been signed out/)).toBeTruthy()
    // 草稿留在原地,使用者不必重打 —— 清掉它才是最伤的那一种「成功」。
    expect(input.value).toBe('Approved — order two.')
    expect(onPosted).not.toHaveBeenCalled()
    // 重新载入清单会把画面刷成「就是没有你那句话」的样子,看起来跟成功一模一样。
    expect(h.fetchComments).toHaveBeenCalledTimes(1)
  })

  it('clears the draft and reloads only when the write really landed', async () => {
    h.postComment.mockResolvedValue({ ok: true })
    const { onPosted } = renderThread()

    const input = await typeAndPost('Approved — order two.')

    await waitFor(() => expect(onPosted).toHaveBeenCalled())
    expect(input.value).toBe('')
    expect(h.postComment).toHaveBeenCalledWith('task-1', 'staff-1', 'Approved — order two.')
    expect(h.fetchComments).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(/Could not post the comment/)).toBeNull()
  })

  it('surfaces a failed read instead of drawing an empty thread', async () => {
    h.fetchComments.mockRejectedValue(new Error('permission denied for table task_comments'))
    renderThread()

    expect(await screen.findByText(/permission denied for table task_comments/)).toBeTruthy()
  })
})
