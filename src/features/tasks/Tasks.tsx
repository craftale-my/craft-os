import { useState, useEffect, useCallback } from 'react'
import { Settings2 } from 'lucide-react'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { useLookups } from '../../shared/lib/lookups'
import { useCan } from '../../shared/lib/permissions'
import { needsRebalance, openChecklistCount, rebalance } from '../../shared/lib/tasks'
import type { Staff } from '../../shared/types'
import { fetchBoardTasks, fetchTags, moveTask, updateTask } from './api'
import type { MoveResult, Tag, Task, TaskStatus } from './types'
import { TaskBoard, bottomPosition } from './TaskBoard'
import { TaskDetailModal } from './TaskDetailModal'
import { TaskFormModal } from './TaskFormModal'
import { TagManagerModal } from './TagManagerModal'

/**
 * 子项没做完就要收工时的软性提醒。刻意**不硬挡**:子项可能作废、可能被
 * 情势跳过,硬挡会让那个任务永远结不掉,最后大家学会绕过整套 checklist。
 * 问一次就好,回 true 表示放行。
 *
 * 用 window.confirm 是跟着这个模块既有的破坏性确认走(删任务、删标签),
 * 不为了一句提示新开一层 modal —— 这个弹窗已经是 z-50,再叠一层要自己
 * 处理层级与焦点。测试端以 vi.spyOn(window, 'confirm') 决定按下确定或取消。
 */
function confirmDoneWithOpenItems(task: Task): boolean {
  const open = openChecklistCount(task)
  if (open === 0) return true
  return window.confirm(
    `Still ${open} of ${task._checklist_total} items open. Mark as done anyway?`,
  )
}

export default function TasksPage() {
  const { staff: currentStaff } = useAuth()
  const { departmentOptions } = useLookups()
  const { can } = useCan()
  const [tasks,    setTasks]    = useState<Task[]>([])
  const [allStaff, setAllStaff] = useState<Staff[]>([])
  const [allTags,  setAllTags]  = useState<Tag[]>([])
  const [firstLoad, setFirstLoad] = useState(true)
  const [error,    setError]    = useState('')

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

  /**
   * 重新拉板。刻意不切任何「读取中」旗标 —— 全屏 loader 只属于第一次进板。
   * 这个函式同时是 onSaved / onChanged / onPosted 的回呼,一旦它让整棵树卸载,
   * 开着的详情弹窗会跟着重挂,使用者刚打好、还没存档的内容就这样消失。
   */
  const load = useCallback(async () => {
    try {
      const [t, s, g] = await Promise.all([
        fetchBoardTasks(),
        supabase.from('staff').select('id,name,avatar,rank,department').order('name'),
        fetchTags(),
      ])
      setTasks(t)
      setAllStaff((s.data ?? []) as Staff[])
      setAllTags(g)
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
   *
   * 软性完成闸门也放在这里,而不是拖放与弹窗各写一份:板上拖放、mobile 的
   * 换栏钮、详情弹窗的 "Move to" 三条路最后都收敛到这一个函式(弹窗那条
   * 刻意绕过 handleBoardMove,见下方 onStatusChange),放在这里才没有一条
   * 路径能绕过确认。确认必须挡在乐观更新之前 —— 按了取消却让卡片先跳去
   * Done 再弹回来,等於没问。
   */
  async function moveOptimistic(
    taskId: string, status: TaskStatus, position: number,
  ): Promise<MoveResult> {
    const before = tasks.find(t => t.id === taskId)
    if (!before) return { ok: false, reason: 'it is no longer on the board.' }
    // 只在「真的把任务收掉」时问 —— 已经在 Done 的卡在栏内换个位置不是收工,
    // 每挪一次就问一次「还有子项没做完」,问的是一件早就发生过的事。
    if (status === 'done' && before.status !== 'done' && !confirmDoneWithOpenItems(before)) {
      return null
    }
    setTasks(prev => prev.map(t => (t.id === taskId ? { ...t, status, position } : t)))

    const res = await moveTask(taskId, status, position)
    if (!res.ok) {
      setTasks(prev => prev.map(t => (
        t.id === taskId ? { ...t, status: before.status, position: before.position } : t
      )))
      return res
    }
    // 详情弹窗的换栏钮直接呼叫这里,不经过 handleBoardMove —— 若不在这收掉,
    // 之前拖放失败留下的页面横幅会一直挂著,即使这次换栏明明成功了。
    setError('')

    // 目标栏搬进来之后长这样。用整份 tasks(不是画面上筛过的那份)——
    // 重新编号会重写整栏,被筛掉的卡也在里面,漏算它们就会算出错的号码。
    const column = [
      ...tasks.filter(t => t.status === status && t.id !== taskId),
      { ...before, status, position },
    ].sort((a, b) => a.position - b.position)
    if (needsRebalance(column.map(t => t.position))) await rebalanceColumn(column)
    return res
  }

  /**
   * 整栏重新编号。反覆往同一条缝插中点,double 的间距最后会小到再也切不开
   * (needsRebalance 就是在喊这件事),这时把整栏摊平回 POSITION_STEP 的间距。
   *
   * 这是搬动成功之后的收尾,不是搬动本身:使用者要的那一步已经落地了,所以这里
   * 失败不能讲成「搬不动」。写入一笔一笔送、第一笔失败就停手 —— 半套的重新编号
   * 会把整栏的顺序打乱成没人预期的样子(新号码可能比还没改到的旧号码小),
   * 本地状态无从推测那到底变成什么,唯一诚实的做法是重新拉板,让画面回到
   * 资料库真正的样子,再把失败讲出来。
   */
  async function rebalanceColumn(column: Task[]) {
    const planned = rebalance(column)
    for (let i = 0; i < planned.length; i++) {
      // 号码本来就对的那几张不用写:少送几趟网路,能失败的面也跟着变小。
      if (planned[i].position === column[i].position) continue
      const res = await updateTask(planned[i].id, { position: planned[i].position })
      if (!res.ok) {
        // load() 成功会自己清掉 error,所以讯息要摆在它之后;代价是万一连重拉
        // 都失败,读取的错误会被这一句盖掉 —— 横幅上的 Retry 仍然是同一颗钮。
        await load()
        setError(`Could not tidy up the column order — ${res.reason}`)
        return
      }
    }
    // 全部落地了,本地直接吃新号码,不必再为了这件事多拉一次板。
    setTasks(prev => prev.map(t => {
      const next = planned.find(p => p.id === t.id)
      return next ? { ...t, position: next.position } : t
    }))
  }

  /**
   * 板上的拖放与 mobile 换栏钮 —— 失败回报到页面横幅。
   *
   * 成功刻意**不**在这里收横幅:moveOptimistic 一成功就收掉了,收完之后还接着
   * 整栏重新编号,那一步失败会把讯息写进同一条横幅。这里若再无条件清一次,
   * 就会把刚写上去的那句抹掉 —— 使用者看到的是一块什么都没说、顺序却和资料库
   * 对不起来的板。
   */
  async function handleBoardMove(taskId: string, status: TaskStatus, position: number) {
    const res = await moveOptimistic(taskId, status, position)
    if (!res) return   // 确认被取消 —— 什么都没发生,横幅维持原样。
    if (!res.ok) setError(`Could not move the task — ${res.reason}`)
  }

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
