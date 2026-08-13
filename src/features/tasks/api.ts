import { supabase } from '../../shared/lib/supabase'
import { writeOutcome, type WriteOutcome } from '../../shared/lib/db-write'
import { normalizeTagName } from '../../shared/lib/tasks'
import { DONE_WINDOW_DAYS } from './types'
import type {
  Task, Project, Tag, ChecklistItem, Attachment, TaskComment,
  TaskStatus, TaskPriority, ProjectStatus,
} from './types'

/**
 * Tasks 模块唯一的 Supabase 出入口。
 *
 * 两条硬规则:
 *  1. 读取失败一律 throw —— 页面层负责显示错误。旧版把 error 吞掉,
 *     结果 tasks 表整个不存在也只是显示一块空白板,没人发现。
 *  2. 写入一律带 .select() 并经 writeOutcome() 判定 —— RLS 挡掉的写入
 *     回传 { data: [], error: null },error === null 不代表写进去了。
 */

const TASK_SELECT = `
  *,
  assignee:staff!tasks_assigned_to_fkey(id,name,avatar),
  creator:staff!tasks_created_by_fkey(id,name,avatar),
  project:projects(id,name,color),
  task_tags(tags(id,slug,name,color)),
  task_comments(count),
  task_attachments(count),
  task_checklist_items(id,done)
`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function shapeTask(row: any): Task {
  const checklist: Array<{ done: boolean }> = row.task_checklist_items ?? []
  return {
    ...row,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tags: (row.task_tags ?? []).map((tt: any) => tt.tags).filter(Boolean),
    _comment_count:    row.task_comments?.[0]?.count ?? 0,
    _attachment_count: row.task_attachments?.[0]?.count ?? 0,
    _checklist_total:  checklist.length,
    _checklist_done:   checklist.filter(c => c.done).length,
  } as Task
}

/** Done 栏的 server-side 时间窗。前端过滤会让半年后每次开板都拉全部历史。 */
export function doneWindowFilter(now: Date, days = DONE_WINDOW_DAYS): string {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
  return `status.neq.done,completed_at.gte.${cutoff}`
}

// ── Tasks ───────────────────────────────────────────────────────────────────

/** 板上要显示的任务。`projectId` 给的话只取该项目。 */
export async function fetchBoardTasks(opts: {
  projectId?: string
  now?: Date
} = {}): Promise<Task[]> {
  let q = supabase.from('tasks').select(TASK_SELECT)
  if (opts.projectId) q = q.eq('project_id', opts.projectId)
  const { data, error } = await q
    .or(doneWindowFilter(opts.now ?? new Date()))
    .order('position', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []).map(shapeTask)
}

