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

/** Done 栏保留几天。超过的只在 /team/tasks/archive 出现。 */
export const DONE_WINDOW_DAYS = 14
