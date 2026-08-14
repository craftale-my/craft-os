import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Pencil, Trash2 } from 'lucide-react'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { useCan } from '../../shared/lib/permissions'
import { projectProgress } from '../../shared/lib/tasks'
import { Avatar } from '../../shared/components/Avatar'
import { fetchProjects, deleteProject } from './api'
import { PROJECT_STATUS_LABELS } from './types'
import type { Project, ProjectStatus, StaffLite } from './types'
import { ProjectFormModal } from './ProjectFormModal'

/** 顶部的切换。`all` 不是 status,是「不过滤」—— cancelled 只在这一档出现。 */
type Filter = ProjectStatus | 'all'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'active',    label: 'Active' },
  { key: 'on_hold',   label: 'On Hold' },
  { key: 'completed', label: 'Completed' },
  { key: 'all',       label: 'All' },
]

const STATUS_STYLES: Record<ProjectStatus, string> = {
  active:    'bg-[#C4813A20] text-[#A86C2C]',
  on_hold:   'bg-[#EDE5D8] text-[#8B7355]',
  completed: 'bg-[#6B8E5A20] text-[#4F6B43]',
  cancelled: 'bg-[#F5EDE0] text-[#A09080]',
}

/**
 * 删除 Project 的确认。tasks.project_id 是 on delete set null,所以任务不会跟着
 * 消失 —— 它们变成没有归属的任务、留在板上。确认文字必须讲这件事:讲成
 * 「一并删除 N 个任务」会吓得没人敢删,讲成「确定要删除吗?」则让人以为任务
 * 也一起没了。回 true 表示放行。
 */
function confirmDelete(project: Project): boolean {
  const n = project.total_tasks
  const note = n === 0
    ? 'It has no tasks.'
    : `Its ${n} task${n === 1 ? '' : 's'} will not be deleted — ${n === 1 ? 'it stays' : 'they stay'} on the board without a project.`
  return window.confirm(`Delete "${project.name}"? ${note}`)
}

