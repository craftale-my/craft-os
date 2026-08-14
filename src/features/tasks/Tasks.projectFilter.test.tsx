// @vitest-environment jsdom
//
// Task 13:筛选列多一颗 project 下拉。要钉住的不是「它自己筛得动」——
// filteredTasks 那句 `if (filterProject && ...) return false` 单独看很难写错 ——
// 而是它跟既有四个筛选(search / My Tasks / department / assignee)与 tag
// 筛选一样,是**再加一句 AND**,不是换掉其中一句、也不是自成一组 OR。
// 用两张卡钉住这件事最直接:两张卡同一个 project,分属不同 department;
// 只开 project 筛选两张都在,department 筛选也一起开之后只剩其中一张 ——
// 少了 AND 语意(例如筛选彼此互斥、后加的那句覆写了前面的判断),这里会
// 全部消失或全部留着,而不是精准剩一张。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import type { Project, Task } from './types'

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
    departmentOptions: () => [
      { slug: 'kitchen', name: 'Kitchen' },
      { slug: 'service', name: 'Service' },
    ],
    roleCaps: { manager: { manage_projects: true } },
  }),
}))

const { default: TasksPage } = await import('./Tasks')

const PROJECT: Project = {
  id: 'proj-1',
  name: 'Bean Sourcing',
  description: null,
  color: '#C4813A',
  status: 'active',
  owner_id: null,
  start_date: null,
  due_date: null,
  created_by: 'staff-1',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  owner: null,
  total_tasks: 2,
  done_tasks: 0,
  overdue_tasks: 0,
}

function task(id: string, patch: Partial<Task>): Task {
  return {
    id,
    title: `Task ${id}`,
    description: null,
    status: 'todo',
    priority: 'medium',
    project_id: null,
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
    project: null,
    tags: [],
    _comment_count: 0,
    _attachment_count: 0,
    _checklist_done: 0,
    _checklist_total: 0,
    ...patch,
  }
}

// 同一个 project(proj-1),分属不同 department —— project 筛选自己筛不开
// 这两张,department 筛选才筛得开。
const IN_KITCHEN = task('kitchen-task', { title: 'Roast the new lot', project_id: 'proj-1', department: 'kitchen' })
const IN_SERVICE = task('service-task', { title: 'Restock the till', project_id: 'proj-1', department: 'service' })
// 另一个 project 的卡,用来确认 project 筛选真的把它挡在外面。
const OTHER_PROJECT = task('other-task', { title: 'Repaint the sign', project_id: 'proj-2', department: 'kitchen' })

beforeEach(() => {
  vi.resetAllMocks()
  h.fetchBoardTasks.mockResolvedValue([{ ...IN_KITCHEN }, { ...IN_SERVICE }, { ...OTHER_PROJECT }])
  h.fetchTags.mockResolvedValue([])
  h.fetchAssignableStaff.mockResolvedValue([])
  h.fetchProjects.mockResolvedValue([{ ...PROJECT }])
})
afterEach(cleanup)

async function renderBoard() {
  render(<TasksPage />)
  await screen.findByTestId('task-card-kitchen-task')
}

function selectProject(id: string) {
  fireEvent.change(screen.getByDisplayValue('All projects'), { target: { value: id } })
}

function selectDept(slug: string) {
  fireEvent.change(screen.getByDisplayValue('All departments'), { target: { value: slug } })
}

describe('project 筛选跟既有筛选是 AND,不是取代', () => {
  it('shows all three cards with no filter applied', async () => {
    await renderBoard()
    expect(screen.getByTestId('column-todo').textContent).toMatch(/Roast the new lot/)
    expect(screen.getByTestId('column-todo').textContent).toMatch(/Restock the till/)
    expect(screen.getByTestId('column-todo').textContent).toMatch(/Repaint the sign/)
  })

  it('the project filter alone keeps both cards in that project and drops the other project', async () => {
    await renderBoard()
    selectProject('proj-1')

    const column = within(screen.getByTestId('column-todo'))
    expect(column.queryByText('Roast the new lot')).toBeTruthy()
    expect(column.queryByText('Restock the till')).toBeTruthy()
    expect(column.queryByText('Repaint the sign')).toBeNull()
  })

  it('stacking the department filter on top narrows the project-filtered set further, not replaces it', async () => {
    await renderBoard()
    selectProject('proj-1')
    selectDept('kitchen')

    const column = within(screen.getByTestId('column-todo'))
    // 两个筛选都要通过才留着:project 对、department 也对的那一张。
    expect(column.queryByText('Roast the new lot')).toBeTruthy()
    // project 对但 department 不对 —— 被 department 那句筛掉。
    expect(column.queryByText('Restock the till')).toBeNull()
    // 两者都不对。
    expect(column.queryByText('Repaint the sign')).toBeNull()
  })

  it('updates the shown-count header to match the composed filter', async () => {
    await renderBoard()
    expect(screen.getByText('3 total · 3 shown')).toBeTruthy()

    selectProject('proj-1')
    selectDept('kitchen')

    expect(await screen.findByText('3 total · 1 shown')).toBeTruthy()
  })
})
