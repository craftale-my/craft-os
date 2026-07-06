import { useState, useEffect, useRef } from 'react'
import { supabase } from '../../shared/lib/supabase'
import { toCSV, downloadCSV } from '../../shared/lib/csv'
import type {
  CompanySettings, Branch, Role, SystemRule, NotificationSetting, Staff, Rank, ShiftType, Department, EmploymentType,
  SystemRole, Capability, CareerPath, Skill,
} from '../../shared/types'
import {
  RANK_LABELS, DEPT_LABELS, DEPT_SHIFT_COLORS,
  SYSTEM_ROLES, SYSTEM_ROLE_LABELS, SYSTEM_ROLE_DESC, CAPABILITIES,
} from '../../shared/types'
import { useLookups } from '../../shared/lib/lookups'
import { useCan } from '../../shared/lib/permissions'

const TABS = [
  { id: 'company',        label: 'Company Info',        icon: '🏢' },
  { id: 'branches',       label: 'Branches',            icon: '🏪' },
  { id: 'departments',    label: 'Departments',         icon: '🏷️' },
  { id: 'employment',     label: 'Employment Types',    icon: '📋' },
  { id: 'roles',          label: 'Roles & Permissions', icon: '👔' },
  { id: 'career',         label: 'Career Paths',        icon: '🎯' },
  { id: 'rules',          label: 'XP & Scoring Rules',  icon: '⚡' },
  { id: 'shifts',         label: 'Shift Types',         icon: '🕐' },
  { id: 'notifications',  label: 'Notifications',       icon: '🔔' },
  { id: 'data',           label: 'Data & Export',       icon: '📊' },
] as const

type TabId = typeof TABS[number]['id']

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'
const labelCls = 'block text-xs font-semibold text-brown-medium mb-1'

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative w-10 h-5.5 h-[22px] rounded-full transition-colors flex-shrink-0 ${
        checked ? 'bg-[#3D7A50]' : 'bg-[#D4C5B0]'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <span
        className={`absolute top-[2px] left-[2px] w-[18px] h-[18px] rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-[18px]' : ''
        }`}
      />
    </button>
  )
}

function Toast({ message }: { message: string }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 bg-[#3D2410] text-white text-sm font-medium px-4 py-2.5 rounded-xl shadow-xl">
      ✅ {message}
    </div>
  )
}

function useToast() {
  const [toast, setToast] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function show(msg: string) {
    setToast(msg)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setToast(''), 2200)
  }
  return { toast, show }
}

// ─── Company Info ──────────────────────────────────────────────────────────────

function CompanyInfoTab({ settings, onSaved }: { settings: CompanySettings; onSaved: (s: CompanySettings) => void }) {
  const [form, setForm] = useState(settings)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const { toast, show } = useToast()

  const set = (k: keyof CompanySettings) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    const ext = file.name.split('.').pop() ?? 'png'
    const filePath = `logo-${Date.now()}.${ext}`
    const { error: uploadErr } = await supabase.storage
      .from('company-assets')
      .upload(filePath, file, { contentType: file.type, upsert: true })
    if (!uploadErr) {
      const url = supabase.storage.from('company-assets').getPublicUrl(filePath).data.publicUrl
      setForm(f => ({ ...f, logo_url: url }))
    }
    setUploading(false)
  }

  async function handleSave() {
    setSaving(true)
    const { error } = await supabase
      .from('company_settings')
      .update({
        company_name: form.company_name,
        cafe_name: form.cafe_name,
        logo_url: form.logo_url,
        company_culture: form.company_culture,
        contact_email: form.contact_email,
        contact_phone: form.contact_phone,
        address: form.address,
        updated_at: new Date().toISOString(),
      })
      .eq('id', form.id)
    setSaving(false)
    if (!error) {
      onSaved(form)
      show('Company info saved')
    }
  }

  return (
    <div className="space-y-5 max-w-xl">
      {toast && <Toast message={toast} />}
      <div>
        <label className={labelCls}>Company Logo</label>
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-xl bg-white border border-[#E8DDD0] flex items-center justify-center overflow-hidden">
            {form.logo_url ? (
              <img src={form.logo_url} alt="logo" className="w-full h-full object-cover" />
            ) : (
              <span className="text-2xl">🏢</span>
            )}
          </div>
          <label className="px-3 py-2 rounded-lg border border-[#D4C5B0] text-xs font-semibold text-brown-medium hover:bg-[#F5EDE0] cursor-pointer transition-colors">
            {uploading ? 'Uploading…' : 'Upload Logo'}
            <input type="file" accept="image/*" className="hidden" onChange={handleLogoChange} disabled={uploading} />
          </label>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelCls}>Company Name</label>
          <input className={inputCls} value={form.company_name ?? ''} onChange={set('company_name')} />
        </div>
        <div>
          <label className={labelCls}>Cafe Name</label>
          <input className={inputCls} value={form.cafe_name ?? ''} onChange={set('cafe_name')} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelCls}>Contact Email</label>
          <input type="email" className={inputCls} value={form.contact_email ?? ''} onChange={set('contact_email')} />
        </div>
        <div>
          <label className={labelCls}>Contact Phone</label>
          <input className={inputCls} value={form.contact_phone ?? ''} onChange={set('contact_phone')} />
        </div>
      </div>
      <div>
        <label className={labelCls}>Company Address</label>
        <input className={inputCls} value={form.address ?? ''} onChange={set('address')} />
      </div>
      <div>
        <label className={labelCls}>Company Culture</label>
        <p className="text-xs text-brown-faint mb-1.5">Shown to new staff during onboarding step 1.</p>
        <textarea
          rows={5}
          className={`${inputCls} resize-none`}
          value={form.company_culture ?? ''}
          onChange={set('company_culture')}
          placeholder="We believe in craft, consistency, and care for every cup..."
        />
      </div>
      <button
        onClick={handleSave}
        disabled={saving}
        className="px-5 py-2.5 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors disabled:opacity-60"
      >
        {saving ? 'Saving...' : 'Save Changes'}
      </button>
    </div>
  )
}

// ─── Branches ──────────────────────────────────────────────────────────────────

