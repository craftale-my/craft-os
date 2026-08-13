import { useState, useEffect, useCallback } from 'react'
import { Avatar } from '../../shared/components/Avatar'
import { fetchComments, postComment } from './api'
import type { TaskComment } from './types'

/**
 * 一条任务的评论串。自己管自己的读取与张贴,
 * `onPosted` 只是让外层的评论计数跟着重整。
 */
export function CommentThread({
  taskId, currentStaffId, onPosted,
}: {
  taskId: string
  currentStaffId: string
  onPosted?: () => void
}) {
  const [comments, setComments] = useState<TaskComment[]>([])
  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setComments(await fetchComments(taskId))
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load comments.')
    }
  }, [taskId])

  useEffect(() => { load() }, [load])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const body = draft.trim()
    if (!body) return
    setPosting(true)
    const res = await postComment(taskId, currentStaffId, body)
    setPosting(false)
    // 写入没落地就把草稿留着,不要让使用者以为已经送出。
    if (!res.ok) { setError(`Could not post the comment — ${res.reason}`); return }
    setDraft('')
    setError('')
    await load()
    onPosted?.()
  }

  return (
    <div>
      <p className="text-xs font-semibold text-[#8B7355] mb-3">
        Comments ({comments.length})
      </p>
      {error && (
        <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-3">{error}</p>
      )}
      {comments.length > 0 && (
        <div className="space-y-3 mb-4">
          {comments.map(c => (
            <div key={c.id} className="flex gap-2.5">
              <Avatar name={c.staff?.name ?? '?'} avatar={c.staff?.avatar ?? null} size="sm" />
              <div className="flex-1 bg-[#FAF6F1] rounded-xl px-3 py-2.5">
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-xs font-semibold text-[#3D2B1F]">
                    {c.staff?.name ?? 'Unknown'}
                  </span>
                  <span className="text-xs text-[#A09080]">
                    {new Date(c.created_at).toLocaleDateString('en-MY', {
                      day: 'numeric', month: 'short',
                    })}
                  </span>
                </div>
                <p className="text-sm text-[#3D2B1F] leading-relaxed">{c.comment}</p>
              </div>
            </div>
          ))}
        </div>
      )}
      {comments.length === 0 && (
        <p className="text-xs text-[#A09080] mb-4">No comments yet. Be the first!</p>
      )}
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="Add a comment..."
          className="flex-1 px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-[#3D2B1F] focus:outline-none focus:ring-2 focus:ring-[#C4813A40]"
        />
        <button
          type="submit"
          disabled={posting || !draft.trim()}
          className="px-4 py-2 rounded-lg bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors disabled:opacity-50"
        >
          {posting ? '...' : 'Post'}
        </button>
      </form>
    </div>
  )
}
