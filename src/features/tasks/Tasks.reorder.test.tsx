// @vitest-environment jsdom
//
// 栏内手动排序。落点不再只是「哪一栏」,而是「哪两张卡之间」——
// 卡片上半 = 插在它之前,下半 = 插在下一张之前,栏位本体 = 放到栏尾。
//
// 三件只有接起来才看得出来的事:
//  1. 乐观更新只改 position,不动阵列顺序。板子若不依 position 排序,重排会
//     完全看不出来 —— 画面得等下一次重拉板才跳位,中间那段时间画面讲的顺序
//     和资料库讲的顺序是两回事。所以这里一律断言「整栏的顺序」,不只断言写入。
//  2. 写入被挡下时,回滚要连 position 一起回。同栏重排的 status 从头到尾没变,
//     只回滚 status 的话测试会照过,顺序却永远错着。
//  3. 反覆插中点会把 double 的间距吃光,needsRebalance 一喊就整栏重新编号;
//     那是搬动成功之后的收尾,失败不能讲成「搬不动」。
//
// 拖放一律对 bare testid 操作(桌面那一份);mobile 那一份的 draggingId 永远是
// null,所以它根本不会长出落点 —— 详见 KanbanColumn。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import type { WriteOutcome } from '../../shared/lib/db-write'
import type { Task, TaskStatus } from './types'

const h = vi.hoisted(() => ({
  fetchBoardTasks:  vi.fn(),
  moveTask:         vi.fn(),
  updateTask:       vi.fn(),
  createTask:       vi.fn(),
  fetchTags:        vi.fn(),
  fetchComments:    vi.fn(),
  fetchAttachments: vi.fn(),
  fetchChecklist:   vi.fn(),
}))

