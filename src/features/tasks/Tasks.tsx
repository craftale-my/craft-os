import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { useLookups } from '../../shared/lib/lookups'
import type { WriteOutcome } from '../../shared/lib/db-write'
import type { Staff } from '../../shared/types'
import { fetchBoardTasks, moveTask } from './api'
import type { Task, TaskStatus } from './types'
import { TaskBoard, bottomPosition } from './TaskBoard'
import { TaskDetailModal } from './TaskDetailModal'
import { TaskFormModal } from './TaskFormModal'

export default function TasksPage() {
  const { staff: currentStaff } = useAuth()
  const { departmentOptions } = useLookups()
  const [tasks,    setTasks]    = useState<Task[]>([])
  const [allStaff, setAllStaff] = useState<Staff[]>([])
  const [firstLoad, setFirstLoad] = useState(true)
  const [error,    setError]    = useState('')

  // Filters
  const [search,         setSearch]         = useState('')
  const [myTasksOnly,    setMyTasksOnly]    = useState(false)
  const [filterDept,     setFilterDept]     = useState('')
  const [filterAssignee, setFilterAssignee] = useState('')

  // Modals
  const [formOpen, setFormOpen] = useState(false)
  const [editTask, setEditTask] = useState<Task | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)

  const canManage      = currentStaff?.rank === 'supervisor' || currentStaff?.rank === 'manager'
  const currentStaffId = currentStaff?.id ?? ''

  /**
   * 重新拉板。刻意不切任何「读取中」旗标 —— 全屏 loader 只属于第一次进板。
   * 这个函式同时是 onSaved / onChanged / onPosted 的回呼,一旦它让整棵树卸载,
   * 开着的详情弹窗会跟着重挂,使用者刚打好、还没存档的内容就这样消失。
   */
  const load = useCallback(async () => {
    try {
      const [t, s] = await Promise.all([
        fetchBoardTasks(),
        supabase.from('staff').select('id,name,avatar,rank,department').order('name'),
      ])
      setTasks(t)
      setAllStaff((s.data ?? []) as Staff[])
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load tasks.')
    } finally {
      setFirstLoad(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  /**
   * 乐观换栏。RLS 静默挡掉的写入没有 error 也没有 rows,所以一定要看 WriteOutcome。
   * 结果原样回传,不自己决定错误显示在哪 —— 详情弹窗是 fixed inset-0 z-50,
   * 整个盖住页面横幅,失败讯息得进它自己的错误位才看得到。
   */
  async function moveOptimistic(
    taskId: string, status: TaskStatus, position: number,
  ): Promise<WriteOutcome> {
    const before = tasks.find(t => t.id === taskId)
    if (!before) return { ok: false, reason: 'it is no longer on the board.' }
    setTasks(prev => prev.map(t => (t.id === taskId ? { ...t, status, position } : t)))

    const res = await moveTask(taskId, status, position)
    if (!res.ok) {
      setTasks(prev => prev.map(t => (
        t.id === taskId ? { ...t, status: before.status, position: before.position } : t
      )))
    }
    return res
  }

  /** 板上的拖放与 mobile 换栏钮 —— 回报到页面横幅。成功要把上一次的失败收掉。 */
  async function handleBoardMove(taskId: string, status: TaskStatus, position: number) {
    const res = await moveOptimistic(taskId, status, position)
    setError(res.ok ? '' : `Could not move the task — ${res.reason}`)
  }

  const filteredTasks = tasks.filter(t => {
    if (myTasksOnly && t.assigned_to !== currentStaffId) return false
    if (filterDept && t.department !== filterDept) return false
    if (filterAssignee && t.assigned_to !== filterAssignee) return false
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
          canManage={canManage}
          currentStaffId={currentStaffId}
          onClose={() => setDetailId(null)}
          onChanged={load}
          onStatusChange={status => moveOptimistic(detailTask.id, status, bottomPosition(tasks, status))}
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
        </div>

        <TaskBoard
          tasks={filteredTasks}
          canManage={canManage}
          currentStaffId={currentStaffId}
          onCardClick={task => setDetailId(task.id)}
          onAddClick={() => { setEditTask(null); setFormOpen(true) }}
          onMove={handleBoardMove}
        />

      </div>
    </div>
  )
}
