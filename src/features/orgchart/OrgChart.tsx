import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import { Card, PageHeader } from '../../shared/components/ui'
import { RANK_LABELS } from '../../shared/types'
import { shortenBranch } from '../../shared/lib/branches'
import { buildOrgTree, chainOf, initialExpanded, scrollLeftToCenter, searchPeople, type OrgPerson } from './orgTree'
import { fetchOrgChart } from './api'
import { ReportingLine } from './ReportingLine'
import { UnassignedPanel } from './UnassignedPanel'
import { OrgTreeView, type TreeCtx } from './OrgTreeView'

export default function OrgChartPage() {
  const { staff } = useAuth()
  const navigate = useNavigate()
  const canAssign = staff?.rank === 'manager'
  const meId = staff?.id ?? null

  const [rows, setRows] = useState<OrgPerson[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const initialised = useRef(false)

  const load = useCallback(async () => {
    try {
      setRows(await fetchOrgChart())
      setLoadError('')
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'unknown error')
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const tree = useMemo(() => (rows ? buildOrgTree(rows) : null), [rows])
  const me = (tree && meId && tree.byId.get(meId)) || null
  const chain = useMemo(() => (tree && meId ? chainOf(tree, meId) : []), [tree, meId])

  // First load only: owner + two levels, plus the viewer's own line so their
  // card is on screen. Later reloads (after an assignment) keep what the user opened.
  useEffect(() => {
    if (!tree || initialised.current) return
    initialised.current = true
    const open = initialExpanded(tree, 2)
    for (const p of chain) open.add(p.id)
    setExpanded(open)
  }, [tree, chain])

  // Once the first expansion has rendered, scroll the tree sideways so the
  // owner is in view. A wide tree centres the owner far to the right, and the
  // page used to open on an empty stretch of connector lines.
  const treeBox = useRef<HTMLDivElement>(null)
  const centred = useRef(false)
  useEffect(() => {
    if (!tree || centred.current || expanded.size === 0 || tree.roots.length === 0) return
    const box = treeBox.current
    const card = document.getElementById(`org-node-${tree.roots[0].id}`)
    if (!box || !card) return
    centred.current = true
    const b = box.getBoundingClientRect()
    const c = card.getBoundingClientRect()
    box.scrollLeft = scrollLeftToCenter(
      { left: b.left, scrollLeft: box.scrollLeft, clientWidth: box.clientWidth },
      { left: c.left, width: c.width },
    )
  }, [tree, expanded])

  useEffect(() => {
    if (!highlightId) return
    document.getElementById(`org-node-${highlightId}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'center', inline: 'center' })
    const t = setTimeout(() => setHighlightId(null), 3000)
    return () => clearTimeout(t)
  }, [highlightId])

  function toggle(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function reveal(id: string) {
    if (!tree) return
    setExpanded(prev => {
      const next = new Set(prev)
      for (const p of chainOf(tree, id)) next.add(p.id)
      return next
    })
    setQuery('')
    setHighlightId(id)
  }

  const matches = tree ? searchPeople(tree, query) : []
  const ctx: TreeCtx | null = tree && {
    tree,
    expanded,
    onToggle: toggle,
    meId,
    chainIds: new Set(chain.map(p => p.id)),
    highlightId,
    onOpen: canAssign ? (id: string) => navigate(`/staff/${id}`) : undefined,
  }
  const detachedTops = tree ? tree.unassigned.map(u => u.person) : []

  return (
    <div className="min-h-screen bg-[#F5F0E8]">
      <div className="max-w-6xl mx-auto px-4 py-6 lg:px-8">
        <PageHeader title="Org Chart" subtitle="Who reports to whom, from the owner down." />

        {loadError && (
          <Card className="mb-4">
            <p role="alert" className="text-sm text-bad">Couldn't load the org chart: {loadError}</p>
          </Card>
        )}

        {!tree || !ctx ? (
          !loadError && <p className="text-[#8B7355] animate-pulse">Loading org chart...</p>
        ) : (
          <>
            <ReportingLine me={me} chain={chain} />
            {canAssign && <UnassignedPanel tree={tree} onAssigned={load} />}

            <div className="relative mb-4 max-w-sm">
              <Search size={16} className="absolute left-3 top-2.5 text-brown-muted" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Find a person…"
                aria-label="Find a person"
                className="w-full rounded-xl border border-border-mid bg-white py-2 pl-9 pr-3 text-sm text-brown-dark"
              />
              {matches.length > 0 && (
                <ul className="absolute z-10 mt-1 w-full rounded-xl bg-white py-1 shadow-card">
                  {matches.map(p => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => reveal(p.id)}
                        className="w-full px-3 py-2 text-left text-sm text-brown-dark hover:bg-cream"
                      >
                        {p.name} <span className="text-brown-muted">· {RANK_LABELS[p.rank]} · {shortenBranch(p.branch)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {query.trim() && matches.length === 0 && (
                <p className="mt-1 text-xs text-brown-muted">No one matches “{query.trim()}”.</p>
              )}
            </div>

            {tree.roots.length === 0 && (
              <Card className="mb-4">
                <p className="text-sm text-brown-dark">
                  No owner is set yet. Give someone the Owner role in Settings so the chart has a top.
                </p>
              </Card>
            )}

            <div ref={treeBox} className="overflow-x-auto pb-4 -mx-4 px-4">
              <OrgTreeView roots={tree.roots} ctx={ctx} />
            </div>

            {detachedTops.length > 0 && (
              <section className="mt-8">
                <h2 className="mb-3 text-sm font-semibold text-brown-muted">Not connected to the owner yet</h2>
                <div className="overflow-x-auto pb-4 -mx-4 px-4">
                  <OrgTreeView roots={detachedTops} ctx={ctx} />
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
