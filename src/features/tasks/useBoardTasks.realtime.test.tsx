// @vitest-environment jsdom
//
// Realtime:另一个 session 动了 tasks,这块板要自己跟上。
//
// naive 版本(收到事件就 load())会踩到四件事,这个档案一件一件钉住:
//
// 1. **它真的会跟上**。别人改了一张卡,板要重拉一次。
// 2. **它不准升起全屏 loader**。背景重拉一旦卸载整棵树,开着的详情弹窗会跟着
//    重挂,使用者刚打好、还没存档的内容就这样消失。这条规则在
//    Tasks.refresh.test.tsx 已经为「存档 / 留言」那条路钉过一次,realtime 是
//    第二个入口,而且是使用者完全没动手的那个 —— 所以这里再钉一次,走真的页面。
// 3. **自己的回音不算别人的改动**。板上换栏是乐观更新,自己那一笔的广播回来
//    再拉一次不只是白跑:整栏重新编号失败时,横幅上那句「没收干净」是先 load()
//    再写上去的,晚一步到的回音会再跑一次 load(),而 load() 一成功就 setError(''),
//    那句话当场被抹掉。每一则回音测试都配一组对照:同一张卡、下一发事件,板
//    必须照样跟上 —— 否则「回音抑制」很容易写成「这张卡从此不再更新」。
// 4. **连发要收敛**。整栏重新编号是一笔一笔写的,别人做一次,这块板会连收 N 发。
//
// 另外两件接线:退订要真的发生(而且计时器要跟着收掉,不能在卸载之后才拉板),
// 换一个 projectId 不可以再开一条 channel、而且那条 channel 拉的必须是**新**专案。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, renderHook, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { WriteOutcome } from '../../shared/lib/db-write'
import type { Task } from './types'

const h = vi.hoisted(() => ({
  fetchBoardTasks:      vi.fn(),
  fetchAssignableStaff: vi.fn(),
  fetchTags:            vi.fn(),
  fetchProjects:        vi.fn(),
  fetchChecklist:       vi.fn(),
  fetchComments:        vi.fn(),
  fetchAttachments:     vi.fn(),
  moveTask:             vi.fn(),
  updateTask:           vi.fn(),
  /** 每呼叫一次 supabase.channel() 就多一笔,连同它收到的订阅条件与 handler。 */
  opened: [] as Array<{
    name: string
    filter: Record<string, unknown>
    handler: (payload: unknown) => void
    channel: unknown
    subscribed: boolean
  }>,
  /** supabase.removeChannel() 收到的那些 channel 物件。 */
  removed: [] as unknown[],
}))

