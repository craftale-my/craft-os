import { useState, useEffect, useRef } from 'react'
import { supabase } from '../../shared/lib/supabase'
import { toCSV, downloadCSV } from '../../shared/lib/csv'
import type {
  CompanySettings, Branch, Role, SystemRule, NotificationSetting, Staff, Rank, ShiftType,
} from '../../shared/types'
import { RANK_LABELS, PERMISSION_KEYS, PERMISSION_LABELS, DEPT_LABELS, DEPT_SHIFT_COLORS } from '../../shared/types'

const TABS = [
  { id: 'company',       label: 'Company Info',       icon: '🏢' },
  { id: 'branches',       label: 'Branches',           icon: '🏪' },
  { id: 'roles',          label: 'Roles & Permissions', icon: '👔' },
  { id: 'rules',          label: 'XP & Scoring Rules',  icon: '⚡' },
  { id: 'shifts',         label: 'Shift Types',        icon: '🕐' },
  { id: 'notifications',  label: 'Notifications',      icon: '🔔' },
  { id: 'data',           label: 'Data & Export',      icon: '📊' },
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

function RolesTab({ roles, onRefresh }: { roles: Role[]; onRefresh: () => void }) {
  const [modalTarget, setModalTarget] = useState<Partial<Role> | null | 'new'>(null)
  const { toast, show } = useToast()

  async function toggleActive(r: Role) {
    await supabase.from('roles').update({ is_active: !r.is_active }).eq('id', r.id)
    onRefresh()
  }

  async function togglePermission(r: Role, key: string) {
    if (r.rank === 'manager') return
    const next = { ...r.permissions, [key]: !r.permissions?.[key as keyof typeof r.permissions] }
    await supabase.from('roles').update({ permissions: next }).eq('id', r.id)
    onRefresh()
    show('Permissions updated')
  }

  return (
    <div className="space-y-8">
      {toast && <Toast message={toast} />}

      {/* Role list */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-brown-dark">Role List</h3>
          <button
            onClick={() => setModalTarget('new')}
            className="px-3 py-1.5 rounded-lg bg-[#C4813A] text-white text-xs font-semibold hover:bg-[#A86C2C] transition-colors"
          >
            + Add New Role
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
      </div>

      {/* Permission matrix */}
      <div>
        <h3 className="text-sm font-bold text-brown-dark mb-3">Permission Matrix</h3>
        <p className="text-xs text-brown-faint mb-3">Managers always have full permissions and cannot be changed.</p>
        <div className="bg-white rounded-xl border border-[#E8DDD0] overflow-x-auto">
          <table className="w-full text-xs min-w-[900px]">
            <thead>
              <tr className="border-b border-[#EDE5D8]">
                <th className="text-left px-4 py-2.5 font-semibold text-brown-faint sticky left-0 bg-white">Role</th>
                {PERMISSION_KEYS.map(k => (
                  <th key={k} className="px-2 py-2.5 font-semibold text-brown-faint text-center whitespace-nowrap">
                    {PERMISSION_LABELS[k]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {roles.map((r, i) => (
                <tr key={r.id} className={i > 0 ? 'border-t border-[#F0E8DC]' : ''}>
                  <td className="px-4 py-2 font-medium text-brown-dark sticky left-0 bg-white whitespace-nowrap">{r.name}</td>
                  {PERMISSION_KEYS.map(k => {
                    const isManager = r.rank === 'manager'
                    const checked = isManager ? true : !!r.permissions?.[k]
                    return (
                      <td key={k} className="px-2 py-2 text-center">
                        <button
                          onClick={() => togglePermission(r, k)}
                          disabled={isManager}
                          className={`w-5 h-5 rounded-md inline-flex items-center justify-center text-[11px] font-bold transition-colors ${
                            checked ? 'bg-[#3D7A50] text-white' : 'bg-[#F0E8DC] text-brown-faint'
                          } ${isManager ? 'opacity-70 cursor-not-allowed' : 'hover:opacity-80'}`}
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
            {tab === 'roles' && (
              <RolesTab roles={roles} onRefresh={loadAll} />
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
