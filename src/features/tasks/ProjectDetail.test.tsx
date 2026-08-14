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
// 5. 头部的 done/total/overdue 来自 project_progress view(以 status 计数),板上
//    搬一次卡它就过期一次。搬动之后不重拉,这一页最重要的那个数字会跟它底下的
//    板互相打脸:卡片躺在 Done,头部还写着 0/1、还亮着「⚠ 1 overdue」。反向也要
//    钉住 —— 确认被取消、写入被挡下来都不算搬动,再补一次读只是每次取消都白跑。
// 6. 换一个 :id 是换一个专案,两个 firstLoad 都得回到 true。少一个,新专案的读
//    还没落地之前,画面会拿上一个专案的头部或板当成这一个的。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
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
  // 详情弹窗一开就读这三笔(子项 / 留言 / 附件)。放着不管会回 undefined,
  // ChecklistEditor 当场炸在 items.length 上 —— 跟这一页要验的事毫无关系。
  fetchChecklist:       vi.fn(),
  fetchComments:        vi.fn(),
  fetchAttachments:     vi.fn(),
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
  fetchComments:        h.fetchComments,
  fetchAttachments:     h.fetchAttachments,
  uploadAttachment:     vi.fn(),
  deleteAttachment:     vi.fn(),
  fetchChecklist:       h.fetchChecklist,
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

// useBoardTasks 会订阅 tasks 的 realtime。不换掉这支 client,测试会拿 .env.local
// 里那组真的设定,对正式站开一条 WebSocket —— 测试不该连线,更不该连去 prod。
// 只补它真的用到的两支;on / subscribe 照 supabase-js 的形状回传 channel 本身,
// 链式呼叫才接得起来。
vi.mock('../../shared/lib/supabase', () => {
  const channel = {
    on:        (): unknown => channel,
    subscribe: (): unknown => channel,
  }
  return { supabase: { channel: () => channel, removeChannel: () => undefined } }
})

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
  h.fetchChecklist.mockResolvedValue([])
  h.fetchComments.mockResolvedValue([])
  h.fetchAttachments.mockResolvedValue([])
  h.moveTask.mockResolvedValue(OK)
  h.updateTask.mockResolvedValue(OK)
  h.createTask.mockResolvedValue(OK)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/**
 * 从 /team/projects/proj-1 进这一页 —— :id 得真的从路由来。
 *
 * `extra` 挂在同一条 route 底下、页面的旁边:它得在全屏 loader 升起来的时候
 * 还活着,所以不能塞进页面里面(页面一挡就整个 return 掉了)。
 */
function renderPage(extra?: ReactNode) {
  return render(
    <MemoryRouter initialEntries={['/team/projects/proj-1']}>
      <Routes>
        <Route path="/team/projects/:id" element={<>{extra}<ProjectDetailPage /></>} />
      </Routes>
    </MemoryRouter>,
  )
}

