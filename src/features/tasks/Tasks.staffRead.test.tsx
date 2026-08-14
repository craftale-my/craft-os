// @vitest-environment jsdom
//
// staff 读失败不能被吞掉,退化成一份空的指派清单。旧版 load() 直接摆一句
// `supabase.from('staff').select(...).order('name')`,连 s.error 都不看:
//   setAllStaff((s.data ?? []) as Staff[])
// RLS 收紧、连线断掉、session 过期,这一笔查询回 { data: null, error: {...} },
// `s.data ?? []` 照样吃出一份空阵列,画面上跟「公司真的还没有员工」长得一模
// 一样。使用者打开既有任务的表单,原本指派的那个人不在下拉里可选,存档就把
// assigned_to 无声洗成 null —— 没有任何地方说过读取失败了。
//
// 修好之后这一笔改叫 fetchAssignableStaff()(定义在 ./api,失败就 throw),
// 跟 fetchBoardTasks() / fetchTags() 一样送进同一个 Promise.all + try/catch,
// 任何一笔失败都会被 load() 的 catch 接到,显示板本来就有的那条错误横幅。
//
// 这里跟 Tasks.refresh.test.tsx / Tasks.doneGate.test.tsx 用同一套 mock 骨架:
// 资料一律从 ./api 进来(页面层已经不直接碰 supabase),再补一支最小的 supabase
// 假货,单纯为了 useBoardTasks 的 realtime 订阅 —— 理由见下面那一则。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Task } from './types'

const h = vi.hoisted(() => ({
  fetchBoardTasks:      vi.fn(),
  fetchTags:            vi.fn(),
  fetchAssignableStaff: vi.fn(),
  fetchProjects:        vi.fn(),
}))

vi.mock('./api', () => ({
  fetchBoardTasks:      h.fetchBoardTasks,
  fetchTags:            h.fetchTags,
  fetchAssignableStaff: h.fetchAssignableStaff,
  fetchProjects:        h.fetchProjects,
  moveTask:             vi.fn(),
  updateTask:           vi.fn(),
  createTask:           vi.fn(),
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

vi.mock('../../shared/lib/lookups', () => ({
  useLookups: () => ({
    deptName: (slug: string) => slug,
    departmentOptions: () => [],
    roleCaps: { manager: { view_team: true, manage_projects: true } },
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

const { default: TasksPage } = await import('./Tasks')

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
  _checklist_done:   0,
  _checklist_total:  0,
}

const BOOM = 'permission denied for table staff'

beforeEach(() => {
  vi.resetAllMocks()
  h.fetchBoardTasks.mockResolvedValue([{ ...TASK }])
  h.fetchTags.mockResolvedValue([])
  h.fetchProjects.mockResolvedValue([])
})
afterEach(cleanup)

describe('staff 读失败要顶上错误横幅,不能退化成空的指派清单', () => {
  it('surfaces the failed staff read on the board banner', async () => {
    h.fetchAssignableStaff.mockRejectedValue(new Error(BOOM))

    render(<MemoryRouter><TasksPage /></MemoryRouter>)

    // 关键是横幅上真的出现了这句话 —— 旧版的 load() 从不为 staff 读取失败呼叫
    // setError,这一行在修好之前永远等不到。
    expect(await screen.findByText(new RegExp(BOOM, 'i'))).toBeTruthy()

    // 指派下拉除了 "All assignees" 本身不该再多长出别的选项来掩盖这次失败 ——
    // 长出别的选项就代表读取失败被悄悄吞成了一份空清单以外的东西。
    const assigneeSelect = screen.getByDisplayValue('All assignees') as HTMLSelectElement
    expect(assigneeSelect.options).toHaveLength(1)
  })

  it('never shows the full-screen loader forever just because one of the three reads failed', async () => {
    h.fetchAssignableStaff.mockRejectedValue(new Error(BOOM))

    render(<MemoryRouter><TasksPage /></MemoryRouter>)

    await screen.findByText(new RegExp(BOOM, 'i'))
    expect(screen.queryByText(/Loading tasks/i)).toBeNull()
  })

  it('recovers the assignee list once Retry succeeds', async () => {
    h.fetchAssignableStaff.mockRejectedValueOnce(new Error(BOOM))
    h.fetchAssignableStaff.mockResolvedValueOnce([
      { id: 'staff-1', name: 'Yong Tan', avatar: null, rank: 'staff', department: null },
    ])

    render(<MemoryRouter><TasksPage /></MemoryRouter>)
    await screen.findByText(new RegExp(BOOM, 'i'))

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(screen.queryByText(new RegExp(BOOM, 'i'))).toBeNull())
    const assigneeSelect = screen.getByDisplayValue('All assignees') as HTMLSelectElement
    expect(within(assigneeSelect).getByText('Yong Tan')).toBeTruthy()
  })
})
