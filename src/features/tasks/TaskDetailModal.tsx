import { useState, useEffect, useRef, useCallback } from 'react'
import { Avatar } from '../../shared/components/Avatar'
import { useLookups } from '../../shared/lib/lookups'
import { isOverdue } from '../../shared/lib/tasks'
import type { Staff } from '../../shared/types'
import {
  fetchAttachments, uploadAttachment, deleteAttachment, updateTask, deleteTask,
} from './api'
import { TASK_COLUMNS } from './types'
import type { Attachment, Task, TaskPriority, TaskStatus } from './types'
import { PRIORITY_CFG, fmtDate } from './TaskCard'
import { CommentThread } from './CommentThread'

const statusLabel: Record<TaskStatus, string> = {
  todo: 'To Do', in_progress: 'In Progress', done: 'Done',
}

export function TaskDetailModal({
  task, allStaff, canManage, currentStaffId, onClose, onChanged, onStatusChange,
}: {
  task: Task
  allStaff: Staff[]
  canManage: boolean
  currentStaffId: string
  onClose: () => void
  /** 任务本体有变动 —— 请页面层重新拉板。 */
  onChanged: () => void
  onStatusChange: (status: TaskStatus) => void
}) {
  const { deptName } = useLookups()
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [deleting, setDeleting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [lightbox, setLightbox] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    title:       task.title,
    description: task.description ?? '',
    priority:    task.priority,
    assigned_to: task.assigned_to ?? '',
    due_date:    task.due_date ?? '',
  })

  const isAssignee      = task.assigned_to === currentStaffId
  const canChangeStatus = canManage || isAssignee
  const canAttach       = canManage || isAssignee
  const pCfg            = PRIORITY_CFG[editing ? form.priority : task.priority]
  const overdue         = isOverdue(task.due_date, new Date())
  const attachment: Attachment | null = attachments[0] ?? null

  const loadAttachments = useCallback(async () => {
    try {
      setAttachments(await fetchAttachments(task.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load attachments.')
    }
  }, [task.id])

  useEffect(() => { loadAttachments() }, [loadAttachments])

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
    const res = await updateTask(task.id, {
      title:       form.title.trim(),
      description: form.description.trim() || null,
      priority:    form.priority,
      assigned_to: form.assigned_to || null,
      due_date:    form.due_date || null,
    })
    setSaving(false)
    if (!res.ok) { setError(`Could not save the task — ${res.reason}`); return }
    setError('')
    setEditing(false)
    onChanged()
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    const res = await uploadAttachment(task.id, file, currentStaffId)
    setUploading(false)
    if (fileRef.current) fileRef.current.value = ''
    if (!res.ok) { setError(`Could not upload the image — ${res.reason}`); return }
    setError('')
    await loadAttachments()
    onChanged()
  }

  async function removeAttachment(att: Attachment) {
    const res = await deleteAttachment(att)
    if (!res.ok) { setError(`Could not remove the image — ${res.reason}`); return }
    setError('')
    await loadAttachments()
    onChanged()
  }

  async function handleDelete() {
    if (!window.confirm('Delete this task? This cannot be undone.')) return
    setDeleting(true)
    const res = await deleteTask(task.id)
    setDeleting(false)
    if (!res.ok) { setError(`Could not delete the task — ${res.reason}`); return }
    onClose()
    onChanged()
  }

  const inputCls = 'w-full px-2.5 py-1.5 rounded-lg border border-[#D4C5B0] bg-white text-xs text-[#3D2B1F] focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

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
                  {deptName(task.department)}
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

          {error && (
            <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>
          )}

          {/* Meta */}
          <div className="grid grid-cols-2 gap-4 text-xs">
            <div>
              <p className="text-[#A09080] font-medium mb-1">Assigned To</p>
              {editing ? (
                <select
                  className={inputCls}
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
                  className={inputCls}
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
                  className={inputCls}
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
            {attachment ? (
              <div className="flex items-start gap-3">
                <img
                  src={attachment.url}
                  alt="Task attachment"
                  onClick={() => setLightbox(true)}
                  className="w-24 h-24 object-cover rounded-lg border border-[#EDE5D8] shadow-sm cursor-pointer"
                />
                {canAttach && (
                  <button
                    onClick={() => removeAttachment(attachment)}
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
                {TASK_COLUMNS.map(col => (
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

          <CommentThread taskId={task.id} currentStaffId={currentStaffId} onPosted={onChanged} />
        </div>

        {/* Lightbox */}
        {lightbox && attachment && (
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4"
            onClick={() => setLightbox(false)}
          >
            <img src={attachment.url} alt="Task attachment full size" className="max-w-full max-h-full rounded-lg" />
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