/** 渲染并等第一次载入落地(全屏 loader 退场)。 */
async function renderLoaded(extra?: ReactNode) {
  renderPage(extra)
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

/**
 * 头部那三个数字是这一页存在的理由,而它们不是从板上那份任务算出来的 ——
 * 来自 project_progress view(以 `status = 'done'` 计数)。板上搬一次卡,它就
 * 过期一次:卡片躺在 Done,头部还写着 1/4、还亮着「⚠ 2 overdue」,而使用者
 * 会信哪一边完全看运气。
 *
 * 通知挂在 useBoardTasks 的 onMoved 上(不是在这一页的 onMove 后面补一句),
 * 所以这里连**两个入口**一起钉:板上的拖放走 handleMove,详情弹窗的 "Move to"
 * 直接呼叫 moveOptimistic、绕过 handleMove。
 *
 * 反向的三则一样重要 —— 少了它们,「搬动之后要重读」很容易被写成「每次碰到
 * 搬动这段程式码就重读」:使用者每按一次取消、每被 RLS 挡一次,就白跑一趟。
 */
describe('搬动落地之后,头部的数字要跟着走', () => {
  /**
   * 一份最小的 project_progress:数字只在写入落地时才动。断言因此吃的是
   * 「搬动之后有没有再读一次」,不是一份写死的期望值 —— 没重读的实作会把
   * 旧数字原封不动留在画面上,那正是这几则要抓的东西。
   */
  function countedByStatus() {
    const counts = { done: 1, overdue: 2 }
    h.fetchProject.mockImplementation(async () => ({
      ...PROJECT,
      done_tasks:    counts.done,
      overdue_tasks: counts.overdue,
    }))
    h.moveTask.mockImplementation(async (_id: string, status: TaskStatus) => {
      // t1 进 Done:分子 +1,而它那笔逾期也不再算逾期(view 不数已完成的)。
      if (status === 'done') { counts.done = 2; counts.overdue = 1 }
      return OK
    })
  }

  it('re-reads the header once a dragged card lands in Done', async () => {
    countedByStatus()
    await renderLoaded()
    expect(screen.getByText('1/4')).toBeTruthy()

    fireEvent.dragStart(screen.getByTestId('task-card-t1'))
    fireEvent.drop(screen.getByTestId('column-done'))

    expect(await screen.findByText('2/4')).toBeTruthy()
    expect(screen.getByTestId('project-progress-bar').getAttribute('style')).toContain('width: 50%')
    // 「⚠ 2 overdue」亮在一张已经躺进 Done 的卡正上方,是这条 bug 最刺眼的一面。
    expect(screen.getByText('⚠ 1 overdue')).toBeTruthy()
    expect(orderIn('done')).toEqual(['t1'])
    expect(h.fetchProject).toHaveBeenCalledTimes(2)
  })

  it('re-reads the header for a move made from the detail modal', async () => {
    countedByStatus()
    await renderLoaded()

    fireEvent.click(screen.getByTestId('task-card-t1'))
    // 弹窗的 "Move to" 钮;mobile 卡上的是 "→ Done",栏位分页钮是 "Done (0)"。
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }))

    expect(await screen.findByText('2/4')).toBeTruthy()
    expect(h.fetchProject).toHaveBeenCalledTimes(2)
  })

  it('does not re-read the header when the Done confirmation is cancelled', async () => {
    const asked = vi.spyOn(window, 'confirm').mockReturnValue(false)
    h.fetchBoardTasks.mockResolvedValue([task('t1', { _checklist_done: 4, _checklist_total: 7 })])
    await renderLoaded()

    fireEvent.dragStart(screen.getByTestId('task-card-t1'))
    fireEvent.drop(screen.getByTestId('column-done'))

    await waitFor(() => expect(asked).toHaveBeenCalledTimes(1))
    await act(async () => {})   // 让所有还没落地的 promise 走完,再数次数
    // 取消 = 没有写入、没有乐观更新,也就没有任何数字会变。
    expect(h.moveTask).not.toHaveBeenCalled()
    expect(h.fetchProject).toHaveBeenCalledTimes(1)
  })

  it('does not re-read the header when the write is rejected and rolled back', async () => {
    h.moveTask.mockResolvedValue(BLOCKED)
    await renderLoaded()

    fireEvent.dragStart(screen.getByTestId('task-card-t1'))
    fireEvent.drop(screen.getByTestId('column-done'))

    expect(await screen.findByText(/Could not move the task/i)).toBeTruthy()
    await waitFor(() => expect(orderIn('todo')).toEqual(['t1']))
    // status 从头到尾没变过,view 的数字也就没变过 —— 1/4 留在这里是对的。
    expect(h.fetchProject).toHaveBeenCalledTimes(1)
    expect(screen.getByText('1/4')).toBeTruthy()
  })

  /**
   * 整栏重新编号只改 position。done/total/overdue 没有一个看得到 position,
   * 所以它不是「又一次搬动落地」—— 一次搬动就该只对应一次读。
   */
  it('does not re-read the header for a renumber that only rewrites positions', async () => {
    // 两张卡已经挤到 needsRebalance 的门槛边上,再插一次中点就切不开了。
    h.fetchBoardTasks.mockResolvedValue([
      task('a', { position: 1024 }),
      task('b', { position: 1024.00005 }),
      task('c', { position: 3072 }),
    ])
    await renderLoaded()

    // 落点是 dragStart 之后才挂上去的,所以一定要拖起来才查得到。
    fireEvent.dragStart(screen.getByTestId('task-card-c'))
    fireEvent.drop(screen.getByTestId('drop-before-b'))

    await waitFor(() => expect(h.updateTask).toHaveBeenCalledTimes(3))
    expect(h.fetchProject).toHaveBeenCalledTimes(2)
  })
})

