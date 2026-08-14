// @vitest-environment jsdom
//
// 两件在 refactor 之后被破坏、但纯逻辑测试照不到的「接线」:
//
// 1. 重新拉板必须是背景更新。load() 一旦切「读取中」,整页只剩一句
//    "Loading tasks...",于是每次存档 / 上传 / 留言都会把整棵树连同开着的
//    详情弹窗一起卸载 —— 使用者刚打好、还没存档的内容就这样消失。
// 2. 桌面三栏与 mobile 单栏同时挂在 DOM(靠 CSS 二选一显示),jsdom 不套 CSS
//    所以两边都在。mobile 那份的拖放 handler 是空的,若两边共用同一组
//    data-testid,测试抓错一份就会以「moveTask 没被呼叫」失败,指向完全无关的
//    程式码。本档一律用 bare getByTestId:再撞名就会直接以
//    "Found multiple elements" 炸掉,而不是变成看不懂的 no-op。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { WriteOutcome } from '../../shared/lib/db-write'
import type { Task } from './types'

const h = vi.hoisted(() => ({
  fetchBoardTasks:  vi.fn(),
  moveTask:         vi.fn(),
  postComment:      vi.fn(),
  fetchComments:    vi.fn(),
  fetchAttachments: vi.fn(),
  fetchTags:        vi.fn(),
  fetchChecklist:   vi.fn(),
}))

vi.mock('./api', () => ({
  fetchBoardTasks:  h.fetchBoardTasks,
  moveTask:         h.moveTask,
  postComment:      h.postComment,
  fetchComments:    h.fetchComments,
  fetchAttachments: h.fetchAttachments,
  fetchTags:        h.fetchTags,
  fetchChecklist:   h.fetchChecklist,
  createTask:       vi.fn(),
  updateTask:       vi.fn(),
  deleteTask:       vi.fn(),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  upsertTag:        vi.fn(),
  attachTag:        vi.fn(),
  detachTag:        vi.fn(),
  addChecklistItem:    vi.fn(),
  setChecklistDone:    vi.fn(),
  setChecklistAssignee: vi.fn(),
  deleteChecklistItem: vi.fn(),
}))

// 页面层只剩 staff 下拉还直接打 supabase,给它一份空清单就够。
vi.mock('../../shared/lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }),
  },
}))

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ staff: { id: 'staff-1', name: 'Yong Tan', rank: 'manager' } }),
}))

// useCan() 读 roleCaps 决定 "Manage tags" 钮显不显示;mock 的 staff 是
// rank: 'manager',所以只需要给 manager 这一格,与 DEFAULT_SYSTEM_ROLE_CAPS
// 的 manager.manage_projects 保持一致。
vi.mock('../../shared/lib/lookups', () => ({
  useLookups: () => ({
    deptName: (slug: string) => slug,
    departmentOptions: () => [],
    roleCaps: { manager: { manage_projects: true } },
  }),
}))

const { default: TasksPage } = await import('./Tasks')

const TASK: Task = {
  id: 'task-1',
  title: 'Restock the beans',
  description: 'Original description',
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
  _checklist_done:   0,
  _checklist_total:  0,
}

const OK: WriteOutcome = { ok: true }
const BLOCKED: WriteOutcome = { ok: false, reason: 'it was not saved — you may have been signed out.' }

beforeEach(() => {
  vi.resetAllMocks()
  // 每次重拉都回传全新的物件,模拟真的重新查过资料库。
  h.fetchBoardTasks.mockImplementation(async () => [{ ...TASK }])
  h.fetchComments.mockResolvedValue([])
  h.fetchAttachments.mockResolvedValue([])
  h.fetchTags.mockResolvedValue([])
  h.fetchChecklist.mockResolvedValue([])
  h.postComment.mockResolvedValue(OK)
  h.moveTask.mockResolvedValue(OK)
})
afterEach(cleanup)

/** 渲染并等第一次拉板落地,回传桌面版那张卡。 */
async function renderBoard(): Promise<HTMLElement> {
  render(<TasksPage />)
  return await screen.findByTestId('task-card-task-1')
}

/** 开详情弹窗,并进入编辑模式。 */
async function openEditor(card: HTMLElement) {
  fireEvent.click(card)
  fireEvent.click(await screen.findByRole('button', { name: 'Edit Task' }))
  return screen.getByPlaceholderText('More details...') as HTMLTextAreaElement
}

/** 走 CommentThread.onPosted → 页面层 load(),就是每次背景刷新走的那条路。 */
function postAComment() {
  fireEvent.change(screen.getByPlaceholderText('Add a comment...'), { target: { value: 'ping' } })
  fireEvent.click(screen.getByRole('button', { name: 'Post' }))
}

/**
 * 让下一次重拉悬着不 resolve,回传放行的手把。
 *
 * 这一步不是排场:mock 若当场 resolve,「卸下整棵树」与「挂回来」会被压进同一个
 * React batch,画面根本来不及换成 loader —— 刚好把这个 bug 藏得干干净净。
 * 真实网路有往返时间,所以这里也必须把那段空档撑开。
 */
function holdNextRefresh(): () => Promise<void> {
  let release: (rows: Task[]) => void = () => {}
  h.fetchBoardTasks.mockImplementationOnce(() => new Promise<Task[]>(r => { release = r }))
  return async () => {
    release([{ ...TASK }])
    await waitFor(() => expect(screen.getByTestId('task-card-task-1')).toBeTruthy())
  }
}

