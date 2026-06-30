export type Rank = 'trainee' | 'junior' | 'senior' | 'supervisor' | 'manager'
export type MissionCategory = 'espresso' | 'milk' | 'service' | 'ops' | 'knowledge' | 'leadership'
export type CompletionStatus = 'pending' | 'approved' | 'rejected'
export type VerificationType = 'photo' | 'supervisor' | 'both'

export interface Staff {
  id: string
  name: string
  avatar: string | null
  rank: Rank
  is_active: boolean
  level: number
  xp: number
  department: string | null
  joined_at: string | null
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

export const BRANCHES = ['Cheras (Taman Connaught)', 'Puchong (Bandar Puteri)', 'Other']
export const GENDERS = ['Man', 'Woman']
export const EMPLOYMENT_TYPES = ['Full Time / Contract', 'Part Time']
export const DEPARTMENTS = ['Barista (Full Time)', 'Service Crew', 'Bakery', 'Kitchen', 'Other']

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