/** Archive 页:全部已完成任务,不受时间窗限制。 */
export async function fetchArchivedTasks(): Promise<Task[]> {
  const { data, error } = await supabase
    .from('tasks').select(TASK_SELECT)
    .eq('status', 'done')
    .order('completed_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []).map(shapeTask)
}

export interface TaskInput {
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  project_id: string | null
  assigned_to: string | null
  due_date: string | null
  department: string | null
  position: number
}

export async function createTask(input: TaskInput, createdBy: string): Promise<WriteOutcome> {
  return writeOutcome(
    await supabase.from('tasks').insert({ ...input, created_by: createdBy }).select(),
  )
}

export async function updateTask(id: string, patch: Partial<TaskInput>): Promise<WriteOutcome> {
  return writeOutcome(await supabase.from('tasks').update(patch).eq('id', id).select())
}

export async function moveTask(
  id: string, status: TaskStatus, position: number,
): Promise<WriteOutcome> {
  return writeOutcome(
    await supabase.from('tasks').update({ status, position }).eq('id', id).select(),
  )
}

export async function deleteTask(id: string): Promise<WriteOutcome> {
  return writeOutcome(await supabase.from('tasks').delete().eq('id', id).select())
}

// ── Tags ────────────────────────────────────────────────────────────────────

export async function fetchTags(): Promise<Tag[]> {
  const { data, error } = await supabase
    .from('tags').select('id,slug,name,color').order('name')
  if (error) throw new Error(error.message)
  return (data ?? []) as Tag[]
}

/**
 * 自由输入的标签。冲突时刻意写回自己的旧 name(先到者胜),
 * 目的是让 RETURNING 回传既有列 —— 所以打 `Urgent` 会命中已存在的 `urgent`,
 * 不会产生第二笔。
 *
 * 这是唯一不经 writeOutcome 的写入:`.single()` 在零列时会回 PGRST116 error,
 * 所以 RLS 挡掉会直接 throw,不会静默通过。
 */
export async function upsertTag(raw: string, createdBy: string): Promise<Tag> {
  const norm = normalizeTagName(raw)
  if (!norm) throw new Error('Tag name cannot be empty.')
  const { data, error } = await supabase
    .from('tags')
    .upsert(
      { slug: norm.slug, name: norm.name, created_by: createdBy },
      { onConflict: 'slug', ignoreDuplicates: false },
    )
    .select('id,slug,name,color')
    .single()
  if (error) throw new Error(error.message)
  return data as Tag
}

export async function attachTag(taskId: string, tagId: string): Promise<WriteOutcome> {
  return writeOutcome(
    await supabase.from('task_tags').insert({ task_id: taskId, tag_id: tagId }).select(),
  )
}

export async function detachTag(taskId: string, tagId: string): Promise<WriteOutcome> {
  return writeOutcome(
    await supabase.from('task_tags').delete()
      .eq('task_id', taskId).eq('tag_id', tagId).select(),
  )
}

export async function updateTag(
  id: string, patch: { name?: string; slug?: string; color?: string },
): Promise<WriteOutcome> {
  return writeOutcome(await supabase.from('tags').update(patch).eq('id', id).select())
}

export async function deleteTag(id: string): Promise<WriteOutcome> {
  return writeOutcome(await supabase.from('tags').delete().eq('id', id).select())
}

// ── Checklist ───────────────────────────────────────────────────────────────

export async function fetchChecklist(taskId: string): Promise<ChecklistItem[]> {
  const { data, error } = await supabase
    .from('task_checklist_items').select('*')
    .eq('task_id', taskId).order('position')
  if (error) throw new Error(error.message)
  return (data ?? []) as ChecklistItem[]
}

export async function addChecklistItem(
  taskId: string, title: string, position: number,
): Promise<WriteOutcome> {
  return writeOutcome(
    await supabase.from('task_checklist_items')
      .insert({ task_id: taskId, title, position }).select(),
  )
}

export async function setChecklistDone(id: string, done: boolean): Promise<WriteOutcome> {
  return writeOutcome(
    await supabase.from('task_checklist_items').update({ done }).eq('id', id).select(),
  )
}

export async function deleteChecklistItem(id: string): Promise<WriteOutcome> {
  return writeOutcome(
    await supabase.from('task_checklist_items').delete().eq('id', id).select(),
  )
}

// ── Attachments ─────────────────────────────────────────────────────────────

export async function fetchAttachments(taskId: string): Promise<Attachment[]> {
  const { data, error } = await supabase
    .from('task_attachments').select('*')
    .eq('task_id', taskId).order('created_at')
  if (error) throw new Error(error.message)
  return (data ?? []) as Attachment[]
}

/** 上传后写一笔纪录。storage_path 必须留下,否则档案永远删不掉。 */
export async function uploadAttachment(
  taskId: string, file: File, uploadedBy: string,
): Promise<WriteOutcome> {
  const ext = file.name.split('.').pop() ?? 'jpg'
  const storagePath = `${taskId}/${Date.now()}.${ext}`
  const { error: upErr } = await supabase.storage
    .from('task-attachments').upload(storagePath, file, { contentType: file.type })
  if (upErr) return { ok: false, reason: upErr.message }

  const url = supabase.storage.from('task-attachments').getPublicUrl(storagePath).data.publicUrl
  const res = writeOutcome(
    await supabase.from('task_attachments').insert({
      task_id: taskId, url, storage_path: storagePath,
      file_name: file.name, mime_type: file.type, size_bytes: file.size,
      uploaded_by: uploadedBy,
    }).select(),
  )
  // 纪录写不进去就把已上传的档案收掉,不要留孤儿。
  if (!res.ok) {
    const { error: rmErr } = await supabase.storage.from('task-attachments').remove([storagePath])
    // remove() 本身失败的话孤儿档案还是留着——记下来,不要连这个失败都吞掉。
    if (rmErr) console.error(`[tasks] orphaned attachment not removed: ${storagePath}`, rmErr.message)
  }
  return res
}

export async function deleteAttachment(att: Attachment): Promise<WriteOutcome> {
  const res = writeOutcome(
    await supabase.from('task_attachments').delete().eq('id', att.id).select(),
  )
  if (res.ok) await supabase.storage.from('task-attachments').remove([att.storage_path])
  return res
}

// ── Comments ────────────────────────────────────────────────────────────────

export async function fetchComments(taskId: string): Promise<TaskComment[]> {
  const { data, error } = await supabase
    .from('task_comments')
    .select('*, staff:staff!task_comments_staff_id_fkey(id,name,avatar)')
    .eq('task_id', taskId).order('created_at')
  if (error) throw new Error(error.message)
  return (data ?? []) as TaskComment[]
}

export async function postComment(
  taskId: string, staffId: string, comment: string,
): Promise<WriteOutcome> {
  return writeOutcome(
    await supabase.from('task_comments')
      .insert({ task_id: taskId, staff_id: staffId, comment }).select(),
  )
}

// ── Projects ────────────────────────────────────────────────────────────────

const PROJECT_SELECT = '*, owner:staff!projects_owner_id_fkey(id,name,avatar)'

export async function fetchProjects(): Promise<Project[]> {
  const [projRes, progRes] = await Promise.all([
    supabase.from('projects').select(PROJECT_SELECT).order('created_at', { ascending: false }),
    supabase.from('project_progress').select('*'),
  ])
  if (projRes.error) throw new Error(projRes.error.message)
  if (progRes.error) throw new Error(progRes.error.message)
  const byId = new Map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (progRes.data ?? []).map((r: any) => [r.project_id, r]),
  )
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (projRes.data ?? []).map((p: any) => ({
    ...p,
    total_tasks:   byId.get(p.id)?.total_tasks   ?? 0,
    done_tasks:    byId.get(p.id)?.done_tasks    ?? 0,
    overdue_tasks: byId.get(p.id)?.overdue_tasks ?? 0,
  })) as Project[]
}

