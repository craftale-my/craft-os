// @vitest-environment jsdom
//
// 存档路径唯一真正危险的地方:RLS 挡掉的写入回 { data: [], error: null } ——
// 没有 error,也没有列。writeOutcome 已经把这个形状判成 { ok: false },但那只有
// 在呼叫端真的去看 .ok 时才有意义。少了这一层,弹窗会关掉、清单会重新载入,
// 使用者盯着一份没有自己刚建立的专案的清单,而画面上一个字都没说。
//
// 新增与编辑两条路分开测:它们走的是不同的 api 函式,曾经出现过只有其中一条
// 接了错误处理的写法。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { Project, StaffLite } from './types'

const h = vi.hoisted(() => ({
  createProject: vi.fn(),
  updateProject: vi.fn(),
}))

vi.mock('./api', () => ({
  createProject: h.createProject,
  updateProject: h.updateProject,
}))

const { ProjectFormModal } = await import('./ProjectFormModal')

const STAFF: StaffLite[] = [{ id: 'staff-2', name: 'Mei Ling', avatar: null }]

const PROJECT: Project = {
  id: 'proj-1',
  name: 'Bean Sourcing',
  description: 'Find a new roaster',
  color: '#C4813A',
  status: 'active',
  owner_id: 'staff-2',
  start_date: null,
  due_date: null,
  created_by: 'staff-1',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  owner: { id: 'staff-2', name: 'Mei Ling', avatar: null },
  total_tasks: 0,
  done_tasks: 0,
  overdue_tasks: 0,
}

/** RLS 静静挡掉的写入,经 writeOutcome 判定之后的样子。 */
const BLOCKED = { ok: false, reason: 'it was not saved — you may have been signed out.' } as const

function renderModal(project: Project | null) {
  const onSaved = vi.fn()
  const onClose = vi.fn()
  render(
    <ProjectFormModal
      project={project}
      allStaff={STAFF}
      currentStaffId="staff-1"
      onClose={onClose}
      onSaved={onSaved}
    />,
  )
  return { onSaved, onClose }
}

beforeEach(() => {
  h.createProject.mockReset()
  h.updateProject.mockReset()
})
afterEach(cleanup)

describe('ProjectFormModal 新增', () => {
  it('写入被静静挡掉时讲出来,而且不当成存好了', async () => {
    h.createProject.mockResolvedValue(BLOCKED)
    const { onSaved, onClose } = renderModal(null)

    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Bean Sourcing' } })
    fireEvent.click(screen.getByText('Create Project'))

    const err = await screen.findByTestId('project-form-error')
    expect(err.textContent).toContain('Could not save the project')
    expect(err.textContent).toContain('you may have been signed out')
    // 弹窗留在原地,使用者打的内容还在 —— 关掉才是最伤的那一种「成功」。
    expect(onSaved).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('成功才收掉弹窗并重新载入,送出的 payload 把空字串收成 null', async () => {
    h.createProject.mockResolvedValue({ ok: true })
    const { onSaved, onClose } = renderModal(null)

    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: '  Bean Sourcing  ' } })
    fireEvent.click(screen.getByText('Create Project'))

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(onClose).toHaveBeenCalled()
    expect(h.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Bean Sourcing',
        description: null,
        status: 'active',
        owner_id: null,
        start_date: null,
        due_date: null,
      }),
      'staff-1',
    )
  })

  it('名称是空的就不送出任何写入', () => {
    renderModal(null)

    fireEvent.click(screen.getByText('Create Project'))

    expect(screen.getByTestId('project-form-error').textContent).toContain('Name is required.')
    expect(h.createProject).not.toHaveBeenCalled()
  })
})

describe('ProjectFormModal 编辑', () => {
  it('走 updateProject 并带上专案 id,同样检查 WriteOutcome', async () => {
    h.updateProject.mockResolvedValue(BLOCKED)
    const { onSaved, onClose } = renderModal(PROJECT)

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'on_hold' } })
    fireEvent.click(screen.getByText('Save Changes'))

    const err = await screen.findByTestId('project-form-error')
    expect(err.textContent).toContain('Could not save the project')
    expect(h.updateProject).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({ name: 'Bean Sourcing', status: 'on_hold', owner_id: 'staff-2' }),
    )
    expect(h.createProject).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})
