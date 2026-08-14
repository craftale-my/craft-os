import { useState } from 'react'
import { Avatar } from '../../shared/components/Avatar'
import { useLookups } from '../../shared/lib/lookups'
import { isOverdue } from '../../shared/lib/tasks'
import type { Staff } from '../../shared/types'
import { updateTask, deleteTask, upsertTag, attachTag, detachTag } from './api'
import { TASK_COLUMNS } from './types'
import type { MoveResult, Tag, Task, TaskPriority, TaskStatus } from './types'
import { PRIORITY_CFG, fmtDate } from './TaskCard'
import { AttachmentGallery } from './AttachmentGallery'
import { ChecklistEditor } from './ChecklistEditor'
import { CommentThread } from './CommentThread'
import { TagInput } from './TagInput'

const statusLabel: Record<TaskStatus, string> = {
  todo: 'To Do', in_progress: 'In Progress', done: 'Done',
}

export function TaskDetailModal({
  task, allStaff, allTags, canManage, currentStaffId, onClose, onChanged, onStatusChange,
}: {
  task: Task
  allStaff: Staff[]
  /** 给 TagInput 做建议清单;新建的 tag 要等下一次 onChanged() 落地后才会出现在这里。 */
  allTags: Tag[]
  canManage: boolean
  currentStaffId: string
  onClose: () => void
  /** 任务本体有变动 —— 请页面层重新拉板。 */
  onChanged: () => void
  /**
   * 换栏交给页面层写入,但结果要回传 —— 失败得显示在弹窗里,见 handleStatusChange。
   * 回 null 表示使用者在「还有子项没做完」的确认里按了取消:什么都没发生。
   */
  onStatusChange: (status: TaskStatus) => Promise<MoveResult>
}) {
  const { deptName } = useLookups()
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')

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

  /**
   * 换栏失败必须说在这里。弹窗是 fixed inset-0 z-50,页面横幅整个被盖在底下,
   * 使用者只会看到状态标签弹回去,却完全没有理由。
   */
  async function handleStatusChange(status: TaskStatus) {
    const res = await onStatusChange(status)
    // null = 软性完成确认被取消。没有写入、没有乐观更新,所以既不报错,
    // 也不把上一次真的失败留下的讯息当成「这次成功了」而收掉。
    if (!res) return
    setError(res.ok ? '' : `Could not move the task — ${res.reason}`)
  }

  /**
   * upsert → attach,中间没有乐观 UI —— 跟这个弹窗其它写入(存档、传附件)同款,
   * 使用者等两趟网路来回才看到 pill 出现,靠 onChanged() 的重拉板落地。
   *
   * attachTag 若在 upsertTag 已经把 tag 列写进去之后才失败,这里刻意不回滚
   * 那笔 tag:
   *  1. tags 本来就是人人可建的自由列表,一笔没被挂上任何任务的 tag 不是
   *     「孤儿」——它就是还没被用到,下次打同样的名字照样能透过 slug 命中它。
   *  2. upsertTag 用 onConflict 保证回传的是「这个 slug 目前唯一的那一列」,
   *     不保证「这次呼叫是造出它的那一次」;这段空档里,另一个使用者的
   *     handleAddTag 完全可能已经把同一笔 tag 挂到别的任务上。删掉它会连带
   *     扯断那笔已经成功的挂载。
   *  3. tags_delete 这条 RLS 只放行 manage_projects,大多数能挂 tag 的人根本
   *     没有删 tag 的权限——真的尝试回滚,对多数使用者而言只会是另一次静默
   *     失败,不会让状态更乾净。
   * 保留这笔 tag、把错误显示出来,让使用者重打一次:upsertTag 是幂等的,
   * 会拿回同一笔,重试的 attachTag 才是真正需要成功的那一步。
   */
  async function handleAddTag(raw: string) {
    try {
      const tag = await upsertTag(raw, currentStaffId)
      if (task.tags.some(t => t.id === tag.id)) return   // 已经挂上了,不重复插入 task_tags
      const res = await attachTag(task.id, tag.id)
      if (!res.ok) { setError(`Could not add the tag — ${res.reason}`); return }
      setError('')
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add the tag.')
    }
  }

  async function handleRemoveTag(tagId: string) {
    const res = await detachTag(task.id, tagId)
    if (!res.ok) { setError(`Could not remove the tag — ${res.reason}`); return }
    setError('')
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

          {/* Tags —— 自由输入,谁都能加,不跟 "Edit Task" 的表单绑在一起。 */}
          <div>
            <p className="text-xs font-semibold text-[#8B7355] mb-1.5">Tags</p>
            <TagInput value={task.tags} allTags={allTags} onAdd={handleAddTag} onRemove={handleRemoveTag} />
          </div>

          {/* Checklist —— 子项与它们各自的负责人。跟 Tags 一样不锁在编辑模式后面。 */}
          <ChecklistEditor taskId={task.id} allStaff={allStaff} onChanged={onChanged} />

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

          {/* Attachments —— 缩图墙 + lightbox,自己管自己的载入/上传/删除,细节见 AttachmentGallery。 */}
          <AttachmentGallery
            taskId={task.id}
            currentStaffId={currentStaffId}
            canEdit={canAttach}
            onChanged={onChanged}
          />

          {/* Status change */}
          {canChangeStatus && (
            <div>
              <p className="text-xs font-semibold text-[#8B7355] mb-2">Move to</p>
              <div className="flex gap-2">
                {TASK_COLUMNS.map(col => (
                  <button
                    key={col.key}
                    onClick={() => task.status !== col.key && handleStatusChange(col.key)}
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
