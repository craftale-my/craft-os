import { useState } from 'react'
import { X } from 'lucide-react'
import { normalizeTagName } from '../../shared/lib/tasks'
import type { Tag } from './types'

export function TagInput({ value, allTags, onAdd, onRemove }: {
  value: Tag[]
  allTags: Tag[]
  onAdd: (raw: string) => void
  onRemove: (tagId: string) => void
}) {
  const [draft, setDraft] = useState('')

  const norm = normalizeTagName(draft)
  const chosen = new Set(value.map(t => t.id))
  // 已经挂在这个任务上的不再建议;比对 slug 而非显示名,
  // 这样打 "Urg" 也能命中 name 是 "URGENT" 的那一笔。
  const suggestions = norm
    ? allTags.filter(t => !chosen.has(t.id) && t.slug.includes(norm.slug)).slice(0, 6)
    : []

  function commit(raw: string) {
    if (!normalizeTagName(raw)) return
    onAdd(raw)
    setDraft('')
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {value.map(t => (
          <span
            key={t.id}
            className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full"
            style={{ color: t.color, background: `${t.color}1A` }}
          >
            {t.name}
            <button
              type="button"
              onClick={() => onRemove(t.id)}
              aria-label={`Remove ${t.name}`}
              className="hover:opacity-70"
            >
              <X size={11} />
            </button>
          </span>
        ))}
        {value.length === 0 && <span className="text-xs text-[#A09080]">No tags</span>}
      </div>

      <div className="relative">
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            commit(draft)
          }}
          placeholder="Add a tag…"
          className="w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-[#3D2B1F] focus:outline-none focus:ring-2 focus:ring-[#C4813A40]"
        />
        {suggestions.length > 0 && (
          <ul className="absolute z-10 left-0 right-0 mt-1 bg-white border border-[#D4C5B0] rounded-lg shadow-lg overflow-hidden">
            {suggestions.map(t => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => commit(t.name)}
                  className="w-full text-left px-3 py-1.5 text-sm text-[#3D2B1F] hover:bg-[#F5EDE0]"
                >
                  {t.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
