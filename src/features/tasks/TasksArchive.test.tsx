// @vitest-environment jsdom
//
// Task 14:/team/tasks/archive。
//
// 两件事最容易悄悄坏掉,跟这个模块其余清单页(Projects.tsx / Tasks.tsx)
// 同一个理由:
//
// 1. fetchArchivedTasks() 读不到就 throw(api.reads.test.ts 已经钉住这一条),
//    但那是 api 层。throw 出来之后页面接不接得住是另一层,只有这里照得到 ——
//    把 catch 改成 setTasks([]) 一样会静静地画出「Nothing archived yet.」,
//    而一个真的空的 archive(团队还没完成过任何任务)是完全合法的状态,两者
//    在画面上长得一模一样。这正是这个模块重建的起点(见 api.ts 顶端注解),
//    在 archive 页格外容易重蹈覆辙 —— 空清单本来就是它的合法结局之一。
//
// 2. 搜寻框要真的筛得动,不能只是摆着好看。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Task } from './types'

const h = vi.hoisted(() => ({
  fetchArchivedTasks: vi.fn(),
}))

vi.mock('./api', () => ({
  fetchArchivedTasks: h.fetchArchivedTasks,
}))

const { default: TasksArchivePage } = await import('./TasksArchive')

function archivedTask(patch: Partial<Task>): Task {
  return {
    id: 'task-1',
    title: 'Restock the beans',
    description: null,
    status: 'done',
    priority: 'medium',
    project_id: 'proj-1',
    assigned_to: 'staff-1',
    created_by: 'staff-1',
    due_date: null,
    department: null,
    position: 1024,
    // 中午,不是午夜:日期格式化断言得撑过任何时区,不能只在本机的 UTC+8 上过。
    completed_at: '2026-05-01T12:00:00.000Z',
    created_at: '2026-04-01T12:00:00.000Z',
    updated_at: '2026-05-01T12:00:00.000Z',
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

const BOOM = 'permission denied for table tasks'

const renderPage = () =>
  render(
    <MemoryRouter>
      <TasksArchivePage />
    </MemoryRouter>,
  )

beforeEach(() => { h.fetchArchivedTasks.mockReset() })
afterEach(cleanup)

describe('读取失败', () => {
  it('shows the error banner instead of an empty archive', async () => {
    h.fetchArchivedTasks.mockRejectedValue(new Error(BOOM))

    renderPage()

    const banner = await screen.findByTestId('archive-error')
    expect(banner.textContent).toContain(BOOM)
    // 关键的反向断言:失败的读取绝不能长得像「这里本来就没有归档」——
    // 那是一个真正空的 archive 完全合法的文案,读取失败不该借用它。
    expect(screen.queryByText('Nothing archived yet.')).toBeNull()
  })

  it('Retry re-reads and the archive shows once it succeeds', async () => {
    h.fetchArchivedTasks
      .mockRejectedValueOnce(new Error(BOOM))
      .mockResolvedValue([archivedTask({})])

    renderPage()
    fireEvent.click(await screen.findByText('Retry'))

    expect(await screen.findByText('Restock the beans')).toBeTruthy()
    await waitFor(() => expect(screen.queryByTestId('archive-error')).toBeNull())
  })
})

describe('搜寻', () => {
  const BEANS = archivedTask({
    id: 'task-1', title: 'Restock the beans',
    project: { id: 'proj-1', name: 'Bean Sourcing', color: '#C4813A' },
    assignee: { id: 'staff-1', name: 'Yong Tan', avatar: null },
  })
  const OVEN = archivedTask({
    id: 'task-2', title: 'Fix the oven',
    project: { id: 'proj-2', name: 'Kitchen Refit', color: '#3D2B1F' },
    assignee: { id: 'staff-2', name: 'Mei Lee', avatar: null },
  })

  it('filters the list down to titles matching the query', async () => {
    h.fetchArchivedTasks.mockResolvedValue([BEANS, OVEN])

    renderPage()
    await screen.findByText('Restock the beans')
    expect(screen.getByText('Fix the oven')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('Search archived tasks...'), {
      target: { value: 'oven' },
    })

    // 反向断言:少了这一条,把筛选拿掉也会让上面那句全绿。
    expect(screen.queryByText('Restock the beans')).toBeNull()
    expect(screen.getByText('Fix the oven')).toBeTruthy()
  })

  it('says nothing matches without pretending the archive itself is empty', async () => {
    h.fetchArchivedTasks.mockResolvedValue([BEANS, OVEN])

    renderPage()
    await screen.findByText('Restock the beans')

    fireEvent.change(screen.getByPlaceholderText('Search archived tasks...'), {
      target: { value: 'nothing matches this' },
    })

    expect(await screen.findByText('No tasks match your search.')).toBeTruthy()
    expect(screen.queryByText('Nothing archived yet.')).toBeNull()
  })
})

describe('清单内容', () => {
  it('shows the title, project, assignee and completed date a manager needs', async () => {
    h.fetchArchivedTasks.mockResolvedValue([archivedTask({})])

    renderPage()

    const row = await screen.findByTestId('archive-row')
    expect(row.textContent).toContain('Restock the beans')
    expect(row.textContent).toContain('Bean Sourcing')
    expect(row.textContent).toContain('Yong Tan')
    expect(row.textContent).toContain('1 May 2026')
  })
})
