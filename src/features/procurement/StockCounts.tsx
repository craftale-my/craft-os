import { useState, useEffect, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { useCan } from '../../shared/lib/permissions'
import { money } from '../../shared/lib/procurement'
import { useBranchPicker } from './useBranchPicker'
import type { StockCount, StockCountKind } from '../../shared/types'
import { STOCK_COUNT_KIND_LABELS } from '../../shared/types'

const selectCls =
  'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-MY', {
    timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

type CountRow = StockCount & { starter: { name: string } | null; entries: { count: number }[] }

export default function StockCountsPage() {
  const navigate = useNavigate()
  const { can } = useCan()
  const { branches, branchId, setBranchId, allBranches, loaded, error: branchError, staffHasNoBranch } = useBranchPicker()
  const [counts, setCounts] = useState<CountRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [starting, setStarting] = useState<StockCountKind | null>(null)

  const load = useCallback(async () => {
    if (!branchId) return
    setLoading(true)
    const { data, error: err } = await supabase
      .from('stock_counts')
      .select('*, starter:staff!stock_counts_started_by_fkey(name), entries:stock_count_entries(count)')
      .eq('branch_id', branchId)
      .neq('status', 'cancelled')
      .order('started_at', { ascending: false })
      .limit(30)
    if (err) setError(err.message)
    setCounts((data as CountRow[]) ?? [])
    setLoading(false)
  }, [branchId])

  useEffect(() => { load() }, [load])

  async function start(kind: StockCountKind) {
    setStarting(kind)
    setError('')
    const { data, error: err } = await supabase.rpc('start_stock_count', { p_branch_id: branchId, p_kind: kind })
    setStarting(null)
    if (err) {
      const open = /\(([0-9a-f-]{36})\)/.exec(err.message)?.[1]
      if (open) { navigate(`/procurement/stock-counts/${open}`); return }
      setError(err.message)
      return
    }
    navigate(`/procurement/stock-counts/${(data as StockCount).id}`)
  }

  const open = counts.find(c => c.status === 'in_progress')
  const history = counts.filter(c => c.status === 'submitted')

  return (
    <div className="min-h-screen bg-cream-light px-4 py-6">
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-brown-dark">Stock Count</h1>
            <p className="text-xs text-brown-faint mt-0.5">Count what is on the shelf. Submitting sets stock on hand to your numbers.</p>
          </div>
          {can('manage_procurement') && (
            <Link to="/procurement/stock-counts/setup" className="text-xs font-semibold text-[#C4813A] whitespace-nowrap">
              Locations & key items
            </Link>
          )}
        </div>

        {allBranches && branches.length > 1 && (
          <select className={selectCls} value={branchId} onChange={e => setBranchId(e.target.value)} aria-label="Branch">
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}

        {(branchError || error) && <p className="text-sm text-red-700">{branchError || error}</p>}
        {loaded && staffHasNoBranch && (
          <p className="text-sm text-brown-muted">Your staff record has no branch. Ask a manager to set it.</p>
        )}

        {open ? (
          <Link
            to={`/procurement/stock-counts/${open.id}`}
            className="block bg-white rounded-xl border-2 border-[#C4813A] p-4"
          >
            <p className="text-xs font-semibold text-[#C4813A] uppercase tracking-wide">In progress</p>
            <p className="text-base font-bold text-brown-dark mt-1">{STOCK_COUNT_KIND_LABELS[open.kind]} count</p>
            <p className="text-xs text-brown-faint mt-0.5">
              Started {when(open.started_at)}{open.starter ? ` by ${open.starter.name}` : ''} · {open.entries[0]?.count ?? 0} entries saved
            </p>
            <p className="text-sm font-semibold text-brown-btn mt-3">Resume counting →</p>
          </Link>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {(['weekly', 'full'] as const).map(kind => (
              <button
                key={kind}
                type="button"
                disabled={!branchId || starting !== null}
                onClick={() => start(kind)}
                className="bg-white rounded-xl border border-[#E8DDD0] p-4 text-left active:bg-[#F5EDE0] disabled:opacity-50"
              >
                <p className="text-base font-bold text-brown-dark">
                  {starting === kind ? 'Starting…' : `Start ${kind} count`}
                </p>
                <p className="text-xs text-brown-faint mt-1">
                  {kind === 'weekly' ? 'Key items only' : 'Every item at this branch'}
                </p>
              </button>
            ))}
          </div>
        )}

        <section>
          <h2 className="text-sm font-bold text-brown-dark mb-2">History</h2>
          {loading ? (
            <p className="text-sm text-brown-faint">Loading…</p>
          ) : history.length === 0 ? (
            <p className="text-sm text-brown-faint">No counts submitted yet.</p>
          ) : (
            <ul className="space-y-2">
              {history.map(c => {
                const net = Number(c.net_value ?? 0)
                return (
                  <li key={c.id}>
                    <Link
                      to={`/procurement/stock-counts/${c.id}`}
                      className="flex items-center justify-between gap-3 bg-white rounded-xl border border-[#E8DDD0] px-4 py-3"
                    >
                      <div>
                        <p className="text-sm font-semibold text-brown-dark">
                          {STOCK_COUNT_KIND_LABELS[c.kind]} · {c.item_count ?? 0} items
                        </p>
                        <p className="text-xs text-brown-faint">
                          {c.submitted_at ? when(c.submitted_at) : ''}{c.starter ? ` · ${c.starter.name}` : ''}
                        </p>
                      </div>
                      <span className={`text-sm font-bold ${net < 0 ? 'text-red-700' : net > 0 ? 'text-green-700' : 'text-brown-muted'}`}>
                        {net < 0 ? '−' : net > 0 ? '+' : ''}{money(Math.abs(net))}
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
