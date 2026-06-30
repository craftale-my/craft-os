import { useState, useEffect, useRef } from 'react'
import { Paperclip, MessageSquare } from 'lucide-react'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from '../auth/AuthContext'
import type { Staff } from '../../shared/types'
import { Avatar } from '../../shared/components/Avatar'

// ─── Types ────────────────────────────────────────────────────────────────────

type TaskStatus = 'todo' | 'in_progress' | 'done'
type TaskPriority = 'low' | 'medium' | 'high'

interface Task {
  id: string
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  assigned_to: string | null
  created_by: string | null
  due_date: string | null
  department: string | null
  attachment_url: string | null
  created_at: string
  updated_at: string
  assignee?: { id: string; name: string; avatar: string | null }
  creator?:  { id: string; name: string; avatar: string | null }
  _comment_count: number
}

interface TaskComment {
  id: string
  task_id: string
  staff_id: string
  comment: string
  created_at: string
  staff?: { id: string; name: string; avatar: string | null }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const COLUMNS: { key: TaskStatus; label: string }[] = [
  { key: 'todo',        label: 'To Do' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'done',        label: 'Done' },
]

const COL_STYLE: Record<TaskStatus, {
  bg: string; border: string
  countBg: string; countColor: string; labelColor: string
}> = {
  todo:        { bg: '#FAF6F1', border: '#EDE5D8', countBg: '#EDE5D8', countColor: '#8B6344', labelColor: '#8B6344' },
  in_progress: { bg: '#EBF3FB', border: '#BDD4EC', countBg: '#D4E8F7', countColor: '#2E6E9E', labelColor: '#2E6E9E' },
  done:        { bg: '#EBF5EE', border: '#B8DCC4', countBg: '#CCE8D4', countColor: '#3D7A50', labelColor: '#3D7A50' },
}

const PRIORITY_CFG: Record<TaskPriority, { label: string; color: string; bg: string }> = {
  low:    { label: 'Low',    color: '#6B7280', bg: '#F3F4F6' },
  medium: { label: 'Medium', color: '#92400E', bg: '#FEF3C7' },
  high:   { label: 'High',   color: '#991B1B', bg: '#FEE2E2' },
}

const TASK_DEPTS = [
  { value: 'barista', label: 'Barista' },
  { value: 'bakery',  label: 'Bakery' },
  { value: 'kitchen', label: 'Kitchen' },
  { value: 'general', label: 'General' },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(d: string | null): string | null {
  if (!d) return null
  return new Date(d).toLocaleDateString('en-MY', { day: 'numeric', month: 'short' })
}

function isOverdue(d: string | null): boolean {
  if (!d) return false
  const due = new Date(d)
  due.setHours(23, 59, 59, 999)
  return due < new Date()
}

// ─── TaskCard ─────────────────────────────────────────────────────────────────

function TaskCard({
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
  const pCfg = PRIORITY_CFG[task.priority]
  const overdue = isOverdue(task.due_date)
  const dateStr = fmtDate(task.due_date)

  return (
    <div
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
            {task.department}
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
          {task.attachment_url && (
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
          {COLUMNS.filter(col => col.key !== task.status).map(col => (
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

// ─── KanbanColumn ─────────────────────────────────────────────────────────────

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

// ─── CreateEditModal ──────────────────────────────────────────────────────────

function CreateEditModal({
  task, allStaff, currentStaffId, onClose, onSaved,
}: {
  task: Task | null
  allStaff: Staff[]
  currentStaffId: string
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    title:       task?.title       ?? '',
    description: task?.description ?? '',
    assigned_to: task?.assigned_to ?? '',
    priority:    (task?.priority   ?? 'medium') as TaskPriority,
    due_date:    task?.due_date    ?? '',
    department:  task?.department  ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  const set = (k: keyof typeof form) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) => setForm(f => ({ ...f, [k]: e.target.value }))

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.title.trim()) { setError('Title is required.'); return }
    setSaving(true)
    setError('')

    const payload = {
      title:       form.title.trim(),
      description: form.description.trim() || null,
      assigned_to: form.assigned_to || null,
      priority:    form.priority,
      due_date:    form.due_date || null,
      department:  form.department || null,
      updated_at:  new Date().toISOString(),
    }

    const { error: err } = task
      ? await supabase.from('tasks').update(payload).eq('id', task.id)
      : await supabase.from('tasks').insert({ ...payload, status: 'todo', created_by: currentStaffId })

    setSaving(false)
    if (err) { setError(err.message); return }
    onSaved()
    onClose()
  }

  const labelCls = 'block text-xs font-semibold text-[#8B7355] mb-1'
  const inputCls = 'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-[#3D2B1F] focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-[#FDFAF6] rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#EDE5D8] sticky top-0 bg-[#FDFAF6]">
          <h2 className="font-bold text-[#3D2B1F] text-lg">{task ? 'Edit Task' : 'New Task'}</h2>
          <button onClick={onClose} className="text-[#A09080] hover:text-[#3D2B1F] text-xl leading-none">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          {error && (
            <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>
          )}
          <div>
            <label className={labelCls}>Title *</label>
            <input
              className={inputCls}
              value={form.title}
              onChange={set('title')}
              placeholder="What needs to be done..."
            />
          </div>
          <div>
            <label className={labelCls}>Description</label>
            <textarea
              className={`${inputCls} resize-none`}
              rows={3}
              value={form.description}
              onChange={set('description')}
              placeholder="More details..."
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Priority</label>
              <select className={inputCls} value={form.priority} onChange={set('priority')}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>Due Date</label>
              <input type="date" className={inputCls} value={form.due_date} onChange={set('due_date')} />
            </div>
          </div>
          <div>
            <label className={labelCls}>Assign To</label>
            <select className={inputCls} value={form.assigned_to} onChange={set('assigned_to')}>
              <option value="">Unassigned</option>
              {allStaff.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Department (optional)</label>
            <select className={inputCls} value={form.department} onChange={set('department')}>
              <option value="">All departments</option>
              {TASK_DEPTS.map(d => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border border-[#D4C5B0] text-sm text-[#8B7355] font-medium hover:bg-[#F5EDE0] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 py-2.5 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors disabled:opacity-60"
            >
              {saving ? 'Saving...' : task ? 'Save Changes' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── TaskDetailModal ──────────────────────────────────────────────────────────

function TaskDetailModal({
  task, allStaff, canManage, currentStaffId,
  onClose, onDeleted, onStatusChange, onRefresh, onTaskUpdated,
}: {
  task: Task
  allStaff: Staff[]
  canManage: boolean
  currentStaffId: string
  onClose: () => void
  onDeleted: () => void
  onStatusChange: (status: TaskStatus) => void
  onRefresh: () => void
  onTaskUpdated: (task: Task) => void
}) {
  const [comments, setComments] = useState<TaskComment[]>([])
  const [newComment, setNewComment] = useState('')
  const [posting,  setPosting]  = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [lightbox, setLightbox] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const [editing, setEditing] = useState(false)
  const [saving,  setSaving]  = useState(false)
  const [form, setForm] = useState({
    title:       task.title,
    description: task.description ?? '',
    priority:    task.priority,
    assigned_to: task.assigned_to ?? '',
    due_date:    task.due_date ?? '',
  })

  const isAssignee       = task.assigned_to === currentStaffId
  const canChangeStatus  = canManage || isAssignee
  const canAttach        = canManage || isAssignee
  const pCfg             = PRIORITY_CFG[editing ? form.priority : task.priority]
  const overdue          = isOverdue(task.due_date)

  useEffect(() => { loadComments() }, [task.id])

  function startEdit() {
    setForm({
      title:       task.title,
      description: task.description ?? '',
      priority:    task.priority,
      assigned_to: task.assigned_to ?? '',
      due_date:    task.due_date ?? '',
    })
    setEditing(true)
  }

  async function saveEdit() {
    if (!form.title.trim()) return
    setSaving(true)
    const payload = {
      title:       form.title.trim(),
      description: form.description.trim() || null,
      priority:    form.priority,
      assigned_to: form.assigned_to || null,
      due_date:    form.due_date || null,
      updated_at:  new Date().toISOString(),
    }
    const { error } = await supabase.from('tasks').update(payload).eq('id', task.id)
    setSaving(false)
    if (error) return
    const assignee = allStaff.find(s => s.id === form.assigned_to)
    onTaskUpdated({
      ...task,
      ...payload,
      assignee: assignee ? { id: assignee.id, name: assignee.name, avatar: assignee.avatar } : undefined,
    })
    setEditing(false)
    onRefresh()
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const ext = file.name.split('.').pop() ?? 'jpg'
      const filePath = `${task.id}/${Date.now()}.${ext}`
      const { error: uploadErr } = await supabase.storage
        .from('task-attachments')
        .upload(filePath, file, { contentType: file.type })
      if (uploadErr) { setUploading(false); return }
      const url = supabase.storage.from('task-attachments').getPublicUrl(filePath).data.publicUrl
      const { error } = await supabase.from('tasks').update({ attachment_url: url }).eq('id', task.id)
      if (!error) {
        onTaskUpdated({ ...task, attachment_url: url })
        onRefresh()
      }
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function removeAttachment() {
    const { error } = await supabase.from('tasks').update({ attachment_url: null }).eq('id', task.id)
    if (!error) {
      onTaskUpdated({ ...task, attachment_url: null })
      onRefresh()
    }
  }

  async function loadComments() {
    const { data } = await supabase
      .from('task_comments')
      .select('*, staff:staff!task_comments_staff_id_fkey(id,name,avatar)')
      .eq('task_id', task.id)
      .order('created_at', { ascending: true })
    if (data) setComments(data as TaskComment[])
  }

  async function postComment(e: React.FormEvent) {
    e.preventDefault()
    if (!newComment.trim()) return
    setPosting(true)
    await supabase.from('task_comments').insert({
      task_id:  task.id,
      staff_id: currentStaffId,
      comment:  newComment.trim(),
    })
    setNewComment('')
    setPosting(false)
    loadComments()
    onRefresh()
  }

  async function handleDelete() {
    if (!window.confirm('Delete this task? This cannot be undone.')) return
    setDeleting(true)
    await supabase.from('tasks').delete().eq('id', task.id)
    onDeleted()
  }

  const statusLabel: Record<TaskStatus, string> = {
    todo: 'To Do', in_progress: 'In Progress', done: 'Done',
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-[#FDFAF6] rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-start justify-between px-6 pt-5 pb-4 border-b border-[#EDE5D8]">
          <div className="flex-1 min-w-0 pr-3">
            <div className="flex flex-wrap items-center gap-1.5 mb-2">
              <span
                className="text-xs font-semibold px-2 py-0.5 rounded-full"
                style={{ color: pCfg.color, background: pCfg.bg }}
              >
                {pCfg.label}
              </span>
              {task.department && (
                <span className="text-xs font-medium text-[#8B6344] bg-[#F5EDE0] px-2 py-0.5 rounded-full capitalize">
                  {task.department}
                </span>
              )}
              {!editing && (
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                  task.status === 'done'        ? 'bg-[#CCE8D4] text-[#3D7A50]' :
                  task.status === 'in_progress' ? 'bg-[#D4E8F7] text-[#2E6E9E]' :
                  'bg-[#EDE5D8] text-[#8B6344]'
                }`}>
                  {statusLabel[task.status]}
                </span>
              )}
            </div>
            {editing ? (
              <input
                className="w-full px-2.5 py-1.5 rounded-lg border border-[#D4C5B0] bg-white text-base font-bold text-[#3D2B1F] focus:outline-none focus:ring-2 focus:ring-[#C4813A40]"
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              />
            ) : (
              <h2 className="font-bold text-[#3D2B1F] text-lg leading-snug">{task.title}</h2>
            )}
            <p className="text-xs text-[#A09080] mt-1.5">
              Created by <span className="font-medium text-[#8B7355]">{task.creator?.name ?? 'Unknown'}</span>
              {' · '}{new Date(task.created_at).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' })}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-[#A09080] hover:text-[#3D2B1F] text-xl leading-none flex-shrink-0 mt-1"
          >
            ✕
          </button>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-5">

          {/* Meta */}
          <div className="grid grid-cols-2 gap-4 text-xs">
            <div>
              <p className="text-[#A09080] font-medium mb-1">Assigned To</p>
              {editing ? (
                <select
                  className="w-full px-2.5 py-1.5 rounded-lg border border-[#D4C5B0] bg-white text-xs text-[#3D2B1F] focus:outline-none focus:ring-2 focus:ring-[#C4813A40]"
                  value={form.assigned_to}
                  onChange={e => setForm(f => ({ ...f, assigned_to: e.target.value }))}
                >
                  <option value="">Unassigned</option>
                  {allStaff.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              ) : task.assignee ? (
                <div className="flex items-center gap-1.5">
                  <Avatar name={task.assignee.name} avatar={task.assignee.avatar} size="sm" />
                  <span className="text-[#3D2B1F] font-semibold">{task.assignee.name}</span>
                </div>
              ) : (
                <span className="text-[#A09080]">Unassigned</span>
              )}
            </div>
            <div>
              <p className="text-[#A09080] font-medium mb-1">Due Date</p>
              {editing ? (
                <input
                  type="date"
                  className="w-full px-2.5 py-1.5 rounded-lg border border-[#D4C5B0] bg-white text-xs text-[#3D2B1F] focus:outline-none focus:ring-2 focus:ring-[#C4813A40]"
                  value={form.due_date}
                  onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))}
                />
              ) : task.due_date ? (
                <span className={`font-semibold ${overdue ? 'text-red-600' : 'text-[#3D2B1F]'}`}>
                  {overdue ? '⚠ ' : ''}{fmtDate(task.due_date)}
                </span>
              ) : (
                <span className="text-[#A09080]">No due date</span>
              )}
            </div>
            {editing && (
              <div>
                <p className="text-[#A09080] font-medium mb-1">Priority</p>
                <select
                  className="w-full px-2.5 py-1.5 rounded-lg border border-[#D4C5B0] bg-white text-xs text-[#3D2B1F] focus:outline-none focus:ring-2 focus:ring-[#C4813A40]"
                  value={form.priority}
                  onChange={e => setForm(f => ({ ...f, priority: e.target.value as TaskPriority }))}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>
            )}
          </div>

          {/* Description */}
          {editing ? (
            <div>
              <p className="text-xs font-semibold text-[#8B7355] mb-1.5">Description</p>
              <textarea
                rows={4}
                className="w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-[#3D2B1F] resize-none focus:outline-none focus:ring-2 focus:ring-[#C4813A40]"
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="More details..."
              />
            </div>
          ) : task.description && (
            <div>
              <p className="text-xs font-semibold text-[#8B7355] mb-1.5">Description</p>
              <p className="text-sm text-[#3D2B1F] leading-relaxed whitespace-pre-wrap">
                {task.description}
              </p>
            </div>
          )}

          {editing && (
            <div className="flex gap-2">
              <button
                onClick={() => setEditing(false)}
                className="flex-1 py-2 rounded-xl border border-[#D4C5B0] text-sm text-[#8B7355] font-semibold hover:bg-[#F5EDE0] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={saveEdit}
                disabled={saving}
                className="flex-1 py-2 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors disabled:opacity-60"
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          )}

          {/* Attachment */}
          <div>
            <p className="text-xs font-semibold text-[#8B7355] mb-2">Attachment</p>
            {task.attachment_url ? (
              <div className="flex items-start gap-3">
                <img
                  src={task.attachment_url}
                  alt="Task attachment"
                  onClick={() => setLightbox(true)}
                  className="w-24 h-24 object-cover rounded-lg border border-[#EDE5D8] shadow-sm cursor-pointer"
                />
                {canAttach && (
                  <button
                    onClick={removeAttachment}
                    className="text-xs text-[#9E4A30] hover:underline mt-1"
                  >
                    Remove
                  </button>
                )}
              </div>
            ) : canAttach ? (
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="flex items-center gap-2 px-4 py-3 border-2 border-dashed border-[#D4C5B0] rounded-xl text-sm text-[#8B7355] hover:border-[#C4813A] hover:text-[#3D2B1F] transition-colors w-full justify-center disabled:opacity-60"
              >
                {uploading ? 'Uploading...' : '+ Add Image'}
              </button>
            ) : (
              <p className="text-xs text-[#A09080]">No attachment</p>
            )}
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
          </div>

          {/* Status change */}
          {canChangeStatus && (
            <div>
              <p className="text-xs font-semibold text-[#8B7355] mb-2">Move to</p>
              <div className="flex gap-2">
                {COLUMNS.map(col => (
                  <button
                    key={col.key}
                    onClick={() => task.status !== col.key && onStatusChange(col.key)}
                    disabled={task.status === col.key}
                    className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                      task.status === col.key
                        ? col.key === 'done'        ? 'bg-[#3D7A50] text-white cursor-default'
                        : col.key === 'in_progress' ? 'bg-[#2E6E9E] text-white cursor-default'
                        :                             'bg-[#8B6344] text-white cursor-default'
                        : 'bg-[#EDE5D8] text-[#8B7355] hover:bg-[#E0D5C5]'
                    }`}
                  >
                    {col.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Comments */}
          <div>
            <p className="text-xs font-semibold text-[#8B7355] mb-3">
              Comments ({comments.length})
            </p>
            {comments.length > 0 && (
              <div className="space-y-3 mb-4">
                {comments.map(c => (
                  <div key={c.id} className="flex gap-2.5">
                    <Avatar name={c.staff?.name ?? '?'} avatar={c.staff?.avatar ?? null} size="sm" />
                    <div className="flex-1 bg-[#FAF6F1] rounded-xl px-3 py-2.5">
                      <div className="flex items-baseline gap-2 mb-1">
                        <span className="text-xs font-semibold text-[#3D2B1F]">
                          {c.staff?.name ?? 'Unknown'}
                        </span>
                        <span className="text-xs text-[#A09080]">
                          {new Date(c.created_at).toLocaleDateString('en-MY', {
                            day: 'numeric', month: 'short',
                          })}
                        </span>
                      </div>
                      <p className="text-sm text-[#3D2B1F] leading-relaxed">{c.comment}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {comments.length === 0 && (
              <p className="text-xs text-[#A09080] mb-4">No comments yet. Be the first!</p>
            )}
            <form onSubmit={postComment} className="flex gap-2">
              <input
                type="text"
                value={newComment}
                onChange={e => setNewComment(e.target.value)}
                placeholder="Add a comment..."
                className="flex-1 px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-[#3D2B1F] focus:outline-none focus:ring-2 focus:ring-[#C4813A40]"
              />
              <button
                type="submit"
                disabled={posting || !newComment.trim()}
                className="px-4 py-2 rounded-lg bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors disabled:opacity-50"
              >
                {posting ? '...' : 'Post'}
              </button>
            </form>
          </div>
        </div>

        {/* Lightbox */}
        {lightbox && task.attachment_url && (
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4"
            onClick={() => setLightbox(false)}
          >
            <img src={task.attachment_url} alt="Task attachment full size" className="max-w-full max-h-full rounded-lg" />
          </div>
        )}

        {/* Footer actions (manager only) */}
        {canManage && !editing && (
          <div className="px-6 py-4 border-t border-[#EDE5D8] flex gap-2">
            <button
              onClick={startEdit}
              className="flex-1 py-2 rounded-xl border border-[#D4C5B0] text-sm text-[#8B7355] font-semibold hover:bg-[#F5EDE0] transition-colors"
            >
              Edit Task
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-4 py-2 rounded-xl bg-[#FCF0EC] text-[#9E4A30] text-sm font-semibold hover:bg-[#F5DDD5] transition-colors disabled:opacity-60"
            >
              {deleting ? '...' : 'Delete'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── TasksPage ────────────────────────────────────────────────────────────────

export default function TasksPage() {
  const { staff: currentStaff } = useAuth()
  const [tasks,    setTasks]    = useState<Task[]>([])
  const [allStaff, setAllStaff] = useState<Staff[]>([])
  const [loading,  setLoading]  = useState(true)

  // Drag state
  const [draggingId,  setDraggingId]  = useState<string | null>(null)
  const [dragOverCol, setDragOverCol] = useState<TaskStatus | null>(null)

  // Filters
  const [search,        setSearch]        = useState('')
  const [myTasksOnly,   setMyTasksOnly]   = useState(false)
  const [filterDept,    setFilterDept]    = useState('')
  const [filterAssignee, setFilterAssignee] = useState('')

  // Modals
  const [createOpen, setCreateOpen] = useState(false)
  const [editTask,   setEditTask]   = useState<Task | null>(null)
  const [detailTask, setDetailTask] = useState<Task | null>(null)

  // Mobile tab
  const [mobileTab, setMobileTab] = useState<TaskStatus>('todo')

  const canManage     = currentStaff?.rank === 'supervisor' || currentStaff?.rank === 'manager'
  const currentStaffId = currentStaff?.id ?? ''

  async function loadTasks() {
    const [tasksRes, staffRes] = await Promise.all([
      supabase
        .from('tasks')
        .select(`
          *,
          assignee:staff!tasks_assigned_to_fkey(id,name,avatar),
          creator:staff!tasks_created_by_fkey(id,name,avatar),
          task_comments(count)
        `)
        .order('created_at', { ascending: false }),
      supabase
        .from('staff')
        .select('id,name,avatar,rank,department')
        .order('name'),
    ])

    if (tasksRes.data) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setTasks((tasksRes.data as any[]).map(t => ({
        ...t,
        _comment_count: t.task_comments?.[0]?.count ?? 0,
      })) as Task[])
    }
    if (staffRes.data) setAllStaff(staffRes.data as Staff[])
    setLoading(false)
  }

  useEffect(() => { loadTasks() }, [])

  async function handleDrop(targetStatus: TaskStatus) {
    const id = draggingId
    if (!id) return
    const task = tasks.find(t => t.id === id)
    setDraggingId(null)
    setDragOverCol(null)
    if (!task || task.status === targetStatus) return
    if (!canManage && task.assigned_to !== currentStaffId) return

    const prevStatus = task.status
    setTasks(prev => prev.map(t => t.id === id ? { ...t, status: targetStatus } : t))

    const { error } = await supabase
      .from('tasks')
      .update({ status: targetStatus, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) {
      setTasks(prev => prev.map(t => t.id === id ? { ...t, status: prevStatus } : t))
    }
  }

  function handleStatusChange(taskId: string, newStatus: TaskStatus) {
    const prevTask = tasks.find(t => t.id === taskId)
    if (!prevTask) return
    const prevStatus = prevTask.status

    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: newStatus } : t))
    setDetailTask(prev => prev?.id === taskId ? { ...prev, status: newStatus } : prev)

    supabase
      .from('tasks')
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', taskId)
      .then(({ error }) => {
        if (error) {
          setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: prevStatus } : t))
          setDetailTask(prev => prev?.id === taskId ? { ...prev, status: prevStatus } : prev)
        }
      })
  }

  function clearDragState() {
    setDraggingId(null)
    setDragOverCol(null)
  }

  const filteredTasks = tasks.filter(t => {
    if (myTasksOnly && t.assigned_to !== currentStaffId) return false
    if (filterDept && t.department !== filterDept) return false
    if (filterAssignee && t.assigned_to !== filterAssignee) return false
    if (search && !t.title.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const tasksByCol: Record<TaskStatus, Task[]> = {
    todo:        filteredTasks.filter(t => t.status === 'todo'),
    in_progress: filteredTasks.filter(t => t.status === 'in_progress'),
    done:        filteredTasks.filter(t => t.status === 'done'),
  }

  if (loading) {
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
      {(createOpen || editTask) && (
        <CreateEditModal
          task={editTask}
          allStaff={allStaff}
          currentStaffId={currentStaffId}
          onClose={() => { setCreateOpen(false); setEditTask(null) }}
          onSaved={loadTasks}
        />
      )}
      {detailTask && (
        <TaskDetailModal
          task={detailTask}
          allStaff={allStaff}
          canManage={canManage}
          currentStaffId={currentStaffId}
          onClose={() => setDetailTask(null)}
          onDeleted={() => { setDetailTask(null); loadTasks() }}
          onStatusChange={status => handleStatusChange(detailTask.id, status)}
          onRefresh={loadTasks}
          onTaskUpdated={updated => {
            setDetailTask(updated)
            setTasks(prev => prev.map(t => t.id === updated.id ? updated : t))
          }}
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
              onClick={() => { setEditTask(null); setCreateOpen(true) }}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors shadow-sm"
            >
              + New Task
            </button>
          )}
        </div>

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
          <select
            className={selectCls}
            value={filterDept}
            onChange={e => setFilterDept(e.target.value)}
          >
            <option value="">All departments</option>
            {TASK_DEPTS.map(d => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
          <select
            className={selectCls}
            value={filterAssignee}
            onChange={e => setFilterAssignee(e.target.value)}
          >
            <option value="">All assignees</option>
            {allStaff.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>

        {/* Mobile column tabs */}
        <div className="flex sm:hidden gap-1 mb-4 bg-[#EDE5D8] rounded-xl p-1">
          {COLUMNS.map(col => (
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
              <span className="opacity-60">({tasksByCol[col.key].length})</span>
            </button>
          ))}
        </div>

        {/* Desktop: 3-column Kanban */}
        <div className="hidden sm:grid grid-cols-3 gap-4">
          {COLUMNS.map(col => (
            <KanbanColumn
              key={col.key}
              colKey={col.key}
              label={col.label}
              tasks={tasksByCol[col.key]}
              canManage={canManage}
              currentStaffId={currentStaffId}
              isDragOver={dragOverCol === col.key}
              onDragOver={e => { e.preventDefault(); setDragOverCol(col.key) }}
              onDragLeave={() => setDragOverCol(null)}
              onDrop={e => { e.preventDefault(); handleDrop(col.key) }}
              draggingId={draggingId}
              onDragStart={id => setDraggingId(id)}
              onDragEnd={clearDragState}
              onCardClick={task => setDetailTask(task)}
              onAddClick={() => { setEditTask(null); setCreateOpen(true) }}
            />
          ))}
        </div>

        {/* Mobile: single active column */}
        <div className="sm:hidden">
          <KanbanColumn
            colKey={mobileTab}
            label={COLUMNS.find(c => c.key === mobileTab)!.label}
            tasks={tasksByCol[mobileTab]}
            canManage={canManage}
            currentStaffId={currentStaffId}
            isDragOver={false}
            onDragOver={() => {}}
            onDragLeave={() => {}}
            onDrop={() => {}}
            draggingId={null}
            onDragStart={() => {}}
            onDragEnd={() => {}}
            onCardClick={task => setDetailTask(task)}
            onAddClick={() => { setEditTask(null); setCreateOpen(true) }}
            showMobileActions
            onCardStatusChange={handleStatusChange}
          />
        </div>

      </div>
    </div>
  )
}