vi.mock('./api', () => ({
  fetchBoardTasks:      h.fetchBoardTasks,
  fetchAssignableStaff: h.fetchAssignableStaff,
  fetchTags:            h.fetchTags,
  fetchProjects:        h.fetchProjects,
  fetchChecklist:       h.fetchChecklist,
  fetchComments:        h.fetchComments,
  fetchAttachments:     h.fetchAttachments,
  moveTask:             h.moveTask,
  updateTask:           h.updateTask,
  createTask:           vi.fn(),
  deleteTask:           vi.fn(),
  postComment:          vi.fn(),
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

/**
 * 假的 realtime client。每次 channel() 都给一个**新**物件 —— 退订那一则要能断言
 * 「收回去的就是刚开出来的那一条」,共用一个物件的话那句断言什么都证明不了。
 * on / subscribe 照 supabase-js 的形状回传 channel 本身,链式呼叫才接得起来。
 */
vi.mock('../../shared/lib/supabase', () => ({
  supabase: {
    channel(name: string) {
      const entry = {
        name,
        filter: {} as Record<string, unknown>,
        handler: (() => {}) as (payload: unknown) => void,
        channel: null as unknown,
        subscribed: false,
      }
      const ch = {
        on(
          _event: string,
          filter: Record<string, unknown>,
          handler: (payload: unknown) => void,
        ): unknown {
          entry.filter  = filter
          entry.handler = handler
          return ch
        },
        subscribe(): unknown { entry.subscribed = true; return ch },
      }
      entry.channel = ch
      h.opened.push(entry)
      return ch
    },
    removeChannel(ch: unknown) { h.removed.push(ch) },
  },
}))

const { useBoardTasks, REALTIME_DEBOUNCE_MS } = await import('./useBoardTasks')
const { default: TasksPage } = await import('./Tasks')

function task(id: string, patch: Partial<Task> = {}): Task {
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
    ...patch,
  }
}

const TASK = task('task-1', { title: 'Restock the beans', description: 'Original description' })

const OK: WriteOutcome = { ok: true }
const BLOCKED: WriteOutcome = { ok: false, reason: 'it was not saved — you may have been signed out.' }

beforeEach(() => {
  vi.resetAllMocks()
  h.opened.length  = 0
  h.removed.length = 0
  h.fetchBoardTasks.mockImplementation(async () => [{ ...TASK }])
  h.fetchAssignableStaff.mockResolvedValue([])
  h.fetchTags.mockResolvedValue([])
  h.fetchProjects.mockResolvedValue([])
  h.fetchChecklist.mockResolvedValue([])
  h.fetchComments.mockResolvedValue([])
  h.fetchAttachments.mockResolvedValue([])
  h.moveTask.mockResolvedValue(OK)
  h.updateTask.mockResolvedValue(OK)
})
afterEach(cleanup)

/**
 * 挂一块板,等第一次读**落地**。
 *
 * 等的是 firstLoad 翻面,不是「fetchBoardTasks 被呼叫过一次」—— 后者只保证查询
 * 送出去了,tasks 还是空的,接着呼叫 handleMove 会在 `tasks.find(...)` 那里查无
 * 此卡、当场以「it is no longer on the board.」收场,连 moveTask 都不会送出。
 * 这条 race 会随机让回音那几则变绿变红。
 */
async function mountBoard(projectId?: string) {
  const rendered = renderHook(() => useBoardTasks(projectId))
  await waitFor(() => {
    expect(h.fetchBoardTasks).toHaveBeenCalledTimes(1)
    expect(rendered.result.current.firstLoad).toBe(false)
  })
  return rendered
}

/**
 * 广播一发 postgres_changes;`id` 是被动到的那一列。
 *
 * 先确认这条 channel 真的 subscribe 过 —— 少了那一句,supabase 只会把 handler
 * 挂在一条从没上线的 channel 上,线上一发事件都收不到,而 handler 本身还在,
 * 测试若直接呼叫它就会全绿。这句断言就是那道闸。
 */
function emit(id: string, eventType: 'INSERT' | 'UPDATE' | 'DELETE' = 'UPDATE') {
  const sub = h.opened[h.opened.length - 1]
  expect(sub.subscribed).toBe(true)
  const row = { id }
  sub.handler({
    eventType,
    schema: 'public',
    table:  'tasks',
    new:    eventType === 'DELETE' ? {} : row,
    old:    eventType === 'DELETE' ? row : {},
  })
}

/** 等 debounce 视窗过去,并让它触发的那次重拉落地。 */
async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, REALTIME_DEBOUNCE_MS + 80))
  })
}

describe('别人动了一张卡,这块板要自己跟上', () => {
  it('refreshes the board when another session changes a task', async () => {
    await mountBoard()

    emit('task-9')
    await settle()

    expect(h.fetchBoardTasks).toHaveBeenCalledTimes(2)
  })

  it('follows a delete too — the event only carries the old row', async () => {
    await mountBoard()

    emit('task-9', 'DELETE')
    await settle()

    expect(h.fetchBoardTasks).toHaveBeenCalledTimes(2)
  })

  it('coalesces a burst of remote changes into a single refresh', async () => {
    await mountBoard()

    // 别人整栏重新编号 = 一笔一笔写 = 一发一发广播。
    for (const id of ['t1', 't2', 't3', 't4', 't5']) emit(id)
    await settle()

    expect(h.fetchBoardTasks).toHaveBeenCalledTimes(2)
  })
})

describe('自己的回音不算别人的改动', () => {
  it('ignores the echo of a move this board just made, but still follows the next one', async () => {
    const { result } = await mountBoard()

    await act(async () => { await result.current.handleMove('task-1', 'done', 2048) })
    expect(h.moveTask).toHaveBeenCalledTimes(1)

    // 自己那一笔的广播回来了 —— 本地早就是对的,不必再拉一次。
    emit('task-1')
    await settle()
    expect(h.fetchBoardTasks).toHaveBeenCalledTimes(1)

    // 对照组:同一张卡,下一发事件是别人改的,板必须跟上。回音抑制不可以退化成
    // 「这张卡从此不再更新」。
    emit('task-1')
    await settle()
    expect(h.fetchBoardTasks).toHaveBeenCalledTimes(2)
  })

  it('keeps the "could not tidy up" banner instead of letting its own echoes wipe it', async () => {
    // 这一栏挤到该重新编号了(相邻间距远小于 MIN_GAP)。
    h.fetchBoardTasks.mockImplementation(async () => [
      { ...TASK },
      task('task-2', { status: 'done', position: 1000 }),
      task('task-3', { status: 'done', position: 1000.00001 }),
    ])
    // 由下往上写:task-1、task-3 落地,task-2 被挡下来。
    h.updateTask
      .mockResolvedValueOnce(OK)
      .mockResolvedValueOnce(OK)
      .mockResolvedValue(BLOCKED)

    const { result } = await mountBoard()

    await act(async () => { await result.current.handleMove('task-1', 'done', 2048) })
    // rebalanceColumn 失败:先 load() 再把讯息写上横幅。
    expect(h.fetchBoardTasks).toHaveBeenCalledTimes(2)
    expect(result.current.error).toMatch(/Could not tidy up the column order/)

    // 那两笔落地的写入现在广播回来。naive 版本会各拉一次板,而 load() 一成功就
    // setError(''),横幅上那句话当场消失 —— 使用者看到一块什么都没说、号码却还
    // 挤着的板。
    emit('task-1')
    emit('task-3')
    await settle()

    expect(h.fetchBoardTasks).toHaveBeenCalledTimes(2)
    expect(result.current.error).toMatch(/Could not tidy up the column order/)

    // 对照组:真的是别人改的,板照样重拉(而重拉成功本来就会收掉横幅)。
    emit('task-99')
    await settle()
    expect(h.fetchBoardTasks).toHaveBeenCalledTimes(3)
  })
})