export default function ProjectsPage() {
  const { staff: currentStaff } = useAuth()
  const { can } = useCan()
  const [projects, setProjects] = useState<Project[]>([])
  const [allStaff, setAllStaff] = useState<StaffLite[]>([])
  const [firstLoad, setFirstLoad] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<Filter>('active')
  const [formOpen, setFormOpen] = useState(false)
  const [editProject, setEditProject] = useState<Project | null>(null)

  const canManage = can('manage_projects')
  const currentStaffId = currentStaff?.id ?? ''

  /**
   * 读取失败一定要显示出来,不能退化成一份空清单 —— 「读不到」跟「还没有任何
   * 专案」在画面上长得一模一样,而这个模块重建的起点就是这个 bug。
   *
   * staff 那一笔的 error 同样要炸:静静吞掉的话 Owner 下拉会变成只剩
   * "Unassigned",使用者编辑任何专案再存档,就把原本的 owner 洗掉了。
   */
  const load = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([
        fetchProjects(),
        supabase.from('staff').select('id,name,avatar').order('name'),
      ])
      if (s.error) throw new Error(s.error.message)
      setProjects(p)
      setAllStaff((s.data ?? []) as StaffLite[])
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load projects.')
    } finally {
      setFirstLoad(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleDelete(project: Project) {
    if (!confirmDelete(project)) return
    // RLS 挡掉的删除回 { data: [], error: null } —— 没有 error 不代表删掉了。
    const res = await deleteProject(project.id)
    if (!res.ok) { setError(`Could not delete the project — ${res.reason}`); return }
    await load()
  }

  const shown = projects.filter(p => filter === 'all' || p.status === filter)

  // 全屏 loader 只挡第一次进页;之后的重新载入一律保留整棵树。
  if (firstLoad) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F5F0E8]">
        <p className="text-[#8B7355] animate-pulse">Loading projects...</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#F5F0E8]">

      {(formOpen || editProject) && (
        <ProjectFormModal
          project={editProject}
          allStaff={allStaff}
          currentStaffId={currentStaffId}
          onClose={() => { setFormOpen(false); setEditProject(null) }}
          onSaved={load}
        />
      )}

      <div className="max-w-5xl mx-auto px-4 py-6 lg:px-8">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-[#3D2B1F]">Projects</h1>
            <p className="text-sm text-[#A09080] mt-0.5">
              {projects.length} total · {shown.length} shown
            </p>
          </div>
          {canManage && (
            <button
              onClick={() => { setEditProject(null); setFormOpen(true) }}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors shadow-sm"
            >
              + New Project
            </button>
          )}
        </div>

        {error && (
          <div
            data-testid="projects-error"
            className="flex items-center justify-between gap-3 mb-4 px-4 py-3 rounded-xl bg-red-50 border border-red-200"
          >
            <p className="text-sm text-red-700">{error}</p>
            <button
              onClick={load}
              className="text-xs font-semibold text-red-700 underline flex-shrink-0"
            >
              Retry
            </button>
          </div>
        )}

        {/* Status filter */}
        <div className="flex flex-wrap gap-2 mb-5">
          {FILTERS.map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                filter === f.key
                  ? 'bg-[#4A2E1A] text-[#F5F0E8]'
                  : 'border border-[#D4C5B0] bg-white text-[#8B7355] hover:bg-[#F5EDE0]'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* List。空状态刻意让位给错误横幅:读取失败时手上一列都没有,若照常
            画出「No projects yet.」,横幅上方说读不到、下方却说这里本来就没有
            东西 —— 使用者会信下面那句,因为它长得像资料。 */}
        {shown.length === 0 ? (error ? null : (
          <p className="text-sm text-[#A09080] bg-white rounded-2xl border border-[#EDE5D8] px-4 py-8 text-center">
            {projects.length === 0
              ? 'No projects yet.'
              : `No ${FILTERS.find(f => f.key === filter)?.label.toLowerCase()} projects.`}
          </p>
        )) : (
          <div className="bg-white rounded-2xl border border-[#EDE5D8] overflow-hidden">
            {shown.map(p => (
              <div
                key={p.id}
                data-testid="project-row"
                className="flex items-center gap-3 px-4 py-3 border-b border-[#EDE5D8] last:border-b-0 hover:bg-[#F5EDE0] transition-colors"
              >
                <Link
                  to={`/team/projects/${p.id}`}
                  className="flex items-center gap-3 flex-1 min-w-0 flex-wrap"
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ background: p.color }}
                  />
                  <span className="font-semibold text-[#3D2B1F] truncate">{p.name}</span>
                  {p.owner && <Avatar name={p.owner.name} avatar={p.owner.avatar} size="sm" />}
                  <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold flex-shrink-0 ${STATUS_STYLES[p.status]}`}>
                    {PROJECT_STATUS_LABELS[p.status]}
                  </span>
                  <div className="h-1.5 w-24 rounded-full bg-[#EDE5D8] overflow-hidden flex-shrink-0">
                    <div
                      data-testid="project-progress-bar"
                      className="h-full bg-[#C4813A]"
                      style={{ width: `${projectProgress(p.done_tasks, p.total_tasks)}%` }}
                    />
                  </div>
                  <span className="text-xs text-[#8B7355] flex-shrink-0">{p.done_tasks}/{p.total_tasks}</span>
                  {p.overdue_tasks > 0 && (
                    <span className="text-xs font-medium text-red-600 flex-shrink-0">⚠ {p.overdue_tasks} overdue</span>
                  )}
                </Link>
                {canManage && (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => { setFormOpen(false); setEditProject(p) }}
                      aria-label={`Edit ${p.name}`}
                      className="p-1.5 rounded-lg text-[#8B7355] hover:bg-[#EDE5D8] transition-colors"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => handleDelete(p)}
                      aria-label={`Delete ${p.name}`}
                      className="p-1.5 rounded-lg text-[#A09080] hover:bg-red-50 hover:text-red-600 transition-colors"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

      </div>
    </div>
  )
}
