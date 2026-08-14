// @vitest-environment jsdom
//
// Task 14,Step 1:Done 栏底的「View archive →」与栏首的空状态文案。
//
// `showArchiveLink` 跟 Task 13 的 `showProject` 是同一个形状:预设 false,
// 只有 /team/tasks 显式打开 —— /team/projects/:id 什么都不用改就自动是对的。
// 这里跟 TaskBoard.projectBadge.test.tsx 一样直接灌 props,不必假 supabase。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Task } from './types'

vi.mock('../../shared/lib/lookups', () => ({
  useLookups: () => ({ deptName: (slug: string) => slug }),
}))

const { TaskBoard } = await import('./TaskBoard')

const DONE_TASK: Task = {
  id: 'task-1',
  title: 'Roast the new lot',
  description: null,
  status: 'done',
  priority: 'medium',
  project_id: null,
  assigned_to: null,
  created_by: 'staff-1',
  due_date: null,
  department: null,
  position: 1024,
  completed_at: '2026-08-01T00:00:00.000Z',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  assignee: null,
  creator: null,
  project: null,
  tags: [],
  _comment_count: 0,
  _attachment_count: 0,
  _checklist_done: 0,
  _checklist_total: 0,
}

afterEach(cleanup)

function renderBoard(opts: { tasks: Task[]; showArchiveLink?: boolean }) {
  const props = {
    tasks: opts.tasks,
    allTasks: opts.tasks,
    canManage: true,
    currentStaffId: 'staff-1',
    onCardClick: vi.fn(),
    onAddClick: vi.fn(),
    onMove: vi.fn(),
  }
  return render(
    <MemoryRouter>
      {/* undefined 模拟 /team/projects/:id 今天的呼叫方式:那支档案不在这个
          任务的范围内,故意不传这个 prop 而不是显式传 false。 */}
      {opts.showArchiveLink === undefined
        ? <TaskBoard {...props} />
        : <TaskBoard {...props} showArchiveLink={opts.showArchiveLink} />}
    </MemoryRouter>,
  )
}

describe('/team/tasks(showArchiveLink={true})要画 Done 栏底的连结', () => {
  it('links to /team/tasks/archive on the desktop Done column', async () => {
    renderBoard({ tasks: [DONE_TASK], showArchiveLink: true })

    // mobile 单栏默认停在 To Do 分页,不会长出 Done 栏,所以这里一开始只有
    // 桌面那一份。是不是 <a href="/team/tasks/archive"> 才是真正要钉住的事,
    // 不只是文字对了。
    const link = screen.getByRole('link', { name: 'View archive →' })
    expect(link.getAttribute('href')).toBe('/team/tasks/archive')
  })

  it('also links from the mobile Done column once that tab is active', async () => {
    renderBoard({ tasks: [DONE_TASK], showArchiveLink: true })

    // 切到 mobile 的 Done 分页,单栏这时才换成 Done —— 两块 KanbanColumn
    // (桌面与 mobile)同时挂在 DOM,靠 CSS 二选一显示,jsdom 不套 CSS 所以
    // 切换分页之后两份 Done 栏都看得到,连结也该长在两边。
    fireEvent.click(screen.getByRole('button', { name: 'Done (1)' }))

    const links = screen.getAllByRole('link', { name: 'View archive →' })
    expect(links).toHaveLength(2)
    for (const link of links) {
      expect(link.getAttribute('href')).toBe('/team/tasks/archive')
    }
  })
})

describe('/team/projects/:id(不传 showArchiveLink)不该画连结', () => {
  it('renders the Done column with no archive link at all when the prop is omitted', async () => {
    renderBoard({ tasks: [DONE_TASK] })

    await screen.findByTestId('task-card-task-1')
    expect(screen.queryByRole('link', { name: 'View archive →' })).toBeNull()
  })

  it('does not draw the link even when showArchiveLink is explicitly false', async () => {
    renderBoard({ tasks: [DONE_TASK], showArchiveLink: false })

    await screen.findByTestId('task-card-task-1')
    expect(screen.queryByRole('link', { name: 'View archive →' })).toBeNull()
  })
})

describe('Done 栏的空状态文案', () => {
  it('says nothing was completed recently instead of the generic empty text', async () => {
    renderBoard({ tasks: [], showArchiveLink: true })

    expect(screen.getByTestId('column-done').textContent).toContain('Nothing completed in the last 14 days')
    // 反向断言:旧文案不该还留在 Done 栏里。
    expect(screen.getByTestId('column-done').textContent).not.toContain('No tasks here yet')
  })

  it('leaves the other two empty columns with the generic text', async () => {
    renderBoard({ tasks: [], showArchiveLink: true })

    expect(screen.getByTestId('column-todo').textContent).toContain('No tasks here yet')
    expect(screen.getByTestId('column-in_progress').textContent).toContain('No tasks here yet')
  })
})
