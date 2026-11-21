import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from '../auth/AuthContext'
import {
  itemsForCount, groupForCounting, groupProgress, entryKey, packsLooseToBase, baseToPacksLoose, uncountedSpots, countSpotTotal,
  strayEntries,
} from '../../shared/lib/stocktake'
import { qty } from '../../shared/lib/procurement'
import type { Item, StorageLocation, ItemLocation, StockCount, StockCountEntry, Branch } from '../../shared/types'
import { STOCK_COUNT_KIND_LABELS } from '../../shared/types'
import StockCountResult from './StockCountResult'

/** Tab key of the "Other entries" group (cannot clash with a location uuid or 'unassigned'). */
const OTHER = 'other'

const numCls =
  'w-20 h-11 px-2 rounded-xl border border-[#E8DDD0] bg-[#FDFAF6] text-center text-base font-bold text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

function parse(v: string): number | null {
  if (v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : NaN
}

/** One item at one location: packs + loose, saved on blur. Never shows system stock. */
function CountRow({ item, locationId, place, saved, onSave }: {
  item: Item
  locationId: string | null
  /** Where this entry was saved — shown on "Other entries" rows. */
  place?: string
  saved: number | undefined
  onSave: (itemId: string, locationId: string | null, base: number | null) => Promise<void>
}) {
  const rate = Number(item.conversion_rate)
  const single = rate === 1
  const start = saved == null ? null : baseToPacksLoose(saved, rate)
  const [packsText, setPacksText] = useState(start ? String(start.packs) : '')
  const [looseText, setLooseText] = useState(start && start.loose ? String(start.loose) : '')
  const [state, setState] = useState<'idle' | 'error'>('idle')
  const [pending, setPending] = useState(0)
  // Latest text and last successfully saved base live in refs so queued saves never read stale closures.
  const packsRef = useRef(packsText)
  const looseRef = useRef(looseText)
  const lastSaved = useRef<number | null>(saved ?? null)
  const chain = useRef<Promise<void>>(Promise.resolve())

  async function run() {
    const p = parse(packsRef.current)
    const l = single ? null : parse(looseRef.current)
    if (Number.isNaN(p) || Number.isNaN(l)) { setState('error'); return }
    const base = packsLooseToBase(p, l, rate)
    if (base === lastSaved.current) { setState('idle'); return }
    try {
      await onSave(item.id, locationId, base)
      lastSaved.current = base
      setState('idle')
    } catch {
      setState('error')
    }
  }

  /** Saves on one row run strictly one after another, each from the current text. */
  function commit() {
    setPending(n => n + 1)
    chain.current = chain.current.then(run).finally(() => setPending(n => n - 1))
  }

  return (
    <div className={`bg-white rounded-xl border px-4 py-3 ${saved != null ? 'border-[#B9D7B0]' : 'border-[#E8DDD0]'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-brown-dark">{item.name}</p>
          <p className="text-xs text-brown-faint">
            {place && <span className="font-semibold text-brown-muted">{place} · </span>}
            {single ? item.base_unit : `1 ${item.purchase_unit} = ${qty(rate)} ${item.base_unit}`}
          </p>
        </div>
        <span className="text-xs font-semibold whitespace-nowrap">
          {pending > 0 ? <span className="text-brown-faint">Saving…</span>
            : state === 'error' ? <span className="text-red-700">Not saved</span>
            : saved != null ? <span className="text-green-700">✓ {qty(saved)} {item.base_unit}</span>
            : null}
        </span>
      </div>
      <div className="flex items-center gap-2 mt-2">
        <input
          type="text" inputMode="decimal" className={numCls} value={packsText}
          aria-label={`${item.name} ${single ? item.base_unit : item.purchase_unit}`}
          onChange={e => { packsRef.current = e.target.value; setPacksText(e.target.value) }} onBlur={commit} onFocus={e => e.target.select()}
        />
        <span className="text-xs text-brown-muted">{single ? item.base_unit : item.purchase_unit}</span>
        {!single && (
          <>
            <span className="text-brown-faint">+</span>
            <input
              type="text" inputMode="decimal" className={numCls} value={looseText}
              aria-label={`${item.name} loose ${item.base_unit}`}
              onChange={e => { looseRef.current = e.target.value; setLooseText(e.target.value) }} onBlur={commit} onFocus={e => e.target.select()}
            />
            <span className="text-xs text-brown-muted">{item.base_unit}</span>
          </>
        )}
      </div>
    </div>
  )
}

export default function StockCountSessionPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { staff } = useAuth()
  const [count, setCount] = useState<StockCount | null>(null)
  const [branch, setBranch] = useState<Branch | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [locations, setLocations] = useState<StorageLocation[]>([])
  const [links, setLinks] = useState<ItemLocation[]>([])
  const [entries, setEntries] = useState<StockCountEntry[]>([])
  const [tab, setTab] = useState<string>('')
  const [onlyGaps, setOnlyGaps] = useState(false)
  // Keys uncounted at the moment "Not counted only" was switched on or the tab changed; rows stay put while being filled.
  const [gapSnap, setGapSnap] = useState<Set<string> | null>(null)
  const cancelling = useRef(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  // Row saves still in flight: the confirm sheet waits for them before it can submit.
  const [saving, setSaving] = useState(0)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!id) return
    const { data: c, error: cErr } = await supabase.from('stock_counts').select('*').eq('id', id).maybeSingle()
    if (cErr || !c) { setError(cErr?.message ?? 'Count not found'); setLoading(false); return }
    const sc = c as StockCount
    const [bRes, iRes, lRes, eRes] = await Promise.all([
      supabase.from('branches').select('*').eq('id', sc.branch_id).maybeSingle(),
      supabase.from('items').select('*').eq('status', 'active').order('name'),
      supabase.from('storage_locations').select('*').eq('branch_id', sc.branch_id),
      supabase.from('stock_count_entries').select('*').eq('count_id', sc.id),
    ])
    const locs = (lRes.data as StorageLocation[]) ?? []
    const linkRes = locs.length
      ? await supabase.from('item_locations').select('*').in('location_id', locs.map(l => l.id))
      : { data: [], error: null }
    setCount(sc)
    setBranch((bRes.data as Branch) ?? null)
    setItems((iRes.data as Item[]) ?? [])
    setLocations(locs)
    setLinks((linkRes.data as ItemLocation[]) ?? [])
    setEntries((eRes.data as StockCountEntry[]) ?? [])
    const loadErr = bRes.error?.message ?? iRes.error?.message ?? lRes.error?.message
      ?? linkRes.error?.message ?? eRes.error?.message
    if (loadErr) setError(loadErr)
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  const countItems = useMemo(() => (count ? itemsForCount(items, count.kind) : []), [items, count])
  const groups = useMemo(() => groupForCounting(countItems, locations, links), [countItems, locations, links])
  const entryMap = useMemo(
    () => new Map(entries.map(e => [entryKey(e.item_id, e.location_id), Number(e.counted_base)])), [entries])
  const missing = useMemo(() => uncountedSpots(groups, entries), [groups, entries])
  // Saved numbers on rows the list no longer shows; they still count at submit.
  const others = useMemo(() => strayEntries(countItems, groups, entries), [countItems, groups, entries])
  const itemById = useMemo(() => new Map(countItems.map(i => [i.id, i])), [countItems])
  const locName = useMemo(() => new Map(locations.map(l => [l.id, l.name])), [locations])
  const activeTab = groups.some(g => g.key === tab) || (tab === OTHER && others.length > 0)
    ? tab : groups[0]?.key ?? ''
  const group = groups.find(g => g.key === activeTab)

  async function saveEntry(itemId: string, locationId: string | null, base: number | null) {
    setSaving(n => n + 1)
    let err: { message: string } | null
    try {
      ({ error: err } = await supabase.rpc('save_count_entry', {
        p_count_id: id, p_item_id: itemId, p_location_id: locationId, p_counted_base: base,
      }))
    } finally {
      setSaving(n => n - 1)
    }
    if (err) { setError(err.message); throw err }
    setEntries(prev => {
      const rest = prev.filter(e => !(e.item_id === itemId && e.location_id === locationId))
      if (base == null) return rest
      return [...rest, {
        id: '', count_id: id!, item_id: itemId, location_id: locationId, counted_base: base,
        counted_by: staff?.id ?? null, counted_at: new Date().toISOString(),
      }]
    })
  }

  async function submit() {
    setBusy(true)
    setError('')
    const { data, error: err } = await supabase.rpc('submit_stock_count', { p_count_id: id })
    setBusy(false)
    setConfirming(false)
    if (err) { setError(err.message); load(); return }
    setCount(data as StockCount)
  }

  function snapshotGaps(g: typeof group) {
    return new Set(g ? g.items.filter(i => !entryMap.has(entryKey(i.id, g.locationId))).map(i => entryKey(i.id, g.locationId)) : [])
  }

  function selectTab(key: string) {
    setTab(key)
    if (onlyGaps) setGapSnap(snapshotGaps(groups.find(g => g.key === key)))
  }

  function toggleGaps(on: boolean) {
    setOnlyGaps(on)
    setGapSnap(on ? snapshotGaps(group) : null)
  }

  function openConfirm() {
    // Commit a field still being edited (its blur saves) before the sheet can be confirmed.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    setConfirming(true)
  }

  async function cancel() {
    if (cancelling.current) return
    if (!window.confirm('Cancel this count? Numbers entered so far are discarded and stock is not changed.')) return
    cancelling.current = true
    setError('')
    const { error: err } = await supabase.rpc('cancel_stock_count', { p_count_id: id })
    if (err) { cancelling.current = false; setError(err.message); return }
    navigate('/procurement/stock-counts')
  }

  if (loading) return <div className="min-h-screen bg-cream-light px-4 py-8 text-center text-sm text-brown-faint">Loading…</div>
  if (!count) {
    return (
      <div className="min-h-screen bg-cream-light px-4 py-8 text-center">
        <p className="text-sm text-brown-muted">{error || 'Count not found.'}</p>
        <Link to="/procurement/stock-counts" className="text-sm text-[#C4813A] font-semibold">← Stock Count</Link>
      </div>
    )
  }

  if (count.status !== 'in_progress') {
    return (
      <div className="min-h-screen bg-cream-light px-4 py-6">
        <div className="max-w-2xl mx-auto space-y-3">
          <Link to="/procurement/stock-counts" className="text-sm text-brown-muted">← Stock Count</Link>
          {count.status === 'cancelled'
            ? <p className="text-sm text-brown-muted">This count was cancelled. Stock was not changed.</p>
            : <StockCountResult count={count} branchName={branch?.name ?? ''} />}
        </div>
      </div>
    )
  }

  const spotTotal = countSpotTotal(groups)
  const done = spotTotal - missing.length
  const onOther = activeTab === OTHER
  const shownItems = group
    ? (onlyGaps && gapSnap ? group.items.filter(i => gapSnap.has(entryKey(i.id, group.locationId))) : group.items)
    : []

  return (
    <div className="min-h-screen bg-cream-light pb-36">
      <div className="max-w-2xl mx-auto px-4 pt-6 space-y-3">
        <Link to="/procurement/stock-counts" className="text-sm text-brown-muted">← Stock Count</Link>
        <div>
          <h1 className="text-xl font-bold text-brown-dark">{STOCK_COUNT_KIND_LABELS[count.kind]} count</h1>
          <p className="text-xs text-brown-faint">{branch?.name} · Count what is there; system stock is hidden until you submit.</p>
        </div>

        {countItems.length === 0 ? (
          <p className="text-sm text-brown-muted bg-white rounded-xl border border-[#E8DDD0] p-4">
            {count.kind === 'weekly'
              ? 'No key items yet. A manager marks key items under Locations & key items.'
              : 'There are no active items to count.'}
          </p>
        ) : (
          <>
            <div className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4">
              {groups.map(g => {
                const p = groupProgress(g, entryMap)
                const on = g.key === activeTab
                return (
                  <button
                    key={g.key} type="button" onClick={() => selectTab(g.key)}
                    className={`px-3 py-2 rounded-full text-xs font-semibold whitespace-nowrap border ${
                      on ? 'bg-[#C4813A] border-[#C4813A] text-white' : 'bg-white border-[#D4C5B0] text-brown-medium'}`}
                  >
                    {g.label} · {p.done}/{p.total}
                  </button>
                )
              })}
              {others.length > 0 && (
                <button
                  type="button" onClick={() => selectTab(OTHER)}
                  className={`px-3 py-2 rounded-full text-xs font-semibold whitespace-nowrap border ${
                    onOther ? 'bg-[#C4813A] border-[#C4813A] text-white' : 'bg-white border-[#D4C5B0] text-brown-medium'}`}
                >
                  Other entries · {others.length}
                </button>
              )}
            </div>
            {/* Rows are read-only while the confirm sheet is open, so no edit can race the submit. */}
            <fieldset disabled={confirming} className="min-w-0 space-y-3 disabled:opacity-60">
            {onOther ? (
              <div className="space-y-2">
                <p className="text-xs text-brown-faint">
                  Numbers saved at a place this list no longer shows (a removed location, or an item moved
                  during the count). They are still added to the item's total. Clear both boxes to remove one.
                </p>
                {others.map(e => {
                  const it = itemById.get(e.item_id)!
                  return (
                    <CountRow
                      key={`${OTHER}:${entryKey(e.item_id, e.location_id)}`}
                      item={it}
                      locationId={e.location_id}
                      place={e.location_id ? locName.get(e.location_id) ?? 'Unknown location' : 'Unassigned'}
                      saved={Number(e.counted_base)}
                      onSave={saveEntry}
                    />
                  )
                })}
              </div>
            ) : (
              <>
              <label className="flex items-center gap-2 text-xs text-brown-muted">
                <input type="checkbox" checked={onlyGaps} onChange={e => toggleGaps(e.target.checked)} />
                Not counted only
              </label>
              <div className="space-y-2">
                {group && shownItems.map(i => (
                  <CountRow
                    key={entryKey(i.id, group.locationId)}
                    item={i}
                    locationId={group.locationId}
                    saved={entryMap.get(entryKey(i.id, group.locationId))}
                    onSave={saveEntry}
                  />
                ))}
                {group && shownItems.length === 0 && (
                  <p className="text-sm text-brown-faint text-center py-4">Everything here is counted.</p>
                )}
              </div>
              </>
            )}
            </fieldset>
          </>
        )}
        <button type="button" onClick={cancel} className="text-xs text-brown-faint underline pt-2">Cancel this count</button>
        {error && <p className="text-sm text-red-700">{error}</p>}
      </div>

      {countItems.length > 0 && (
        <div className="fixed bottom-0 inset-x-0 z-40 bg-white border-t border-[#E8DDD0] px-4 py-3">
          <div className="max-w-2xl mx-auto">
            {confirming ? (
              <div className="space-y-2">
                <p className="text-sm text-brown-dark">
                  Stock on hand at {branch?.name} will be set to these counts for {countItems.length} items. This cannot be undone.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => setConfirming(false)} className="h-12 rounded-xl border border-[#D4C5B0] text-sm font-semibold text-brown-medium">
                    Keep counting
                  </button>
                  <button type="button" onClick={submit} disabled={busy || saving > 0} className="h-12 rounded-xl bg-brown-btn text-white text-sm font-bold disabled:opacity-50">
                    {busy ? 'Submitting…' : saving > 0 ? 'Saving…' : 'Submit count'}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex justify-between text-xs text-brown-muted mb-2">
                  <span>{done} of {spotTotal} spots counted</span>
                  {missing.length > 0 && <span>{missing.length} to go</span>}
                </div>
                <button
                  type="button" disabled={missing.length > 0} onClick={openConfirm}
                  className="w-full h-12 rounded-xl bg-brown-btn text-white text-sm font-bold disabled:opacity-40"
                >
                  Submit count
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
