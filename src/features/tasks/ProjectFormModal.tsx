import { useState } from 'react'
import { createProject, updateProject } from './api'
import type { ProjectInput } from './api'
import { PROJECT_STATUS_LABELS } from './types'
import type { Project, ProjectStatus, StaffLite } from './types'

/** 六个预设色票。够分辨、又不跳出这个 app 的调色盘;要别的颜色走旁边的取色器。 */
const PRESET_COLORS = ['#C4813A', '#8B7355', '#6B8E5A', '#4A6FA5', '#A0522D', '#8B5A8B']

/**
 * 新增 / 编辑 Project。`project` 为 null 即新增。
 *
 * 存档一律看 WriteOutcome:RLS 挡掉的写入回 { data: [], error: null },
 * 只看 error 的话画面会关掉弹窗、跑一次重新载入,然后使用者发现自己刚打的
 * 东西不在清单上 —— 而且没有任何一句话说明发生了什么。
 */
export function ProjectFormModal({
  project, allStaff, currentStaffId, onClose, onSaved,
}: {
  project: Project | null
  allStaff: StaffLite[]
  currentStaffId: string
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    name:        project?.name        ?? '',
    description: project?.description ?? '',
    color:       project?.color       ?? PRESET_COLORS[0],
    status:      (project?.status     ?? 'active') as ProjectStatus,
    owner_id:    project?.owner_id    ?? '',
    start_date:  project?.start_date  ?? '',
    due_date:    project?.due_date    ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  const set = (k: keyof typeof form) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) => setForm(f => ({ ...f, [k]: e.target.value }))

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) { setError('Name is required.'); return }
    setSaving(true)
    setError('')

    const payload: ProjectInput = {
      name:        form.name.trim(),
      description: form.description.trim() || null,
      color:       form.color,
      status:      form.status,
      owner_id:    form.owner_id || null,
      start_date:  form.start_date || null,
      due_date:    form.due_date || null,
    }

    // created_at / updated_at 由资料库维护,不从前端塞。
    const res = project
      ? await updateProject(project.id, payload)
      : await createProject(payload, currentStaffId)

    setSaving(false)
    // res.reason 是没有主词的句子片段(「it was not saved — …」),
    // 一定要接在自己的句首后面,别裸着丢给使用者。
    if (!res.ok) { setError(`Could not save the project — ${res.reason}`); return }
    onSaved()
    onClose()
  }

  const labelCls = 'block text-xs font-semibold text-[#8B7355] mb-1'
  const inputCls = 'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-[#3D2B1F] focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-[#FDFAF6] rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#EDE5D8] sticky top-0 bg-[#FDFAF6]">
          <h2 className="font-bold text-[#3D2B1F] text-lg">{project ? 'Edit Project' : 'New Project'}</h2>
          <button onClick={onClose} className="text-[#A09080] hover:text-[#3D2B1F] text-xl leading-none">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          {error && (
            <p data-testid="project-form-error" className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>
          )}
          <div>
            <label className={labelCls} htmlFor="project-name">Name *</label>
            <input
              id="project-name"
              className={inputCls}
              value={form.name}
              onChange={set('name')}
              placeholder="What is this project called..."
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="project-description">Description</label>
            <textarea
              id="project-description"
              className={`${inputCls} resize-none`}
              rows={3}
              value={form.description}
              onChange={set('description')}
              placeholder="What is it for..."
            />
          </div>
          <div>
            <label className={labelCls}>Color</label>
            <div className="flex items-center gap-2 flex-wrap">
              {PRESET_COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Use color ${c}`}
                  aria-pressed={form.color.toLowerCase() === c.toLowerCase()}
                  onClick={() => setForm(f => ({ ...f, color: c }))}
                  className={`w-7 h-7 rounded-full border-2 transition-transform ${
                    form.color.toLowerCase() === c.toLowerCase()
                      ? 'border-[#3D2B1F] scale-110'
                      : 'border-transparent hover:scale-105'
                  }`}
                  style={{ background: c }}
                />
              ))}
              <input
                type="color"
                aria-label="Custom color"
                value={form.color}
                onChange={set('color')}
                className="w-9 h-7 rounded border border-[#D4C5B0] bg-white p-0.5 cursor-pointer"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} htmlFor="project-status">Status</label>
              <select id="project-status" className={inputCls} value={form.status} onChange={set('status')}>
                {(Object.keys(PROJECT_STATUS_LABELS) as ProjectStatus[]).map(s => (
                  <option key={s} value={s}>{PROJECT_STATUS_LABELS[s]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="project-owner">Owner</label>
              <select id="project-owner" className={inputCls} value={form.owner_id} onChange={set('owner_id')}>
                <option value="">Unassigned</option>
                {allStaff.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} htmlFor="project-start-date">Start Date</label>
              <input id="project-start-date" type="date" className={inputCls} value={form.start_date} onChange={set('start_date')} />
            </div>
            <div>
              <label className={labelCls} htmlFor="project-due-date">Due Date</label>
              <input id="project-due-date" type="date" className={inputCls} value={form.due_date} onChange={set('due_date')} />
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
              {saving ? 'Saving...' : project ? 'Save Changes' : 'Create Project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
