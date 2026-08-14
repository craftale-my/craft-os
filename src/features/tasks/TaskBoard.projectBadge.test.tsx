// @vitest-environment jsdom
//
// Task 13:卡片上的 project 标签。
//
// 只测一件事,但两个方向都要钉住:`showProject` 决定卡片上那颗「点 + 专案名」
// 的标签画不画。/team/tasks 传 true(整间公司的板,标签是有用的资讯);
// /team/projects/:id 是另一支并行任务在顾的档案,这里没办法替它补上
// `showProject={false}` —— 所以默认值必须是 false,那块板才能什么都不改就
// 自动是对的。这一份测试同时钉住两头:显式传 true 会画,不传(模拟专案页
// 现在的呼叫方式)不会画。少了后面这一半,`showProject` 预设成 true 也会
// 让前一半全绿,而那正是专案页会被噪音标签打脸的那个 bug。
//
// TaskBoard / TaskCard 不碰 ./api,直接灌 props 就能测,不必假 supabase。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { Task } from './types'

vi.mock('../../shared/lib/lookups', () => ({
  useLookups: () => ({ deptName: (slug: string) => slug }),
}))

const { TaskBoard } = await import('./TaskBoard')

const TASK: Task = {
  id: 'task-1',
  title: 'Roast the new lot',
  description: null,
  status: 'todo',
  priority: 'medium',
  project_id: 'proj-1',
  assigned_to: null,
  created_by: 'staff-1',
  due_date: null,
  department: null,
  position: 1024,
  completed_at: null,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  assignee: null,
  creator: null,
  project: { id: 'proj-1', name: 'Bean Sourcing', color: '#C4813A' },
  tags: [],
  _comment_count: 0,
  _attachment_count: 0,
  _checklist_done: 0,
  _checklist_total: 0,
}

afterEach(cleanup)

function renderBoard(showProject: boolean | undefined) {
  const props = {
    tasks: [TASK],
    allTasks: [TASK],
    canManageTasks: true,
    currentStaffId: 'staff-1',
    onCardClick: vi.fn(),
    onAddClick: vi.fn(),
    onMove: vi.fn(),
  }
  // `undefined` 模拟 /team/projects/:id 今天的呼叫方式:那支档案不在这个
  // 任务的范围内,没办法替它加一行 `showProject={false}` —— 所以这里故意
  // 不传这个 prop,而不是显式传 false,才是忠实模拟那个呼叫端。
  return showProject === undefined
    ? render(<TaskBoard {...props} />)
    : render(<TaskBoard {...props} showProject={showProject} />)
}

describe('/team/tasks(showProject={true})要画标签', () => {
  it('shows the dot-plus-name badge on the desktop and mobile card', async () => {
    renderBoard(true)
    // 桌面三栏与 mobile 单栏同时挂在 DOM(靠 CSS 二选一显示),两份都要有。
    expect(await screen.findByTestId('project-badge-task-1')).toBeTruthy()
    expect(screen.getByTestId('mobile-project-badge-task-1')).toBeTruthy()
    expect(screen.getByTestId('project-badge-task-1').textContent).toContain('Bean Sourcing')
  })
})

describe('/team/projects/:id(不传 showProject)不该画标签', () => {
  it('renders the card with no project badge at all when the prop is omitted', async () => {
    renderBoard(undefined)
    await screen.findByTestId('task-card-task-1')
    expect(screen.queryByTestId('project-badge-task-1')).toBeNull()
    expect(screen.queryByTestId('mobile-project-badge-task-1')).toBeNull()
  })
})
