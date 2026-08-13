import { useState } from 'react'
import { computeDropPosition } from '../../shared/lib/tasks'
import { TASK_COLUMNS } from './types'
import type { Task, TaskStatus } from './types'
import { TaskCard } from './TaskCard'

const COL_STYLE: Record<TaskStatus, {
  bg: string; border: string
  countBg: string; countColor: string; labelColor: string
}> = {
  todo:        { bg: '#FAF6F1', border: '#EDE5D8', countBg: '#EDE5D8', countColor: '#8B6344', labelColor: '#8B6344' },
  in_progress: { bg: '#EBF3FB', border: '#BDD4EC', countBg: '#D4E8F7', countColor: '#2E6E9E', labelColor: '#2E6E9E' },
  done:        { bg: '#EBF5EE', border: '#B8DCC4', countBg: '#CCE8D4', countColor: '#3D7A50', labelColor: '#3D7A50' },
}

/** 换栏后的落点 = 该栏底部。栏内手动排序是后续 task,这里只需要一个合法的 position。 */
export function bottomPosition(tasks: Task[], status: TaskStatus): number {
  const positions = tasks.filter(t => t.status === status).map(t => t.position)
  return computeDropPosition(positions.length ? Math.max(...positions) : undefined, undefined)
}

function KanbanColumn({
  colKey, label, tasks, canManage, currentStaffId,
  isDragOver, onDragOver, onDragLeave, onDrop,
  draggingId, onDragStart, onDragEnd, onCardClick, onAddClick,
  showMobileActions, onCardStatusChange,
}: {
  colKey: TaskStatus
  label: string
  tasks: Task[]
  canManage: boolean
  currentStaffId: string
  isDragOver: boolean
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent) => void
  draggingId: string | null
  onDragStart: (id: string) => void
  onDragEnd: () => void
  onCardClick: (task: Task) => void
  onAddClick: () => void
  showMobileActions?: boolean
  onCardStatusChange?: (taskId: string, status: TaskStatus) => void
}) {
  const s = COL_STYLE[colKey]

  return (
    <div
      data-testid={`column-${colKey}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="flex flex-col rounded-2xl p-3 min-h-[400px] transition-all"
      style={{
        background: s.bg,
        border: `1.5px solid ${isDragOver ? '#C4813A' : s.border}`,
        boxShadow: isDragOver ? '0 0 0 3px #C4813A30' : undefined,
      }}
    >
      <div className="flex items-center justify-between mb-3 px-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold" style={{ color: s.labelColor }}>{label}</span>
          <span
            className="text-xs font-bold px-1.5 py-0.5 rounded-full"
            style={{ background: s.countBg, color: s.countColor }}
          >
            {tasks.length}
          </span>
        </div>
        {canManage && colKey === 'todo' && (
          <button
            onClick={onAddClick}
            className="w-6 h-6 flex items-center justify-center rounded-full bg-[#C4813A] text-white text-base font-bold leading-none hover:bg-[#A86C2C] transition-colors"
            title="New task"
          >
            +
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2.5 flex-1">
        {tasks.length === 0 ? (
          <div className="flex-1 flex items-center justify-center py-10">
            <p className="text-xs text-[#A09080]">No tasks here yet</p>
          </div>
        ) : (
          tasks.map(task => (
            <TaskCard
              key={task.id}
              task={task}
              draggable={canManage || task.assigned_to === currentStaffId}
              isDragging={draggingId === task.id}
              onDragStart={() => onDragStart(task.id)}
              onDragEnd={onDragEnd}
              onClick={() => onCardClick(task)}
              showMobileActions={showMobileActions && (canManage || task.assigned_to === currentStaffId)}
              onStatusChange={onCardStatusChange ? status => onCardStatusChange(task.id, status) : undefined}
            />
          ))
        )}
      </div>
    </div>
  )
}

/**
 * 三栏板本体。只吃 `tasks`,不自己查资料 —— 好让 `/team/tasks` 与
 * `/team/projects/:id` 共用同一块板。写入由 `onMove` 交回页面层。
 */
export function TaskBoard({
  tasks, canManage, currentStaffId, onCardClick, onAddClick, onMove,
}: {
  tasks: Task[]
  canManage: boolean
  currentStaffId: string
  onCardClick: (task: Task) => void
  onAddClick: () => void
  onMove: (taskId: string, status: TaskStatus, position: number) => void
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverCol, setDragOverCol] = useState<TaskStatus | null>(null)
  const [mobileTab, setMobileTab] = useState<TaskStatus>('todo')

  const byCol: Record<TaskStatus, Task[]> = {
    todo:        tasks.filter(t => t.status === 'todo'),
    in_progress: tasks.filter(t => t.status === 'in_progress'),
    done:        tasks.filter(t => t.status === 'done'),
  }

  /** 非管理层只能搬自己名下的任务 —— 这条规则同时守住拖放与 mobile 的换栏钮。 */
  function requestMove(taskId: string, status: TaskStatus) {
    const task = tasks.find(t => t.id === taskId)
    if (!task || task.status === status) return
    if (!canManage && task.assigned_to !== currentStaffId) return
    onMove(taskId, status, bottomPosition(tasks, status))
  }

  function handleDrop(status: TaskStatus) {
    const id = draggingId
    setDraggingId(null)
    setDragOverCol(null)
    if (id) requestMove(id, status)
  }

  function clearDragState() {
    setDraggingId(null)
    setDragOverCol(null)
  }

  return (
    <>
      {/* Mobile column tabs */}
      <div className="flex sm:hidden gap-1 mb-4 bg-[#EDE5D8] rounded-xl p-1">
        {TASK_COLUMNS.map(col => (
          <button
            key={col.key}
            onClick={() => setMobileTab(col.key)}
            className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              mobileTab === col.key
                ? 'bg-white text-[#3D2B1F] shadow-sm'
                : 'text-[#8B7355]'
            }`}
          >
            {col.label}{' '}
            <span className="opacity-60">({byCol[col.key].length})</span>
          </button>
        ))}
      </div>

      {/* Desktop: 3-column Kanban */}
      <div className="hidden sm:grid grid-cols-3 gap-4">
        {TASK_COLUMNS.map(col => (
          <KanbanColumn
            key={col.key}
            colKey={col.key}
            label={col.label}
            tasks={byCol[col.key]}
            canManage={canManage}
            currentStaffId={currentStaffId}
            isDragOver={dragOverCol === col.key}
            onDragOver={e => { e.preventDefault(); setDragOverCol(col.key) }}
            onDragLeave={() => setDragOverCol(null)}
            onDrop={e => { e.preventDefault(); handleDrop(col.key) }}
            draggingId={draggingId}
            onDragStart={id => setDraggingId(id)}
            onDragEnd={clearDragState}
            onCardClick={onCardClick}
            onAddClick={onAddClick}
          />
        ))}
      </div>

      {/* Mobile: single active column */}
      <div className="sm:hidden">
        <KanbanColumn
          colKey={mobileTab}
          label={TASK_COLUMNS.find(c => c.key === mobileTab)!.label}
          tasks={byCol[mobileTab]}
          canManage={canManage}
          currentStaffId={currentStaffId}
          isDragOver={false}
          onDragOver={() => {}}
          onDragLeave={() => {}}
          onDrop={() => {}}
          draggingId={null}
          onDragStart={() => {}}
          onDragEnd={() => {}}
          onCardClick={onCardClick}
          onAddClick={onAddClick}
          showMobileActions
          onCardStatusChange={requestMove}
        />
      </div>
    </>
  )
}
