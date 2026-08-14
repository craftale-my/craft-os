// @vitest-environment jsdom
//
// upsertTag 本身的 slug 撞库存(onConflict)逻辑属于 Task 3,这里不重测那段
// Supabase 呼叫;要测的是 TaskDetailModal.handleAddTag 有没有老实把 upsertTag
// 回传的既有列直接拿去 attachTag —— 而不是任何图方便的捷径,例如照着 allTags
// 本地比对自己造一个 id、或是不管三七二十一都当成新 tag 处理。那类捷径一旦
// 存在,两个使用者各自打 "urgent" 与 "Urgent" 就会在 task_tags 挂上两笔不同
// 的 tag id,画面上看起来像是同一个字却各自为政,筛选器一次只能挑到一半。
//
// mock 的 upsertTag 用一张以 slug 为键的假表模拟真正的 upsert-on-conflict:
// 同一个 slug 第二次打进来,回传的是「同一个 id」的既有列,不会造新的一笔。
// slug 计算走真正的 normalizeTagName(未 mock),这样大小写/空白差异的收敛
// 规则跟正式环境一致。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { normalizeTagName } from '../../shared/lib/tasks'
import type { Tag, Task } from './types'

const h = vi.hoisted(() => ({
  upsertTag:        vi.fn(),
  attachTag:        vi.fn(),
  detachTag:        vi.fn(),
  fetchAttachments: vi.fn(),
  fetchChecklist:   vi.fn(),
}))

vi.mock('./api', () => ({
  upsertTag:        h.upsertTag,
  attachTag:        h.attachTag,
  detachTag:        h.detachTag,
  fetchAttachments: h.fetchAttachments,
  fetchChecklist:   h.fetchChecklist,
  // 弹窗现在自己会拉一份 project 清单喂给编辑态的下拉;这份测试跟 project
  // 挑选无关,给个空清单让它悄悄过去就好。
  fetchProjects:    vi.fn().mockResolvedValue([]),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  updateTask:       vi.fn(),
  deleteTask:       vi.fn(),
  addChecklistItem:     vi.fn(),
  setChecklistDone:     vi.fn(),
  setChecklistAssignee: vi.fn(),
  deleteChecklistItem:  vi.fn(),
}))

// 评论串自己管自己的读取/张贴,跟 tag 去重无关,整块换掉免得还要另外喂
// fetchComments / postComment 的 mock。
vi.mock('./CommentThread', () => ({
  CommentThread: () => null,
}))

vi.mock('../../shared/lib/lookups', () => ({
  useLookups: () => ({ deptName: (slug: string) => slug }),
}))

const { TaskDetailModal } = await import('./TaskDetailModal')

const TASK: Task = {
  id: 'task-1',
  title: 'Restock the beans',
  description: null,
  status: 'todo',
  priority: 'medium',
  project_id: null,
  assigned_to: 'staff-1',
  created_by: 'staff-1',
  due_date: null,
  department: null,
  position: 1024,
  completed_at: null,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  assignee: null,
  creator:  null,
  project: null,
  tags: [],
  _comment_count:    0,
  _attachment_count: 0,
  _checklist_done:   0,
  _checklist_total:  0,
}

/** 假的 tags 表:同一个 slug 一律回传第一次造出的那一列,模拟 upsert onConflict。 */
function fakeTagTable() {
  const bySlug = new Map<string, Tag>()
  let seq = 0
  return vi.fn(async (raw: string): Promise<Tag> => {
    const norm = normalizeTagName(raw)
    if (!norm) throw new Error('Tag name cannot be empty.')
    const existing = bySlug.get(norm.slug)
    if (existing) return existing
    const created: Tag = { id: `tag-${++seq}`, slug: norm.slug, name: norm.name, color: '#C4813A' }
    bySlug.set(norm.slug, created)
    return created
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  h.fetchAttachments.mockResolvedValue([])
  h.fetchChecklist.mockResolvedValue([])
})
afterEach(cleanup)

function renderModal(onChanged: () => void = vi.fn()) {
  return render(
    <TaskDetailModal
      task={TASK}
      allStaff={[]}
      allTags={[]}
      canManageTasks={false}
      canManageProjects={false}
      currentStaffId="staff-1"
      onClose={() => {}}
      onChanged={onChanged}
      onStatusChange={async () => ({ ok: true })}
    />,
  )
}

describe('打一个 slug 已经存在的 tag 名字,要挂上既有的那笔,不是另外造一笔', () => {
  it('resolves a case-different retype of an existing tag to the same id', async () => {
    h.upsertTag.mockImplementation(fakeTagTable())
    h.attachTag.mockResolvedValue({ ok: true })
    renderModal()

    const input = await screen.findByPlaceholderText('Add a tag…')

    // 先打小写,造出 "urgent"。
    fireEvent.change(input, { target: { value: 'urgent' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(h.attachTag).toHaveBeenCalledTimes(1))
    const firstId = h.attachTag.mock.calls[0][1]

    // 再打一次,这次大小写不同 —— slug 撞库存,必须命中同一笔,不是造第二笔。
    fireEvent.change(input, { target: { value: 'Urgent' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(h.attachTag).toHaveBeenCalledTimes(2))
    const secondId = h.attachTag.mock.calls[1][1]

    expect(secondId).toBe(firstId)
    // 两次都真的问过 upsertTag(不是靠本地缓存猜),但 tags 表里只长出一笔。
    expect(h.upsertTag).toHaveBeenCalledTimes(2)
  })
})
