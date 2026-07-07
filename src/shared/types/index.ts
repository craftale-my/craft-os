export type Rank = 'trainee' | 'junior' | 'senior' | 'supervisor' | 'manager'
export type MissionCategory = 'espresso' | 'milk' | 'service' | 'ops' | 'knowledge' | 'leadership'
export type CompletionStatus = 'pending' | 'approved' | 'rejected'
export type VerificationType = 'photo' | 'supervisor' | 'both'

export type StaffStatus = 'active' | 'resigned'

// ─── System roles (access control — separate from rank/XP and job title) ──────

export type SystemRole = 'owner' | 'admin' | 'hr' | 'manager' | 'supervisor' | 'staff'

export const SYSTEM_ROLES: SystemRole[] = ['owner', 'admin', 'hr', 'manager', 'supervisor', 'staff']

export const SYSTEM_ROLE_LABELS: Record<SystemRole, string> = {
  owner:      'Owner',
  admin:      'Admin',
  hr:         'HR',
  manager:    'Manager',
  supervisor: 'Supervisor',
  staff:      'Staff',
}

export const SYSTEM_ROLE_DESC: Record<SystemRole, string> = {
  owner:      'Full access, incl. system-role assignment',
  admin:      'Full access to all operations',
  hr:         'Attendance, salary, leave, claims & staff profiles',
  manager:    'All operations across every branch',
  supervisor: 'Own branch only',
  staff:      'Own profile only',
}

/** Capabilities that gate navigation, routes and queries. */
export type Capability =
  | 'view_team'        // team dashboard, staff list, approvals area
  | 'manage_staff'     // add staff, approve registrations, edit others
  | 'manage_schedule'  // scheduling
  | 'conduct_reviews'  // monthly / probation reviews
  | 'manage_missions'  // mission CRUD
  | 'view_salary'      // salary records
  | 'manage_hr'        // attendance / leave / claims management
  | 'all_branches'     // see data across every branch (false ⇒ own branch only)
  | 'access_settings'  // company settings
  | 'manage_system_roles' // owner-only; assign system roles + edit matrix

export const CAPABILITIES: { key: Capability; label: string }[] = [
  { key: 'view_team',           label: 'View Team' },
  { key: 'manage_staff',        label: 'Manage Staff' },
  { key: 'manage_schedule',     label: 'Manage Schedule' },
  { key: 'conduct_reviews',     label: 'Conduct Reviews' },
  { key: 'manage_missions',     label: 'Manage Missions' },
  { key: 'view_salary',         label: 'View Salary' },
  { key: 'manage_hr',           label: 'Manage HR' },
  { key: 'all_branches',        label: 'All Branches' },
  { key: 'access_settings',     label: 'Access Settings' },
  { key: 'manage_system_roles', label: 'Manage System Roles' },
]

type CapMap = Partial<Record<Capability, boolean>>

/** Built-in defaults. Owner can override per-role in Settings → System Roles. */
export const DEFAULT_SYSTEM_ROLE_CAPS: Record<SystemRole, CapMap> = {
  owner: {
    view_team: true, manage_staff: true, manage_schedule: true, conduct_reviews: true,
    manage_missions: true, view_salary: true, manage_hr: true, all_branches: true,
    access_settings: true, manage_system_roles: true,
  },
  admin: {
    view_team: true, manage_staff: true, manage_schedule: true, conduct_reviews: true,
    manage_missions: true, view_salary: true, manage_hr: true, all_branches: true,
    access_settings: true, manage_system_roles: false,
  },
  hr: {
    view_team: true, manage_staff: true, manage_schedule: false, conduct_reviews: false,
    manage_missions: false, view_salary: true, manage_hr: true, all_branches: true,
    access_settings: false, manage_system_roles: false,
  },
  manager: {
    view_team: true, manage_staff: true, manage_schedule: true, conduct_reviews: true,
    manage_missions: true, view_salary: true, manage_hr: true, all_branches: true,
    access_settings: true, manage_system_roles: false,
  },
  supervisor: {
    view_team: true, manage_staff: true, manage_schedule: true, conduct_reviews: true,
    manage_missions: false, view_salary: false, manage_hr: true, all_branches: false,
    access_settings: false, manage_system_roles: false,
  },
  staff: {
    view_team: false, manage_staff: false, manage_schedule: false, conduct_reviews: false,
    manage_missions: false, view_salary: false, manage_hr: false, all_branches: false,
    access_settings: false, manage_system_roles: false,
  },
}

