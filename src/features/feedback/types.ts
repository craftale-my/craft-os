export type FeedbackCategory = 'product_quality' | 'product_idea' | 'system' | 'workplace'
export type FeedbackStatus = 'new' | 'in_review' | 'resolved'

/** 自动附带、不给员工看的上下文。匿名时服务器只留 appVersion。 */
export interface FeedbackContext {
  userAgent?: string
  appVersion?: string
  errorMessage?: string
}

/** feedback 表的一行。 */
export interface Feedback {
  id: string
  category: FeedbackCategory
  message: string
  branch: string | null
  page_path: string | null
  context: FeedbackContext
  photo_paths: string[]
  is_anonymous: boolean
  submitted_by: string | null
  status: FeedbackStatus
  owner_reply: string | null
  replied_at: string | null
  created_at: string
  updated_at: string
}

/** Inbox 用:带上提交人姓名(匿名或 My Feedback 里为 null)。 */
export interface FeedbackRow extends Feedback {
  submitter: { name: string } | null
}

export const CATEGORIES: { value: FeedbackCategory; label: string; hint: string }[] = [
  { value: 'product_quality', label: 'Product Quality',       hint: 'Food, drinks or ingredients not up to standard' },
  { value: 'product_idea',    label: 'Product Idea',          hint: 'Menu ideas or new product suggestions' },
  { value: 'system',          label: 'App / System Issue',    hint: 'Something in Craft OS is broken or hard to use' },
  { value: 'workplace',       label: 'Workplace / Complaint', hint: 'Company, policies, or colleagues' },
]

export const CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  product_quality: 'Product Quality',
  product_idea: 'Product Idea',
  system: 'App / System Issue',
  workplace: 'Workplace / Complaint',
}

export const STATUS_LABELS: Record<FeedbackStatus, string> = {
  new: 'New',
  in_review: 'In review',
  resolved: 'Resolved',
}

export const MAX_MESSAGE = 2000
export const MAX_PHOTOS = 3
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024
/** 选择器里只列这几种:列出 HEIC 会让 iOS Safari 上传原始 HEIC 而不是转成 JPEG。 */
export const PICKER_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
/** 与 feedback-photos bucket 允许的 MIME 类型保持一致。 */
export const ACCEPTED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']
