// @vitest-environment jsdom
//
// 子项没做完就把任务丢进 Done,要先问一句。这个闸门刻意是**软的** —— 确认就
// 放行,子项可能作废、可能被情势跳过,硬挡会让任务永远结不掉。
//
// 有三条路会把任务搬到 Done,而且它们不共用同一个入口:板上的拖放与 mobile 卡上的
// 换栏钮虽然都走 TaskBoard → handleBoardMove,进 TaskBoard 的却是两个不同的呼叫点
// (拖放的 drop handler,对上卡片钮直接呼叫 requestMove);详情弹窗的 "Move to"
// 更是直接呼叫 moveOptimistic、绕过 handleBoardMove。只在其中一条挂确认,其余就成了
// 后门 —— 而弹窗那条还是使用者最常用的(卡片开着弹窗才看得到子项)。所以三条都测。
//
// 「取消」的验收标准比「没有送出写入」更严格:连乐观更新都不准跑。卡片先跳去
// Done 再弹回来,等於问了也白问 —— 使用者已经看到它进了 Done。
//
// window.confirm 用 vi.spyOn 决定按下确定或取消;整个模块的破坏性确认(删任务、
// 删标签)本来就是 window.confirm,不为了一句提示新开一层 modal。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { WriteOutcome } from '../../shared/lib/db-write'
import type { Task } from './types'

const h = vi.hoisted(() => ({
  fetchBoardTasks:      vi.fn(),
  moveTask:             vi.fn(),
  fetchTags:            vi.fn(),
  fetchComments:        vi.fn(),
  postComment:          vi.fn(),
  fetchAttachments:     vi.fn(),
  fetchChecklist:       vi.fn(),
  fetchAssignableStaff: vi.fn(),
  fetchProjects:        vi.fn(),
}))

vi.mock('./api', () => ({
  fetchBoardTasks:      h.fetchBoardTasks,
  moveTask:             h.moveTask,
  fetchTags:            h.fetchTags,
  fetchComments:        h.fetchComments,
  postComment:          h.postComment,
  fetchAttachments:     h.fetchAttachments,
  fetchChecklist:       h.fetchChecklist,
  fetchAssignableStaff: h.fetchAssignableStaff,
  fetchProjects:        h.fetchProjects,
  createTask:           vi.fn(),
  updateTask:           vi.fn(),
  deleteTask:           vi.fn(),
  uploadAttachment:     vi.fn(),
  deleteAttachment:     vi.fn(),
  upsertTag:            vi.fn(),
  attachTag:            vi.fn(),
  detachTag:            vi.fn(),
  addChecklistItem:     vi.fn(),
  setChecklistDone:     vi.fn(),
  setChecklistAssignee: vi.fn(),
  deleteChecklistItem:  vi.fn(),
}))

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ staff: { id: 'staff-1', name: 'Yong Tan', rank: 'manager' } }),
}))

vi.mock('../../shared/lib/lookups', () => ({
  useLookups: () => ({
    deptName: (slug: string) => slug,
    departmentOptions: () => [],
    roleCaps: { manager: { manage_projects: true } },
  }),
}))

const { default: TasksPage } = await import('./Tasks')

/** 7 条子项,做完 4 条 —— 还有 3 条开着。 */
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
  assignee: { id: 'staff-1', name: 'Yong Tan', avatar: null },
  creator:  { id: 'staff-1', name: 'Yong Tan', avatar: null },
  project: null,
  tags: [],
  _comment_count:    0,
  _attachment_count: 0,
  _checklist_done:   4,
  _checklist_total:  7,
}

const OK: WriteOutcome = { ok: true }
const PROMPT = 'Still 3 of 7 items open. Mark as done anyway?'