export type SystemRolePermissions = Record<SystemRole, CapMap>

export interface SystemRolePermissionRow {
  system_role: SystemRole
  permissions: CapMap
  updated_at: string
}

export interface Staff {
  id: string
  name: string
  email: string | null
  avatar: string | null
  rank: Rank
  system_role: SystemRole
  job_title_id: string | null
  branch_id: string | null
  is_active: boolean
  status: StaffStatus
  level: number
  xp: number
  department: string | null
  joined_at: string | null
  confirmation_date: string | null
  created_at: string
  // onboarding fields
  onboarding_completed: boolean | null
  nickname: string | null
  ic_number: string | null
  address: string | null
  gender: string | null
  date_of_birth: string | null
  contact_number: string | null
  branch: string | null
  employment_type: string | null
  working_experience: string | null
  education: string | null
  // management fields
  manager_notes: string | null
  last_level_up_at: string | null
}

export interface Mission {
  id: string
  title: string
  description: string | null
  xp_reward: number
  category: MissionCategory | null
  min_rank: Rank
  requires_approval: boolean
  verification_type: VerificationType
  created_at: string
}

export interface MissionCompletion {
  id: string
  staff_id: string
  mission_id: string
  status: CompletionStatus
  approved_by: string | null
  photo_url: string | null
  supervisor_note: string | null
  completed_at: string
  mission?: Mission
  staff?: Staff
  approver?: Staff
}

export interface SkillRating {
  id: string
  staff_id: string
  category: string
  skill: string
  rating: number
  rated_by: string | null
  rated_at: string
}

export const RANK_ORDER: Rank[] = ['trainee', 'junior', 'senior', 'supervisor', 'manager']
export const XP_PER_LEVEL = 500
export const MAX_LEVEL: Record<Rank, number> = {
  trainee: 1,
  junior: 5,
  senior: 5,
  supervisor: 3,
  manager: 99,
}

export const RANK_COLORS: Record<Rank, string> = {
  trainee:    '#A0845C',
  junior:     '#C4813A',
  senior:     '#5B9E6A',
  supervisor: '#4A8FBF',
  manager:    '#C27BA0',
}

export const RANK_LABELS: Record<Rank, string> = {
  trainee: 'Trainee',
  junior: 'Junior Barista',
  senior: 'Senior Barista',
  supervisor: 'Supervisor',
  manager: 'Manager',
}

export const SKILL_CATEGORIES: { key: string; label: string; skills: string[] }[] = [
  {
    key: 'espresso',
    label: '☕ Espresso',
    skills: ['Extraction', 'Grinder Calibration', 'Shot Timing', 'Tasting'],
  },
  {
    key: 'milk',
    label: '🥛 Milk & Latte Art',
    skills: ['Steaming', 'Heart Pour', 'Rosetta', 'Tulip'],
  },
  {
    key: 'service',
    label: '⭐ Service',
    skills: ['Greeting', 'Order Taking', 'Complaint Handling', 'Upselling'],
  },
  {
    key: 'ops',
    label: '🔑 Operations',
    skills: ['Opening', 'Closing', 'Cash Handling', 'Stock Count'],
  },
  {
    key: 'knowledge',
    label: '📚 Knowledge',
    skills: ['Coffee Origins', 'Menu', 'Food Safety', 'Allergen'],
  },
]

export const MISSION_CATEGORY_LABELS: Record<MissionCategory, string> = {
  espresso:   '☕ Espresso',
  milk:       '🥛 Milk & Latte Art',
  service:    '⭐ Service',
  ops:        '🔑 Operations',
  knowledge:  '📚 Knowledge',
  leadership: '👑 Leadership',
}

export const VERIFICATION_CONFIG: Record<VerificationType, { label: string; style: string }> = {
  photo:      { label: '📷 Photo',        style: 'bg-[#EBF3FB] text-[#2E6E9E]' },
  supervisor: { label: '✓ Supervisor',    style: 'bg-[#EBF5EE] text-[#3D7A50]' },
  both:       { label: '📷 + Supervisor', style: 'bg-[#FBF0E6] text-[#8B5E2E]' },
}

// ─── Monthly Reviews ──────────────────────────────────────────────────────────

