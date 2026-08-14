import { Paperclip, MessageSquare, CheckSquare } from 'lucide-react'
import { Avatar } from '../../shared/components/Avatar'
import { useLookups } from '../../shared/lib/lookups'
import { isOverdue } from '../../shared/lib/tasks'
import { TASK_COLUMNS } from './types'
import type { Task, TaskPriority, TaskStatus } from './types'

/** 优先级色表。详情弹窗也吃这张表,所以 export。 */
export const PRIORITY_CFG: Record<TaskPriority, { label: string; color: string; bg: string }> = {
  low:    { label: 'Low',    color: '#6B7280', bg: '#F3F4F6' },
  medium: { label: 'Medium', color: '#92400E', bg: '#FEF3C7' },
  high:   { label: 'High',   color: '#991B1B', bg: '#FEE2E2' },
}

export function fmtDate(d: string | null): string | null {
  if (!d) return null
  return new Date(d).toLocaleDateString('en-MY', { day: 'numeric', month: 'short' })
}

export function TaskCard({
  task,
  draggable: isDraggable,
  isDragging,
  onDragStart,
  onDragEnd,
  onClick,
  showMobileActions,
  onStatusChange,
  testIdPrefix = '',
  showProject = false,
}: {
  task: Task
  draggable: boolean
  isDragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onClick: () => void
  showMobileActions?: boolean
  onStatusChange?: (status: TaskStatus) => void
  /** 同一张卡在桌面栏与 mobile 栏各挂一次,靠这个前缀区分 —— 详见 KanbanColumn。 */
  testIdPrefix?: string
  /**
   * 卡上要不要画 project 标签。默认 false —— 由 TaskBoard 一路往下传,详见那边
   * `showProject` 的说明:安全的默认值就是「不画」,专案页那块板什么都不用做
   * 就自动是对的。
   */
  showProject?: boolean
}) {
  const { deptName } = useLookups()
  const pCfg = PRIORITY_CFG[task.priority]
  const overdue = isOverdue(task.due_date, new Date())
  const dateStr = fmtDate(task.due_date)

  return (
    <div
      data-testid={`${testIdPrefix}task-card-${task.id}`}
      draggable={isDraggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      className="bg-white rounded-xl p-3.5 shadow-card hover:shadow-card-hover transition-all duration-150 cursor-pointer select-none border border-[#EDE5D8]"
      style={{ opacity: isDragging ? 0.4 : 1 }}
    >
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        <span
          className="text-xs font-semibold px-2 py-0.5 rounded-full"
          style={{ color: pCfg.color, background: pCfg.bg }}
        >
          {pCfg.label}
        </span>
        {task.department && (
          <span className="text-xs font-medium text-[#8B6344] bg-[#F5EDE0] px-2 py-0.5 rounded-full capitalize">
            {deptName(task.department)}
          </span>
        )}
        {/*
          专案页那块板每张卡都属于同一个专案,标签只是噪音 —— showProject 由
          TaskBoard 一路往下传,预设 false 就是为了让那块板不用改一行代码。
          max-w + truncate 挡住长专案名把这一列撑爆:这一列在窄卡上已经挤着
          priority 与 department 两个 pill,第三个 pill 只能省字,不能抢位置。
        */}
        {showProject && task.project && (
          <span
            data-testid={`${testIdPrefix}project-badge-${task.id}`}
            className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-[#F5EDE0] text-[#8B6344] max-w-[110px]"
          >
            <span
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ background: task.project.color }}
            />
            <span className="truncate">{task.project.name}</span>
          </span>
        )}
      </div>

      <p className="text-sm font-semibold text-[#3D2B1F] leading-snug mb-3">{task.title}</p>

      {task.tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 mb-2">
          {task.tags.slice(0, 2).map(t => (
            <span
              key={t.id}
              className="text-[11px] font-medium px-1.5 py-0.5 rounded-full"
              style={{ color: t.color, background: `${t.color}1A` }}
            >
              {t.name}
            </span>
          ))}
          {task.tags.length > 2 && (
            <span className="text-[11px] font-medium text-[#A09080]">
              +{task.tags.length - 2}
            </span>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        {task.assignee ? (
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <Avatar name={task.assignee.name} avatar={task.assignee.avatar} size="sm" />
            <span className="text-xs text-[#8B7355] truncate">{task.assignee.name.split(' ')[0]}</span>
          </div>
        ) : (
          <span className="text-xs text-[#A09080] flex-1">Unassigned</span>
        )}
        <div className="flex items-center gap-2 flex-shrink-0">
          {dateStr && (
            <span className={`text-xs font-medium ${overdue ? 'text-red-600' : 'text-[#8B7355]'}`}>
              {overdue ? '⚠ ' : ''}{dateStr}
            </span>
          )}
          {task._attachment_count > 0 && (
            <span className="flex items-center gap-0.5 text-xs font-medium text-[#8B7355]" data-testid="attachment-count-badge">
              <Paperclip size={11} />
              {task._attachment_count}
            </span>
          )}
          {/*
            子项只在这里显示进度数字,负责人不上卡片。卡上已经有优先级、部门、
            标签、任务本身的 assignee、日期、附件与留言数;子项负责人是多值的
            (三个人分工就是三个头像),而且会跟任务 assignee 的头像混在一起,
            让人误判「这张卡是谁的」。「快做完了吗」用 3/7 就答得完,
            「谁负责哪一条」要看得到那一条本身才有意义 —— 那是弹窗的事。
          */}
          {task._checklist_total > 0 && (
            <span className="flex items-center gap-0.5 text-xs font-medium text-[#8B7355]">
              <CheckSquare size={11} />
              {task._checklist_done}/{task._checklist_total}
            </span>
          )}
          {task._comment_count > 0 && (
            <span className="flex items-center gap-0.5 text-xs font-medium text-[#8B7355] bg-[#F5EDE0] px-1.5 py-0.5 rounded-full">
              <MessageSquare size={11} />
              {task._comment_count}
            </span>
          )}
        </div>
      </div>

      {showMobileActions && onStatusChange && (
        <div
          className="flex gap-1.5 mt-3 pt-3 border-t border-[#EDE5D8]"
          onClick={e => e.stopPropagation()}
        >
          {TASK_COLUMNS.filter(col => col.key !== task.status).map(col => (
            <button
              key={col.key}
              onClick={() => onStatusChange(col.key)}
              className="flex-1 py-1.5 rounded-lg text-xs font-semibold bg-[#EDE5D8] text-[#8B7355] hover:bg-[#E0D5C5] transition-colors"
            >
              → {col.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
