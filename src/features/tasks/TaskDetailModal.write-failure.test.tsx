// @vitest-environment jsdom
//
// 详情弹窗的两笔「自己写、自己判」的写入:存档与删除。两笔都是 RLS 挡得掉的
// 形状({ data: [], error: null } —— 没有 error 也没有列),而两笔的失败长相
// 特别恶劣:
//
//  - 存档:少了 .ok 判断就 setEditing(false) + onChanged(),编辑态收起来、板重拉
//    一次,画面回到那笔**旧的**任务上,像极了「存好了,只是画面还没跟上」。
//  - 删除:少了 .ok 判断就 onClose(),弹窗当场关掉 —— 使用者拿到的是最强烈的
//    「删掉了」讯号,而那张卡下一次重拉还会回到板上。
//
// 顺带钉住 fetchProjects 失败的显示位置:那笔读取在弹窗一开就跑,失败也就该在
// 弹窗一开就说出来。曾经只画在编辑态的下拉旁边,不按 "Edit Task" 的人永远看不到。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { Task } from './types'

const h = vi.hoisted(() => ({
  updateTask:       vi.fn(),
  deleteTask:       vi.fn(),
  fetchProjects:    vi.fn(),
  // 弹窗一开就跑这两笔;vi.resetAllMocks() 会把 mock 工厂里写死的回传也清掉,
  // 所以跟其它 mock 一样挂在 h 上,每则测试前重新给一次。
  fetchAttachments: vi.fn(),
  fetchChecklist:   vi.fn(),
}))

vi.mock('./api', () => ({
  updateTask:    h.updateTask,
  deleteTask:    h.deleteTask,
  fetchProjects: h.fetchProjects,
  upsertTag:     vi.fn(),
  attachTag:     vi.fn(),
  detachTag:     vi.fn(),
  fetchAttachments: h.fetchAttachments,
  fetchChecklist:   h.fetchChecklist,
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  addChecklistItem:     vi.fn(),
  setChecklistDone:     vi.fn(),
  setChecklistAssignee: vi.fn(),
  deleteChecklistItem:  vi.fn(),
}))

// 评论串自己管自己的读取/张贴(有自己的测试档),跟存档 / 删除无关。
vi.mock('./CommentThread', () => ({ CommentThread: () => null }))

vi.mock('../../shared/lib/lookups', () => ({
  useLookups: () => ({ deptName: (slug: string) => slug }),
}))

const { TaskDetailModal } = await import('./TaskDetailModal')

const TASK: Task = {
  id: 'task-1',
  title: 'Fix the espresso machine leak',
  description: null,
  status: 'todo',
  priority: 'medium',
  project_id: 'proj-1',
  assigned_to: 'staff-1',
  created_by: 'staff-1',
  due_date: null,
  department: null,
  position: 1024,
  completed_at: null,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  assignee: { id: 'staff-1', name: 'Yong Tan', avatar: null },
  creator:  { id: 'staff-1', name: 'Yong Tan', avatar: null },
  project: { id: 'proj-1', name: 'Bean Sourcing', color: '#C4813A' },
  tags: [],
  _comment_count:    0,
  _attachment_count: 0,
  _checklist_done:   0,
  _checklist_total:  0,
}

/** RLS 静静挡掉的写入,经 writeOutcome 判定之后的样子。 */
const BLOCKED = { ok: false, reason: 'it was not saved — you may have been signed out.' } as const

function renderModal(task: Task = TASK) {
  const onChanged = vi.fn()
  const onClose = vi.fn()
  render(
    <TaskDetailModal
      task={task}
      allStaff={[]}
      allTags={[]}
      canManageTasks
      canManageProjects
      currentStaffId="staff-1"
      onClose={onClose}
      onChanged={onChanged}
      onStatusChange={async () => ({ ok: true })}
    />,
  )
  return { onChanged, onClose }
}