vi.mock('./api', () => ({
  fetchBoardTasks:  h.fetchBoardTasks,
  moveTask:         h.moveTask,
  updateTask:       h.updateTask,
  createTask:       h.createTask,
  fetchTags:        h.fetchTags,
  fetchComments:    h.fetchComments,
  fetchAttachments: h.fetchAttachments,
  fetchChecklist:   h.fetchChecklist,
  postComment:          vi.fn(),
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

vi.mock('../../shared/lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }),
  },
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

const OK: WriteOutcome = { ok: true }
const BLOCKED: WriteOutcome = { ok: false, reason: 'it was not saved — you may have been signed out.' }

function task(id: string, position: number, patch: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    description: null,
    status: 'todo',
    priority: 'medium',
    project_id: null,
    assigned_to: 'staff-1',
    created_by: 'staff-1',
    due_date: null,
    department: null,
    position,
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
    ...patch,
  }
}

/** To Do 栏三张卡,号码是刚建好的样子。 */
const THREE = [task('a', 1024), task('b', 2048), task('c', 3072)]

beforeEach(() => {
  vi.resetAllMocks()
  h.fetchTags.mockResolvedValue([])
  h.fetchComments.mockResolvedValue([])
  h.fetchAttachments.mockResolvedValue([])
  h.fetchChecklist.mockResolvedValue([])
  h.moveTask.mockResolvedValue(OK)
  h.updateTask.mockResolvedValue(OK)
  h.createTask.mockResolvedValue(OK)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** 这一轮看板要回传的卡。必须在 render 之前呼叫。 */
async function boardOf(rows: Task[]): Promise<void> {
  // 每次重拉都回传全新的物件,模拟真的重新查过资料库。
  h.fetchBoardTasks.mockImplementation(async () => rows.map(r => ({ ...r })))
  render(<TasksPage />)
  await screen.findByTestId(`task-card-${rows[0].id}`)
}

/** 一栏由上到下的卡片 id —— 这才是使用者看到的顺序。 */
function orderIn(col: TaskStatus): string[] {
  return within(screen.getByTestId(`column-${col}`))
    .queryAllByTestId(/^task-card-/)
    .map(el => el.getAttribute('data-testid')!.replace('task-card-', ''))
}

/**
 * 把 `cardId` 拖到 `target` 上放开。落点是 dragStart 之后才挂上去的,
 * 所以一定要拖起来才查得到 —— 这里的顺序不是排场。
 */
function dragOnto(cardId: string, target: string) {
  fireEvent.dragStart(screen.getByTestId(`task-card-${cardId}`))
  fireEvent.drop(screen.getByTestId(target))
}

describe('落在两张卡之间', () => {
  it('lands the card between the two cards it was dropped between', async () => {
    await boardOf(THREE)

    dragOnto('c', 'drop-before-b')

    await waitFor(() => expect(h.moveTask).toHaveBeenCalledTimes(1))
    expect(h.moveTask.mock.calls[0]).toEqual(['c', 'todo', 1536])
    expect(orderIn('todo')).toEqual(['a', 'c', 'b'])
  })

  it('lands the card at the top when dropped above the first card', async () => {
    await boardOf(THREE)

    dragOnto('c', 'drop-before-a')

    await waitFor(() => expect(h.moveTask).toHaveBeenCalledTimes(1))
    expect(h.moveTask.mock.calls[0]).toEqual(['c', 'todo', 0])
    expect(orderIn('todo')).toEqual(['c', 'a', 'b'])
  })

  /** 「插在这张之后」= 「插在下一张之前」;最后一张的下半就是栏尾。 */
  it('treats the bottom half of the last card as the end of the column', async () => {
    await boardOf(THREE)

    dragOnto('a', 'drop-after-c')

    await waitFor(() => expect(h.moveTask).toHaveBeenCalledTimes(1))
    expect(h.moveTask.mock.calls[0]).toEqual(['a', 'todo', 3072 + 1024])
    expect(orderIn('todo')).toEqual(['b', 'c', 'a'])
  })

  it('carries the insertion point across columns', async () => {
    await boardOf([
      ...THREE,
      task('x', 1024, { status: 'done' }),
      task('y', 2048, { status: 'done' }),
    ])

    dragOnto('a', 'drop-before-y')

    await waitFor(() => expect(h.moveTask).toHaveBeenCalledTimes(1))
    expect(h.moveTask.mock.calls[0]).toEqual(['a', 'done', 1536])
    expect(orderIn('done')).toEqual(['x', 'a', 'y'])
    expect(orderIn('todo')).toEqual(['b', 'c'])
  })
})

describe('落在栏位本体', () => {
  it('still appends to the bottom of the column', async () => {
    await boardOf([...THREE, task('x', 5000, { status: 'done' })])

    dragOnto('a', 'column-done')

    await waitFor(() => expect(h.moveTask).toHaveBeenCalledTimes(1))
    expect(h.moveTask.mock.calls[0]).toEqual(['a', 'done', 5000 + 1024])
    expect(orderIn('done')).toEqual(['x', 'a'])
  })

  it('seeds an empty column', async () => {
    await boardOf([task('a', 2048, { status: 'in_progress' })])

    dragOnto('a', 'column-todo')

    await waitFor(() => expect(h.moveTask).toHaveBeenCalledTimes(1))
    expect(h.moveTask.mock.calls[0]).toEqual(['a', 'todo', 1024])
    expect(orderIn('todo')).toEqual(['a'])
  })

  /** 同一个插入点有两条路指得到,放回原位就不该送出任何写入。 */
  it('writes nothing when the card is dropped back into the slot it came from', async () => {
    await boardOf(THREE)

    dragOnto('b', 'drop-after-a')     // a 的下半 = b 现在的位置
    dragOnto('b', 'drop-before-b')    // 丢在自己身上
    dragOnto('c', 'column-todo')      // c 本来就在栏尾

    await waitFor(() => expect(orderIn('todo')).toEqual(['a', 'b', 'c']))
    expect(h.moveTask).not.toHaveBeenCalled()
  })
})

describe('写入没落地', () => {
  /**
   * 同栏重排的 status 从头到尾都是 todo,唯一能把顺序放回去的就是 position 的
   * 回滚 —— 只回滚 status 的实作会在这里现形。
   */
  it('restores the original slot, not just the original column', async () => {
    let reject: (res: WriteOutcome) => void = () => {}
    h.moveTask.mockImplementationOnce(() => new Promise<WriteOutcome>(r => { reject = r }))
    await boardOf(THREE)

    dragOnto('c', 'drop-before-a')

    // 乐观更新已经把它排到最前面 —— 先确认这一步真的发生过,
    // 否则「回到原顺序」有可能只是因为从头到尾什么都没动。
    await waitFor(() => expect(orderIn('todo')).toEqual(['c', 'a', 'b']))

    reject(BLOCKED)
    await waitFor(() => expect(orderIn('todo')).toEqual(['a', 'b', 'c']))
    expect(await screen.findByText(/Could not move the task/i)).toBeTruthy()
  })
})

describe('整栏重新编号', () => {
  // 两张卡已经挤到 needsRebalance 的门槛边上,再插一次中点就切不开了。
  const TIGHT = [task('a', 1024), task('b', 1024.00005), task('c', 3072)]
  const SPLIT = (1024 + 1024.00005) / 2

  it('renumbers the whole column once the gaps get too small to split', async () => {
    await boardOf(TIGHT)

    dragOnto('c', 'drop-before-b')

    await waitFor(() => expect(h.updateTask).toHaveBeenCalledTimes(2))
    expect(h.moveTask.mock.calls[0]).toEqual(['c', 'todo', SPLIT])
    // a 的号码本来就对(1024),不必重写;其余两张依顺序摊回整数步长。
    expect(h.updateTask.mock.calls[0]).toEqual(['c', { position: 2048 }])
    expect(h.updateTask.mock.calls[1]).toEqual(['b', { position: 3072 }])
    // 重新编号不改顺序,而且不必为了这件事再拉一次板。
    expect(orderIn('todo')).toEqual(['a', 'c', 'b'])
    expect(h.fetchBoardTasks).toHaveBeenCalledTimes(1)
  })

  it('leaves a roomy column alone', async () => {
    await boardOf(THREE)

    dragOnto('c', 'drop-before-b')

    await waitFor(() => expect(h.moveTask).toHaveBeenCalledTimes(1))
    expect(h.updateTask).not.toHaveBeenCalled()
  })

  /**
   * 半套的重新编号会把顺序打乱成没人预期的样子(新号码可能比还没改到的旧号码
   * 小),本地无从推测,所以停手 + 重拉板。搬动本身是成功的,不能讲成「搬不动」。
   */
  it('stops at the first rejected renumber, reloads the board, and says so', async () => {
    h.updateTask.mockResolvedValueOnce(BLOCKED)
    await boardOf(TIGHT)

    dragOnto('c', 'drop-before-b')

    expect(await screen.findByText(/Could not tidy up the column order/i)).toBeTruthy()
    expect(h.updateTask).toHaveBeenCalledTimes(1)
    expect(h.fetchBoardTasks).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(/Could not move the task/i)).toBeNull()
  })
})

describe('Done 栏内重排', () => {
  /**
   * 软性完成闸门问的是「要不要现在收工」。已经在 Done 的卡换个位置不是收工,
   * 每挪一次就问一次,问的是一件早就发生过的事。
   */
  it('does not re-ask the open-items confirmation when reordering inside Done', async () => {
    const asked = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await boardOf([
      task('x', 1024, { status: 'done' }),
      task('y', 2048, { status: 'done', _checklist_done: 4, _checklist_total: 7 }),
    ])

    dragOnto('y', 'drop-before-x')

    await waitFor(() => expect(h.moveTask).toHaveBeenCalledTimes(1))
    expect(asked).not.toHaveBeenCalled()
    expect(orderIn('done')).toEqual(['y', 'x'])
  })

  it('still asks when the card is entering Done for the first time', async () => {
    const asked = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await boardOf([
      task('a', 1024, { _checklist_done: 4, _checklist_total: 7 }),
      task('x', 1024, { status: 'done' }),
    ])

    dragOnto('a', 'drop-before-x')

    await waitFor(() => expect(h.moveTask).toHaveBeenCalledTimes(1))
    expect(asked).toHaveBeenCalledWith('Still 3 of 7 items open. Mark as done anyway?')
  })
})

describe('新任务', () => {
  it('lands at the bottom of To Do', async () => {
    await boardOf(THREE)

    fireEvent.click(screen.getByRole('button', { name: '+ New Task' }))
    fireEvent.change(screen.getByPlaceholderText('What needs to be done...'), {
      target: { value: 'Descale the machine' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))

    await waitFor(() => expect(h.createTask).toHaveBeenCalledTimes(1))
    expect(h.createTask.mock.calls[0][0].position).toBe(3072 + 1024)
  })

  it('seeds an empty To Do column', async () => {
    await boardOf([task('x', 5000, { status: 'done' })])

    fireEvent.click(screen.getByRole('button', { name: '+ New Task' }))
    fireEvent.change(screen.getByPlaceholderText('What needs to be done...'), {
      target: { value: 'Descale the machine' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))

    await waitFor(() => expect(h.createTask).toHaveBeenCalledTimes(1))
    expect(h.createTask.mock.calls[0][0].position).toBe(1024)
  })
})