beforeEach(() => {
  vi.resetAllMocks()
  h.fetchBoardTasks.mockImplementation(async () => [{ ...TASK }])
  h.fetchTags.mockResolvedValue([])
  h.fetchComments.mockResolvedValue([])
  h.fetchAttachments.mockResolvedValue([])
  h.fetchChecklist.mockResolvedValue([])
  h.fetchAssignableStaff.mockResolvedValue([])
  h.fetchProjects.mockResolvedValue([])
  h.moveTask.mockResolvedValue(OK)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** 换掉这一轮看板要回传的任务。必须在 render 之前呼叫。 */
function boardHolds(patch: Partial<Task>) {
  h.fetchBoardTasks.mockImplementation(async () => [{ ...TASK, ...patch }])
}

function answerConfirm(answer: boolean) {
  return vi.spyOn(window, 'confirm').mockReturnValue(answer)
}

async function renderBoard(): Promise<HTMLElement> {
  render(<TasksPage />)
  return await screen.findByTestId('task-card-task-1')
}

/** 拖到 Done 栏 —— 板上那条路,同时也是 mobile 换栏钮走的 requestMove。 */
function dragToDone(card: HTMLElement) {
  fireEvent.dragStart(card)
  fireEvent.drop(screen.getByTestId('column-done'))
}

/** 开详情弹窗,按下 "Move to" 的 Done —— 这条路直接呼叫 moveOptimistic。 */
async function moveToDoneFromModal(card: HTMLElement) {
  fireEvent.click(card)
  // 弹窗的钮叫 "Done";mobile 卡上的是 "→ Done",不会撞到。
  fireEvent.click(await screen.findByRole('button', { name: 'Done' }))
}

/** 卡片留在 To Do、没有出现在 Done —— 连乐观更新都没跑过。 */
function expectStillInTodo() {
  expect(screen.getByTestId('column-todo').textContent).toMatch(/Restock the beans/)
  expect(screen.getByTestId('column-done').textContent).not.toMatch(/Restock the beans/)
}

describe('板上拖到 Done', () => {
  it('asks before closing a task that still has open items', async () => {
    const confirmed = answerConfirm(true)
    dragToDone(await renderBoard())

    await waitFor(() => expect(h.moveTask).toHaveBeenCalledTimes(1))
    expect(confirmed).toHaveBeenCalledWith(PROMPT)
    expect(h.moveTask.mock.calls[0][1]).toBe('done')
  })

  it('does nothing at all when the confirmation is cancelled', async () => {
    answerConfirm(false)
    dragToDone(await renderBoard())

    await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1))
    expect(h.moveTask).not.toHaveBeenCalled()
    // 取消不是失败:横幅不该冒出「Could not move the task」。
    expect(screen.queryByText(/Could not move the task/i)).toBeNull()
    expectStillInTodo()
  })

  it('does not ask when every item is already ticked', async () => {
    boardHolds({ _checklist_done: 7, _checklist_total: 7 })
    const asked = answerConfirm(true)
    dragToDone(await renderBoard())

    await waitFor(() => expect(h.moveTask).toHaveBeenCalledTimes(1))
    expect(asked).not.toHaveBeenCalled()
  })

  it('does not ask when the task has no checklist at all', async () => {
    boardHolds({ _checklist_done: 0, _checklist_total: 0 })
    const asked = answerConfirm(true)
    dragToDone(await renderBoard())

    await waitFor(() => expect(h.moveTask).toHaveBeenCalledTimes(1))
    expect(asked).not.toHaveBeenCalled()
  })

  it('does not ask when the task is only moving to In Progress', async () => {
    const asked = answerConfirm(true)
    const card = await renderBoard()

    fireEvent.dragStart(card)
    fireEvent.drop(screen.getByTestId('column-in_progress'))

    await waitFor(() => expect(h.moveTask).toHaveBeenCalledTimes(1))
    expect(asked).not.toHaveBeenCalled()
  })
})

describe('mobile 卡上的 → Done', () => {
  /** mobile 卡上的换栏钮;栏位分页钮叫 "Done (0)",不会撞到。 */
  function tapMoveToDone() {
    fireEvent.click(screen.getByRole('button', { name: '→ Done' }))
  }

  it('asks before closing a task that still has open items', async () => {
    const confirmed = answerConfirm(true)
    await renderBoard()

    tapMoveToDone()

    await waitFor(() => expect(h.moveTask).toHaveBeenCalledTimes(1))
    expect(confirmed).toHaveBeenCalledWith(PROMPT)
    expect(h.moveTask.mock.calls[0][1]).toBe('done')
  })

  it('does nothing at all when the confirmation is cancelled', async () => {
    answerConfirm(false)
    await renderBoard()

    tapMoveToDone()

    await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1))
    expect(h.moveTask).not.toHaveBeenCalled()
    expect(screen.queryByText(/Could not move the task/i)).toBeNull()
    expectStillInTodo()
  })
})

describe('详情弹窗的 Move to → Done', () => {
  it('asks before closing a task that still has open items', async () => {
    const confirmed = answerConfirm(true)
    await moveToDoneFromModal(await renderBoard())

    await waitFor(() => expect(h.moveTask).toHaveBeenCalledTimes(1))
    expect(confirmed).toHaveBeenCalledWith(PROMPT)
    expect(h.moveTask.mock.calls[0][1]).toBe('done')
  })

  it('does nothing at all when the confirmation is cancelled', async () => {
    answerConfirm(false)
    await moveToDoneFromModal(await renderBoard())

    await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1))
    expect(h.moveTask).not.toHaveBeenCalled()
    // 弹窗还开着,状态标签还是 To Do,而且没有报错 —— 取消不是失败。
    expect(screen.queryByText(/Could not move the task/i)).toBeNull()
    expect(screen.getByRole('button', { name: 'To Do' })).toBeTruthy()
    expectStillInTodo()
  })
})
