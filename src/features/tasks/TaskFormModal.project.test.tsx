// @vitest-environment jsdom
//
// Task 13:表单里新的 Project 下拉,连到 createTask 的写入路径。
//
// 跟这个模块所有别的写入一样,唯一真正危险的地方是 RLS 静静挡掉的写入——
// { data: [], error: null },没有 error 也没有列(见 writeOutcome)。这里要
// 钉住的不是「下拉选了会送出 project_id」(那条路很难写错),而是
// handleSubmit 真的看了 res.ok,不是只要 createTask 没有丢例外就当成存好了:
// 挡下来的时候弹窗要留着、要把话说出来,不能关掉又清空表单让使用者以为
// 存好了。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { Project, StaffLite } from './types'

const h = vi.hoisted(() => ({
  createTask:    vi.fn(),
  updateTask:    vi.fn(),
  fetchProjects: vi.fn(),
}))

vi.mock('./api', () => ({
  createTask:    h.createTask,
  updateTask:    h.updateTask,
  fetchProjects: h.fetchProjects,
}))

vi.mock('../../shared/lib/lookups', () => ({
  useLookups: () => ({ departmentOptions: () => [] }),
}))

const { TaskFormModal } = await import('./TaskFormModal')

const PROJECTS: Project[] = [
  {
    id: 'proj-1', name: 'Bean Sourcing', description: null, color: '#C4813A',
    status: 'active', owner_id: null, start_date: null, due_date: null,
    created_by: 'staff-1', created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
    owner: null, total_tasks: 0, done_tasks: 0, overdue_tasks: 0,
  },
  {
    id: 'proj-2', name: 'Cafe Refit', description: null, color: '#4A6FA5',
    status: 'active', owner_id: null, start_date: null, due_date: null,
    created_by: 'staff-1', created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
    owner: null, total_tasks: 0, done_tasks: 0, overdue_tasks: 0,
  },
]

const STAFF: StaffLite[] = []

/** RLS 静静挡掉的写入,经 writeOutcome 判定之后的样子。 */
const BLOCKED = { ok: false, reason: 'it was not saved — you may have been signed out.' } as const

function renderModal() {
  const onSaved = vi.fn()
  const onClose = vi.fn()
  render(
    <TaskFormModal
      task={null}
      allStaff={STAFF}
      currentStaffId="staff-1"
      nextPosition={1024}
      onClose={onClose}
      onSaved={onSaved}
    />,
  )
  return { onSaved, onClose }
}

async function fillTitleAndPickProject(projectName: string) {
  fireEvent.change(screen.getByPlaceholderText('What needs to be done...'), {
    target: { value: 'Roast the new lot' },
  })
  const select = await screen.findByDisplayValue('No project')
  const options = Array.from((select as HTMLSelectElement).options)
  const match = options.find(o => o.textContent === projectName)!
  fireEvent.change(select, { target: { value: match.value } })
}

beforeEach(() => {
  vi.resetAllMocks()
  h.fetchProjects.mockResolvedValue(PROJECTS)
})
afterEach(cleanup)

describe('project 下拉挑好之后,存档要看 WriteOutcome 不是只看有没有丢例外', () => {
  it('sends the picked project id, and reports success only once createTask resolves ok:true', async () => {
    h.createTask.mockResolvedValue({ ok: true })
    const { onSaved, onClose } = renderModal()

    await fillTitleAndPickProject('Bean Sourcing')
    fireEvent.click(screen.getByText('Create Task'))

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(onClose).toHaveBeenCalled()
    expect(h.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 'proj-1' }),
      'staff-1',
    )
  })

  it('leaves the field on "No project" as null, not an empty string, when nothing is picked', async () => {
    h.createTask.mockResolvedValue({ ok: true })
    renderModal()

    fireEvent.change(screen.getByPlaceholderText('What needs to be done...'), {
      target: { value: 'Wipe the counters' },
    })
    fireEvent.click(screen.getByText('Create Task'))

    await waitFor(() => expect(h.createTask).toHaveBeenCalled())
    expect(h.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: null }),
      'staff-1',
    )
  })

  it('keeps the modal open and reports the RLS-blocked write instead of treating it as saved', async () => {
    h.createTask.mockResolvedValue(BLOCKED)
    const { onSaved, onClose } = renderModal()

    await fillTitleAndPickProject('Cafe Refit')
    fireEvent.click(screen.getByText('Create Task'))

    const err = await screen.findByText(/Could not save the task/i)
    expect(err.textContent).toMatch(/signed out/i)
    // 关掉弹窗、清空表单才是最伤的那一种「成功」—— 使用者刚打的东西和刚选的
    // project 都还在画面上,让他重试。
    expect(onSaved).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})
