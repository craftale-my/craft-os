import { useState } from 'react'
import { Settings2 } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import { useLookups } from '../../shared/lib/lookups'
import { useCan } from '../../shared/lib/permissions'
import type { Task } from './types'
import { TaskBoard, bottomPosition } from './TaskBoard'
import { TaskDetailModal } from './TaskDetailModal'
import { TaskFormModal } from './TaskFormModal'
import { TagManagerModal } from './TagManagerModal'
import { useBoardTasks } from './useBoardTasks'

export default function TasksPage() {
  const { staff: currentStaff } = useAuth()
  const { departmentOptions } = useLookups()
  const { can } = useCan()
  // 板的资料与搬动逻辑都在这支 hook 里 —— /team/projects/:id 用的是同一份。
  const { tasks, allStaff, allTags, firstLoad, error, load, handleMove, moveOptimistic } =
    useBoardTasks()

  // Filters
  const [search,         setSearch]         = useState('')
  const [myTasksOnly,    setMyTasksOnly]    = useState(false)
  const [filterDept,     setFilterDept]     = useState('')
  const [filterAssignee, setFilterAssignee] = useState('')
  const [filterTag,      setFilterTag]      = useState('')

  // Modals
  const [formOpen, setFormOpen] = useState(false)
  const [editTask, setEditTask] = useState<Task | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [tagManagerOpen, setTagManagerOpen] = useState(false)

  const canManage      = currentStaff?.rank === 'supervisor' || currentStaff?.rank === 'manager'
  const currentStaffId = currentStaff?.id ?? ''

  const filteredTasks = tasks.filter(t => {
    if (myTasksOnly && t.assigned_to !== currentStaffId) return false
    if (filterDept && t.department !== filterDept) return false
    if (filterAssignee && t.assigned_to !== filterAssignee) return false
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
          canManage={canManage}
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
          {canManage && (
            <button
              onClick={() => { setEditTask(null); setFormOpen(true) }}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors shadow-sm"
            >
              + New Task
            </button>
          )}
        </div>

        {error && (
          <div className="flex items-center justify-between gap-3 mb-4 px-4 py-3 rounded-xl bg-red-50 border border-red-200">
            <p className="text-sm text-red-700">{error}</p>
            <button
              onClick={load}
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
          <select className={selectCls} value={filterTag} onChange={e => setFilterTag(e.target.value)}>
            <option value="">All tags</option>
            {allTags.map(tag => (
              <option key={tag.id} value={tag.id}>{tag.name}</option>
            ))}
          </select>
          {can('manage_projects') && (
            <button
              onClick={() => setTagManagerOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#D4C5B0] bg-white text-xs font-semibold text-[#8B7355] hover:bg-[#F5EDE0] transition-colors"
            >
              <Settings2 size={13} />
              Manage tags
            </button>
          )}
        </div>

        <TaskBoard
          tasks={filteredTasks}
          allTasks={tasks}
          canManage={canManage}
          currentStaffId={currentStaffId}
          onCardClick={task => setDetailId(task.id)}
          onAddClick={() => { setEditTask(null); setFormOpen(true) }}
          onMove={handleMove}
        />

      </div>
    </div>
  )
}
