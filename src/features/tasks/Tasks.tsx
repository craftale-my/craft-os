import { useState, useCallback, useEffect } from 'react'
import { Settings2 } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import { useLookups } from '../../shared/lib/lookups'
import { fetchProjects } from './api'
import type { Project, Task } from './types'
import { TaskBoard, bottomPosition } from './TaskBoard'
import { TaskDetailModal } from './TaskDetailModal'
import { TaskFormModal } from './TaskFormModal'
import { TagManagerModal } from './TagManagerModal'
import { useBoardTasks } from './useBoardTasks'
import { useTaskPermissions } from './permissions'

export default function TasksPage() {
  const { staff: currentStaff } = useAuth()
  const { departmentOptions } = useLookups()
  const { canManageTasks, canManageProjects } = useTaskPermissions()
  // 板的资料与搬动逻辑都在这支 hook 里 —— /team/projects/:id 用的是同一份。
  const { tasks, allStaff, allTags, firstLoad, error, load, handleMove, moveOptimistic } =
    useBoardTasks()

  // Filters
  const [search,         setSearch]         = useState('')
  const [myTasksOnly,    setMyTasksOnly]    = useState(false)
  const [filterDept,     setFilterDept]     = useState('')
  const [filterAssignee, setFilterAssignee] = useState('')
  const [filterTag,      setFilterTag]      = useState('')
  const [filterProject,  setFilterProject]  = useState('')

  // Project 下拉的选项(表单的下拉自己管自己的读取,但筛选列在页面层,这里
  // 单独拉一份)。跟板本身的三笔读取(tasks / staff / tags)不合并进
  // useBoardTasks —— 那支 hook 也给 /team/projects/:id 用,这一页专属的筛选
  // 不该往那支共用 hook 里加一颗只有这一页用得到的状态。读失败一样要显示出来,
  // 不能退化成一份空的项目清单;跟其余三笔一样共用同一条错误横幅与 Retry。
  const [projects,      setProjects]      = useState<Project[]>([])
  const [projectsError, setProjectsError] = useState('')
  const loadProjects = useCallback(async () => {
    try {
      setProjects(await fetchProjects())
      setProjectsError('')
    } catch (e) {
      setProjectsError(e instanceof Error ? e.message : 'Could not load projects.')
    }
  }, [])
  useEffect(() => { loadProjects() }, [loadProjects])

  // Modals
  const [formOpen, setFormOpen] = useState(false)
  const [editTask, setEditTask] = useState<Task | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [tagManagerOpen, setTagManagerOpen] = useState(false)

  const currentStaffId = currentStaff?.id ?? ''

  const filteredTasks = tasks.filter(t => {
    if (myTasksOnly && t.assigned_to !== currentStaffId) return false
    if (filterDept && t.department !== filterDept) return false
    if (filterAssignee && t.assigned_to !== filterAssignee) return false
    if (filterProject && t.project_id !== filterProject) return false
    if (filterTag && !t.tags.some(tg => tg.id === filterTag)) return false
    if (search && !t.title.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  // 详情弹窗读同一份 tasks,重新拉板时弹窗内容跟着更新,不必另外同步一份副本。
  const detailTask = tasks.find(t => t.id === detailId) ?? null

  // 全屏 loader 只挡第一次进板;背景重拉一定要保留整棵树。
  if (firstLoad) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F5F0E8]">
        <p className="text-[#8B7355] animate-pulse">Loading tasks...</p>
      </div>
    )
  }

  const selectCls = 'px-3 py-1.5 rounded-lg border border-[#D4C5B0] bg-white text-xs text-[#3D2B1F] focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

  return (
    <div className="min-h-screen bg-[#F5F0E8]">

      {/* Modals */}
      {(formOpen || editTask) && (
        <TaskFormModal
          task={editTask}
          allStaff={allStaff}
          currentStaffId={currentStaffId}
          nextPosition={bottomPosition(tasks, 'todo')}
          onClose={() => { setFormOpen(false); setEditTask(null) }}
          onSaved={load}
        />
      )}
      {detailTask && (
        <TaskDetailModal
          task={detailTask}
          allStaff={allStaff}
          allTags={allTags}
          canManageTasks={canManageTasks}
          canManageProjects={canManageProjects}
          currentStaffId={currentStaffId}
          onClose={() => setDetailId(null)}
          onChanged={load}
          onStatusChange={status => moveOptimistic(detailTask.id, status, bottomPosition(tasks, status))}
        />
      )}
      {tagManagerOpen && (
        <TagManagerModal
          tags={allTags}
          onClose={() => setTagManagerOpen(false)}
          onChanged={load}
        />
      )}

      <div className="max-w-7xl mx-auto px-4 py-6 lg:px-8">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-[#3D2B1F]">Tasks</h1>
            <p className="text-sm text-[#A09080] mt-0.5">
              {tasks.length} total · {filteredTasks.length} shown
            </p>
          </div>
          {canManageTasks && (
            <button
              onClick={() => { setEditTask(null); setFormOpen(true) }}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors shadow-sm"
            >
              + New Task
            </button>
          )}
        </div>

        {/* board 的三笔读取(tasks/staff/tags)与这一页专属的 projects 读取共用
            一条横幅:两边同时失败也只讲得出第一句,但下一步动作是同一个
            —— 都是再读一次 —— 不值得为此叠第二条横幅,跟 ProjectDetail 那条
            pageError 是同一个规格。 */}
        {(error || projectsError) && (
          <div className="flex items-center justify-between gap-3 mb-4 px-4 py-3 rounded-xl bg-red-50 border border-red-200">
            <p className="text-sm text-red-700">{error || projectsError}</p>
            <button
              onClick={() => { load(); loadProjects() }}
              className="text-xs font-semibold text-red-700 underline flex-shrink-0"
            >
              Retry
            </button>
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap gap-2 mb-5">
          <input
            type="search"
            placeholder="Search tasks..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="flex-1 min-w-[150px] px-3 py-1.5 rounded-lg border border-[#D4C5B0] bg-white text-xs text-[#3D2B1F] focus:outline-none focus:ring-2 focus:ring-[#C4813A40]"
          />
          <button
            onClick={() => setMyTasksOnly(v => !v)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              myTasksOnly
                ? 'bg-[#4A2E1A] text-[#F5F0E8]'
                : 'border border-[#D4C5B0] bg-white text-[#8B7355] hover:bg-[#F5EDE0]'
            }`}
          >
            My Tasks
          </button>
          <select className={selectCls} value={filterDept} onChange={e => setFilterDept(e.target.value)}>
            <option value="">All departments</option>
            {departmentOptions(filterDept).map(d => (
              <option key={d.slug} value={d.slug}>{d.name}</option>
            ))}
          </select>
          <select className={selectCls} value={filterAssignee} onChange={e => setFilterAssignee(e.target.value)}>
            <option value="">All assignees</option>
            {allStaff.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <select className={selectCls} value={filterProject} onChange={e => setFilterProject(e.target.value)}>
            <option value="">All projects</option>
            {projects.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <select className={selectCls} value={filterTag} onChange={e => setFilterTag(e.target.value)}>
            <option value="">All tags</option>
            {allTags.map(tag => (
              <option key={tag.id} value={tag.id}>{tag.name}</option>
            ))}
          </select>
          {canManageProjects && (
            <button
              onClick={() => setTagManagerOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#D4C5B0] bg-white text-xs font-semibold text-[#8B7355] hover:bg-[#F5EDE0] transition-colors"
            >
              <Settings2 size={13} />
              Manage tags
            </button>
          )}
        </div>

        {/* showProject=true —— 这是整间公司的板,每一张卡可能属于不同专案,
            标签是有用的资讯。/team/projects/:id 那块板不传这个 prop,默认值
            就是 false,详见 TaskBoard 里的说明。
            showArchiveLink 同一个道理:archive 涵盖全公司,只有这块板该显示
            出口去那里 —— /team/projects/:id 是单一专案的板,archive 不分专案,
            连过去没有意义。 */}
        <TaskBoard
          tasks={filteredTasks}
          allTasks={tasks}
          canManageTasks={canManageTasks}
          currentStaffId={currentStaffId}
          onCardClick={task => setDetailId(task.id)}
          onAddClick={() => { setEditTask(null); setFormOpen(true) }}
          onMove={handleMove}
          showProject
          showArchiveLink
        />

      </div>
    </div>
  )
}