export async function fetchProject(id: string): Promise<Project> {
  const [projRes, progRes] = await Promise.all([
    supabase.from('projects').select(PROJECT_SELECT).eq('id', id).single(),
    supabase.from('project_progress').select('*').eq('project_id', id).maybeSingle(),
  ])
  if (projRes.error) throw new Error(projRes.error.message)
  return {
    ...projRes.data,
    total_tasks:   progRes.data?.total_tasks   ?? 0,
    done_tasks:    progRes.data?.done_tasks    ?? 0,
    overdue_tasks: progRes.data?.overdue_tasks ?? 0,
  } as Project
}

export interface ProjectInput {
  name: string
  description: string | null
  color: string
  status: ProjectStatus
  owner_id: string | null
  start_date: string | null
  due_date: string | null
}

export async function createProject(
  input: ProjectInput, createdBy: string,
): Promise<WriteOutcome> {
  return writeOutcome(
    await supabase.from('projects').insert({ ...input, created_by: createdBy }).select(),
  )
}

export async function updateProject(
  id: string, patch: Partial<ProjectInput>,
): Promise<WriteOutcome> {
  return writeOutcome(await supabase.from('projects').update(patch).eq('id', id).select())
}

export async function deleteProject(id: string): Promise<WriteOutcome> {
  return writeOutcome(await supabase.from('projects').delete().eq('id', id).select())
}
