// @vitest-environment jsdom
//
// 这一页最容易悄悄坏掉的两件事:
//
// 1. fetchProjects 失败时,画面必须说「读不到」,而不是画出一份空清单。
//    「读不到」跟「还没有任何专案」长得一模一样 —— 整个 Tasks 模块重建的
//    起点就是这个 bug(见 api.reads.test.ts 顶端)。api 层已经守住「读不到
//    就 throw」,但 throw 出来之后页面接不接得住是另一层,只有这里照得到:
//    把 catch 改成 setProjects([]) 一样会静静地画出「No projects yet.」。
//
// 2. 删除是 RLS 挡得掉的写入 —— { data: [], error: null },没有 error 也没有列。
//    只看 error 的话,被挡掉的删除会跑完一次重新载入、专案还在原地,而使用者
//    看不到任何一句话。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Project } from './types'

const h = vi.hoisted(() => ({
  fetchProjects: vi.fn(),
  deleteProject: vi.fn(),
  /** useCan().can 的回传;逐案改写,用来验证 manage_projects 的闸门。 */
  canManage: { value: true },
}))

vi.mock('./api', () => ({
  fetchProjects: h.fetchProjects,
  deleteProject: h.deleteProject,
  createProject: vi.fn(),
  updateProject: vi.fn(),
}))

vi.mock('../../shared/lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }),
  },
}))

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ staff: { id: 'staff-1', name: 'Yong Tan', rank: 'manager' } }),
}))

vi.mock('../../shared/lib/permissions', () => ({
  useCan: () => ({ can: () => h.canManage.value }),
}))

const { default: ProjectsPage } = await import('./Projects')

const PROJECT: Project = {
  id: 'proj-1',
  name: 'Bean Sourcing',
  description: null,
  color: '#C4813A',
  status: 'active',
  owner_id: 'staff-1',
  start_date: null,
  due_date: null,
  created_by: 'staff-1',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  owner: { id: 'staff-1', name: 'Yong Tan', avatar: null },
  total_tasks: 4,
  done_tasks: 1,
  overdue_tasks: 2,
}

const BOOM = 'permission denied for view project_progress'

const renderPage = () =>
  render(
    <MemoryRouter>
      <ProjectsPage />
    </MemoryRouter>,
  )

beforeEach(() => {
  h.fetchProjects.mockReset()
  h.deleteProject.mockReset()
  h.canManage.value = true
})
afterEach(cleanup)

describe('Projects 载入失败', () => {
  it('shows the error banner instead of an empty list', async () => {
    h.fetchProjects.mockRejectedValue(new Error(BOOM))

    renderPage()

    const banner = await screen.findByTestId('projects-error')
    expect(banner.textContent).toContain(BOOM)
    // 关键的反向断言:失败的读取绝不能长得像「这里本来就没有专案」。
    expect(screen.queryByText('No projects yet.')).toBeNull()
  })

  it('Retry 重新读取,成功之后横幅收掉、专案列出来', async () => {
    h.fetchProjects.mockRejectedValueOnce(new Error(BOOM)).mockResolvedValue([PROJECT])

    renderPage()
    fireEvent.click(await screen.findByText('Retry'))

    expect(await screen.findByText('Bean Sourcing')).toBeTruthy()
    await waitFor(() => expect(screen.queryByTestId('projects-error')).toBeNull())
  })
})

describe('Projects 清单', () => {
  it('画出进度条宽度、完成数与逾期数', async () => {
    h.fetchProjects.mockResolvedValue([PROJECT])

    renderPage()

    const bar = await screen.findByTestId('project-progress-bar')
    expect(bar.getAttribute('style')).toContain('width: 25%')   // 1 / 4
    expect(screen.getByText('1/4')).toBeTruthy()
    expect(screen.getByText('⚠ 2 overdue')).toBeTruthy()
  })

  it('没有 manage_projects 就看不到 New Project 与每一列的编辑 / 删除', async () => {
    h.canManage.value = false
    h.fetchProjects.mockResolvedValue([PROJECT])

    renderPage()

    await screen.findByText('Bean Sourcing')
    expect(screen.queryByText('+ New Project')).toBeNull()
    expect(screen.queryByLabelText('Delete Bean Sourcing')).toBeNull()
    expect(screen.queryByLabelText('Edit Bean Sourcing')).toBeNull()
  })
})

describe('Projects 删除', () => {
  it('确认文字讲明任务不会跟着被删,只是变成没有专案', async () => {
    h.fetchProjects.mockResolvedValue([PROJECT])
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)

    renderPage()
    fireEvent.click(await screen.findByLabelText('Delete Bean Sourcing'))

    const asked = confirm.mock.calls[0][0] as string
    expect(asked).toContain('Bean Sourcing')
    expect(asked).toContain('will not be deleted')
    // 按了取消就什么都不该发生。
    expect(h.deleteProject).not.toHaveBeenCalled()
    confirm.mockRestore()
  })

  it('被 RLS 静静挡掉的删除必须讲出来,不能装作成功', async () => {
    h.fetchProjects.mockResolvedValue([PROJECT])
    // writeOutcome 对 { data: [], error: null } 的判定 —— 没有 error,也没有列。
    h.deleteProject.mockResolvedValue({ ok: false, reason: 'it was not saved — you may have been signed out.' })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)

    renderPage()
    fireEvent.click(await screen.findByLabelText('Delete Bean Sourcing'))

    const banner = await screen.findByTestId('projects-error')
    expect(banner.textContent).toContain('Could not delete the project')
    expect(banner.textContent).toContain('you may have been signed out')
    confirm.mockRestore()
  })
})
