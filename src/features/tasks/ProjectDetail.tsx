import { useState, useEffect, useCallback } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Pencil } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import { useCan } from '../../shared/lib/permissions'
import { deriveParticipants, projectProgress } from '../../shared/lib/tasks'
import { Avatar } from '../../shared/components/Avatar'
import { fetchProject } from './api'
import { PROJECT_STATUS_LABELS, PROJECT_STATUS_STYLES } from './types'
import type { Project, Task } from './types'
import { TaskBoard, bottomPosition } from './TaskBoard'
import { TaskDetailModal } from './TaskDetailModal'
import { TaskFormModal } from './TaskFormModal'
import { ProjectFormModal } from './ProjectFormModal'
import { useBoardTasks } from './useBoardTasks'

/** 带年份的日期。专案会跨年,`5 Aug – 3 Feb` 这种写法读者得自己猜是哪一年。 */
function fmtProjectDate(d: string | null): string | null {
  if (!d) return null
  return new Date(d).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * 单一专案页:上半是专案本身,下半是同一块 Kanban,只是这次只查这个专案的任务。
 *
 * 板的一切(读取、乐观换栏、回滚、软性完成闸门、整栏重新编号)走 useBoardTasks,
 * 跟 /team/tasks 是同一份实作 —— 复制一份过来,两边迟早会对同一件事有两种说法。
 *
 * 进度数字取自 project_progress view(project.done_tasks / total_tasks),不是板上
 * 那份任务:Done 栏有 14 天的时间窗,拿板上的卡去数,做完超过两周的任务会从分子
 * 里消失,进度条会自己往回走。
 */
export default function ProjectDetailPage() {
  const { id = '' } = useParams<{ id: string }>()
  const { staff: currentStaff } = useAuth()
  const { can } = useCan()

  const {
    tasks, allStaff, allTags, firstLoad: boardFirstLoad,
    error: boardError, load: loadBoard, handleMove, moveOptimistic,
  } = useBoardTasks(id)

  const [project,      setProject]      = useState<Project | null>(null)
  const [projectError, setProjectError] = useState('')
  const [firstLoad,    setFirstLoad]    = useState(true)

  // Modals
  const [editOpen, setEditOpen] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)

  const canManage      = currentStaff?.rank === 'supervisor' || currentStaff?.rank === 'manager'
  const currentStaffId = currentStaff?.id ?? ''

  /**
   * 专案本体。读失败就把讯息留着,**不**动 project —— 背景重拉失败时画面维持在
   * 上一次读到的样子加一条横幅,比整页塌成错误好。第一次就失败则 project 还是
   * null,下面整个头部与板都不画:连这是哪个专案都不知道,画出来的板只会像
   * 「这个专案没有任务」。
   */
  const loadProject = useCallback(async () => {
    try {
      setProject(await fetchProject(id))
      setProjectError('')
    } catch (e) {
      setProjectError(e instanceof Error ? e.message : 'Could not load this project.')
    } finally {
      setFirstLoad(false)
    }
  }, [id])

  useEffect(() => { loadProject() }, [loadProject])

  /** 任务一变动,专案的 done/total/overdue 就跟着变 —— 两边一起重拉。 */
  const reload = useCallback(async () => {
    await Promise.all([loadProject(), loadBoard()])
  }, [loadProject, loadBoard])

  // 详情弹窗读同一份 tasks,重新拉板时弹窗内容跟着更新,不必另外同步一份副本。
  const detailTask: Task | null = tasks.find(t => t.id === detailId) ?? null

  // 参与者由任务推导,不另外维护一张成员表:手动维护的名单会过期,而
  // 「谁在做这个专案」= owner + 所有任务的 assignee 本来就答得出来。
  // allStaff 是依 name 排序读回来的,直接筛出来就有稳定顺序
  // (deriveParticipants 回的是 Set 的插入顺序,不保证稳定)。
  const participantIds = deriveParticipants(tasks, project?.owner_id ?? null)
  const participants   = allStaff.filter(s => participantIds.includes(s.id))

  // 全屏 loader 只挡第一次进页;背景重拉一定要保留整棵树,否则开着的弹窗会被卸载。
  if (firstLoad || boardFirstLoad) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F5F0E8]">
        <p className="text-[#8B7355] animate-pulse">Loading project...</p>
      </div>
    )
  }

  // 两笔读取共用一条横幅,Retry 一次重拉两边。两笔同时失败时只讲得出第一句,
  // 但两句话的下一步动作是同一个 —— 再读一次 —— 所以不值得为此叠第二条横幅。
  const pageError = projectError || boardError

  return (
    <div className="min-h-screen bg-[#F5F0E8]">

      {/* Modals */}
      {editOpen && project && (
        <ProjectFormModal
          project={project}
          allStaff={allStaff}
          currentStaffId={currentStaffId}
          onClose={() => setEditOpen(false)}
          onSaved={loadProject}
        />
      )}
      {formOpen && (
        <TaskFormModal
          task={null}
          allStaff={allStaff}
          currentStaffId={currentStaffId}
          nextPosition={bottomPosition(tasks, 'todo')}
          projectId={id}
          onClose={() => setFormOpen(false)}
          onSaved={reload}
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
          onChanged={reload}
          onStatusChange={status => moveOptimistic(detailTask.id, status, bottomPosition(tasks, status))}
        />
      )}

      <div className="max-w-7xl mx-auto px-4 py-6 lg:px-8">

        <Link
          to="/team/projects"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#8B7355] hover:text-[#3D2B1F] transition-colors mb-4"
        >
          <ArrowLeft size={14} />
          Projects
        </Link>

        {pageError && (
          <div
            data-testid="project-detail-error"
            className="flex items-center justify-between gap-3 mb-4 px-4 py-3 rounded-xl bg-red-50 border border-red-200"
          >
            <p className="text-sm text-red-700">{pageError}</p>
            <button
              onClick={reload}
              className="text-xs font-semibold text-red-700 underline flex-shrink-0"
            >
              Retry
            </button>
          </div>
        )}

        {/* 读不到专案就到此为止 —— 下面每一块都是在讲这个专案的事,少了它,
            一块空板会被读成「这个专案还没有任务」,而那正是这个模块重建的起点。 */}
        {project && (
          <>
            <div className="bg-white rounded-2xl border border-[#EDE5D8] p-5 mb-6">

              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      data-testid="project-color-dot"
                      className="w-3 h-3 rounded-full flex-shrink-0"
                      style={{ background: project.color }}
                    />
                    <h1 className="text-2xl font-bold text-[#3D2B1F] break-words">{project.name}</h1>
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold flex-shrink-0 ${PROJECT_STATUS_STYLES[project.status]}`}>
                      {PROJECT_STATUS_LABELS[project.status]}
                    </span>
                  </div>
                  {project.description && (
                    <p className="text-sm text-[#8B7355] mt-2 whitespace-pre-wrap">{project.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {canManage && (
                    <button
                      onClick={() => setFormOpen(true)}
                      className="px-4 py-2 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors shadow-sm"
                    >
                      + New Task
                    </button>
                  )}
                  {can('manage_projects') && (
                    <button
                      onClick={() => setEditOpen(true)}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[#D4C5B0] bg-white text-sm font-semibold text-[#8B7355] hover:bg-[#F5EDE0] transition-colors"
                    >
                      <Pencil size={14} />
                      Edit
                    </button>
                  )}
                </div>
              </div>

              {/* Meta */}
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="text-[#A09080] font-medium">Owner</span>
                  {project.owner ? (
                    <span className="flex items-center gap-1.5">
                      <Avatar name={project.owner.name} avatar={project.owner.avatar} size="sm" />
                      <span className="text-[#3D2B1F] font-semibold">{project.owner.name}</span>
                    </span>
                  ) : (
                    <span className="text-[#A09080]">Unassigned</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[#A09080] font-medium">Start</span>
                  <span className="text-[#3D2B1F]">{fmtProjectDate(project.start_date) ?? '—'}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[#A09080] font-medium">Due</span>
                  <span className="text-[#3D2B1F]">{fmtProjectDate(project.due_date) ?? '—'}</span>
                </div>
                <div className="flex items-center gap-1.5" data-testid="project-participants">
                  <span className="text-[#A09080] font-medium">On this</span>
                  {participants.length === 0 ? (
                    <span className="text-[#A09080]">Nobody yet</span>
                  ) : (
                    <span className="flex items-center gap-1 flex-wrap">
                      {participants.map(s => (
                        <span key={s.id} data-testid={`participant-${s.id}`} title={s.name}>
                          <Avatar name={s.name} avatar={s.avatar} size="sm" />
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              </div>

              {/* Progress */}
              <div className="flex items-center gap-3 mt-4">
                <div className="h-2 flex-1 rounded-full bg-[#EDE5D8] overflow-hidden">
                  <div
                    data-testid="project-progress-bar"
                    className="h-full bg-[#C4813A]"
                    style={{ width: `${projectProgress(project.done_tasks, project.total_tasks)}%` }}
                  />
                </div>
                <span className="text-xs font-semibold text-[#8B7355] flex-shrink-0">
                  {project.done_tasks}/{project.total_tasks}
                </span>
                {project.overdue_tasks > 0 && (
                  <span className="text-xs font-medium text-red-600 flex-shrink-0">
                    ⚠ {project.overdue_tasks} overdue
                  </span>
                )}
              </div>
            </div>

            {/* 板读失败而手上一张卡都没有时,让位给上面那条横幅:三栏
                「No tasks here yet」跟「这个专案真的还没有任务」长得一模一样,
                而使用者会信板上那句,因为它长得像资料。 */}
            {boardError && tasks.length === 0 ? null : (
              <TaskBoard
                tasks={tasks}
                allTasks={tasks}
                canManage={canManage}
                currentStaffId={currentStaffId}
                onCardClick={task => setDetailId(task.id)}
                onAddClick={() => setFormOpen(true)}
                onMove={handleMove}
              />
            )}
          </>
        )}

      </div>
    </div>
  )
}
