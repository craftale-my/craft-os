import { useState, useEffect } from 'react'
import { useLookups } from '../../shared/lib/lookups'
import { createTask, updateTask, fetchProjects } from './api'
import type { Project, StaffLite, Task, TaskPriority } from './types'

/**
 * 新增 / 编辑任务。`task` 为 null 即新增。
 * `nextPosition` 是 To Do 栏底部的落点 —— 建立时必须给,栏内排序才有依据。
 */
export function TaskFormModal({
  task, allStaff, currentStaffId, nextPosition, projectId = null, onClose, onSaved,
}: {
  task: Task | null
  allStaff: StaffLite[]
  currentStaffId: string
  nextPosition: number
  /**
   * 新建的任务预设归给哪个专案。从 /team/projects/:id 开的表单一律带着那个
   * 专案,不然使用者在专案页上建的任务会掉进「没有专案」那一堆,而且当场从
   * 这块板上消失(这块板只查这个专案)。这一栏现在是表单里一个真的下拉
   * (见下面的 form.project_id),这个 prop 只决定它的初始值 —— 使用者存档前
   * 仍然可以改选别的专案,或改回 "No project"。
   */
  projectId?: string | null
  onClose: () => void
  onSaved: () => void
}) {
  const { departmentOptions } = useLookups()
  const [form, setForm] = useState({
    title:       task?.title       ?? '',
    description: task?.description ?? '',
    assigned_to: task?.assigned_to ?? '',
    priority:    (task?.priority   ?? 'medium') as TaskPriority,
    due_date:    task?.due_date    ?? '',
    department:  task?.department  ?? '',
    project_id:  task?.project_id  ?? projectId ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  // 专案下拉的选项。自己管自己的读取,不靠呼叫端往下传 —— 这个弹窗从
  // /team/tasks 与 /team/projects/:id 两处开,后者不该为了这一颗下拉多接一条
  // props 线路。跟 ChecklistEditor / AttachmentGallery 同一个规格:读失败不
  // 挡住表单其余栏位,但要把话说出来,不能静静吞掉 —— "reads throw" 那条
  // 规则不是只管 api.ts 那一层,呼叫端接到之后也不能假装什么都没发生。
  const [projects, setProjects] = useState<Project[]>([])
  const [projectsError, setProjectsError] = useState('')
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const rows = await fetchProjects()
        if (cancelled) return
        setProjects(rows ?? [])
        setProjectsError('')
      } catch (e) {
        if (!cancelled) {
          setProjectsError(e instanceof Error ? e.message : 'Could not load the project list.')
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

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
      project_id:  form.project_id || null,
    }

    // updated_at 由 tasks_touch trigger 维护,不再从前端塞。
    const res = task
      ? await updateTask(task.id, payload)
      : await createTask(
          { ...payload, status: 'todo', position: nextPosition },
          currentStaffId,
        )

    setSaving(false)
    // res.reason 是没有主词的句子片段(「it was not saved — …」),
    // 一定要接在自己的句首后面,别裸着丢给使用者。
    if (!res.ok) { setError(`Could not save the task — ${res.reason}`); return }
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
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Department (optional)</label>
              <select className={inputCls} value={form.department} onChange={set('department')}>
                <option value="">All departments</option>
                {departmentOptions(form.department).map(d => (
                  <option key={d.slug} value={d.slug}>{d.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Project (optional)</label>
              <select className={inputCls} value={form.project_id} onChange={set('project_id')}>
                <option value="">No project</option>
                {projects.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              {projectsError && (
                <p className="text-[11px] text-red-600 mt-1">Could not load projects — {projectsError}</p>
              )}
            </div>
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
