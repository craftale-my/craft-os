import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { X } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import { BRANCHES } from '../../shared/types'
import { submitFeedback, feedbackContext } from './api'
import { CATEGORIES, MAX_MESSAGE, MAX_PHOTOS, ACCEPTED_PHOTO_TYPES } from './types'
import type { FeedbackCategory } from './types'
import { validateFeedbackDraft, isAcceptablePhoto } from './validate'
import type { FeedbackPrefill } from './feedbackBus'

export function FeedbackSheet({ prefill, onClose, onSent }: {
  prefill: FeedbackPrefill
  onClose: () => void
  onSent: () => void
}) {
  const { staff } = useAuth()
  const { pathname } = useLocation()

  const [category, setCategory] = useState<FeedbackCategory | null>(prefill.category ?? null)
  const [message, setMessage] = useState('')
  const [photos, setPhotos] = useState<File[]>([])
  const [branch, setBranch] = useState(staff?.branch ?? '')
  const [anonymous, setAnonymous] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 员工资料里的分店不在清单里时也要能选到
  const branchOptions = staff?.branch && !BRANCHES.includes(staff.branch) ? [staff.branch, ...BRANCHES] : BRANCHES

  const previews = useMemo(() => photos.map(f => URL.createObjectURL(f)), [photos])
  useEffect(() => () => previews.forEach(u => URL.revokeObjectURL(u)), [previews])

  function pickCategory(c: FeedbackCategory) {
    setCategory(c)
    if (c !== 'workplace') setAnonymous(false)
  }

  function toggleAnonymous(on: boolean) {
    setAnonymous(on)
    if (on) setPhotos([])
  }

  function addPhotos(files: FileList | null) {
    if (!files) return
    const picked = Array.from(files)
    const good = picked.filter(isAcceptablePhoto)
    const next = [...photos, ...good]
    if (good.length < picked.length) setError('Photos must be images under 5 MB.')
    else if (next.length > MAX_PHOTOS) setError(`Add up to ${MAX_PHOTOS} photos.`)
    else setError(null)
    setPhotos(next.slice(0, MAX_PHOTOS))
  }

  async function send() {
    const errors = validateFeedbackDraft({ category, message, photos, anonymous })
    if (errors.length > 0 || !category) { setError(errors[0] ?? 'Choose a category.'); return }
    setSubmitting(true)
    setError(null)
    const res = await submitFeedback({
      category,
      message: message.trim(),
      branch: branch || null,
      anonymous,
      photos,
      pagePath: pathname,
      context: feedbackContext(prefill.errorMessage),
    })
    setSubmitting(false)
    if (res.ok) onSent()
    else setError(res.reason)
  }

  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Send feedback"
        className="bg-white w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl max-h-[90vh] overflow-y-auto p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-brown-dark">Send feedback</h2>
          <button onClick={onClose} aria-label="Close" className="text-brown-muted hover:text-brown-dark p-1">
            <X size={20} />
          </button>
        </div>

        <p className="text-sm font-medium text-brown-dark mb-2">Category</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
          {CATEGORIES.map(c => (
            <button
              key={c.value}
              type="button"
              aria-pressed={category === c.value}
              onClick={() => pickCategory(c.value)}
              className={`text-left rounded-xl border px-3 py-2.5 transition-colors ${
                category === c.value ? 'border-[#8B6344] bg-[#F5F0E8]' : 'border-gray-200 hover:border-[#D4C4B0]'
              }`}
            >
              <span className="block text-sm font-semibold text-brown-dark">{c.label}</span>
              <span className="block text-xs text-brown-muted mt-0.5">{c.hint}</span>
            </button>
          ))}
        </div>

        <label className="block text-sm font-medium text-brown-dark mb-1" htmlFor="feedback-message">Message</label>
        <textarea
          id="feedback-message"
          value={message}
          onChange={e => setMessage(e.target.value)}
          rows={5}
          maxLength={MAX_MESSAGE}
          placeholder="What happened? Be as specific as you can."
          className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:border-[#8B6344]"
        />
        <p className="text-xs text-brown-muted text-right mb-3">{message.length}/{MAX_MESSAGE}</p>

        {anonymous ? (
          <p className="text-xs text-brown-muted mb-3">Photos can't be attached to anonymous feedback.</p>
        ) : (
          <div className="mb-3">
            <p className="text-sm font-medium text-brown-dark mb-1">Photos (optional)</p>
            <div className="flex gap-2 flex-wrap">
              {previews.map((url, i) => (
                <div key={url} className="relative">
                  <img src={url} alt={`Photo ${i + 1}`} className="w-16 h-16 rounded-lg object-cover" />
                  <button
                    type="button"
                    aria-label={`Remove photo ${i + 1}`}
                    onClick={() => setPhotos(photos.filter((_, j) => j !== i))}
                    className="absolute -top-1.5 -right-1.5 bg-[#3D2410] text-white rounded-full w-5 h-5 flex items-center justify-center"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              {photos.length < MAX_PHOTOS && (
                <label className="w-16 h-16 rounded-lg border border-dashed border-[#D4C4B0] flex items-center justify-center text-xs text-brown-muted cursor-pointer">
                  + Add
                  <input
                    type="file"
                    accept={ACCEPTED_PHOTO_TYPES.join(',')}
                    multiple
                    aria-label="Add photos"
                    className="sr-only"
                    onChange={e => { addPhotos(e.target.files); e.target.value = '' }}
                  />
                </label>
              )}
            </div>
          </div>
        )}

        <label className="block text-sm font-medium text-brown-dark mb-1" htmlFor="feedback-branch">Branch</label>
        <select
          id="feedback-branch"
          value={branch}
          onChange={e => setBranch(e.target.value)}
          className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm mb-3"
        >
          <option value="">No specific branch</option>
          {branchOptions.map(b => <option key={b} value={b}>{b}</option>)}
        </select>

        {category === 'workplace' && (
          <div className="mb-3">
            <label className="flex items-center gap-2 text-sm text-brown-dark">
              <input type="checkbox" checked={anonymous} onChange={e => toggleAnonymous(e.target.checked)} />
              Submit anonymously
            </label>
            {anonymous && (
              <p className="text-xs text-brown-muted mt-1">You won't see this in My Feedback or get a reply.</p>
            )}
          </div>
        )}

        {error && <p role="alert" className="text-sm text-red-600 mb-3">{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="text-sm px-4 py-2 rounded-lg text-brown-muted hover:bg-gray-100">
            Cancel
          </button>
          <button
            type="button"
            onClick={send}
            disabled={submitting}
            className="text-sm bg-brown-btn hover:bg-brown-btn-hover text-white px-4 py-2 rounded-lg transition-colors disabled:opacity-60"
          >
            {submitting ? 'Sending…' : 'Send feedback'}
          </button>
        </div>
      </div>
    </div>
  )
}
