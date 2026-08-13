import { Paperclip, MessageSquare } from 'lucide-react'
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
}: {
  task: Task
  draggable: boolean
  isDragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onClick: () => void
  showMobileActions?: boolean
  onStatusChange?: (status: TaskStatus) => void
}) {
  const { deptName } = useLookups()
  const pCfg = PRIORITY_CFG[task.priority]
  const overdue = isOverdue(task.due_date, new Date())
  const dateStr = fmtDate(task.due_date)

  return (
    <div
      data-testid={`task-card-${task.id}`}
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
      </div>

      <p className="text-sm font-semibold text-[#3D2B1F] leading-snug mb-3">{task.title}</p>

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
            <Paperclip size={12} className="text-[#A09080]" />
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
