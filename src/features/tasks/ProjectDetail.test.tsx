// @vitest-environment jsdom
//
// /team/projects/:id —— 上半是专案本身,下半是同一块 Kanban,只查这个专案的任务。
//
// 这一页最容易悄悄坏掉的几件事:
//
// 1. 专案读失败必须说出来,不能退化成一块空板。「读不到这个专案」跟「这个专案
//    还没有任务」在画面上长得一模一样(三栏各一句 "No tasks here yet"),而使用者
//    会信板上那句 —— 那正是整个 Tasks 模块重建的起点(见 api.reads.test.ts 顶端)。
//    所以两种情境都测,而且互为对照组:少了「真的没有任务」那一则,把整块板
//    无条件藏起来也会全绿。
// 2. 参与者是从任务推导的(owner + 所有 assignee),不是另一张成员表。
// 3. 板的搬动逻辑跟 /team/tasks 共用 useBoardTasks —— 这里驱动一次,确认乐观
//    更新、回滚与横幅在这一页上同样接得起来。抽 hook 的时候只让其中一页接对线
//    是最容易发生的事。
// 4. 从这一页建的任务要归给这个专案,否则它当场从这块板上消失(这块板只查
//    这个专案),使用者只会看到「刚建的东西不见了」。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import type { WriteOutcome } from '../../shared/lib/db-write'
import type { Project, Task, TaskStatus } from './types'

const h = vi.hoisted(() => ({
  fetchProject:         vi.fn(),
  fetchBoardTasks:      vi.fn(),
  fetchAssignableStaff: vi.fn(),
  fetchTags:            vi.fn(),
  moveTask:             vi.fn(),
  updateTask:           vi.fn(),
  createTask:           vi.fn(),
  /** useCan() 实际吃的那份能力表;逐案改写,用来验证 manage_projects 的闸门。 */
  roleCaps: { value: { manager: { manage_projects: true } } as Record<string, Record<string, boolean>> },
}))