export type ReviewStatus = 'pending' | 'self_done' | 'completed'

export interface MonthlyReview {
  id: string
  staff_id: string
  reviewer_id: string | null
  month: number
  year: number
  late_count: number | null
  attendance_score: number | null
  self_attitude: number | null
  self_efficiency: number | null
  self_coffee_skill: number | null
  self_service: number | null
  self_comments: string | null
  self_submitted_at: string | null
  sup_attitude: number | null
  sup_efficiency: number | null
  sup_coffee_skill: number | null
  sup_service: number | null
  sup_comments: string | null
  sup_submitted_at: string | null
  status: ReviewStatus
  created_at: string
  staff?: Staff
}

export const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
export const MONTHS_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December']

export const REVIEW_CATEGORIES = [
  { key: 'attitude',     selfKey: 'self_attitude',     supKey: 'sup_attitude',     label: 'Attitude & Teamwork', sub: '态度 / 合作', weight: 0.15 },
  { key: 'efficiency',   selfKey: 'self_efficiency',   supKey: 'sup_efficiency',   label: 'Work Efficiency',     sub: '工作效率',   weight: 0.20 },
  { key: 'coffee_skill', selfKey: 'self_coffee_skill', supKey: 'sup_coffee_skill', label: 'Coffee Skills',        sub: '咖啡技术',   weight: 0.20 },
  { key: 'service',      selfKey: 'self_service',      supKey: 'sup_service',      label: 'Service Quality',      sub: '服务品质',   weight: 0.15 },
] as const

export function calcFinalScore(r: MonthlyReview): number | null {
  if (r.sup_attitude == null || r.sup_efficiency == null || r.sup_coffee_skill == null || r.sup_service == null) return null
  const att = r.attendance_score ?? 0
  return Math.round(
    att                     * 0.30 +
    r.sup_attitude    * 20  * 0.15 +
    r.sup_efficiency  * 20  * 0.20 +
    r.sup_coffee_skill * 20 * 0.20 +
    r.sup_service     * 20  * 0.15
  )
}

export function getScoreConfig(score: number) {
  if (score >= 90) return { label: 'Excellent',         emoji: '🌟', color: '#3D7A50', bg: '#EBF5EE', border: '#5B9E6A40' }
  if (score >= 75) return { label: 'Good',              emoji: '👍', color: '#2E6E9E', bg: '#EBF3FB', border: '#4A8FBF40' }
  if (score >= 60) return { label: 'Needs Improvement', emoji: '⚠️', color: '#C4813A', bg: '#FEF3E2', border: '#C4813A40' }
  return               { label: 'Poor',             emoji: '❌', color: '#9E4A30', bg: '#FCF0EC', border: '#C0624240' }
}

// ─── Shared UI constants ──────────────────────────────────────────────────────

// Hardcoded fallbacks — used only when the dynamic tables are unavailable/empty
// (e.g. before the departments/employment_types migration has been run).
export const BRANCHES = ['Cheras (Taman Connaught)', 'Puchong (Bandar Puteri)', 'Other']
export const GENDERS = ['Man', 'Woman']
export const EMPLOYMENT_TYPES = ['Full Time / Contract', 'Part Time']
export const DEPARTMENTS = ['Barista (Full Time)', 'Service Crew', 'Bakery', 'Kitchen', 'Other']

// ─── Dynamic lookups (departments, employment types) ──────────────────────────

export type LookupStatus = 'active' | 'inactive'

export interface Department {
  id: string
  name: string          // display label, e.g. "Barista (Full Time)"
  slug: string          // canonical value stored on staff.department, e.g. "barista"
  status: LookupStatus
  created_at: string
}

/** Fallback department options {slug,name} derived from the hardcoded lists. */
export const FALLBACK_DEPARTMENTS: { slug: string; name: string }[] = [
  { slug: 'barista',      name: 'Barista (Full Time)' },
  { slug: 'service crew', name: 'Service Crew' },
  { slug: 'bakery',       name: 'Bakery' },
  { slug: 'kitchen',      name: 'Kitchen' },
  { slug: 'other',        name: 'Other' },
]

export interface EmploymentType {
  id: string
  name: string          // the value stored on staff.employment_type
  status: LookupStatus
  created_at: string
}

export const DEPT_LABELS: Record<string, string> = {
  barista:        'Barista (Full Time)',
  'service crew': 'Service Crew',
  bakery:         'Bakery',
  kitchen:        'Kitchen',
  other:          'Other',
}

