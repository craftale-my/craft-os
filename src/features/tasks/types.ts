import type { WriteOutcome } from '../../shared/lib/db-write'

export type TaskStatus   = 'todo' | 'in_progress' | 'done'
export type TaskPriority = 'low' | 'medium' | 'high'
export type ProjectStatus = 'active' | 'on_hold' | 'completed' | 'cancelled'

export interface StaffLite { id: string; name: string; avatar: string | null }

export interface Tag {
  id: string
  slug: string
  name: string
  color: string
}

export interface ChecklistItem {
  id: string
  task_id: string
  title: string
  done: boolean
  position: number
  /** 谁认领了这一条。null = 还没人认领(画面上的 "Anyone")。 */
  assigned_to: string | null
  assignee?: StaffLite | null
}

export interface Attachment {
  id: string
  task_id: string
  url: string
  storage_path: string
  file_name: string | null
  mime_type: string | null
  size_bytes: number | null
  uploaded_by: string | null
  created_at: string
}

export interface TaskComment {
  id: string
  task_id: string
  staff_id: string
  comment: string
  created_at: string
  staff?: StaffLite
}

export interface Task {
  id: string
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  project_id: string | null
  assigned_to: string | null
  created_by: string | null
  due_date: string | null
  department: string | null
  position: number
  completed_at: string | null
  created_at: string
  updated_at: string
  assignee?: StaffLite | null
  creator?: StaffLite | null
  project?: { id: string; name: string; color: string } | null
  tags: Tag[]
  /** 由 board 查询聚合,不是资料表栏位。 */
  _comment_count: number
  _attachment_count: number
  _checklist_done: number
  _checklist_total: number
}

export interface Project {
  id: string
  name: string
  description: string | null
  color: string
  status: ProjectStatus
  owner_id: string | null
  start_date: string | null
  due_date: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  owner?: StaffLite | null
  /** 来自 project_progress view。 */
  total_tasks: number
  done_tasks: number
  overdue_tasks: number
}

/**
 * 换栏的结果。`null` 是「使用者在软性完成确认里按了取消」——不是失败:
 * 没有送出写入,也没有跑乐观更新,所以呼叫端既不该显示错误,也不该
 * 把既有的错误横幅当成「这次成功了」而收掉。用 null 而不是多一种
 * `{ ok: false, reason }`,是因为后者一定会被现成的 `!res.ok` 分支
 * 当成失败讲出来。
 */
export type MoveResult = WriteOutcome | null

export const TASK_COLUMNS: { key: TaskStatus; label: string }[] = [
  { key: 'todo',        label: 'To Do' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'done',        label: 'Done' },
]

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  active:    'Active',
  on_hold:   'On Hold',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

/** status pill 的配色。清单页与详情页共用同一份,不各自留一份色码。 */
export const PROJECT_STATUS_STYLES: Record<ProjectStatus, string> = {
  active:    'bg-[#C4813A20] text-[#A86C2C]',
  on_hold:   'bg-[#EDE5D8] text-[#8B7355]',
  completed: 'bg-[#6B8E5A20] text-[#4F6B43]',
  cancelled: 'bg-[#F5EDE0] text-[#A09080]',
}

/** Done 栏保留几天。超过的只在 /team/tasks/archive 出现。 */
export const DONE_WINDOW_DAYS = 14
