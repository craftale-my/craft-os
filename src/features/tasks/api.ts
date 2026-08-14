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
 * 自由输入的标签:打 `Urgent` 会命中已存在的 `urgent`,不会产生第二笔。
 *
 * 刻意不用 supabase-js 的 .upsert()。它只能送出
 * `on conflict (slug) do update set <每个给定栏位> = excluded.<栏位>`,
 * 没有语法能表达「冲突时保留既有值」—— 给了 { slug, name, created_by },
 * 撞库存时这三栏就会被后来者整包盖掉:A 建的 `Urgent` 只因为 B 在别的任务上
 * 打了 `urgent`,全板的 pill 就无声变成 `urgent`,created_by 也改判给 B。
 *
 * 改走 upsert_tag() 这支 Postgres function(migration-2026-08-14-tasks-upsert-fn.sql):
 * `on conflict (slug) do update set name = tags.name` 写回既有值,只为了让
 * RETURNING 有列可回 —— 去重照旧,name / created_by 归先写入者,
 * 与 tasks_touch() 锁住 tasks.created_by 是同一个规则。单一 statement,
 * 没有「先 select 再 insert」的空窗。
 *
 * 这是唯一不经 writeOutcome 的写入:`.single()` 在零列时会回 PGRST116 error,
 * 所以权限挡掉会直接 throw,不会静默通过。
 */
export async function upsertTag(raw: string, createdBy: string): Promise<Tag> {
  const norm = normalizeTagName(raw)
  if (!norm) throw new Error('Tag name cannot be empty.')
  const { data, error } = await supabase
    .rpc('upsert_tag', { p_slug: norm.slug, p_name: norm.name, p_created_by: createdBy })
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

/**
 * 改名 / 换色。呼叫端传不了 `slug` —— 这栏刻意不在参数里,想改名就一定会
 * 经过 normalizeTagName() 重算 slug,不存在「name 换了、slug 忘了跟」这种
 * 半吊子状态。TagManagerModal 那边不用记得两栏要一起送,是这支函式的形状
 * 逼出来的,不是靠呼叫端自律。
 *
 * 撞名(改到一个已经有别人在用的 slug)会撞上 `tags.slug` 的 unique index,
 * Postgres 回 23505。刻意不做自动合并——合并要把两笔 tag 底下的 task_tags
 * 一起改判、还要处理同一张卡可能同时挂着「合并前」两笔 tag 的情境,是比
 * 「改名」大一个量级的操作,不是这支函式该硬做的决定。改回一句看得懂的
 * 错误,让打字的人自己决定:换个不撞名的字,或是先把其中一笔删掉
 * (删除会连带清掉 task_tags,呼叫端的确认文字要讲清楚)。
 */
export async function updateTag(
  id: string, patch: { name?: string; color?: string },
): Promise<WriteOutcome> {
  const dbPatch: { name?: string; slug?: string; color?: string } = {}
  if (patch.color !== undefined) dbPatch.color = patch.color
  if (patch.name !== undefined) {
    const norm = normalizeTagName(patch.name)
    if (!norm) return { ok: false, reason: 'the tag name cannot be empty.' }
    dbPatch.name = norm.name
    dbPatch.slug = norm.slug
  }
  const res = await supabase.from('tags').update(dbPatch).eq('id', id).select()
  if (res.error?.code === '23505') {
    return { ok: false, reason: `a tag named "${dbPatch.name}" already exists — pick a different name, or delete one of them.` }
  }
  return writeOutcome(res)
}

export async function deleteTag(id: string): Promise<WriteOutcome> {
  return writeOutcome(await supabase.from('tags').delete().eq('id', id).select())
}

// ── Checklist ───────────────────────────────────────────────────────────────

/**
 * 子项内嵌负责人。外键提示 `!task_checklist_items_assigned_to_fkey` 是必要的,
 * 不是装饰:PostgREST 会把「两个外键的中介表」认成多对多关系,
 * task_checklist_items 加了 staff 外键之后正好符合这个形状,裸写 `staff(...)`
 * 迟早会撞上关系歧义。写死约束名与 TASK_SELECT 的 assignee/creator 同款。
 *
 * 这一栏由 migration-2026-08-14-checklist-assignee.sql 建立;没跑那份迁移的
 * 环境这支读取会直接 throw,由弹窗显示出来 —— 比默默把每一条都画成
 * "Anyone" 好,后者会让人以为资料真的没人认领。
 */
const CHECKLIST_SELECT =
  'id,task_id,title,done,position,assigned_to,' +
  'assignee:staff!task_checklist_items_assigned_to_fkey(id,name,avatar)'

export async function fetchChecklist(taskId: string): Promise<ChecklistItem[]> {
  const { data, error } = await supabase
    .from('task_checklist_items').select(CHECKLIST_SELECT)
    .eq('task_id', taskId).order('position')
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as ChecklistItem[]
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

/** 认领 / 取消认领一条子项。`staffId` 为 null 就是放回 "Anyone"。 */
export async function setChecklistAssignee(
  id: string, staffId: string | null,
): Promise<WriteOutcome> {
  return writeOutcome(
    await supabase.from('task_checklist_items')
      .update({ assigned_to: staffId }).eq('id', id).select(),
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
