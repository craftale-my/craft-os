import { useEffect, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { photoUrls, replyFeedback } from './api'
import { CATEGORY_LABELS, STATUS_LABELS } from './types'
import type { FeedbackRow, FeedbackStatus } from './types'

export const formatWhen = (iso: string) =>
  new Date(iso).toLocaleString('en-MY', { dateStyle: 'medium', timeStyle: 'short' })

export function FeedbackDetail({ item, ownerView, onBack, onSaved }: {
  item: FeedbackRow
  ownerView: boolean
  onBack: () => void
  onSaved: () => void
}) {
  const [urls, setUrls] = useState<string[]>([])
  const [status, setStatus] = useState<FeedbackStatus>(item.status)
  const [reply, setReply] = useState(item.owner_reply ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    photoUrls(item.photo_paths).then(u => { if (live) setUrls(u) })
    return () => { live = false }
  }, [item.photo_paths])

  async function save() {
    setSaving(true)
    setError(null)
    const res = await replyFeedback(item.id, status, reply)
    setSaving(false)
    if (res.ok) onSaved()
    else setError(res.reason)
  }

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-brown-muted hover:text-brown-dark">
        <ArrowLeft size={16} /> Back
      </button>

      <div className="bg-white rounded-2xl p-4 shadow-sm space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-brown-dark">{CATEGORY_LABELS[item.category]}</span>
          <span className="text-xs rounded-full bg-[#F5F0E8] px-2 py-0.5 text-brown-dark">{STATUS_LABELS[item.status]}</span>
        </div>
        <p className="text-sm text-brown-dark whitespace-pre-wrap">{item.message}</p>

        {urls.length > 0 && (
          <div className="flex gap-2 flex-wrap">
            {urls.map((u, i) => (
              <a key={u} href={u} target="_blank" rel="noreferrer">
                <img src={u} alt={`Photo ${i + 1}`} className="w-20 h-20 rounded-lg object-cover" />
              </a>
            ))}
          </div>
        )}

        <dl className="text-xs text-brown-muted grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {ownerView && (<><dt>From</dt><dd>{item.is_anonymous ? 'Anonymous' : item.submitter?.name ?? 'Unknown'}</dd></>)}
          <dt>Sent</dt><dd>{formatWhen(item.created_at)}</dd>
          {item.branch && (<><dt>Branch</dt><dd>{item.branch}</dd></>)}
          {ownerView && item.page_path && (<><dt>Page</dt><dd>{item.page_path}</dd></>)}
          {ownerView && item.context.errorMessage && (<><dt>Error</dt><dd className="break-words">{item.context.errorMessage}</dd></>)}
          {ownerView && item.context.appVersion && (<><dt>Version</dt><dd>{item.context.appVersion}</dd></>)}
          {ownerView && item.context.userAgent && (<><dt>Device</dt><dd className="break-words">{item.context.userAgent}</dd></>)}
        </dl>
      </div>

      {!ownerView && item.owner_reply && (
        <div className="bg-white rounded-2xl p-4 shadow-sm">
          <p className="text-xs font-semibold text-brown-muted mb-1">Owner's reply</p>
          <p className="text-sm text-brown-dark whitespace-pre-wrap">{item.owner_reply}</p>
        </div>
      )}

      {ownerView && (
        <div className="bg-white rounded-2xl p-4 shadow-sm space-y-3">
          <div>
            <label htmlFor="feedback-status" className="block text-sm font-medium text-brown-dark mb-1">Status</label>
            <select
              id="feedback-status"
              value={status}
              onChange={e => setStatus(e.target.value as FeedbackStatus)}
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm"
            >
              {(Object.keys(STATUS_LABELS) as FeedbackStatus[]).map(s => (
                <option key={s} value={s}>{STATUS_LABELS[s]}</option>
              ))}
            </select>
          </div>
          {item.is_anonymous ? (
            <p className="text-xs text-brown-muted">Anonymous feedback — the sender won't see a reply.</p>
          ) : (
            <div>
              <label htmlFor="feedback-reply" className="block text-sm font-medium text-brown-dark mb-1">Reply</label>
              <textarea
                id="feedback-reply"
                value={reply}
                onChange={e => setReply(e.target.value)}
                rows={4}
                maxLength={2000}
                className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm"
              />
            </div>
          )}
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end">
            <button
              onClick={save}
              disabled={saving}
              className="text-sm bg-brown-btn hover:bg-brown-btn-hover text-white px-4 py-2 rounded-lg transition-colors disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
