// @vitest-environment jsdom
//
// Realtime:另一个 session 动了 tasks,这块板要自己跟上。
//
// naive 版本(收到事件就 load())会踩到六件事,这个档案一件一件钉住:
//
// 1. **它真的会跟上**。别人改了一张卡,板要重拉一次。
// 2. **它不准升起全屏 loader**。背景重拉一旦卸载整棵树,开着的详情弹窗会跟着
//    重挂,使用者刚打好、还没存档的内容就这样消失。这条规则在
//    Tasks.refresh.test.tsx 已经为「存档 / 留言」那条路钉过一次,realtime 是
//    第二个入口,而且是使用者完全没动手的那个 —— 所以这里再钉一次,走真的页面。
// 3. **自己的回音不算别人的改动**。板上换栏是乐观更新,本地那份早就是对的,
//    自己那一笔的广播回来再拉一次是白跑一趟查询。每一则回音测试都配一组对照:
//    同一张卡、下一发事件,板必须照样跟上 —— 否则「回音抑制」很容易写成
//    「这张卡从此不再更新」。
// 4. **连发要收敛**。整栏重新编号是一笔一笔写的,别人做一次,这块板会连收 N 发。
// 5. **写入失败的横幅不属於事件流**。「你刚刚那一笔没存进去」是使用者自己的事,
//    别人 session 的一发事件把它抹掉,留下的是一张自己跳回原栏、却没人解释为什么
//    的卡。背景重拉只准收掉**读取**失败那一句(它一成功就不再是真的了)。
// 6. **重连要补拉**。postgres_changes 不补送断线期间的事件,supabase-js 又自己
//    安静地重新 join;少了这一句,睡醒的板会停在睡前那一份,看起来却完全正常。
//    挂载时的那道缝(第一次读取比 join 早落地)是同一发补的。
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
  /**
   * 每呼叫一次 supabase.channel() 就多一笔,连同它收到的订阅条件、事件 handler,
   * 以及 subscribe() 收到的那支状态回呼(真的 client 会拿 'SUBSCRIBED' 呼叫它,
   * 重连之后也会再呼叫一次)。
   */
  opened: [] as Array<{
    name: string
    filter: Record<string, unknown>
    handler: (payload: unknown) => void
    onStatus: ((status: string) => void) | null
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
        onStatus: null as ((status: string) => void) | null,
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
        // 状态回呼收下来但**不**自己呼叫:真的 client 是在 join 完成之后才送
        // 'SUBSCRIBED',什么时候送由测试自己决定(见 reconnect())。
        subscribe(onStatus?: (status: string) => void): unknown {
          entry.subscribed = true
          entry.onStatus   = onStatus ?? null
          return ch
        },
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

/**
 * channel 报到:join 完成(挂载时的第一次)或断线之后自己重新 join 完成。
 * supabase-js 两种情况都是拿 'SUBSCRIBED' 呼叫 subscribe() 收下的那支回呼。
 */
function reconnect(status = 'SUBSCRIBED') {
  const sub = h.opened[h.opened.length - 1]
  expect(sub.onStatus).not.toBeNull()
  sub.onStatus?.(status)
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

    // 对照组:真的是别人改的,板照样重拉 —— 回音抑制不可以退化成「这块板从此
    // 不再更新」。但那一趟重拉**不准**顺手把横幅收掉:整栏的号码还是挤着的,
    // 收掉它只会留下一块什么都没说、号码却还挤着的板(见档案上方第 5 点)。
    emit('task-99')
    await settle()
    expect(h.fetchBoardTasks).toHaveBeenCalledTimes(3)
    expect(result.current.error).toMatch(/Could not tidy up the column order/)
  })
})

/**
 * 横幅上那句话由谁收掉。分的是「这句话在讲什么」,不是「谁触发的重拉」:
 * 讲写入的那句只有使用者自己的下一个动作收得掉,讲读取的那句一次成功的重拉就该收掉
 * —— 少了后者,换来的是一条永远不会消失的横幅。
 */