describe('订阅范围与退订', () => {
  it('subscribes to every task row — a project filter would miss cards moved out', async () => {
    await mountBoard('proj-1')

    expect(h.opened).toHaveLength(1)
    // 没有 filter 这个键。下了 `project_id=eq.proj-1`,「把任务搬出这个专案」那笔
    // UPDATE(新值的 project_id 已经是别人了)就不会送来,那张卡会赖在板上。
    expect(h.opened[0].filter).toEqual({ event: '*', schema: 'public', table: 'tasks' })

    // 收到的是全公司的事件,重拉却仍然只查这个专案。
    emit('task-in-another-project')
    await settle()
    expect(h.fetchBoardTasks).toHaveBeenCalledTimes(2)
    expect(h.fetchBoardTasks.mock.calls[1][0]).toEqual({ projectId: 'proj-1' })
  })

  it('removes the channel on unmount and drops the refresh that was still pending', async () => {
    const { unmount } = await mountBoard()

    emit('task-9')          // debounce 还在跑
    unmount()

    expect(h.removed).toHaveLength(1)
    expect(h.removed[0]).toBe(h.opened[0].channel)

    await settle()
    expect(h.fetchBoardTasks).toHaveBeenCalledTimes(1)
  })

  it('does not stack up channels when the board switches project', async () => {
    const { rerender } = renderHook(
      ({ id }: { id?: string }) => useBoardTasks(id),
      { initialProps: { id: 'proj-1' as string | undefined } },
    )
    await waitFor(() => expect(h.fetchBoardTasks).toHaveBeenCalledTimes(1))

    rerender({ id: 'proj-2' })
    await waitFor(() => expect(h.fetchBoardTasks).toHaveBeenCalledTimes(2))

    expect(h.opened).toHaveLength(1)
    expect(h.removed).toHaveLength(0)

    // 而且那条 channel 拉的是**新**专案 —— 订阅刻意不钉在 load 的身分上,所以
    // handler 抓着一个过期的 load 是这里最容易写出来的 bug。
    emit('task-9')
    await settle()
    expect(h.fetchBoardTasks).toHaveBeenCalledTimes(3)
    expect(h.fetchBoardTasks.mock.calls[2][0]).toEqual({ projectId: 'proj-2' })
  })
})

describe('realtime 重拉不得卸载开着的弹窗', () => {
  it('refreshes on a remote change without raising the full-screen loader', async () => {
    render(<MemoryRouter><TasksPage /></MemoryRouter>)
    const card = await screen.findByTestId('task-card-task-1')

    fireEvent.click(card)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Task' }))
    const description = screen.getByPlaceholderText('More details...') as HTMLTextAreaElement
    fireEvent.change(description, { target: { value: 'Half-typed, not saved yet' } })

    // 让这次重拉悬在半空。当场 resolve 会把「卸下整棵树」与「挂回来」压进同一个
    // React batch,画面来不及换成 loader —— 刚好把这个 bug 藏得干干净净
    // (同 Tasks.refresh.test.tsx 的 holdNextRefresh)。
    let release: (rows: Task[]) => void = () => {}
    h.fetchBoardTasks.mockImplementationOnce(() => new Promise<Task[]>(r => { release = r }))

    emit('task-1')
    await waitFor(() => expect(h.fetchBoardTasks).toHaveBeenCalledTimes(2))

    // 画面定格在「别人的改动正在拉」那一刻:板还在,弹窗还在编辑模式,字还在。
    expect(screen.queryByText(/Loading tasks/i)).toBeNull()
    const during = screen.getByPlaceholderText('More details...') as HTMLTextAreaElement
    expect(during.value).toBe('Half-typed, not saved yet')

    await act(async () => { release([{ ...TASK }]) })
    const after = screen.getByPlaceholderText('More details...') as HTMLTextAreaElement
    expect(after.value).toBe('Half-typed, not saved yet')
  })
})