// ─── Probation Reviews ────────────────────────────────────────────────────────

export interface ProbationReview {
  id: string
  staff_id: string
  reviewer_id: string | null
  start_date: string
  day1_attitude: Record<string, boolean>
  day1_communication: Record<string, boolean>
  day1_elimination: Record<string, boolean>
  day1_result: 'continue' | 'eliminate' | null
  day1_completed_at: string | null
  day2_process: Record<string, boolean>
  day2_serving: Record<string, boolean>
  day2_elimination: Record<string, boolean>
  day2_result: 'continue' | 'eliminate' | null
  day2_completed_at: string | null
  day3_attitude: Record<string, boolean>
  day3_performance: Record<string, boolean>
  day3_result: 'hire' | 'eliminate' | null
  day3_completed_at: string | null
  overall_result: 'hired' | 'eliminated' | null
  supervisor_notes: string | null
  created_at: string
  staff?: Staff
}

export function getProbationDay(startDate: string): number {
  const start = new Date(startDate)
  start.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diff = Math.floor((today.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
  return Math.min(Math.max(diff + 1, 1), 3)
}

export const PROBATION_CHECKLIST = {
  day1: {
    attitude: [
      { key: 'on_time',        label: '准时到达（9:30前）', sub: '是否有时间观念' },
      { key: 'neat_dress',     label: '穿着整齐',          sub: '干净、符合店标准' },
      { key: 'willing_learn',  label: '愿意学习',          sub: '没有抗拒、不敷衍' },
      { key: 'basic_courtesy', label: '有基本礼貌',        sub: '会打招呼、有回应' },
      { key: 'smile',          label: '有微笑',            sub: '表情自然，不冷脸' },
    ],
    communication: [
      { key: 'speaks_up',          label: '敢开口说话',        sub: '不沉默、不逃避' },
      { key: 'asks_questions',     label: '不懂会问',          sub: '主动提问，不硬撑' },
      { key: 'accepts_correction', label: '能接受指正',        sub: '被纠正不会不爽' },
      { key: 'responds',           label: '有回应（不会无视）', sub: '被叫会回应' },
      { key: 'not_zoning_out',     label: '不站着发呆',        sub: '会观察、会找事做' },
      { key: 'initiative',         label: '有基本主动性',      sub: '不一直等指示' },
      { key: 'keeps_pace',         label: '跟得上节奏',        sub: '不拖、不慢' },
    ],
    elimination: [
      { key: 'late_excuses',  label: '迟到 / 找借口' },
      { key: 'silent',        label: '完全不讲话 / 不回应' },
      { key: 'bad_attitude',  label: '黑脸 / 情绪不好' },
      { key: 'phone',         label: '一直发呆 / 滑手机' },
      { key: 'refuses_learn', label: '不愿意学（明显抗拒）' },
    ],
  },
  day2: {
    process: [
      { key: 'greet_independently', label: '能独立迎宾',  sub: '不需要提醒' },
      { key: 'seat_correctly',      label: '能正确带位',  sub: '不乱走、不指人' },
      { key: 'qr_clear',            label: 'QR话术清楚',  sub: '不讲错、不漏讲' },
      { key: 'knows_table',         label: '知道桌号',    sub: '不混乱' },
      { key: 'reads_order',         label: '看得懂订单',  sub: '不只看第一行' },
    ],
    serving: [
      { key: 'correct_table',    label: '不送错桌',         sub: '有确认桌号' },
      { key: 'checks_before',    label: '出餐前会检查',     sub: '有"看单再看桌"' },
      { key: 'no_missed_orders', label: '不漏单',           sub: '有留意系统' },
      { key: 'proactive',        label: '有主动性',         sub: '会帮忙，不等指示' },
      { key: 'follows_standard', label: '会照标准做',       sub: '不乱改流程' },
      { key: 'learning',         label: '重复错误是否减少', sub: '有学习能力' },
      { key: 'accountability',   label: '不推责任',         sub: '错会承认' },
    ],
    elimination: [
      { key: 'wrong_process',    label: '一直讲错流程' },
      { key: 'repeat_mistakes',  label: '同样错误重复3次以上' },
      { key: 'ignores_teaching', label: '教了不改 / 不听' },
      { key: 'no_initiative',    label: '完全没有主动性' },
      { key: 'affects_others',   label: '开始影响其他员工' },
    ],
  },
  day3: {
    attitude: [
      { key: 'proactive_help', label: '主动帮忙',   sub: '会自己找事情' },
      { key: 'no_reminders',   label: '不等人提醒', sub: '有责任感' },
      { key: 'stable_mood',    label: '情绪稳定',   sub: '不摆脸色' },
      { key: 'team_player',    label: '有团队感',   sub: '不自我中心' },
    ],
    performance: [
      { key: 'stable_process',   label: '流程稳定', sub: '不再乱' },
      { key: 'correct_delivery', label: '不送错桌', sub: '基本准确' },
      { key: 'no_missed_orders', label: '不漏单',   sub: '有责任心' },
      { key: 'smooth_overall',   label: '整体顺畅', sub: '不拖累团队' },
    ],
  },
} as const

export const DEPT_STORE: Record<string, string> = {
  'Barista (Full Time)': 'barista',
  'Service Crew':        'service crew',
  'Bakery':              'bakery',
  'Kitchen':             'kitchen',
  'Other':               'other',
}

// ─── Settings module ──────────────────────────────────────────────────────────

export interface CompanySettings {
  id: string
  company_name: string | null
  cafe_name: string | null
  logo_url: string | null
  company_culture: string | null
  contact_email: string | null
  contact_phone: string | null
  address: string | null
  updated_at: string | null
}

export interface Branch {
  id: string
  name: string
  address: string | null
  pic_staff_id: string | null
  operating_hours: string | null
  is_active: boolean
  created_at: string
  latitude: number | null
  longitude: number | null
  radius_meters: number | null
  pic?: Staff | null
}

export type PermissionKey =
  | 'view_own_profile'
  | 'complete_missions'
  | 'view_team_dashboard'
  | 'approve_missions'
  | 'rate_skills'
  | 'manage_staff'
  | 'manage_tasks'
  | 'view_all_reviews'
  | 'conduct_reviews'
  | 'access_settings'

export const PERMISSION_LABELS: Record<PermissionKey, string> = {
  view_own_profile:    'View Own Profile',
  complete_missions:   'Complete Missions',
  view_team_dashboard: 'View Team Dashboard',
  approve_missions:    'Approve Missions',
  rate_skills:         'Rate Skills',
  manage_staff:        'Manage Staff',
  manage_tasks:        'Manage Tasks',
  view_all_reviews:    'View All Reviews',
  conduct_reviews:     'Conduct Reviews',
  access_settings:     'Access Settings',
}

export const PERMISSION_KEYS = Object.keys(PERMISSION_LABELS) as PermissionKey[]

export interface Role {
  id: string
  name: string
  rank: Rank
  department: string | null
  description: string | null
  permissions: Partial<Record<PermissionKey, boolean>>
  is_active: boolean
  created_at: string
}

export interface SystemRule {
  id: string
  key: string
  value: string
  label: string | null
  description: string | null
  updated_at: string | null
}

export interface NotificationSetting {
  id: string
  event_type: string
  label: string | null
  enabled: boolean
  notify_staff: boolean
  notify_supervisor: boolean
  notify_manager: boolean
}

// ─── HR module ──────────────────────────────────────────────────────────────────

export type AttendanceStatus = 'present' | 'absent' | 'late' | 'half_day' | 'public_holiday' | 'on_leave'

export const ATTENDANCE_STATUS_LABELS: Record<AttendanceStatus, string> = {
  present: 'Present',
  absent: 'Absent',
  late: 'Late',
  half_day: 'Half Day',
  public_holiday: 'Public Holiday',
  on_leave: 'On Leave',
}

export const ATTENDANCE_STATUS_COLORS: Record<AttendanceStatus, string> = {
  present: '#3D7A50',
  absent: '#9E4A30',
  late: '#C4813A',
  half_day: '#2E6E9E',
  public_holiday: '#7B5EA8',
  on_leave: '#8B7355',
}

export interface Attendance {
  id: string
  staff_id: string
  date: string
  clock_in: string | null
  clock_out: string | null
  status: AttendanceStatus
  late_minutes: number
  notes: string | null
  recorded_by: string | null
  created_at: string
  clock_in_photo_url: string | null
  clock_out_photo_url: string | null
  clock_in_lat: number | null
  clock_in_lng: number | null
  clock_in_distance_m: number | null
  clock_out_lat: number | null
  clock_out_lng: number | null
  clock_out_distance_m: number | null
  // break tracking
  break_start: string | null          // when staff clocked OUT for break
  break_end: string | null            // when staff clocked back IN from break
  break_minutes: number | null        // actual break duration taken
  break_late: boolean                 // true if break exceeded the allowed duration
  break_overrun_minutes: number       // minutes over the allowed break duration
  staff?: Staff
}

export interface SalaryRecord {
  id: string
  staff_id: string
  month: number
  year: number
  basic_salary: number
  allowances: number
  overtime: number
  deductions: number
  bonus: number
  gross_salary: number
  epf_employee: number
  socso_employee: number
  eis_employee: number
  pcb: number
  net_salary: number
  payment_date: string | null
  payment_method: 'bank_transfer' | 'cash' | 'cheque'
  notes: string | null
  created_by: string | null
  created_at: string
  staff?: Staff
}

export type LeaveType = 'annual' | 'medical' | 'emergency' | 'unpaid' | 'maternity' | 'paternity' | 'public_holiday'

export const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
  annual: 'Annual Leave',
  medical: 'Medical Leave',
  emergency: 'Emergency Leave',
  unpaid: 'Unpaid Leave',
  maternity: 'Maternity Leave',
  paternity: 'Paternity Leave',
  public_holiday: 'Public Holiday',
}

export interface LeaveEntitlement {
  id: string
  staff_id: string
  year: number
  annual_entitled: number
  annual_used: number
  medical_entitled: number
  medical_used: number
  emergency_entitled: number
  emergency_used: number
  unpaid_used: number
}

export interface LeaveRequest {
  id: string
  staff_id: string
  leave_type: LeaveType
  start_date: string
  end_date: string
  total_days: number
  reason: string | null
  attachment_url: string | null
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  reviewed_by: string | null
  reviewed_at: string | null
  rejection_reason: string | null
  created_at: string
  staff?: Staff
}

export interface AccrualEntry {
  id: string
  staff_id: string
  entry_type: 'accrual' | 'forfeit' | 'adjustment'
  amount: number
  period_month: string | null
  accrued_at: string
  note: string | null
}

export interface PhReplacement {
  id: string
  staff_id: string
  granted_by: string | null
  granted_at: string
  expires_at: string
  reason: string | null
  status: 'available' | 'used' | 'expired'
  used_in_leave_request_id: string | null
  created_at: string
}

export type ClaimType = 'transport' | 'parking' | 'meal' | 'medical' | 'phone' | 'uniform' | 'other'

export const CLAIM_TYPE_LABELS: Record<ClaimType, string> = {
  transport: 'Transport',
  parking: 'Parking',
  meal: 'Meal',
  medical: 'Medical',
  phone: 'Phone',
  uniform: 'Uniform',
  other: 'Other',
}

export interface Claim {
  id: string
  staff_id: string
  claim_type: ClaimType
  amount: number
  description: string
  receipt_url: string | null
  claim_date: string
  status: 'pending' | 'approved' | 'rejected'
  reviewed_by: string | null
  reviewed_at: string | null
  rejection_reason: string | null
  paid_at: string | null
  created_at: string
  staff?: Staff
}

// ─── Shift Scheduling ─────────────────────────────────────────────────────────

export interface ShiftType {
  id: string
  department: string
  name: string
  start_time: string
  end_time: string
  break_start: string | null   // legacy — no longer used, kept for back-compat
  break_end: string | null     // legacy — no longer used, kept for back-compat
  break_minutes: number        // legacy single-break duration — superseded by break1/break2
  break1_duration_minutes: number // allowed duration of break 1 (0 = no break 1)
  break2_duration_minutes: number // allowed duration of break 2 (0 = no break 2)
  color: string
  is_active: boolean
  created_at: string
}

export interface AttendanceBreak {
  id: string
  attendance_id: string
  break_number: 1 | 2
  clock_out_time: string | null
  clock_in_time: string | null
  duration_minutes: number | null
  overtime_minutes: number
  is_overtime: boolean
  created_at: string
}

/** Fallback break duration (minutes) when a staff has no scheduled shift for the day. */
export const DEFAULT_BREAK_MINUTES = 60

export interface ScheduledShift {
  id: string
  staff_id: string
  shift_type_id: string | null
  leave_type: LeaveType | null
  branch_id: string | null
  date: string
  status: 'scheduled' | 'confirmed' | 'swapped' | 'cancelled'
  notes: string | null
  created_by: string | null
  created_at: string
}

/** Leave types a manager may assign straight from the schedule (annual and
 *  paternity intentionally excluded — those go through the request flow). */
export const SCHEDULE_LEAVE_OPTIONS: { type: LeaveType; label: string }[] = [
  { type: 'medical',        label: 'Medical Leave (MC)' },
  { type: 'emergency',      label: 'Emergency Leave' },
  { type: 'unpaid',         label: 'Unpaid Leave' },
  { type: 'maternity',      label: 'Maternity Leave' },
  { type: 'public_holiday', label: 'Public Holiday Replacement' },
]

export const SCHEDULE_LEAVE_LABELS: Partial<Record<LeaveType, string>> =
  Object.fromEntries(SCHEDULE_LEAVE_OPTIONS.map(o => [o.type, o.label]))

/** A schedule-assigned leave writes an attendance row (status on_leave).
 *  When the leave marker is replaced, that row may be deleted — but only
 *  while it is still pristine (no clock data). */
export function shouldClearLeaveAttendance(
  att: Pick<Attendance, 'status' | 'clock_in'> | null | undefined,
): boolean {
  return !!att && att.status === 'on_leave' && att.clock_in == null
}

export const DEPT_SHIFT_COLORS: Record<string, string> = {
  barista:        '#C4813A',
  bakery:         '#8B6344',
  kitchen:        '#C0624B',
  office:         '#4A8FBF',
  'service crew': '#6B8F5E',
  other:          '#8B7355',
}

export interface BreakOvertimeResult {
  durationMinutes: number
  overtimeMinutes: number
  isOvertime: boolean
}

/** Compute a break's actual length and overtime against the allowed minutes. */
export function computeBreakOvertime(
  clockOutIso: string,
  clockInIso: string,
  allowedMinutes: number,
): BreakOvertimeResult {
  const durationMinutes = Math.round(
    (new Date(clockInIso).getTime() - new Date(clockOutIso).getTime()) / 60000,
  )
  const overtimeMinutes = Math.max(0, durationMinutes - allowedMinutes)
  return { durationMinutes, overtimeMinutes, isOvertime: overtimeMinutes > 0 }
}

// ─── Skill Matrix / Career system ─────────────────────────────────────────────

export interface CareerPath {
  id: string
  department_id: string | null
  from_job_title_id: string
  to_job_title_id: string
  status: LookupStatus
  created_at: string
  from?: Role
  to?: Role
  skills?: Skill[]
}

export interface Skill {
  id: string
  career_path_id: string
  name: string
  name_zh: string | null
  description: string | null
  xp_reward: number
  sort_order: number
  status: LookupStatus
  created_at: string
}

export type SkillAssessmentStatus = 'not_started' | 'learning' | 'pending_review' | 'passed' | 'failed'

export interface SkillAssessment {
  id: string
  staff_id: string
  skill_id: string
  status: SkillAssessmentStatus
  assessed_by: string | null
  assessed_at: string | null
  remarks: string | null
  created_at: string
  updated_at: string
  skill?: Skill
  staff?: Staff
  assessor?: Staff
}

export interface PromotionRequest {
  id: string
  staff_id: string
  career_path_id: string
  status: 'pending' | 'approved' | 'deferred'
  decided_by: string | null
  decided_at: string | null
  defer_reason: string | null
  created_at: string
  staff?: Staff
  career_path?: CareerPath
}

export const SKILL_STATUS_LABELS: Record<SkillAssessmentStatus, string> = {
  not_started:    'Not Started',
  learning:       'Learning',
  pending_review: 'Pending Review',
  passed:         'Passed',
  failed:         'Failed',
}

export const SKILL_STATUS_COLORS: Record<SkillAssessmentStatus, string> = {
  not_started:    '#8B7355',
  learning:       '#2E6E9E',
  pending_review: '#C4813A',
  passed:         '#3D7A50',
  failed:         '#9E4A30',
}

export const SKILL_STATUS_ICONS: Record<SkillAssessmentStatus, string> = {
  not_started:    '⬜',
  learning:       '📖',
  pending_review: '🔶',
  passed:         '✅',
  failed:         '❌',
}