beforeEach(() => {
  vi.resetAllMocks()
  h.fetchProjects.mockResolvedValue([])
  h.fetchAttachments.mockResolvedValue([])
  h.fetchChecklist.mockResolvedValue([])
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TaskDetailModal 存档', () => {
  it('says so when the write is silently dropped, and stays in the editor', async () => {
    h.updateTask.mockResolvedValue(BLOCKED)
    const { onChanged } = renderModal()

    fireEvent.click(await screen.findByText('Edit Task'))
    fireEvent.click(screen.getByText('Save Changes'))

    expect(await screen.findByText(/Could not save the task/)).toBeTruthy()
    expect(screen.getByText(/you may have been signed out/)).toBeTruthy()
    // 编辑态收起来 + 重拉板 = 画面回到那笔旧任务上,看起来完全像存好了。
    expect(screen.getByText('Save Changes')).toBeTruthy()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('leaves the editor and reloads the board only when the write really landed', async () => {
    h.updateTask.mockResolvedValue({ ok: true })
    const { onChanged } = renderModal()

    fireEvent.click(await screen.findByText('Edit Task'))
    fireEvent.click(screen.getByText('Save Changes'))

    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(screen.queryByText('Save Changes')).toBeNull()
    expect(h.updateTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ title: 'Fix the espresso machine leak', project_id: 'proj-1' }),
    )
  })
})

describe('TaskDetailModal 删除', () => {
  it('says so when the delete is silently dropped, and keeps the modal open', async () => {
    h.deleteTask.mockResolvedValue(BLOCKED)
    const { onChanged, onClose } = renderModal()

    fireEvent.click(await screen.findByText('Delete'))

    expect(await screen.findByText(/Could not delete the task/)).toBeTruthy()
    expect(screen.getByText(/you may have been signed out/)).toBeTruthy()
    // 关掉弹窗是最强烈的「删掉了」讯号,而那张卡下一次重拉还会回到板上。
    expect(onClose).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('closes and reloads the board only when the delete really landed', async () => {
    h.deleteTask.mockResolvedValue({ ok: true })
    const { onChanged, onClose } = renderModal()

    fireEvent.click(await screen.findByText('Delete'))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onChanged).toHaveBeenCalled()
    expect(h.deleteTask).toHaveBeenCalledWith('task-1')
  })

  it('writes nothing when the confirmation is declined', async () => {
    vi.mocked(window.confirm).mockReturnValue(false)
    const { onClose } = renderModal()

    fireEvent.click(await screen.findByText('Delete'))

    expect(h.deleteTask).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('TaskDetailModal 的专案清单读取', () => {
  it('shows a failed project read straight away, without waiting for anyone to click Edit', async () => {
    h.fetchProjects.mockRejectedValue(new Error('permission denied for table projects'))
    renderModal()

    const err = await screen.findByTestId('task-detail-projects-error')
    expect(err.textContent).toContain('Could not load projects')
    expect(err.textContent).toContain('permission denied for table projects')
    // 这一笔跟卡上那颗 project 标签是两条不同的读取:标签来自任务本身,
    // 清单读不到并不代表这张卡不属于任何专案 —— 标签必须还在。
    expect(screen.getByTestId('task-detail-project-badge').textContent).toContain('Bean Sourcing')
  })

  it('says nothing when the list reads fine', async () => {
    renderModal()

    await waitFor(() => expect(h.fetchProjects).toHaveBeenCalled())
    expect(screen.queryByTestId('task-detail-projects-error')).toBeNull()
  })
})

describe('TaskDetailModal 的删除闸门', () => {
  it('hides Delete for a task someone else created when the user lacks manage_projects', async () => {
    render(
      <TaskDetailModal
        task={{ ...TASK, created_by: 'staff-2' }}
        allStaff={[]}
        allTags={[]}
        canManageTasks
        canManageProjects={false}
        currentStaffId="staff-1"
        onClose={vi.fn()}
        onChanged={vi.fn()}
        onStatusChange={async () => ({ ok: true })}
      />,
    )

    // tasks_delete 只放行「自己建的,或者有 manage_projects」——这一格两个都不是。
    // 编辑仍然开着:tasks_update 只要 view_team。
    expect(await screen.findByText('Edit Task')).toBeTruthy()
    expect(screen.queryByText('Delete')).toBeNull()
  })

  it('keeps Delete for a task someone else created when the user has manage_projects', async () => {
    renderModal({ ...TASK, created_by: 'staff-2' })

    expect(await screen.findByText('Delete')).toBeTruthy()
  })
})