describe('别人的事件不准抹掉「你刚刚那一笔没存进去」', () => {
  it('keeps a write-failure banner when an unrelated remote change arrives', async () => {
    h.moveTask.mockResolvedValue(BLOCKED)
    const { result } = await mountBoard()

    // 使用者拖了一张卡,RLS 静默挡掉,卡片弹回原栏 + 横幅解释为什么。
    await act(async () => { await result.current.handleMove('task-1', 'done', 2048) })
    expect(result.current.error).toMatch(/Could not move the task/)

    // 200 毫秒后同事勾掉了另一张完全无关的卡。板要跟上(资料是别人的),
    // 但那句解释是使用者的 —— 抹掉它,剩下的就是一张莫名其妙跳回来的卡。
    emit('task-99')
    await settle()

    expect(h.fetchBoardTasks).toHaveBeenCalledTimes(2)   // 真的重拉了
    expect(result.current.error).toMatch(/Could not move the task/)
  })

  it('lets the user clear it themselves — a Retry-triggered load does', async () => {
    h.moveTask.mockResolvedValue(BLOCKED)
    const { result } = await mountBoard()

    await act(async () => { await result.current.handleMove('task-1', 'done', 2048) })
    expect(result.current.error).toMatch(/Could not move the task/)

    // 横幅上的 Retry(以及弹窗存档 / 留言)走的就是这支 load。挡下别人的事件是
    // 为了不替使用者做决定,不是把这句话钉死在画面上。
    await act(async () => { await result.current.load() })
    expect(result.current.error).toBe('')
  })

  it('still clears a read-failure banner on the next successful load', async () => {
    h.fetchBoardTasks.mockRejectedValueOnce(new Error('permission denied for table tasks'))
    const { result } = await mountBoard()
    expect(result.current.error).toMatch(/permission denied for table tasks/)

    // 这一趟是别人的事件触发的背景重拉,而且它成功了:那句「读不到」已经不是
    // 真的了,留着就是一条永远不会消失的横幅。
    emit('task-9')
    await settle()

    expect(h.fetchBoardTasks).toHaveBeenCalledTimes(2)
    expect(result.current.error).toBe('')
  })
})

/**
 * 断线重连。事件流不补送断线期间的改动,supabase-js 又自己安静地重新 join ——
 * 没有这一发补拉,睡醒的板会一直停在睡前那一份,而且因为「有 realtime」而更可信。
 */
describe('channel 报到就补拉一次', () => {
  it('refetches the board when the channel reports SUBSCRIBED', async () => {
    const { result } = await mountBoard()

    reconnect()
    await settle()

    expect(h.fetchBoardTasks).toHaveBeenCalledTimes(2)
    // 补拉是背景重拉:全屏 loader 只属于第一次进板,开着的弹窗不准被卸载。
    expect(result.current.firstLoad).toBe(false)
  })

  it('ignores the statuses that are not a live subscription', async () => {
    await mountBoard()

    // 掉线、出错、join 逾时都会走同一支回呼。这几发只代表「现在没接上」,
    // 拿它们去拉板是白跑 —— 真的接回来时还会再送一发 SUBSCRIBED。
    reconnect('CLOSED')
    reconnect('CHANNEL_ERROR')
    reconnect('TIMED_OUT')
    await settle()

    expect(h.fetchBoardTasks).toHaveBeenCalledTimes(1)
  })

  it('coalesces the reconnect refetch with the events that follow it', async () => {
    await mountBoard()

    // 接回来之后常常紧接着一串事件(别人在这段时间里动过好几张卡)。
    // 补拉与事件走同一条 debounce,所以这一整串只该拉一次板。
    reconnect()
    emit('t1')
    emit('t2')
    await settle()

    expect(h.fetchBoardTasks).toHaveBeenCalledTimes(2)
  })

  it('does not let the reconnect refetch wipe a write-failure banner either', async () => {
    h.moveTask.mockResolvedValue(BLOCKED)
    const { result } = await mountBoard()

    await act(async () => { await result.current.handleMove('task-1', 'done', 2048) })
    expect(result.current.error).toMatch(/Could not move the task/)

    // 笔电睡醒:socket 接回来,板补拉一次 —— 使用者那句解释还在原地。
    reconnect()
    await settle()

    expect(h.fetchBoardTasks).toHaveBeenCalledTimes(2)
    expect(result.current.error).toMatch(/Could not move the task/)
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
