// src/features/pos/menu/GroupListPage.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchLookups, type LookupGroup } from './menuEditorApi'
import MenuTabs from './MenuTabs'
import { OutcomeLine, btnCls, errorText } from './editorUi'

/** /menu/groups — every add-on group, switched-off ones last. */
export default function GroupListPage() {
  const [groups, setGroups] = useState<LookupGroup[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const loadSeq = useRef(0)                                               // an older reply never lands last
  const load = useCallback(() => {
    const seq = ++loadSeq.current
    fetchLookups().then(
      (l) => { if (seq === loadSeq.current) { setGroups(l.groups); setLoadError(null) } },
      (e) => { if (seq === loadSeq.current) setLoadError(errorText(e)) },
    )
  }, [])
  useEffect(() => { load() }, [load])

  const sorted = [...(groups ?? [])].sort((a, b) => Number(b.isActive) - Number(a.isActive))
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <MenuTabs />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Add-on groups</h1>
          <p className="text-sm text-brown-muted">Choices offered with a product (milk, sugar level, extra shot…), with a price per catalog.</p>
        </div>
        <Link to="/menu/groups/new" className={btnCls}>New add-on group</Link>
      </div>
      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" onClick={load}>Try again</button>
        </div>
      )}
      {groups === null && !loadError && <p className="text-sm">Loading…</p>}
      {groups?.length === 0 && <p className="rounded border border-border p-6 text-sm">No add-on groups yet.</p>}
      {sorted.length > 0 && (
        <table className="w-full rounded border border-border bg-card text-sm">
          <thead className="text-left text-brown-muted">
            <tr><th className="px-4 py-2">Group</th><th className="px-4 py-2">Choose</th><th className="px-4 py-2">Options on</th><th className="px-4 py-2">Used by</th></tr>
          </thead>
          <tbody>
            {sorted.map((g) => (
              <tr key={g.id} className={`border-t border-border ${g.isActive ? '' : 'text-brown-faint'}`}>
                <td className="px-4 py-2"><Link to={`/menu/groups/${g.id}`} className="hover:underline">{g.name}</Link>{g.isActive ? '' : ' (off)'}</td>
                <td className="px-4 py-2">{g.min}–{g.max}</td>
                <td className="px-4 py-2">{g.optionCount}</td>
                <td className="px-4 py-2">{g.productCount} product{g.productCount === 1 ? '' : 's'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