describe('背景重拉不得卸载开着的弹窗', () => {
  it('keeps unsaved edits in the open detail modal across a refresh', async () => {
    const description = await openEditor(await renderBoard())
    fireEvent.change(description, { target: { value: 'Half-typed, not saved yet' } })

    const finishRefresh = holdNextRefresh()
    postAComment()
    await waitFor(() => expect(h.fetchBoardTasks).toHaveBeenCalledTimes(2))
    await finishRefresh()

    // 弹窗还在、还在编辑模式、刚打的字一个都没掉。
    const after = screen.getByPlaceholderText('More details...') as HTMLTextAreaElement
    expect(after.value).toBe('Half-typed, not saved yet')
  })

  it('never shows the full-screen loader while a refresh is in flight', async () => {
    await openEditor(await renderBoard())

    const finishRefresh = holdNextRefresh()
    postAComment()
    await waitFor(() => expect(h.fetchBoardTasks).toHaveBeenCalledTimes(2))

    // 画面定格在「刷新进行中」那一刻:板还在,弹窗也还在编辑模式。
    expect(screen.queryByText(/Loading tasks/i)).toBeNull()
    expect(screen.getByPlaceholderText('More details...')).toBeTruthy()

    await finishRefresh()
  })

  it('still shows the full-screen loader for the very first load', () => {
    h.fetchBoardTasks.mockImplementationOnce(() => new Promise<Task[]>(() => {}))
    render(<TasksPage />)
    expect(screen.getByText(/Loading tasks/i)).toBeTruthy()
  })
})

describe('板上的 data-testid 必须唯一,而且指向真的会动的那一份', () => {
  it('resolves column-* and task-card-* to exactly one element each', async () => {
    await renderBoard()
    expect(screen.getAllByTestId('task-card-task-1')).toHaveLength(1)
    expect(screen.getAllByTestId('column-todo')).toHaveLength(1)
    expect(screen.getAllByTestId('column-done')).toHaveLength(1)
    // mobile 那一份还在,只是换了命名空间。
    expect(screen.getByTestId('mobile-column-todo')).toBeTruthy()
    expect(screen.getByTestId('mobile-task-card-task-1')).toBeTruthy()
  })

  it('drops the bare-testid card onto the bare-testid column and actually writes', async () => {
    const card = await renderBoard()

    fireEvent.dragStart(card)
    fireEvent.drop(screen.getByTestId('column-done'))

    await waitFor(() => expect(h.moveTask).toHaveBeenCalledTimes(1))
    expect(h.moveTask.mock.calls[0][0]).toBe('task-1')
    expect(h.moveTask.mock.calls[0][1]).toBe('done')
  })
})

describe('写入没落地时卡片要回到原栏', () => {
  it('puts the card back under To Do and out of Done when the write is silently rejected by RLS', async () => {
    // 这是 RLS 挡掉时的真实形状:没有 error,也没有 rows(见 db-write.ts writeOutcome)。
    h.moveTask.mockResolvedValue(BLOCKED)
    const card = await renderBoard()

    fireEvent.dragStart(card)
    fireEvent.drop(screen.getByTestId('column-done'))

    await waitFor(() => {
      expect(screen.getByTestId('column-todo').textContent).toMatch(/Restock the beans/)
    })
    expect(screen.getByTestId('column-done').textContent).not.toMatch(/Restock the beans/)
  })
})

describe('换栏失败要说在使用者看得到的地方', () => {
  it('clears the board banner once a later drag succeeds', async () => {
    h.moveTask.mockResolvedValueOnce(BLOCKED)
    const card = await renderBoard()

    fireEvent.dragStart(card)
    fireEvent.drop(screen.getByTestId('column-done'))
    expect(await screen.findByText(/Could not move the task/i)).toBeTruthy()

    fireEvent.dragStart(screen.getByTestId('task-card-task-1'))
    fireEvent.drop(screen.getByTestId('column-in_progress'))

    await waitFor(() => expect(screen.queryByText(/Could not move the task/i)).toBeNull())
  })

  it('clears a stale board banner once a later move through the detail modal succeeds', async () => {
    // 先让一次拖放失败,留下页面横幅 —— 这条路走 handleBoardMove。
    h.moveTask.mockResolvedValueOnce(BLOCKED)
    const card = await renderBoard()

    fireEvent.dragStart(card)
    fireEvent.drop(screen.getByTestId('column-done'))
    expect(await screen.findByText(/Could not move the task/i)).toBeTruthy()

    // 再从详情弹窗成功换栏 —— 这条路直接呼叫 moveOptimistic,不经过
    // handleBoardMove,横幅原本不会被这条路径收掉。
    // 注意:失败那趟的乐观更新 + 回滚,让这张卡先搬去 done 栏又搬回 todo
    // 栏 —— 两栏是不同的 KanbanColumn 实例,卡片的 DOM 节点被整个换掉,
    // 所以这里要重新查一次,不能沿用拖放前那个已经脱离文件的 `card`。
    h.moveTask.mockResolvedValueOnce(OK)
    fireEvent.click(screen.getByTestId('task-card-task-1'))
    fireEvent.click(await screen.findByRole('button', { name: 'In Progress' }))

    await waitFor(() => expect(screen.queryByText(/Could not move the task/i)).toBeNull())
  })

  it('reports a move failed from the detail modal inside the modal, not on the covered banner', async () => {
    h.moveTask.mockResolvedValue(BLOCKED)
    const card = await renderBoard()
    fireEvent.click(card)

    // 弹窗的 "Move to" 钮;mobile 卡上的是 "→ In Progress",不会撞到。
    fireEvent.click(await screen.findByRole('button', { name: 'In Progress' }))

    const shown = await screen.findAllByText(/Could not move the task/i)
    expect(shown).toHaveLength(1)
    expect(shown[0].textContent).toMatch(/signed out/i)
    // 页面横幅整个被弹窗盖住,不该是唯一的报错处 —— 它连点都没被点亮。
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })
})
