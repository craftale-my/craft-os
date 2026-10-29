import { supabase } from '../../shared/lib/supabase'
import type { FeedbackCategory, FeedbackContext, FeedbackRow, FeedbackStatus } from './types'

const BUCKET = 'feedback-photos'

export function feedbackContext(errorMessage?: string): FeedbackContext {
  return {
    userAgent: navigator.userAgent,
    appVersion: __APP_VERSION__,
    ...(errorMessage ? { errorMessage: errorMessage.slice(0, 500) } : {}),
  }
}

export interface SubmitInput {
  category: FeedbackCategory
  message: string
  branch: string | null
  anonymous: boolean
  photos: File[]
  pagePath: string
  context: FeedbackContext
}

export type SubmitResult = { ok: true; id: string } | { ok: false; reason: string }

/** 先传照片再写记录;任何一步失败都把已传的照片删掉,不留孤儿档案。 */
export async function submitFeedback(input: SubmitInput): Promise<SubmitResult> {
  const id = crypto.randomUUID()
  // 匿名不传照片:storage.objects 会记下上传人,照片会暴露身份
  const photos = input.anonymous ? [] : input.photos
  const paths: string[] = []

  for (const [i, file] of photos.entries()) {
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
    const path = `${id}/${i + 1}.${ext}`
    const { error } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type })
    if (error) {
      await removePhotos(paths)
      return { ok: false, reason: "Couldn't upload photo. Try again." }
    }
    paths.push(path)
  }

  const { error } = await supabase.rpc('submit_feedback', {
    p_id: id,
    p_category: input.category,
    p_message: input.message,
    p_branch: input.branch,
    p_page_path: input.pagePath,
    p_context: input.context,
    p_photo_paths: paths,
    p_anonymous: input.anonymous,
  })
  if (error) {
    await removePhotos(paths)
    return { ok: false, reason: error.message }
  }
  return { ok: true, id }
}

async function removePhotos(paths: string[]) {
  if (paths.length === 0) return
  const { error } = await supabase.storage.from(BUCKET).remove(paths)
  if (error) console.error(`[feedback] orphaned photos not removed: ${paths.join(', ')}`, error.message)
}

export async function replyFeedback(
  id: string,
  status: FeedbackStatus,
  reply: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { error } = await supabase.rpc('reply_feedback', { p_id: id, p_status: status, p_reply: reply })
  return error ? { ok: false, reason: error.message } : { ok: true }
}

export async function listMyFeedback(staffId: string): Promise<FeedbackRow[]> {
  const { data, error } = await supabase
    .from('feedback')
    .select('*')
    .eq('submitted_by', staffId)
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return ((data ?? []) as FeedbackRow[]).map(f => ({ ...f, submitter: null }))
}

/** RLS 只让 owner 读到全部,这里不再加过滤。 */
export async function listInbox(): Promise<FeedbackRow[]> {
  const { data, error } = await supabase
    .from('feedback')
    .select('*, submitter:staff!feedback_submitted_by_fkey(name)')
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) throw new Error(error.message)
  return (data ?? []) as FeedbackRow[]
}

export async function countNewFeedback(): Promise<number> {
  const { count, error } = await supabase
    .from('feedback')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'new')
  return error ? 0 : count ?? 0
}

/** 私有 bucket:一小时有效的签名链接。 */
export async function photoUrls(paths: string[]): Promise<string[]> {
  if (paths.length === 0) return []
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600)
  if (error || !data) return []
  return data.map(d => d.signedUrl).filter((u): u is string => !!u)
}
