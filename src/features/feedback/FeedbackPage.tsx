import { useEffect, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { listInbox, listMyFeedback } from './api'
import { CATEGORIES, CATEGORY_LABELS, STATUS_LABELS } from './types'
import type { FeedbackCategory, FeedbackRow, FeedbackStatus } from './types'
import { FeedbackDetail, formatWhen } from './FeedbackDetail'
import { openFeedback, useFeedbackSent } from './feedbackBus'

type StatusFilter = 'open' | 'all' | FeedbackStatus

export default function FeedbackPage() {
  const { staff } = useAuth()
  const owner = staff?.system_role === 'owner'
  const [params, setParams] = useSearchParams()
  const { key: navKey } = useLocation()
  // Owner opens the Inbox unless ?tab=mine; everyone else always gets My Feedback.
  const tab: 'mine' | 'inbox' = owner && params.get('tab') !== 'mine' ? 'inbox' : 'mine'
  const selectedId = params.get('id')

  const [loaded, setLoaded] = useState<{ tab: 'mine' | 'inbox'; key: string; rows: FeedbackRow[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open')
  const [categoryFilter, setCategoryFilter] = useState<'all' | FeedbackCategory>('all')

  const staffId = staff?.id
  // Identifies one fetch; rows stored with an older key are stale while a newer fetch is in flight.
  const fetchKey = `${staffId}|${tab}|${reloadKey}|${navKey}`

  useFeedbackSent(() => setReloadKey(k => k + 1))

  useEffect(() => {
    if (!staffId) return
    let live = true
    setError(null)
    const load = tab === 'inbox' ? listInbox() : listMyFeedback(staffId)
    load.then(
      rows => { if (live) setLoaded({ tab, key: fetchKey, rows }) },
      (e: Error) => { if (live) setError(e.message) },
    )
    return () => { live = false }
  }, [staffId, tab, reloadKey, navKey, fetchKey])

  // Rows only count when they belong to the current tab; a same-tab reload keeps them (stale-while-revalidate).
  const items = loaded && loaded.tab === tab ? loaded.rows : null
  // True while the rows we hold predate the latest fetch (a failed fetch is reported through `error` instead).
  const refetching = !error && loaded !== null && loaded.key !== fetchKey

  function go(next: { tab?: 'mine' | 'inbox'; id?: string | null }) {
    const p = new URLSearchParams()
    const t = next.tab ?? tab
    if (owner) p.set('tab', t)
    const id = next.id === undefined ? selectedId : next.id
    if (id) p.set('id', id)
    setParams(p)
  }

  const selected = selectedId ? items?.find(f => f.id === selectedId) ?? null : null

  const visible = (items ?? []).filter(f => {
    if (tab !== 'inbox') return true
    if (statusFilter === 'open' && f.status === 'resolved') return false
    if (statusFilter !== 'open' && statusFilter !== 'all' && f.status !== statusFilter) return false
    if (categoryFilter !== 'all' && f.category !== categoryFilter) return false
    return true
  })

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-display font-bold text-brown-dark">Feedback</h1>
        <button
          onClick={() => openFeedback()}
          className="text-sm bg-brown-btn hover:bg-brown-btn-hover text-white px-3 py-2 rounded-lg transition-colors"
        >
          New feedback
        </button>
      </div>

      {owner && (
        <div className="flex gap-2 mb-4">
          {(['mine', 'inbox'] as const).map(t => (
            <button
              key={t}
              onClick={() => go({ tab: t, id: null })}
              aria-pressed={tab === t}
              className={`text-sm px-3 py-1.5 rounded-full ${tab === t ? 'bg-[#4A2E1A] text-[#F5F0E8]' : 'bg-white text-brown-dark'}`}
            >
              {t === 'mine' ? 'My Feedback' : 'Inbox'}
            </button>
          ))}
        </div>
      )}

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {!error && items === null && <p className="text-sm text-brown-muted">Loading…</p>}

      {items && selected && (
        <FeedbackDetail
          key={selected.id}
          item={selected}
          ownerView={tab === 'inbox'}
          onBack={() => go({ id: null })}
          onSaved={() => { setReloadKey(k => k + 1); go({ id: null }) }}
        />
      )}

      {items && selectedId && !selected && (
        <p className="text-sm text-brown-muted">{refetching ? 'Loading…' : "This feedback isn't available."}</p>
      )}

      {items && !selectedId && (
        <>
          {tab === 'inbox' && (
            <div className="flex gap-2 mb-3">
              <select
                aria-label="Filter by status"
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value as StatusFilter)}
                className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
              >
                <option value="open">Open</option>
                <option value="all">All</option>
                {(Object.keys(STATUS_LABELS) as FeedbackStatus[]).map(s => (
                  <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                ))}
              </select>
              <select
                aria-label="Filter by category"
                value={categoryFilter}
                onChange={e => setCategoryFilter(e.target.value as 'all' | FeedbackCategory)}
                className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
              >
                <option value="all">All categories</option>
                {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
          )}

          {visible.length === 0 ? (
            <p className="text-sm text-brown-muted">
              {tab === 'inbox' ? 'Nothing here.' : 'No feedback yet. Tap Feedback to send one.'}
            </p>
          ) : (
            <ul className="space-y-2">
              {visible.map(f => (
                <li key={f.id}>
                  <button
                    onClick={() => go({ id: f.id })}
                    className="w-full text-left bg-white rounded-xl p-3 shadow-sm hover:shadow transition-shadow"
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-xs font-semibold text-brown-dark">{CATEGORY_LABELS[f.category]}</span>
                      <span className="text-xs rounded-full bg-[#F5F0E8] px-2 py-0.5 text-brown-dark">{STATUS_LABELS[f.status]}</span>
                    </div>
                    <p className="text-sm text-brown-dark line-clamp-2">{f.message}</p>
                    <p className="text-xs text-brown-muted mt-1">
                      {tab === 'inbox' && <><span>{f.is_anonymous ? 'Anonymous' : f.submitter?.name ?? 'Unknown'}</span> · </>}
                      {formatWhen(f.created_at)}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