function BranchModal({ branch, staffOptions, onClose, onSaved }: {
  branch: Partial<Branch> | null
  staffOptions: Staff[]
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    name: branch?.name ?? '',
    address: branch?.address ?? '',
    pic_staff_id: branch?.pic_staff_id ?? '',
    operating_hours: branch?.operating_hours ?? '',
  })
  const [saving, setSaving] = useState(false)

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function handleSave() {
    if (!form.name.trim()) return
    setSaving(true)
    const payload = {
      name: form.name.trim(),
      address: form.address.trim() || null,
      pic_staff_id: form.pic_staff_id || null,
      operating_hours: form.operating_hours.trim() || null,
    }
    if (branch?.id) {
      await supabase.from('branches').update(payload).eq('id', branch.id)
    } else {
      await supabase.from('branches').insert(payload)
    }
    setSaving(false)
    onSaved()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-cream-light rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E8DDD0]">
          <h2 className="font-bold text-brown-dark text-lg">{branch?.id ? 'Edit Branch' : 'Add Branch'}</h2>
          <button onClick={onClose} className="text-brown-faint hover:text-brown-dark text-xl leading-none">✕</button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div>
            <label className={labelCls}>Branch Name</label>
            <input className={inputCls} value={form.name} onChange={set('name')} placeholder="e.g. Cheras" />
          </div>
          <div>
            <label className={labelCls}>Address</label>
            <input className={inputCls} value={form.address} onChange={set('address')} />
          </div>
          <div>
            <label className={labelCls}>Person in Charge</label>
            <select className={inputCls} value={form.pic_staff_id} onChange={set('pic_staff_id')}>
              <option value="">None</option>
              {staffOptions.map(s => (
                <option key={s.id} value={s.id}>{s.name} ({RANK_LABELS[s.rank]})</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Operating Hours</label>
            <input className={inputCls} value={form.operating_hours} onChange={set('operating_hours')} placeholder="e.g. 8am - 10pm daily" />
          </div>
          <div className="flex gap-3 pt-1">
            <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-[#D4C5B0] text-sm text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 py-2.5 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors disabled:opacity-60"
            >
              {saving ? 'Saving...' : 'Save Branch'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function BranchesTab({ branches, staffOptions, onRefresh }: {
  branches: Branch[]
  staffOptions: Staff[]
  onRefresh: () => void
}) {
  const [modalTarget, setModalTarget] = useState<Partial<Branch> | null | 'new'>(null)
  const { toast, show } = useToast()

  async function toggleActive(b: Branch) {
    await supabase.from('branches').update({ is_active: !b.is_active }).eq('id', b.id)
    onRefresh()
    show(b.is_active ? 'Branch deactivated' : 'Branch activated')
  }

  return (
    <div className="space-y-4">
      {toast && <Toast message={toast} />}
      <div className="flex justify-end">
        <button
          onClick={() => setModalTarget('new')}
          className="px-4 py-2 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors"
        >
          + Add Branch
        </button>
      </div>
      <div className="space-y-3">
        {branches.map(b => (
          <div key={b.id} className={`bg-white rounded-xl border p-4 flex items-center gap-4 ${b.is_active ? 'border-[#E8DDD0]' : 'border-[#E8DDD0] opacity-60'}`}>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-brown-dark">{b.name}</p>
              <p className="text-xs text-brown-faint">{b.address || '—'}</p>
              <div className="flex flex-wrap gap-3 mt-1.5 text-xs text-brown-muted">
                <span>PIC: {b.pic?.name ?? '—'}</span>
                <span>Hours: {b.operating_hours ?? '—'}</span>
              </div>
            </div>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${b.is_active ? 'bg-[#EBF5EE] text-[#3D7A50]' : 'bg-[#F0E8DC] text-brown-faint'}`}>
              {b.is_active ? 'Active' : 'Inactive'}
            </span>
            <button
              onClick={() => setModalTarget(b)}
              className="px-3 py-1.5 text-xs rounded-lg border border-[#D4C5B0] text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors flex-shrink-0"
            >
              Edit
            </button>
            <button
              onClick={() => toggleActive(b)}
              className="px-3 py-1.5 text-xs rounded-lg border border-[#D4C5B0] text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors flex-shrink-0"
            >
              {b.is_active ? 'Deactivate' : 'Activate'}
            </button>
          </div>
        ))}
      </div>
      {modalTarget && (
        <BranchModal
          branch={modalTarget === 'new' ? null : modalTarget}
          staffOptions={staffOptions}
          onClose={() => setModalTarget(null)}
          onSaved={onRefresh}
        />
      )}
    </div>
  )
}

// ─── Departments ───────────────────────────────────────────────────────────────

function DepartmentsTab() {
  const { departments, refresh } = useLookups()
  const { toast, show } = useToast()
  const [editing, setEditing] = useState<{ id?: string; name: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function save() {
    if (!editing || !editing.name.trim()) return
    setSaving(true); setError('')
    if (editing.id) {
      const { error: err } = await supabase.from('departments').update({ name: editing.name.trim() }).eq('id', editing.id)
      if (err) { setError(err.message); setSaving(false); return }
      show('Department updated')
    } else {
      // slug is the canonical stored value; derived once from the name, then fixed.
      const slug = editing.name.trim().toLowerCase()
      const { error: err } = await supabase.from('departments').insert({ name: editing.name.trim(), slug })
      if (err) {
        setError(/duplicate|unique/i.test(err.message) ? 'A department with that name already exists.' : err.message)
        setSaving(false); return
      }
      show('Department added')
    }
    setSaving(false); setEditing(null); await refresh()
  }

  async function toggleStatus(d: Department) {
    await supabase.from('departments').update({ status: d.status === 'active' ? 'inactive' : 'active' }).eq('id', d.id)
    await refresh()
  }

  return (
    <div className="space-y-6">
      {toast && <Toast message={toast} />}

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-brown-dark">Departments</h2>
          <p className="text-xs text-brown-faint mt-0.5">Shown in registration, onboarding and profile dropdowns. Deactivating hides a department from new selections without affecting existing staff.</p>
        </div>
        <button
          onClick={() => { setEditing({ name: '' }); setError('') }}
          className="px-3 py-1.5 rounded-lg bg-[#C4813A] text-white text-xs font-semibold hover:bg-[#A86C2C] transition-colors flex-shrink-0"
        >
          + Add Department
        </button>
      </div>

      <div className="bg-white rounded-xl border border-[#E8DDD0] divide-y divide-[#F0E8DC]">
        {departments.length === 0 && (
          <p className="px-4 py-6 text-xs text-brown-faint text-center">
            No departments yet. Add one, or run the departments migration if the list looks empty.
          </p>
        )}
        {departments.map(d => (
          <div key={d.id} className="flex items-center gap-3 px-4 py-3">
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-semibold ${d.status === 'active' ? 'text-brown-dark' : 'text-brown-faint line-through'}`}>{d.name}</p>
              <p className="text-[11px] text-brown-faint">{d.slug}</p>
            </div>
            <button
              onClick={() => toggleStatus(d)}
              className={`text-xs font-medium px-2 py-0.5 rounded-full transition-colors ${
                d.status === 'active' ? 'bg-[#EBF5EE] text-[#3D7A50]' : 'bg-[#F5EDE0] text-brown-faint'
              }`}
            >
              {d.status === 'active' ? 'Active' : 'Inactive'}
            </button>
            <button onClick={() => { setEditing({ id: d.id, name: d.name }); setError('') }} className="text-xs text-brown-faint hover:text-brown-dark transition-colors px-2 py-1">Edit</button>
          </div>
        ))}
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40">
          <div className="w-full sm:max-w-sm bg-white rounded-t-3xl sm:rounded-2xl shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#F0E8DC]">
              <h3 className="font-bold text-brown-dark">{editing.id ? 'Edit Department' : 'Add Department'}</h3>
              <button onClick={() => setEditing(null)} className="p-1 text-brown-faint hover:text-brown-dark">✕</button>
            </div>
            <div className="px-5 py-5 space-y-4">
              <div>
                <label className={labelCls}>Department Name</label>
                <input
                  className={inputCls}
                  value={editing.name}
                  autoFocus
                  onChange={e => setEditing(p => p && { ...p, name: e.target.value })}
                  placeholder="e.g. Kitchen Prep"
                />
              </div>
              {error && <p className="text-xs text-red-600">{error}</p>}
              <button
                onClick={save}
                disabled={saving || !editing.name.trim()}
                className="w-full py-2.5 rounded-xl bg-[#C4813A] text-white font-semibold text-sm hover:bg-[#A86C2C] disabled:opacity-50 transition-colors"
              >
                {saving ? 'Saving…' : editing.id ? 'Save Changes' : 'Add Department'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Employment Types ────────────────────────────────────────────────────────

function EmploymentTypesTab() {
  const { employmentTypes, refresh } = useLookups()
  const { toast, show } = useToast()
  const [editing, setEditing] = useState<{ id?: string; name: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function save() {
    if (!editing || !editing.name.trim()) return
    setSaving(true); setError('')
    if (editing.id) {
      const { error: err } = await supabase.from('employment_types').update({ name: editing.name.trim() }).eq('id', editing.id)
      if (err) { setError(err.message); setSaving(false); return }
      show('Employment type updated')
    } else {
      const { error: err } = await supabase.from('employment_types').insert({ name: editing.name.trim() })
      if (err) {
        setError(/duplicate|unique/i.test(err.message) ? 'That employment type already exists.' : err.message)
        setSaving(false); return
      }
      show('Employment type added')
    }
    setSaving(false); setEditing(null); await refresh()
  }

  async function toggleStatus(e: EmploymentType) {
    await supabase.from('employment_types').update({ status: e.status === 'active' ? 'inactive' : 'active' }).eq('id', e.id)
    await refresh()
  }

  return (
    <div className="space-y-6">
      {toast && <Toast message={toast} />}

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-brown-dark">Employment Types</h2>
          <p className="text-xs text-brown-faint mt-0.5">Shown in registration, onboarding and profile dropdowns. Deactivating hides a type from new selections without affecting existing staff.</p>
        </div>
        <button
          onClick={() => { setEditing({ name: '' }); setError('') }}
          className="px-3 py-1.5 rounded-lg bg-[#C4813A] text-white text-xs font-semibold hover:bg-[#A86C2C] transition-colors flex-shrink-0"
        >
          + Add Type
        </button>
      </div>

      <div className="bg-white rounded-xl border border-[#E8DDD0] divide-y divide-[#F0E8DC]">
        {employmentTypes.length === 0 && (
          <p className="px-4 py-6 text-xs text-brown-faint text-center">
            No employment types yet. Add one, or run the migration if the list looks empty.
          </p>
        )}
        {employmentTypes.map(e => (
          <div key={e.id} className="flex items-center gap-3 px-4 py-3">
            <p className={`flex-1 min-w-0 text-sm font-semibold ${e.status === 'active' ? 'text-brown-dark' : 'text-brown-faint line-through'}`}>{e.name}</p>
            <button
              onClick={() => toggleStatus(e)}
              className={`text-xs font-medium px-2 py-0.5 rounded-full transition-colors ${
                e.status === 'active' ? 'bg-[#EBF5EE] text-[#3D7A50]' : 'bg-[#F5EDE0] text-brown-faint'
              }`}
            >
              {e.status === 'active' ? 'Active' : 'Inactive'}
            </button>
            <button onClick={() => { setEditing({ id: e.id, name: e.name }); setError('') }} className="text-xs text-brown-faint hover:text-brown-dark transition-colors px-2 py-1">Edit</button>
          </div>
        ))}
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40">
          <div className="w-full sm:max-w-sm bg-white rounded-t-3xl sm:rounded-2xl shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#F0E8DC]">
              <h3 className="font-bold text-brown-dark">{editing.id ? 'Edit Employment Type' : 'Add Employment Type'}</h3>
              <button onClick={() => setEditing(null)} className="p-1 text-brown-faint hover:text-brown-dark">✕</button>
            </div>
            <div className="px-5 py-5 space-y-4">
              <div>
                <label className={labelCls}>Name</label>
                <input
                  className={inputCls}
                  value={editing.name}
                  autoFocus
                  onChange={ev => setEditing(p => p && { ...p, name: ev.target.value })}
                  placeholder="e.g. Internship"
                />
              </div>
              {error && <p className="text-xs text-red-600">{error}</p>}
              <button
                onClick={save}
                disabled={saving || !editing.name.trim()}
                className="w-full py-2.5 rounded-xl bg-[#C4813A] text-white font-semibold text-sm hover:bg-[#A86C2C] disabled:opacity-50 transition-colors"
              >
                {saving ? 'Saving…' : editing.id ? 'Save Changes' : 'Add Type'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Roles & Permissions ───────────────────────────────────────────────────────

function RoleModal({ role, onClose, onSaved }: {
  role: Partial<Role> | null
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    name: role?.name ?? '',
    rank: role?.rank ?? 'trainee',
    department: role?.department ?? '',
    description: role?.description ?? '',
  })
  const [saving, setSaving] = useState(false)

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function handleSave() {
    if (!form.name.trim()) return
    setSaving(true)
    const payload = {
      name: form.name.trim(),
      rank: form.rank,
      department: form.department.trim() || null,
      description: form.description.trim() || null,
    }
    if (role?.id) {
      await supabase.from('roles').update(payload).eq('id', role.id)
    } else {
      await supabase.from('roles').insert(payload)
    }
    setSaving(false)
    onSaved()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-cream-light rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E8DDD0]">
          <h2 className="font-bold text-brown-dark text-lg">{role?.id ? 'Edit Role' : 'Add New Role'}</h2>
          <button onClick={onClose} className="text-brown-faint hover:text-brown-dark text-xl leading-none">✕</button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div>
            <label className={labelCls}>Role Name</label>
            <input className={inputCls} value={form.name} onChange={set('name')} placeholder="e.g. Senior Barista" />
          </div>
          <div>
            <label className={labelCls}>Rank Level</label>
            <select className={inputCls} value={form.rank} onChange={set('rank')}>
              {(['trainee', 'junior', 'senior', 'supervisor', 'manager'] as Rank[]).map(r => (
                <option key={r} value={r}>{RANK_LABELS[r]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Department</label>
            <input className={inputCls} value={form.department} onChange={set('department')} placeholder="e.g. barista" />
          </div>
          <div>
            <label className={labelCls}>Description</label>
            <textarea rows={2} className={`${inputCls} resize-none`} value={form.description} onChange={set('description')} />
          </div>
          <div className="flex gap-3 pt-1">
            <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-[#D4C5B0] text-sm text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 py-2.5 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors disabled:opacity-60"
            >
              {saving ? 'Saving...' : 'Save Role'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function RolesTab({ roles, allStaff, onRefresh }: { roles: Role[]; allStaff: Staff[]; onRefresh: () => void }) {
  const { isOwner } = useCan()
  const [sub, setSub] = useState<'titles' | 'system'>('titles')

  const subTabs: { id: 'titles' | 'system'; label: string }[] = [
    { id: 'titles', label: 'Job Titles' },
    ...(isOwner ? [{ id: 'system' as const, label: 'System Roles' }] : []),
  ]

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-bold text-brown-dark">Roles & Permissions</h2>
        <p className="text-xs text-brown-faint mt-0.5">
          Job Titles are display headlines. System Roles control access to Craft OS.
        </p>
      </div>

      <div className="flex gap-1 bg-white rounded-lg border border-[#E8DDD0] p-0.5 w-fit">
        {subTabs.map(t => (
          <button
            key={t.id}
            onClick={() => setSub(t.id)}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
              sub === t.id ? 'bg-[#C4813A] text-white' : 'text-brown-muted hover:bg-[#F5EDE0]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {sub === 'titles' && <JobTitlesTab roles={roles} onRefresh={onRefresh} />}
      {sub === 'system' && isOwner && <SystemRolesTab allStaff={allStaff} onRefresh={onRefresh} />}
    </div>
  )
}

// ── Job Titles (display-only headlines; no access control) ──

function JobTitlesTab({ roles, onRefresh }: { roles: Role[]; onRefresh: () => void }) {
  const [modalTarget, setModalTarget] = useState<Partial<Role> | null | 'new'>(null)

  async function toggleActive(r: Role) {
    await supabase.from('roles').update({ is_active: !r.is_active }).eq('id', r.id)
    onRefresh()
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-brown-faint">Assigned to staff as a headline (e.g. "Senior Barista"). Does not change access or rank.</p>
        <button
          onClick={() => setModalTarget('new')}
          className="px-3 py-1.5 rounded-lg bg-[#C4813A] text-white text-xs font-semibold hover:bg-[#A86C2C] transition-colors flex-shrink-0"
        >
          + Add Job Title
        </button>
      </div>
      <div className="bg-white rounded-xl border border-[#E8DDD0] overflow-hidden overflow-x-auto">
        <table className="w-full text-sm min-w-[480px]">
          <thead>
            <tr className="border-b border-[#EDE5D8]">
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-brown-faint">Name</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-brown-faint">Rank</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-brown-faint">Department</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-brown-faint">Status</th>
              <th className="text-right px-4 py-2.5 text-xs font-semibold text-brown-faint">Actions</th>
            </tr>
          </thead>
          <tbody>
            {roles.map((r, i) => (
              <tr key={r.id} className={i > 0 ? 'border-t border-[#F0E8DC]' : ''}>
                <td className="px-4 py-2.5 font-medium text-brown-dark">{r.name}</td>
                <td className="px-4 py-2.5 text-brown-faint">{RANK_LABELS[r.rank]}</td>
                <td className="px-4 py-2.5 text-brown-faint">{r.department ?? '—'}</td>
                <td className="px-4 py-2.5">
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${r.is_active ? 'bg-[#EBF5EE] text-[#3D7A50]' : 'bg-[#F0E8DC] text-brown-faint'}`}>
                    {r.is_active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right whitespace-nowrap">
                  <button onClick={() => setModalTarget(r)} className="text-xs font-semibold text-[#C4813A] mr-3 hover:underline">Edit</button>
                  <button onClick={() => toggleActive(r)} className="text-xs font-semibold text-brown-muted hover:underline">
                    {r.is_active ? 'Deactivate' : 'Activate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modalTarget && (
        <RoleModal
          role={modalTarget === 'new' ? null : modalTarget}
          onClose={() => setModalTarget(null)}
          onSaved={onRefresh}
        />
      )}
    </div>
  )
}

// ── System Roles (Owner-only: capability matrix + staff assignment) ──

function SystemRolesTab({ allStaff, onRefresh }: { allStaff: Staff[]; onRefresh: () => void }) {
  const { roleCaps, refresh: refreshLookups } = useLookups()
  const { toast, show } = useToast()
  const [savingRole, setSavingRole] = useState<SystemRole | null>(null)
  const [savingStaff, setSavingStaff] = useState<string | null>(null)

  async function toggleCap(role: SystemRole, cap: Capability) {
    if (role === 'owner') return                 // owner is always fully privileged
    if (cap === 'manage_system_roles') return    // owner-only by design, not grantable here
    setSavingRole(role)
    const next = { ...roleCaps[role], [cap]: !roleCaps[role]?.[cap] }
    await supabase.from('system_role_permissions').upsert(
      { system_role: role, permissions: next, updated_at: new Date().toISOString() },
      { onConflict: 'system_role' },
    )
    await refreshLookups()
    setSavingRole(null)
    show('Permissions updated')
  }

  async function assignRole(staffId: string, role: SystemRole) {
    setSavingStaff(staffId)
    await supabase.from('staff').update({ system_role: role }).eq('id', staffId)
    setSavingStaff(null)
    onRefresh()
    show('System role updated')
  }

  const activeStaff = allStaff.filter(s => s.status !== 'resigned')

  return (
    <div className="space-y-8">
      {toast && <Toast message={toast} />}

      {/* Capability matrix */}
      <div>
        <h3 className="text-sm font-bold text-brown-dark mb-1">Permission Matrix</h3>
        <p className="text-xs text-brown-faint mb-3">Owner is always fully privileged. Changes take effect across navigation, routes and data access.</p>
        <div className="bg-white rounded-xl border border-[#E8DDD0] overflow-x-auto">
          <table className="w-full text-xs min-w-[900px]">
            <thead>
              <tr className="border-b border-[#EDE5D8]">
                <th className="text-left px-4 py-2.5 font-semibold text-brown-faint sticky left-0 bg-white">Role</th>
                {CAPABILITIES.map(c => (
                  <th key={c.key} className="px-2 py-2.5 font-semibold text-brown-faint text-center whitespace-nowrap">{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SYSTEM_ROLES.map((role, i) => (
                <tr key={role} className={i > 0 ? 'border-t border-[#F0E8DC]' : ''}>
                  <td className="px-4 py-2 sticky left-0 bg-white whitespace-nowrap">
                    <span className="font-medium text-brown-dark">{SYSTEM_ROLE_LABELS[role]}</span>
                    {savingRole === role && <span className="text-[10px] text-brown-faint ml-1">…</span>}
                  </td>
                  {CAPABILITIES.map(c => {
                    const locked = role === 'owner' || c.key === 'manage_system_roles'
                    const checked = role === 'owner' ? true : !!roleCaps[role]?.[c.key]
                    return (
                      <td key={c.key} className="px-2 py-2 text-center">
                        <button
                          onClick={() => toggleCap(role, c.key)}
                          disabled={locked}
                          className={`w-5 h-5 rounded-md inline-flex items-center justify-center text-[11px] font-bold transition-colors ${
                            checked ? 'bg-[#3D7A50] text-white' : 'bg-[#F0E8DC] text-brown-faint'
                          } ${locked ? 'opacity-60 cursor-not-allowed' : 'hover:opacity-80'}`}
                        >
                          {checked ? '✓' : '✗'}
                        </button>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-2 space-y-0.5">
          {SYSTEM_ROLES.map(role => (
            <p key={role} className="text-[11px] text-brown-faint">
              <span className="font-semibold text-brown-muted">{SYSTEM_ROLE_LABELS[role]}:</span> {SYSTEM_ROLE_DESC[role]}
            </p>
          ))}
        </div>
      </div>

      {/* Staff assignment */}
      <div>
        <h3 className="text-sm font-bold text-brown-dark mb-3">Assign System Roles</h3>
        <div className="bg-white rounded-xl border border-[#E8DDD0] divide-y divide-[#F0E8DC]">
          {activeStaff.map(s => (
            <div key={s.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-brown-dark truncate">{s.name}</p>
                <p className="text-[11px] text-brown-faint">{RANK_LABELS[s.rank]}</p>
              </div>
              <select
                value={s.system_role}
                disabled={savingStaff === s.id}
                onChange={e => assignRole(s.id, e.target.value as SystemRole)}
                className="px-2.5 py-1.5 rounded-lg border border-[#D4C5B0] bg-white text-xs text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40] disabled:opacity-50"
              >
                {SYSTEM_ROLES.map(r => <option key={r} value={r}>{SYSTEM_ROLE_LABELS[r]}</option>)}
              </select>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Career Paths & Skills ──────────────────────────────────────────────────────

interface InitReport {
  initialized: number
  titled: number
  noTitle: string[]
  noPath: string[]
}

function CareerPathsTab({ roles, allStaff, onRefresh }: {
  roles: Role[]
  allStaff: Staff[]
  onRefresh: () => void
}) {
  const { departments } = useLookups()
  const activeDeptRows = departments.filter(d => d.status === 'active')
  const deptNameById = (id: string | null | undefined) => departments.find(d => d.id === id)?.name ?? null
  const { toast, show } = useToast()
  const [paths, setPaths] = useState<CareerPath[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedPathId, setSelectedPathId] = useState<string | null>(null)
  const [pathModal, setPathModal] = useState(false)
  const [pathForm, setPathForm] = useState({ department_id: '', from: '', to: '' })
  const [skillModal, setSkillModal] = useState<Partial<Skill> | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [initing, setIniting] = useState(false)
  const [initReport, setInitReport] = useState<InitReport | null>(null)

  const activeRoles = roles.filter(r => r.is_active)

  async function load() {
    const { data, error: err } = await supabase
      .from('career_paths')
      .select('*, from:roles!career_paths_from_job_title_id_fkey(*), to:roles!career_paths_to_job_title_id_fkey(*), skills(*)')
      .order('created_at')
    if (!err && data) {
      const withSorted = (data as CareerPath[]).map(p => ({
        ...p,
        skills: [...(p.skills ?? [])].sort((a, b) => a.sort_order - b.sort_order),
      }))
      setPaths(withSorted)
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const selectedPath = paths.find(p => p.id === selectedPathId) ?? null

  // ── Path CRUD ──
  async function savePath() {
    if (!pathForm.from || !pathForm.to) { setError('Select both job titles.'); return }
    if (pathForm.from === pathForm.to) { setError('From and To must be different job titles.'); return }
    setSaving(true); setError('')
    const { error: err } = await supabase.from('career_paths').insert({
      department_id: pathForm.department_id || null,
      from_job_title_id: pathForm.from,
      to_job_title_id: pathForm.to,
    })
    setSaving(false)
    if (err) {
      setError(/duplicate|unique/i.test(err.message)
        ? 'That job title already has an active path. Deactivate it first.'
        : err.message)
      return
    }
    show('Career path added')
    setPathModal(false)
    setPathForm({ department_id: '', from: '', to: '' })
    load()
  }

  async function togglePathStatus(p: CareerPath) {
    const { error: err } = await supabase.from('career_paths')
      .update({ status: p.status === 'active' ? 'inactive' : 'active' }).eq('id', p.id)
    if (err) {
      show(/duplicate|unique/i.test(err.message) ? 'Another active path already starts from that title.' : err.message)
      return
    }
    load()
  }

  // ── Skill CRUD ──
  async function saveSkill() {
    if (!skillModal || !selectedPath || !skillModal.name?.trim()) return
    setSaving(true); setError('')
    const payload = {
      name: skillModal.name.trim(),
      name_zh: skillModal.name_zh?.trim() || null,
      description: skillModal.description?.trim() || null,
      xp_reward: Math.max(0, Number(skillModal.xp_reward ?? 0)),
      sort_order: Number(skillModal.sort_order ?? (selectedPath.skills?.length ?? 0) + 1),
    }
    const { error: err } = skillModal.id
      ? await supabase.from('skills').update(payload).eq('id', skillModal.id)
      : await supabase.from('skills').insert({ ...payload, career_path_id: selectedPath.id })
    setSaving(false)
    if (err) { setError(err.message); return }
    show(skillModal.id ? 'Skill updated' : 'Skill added')
    setSkillModal(null)
    load()
  }

  async function toggleSkillStatus(s: Skill) {
    await supabase.from('skills').update({ status: s.status === 'active' ? 'inactive' : 'active' }).eq('id', s.id)
    load()
  }

  // ── One-off initialization for existing staff ──
  async function initializeAll() {
    setIniting(true); setInitReport(null)
    const report: InitReport = { initialized: 0, titled: 0, noTitle: [], noPath: [] }
    for (const s of allStaff.filter(x => x.status !== 'resigned')) {
      let titleId = s.job_title_id
      // Infer the job title from rank + department when unambiguous.
      if (!titleId) {
        const matches = activeRoles.filter(r => r.rank === s.rank && (r.department ?? '') === (s.department ?? ''))
        if (matches.length === 1) {
          const { error: err } = await supabase.from('staff').update({ job_title_id: matches[0].id }).eq('id', s.id)
          if (!err) { titleId = matches[0].id; report.titled++ }
        }
      }
      if (!titleId) { report.noTitle.push(s.name); continue }
      const { data, error: err } = await supabase.rpc('initialize_staff_skills', { p_staff_id: s.id })
      if (err) { report.noPath.push(`${s.name} — ${err.message}`); continue }
      if (data === -1) report.noTitle.push(s.name)
      else if (data === -2) report.noPath.push(s.name)
      else report.initialized += (data as number)
    }
    setInitReport(report)
    setIniting(false)
    onRefresh()
  }

  const roleName = (id: string | null | undefined) => roles.find(r => r.id === id)?.name ?? '—'

  if (loading) {
    return <p className="text-sm text-brown-faint py-8 text-center">Loading career paths…</p>
  }

  // ── Drill-in: skills of one path ──
  if (selectedPath) {
    return (
      <div className="space-y-5">
        {toast && <Toast message={toast} />}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <button onClick={() => setSelectedPathId(null)} className="text-xs text-brown-faint hover:text-brown-dark mb-1">
              ← All paths
            </button>
            <h2 className="text-base font-bold text-brown-dark truncate">
              {roleName(selectedPath.from_job_title_id)} → {roleName(selectedPath.to_job_title_id)}
            </h2>
            <p className="text-xs text-brown-faint mt-0.5">
              Skills required to qualify for promotion. Passing a skill awards its XP.
            </p>
          </div>
          <button
            onClick={() => { setSkillModal({}); setError('') }}
            className="px-3 py-1.5 rounded-lg bg-[#C4813A] text-white text-xs font-semibold hover:bg-[#A86C2C] transition-colors flex-shrink-0"
          >
            + Add Skill
          </button>
        </div>

        <div className="bg-white rounded-xl border border-[#E8DDD0] divide-y divide-[#F0E8DC]">
          {(selectedPath.skills ?? []).length === 0 && (
            <p className="px-4 py-6 text-xs text-brown-faint text-center">No skills yet — add the first one.</p>
          )}
          {(selectedPath.skills ?? []).map(s => (
            <div key={s.id} className="flex items-center gap-3 px-4 py-3">
              <span className="text-xs text-brown-faint w-6 text-center flex-shrink-0">{s.sort_order}</span>
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-semibold ${s.status === 'active' ? 'text-brown-dark' : 'text-brown-faint line-through'}`}>
                  {s.name}
                  {s.name_zh && <span className="font-normal text-brown-faint ml-2">{s.name_zh}</span>}
                </p>
                {s.description && <p className="text-xs text-brown-faint mt-0.5 line-clamp-1">{s.description}</p>}
              </div>
              <span className="text-xs text-[#C4813A] font-semibold flex-shrink-0">+{s.xp_reward} XP</span>
              <button
                onClick={() => toggleSkillStatus(s)}
                className={`text-xs font-medium px-2 py-0.5 rounded-full transition-colors flex-shrink-0 ${
                  s.status === 'active' ? 'bg-[#EBF5EE] text-[#3D7A50]' : 'bg-[#F5EDE0] text-brown-faint'
                }`}
              >
                {s.status === 'active' ? 'Active' : 'Inactive'}
              </button>
              <button
                onClick={() => { setSkillModal({ ...s }); setError('') }}
                className="text-xs text-brown-faint hover:text-brown-dark transition-colors px-2 py-1 flex-shrink-0"
              >
                Edit
              </button>
            </div>
          ))}
        </div>

        {skillModal && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40">
            <div className="w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-2xl shadow-2xl">
              <div className="flex items-center justify-between px-5 py-4 border-b border-[#F0E8DC]">
                <h3 className="font-bold text-brown-dark">{skillModal.id ? 'Edit Skill' : 'Add Skill'}</h3>
                <button onClick={() => setSkillModal(null)} className="p-1 text-brown-faint hover:text-brown-dark">✕</button>
              </div>
              <div className="px-5 py-5 space-y-4 max-h-[70vh] overflow-y-auto">
                <div>
                  <label className={labelCls}>Skill Name (EN)</label>
                  <input className={inputCls} value={skillModal.name ?? ''} autoFocus
                    onChange={e => setSkillModal(p => p && { ...p, name: e.target.value })}
                    placeholder="e.g. Pour a rosetta latte art" />
                </div>
                <div>
                  <label className={labelCls}>Skill Name (中文)</label>
                  <input className={inputCls} value={skillModal.name_zh ?? ''}
                    onChange={e => setSkillModal(p => p && { ...p, name_zh: e.target.value })}
                    placeholder="例:拉花:叶形" />
                </div>
                <div>
                  <label className={labelCls}>Description</label>
                  <textarea rows={2} className={`${inputCls} resize-none`} value={skillModal.description ?? ''}
                    onChange={e => setSkillModal(p => p && { ...p, description: e.target.value })}
                    placeholder="Assessment criteria…" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelCls}>XP Reward</label>
                    <input type="number" min={0} className={inputCls} value={skillModal.xp_reward ?? 0}
                      onChange={e => setSkillModal(p => p && { ...p, xp_reward: Number(e.target.value) })} />
                  </div>
                  <div>
                    <label className={labelCls}>Sort Order</label>
                    <input type="number" min={1} className={inputCls}
                      value={skillModal.sort_order ?? (selectedPath.skills?.length ?? 0) + 1}
                      onChange={e => setSkillModal(p => p && { ...p, sort_order: Number(e.target.value) })} />
                  </div>
                </div>
                {error && <p className="text-xs text-red-600">{error}</p>}
                <button
                  onClick={saveSkill}
                  disabled={saving || !skillModal.name?.trim()}
                  className="w-full py-2.5 rounded-xl bg-[#C4813A] text-white font-semibold text-sm hover:bg-[#A86C2C] disabled:opacity-50 transition-colors"
                >
                  {saving ? 'Saving…' : skillModal.id ? 'Save Changes' : 'Add Skill'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── Path list ──
  return (
    <div className="space-y-6">
      {toast && <Toast message={toast} />}

      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-brown-dark">Career Paths</h2>
          <p className="text-xs text-brown-faint mt-0.5">
            Promotion path segments. Staff must pass every skill in their segment to qualify for the next job title.
          </p>
        </div>
        <button
          onClick={() => { setPathModal(true); setError('') }}
          className="px-3 py-1.5 rounded-lg bg-[#C4813A] text-white text-xs font-semibold hover:bg-[#A86C2C] transition-colors flex-shrink-0"
        >
          + Add Path
        </button>
      </div>

      <div className="bg-white rounded-xl border border-[#E8DDD0] divide-y divide-[#F0E8DC]">
        {paths.length === 0 && (
          <p className="px-4 py-6 text-xs text-brown-faint text-center">
            No career paths yet. Add one, or run the skill-matrix migration if this looks wrong.
          </p>
        )}
        {paths.map(p => (
          <div key={p.id} className="flex items-center gap-3 px-4 py-3">
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-semibold ${p.status === 'active' ? 'text-brown-dark' : 'text-brown-faint line-through'}`}>
                {roleName(p.from_job_title_id)} <span className="text-brown-faint">→</span> {roleName(p.to_job_title_id)}
              </p>
              <p className="text-[11px] text-brown-faint mt-0.5">
                {deptNameById(p.department_id) ? `${deptNameById(p.department_id)} · ` : ''}
                {(p.skills ?? []).filter(s => s.status === 'active').length} active skills
              </p>
            </div>
            <button
              onClick={() => togglePathStatus(p)}
              className={`text-xs font-medium px-2 py-0.5 rounded-full transition-colors flex-shrink-0 ${
                p.status === 'active' ? 'bg-[#EBF5EE] text-[#3D7A50]' : 'bg-[#F5EDE0] text-brown-faint'
              }`}
            >
              {p.status === 'active' ? 'Active' : 'Inactive'}
            </button>
            <button
              onClick={() => setSelectedPathId(p.id)}
              className="text-xs font-semibold text-[#C4813A] hover:underline flex-shrink-0"
            >
              Manage Skills →
            </button>
          </div>
        ))}
      </div>

      {/* One-off initialization */}
      <div className="bg-white rounded-xl border border-[#E8DDD0] p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-brown-dark">Initialize All Staff Skills</p>
            <p className="text-xs text-brown-faint mt-0.5">
              Creates skill records for every active staff member based on their job title's path.
              Staff without a job title are matched by rank + department where unambiguous; the rest are listed for manual assignment.
            </p>
          </div>
          <button
            onClick={initializeAll}
            disabled={initing}
            className="px-3 py-1.5 rounded-lg border border-[#C4813A60] text-[#C4813A] bg-[#C4813A08] text-xs font-semibold hover:bg-[#C4813A18] transition-colors disabled:opacity-50 flex-shrink-0"
          >
            {initing ? 'Initializing…' : 'Initialize'}
          </button>
        </div>
        {initReport && (
          <div className="text-xs space-y-1 border-t border-[#F0E8DC] pt-3">
            <p className="text-[#3D7A50] font-medium">
              ✓ {initReport.initialized} skill records created · {initReport.titled} job titles auto-assigned
            </p>
            {initReport.noTitle.length > 0 && (
              <p className="text-[#9E4A30]">
                ⚠️ No job title (assign manually in their profile): {initReport.noTitle.join(', ')}
              </p>
            )}
            {initReport.noPath.length > 0 && (
              <p className="text-brown-muted">
                ℹ️ No active career path from their title: {initReport.noPath.join(', ')}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Add path modal */}
      {pathModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40">
          <div className="w-full sm:max-w-sm bg-white rounded-t-3xl sm:rounded-2xl shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#F0E8DC]">
              <h3 className="font-bold text-brown-dark">Add Career Path</h3>
              <button onClick={() => setPathModal(false)} className="p-1 text-brown-faint hover:text-brown-dark">✕</button>
            </div>
            <div className="px-5 py-5 space-y-4">
              <div>
                <label className={labelCls}>Department (optional)</label>
                <select className={inputCls} value={pathForm.department_id}
                  onChange={e => setPathForm(f => ({ ...f, department_id: e.target.value }))}>
                  <option value="">— None —</option>
                  {activeDeptRows.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>From Job Title</label>
                <select className={inputCls} value={pathForm.from}
                  onChange={e => setPathForm(f => ({ ...f, from: e.target.value }))}>
                  <option value="">— Select —</option>
                  {activeRoles.map(r => <option key={r.id} value={r.id}>{r.name} ({RANK_LABELS[r.rank]})</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>To Job Title</label>
                <select className={inputCls} value={pathForm.to}
                  onChange={e => setPathForm(f => ({ ...f, to: e.target.value }))}>
                  <option value="">— Select —</option>
                  {activeRoles.map(r => <option key={r.id} value={r.id}>{r.name} ({RANK_LABELS[r.rank]})</option>)}
                </select>
              </div>
              {error && <p className="text-xs text-red-600">{error}</p>}
              <button
                onClick={savePath}
                disabled={saving || !pathForm.from || !pathForm.to}
                className="w-full py-2.5 rounded-xl bg-[#C4813A] text-white font-semibold text-sm hover:bg-[#A86C2C] disabled:opacity-50 transition-colors"
              >
                {saving ? 'Saving…' : 'Add Path'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── XP & Scoring Rules ─────────────────────────────────────────────────────────

function RulesTab({ rules, onRefresh }: { rules: SystemRule[]; onRefresh: () => void }) {
  const ruleMap: Record<string, SystemRule> = {}
  rules.forEach(r => { ruleMap[r.key] = r })

  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(rules.map(r => [r.key, r.value]))
  )
  const [saving, setSaving] = useState(false)
  const { toast, show } = useToast()

  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValues(v => ({ ...v, [key]: e.target.value }))

  const weightKeys = ['review_weight_attendance', 'review_weight_attitude', 'review_weight_efficiency', 'review_weight_coffee', 'review_weight_service']
  const totalWeight = weightKeys.reduce((sum, k) => sum + (Number(values[k]) || 0), 0)

  async function handleSave() {
    setSaving(true)
    await Promise.all(
      Object.entries(values).map(([key, value]) =>
        supabase.from('system_rules').update({ value, updated_at: new Date().toISOString() }).eq('key', key)
      )
    )
    setSaving(false)
    onRefresh()
    show('Rules saved')
  }

  function numInput(key: string, label: string, suffix?: string) {
    if (!ruleMap[key]) return null
    return (
      <div key={key}>
        <label className={labelCls}>{label}</label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            className={inputCls}
            value={values[key] ?? ''}
            onChange={set(key)}
          />
          {suffix && <span className="text-xs text-brown-faint flex-shrink-0">{suffix}</span>}
        </div>
        {ruleMap[key].description && <p className="text-xs text-brown-faint mt-1">{ruleMap[key].description}</p>}
      </div>
    )
  }

  return (
    <div className="space-y-8 max-w-xl">
      {toast && <Toast message={toast} />}

      <div>
        <h3 className="text-sm font-bold text-brown-dark mb-3">XP Rules</h3>
        <div className="space-y-4">
          {numInput('xp_per_level', 'XP needed per level')}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-bold text-brown-dark mb-1">Monthly Review Weights</h3>
        <p className="text-xs text-brown-faint mb-3">Must add up to 100%.</p>
        <div className="space-y-4">
          {numInput('review_weight_attendance', 'Attendance weight', '%')}
          {numInput('review_weight_attitude', 'Attitude weight', '%')}
          {numInput('review_weight_efficiency', 'Work efficiency weight', '%')}
          {numInput('review_weight_coffee', 'Coffee skill weight', '%')}
          {numInput('review_weight_service', 'Service quality weight', '%')}
        </div>
        <div className={`mt-3 px-3 py-2 rounded-lg text-xs font-semibold ${
          totalWeight === 100 ? 'bg-[#EBF5EE] text-[#3D7A50]' : 'bg-[#FCF0EC] text-[#9E4A30]'
        }`}>
          Total: {totalWeight}% {totalWeight !== 100 && '(must equal 100%)'}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-bold text-brown-dark mb-3">Attendance Rules</h3>
        <div className="space-y-4">
          {numInput('late_deduction', 'Score deducted per late instance', '%')}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-bold text-brown-dark mb-3">Probation</h3>
        <div className="space-y-4">
          {numInput('probation_days', 'Number of probation days', 'days')}
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="px-5 py-2.5 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors disabled:opacity-60"
      >
        {saving ? 'Saving...' : 'Save Changes'}
      </button>
    </div>
  )
}

// ─── Notifications ──────────────────────────────────────────────────────────────

function NotificationsTab({ settings, onRefresh }: { settings: NotificationSetting[]; onRefresh: () => void }) {
  const { toast, show } = useToast()

  async function toggle(n: NotificationSetting, field: keyof NotificationSetting) {
    await supabase.from('notification_settings').update({ [field]: !n[field] }).eq('id', n.id)
    onRefresh()
    show('Notification settings updated')
  }

  return (
    <div className="space-y-4">
      {toast && <Toast message={toast} />}
      <div className="bg-white rounded-xl border border-[#E8DDD0] overflow-x-auto">
        <table className="w-full text-sm min-w-[560px]">
          <thead>
            <tr className="border-b border-[#EDE5D8]">
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-brown-faint">Event</th>
              <th className="px-3 py-2.5 text-xs font-semibold text-brown-faint text-center">Enabled</th>
              <th className="px-3 py-2.5 text-xs font-semibold text-brown-faint text-center">Notify Staff</th>
              <th className="px-3 py-2.5 text-xs font-semibold text-brown-faint text-center">Notify Supervisor</th>
              <th className="px-3 py-2.5 text-xs font-semibold text-brown-faint text-center">Notify Manager</th>
            </tr>
          </thead>
          <tbody>
            {settings.map((n, i) => (
              <tr key={n.id} className={i > 0 ? 'border-t border-[#F0E8DC]' : ''}>
                <td className="px-4 py-3 font-medium text-brown-dark">{n.label ?? n.event_type}</td>
                <td className="px-3 py-3 text-center"><Toggle checked={n.enabled} onChange={() => toggle(n, 'enabled')} /></td>
                <td className="px-3 py-3 text-center"><Toggle checked={n.notify_staff} onChange={() => toggle(n, 'notify_staff')} disabled={!n.enabled} /></td>
                <td className="px-3 py-3 text-center"><Toggle checked={n.notify_supervisor} onChange={() => toggle(n, 'notify_supervisor')} disabled={!n.enabled} /></td>
                <td className="px-3 py-3 text-center"><Toggle checked={n.notify_manager} onChange={() => toggle(n, 'notify_manager')} disabled={!n.enabled} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-brown-faint">Note: Email notifications require email setup in Supabase.</p>
    </div>
  )
}

// ─── Data & Export ──────────────────────────────────────────────────────────────

function DataExportTab({ staffCount, missionCount }: { staffCount: number; missionCount: number }) {
  const [exporting, setExporting] = useState('')

  async function exportStaff() {
    setExporting('staff')
    const { data } = await supabase.from('staff').select('*').order('name')
    if (data) {
      const rows = data.map((s: Staff) => [s.name, RANK_LABELS[s.rank], s.level, s.xp, s.branch, s.department, s.joined_at])
      downloadCSV('staff.csv', toCSV(['Name', 'Rank', 'Level', 'XP', 'Branch', 'Department', 'Joined Date'], rows))
    }
    setExporting('')
  }

  async function exportCompletions() {
    setExporting('completions')
    const { data } = await supabase
      .from('mission_completions')
      .select('*, mission:missions(title), staff:staff!mission_completions_staff_id_fkey(name)')
      .order('completed_at', { ascending: false })
    if (data) {
      const rows = data.map((c: { staff?: { name?: string }; mission?: { title?: string }; status: string; completed_at: string }) =>
        [c.staff?.name ?? '', c.mission?.title ?? '', c.status, c.completed_at])
      downloadCSV('mission_completions.csv', toCSV(['Staff', 'Mission', 'Status', 'Date'], rows))
    }
    setExporting('')
  }

  async function exportReviews() {
    setExporting('reviews')
    const { data } = await supabase
      .from('monthly_reviews')
      .select('*, staff:staff!monthly_reviews_staff_id_fkey(name)')
      .order('year', { ascending: false })
    if (data) {
      const rows = data.map((r: { staff?: { name?: string }; month: number; year: number; sup_attitude: number | null; sup_efficiency: number | null; sup_coffee_skill: number | null; sup_service: number | null }) =>
        [r.staff?.name ?? '', r.month, r.year, r.sup_attitude, r.sup_efficiency, r.sup_coffee_skill, r.sup_service])
      downloadCSV('monthly_reviews.csv', toCSV(['Staff', 'Month', 'Year', 'Attitude', 'Efficiency', 'Coffee Skill', 'Service'], rows))
    }
    setExporting('')
  }

  async function exportRegistrations() {
    setExporting('registrations')
    const { data } = await supabase.from('registration_requests').select('*').order('created_at', { ascending: false })
    if (data) {
      const rows = data.map((r: { full_name: string; email: string; branch: string | null; department: string | null; status: string; created_at: string }) =>
        [r.full_name, r.email, r.branch, r.department, r.status, r.created_at])
      downloadCSV('registration_requests.csv', toCSV(['Full Name', 'Email', 'Branch', 'Department', 'Status', 'Submitted'], rows))
    }
    setExporting('')
  }

  const exportBtn = (key: string, label: string, fn: () => void) => (
    <button
      onClick={fn}
      disabled={exporting === key}
      className="px-4 py-2.5 rounded-xl border border-[#D4C5B0] bg-white text-sm font-semibold text-brown-medium hover:bg-[#F5EDE0] transition-colors disabled:opacity-60"
    >
      {exporting === key ? 'Exporting...' : `⬇ ${label}`}
    </button>
  )

  return (
    <div className="space-y-8">
      <div>
        <h3 className="text-sm font-bold text-brown-dark mb-3">Export Data</h3>
        <div className="flex flex-wrap gap-3">
          {exportBtn('staff', 'Export All Staff (CSV)', exportStaff)}
          {exportBtn('completions', 'Export Mission Completions (CSV)', exportCompletions)}
          {exportBtn('reviews', 'Export Monthly Reviews (CSV)', exportReviews)}
          {exportBtn('registrations', 'Export Registration Requests (CSV)', exportRegistrations)}
        </div>
      </div>
      <div>
        <h3 className="text-sm font-bold text-brown-dark mb-3">System Info</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="bg-white rounded-xl p-4 border border-[#E8DDD0]">
            <p className="text-xs text-brown-faint mb-1">Total Staff</p>
            <p className="text-2xl font-bold text-brown-dark">{staffCount}</p>
          </div>
          <div className="bg-white rounded-xl p-4 border border-[#E8DDD0]">
            <p className="text-xs text-brown-faint mb-1">Total Missions</p>
            <p className="text-2xl font-bold text-brown-dark">{missionCount}</p>
          </div>
          <div className="bg-white rounded-xl p-4 border border-[#E8DDD0]">
            <p className="text-xs text-brown-faint mb-1">Database</p>
            <p className="text-sm font-bold text-[#3D7A50]">Connected ✓</p>
          </div>
          <div className="bg-white rounded-xl p-4 border border-[#E8DDD0]">
            <p className="text-xs text-brown-faint mb-1">Storage</p>
            <p className="text-sm font-bold text-[#3D7A50]">Connected ✓</p>
          </div>
        </div>
        <p className="text-xs text-brown-faint mt-3">Last updated: {new Date().toLocaleString()}</p>
      </div>
    </div>
  )
}

// ─── Shift Types tab ─────────────────────────────────────────────────────────

const SHIFT_DEPTS = ['barista', 'bakery', 'kitchen', 'office', 'service crew', 'other']

function ShiftTypesTab() {
  const [shiftTypes, setShiftTypes] = useState<ShiftType[]>([])
  const [editing, setEditing] = useState<Partial<ShiftType> | null>(null)
  const [saving, setSaving] = useState(false)
  const { toast, show } = useToast()

  async function load() {
    const { data } = await supabase.from('shift_types').select('*').order('department').order('start_time')
    if (data) setShiftTypes(data as ShiftType[])
  }

  useEffect(() => { load() }, [])

  async function save() {
    if (!editing) return
    setSaving(true)
    if (editing.id) {
      await supabase.from('shift_types').update({
        name: editing.name,
        start_time: editing.start_time,
        end_time: editing.end_time,
        break1_duration_minutes: editing.break1_duration_minutes ?? 0,
        break2_duration_minutes: editing.break2_duration_minutes ?? 0,
        department: editing.department,
        is_active: editing.is_active,
      }).eq('id', editing.id)
      show('Shift type updated')
    } else {
      await supabase.from('shift_types').insert({
        department: editing.department ?? 'barista',
        name: editing.name ?? 'New Shift',
        start_time: editing.start_time ?? '09:00',
        end_time: editing.end_time ?? '17:00',
        break1_duration_minutes: editing.break1_duration_minutes ?? 0,
        break2_duration_minutes: editing.break2_duration_minutes ?? 0,
        color: DEPT_SHIFT_COLORS[editing.department ?? 'barista'] ?? '#8B6344',
      })
      show('Shift type added')
    }
    setSaving(false)
    setEditing(null)
    load()
  }

  async function toggleActive(st: ShiftType) {
    await supabase.from('shift_types').update({ is_active: !st.is_active }).eq('id', st.id)
    load()
  }

  const grouped: Record<string, ShiftType[]> = {}
  shiftTypes.forEach(st => {
    if (!grouped[st.department]) grouped[st.department] = []
    grouped[st.department].push(st)
  })

  const inputCls2 = 'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

  return (
    <div className="space-y-6">
      {toast && <Toast message={toast} />}

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-brown-dark">Shift Types</h2>
          <p className="text-xs text-brown-faint mt-0.5">Define shifts for each department.</p>
        </div>
        <button
          onClick={() => setEditing({ department: 'barista', name: '', start_time: '09:00', end_time: '17:00', break1_duration_minutes: 60, break2_duration_minutes: 0, is_active: true })}
          className="px-3 py-1.5 rounded-lg bg-[#C4813A] text-white text-xs font-semibold hover:bg-[#A86C2C] transition-colors"
        >
          + Add Shift
        </button>
      </div>

      {Object.entries(grouped).map(([dept, shifts]) => {
        const color = DEPT_SHIFT_COLORS[dept] ?? '#8B7355'
        return (
          <div key={dept}>
            <p className="text-xs font-bold uppercase tracking-widest mb-2" style={{ color }}>
              {DEPT_LABELS[dept] ?? dept}
            </p>
            <div className="bg-white rounded-xl border border-[#E8DDD0] divide-y divide-[#F0E8DC]">
              {shifts.map(st => (
                <div key={st.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="w-1.5 h-8 rounded-full flex-shrink-0" style={{ background: color }} />
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-semibold ${st.is_active ? 'text-brown-dark' : 'text-brown-faint line-through'}`}>
                      {st.name}
                    </p>
                    <p className="text-xs text-brown-faint">
                      {st.start_time.slice(0,5)} – {st.end_time.slice(0,5)}
                      {st.break1_duration_minutes > 0 && ` · Break 1 ${st.break1_duration_minutes}min`}
                      {st.break2_duration_minutes > 0 && ` · Break 2 ${st.break2_duration_minutes}min`}
                    </p>
                  </div>
                  <button
                    onClick={() => toggleActive(st)}
                    className={`text-xs font-medium px-2 py-0.5 rounded-full transition-colors ${
                      st.is_active ? 'bg-[#EBF5EE] text-[#3D7A50]' : 'bg-[#F5EDE0] text-brown-faint'
                    }`}
                  >
                    {st.is_active ? 'Active' : 'Inactive'}
                  </button>
                  <button
                    onClick={() => setEditing({ ...st })}
                    className="text-xs text-brown-faint hover:text-brown-dark transition-colors px-2 py-1"
                  >
                    Edit
                  </button>
                </div>
              ))}
            </div>
          </div>
        )
      })}

      {/* Edit / Add modal */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40">
          <div className="w-full sm:max-w-sm bg-white rounded-t-3xl sm:rounded-2xl shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#F0E8DC]">
              <h3 className="font-bold text-brown-dark">{editing.id ? 'Edit Shift Type' : 'Add Shift Type'}</h3>
              <button onClick={() => setEditing(null)} className="p-1 text-brown-faint hover:text-brown-dark">✕</button>
            </div>
            <div className="px-5 py-5 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-brown-medium mb-1">Department</label>
                <select
                  className={inputCls2}
                  value={editing.department ?? 'barista'}
                  onChange={e => setEditing(p => ({ ...p, department: e.target.value }))}
                >
                  {SHIFT_DEPTS.map(d => <option key={d} value={d}>{DEPT_LABELS[d] ?? d}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-brown-medium mb-1">Shift Name</label>
                <input
                  className={inputCls2}
                  value={editing.name ?? ''}
                  onChange={e => setEditing(p => ({ ...p, name: e.target.value }))}
                  placeholder="e.g. Morning"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-brown-medium mb-1">Start Time</label>
                  <input type="time" className={inputCls2} value={editing.start_time?.slice(0,5) ?? ''} onChange={e => setEditing(p => ({ ...p, start_time: e.target.value }))} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-brown-medium mb-1">End Time</label>
                  <input type="time" className={inputCls2} value={editing.end_time?.slice(0,5) ?? ''} onChange={e => setEditing(p => ({ ...p, end_time: e.target.value }))} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-brown-medium mb-1">Break 1 Duration (min)</label>
                  <input
                    type="number"
                    min={0}
                    step={5}
                    className={inputCls2}
                    value={editing.break1_duration_minutes ?? 0}
                    onChange={e => setEditing(p => ({ ...p, break1_duration_minutes: Math.max(0, Number(e.target.value)) }))}
                    placeholder="e.g. 60"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-brown-medium mb-1">Break 2 Duration (min)</label>
                  <input
                    type="number"
                    min={0}
                    step={5}
                    className={inputCls2}
                    value={editing.break2_duration_minutes ?? 0}
                    onChange={e => setEditing(p => ({ ...p, break2_duration_minutes: Math.max(0, Number(e.target.value)) }))}
                    placeholder="e.g. 60"
                  />
                </div>
                <p className="text-xs text-brown-faint mt-1 col-span-2">Allowed rest per break. 0 = no break. Used for the break countdown when clocking out.</p>
              </div>
              <button
                onClick={save}
                disabled={saving || !editing.name}
                className="w-full py-2.5 rounded-xl bg-[#C4813A] text-white font-semibold text-sm hover:bg-[#A86C2C] disabled:opacity-50 transition-colors"
              >
                {saving ? 'Saving…' : editing.id ? 'Save Changes' : 'Add Shift Type'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Settings page ──────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [tab, setTab] = useState<TabId>('company')
  const [loading, setLoading] = useState(true)
  const [companySettings, setCompanySettings] = useState<CompanySettings | null>(null)
  const [branches, setBranches] = useState<Branch[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [rules, setRules] = useState<SystemRule[]>([])
  const [notifications, setNotifications] = useState<NotificationSetting[]>([])
  const [allStaff, setAllStaff] = useState<Staff[]>([])
  const [missionCount, setMissionCount] = useState(0)

  async function loadAll() {
    const [companyRes, branchesRes, rolesRes, rulesRes, notifRes, staffRes, missionsRes] = await Promise.all([
      supabase.from('company_settings').select('*').limit(1).maybeSingle(),
      supabase.from('branches').select('*, pic:staff!branches_pic_staff_id_fkey(id,name,rank,avatar)').order('name'),
      supabase.from('roles').select('*').order('rank'),
      supabase.from('system_rules').select('*'),
      supabase.from('notification_settings').select('*'),
      supabase.from('staff').select('*').order('name'),
      supabase.from('missions').select('id', { count: 'exact', head: true }),
    ])
    if (companyRes.data) setCompanySettings(companyRes.data as CompanySettings)
    if (branchesRes.data) setBranches(branchesRes.data as Branch[])
    if (rolesRes.data) setRoles(rolesRes.data as Role[])
    if (rulesRes.data) setRules(rulesRes.data as SystemRule[])
    if (notifRes.data) setNotifications(notifRes.data as NotificationSetting[])
    if (staffRes.data) setAllStaff(staffRes.data as Staff[])
    if (missionsRes.count != null) setMissionCount(missionsRes.count)
    setLoading(false)
  }

  useEffect(() => { loadAll() }, [])

  const supervisorOptions = allStaff.filter(s => s.rank === 'supervisor' || s.rank === 'manager')

  if (loading || !companySettings) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-cream-light">
        <p className="text-brown-medium animate-pulse">Loading settings...</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-6xl mx-auto px-4 py-8 lg:px-8">
        <h1 className="text-2xl font-bold text-brown-dark mb-1">Settings</h1>
        <p className="text-sm text-brown-faint mb-6">Manage company info, branches, roles, rules and more.</p>

        <div className="lg:grid lg:grid-cols-[200px_1fr] lg:gap-8">
          {/* Vertical tabs (horizontal scroll on mobile) */}
          <nav className="flex lg:flex-col gap-1.5 overflow-x-auto pb-3 mb-6 lg:mb-0 lg:pb-0">
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap transition-colors flex-shrink-0 ${
                  tab === t.id ? 'bg-[#C4813A] text-white' : 'bg-white text-brown-medium border border-[#E8DDD0] hover:bg-[#F5EDE0]'
                }`}
              >
                <span>{t.icon}</span>
                {t.label}
              </button>
            ))}
          </nav>

          <div className="min-w-0">
            {tab === 'company' && (
              <CompanyInfoTab settings={companySettings} onSaved={setCompanySettings} />
            )}
            {tab === 'branches' && (
              <BranchesTab branches={branches} staffOptions={supervisorOptions} onRefresh={loadAll} />
            )}
            {tab === 'departments' && (
              <DepartmentsTab />
            )}
            {tab === 'employment' && (
              <EmploymentTypesTab />
            )}
            {tab === 'roles' && (
              <RolesTab roles={roles} allStaff={allStaff} onRefresh={loadAll} />
            )}
            {tab === 'career' && (
              <CareerPathsTab roles={roles} allStaff={allStaff} onRefresh={loadAll} />
            )}
            {tab === 'rules' && (
              <RulesTab rules={rules} onRefresh={loadAll} />
            )}
            {tab === 'shifts' && (
              <ShiftTypesTab />
            )}
            {tab === 'notifications' && (
              <NotificationsTab settings={notifications} onRefresh={loadAll} />
            )}
            {tab === 'data' && (
              <DataExportTab staffCount={allStaff.length} missionCount={missionCount} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
