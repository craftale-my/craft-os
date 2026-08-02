import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { supabaseAdmin } from '../../shared/lib/supabase-admin'
import type { Staff, MissionCompletion } from '../../shared/types'
import {
  RANK_LABELS, RANK_COLORS,
  DEPT_LABELS, DEPT_STORE, BRANCHES,
  MONTHS_FULL,
} from '../../shared/types'
import { useLookups } from '../../shared/lib/lookups'
import { useCan } from '../../shared/lib/permissions'
import { useTeamData } from '../team/useTeamData'

const CURRENT_MONTH = new Date().getMonth() + 1
const CURRENT_YEAR = new Date().getFullYear()

interface RegRequest {
  id: string
  full_name: string
  email: string
  phone: string | null
  branch: string | null
  department: string | null
  employment_type: string | null
  status: 'pending' | 'approved' | 'rejected'
  rejection_reason: string | null
  created_at: string
}

function genTempPassword(): string {
  return Math.random().toString(36).slice(-8) + 'A1!'
}

// ─── Avatar (shared across pages) ────────────────────────────────────────────

export function Avatar({
  name,
  avatar,
  size = 'md',
}: {
  name: string
  avatar: string | null
  size?: 'sm' | 'md' | 'lg'
}) {
  const sizeClass = { sm: 'w-7 h-7 text-xs', md: 'w-9 h-9 text-sm', lg: 'w-12 h-12 text-base' }[size]
  if (avatar) {
    return <img src={avatar} alt={name} className={`${sizeClass} rounded-full object-cover flex-shrink-0`} />
  }
  return (
    <div className={`${sizeClass} rounded-full bg-[#C4813A20] flex items-center justify-center font-bold text-[#8B6344] flex-shrink-0`}>
      {name.charAt(0).toUpperCase()}
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shortenBranch(branch: string | null): string {
  if (!branch) return '—'
  if (branch.includes('Connaught')) return 'Cheras'
  if (branch.includes('Puteri')) return 'Puchong'
  return branch
}

/** Reviews 页也要用,所以对外导出(和 Avatar 一样)。 */
export function formatTimeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

// ─── AddStaffModal ────────────────────────────────────────────────────────────

function AddStaffModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    name: '', email: '', password: '', rank: 'trainee', branch: '', department: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const { activeDepartments } = useLookups()

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!supabaseAdmin) {
      setError('Service role key not configured. Add VITE_SUPABASE_SERVICE_ROLE_KEY to .env.local')
      return
    }
    if (!form.name.trim() || !form.email.trim() || form.password.length < 6) {
      setError('Name, email, and a 6+ character password are required.')
      return
    }
    setSaving(true)
    setError('')

    const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
      email: form.email.trim(),
      password: form.password,
      email_confirm: true,
    })
    if (authErr || !authData.user) {
      setError(authErr?.message ?? 'Failed to create auth user')
      setSaving(false)
      return
    }

    const { error: profileErr } = await supabaseAdmin.from('staff').insert({
      id: authData.user.id,
      name: form.name.trim(),
      email: form.email.trim(),
      rank: form.rank,
      branch: form.branch || null,
      department: form.department || null,
      onboarding_completed: form.rank === 'manager',
      joined_at: new Date().toISOString().split('T')[0],
    })
    if (profileErr) {
      // Roll back the just-created auth user so a failed staff insert doesn't
      // leave an orphan that blocks re-creating this email later.
      await supabaseAdmin.auth.admin.deleteUser(authData.user.id)
      setError(profileErr.message)
      setSaving(false)
      return
    }

    // Auto-assign job title (rank + department, when unambiguous) + skill checklist.
    if (form.department) {
      const { data: roleRows } = await supabaseAdmin.from('roles')
        .select('id').eq('rank', form.rank).eq('department', form.department).eq('is_active', true)
      if (roleRows && roleRows.length === 1) {
        await supabaseAdmin.from('staff').update({ job_title_id: roleRows[0].id }).eq('id', authData.user.id)
        await supabaseAdmin.rpc('initialize_staff_skills', { p_staff_id: authData.user.id })
      }
    }

    onCreated()
    onClose()
  }

  const labelCls = 'block text-xs font-semibold text-brown-medium mb-1'
  const inputCls =
    'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-cream-light rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E8DDD0]">
          <h2 className="font-bold text-brown-dark text-lg">Add New Staff</h2>
          <button onClick={onClose} className="text-brown-faint hover:text-brown-dark text-xl leading-none">✕</button>
        </div>
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
          <div>
            <label className={labelCls}>Full Name</label>
            <input className={inputCls} value={form.name} onChange={set('name')} placeholder="e.g. Ahmad Zulkifli" />
          </div>
          <div>
            <label className={labelCls}>Email</label>
            <input className={inputCls} type="email" value={form.email} onChange={set('email')} placeholder="staff@craftale.com" />
          </div>
          <div>
            <label className={labelCls}>Temporary Password</label>
            <input className={inputCls} type="password" value={form.password} onChange={set('password')} placeholder="Min 6 characters" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Rank</label>
              <select className={inputCls} value={form.rank} onChange={set('rank')}>
                {(['trainee', 'junior', 'senior', 'supervisor', 'manager'] as const).map(r => (
                  <option key={r} value={r}>{RANK_LABELS[r]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Branch</label>
              <select className={inputCls} value={form.branch} onChange={set('branch')}>
                <option value="">Select...</option>
                {BRANCHES.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className={labelCls}>Department</label>
            <select className={inputCls} value={form.department} onChange={set('department')}>
              <option value="">Select...</option>
              {activeDepartments.map(d => <option key={d.slug} value={d.slug}>{d.name}</option>)}
            </select>
          </div>
          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border border-[#D4C5B0] text-sm text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 py-2.5 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors disabled:opacity-60"
            >
              {saving ? 'Creating...' : 'Create Staff'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── ApproveRegModal ──────────────────────────────────────────────────────────

function ApproveRegModal({
  request,
  reviewerId,
  onClose,
  onApproved,
}: {
  request: RegRequest
  reviewerId: string | undefined
  onClose: () => void
  onApproved: (creds: { email: string; password: string }) => void
}) {
  const [password, setPassword] = useState(genTempPassword())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleApprove() {
    if (!supabaseAdmin) {
      setError('Service role key not configured. Add VITE_SUPABASE_SERVICE_ROLE_KEY to .env.local')
      return
    }
    if (password.length < 6) {
      setError('Temporary password must be at least 6 characters.')
      return
    }
    setSaving(true)
    setError('')

    // 1. Create the auth user — or recover one left behind by a previously
    //    interrupted approval, so a half-finished attempt no longer dead-ends
    //    every retry with "a user with this email has already been registered".
    let userId: string
    let createdNow = false
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: request.email,
      password,
      email_confirm: true,
    })
    if (created?.user) {
      userId = created.user.id
      createdNow = true
    } else if (createErr && /already/i.test(createErr.message)) {
      const { data: list } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 })
      const existing = list?.users.find(u => u.email?.toLowerCase() === request.email.toLowerCase())
      if (!existing) {
        setError(createErr.message)
        setSaving(false)
        return
      }
      userId = existing.id
      // Reset the password so the temp password shown to the manager is valid.
      await supabaseAdmin.auth.admin.updateUserById(userId, { password, email_confirm: true })
    } else {
      setError(createErr?.message ?? 'Failed to create user')
      setSaving(false)
      return
    }

    // request.department is a department slug for new requests; DEPT_STORE
    // converts any legacy display-string values from older requests.
    const dept = request.department ? (DEPT_STORE[request.department] ?? request.department) : null

    // 2. Create the staff row (idempotent on id).
    const { error: profileErr } = await supabaseAdmin.from('staff').upsert({
      id: userId,
      name: request.full_name,
      email: request.email,
      rank: 'trainee',
      branch: request.branch,
      department: dept,
      employment_type: request.employment_type,
      contact_number: request.phone,
      onboarding_completed: false,
      joined_at: new Date().toISOString().split('T')[0],
    }, { onConflict: 'id' })
    if (profileErr) {
      // Roll back a just-created auth user so it can't become an orphan that
      // blocks every future approval of this email.
      if (createdNow) await supabaseAdmin.auth.admin.deleteUser(userId)
      setError(profileErr.message)
      setSaving(false)
      return
    }

    // 3. Auto-assign the job title (rank + department, when unambiguous) and
    //    create the career-path skill checklist. Best-effort: a new hire with
    //    no matching title simply starts without one until a manager assigns it.
    if (dept) {
      const { data: roleRows } = await supabaseAdmin.from('roles')
        .select('id').eq('rank', 'trainee').eq('department', dept).eq('is_active', true)
      if (roleRows && roleRows.length === 1) {
        await supabaseAdmin.from('staff').update({ job_title_id: roleRows[0].id }).eq('id', userId)
        await supabaseAdmin.rpc('initialize_staff_skills', { p_staff_id: userId })
      }
    }

    await supabase
      .from('registration_requests')
      .update({ status: 'approved', reviewed_by: reviewerId ?? null, reviewed_at: new Date().toISOString() })
      .eq('id', request.id)

    setSaving(false)
    onApproved({ email: request.email, password })
  }

  const inputCls =
    'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-cream-light rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E8DDD0]">
          <h2 className="font-bold text-brown-dark text-lg">Approve Registration</h2>
          <button onClick={onClose} className="text-brown-faint hover:text-brown-dark text-xl leading-none">✕</button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
          <div className="bg-white rounded-lg border border-[#E8DDD0] p-3 space-y-1">
            <p className="text-sm font-semibold text-brown-dark">{request.full_name}</p>
            <p className="text-xs text-brown-faint">{request.email}</p>
          </div>
          <div>
            <label className="block text-xs font-semibold text-brown-medium mb-1">Temporary Password</label>
            <div className="flex gap-2">
              <input
                className={inputCls}
                value={password}
                onChange={e => setPassword(e.target.value)}
              />
              <button
                type="button"
                onClick={() => setPassword(genTempPassword())}
                className="px-3 py-2 rounded-lg border border-[#D4C5B0] text-xs text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors flex-shrink-0"
              >
                Regenerate
              </button>
            </div>
            <p className="text-xs text-brown-faint mt-1">Share this with {request.full_name.split(' ')[0]} after approving.</p>
          </div>
          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border border-[#D4C5B0] text-sm text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleApprove}
              disabled={saving}
              className="flex-1 py-2.5 rounded-xl bg-[#3D7A50] text-white text-sm font-semibold hover:bg-[#2E6040] transition-colors disabled:opacity-60"
            >
              {saving ? 'Approving...' : 'Approve & Create Account'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── RejectRegModal ───────────────────────────────────────────────────────────

function RejectRegModal({
  request,
  reviewerId,
  onClose,
  onRejected,
}: {
  request: RegRequest
  reviewerId: string | undefined
  onClose: () => void
  onRejected: () => void
}) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleReject() {
    setSaving(true)
    await supabase
      .from('registration_requests')
      .update({
        status: 'rejected',
        reviewed_by: reviewerId ?? null,
        reviewed_at: new Date().toISOString(),
        rejection_reason: reason.trim() || null,
      })
      .eq('id', request.id)
    setSaving(false)
    onRejected()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-cream-light rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E8DDD0]">
          <h2 className="font-bold text-brown-dark text-lg">Reject Registration</h2>
          <button onClick={onClose} className="text-brown-faint hover:text-brown-dark text-xl leading-none">✕</button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div className="bg-white rounded-lg border border-[#E8DDD0] p-3 space-y-1">
            <p className="text-sm font-semibold text-brown-dark">{request.full_name}</p>
            <p className="text-xs text-brown-faint">{request.email}</p>
          </div>
          <div>
            <label className="block text-xs font-semibold text-brown-medium mb-1">Reason (optional)</label>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40] resize-none"
              placeholder="e.g. Branch already fully staffed"
            />
          </div>
          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border border-[#D4C5B0] text-sm text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleReject}
              disabled={saving}
              className="flex-1 py-2.5 rounded-xl bg-[#C0624A] text-white text-sm font-semibold hover:bg-[#A8503A] transition-colors disabled:opacity-60"
            >
              {saving ? 'Rejecting...' : 'Reject Request'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── CredentialsModal ─────────────────────────────────────────────────────────

function CredentialsModal({
  email,
  password,
  onClose,
}: {
  email: string
  password: string
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)

  function copy() {
    navigator.clipboard.writeText(`Email: ${email}\nTemporary password: ${password}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-cream-light rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E8DDD0]">
          <h2 className="font-bold text-brown-dark text-lg">Account Created ✅</h2>
        </div>
        <div className="px-6 py-5 space-y-4">
          <p className="text-sm text-brown-medium">Share these login details with the new staff member:</p>
          <div className="bg-white rounded-lg border border-[#E8DDD0] p-4 space-y-2">
            <div>
              <p className="text-xs text-brown-faint">Email</p>
              <p className="text-sm font-semibold text-brown-dark">{email}</p>
            </div>
            <div>
              <p className="text-xs text-brown-faint">Temporary Password</p>
              <p className="text-sm font-semibold text-brown-dark">{password}</p>
            </div>
          </div>
          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={copy}
              className="flex-1 py-2.5 rounded-xl border border-[#D4C5B0] text-sm text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors"
            >
              {copied ? 'Copied ✓' : 'Copy Details'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── PendingCard ──────────────────────────────────────────────────────────────

function PendingCard({
  completion,
  onApprove,
  onReject,
}: {
  completion: MissionCompletion
  onApprove: () => void
  onReject: () => void
}) {
  const [deciding, setDeciding] = useState(false)

  function approve() { setDeciding(true); onApprove() }
  function reject() { setDeciding(true); onReject() }

  return (
    <div className="bg-white rounded-xl border border-[#E8DDD0] p-4 flex gap-3">
      {completion.photo_url ? (
        <img
          src={completion.photo_url}
          alt="proof"
          className="w-14 h-14 rounded-lg object-cover flex-shrink-0 border border-[#E8DDD0]"
        />
      ) : (
        <div className="w-14 h-14 rounded-lg bg-[#F5EDE0] flex items-center justify-center flex-shrink-0 text-2xl">
          📋
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2">
          <Avatar name={completion.staff?.name ?? '?'} avatar={completion.staff?.avatar ?? null} size="sm" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-brown-dark truncate">{completion.staff?.name ?? 'Unknown'}</p>
            <p className="text-xs text-brown-faint truncate">{completion.mission?.title ?? 'Mission'}</p>
          </div>
          <span className="text-xs text-brown-faint flex-shrink-0">{formatTimeAgo(completion.completed_at)}</span>
        </div>
        <div className="flex gap-2 mt-2.5">
          <button
            onClick={approve}
            disabled={deciding}
            className="flex-1 py-1.5 rounded-lg bg-[#EBF5EE] text-[#3D7A50] text-xs font-semibold hover:bg-[#D4EDDA] transition-colors disabled:opacity-60"
          >
            ✓ Approve
          </button>
          <button
            onClick={reject}
            disabled={deciding}
            className="flex-1 py-1.5 rounded-lg bg-[#FCF0EC] text-[#9E4A30] text-xs font-semibold hover:bg-[#F5DDD5] transition-colors disabled:opacity-60"
          >
            ✗ Reject
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const navigate = useNavigate()
  const { deptName } = useLookups()
  const { ownBranchOnly } = useCan()
  // 全员名册来自 useTeamData(与 /team/reviews 共用同一条查询)。
  const { staff: allStaff, loading: staffLoading, reload: reloadStaff } = useTeamData()
  const [currentStaff, setCurrentStaff] = useState<Staff | null>(null)
  const [completions, setCompletions] = useState<MissionCompletion[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddModal, setShowAddModal] = useState(false)
  const [search, setSearch] = useState('')
  const [filterBranch, setFilterBranch] = useState('')
  const [filterDept, setFilterDept] = useState('')
  const [filterRank, setFilterRank] = useState('')
  const [filterStatus, setFilterStatus] = useState<'active' | 'resigned' | ''>('active')
  const pendingRef = useRef<HTMLDivElement>(null)
  const regRef = useRef<HTMLDivElement>(null)
  const [regRequests, setRegRequests] = useState<RegRequest[]>([])
  const [regTab, setRegTab] = useState<'pending' | 'rejected'>('pending')
  const [approveTarget, setApproveTarget] = useState<RegRequest | null>(null)
  const [rejectTarget, setRejectTarget] = useState<RegRequest | null>(null)
  const [newCredentials, setNewCredentials] = useState<{ email: string; password: string } | null>(null)

  const isManager = currentStaff?.rank === 'manager'

  async function loadAll() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const [myRes, completionsRes] = await Promise.all([
      supabase.from('staff').select('*').eq('id', user.id).single(),
      supabase
        .from('mission_completions')
        .select('*, mission:missions(*), staff:staff!mission_completions_staff_id_fkey(*), approver:staff!mission_completions_approved_by_fkey(*)')
        .order('completed_at', { ascending: false }),
    ])

    if (myRes.data) setCurrentStaff(myRes.data)
    if (completionsRes.data) setCompletions(completionsRes.data as MissionCompletion[])

    const { data: regData } = await supabase
      .from('registration_requests')
      .select('*')
      .in('status', ['pending', 'rejected'])
      .order('created_at', { ascending: false })
    if (regData) setRegRequests(regData as RegRequest[])

    setLoading(false)
  }

  /** 会改动 staff 行的动作(新增/审批注册)要连名册一起刷。 */
  function reloadAll() {
    loadAll()
    reloadStaff()
  }

  // 首屏不调 reloadAll:useTeamData 自己已经在挂载时拉过一次名册了。
  useEffect(() => { loadAll() }, [])

  // Supervisors (no all_branches capability) only see their own branch.
  const myBranchId = currentStaff?.branch_id
  const inBranchScope = (s: Staff) => !ownBranchOnly || !myBranchId || s.branch_id === myBranchId

  // Active staff (resigned are retained but excluded from active operations/counts)
  const activeStaff = allStaff.filter(s => s.status !== 'resigned' && inBranchScope(s))

  // Derived counts
  const pendingCompletions = completions.filter(c => c.status === 'pending')
  const onboardingCount = activeStaff.filter(s => !s.onboarding_completed && s.rank !== 'manager').length
  const levelUpCount = activeStaff.filter(s => {
    if (!s.last_level_up_at) return false
    return Date.now() - new Date(s.last_level_up_at).getTime() < 7 * 24 * 60 * 60 * 1000
  }).length

  const pendingRegRequests = regRequests.filter(r => r.status === 'pending')
  const rejectedRegRequests = regRequests.filter(r => r.status === 'rejected')
  const visibleRegRequests = regTab === 'pending' ? pendingRegRequests : rejectedRegRequests

  const deptBreakdown: Record<string, number> = {}
  activeStaff.forEach(s => {
    const key = s.department ?? 'other'
    deptBreakdown[key] = (deptBreakdown[key] ?? 0) + 1
  })

  // Staff table filter
  const filteredStaff = allStaff.filter(s => {
    if (!inBranchScope(s)) return false
    if (search && !s.name.toLowerCase().includes(search.toLowerCase())) return false
    if (filterBranch && s.branch !== filterBranch) return false
    if (filterDept && s.department !== filterDept) return false
    if (filterRank && s.rank !== filterRank) return false
    if (filterStatus && (s.status ?? 'active') !== filterStatus) return false
    return true
  })

  async function handleApprove(id: string) {
    await supabase
      .from('mission_completions')
      .update({ status: 'approved', approved_by: currentStaff?.id })
      .eq('id', id)
    loadAll()
  }

  async function handleReject(id: string) {
    await supabase.from('mission_completions').update({ status: 'rejected' }).eq('id', id)
    loadAll()
  }

  function handleRegApproved(creds: { email: string; password: string }) {
    setApproveTarget(null)
    setNewCredentials(creds)
    reloadAll()
  }

  function handleRegRejected() {
    setRejectTarget(null)
    reloadAll()
  }

  if (loading || staffLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-cream-light">
        <p className="text-brown-medium animate-pulse">Loading dashboard...</p>
      </div>
    )
  }

  const monthLabel = MONTHS_FULL[CURRENT_MONTH - 1]
  const selectCls =
    'px-3 py-1.5 rounded-lg border border-[#D4C5B0] bg-white text-xs text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

  return (
    <div className="min-h-screen bg-cream-light">
      {showAddModal && (
        <AddStaffModal onClose={() => setShowAddModal(false)} onCreated={reloadAll} />
      )}
      {approveTarget && (
        <ApproveRegModal
          request={approveTarget}
          reviewerId={currentStaff?.id}
          onClose={() => setApproveTarget(null)}
          onApproved={handleRegApproved}
        />
      )}
      {rejectTarget && (
        <RejectRegModal
          request={rejectTarget}
          reviewerId={currentStaff?.id}
          onClose={() => setRejectTarget(null)}
          onRejected={handleRegRejected}
        />
      )}
      {newCredentials && (
        <CredentialsModal
          email={newCredentials.email}
          password={newCredentials.password}
          onClose={() => setNewCredentials(null)}
        />
      )}

      <div className="max-w-7xl mx-auto px-4 py-8 lg:px-8">

        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-brown-dark">Dashboard</h1>
            <p className="text-sm text-brown-faint mt-0.5">
              {monthLabel} {CURRENT_YEAR} · Welcome back, {currentStaff?.name?.split(' ')[0] ?? 'there'}
            </p>
          </div>
          {isManager && (
            <button
              onClick={() => setShowAddModal(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors shadow-sm"
            >
              + Add Staff
            </button>
          )}
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
          <div className="bg-white rounded-2xl p-4 border border-[#E8DDD0]">
            <p className="text-xs text-brown-faint font-medium mb-1">Total Staff</p>
            <p className="text-3xl font-bold text-brown-dark">{activeStaff.length}</p>
            <div className="mt-2 space-y-0.5">
              {Object.entries(deptBreakdown).slice(0, 3).map(([dept, count]) => (
                <p key={dept} className="text-xs text-brown-faint">
                  {DEPT_LABELS[dept] ?? dept}: {count}
                </p>
              ))}
            </div>
          </div>

          {pendingRegRequests.length > 0 && (
            <div
              className="bg-white rounded-2xl p-4 border border-[#E8DDD0] cursor-pointer hover:border-[#C4813A60] transition-colors"
              onClick={() => regRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            >
              <p className="text-xs text-brown-faint font-medium mb-1">Registration Requests</p>
              <p className="text-3xl font-bold text-[#2E6E9E]">{pendingRegRequests.length}</p>
              <p className="text-xs text-brown-faint mt-2">Awaiting approval</p>
            </div>
          )}

          <div
            className="bg-white rounded-2xl p-4 border border-[#E8DDD0] cursor-pointer hover:border-[#C4813A60] transition-colors"
            onClick={() => pendingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          >
            <p className="text-xs text-brown-faint font-medium mb-1">Pending Approvals</p>
            <p className="text-3xl font-bold text-brown-dark">{pendingCompletions.length}</p>
            <p className="text-xs text-brown-faint mt-2">Mission completions awaiting review</p>
          </div>

          <div className="bg-white rounded-2xl p-4 border border-[#E8DDD0]">
            <p className="text-xs text-brown-faint font-medium mb-1">Onboarding</p>
            <p className="text-3xl font-bold text-brown-dark">{onboardingCount}</p>
            <p className="text-xs text-brown-faint mt-2">Staff pending onboarding</p>
          </div>

          <div className="bg-white rounded-2xl p-4 border border-[#E8DDD0]">
            <p className="text-xs text-brown-faint font-medium mb-1">Level Ups</p>
            <p className="text-3xl font-bold text-[#3D7A50]">{levelUpCount}</p>
            <p className="text-xs text-brown-faint mt-2">This week</p>
          </div>
        </div>

        {/* Main content: left column + activity sidebar */}
        <div className="lg:grid lg:grid-cols-3 lg:gap-8">
          <div className="lg:col-span-2 space-y-8">

            {/* ── Registration Requests ── */}
            {regRequests.length > 0 && (
              <section ref={regRef}>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-base font-bold text-brown-dark flex items-center gap-2">
                    Registration Requests
                  </h2>
                  <div className="flex gap-1 bg-white rounded-lg border border-[#E8DDD0] p-0.5">
                    {(['pending', 'rejected'] as const).map(tab => (
                      <button
                        key={tab}
                        onClick={() => setRegTab(tab)}
                        className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                          regTab === tab ? 'bg-[#C4813A] text-white' : 'text-brown-muted hover:bg-[#F5EDE0]'
                        }`}
                      >
                        {tab === 'pending' ? `Pending (${pendingRegRequests.length})` : `Rejected (${rejectedRegRequests.length})`}
                      </button>
                    ))}
                  </div>
                </div>
                {visibleRegRequests.length === 0 ? (
                  <div className="bg-white rounded-xl border border-[#E8DDD0] px-6 py-8 text-center">
                    <p className="text-sm text-brown-faint">No {regTab} requests.</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {visibleRegRequests.map(req => (
                      <div
                        key={req.id}
                        className="bg-white rounded-xl border border-[#E8DDD0] p-4 flex flex-col sm:flex-row sm:items-center gap-3"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-brown-dark">{req.full_name}</p>
                          <p className="text-xs text-brown-muted">{req.email}</p>
                          <div className="flex flex-wrap gap-2 mt-1">
                            {req.branch && (
                              <span className="text-xs bg-canvas text-brown-muted px-2 py-0.5 rounded-full border border-[#E8DDD0]">
                                {req.branch.includes('Connaught') ? 'Cheras' : req.branch.includes('Puteri') ? 'Puchong' : req.branch}
                              </span>
                            )}
                            {req.department && (
                              <span className="text-xs bg-canvas text-brown-muted px-2 py-0.5 rounded-full border border-[#E8DDD0]">
                                {deptName(req.department) || req.department}
                              </span>
                            )}
                            {req.employment_type && (
                              <span className="text-xs bg-canvas text-brown-muted px-2 py-0.5 rounded-full border border-[#E8DDD0]">
                                {req.employment_type}
                              </span>
                            )}
                            {req.phone && (
                              <span className="text-xs text-brown-faint">{req.phone}</span>
                            )}
                          </div>
                          {req.status === 'rejected' && req.rejection_reason && (
                            <p className="text-xs text-[#C06242] mt-1 italic">"{req.rejection_reason}"</p>
                          )}
                          <p className="text-xs text-brown-faint mt-1">{formatTimeAgo(req.created_at)}</p>
                        </div>
                        {req.status === 'pending' && (
                          <div className="flex gap-2 flex-shrink-0">
                            <button
                              onClick={() => setRejectTarget(req)}
                              className="px-3 py-1.5 text-xs rounded-lg border border-[#E8DDD0] text-brown-muted hover:bg-[#FCF0EC] hover:border-[#C06242] hover:text-[#C06242] transition-colors"
                            >
                              Reject
                            </button>
                            <button
                              onClick={() => setApproveTarget(req)}
                              className="px-3 py-1.5 text-xs rounded-lg bg-[#3D7A50] hover:bg-[#2E6040] text-white font-semibold transition-colors"
                            >
                              Approve
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* ── Pending Mission Approvals ── */}
            <section ref={pendingRef}>
              <h2 className="text-base font-bold text-brown-dark mb-4">
                Pending Approvals
                {pendingCompletions.length > 0 && (
                  <span className="ml-2 text-xs bg-[#FEF3E2] text-[#C4813A] px-2 py-0.5 rounded-full font-semibold">
                    {pendingCompletions.length}
                  </span>
                )}
              </h2>

              {pendingCompletions.length === 0 ? (
                <div className="bg-white rounded-xl border border-[#E8DDD0] px-6 py-8 text-center">
                  <p className="text-2xl mb-2">✅</p>
                  <p className="text-sm text-brown-faint">All caught up! No pending approvals.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {pendingCompletions.map(c => (
                    <PendingCard
                      key={c.id}
                      completion={c}
                      onApprove={() => handleApprove(c.id)}
                      onReject={() => handleReject(c.id)}
                    />
                  ))}
                </div>
              )}
            </section>

            {/* ── Staff Table ── */}
            <section id="staff-section">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-base font-bold text-brown-dark">All Staff</h2>
                <span className="text-xs text-brown-faint">{filteredStaff.length} of {allStaff.length}</span>
              </div>

              <div className="flex flex-wrap gap-2 mb-3">
                <input
                  type="search"
                  placeholder="Search name..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="flex-1 min-w-[140px] px-3 py-1.5 rounded-lg border border-[#D4C5B0] bg-white text-xs text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]"
                />
                <select className={selectCls} value={filterBranch} onChange={e => setFilterBranch(e.target.value)}>
                  <option value="">All branches</option>
                  {BRANCHES.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
                <select className={selectCls} value={filterDept} onChange={e => setFilterDept(e.target.value)}>
                  <option value="">All depts</option>
                  {Object.entries(DEPT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                <select className={selectCls} value={filterRank} onChange={e => setFilterRank(e.target.value)}>
                  <option value="">All ranks</option>
                  {(['trainee', 'junior', 'senior', 'supervisor', 'manager'] as const).map(r => (
                    <option key={r} value={r}>{RANK_LABELS[r]}</option>
                  ))}
                </select>
                <select className={selectCls} value={filterStatus} onChange={e => setFilterStatus(e.target.value as 'active' | 'resigned' | '')}>
                  <option value="active">Active</option>
                  <option value="resigned">Resigned</option>
                  <option value="">All statuses</option>
                </select>
              </div>

              <div className="bg-white rounded-xl border border-[#E8DDD0] overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#EDE5D8]">
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-brown-faint">Name</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-brown-faint hidden sm:table-cell">Rank</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-brown-faint hidden md:table-cell">Branch</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-brown-faint hidden lg:table-cell">Dept</th>
                      <th className="text-right px-4 py-2.5 text-xs font-semibold text-brown-faint">XP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredStaff.map((s, i) => (
                      <tr
                        key={s.id}
                        onClick={() => navigate(`/staff/${s.id}`)}
                        className={`cursor-pointer hover:bg-[#FAF6F1] transition-colors ${i > 0 ? 'border-t border-[#F0E8DC]' : ''}`}
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <Avatar name={s.name} avatar={s.avatar} size="sm" />
                            <div>
                              <p className="font-medium text-brown-dark text-sm flex items-center gap-1.5">
                                {s.name}
                                {s.status === 'resigned' && (
                                  <span className="text-[10px] font-semibold text-[#9E4A30] bg-[#C0624212] border border-[#C0624230] px-1.5 py-0.5 rounded-full">
                                    Resigned
                                  </span>
                                )}
                              </p>
                              {!s.onboarding_completed && s.rank !== 'manager' && s.status !== 'resigned' && (
                                <p className="text-xs text-[#C4813A]">Onboarding</p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 hidden sm:table-cell">
                          <span
                            className="text-xs font-semibold px-2 py-0.5 rounded-full"
                            style={{ color: RANK_COLORS[s.rank], background: `${RANK_COLORS[s.rank]}18` }}
                          >
                            {RANK_LABELS[s.rank]}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-brown-faint hidden md:table-cell">
                          {shortenBranch(s.branch)}
                        </td>
                        <td className="px-4 py-3 text-xs text-brown-faint hidden lg:table-cell">
                          {s.department ? (DEPT_LABELS[s.department] ?? s.department) : '—'}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span className="text-xs font-bold text-brown-dark">{s.xp}</span>
                          <span className="text-xs text-brown-faint ml-0.5">xp</span>
                        </td>
                      </tr>
                    ))}
                    {filteredStaff.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-xs text-brown-faint">
                          No staff match your filters.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

          </div>

          {/* ── Activity Feed Sidebar ── */}
          <aside className="mt-8 lg:mt-0">
            <div className="lg:sticky lg:top-6">
              <h2 className="text-base font-bold text-brown-dark mb-4">Activity Feed</h2>
              <div className="bg-white rounded-xl border border-[#E8DDD0] divide-y divide-[#F0E8DC]">
                {completions.length === 0 ? (
                  <p className="px-4 py-6 text-xs text-brown-faint text-center">No recent activity.</p>
                ) : (
                  completions.slice(0, 15).map(c => (
                    <div key={c.id} className="px-4 py-3 flex items-start gap-2.5">
                      <Avatar name={c.staff?.name ?? '?'} avatar={c.staff?.avatar ?? null} size="sm" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold text-brown-dark truncate">{c.staff?.name ?? 'Unknown'}</p>
                        <p className="text-xs text-brown-faint truncate">{c.mission?.title ?? 'Mission'}</p>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className={`text-xs font-medium ${
                            c.status === 'approved' ? 'text-[#3D7A50]' :
                            c.status === 'rejected' ? 'text-[#9E4A30]' :
                            'text-[#C4813A]'
                          }`}>
                            {c.status === 'approved' ? '✓ Approved' : c.status === 'rejected' ? '✗ Rejected' : '⏳ Pending'}
                          </span>
                          <span className="text-xs text-brown-faint">· {formatTimeAgo(c.completed_at)}</span>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </aside>

        </div>
      </div>
    </div>
  )
}