vi.mock('./api', () => ({
  fetchProject:         h.fetchProject,
  fetchBoardTasks:      h.fetchBoardTasks,
  fetchAssignableStaff: h.fetchAssignableStaff,
  fetchTags:            h.fetchTags,
  moveTask:             h.moveTask,
  updateTask:           h.updateTask,
  createTask:           h.createTask,
  fetchProjects:        vi.fn(),
  createProject:        vi.fn(),
  updateProject:        vi.fn(),
  deleteProject:        vi.fn(),
  deleteTask:           vi.fn(),
  postComment:          vi.fn(),
  fetchComments:        vi.fn(),
  fetchAttachments:     vi.fn(),
  uploadAttachment:     vi.fn(),
  deleteAttachment:     vi.fn(),
  fetchChecklist:       vi.fn(),
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

// useCan() 跑真的(它读 useAuth + roleCaps),只把 lookups 换掉 —— 与
// Tasks.*.test.tsx 同一套骨架。
vi.mock('../../shared/lib/lookups', () => ({
  useLookups: () => ({
    deptName: (slug: string) => slug,
    departmentOptions: () => [],
    roleCaps: h.roleCaps.value,
  }),
}))

const { default: ProjectDetailPage } = await import('./ProjectDetail')

const PROJECT: Project = {
  id: 'proj-1',
  name: 'Bean Sourcing',
  description: 'Find a new washed Ethiopian.',
  color: '#C4813A',
  status: 'active',
  owner_id: 'staff-1',
  start_date: '2026-08-01',
  due_date: '2026-09-30',
  created_by: 'staff-1',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  owner: { id: 'staff-1', name: 'Yong Tan', avatar: null },
  total_tasks: 4,
  done_tasks: 1,
  overdue_tasks: 2,
}

const STAFF = [
  { id: 'staff-1', name: 'Yong Tan',   avatar: null },
  { id: 'staff-2', name: 'Amy Cheah',  avatar: null },
  { id: 'staff-3', name: 'Bala Nair',  avatar: null },
  { id: 'staff-4', name: 'Chan Wei',   avatar: null },
]

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
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
    ...patch,
  }
}

const OK: WriteOutcome = { ok: true }
const BLOCKED: WriteOutcome = { ok: false, reason: 'it was not saved — you may have been signed out.' }
const BOOM = 'permission denied for table projects'

beforeEach(() => {
  vi.resetAllMocks()
  h.roleCaps.value = { manager: { manage_projects: true } }
  h.fetchProject.mockResolvedValue({ ...PROJECT })
  h.fetchBoardTasks.mockImplementation(async () => [task('t1')])
  h.fetchAssignableStaff.mockResolvedValue(STAFF)
  h.fetchTags.mockResolvedValue([])
  h.moveTask.mockResolvedValue(OK)
  h.updateTask.mockResolvedValue(OK)
  h.createTask.mockResolvedValue(OK)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** 从 /team/projects/proj-1 进这一页 —— :id 得真的从路由来。 */
function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/team/projects/proj-1']}>
      <Routes>
        <Route path="/team/projects/:id" element={<ProjectDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

/** 渲染并等第一次载入落地(全屏 loader 退场)。 */
async function renderLoaded() {
  renderPage()
  await waitFor(() => expect(screen.queryByText(/Loading project/i)).toBeNull())
}

/** 一栏由上到下的卡片 id —— 这才是使用者看到的顺序。 */
function orderIn(col: TaskStatus): string[] {
  return within(screen.getByTestId(`column-${col}`))
    .queryAllByTestId(/^task-card-/)
    .map(el => el.getAttribute('data-testid')!.replace('task-card-', ''))
}

describe('专案头部', () => {
  it('reads the board scoped to this project', async () => {
    await renderLoaded()

    expect(h.fetchProject).toHaveBeenCalledWith('proj-1')
    expect(h.fetchBoardTasks).toHaveBeenCalledWith({ projectId: 'proj-1' })
  })

  it('shows the name, owner, dates, status and progress', async () => {
    await renderLoaded()

    expect(screen.getByRole('heading', { name: 'Bean Sourcing' })).toBeTruthy()
    expect(screen.getByText('Find a new washed Ethiopian.')).toBeTruthy()
    expect(screen.getByText('Active')).toBeTruthy()
    // jsdom 把 hex 正规化成 rgb() —— 比对的是同一个颜色。
    expect(screen.getByTestId('project-color-dot').getAttribute('style')).toContain('rgb(196, 129, 58)')
    expect(screen.getByText('Yong Tan')).toBeTruthy()
    // 专案会跨年,日期一定要带着年份读得出来。
    expect(screen.getByText(/Aug.*2026/)).toBeTruthy()
    expect(screen.getByText(/Sep.*2026/)).toBeTruthy()
    // 进度来自 project_progress view,不是板上那份任务:Done 栏有 14 天时间窗,
    // 拿板上的卡去数,做完超过两周的任务会从分子里消失,进度条自己往回走。
    expect(screen.getByTestId('project-progress-bar').getAttribute('style')).toContain('width: 25%')
    expect(screen.getByText('1/4')).toBeTruthy()
    expect(screen.getByText('⚠ 2 overdue')).toBeTruthy()
  })

  it('leaves the overdue count off when nothing is overdue', async () => {
    h.fetchProject.mockResolvedValue({ ...PROJECT, overdue_tasks: 0 })
    await renderLoaded()

    expect(screen.queryByText(/overdue/i)).toBeNull()
  })
})

describe('参与者由任务推导', () => {
  it('lists the owner plus everyone assigned a task, and nobody else', async () => {
    h.fetchBoardTasks.mockResolvedValue([
      task('t1', { assigned_to: 'staff-2' }),
      task('t2', { assigned_to: 'staff-3' }),
      task('t3', { assigned_to: 'staff-2' }),   // 同一个人只算一次
      task('t4', { assigned_to: null }),
    ])
    await renderLoaded()

    const on = screen.getByTestId('project-participants')
    // owner(staff-1)即使一张任务都没分到也算参与者。
    expect(within(on).getByTestId('participant-staff-1')).toBeTruthy()
    expect(within(on).getByTestId('participant-staff-2')).toBeTruthy()
    expect(within(on).getByTestId('participant-staff-3')).toBeTruthy()
    // staff-4 在名单里但跟这个专案无关 —— 会跑出来就代表这一列画的是
    // 「全公司」而不是「谁在做这个专案」。
    expect(within(on).queryByTestId('participant-staff-4')).toBeNull()
    expect(within(on).getAllByTestId(/^participant-/)).toHaveLength(3)
  })

  it('says nobody is on it when there is no owner and no assignee', async () => {
    h.fetchProject.mockResolvedValue({ ...PROJECT, owner_id: null, owner: null })
    h.fetchBoardTasks.mockResolvedValue([task('t1', { assigned_to: null, assignee: null })])
    await renderLoaded()

    expect(within(screen.getByTestId('project-participants')).getByText('Nobody yet')).toBeTruthy()
  })
})

describe('读取失败不得长成一块空板', () => {
  it('shows the failed project read instead of an empty board', async () => {
    h.fetchProject.mockRejectedValue(new Error(BOOM))
    await renderLoaded()

    expect(screen.getByTestId('project-detail-error').textContent).toContain(BOOM)
    // 关键的反向断言:读不到专案时,三栏「No tasks here yet」比错误横幅
    // 更像资料,使用者会信板上那句。
    expect(screen.queryByTestId('column-todo')).toBeNull()
    expect(screen.queryByText('No tasks here yet')).toBeNull()
  })

  it('shows the failed board read instead of three empty columns', async () => {
    h.fetchBoardTasks.mockRejectedValue(new Error('permission denied for table tasks'))
    await renderLoaded()

    expect(screen.getByTestId('project-detail-error').textContent).toContain('permission denied for table tasks')
    expect(screen.queryByText('No tasks here yet')).toBeNull()
  })

  /** 上面两则的对照组:真的没有任务,就要看得出来「这里本来就没有东西」。 */
  it('still draws an empty board for a project that genuinely has no tasks', async () => {
    h.fetchBoardTasks.mockResolvedValue([])
    await renderLoaded()

    expect(screen.queryByTestId('project-detail-error')).toBeNull()
    expect(screen.getByTestId('column-todo')).toBeTruthy()
    expect(screen.getAllByText('No tasks here yet').length).toBeGreaterThan(0)
  })

  it('Retry re-reads both the project and the board', async () => {
    h.fetchProject.mockRejectedValueOnce(new Error(BOOM)).mockResolvedValue({ ...PROJECT })
    await renderLoaded()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByRole('heading', { name: 'Bean Sourcing' })).toBeTruthy()
    await waitFor(() => expect(screen.queryByTestId('project-detail-error')).toBeNull())
    expect(h.fetchBoardTasks).toHaveBeenCalledTimes(2)
  })
})

describe('板的搬动逻辑在这一页上也接得起来', () => {
  it('moves a card across columns and writes it', async () => {
    await renderLoaded()

    fireEvent.dragStart(screen.getByTestId('task-card-t1'))
    fireEvent.drop(screen.getByTestId('column-done'))

    await waitFor(() => expect(h.moveTask).toHaveBeenCalledTimes(1))
    expect(h.moveTask.mock.calls[0]).toEqual(['t1', 'done', 1024])
    expect(orderIn('done')).toEqual(['t1'])
    expect(orderIn('todo')).toEqual([])
  })

  it('rolls the card back and says so when the write is silently rejected', async () => {
    h.moveTask.mockResolvedValue(BLOCKED)
    await renderLoaded()

    fireEvent.dragStart(screen.getByTestId('task-card-t1'))
    fireEvent.drop(screen.getByTestId('column-done'))

    expect(await screen.findByText(/Could not move the task/i)).toBeTruthy()
    await waitFor(() => expect(orderIn('todo')).toEqual(['t1']))
    expect(orderIn('done')).toEqual([])
  })

  it('asks before closing a task that still has open items', async () => {
    const asked = vi.spyOn(window, 'confirm').mockReturnValue(false)
    h.fetchBoardTasks.mockResolvedValue([task('t1', { _checklist_done: 4, _checklist_total: 7 })])
    await renderLoaded()

    fireEvent.dragStart(screen.getByTestId('task-card-t1'))
    fireEvent.drop(screen.getByTestId('column-done'))

    await waitFor(() => expect(asked).toHaveBeenCalledWith('Still 3 of 7 items open. Mark as done anyway?'))
    // 取消 = 什么都没发生,连乐观更新都不准跑。
    expect(h.moveTask).not.toHaveBeenCalled()
    expect(orderIn('todo')).toEqual(['t1'])
  })
})

describe('从这一页开的表单', () => {
  it('files a new task under this project', async () => {
    await renderLoaded()

    fireEvent.click(screen.getByRole('button', { name: '+ New Task' }))
    fireEvent.change(screen.getByPlaceholderText('What needs to be done...'), {
      target: { value: 'Cup the samples' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))

    await waitFor(() => expect(h.createTask).toHaveBeenCalledTimes(1))
    // 归错专案(或归 null)的任务当场从这块板上消失 —— 这块板只查 proj-1。
    expect(h.createTask.mock.calls[0][0].project_id).toBe('proj-1')
    expect(h.createTask.mock.calls[0][0].position).toBe(2048)
  })

  it('opens the project editor behind manage_projects', async () => {
    await renderLoaded()

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    expect(await screen.findByRole('heading', { name: 'Edit Project' })).toBeTruthy()
  })

  it('hides Edit without manage_projects', async () => {
    h.roleCaps.value = { manager: { manage_projects: false } }
    await renderLoaded()

    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Bean Sourcing' })).toBeTruthy()
  })
})