/**
 * 换一个 :id 是换一个专案,不是重新整理同一个。两个 firstLoad(这一页的、板的)
 * 都得回到 true,否则新专案的读还没落地之前,画面会拿上一个专案的头部或板
 * 当成这一个的 —— 而它们没有一处看得出来自己是旧的。
 *
 * 两则各钉一个 firstLoad:让其中一笔读落地、另一笔悬着,画面就只剩另一边那个
 * 旗标撑得住 loader。合成一则会变成「补一个就全绿」,漏掉的那个永远不会被抓到。
 */
describe('换一个 :id 就是换一个专案', () => {
  /**
   * 在同一条 route 上把 :id 换掉 —— 元件不重新挂载,useParams 直接换个值。
   * 今天 UI 上走不到这条路(这一页唯一的出口是回清单,回去再进来是重新挂载),
   * 这颗钮是为了驱动那件事本身:专案切换器、上一个/下一个之类的第二个入口一加,
   * 这就是使用者真的会走的路径,而那次改动没有理由回头看 firstLoad。
   */
  function OpenOther() {
    const nav = useNavigate()
    return <button onClick={() => nav('/team/projects/proj-2')}>Open proj-2</button>
  }

  const OTHER: Project = { ...PROJECT, id: 'proj-2', name: 'Roastery Fit-out' }

  it('does not leave the previous header up while the next project loads', async () => {
    await renderLoaded(<OpenOther />)
    // 新专案的板由这里放行;专案本体一直悬着。
    let releaseBoard: (rows: Task[]) => void = () => {}
    h.fetchBoardTasks.mockImplementationOnce(() => new Promise<Task[]>(r => { releaseBoard = r }))
    h.fetchProject.mockImplementation(() => new Promise<Project>(() => {}))

    fireEvent.click(screen.getByRole('button', { name: 'Open proj-2' }))
    await waitFor(() => expect(h.fetchBoardTasks).toHaveBeenCalledTimes(2))
    await act(async () => { releaseBoard([task('t9', { project_id: 'proj-2' })]) })

    // 板落地了、专案本体还没 —— 这时撑住画面的只剩这一页自己的 firstLoad。
    expect(screen.getByText(/Loading project/i)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Bean Sourcing' })).toBeNull()
  })

  it('does not leave the previous board up while the next project loads', async () => {
    await renderLoaded(<OpenOther />)
    // 这次反过来:专案本体由这里放行,板一直悬着。
    let releaseProject: (p: Project) => void = () => {}
    h.fetchProject.mockImplementationOnce(() => new Promise<Project>(r => { releaseProject = r }))
    h.fetchBoardTasks.mockImplementation(() => new Promise<Task[]>(() => {}))

    fireEvent.click(screen.getByRole('button', { name: 'Open proj-2' }))
    await waitFor(() => expect(h.fetchProject).toHaveBeenCalledTimes(2))
    await act(async () => { releaseProject(OTHER) })

    // 专案本体落地了、板还没 —— 撑住画面的只剩 useBoardTasks 的 firstLoad。
    // 少了它,上一个专案的卡会挂在新专案的名字底下。
    expect(screen.getByText(/Loading project/i)).toBeTruthy()
    expect(screen.queryByTestId('task-card-t1')).toBeNull()
  })
})
