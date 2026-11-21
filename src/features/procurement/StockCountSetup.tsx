import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { useBranchPicker } from './useBranchPicker'
import type { Item, StorageLocation, ItemLocation } from '../../shared/types'

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

type Panel = { kind: 'location'; location: StorageLocation } | { kind: 'key' } | null

export default function StockCountSetupPage() {
  const { branches, branchId, setBranchId, allBranches } = useBranchPicker()
  const [locations, setLocations] = useState<StorageLocation[]>([])
  const [links, setLinks] = useState<ItemLocation[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [newName, setNewName] = useState('')
  const [panel, setPanel] = useState<Panel>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const reqId = useRef(0)
  const busyRef = useRef(false)

  // reset=true on a branch change: drop the previous branch's data and error first.
  // Reloads after an action keep the data on screen and never wipe an error the action set.
  const load = useCallback(async (reset = false) => {
    const id = ++reqId.current
    if (reset) {
      setLocations([]); setLinks([]); setItems([]); setError('')
    }
    if (!branchId) return
    const [lRes, iRes] = await Promise.all([
      supabase.from('storage_locations').select('*').eq('branch_id', branchId).order('sort_order').order('name'),
      supabase.from('items').select('*').eq('status', 'active').order('name'),
    ])
    if (id !== reqId.current) return
    const locs = (lRes.data as StorageLocation[]) ?? []
    const linkRes = locs.length
      ? await supabase.from('item_locations').select('*').in('location_id', locs.map(l => l.id))
      : { data: [], error: null }
    if (id !== reqId.current) return
    const failed = lRes.error?.message ?? iRes.error?.message ?? linkRes.error?.message
    if (failed) { setError(failed); return }
    setLocations(locs)
    setItems((iRes.data as Item[]) ?? [])
    setLinks((linkRes.data as ItemLocation[]) ?? [])
  }, [branchId])

  useEffect(() => {
    setPanel(null)
    load(true)
  }, [load])

  // Runs one action at a time; a second tap while busy is ignored.
  async function run(action: () => Promise<boolean>): Promise<boolean> {
    if (busyRef.current) return false
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      return await action()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  async function call(fn: string, args: Record<string, unknown>) {
    const { error: err } = await supabase.rpc(fn, args)
    if (err) { setError(err.message); return false }
    return true
  }

  async function addLocation() {
    const name = newName.trim()
    if (!name || !branchId) return
    const next = locations.reduce((m, l) => Math.max(m, l.sort_order), -1) + 1
    const ok = await run(() => call('save_storage_location', { p_id: null, p_branch_id: branchId, p_name: name, p_sort_order: next, p_is_active: true }))
    if (ok) {
      setNewName('')
      load()
    }
  }

  async function saveLocation(l: StorageLocation, patch: Partial<StorageLocation>) {
    const merged = { ...l, ...patch }
    const ok = await run(() => call('save_storage_location', {
      p_id: l.id, p_branch_id: branchId, p_name: merged.name, p_sort_order: merged.sort_order, p_is_active: merged.is_active,
    }))
    if (ok) load()
  }

  async function move(index: number, dir: -1 | 1) {
    const active = locations.filter(l => l.is_active)
    const a = active[index]
    const b = active[index + dir]
    if (!a || !b) return
    // Renumber the whole list so equal sort_orders cannot stall a move.
    const order = active.map(l => l.id)
    order[index] = b.id
    order[index + dir] = a.id
    // One busy span for the whole renumbering so nothing can interleave.
    await run(async () => {
      for (const [i, lid] of order.entries()) {
        const loc = active.find(l => l.id === lid)!
        if (loc.sort_order !== i) {
          const ok = await call('save_storage_location', {
            p_id: loc.id, p_branch_id: branchId, p_name: loc.name, p_sort_order: i, p_is_active: true,
          })
          if (!ok) return false
        }
      }
      return true
    })
    load()
  }

  function openLocation(l: StorageLocation) {
    const activeIds = new Set(items.map(i => i.id))
    setPicked(links
      .filter(x => x.location_id === l.id && activeIds.has(x.item_id))
      .sort((x, y) => x.sort_order - y.sort_order)
      .map(x => x.item_id))
    setSearch('')
    setPanel({ kind: 'location', location: l })
  }

  async function saveLocationItems() {
    if (panel?.kind !== 'location') return
    const locId = panel.location.id
    const ok = await run(() => call('set_location_items', { p_location_id: locId, p_item_ids: picked }))
    if (ok) {
      setPanel(null)
      load()
    }
  }

  async function toggleKey(item: Item) {
    const value = !item.count_weekly
    const ok = await run(() => call('set_item_count_weekly', { p_item_id: item.id, p_value: value }))
    if (ok) setItems(prev => prev.map(i => (i.id === item.id ? { ...i, count_weekly: value } : i)))
  }

  const filtered = useMemo(
    () => items.filter(i => i.name.toLowerCase().includes(search.trim().toLowerCase())), [items, search])
  const active = locations.filter(l => l.is_active)
  const inactive = locations.filter(l => !l.is_active)
  const keyCount = items.filter(i => i.count_weekly).length

  if (panel) {
    const isKey = panel.kind === 'key'
    return (
      <div className="min-h-screen bg-cream-light pb-28">
        <div className="max-w-2xl mx-auto px-4 pt-6 space-y-3">
          <button type="button" onClick={() => setPanel(null)} className="text-sm text-brown-muted">← Back</button>
          <h1 className="text-xl font-bold text-brown-dark">{isKey ? 'Key items' : panel.location.name}</h1>
          <p className="text-xs text-brown-faint">
            {isKey
              ? 'Key items are counted every week. Tap to switch. Applies to every branch.'
              : 'Tick the items kept here. They are counted in the order you tick them.'}
          </p>
          <input className={inputCls} placeholder="Search items" value={search} onChange={e => setSearch(e.target.value)} />
          <ul className="space-y-1">
            {filtered.map(i => {
              const on = isKey ? i.count_weekly : picked.includes(i.id)
              return (
                <li key={i.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => (isKey
                      ? toggleKey(i)
                      : setPicked(p => (p.includes(i.id) ? p.filter(x => x !== i.id) : [...p, i.id])))}
                    className={`w-full flex items-center justify-between gap-3 px-4 py-3 rounded-xl border text-left ${
                      on ? 'bg-[#FBF1E4] border-[#C4813A]' : 'bg-white border-[#E8DDD0]'}`}
                  >
                    <span className="text-sm text-brown-dark">{i.name}</span>
                    <span className="text-sm font-bold text-[#C4813A]">
                      {on ? (isKey ? '★' : `✓ ${picked.indexOf(i.id) + 1}`) : ''}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          {error && <p className="text-sm text-red-700">{error}</p>}
        </div>
        {!isKey && (
          <div className="fixed bottom-0 inset-x-0 z-40 bg-white border-t border-[#E8DDD0] px-4 py-3">
            <div className="max-w-2xl mx-auto">
              <button type="button" disabled={busy} onClick={saveLocationItems}
                className="w-full h-12 rounded-xl bg-brown-btn text-white text-sm font-bold disabled:opacity-50">
                Save {picked.length} item{picked.length === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-cream-light px-4 py-6">
      <div className="max-w-2xl mx-auto space-y-4">
        <Link to="/procurement/stock-counts" className="text-sm text-brown-muted">← Stock Count</Link>
        <h1 className="text-xl font-bold text-brown-dark">Locations & key items</h1>

        {allBranches && branches.length > 1 && (
          <select className={inputCls} value={branchId} disabled={busy} onChange={e => setBranchId(e.target.value)} aria-label="Branch">
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}

        <button type="button" onClick={() => { setSearch(''); setPanel({ kind: 'key' }) }}
          className="w-full flex items-center justify-between bg-white rounded-xl border border-[#E8DDD0] px-4 py-3">
          <span className="text-sm font-semibold text-brown-dark">Key items (counted weekly)</span>
          <span className="text-sm text-brown-muted">{keyCount} →</span>
        </button>

        <section className="space-y-2">
          <h2 className="text-sm font-bold text-brown-dark">Storage locations — walking order</h2>
          {active.length === 0 && <p className="text-sm text-brown-faint">No locations yet. Add them in the order you walk the store.</p>}
          {active.map((l, idx) => {
            const n = links.filter(x => x.location_id === l.id).length
            return (
              <div key={l.id} className="flex items-center gap-2 bg-white rounded-xl border border-[#E8DDD0] px-3 py-2">
                <div className="flex flex-col">
                  <button type="button" aria-label={`Move ${l.name} up`} disabled={busy || idx === 0} onClick={() => move(idx, -1)}
                    className="w-8 h-6 text-brown-btn disabled:opacity-30">▲</button>
                  <button type="button" aria-label={`Move ${l.name} down`} disabled={busy || idx === active.length - 1} onClick={() => move(idx, 1)}
                    className="w-8 h-6 text-brown-btn disabled:opacity-30">▼</button>
                </div>
                <button type="button" onClick={() => openLocation(l)} className="flex-1 text-left">
                  <p className="text-sm font-semibold text-brown-dark">{l.name}</p>
                  <p className="text-xs text-brown-faint">{n} item{n === 1 ? '' : 's'} · tap to choose</p>
                </button>
                <button type="button" className="text-xs text-brown-faint px-2" disabled={busy}
                  onClick={() => {
                    const name = window.prompt('Rename location', l.name)
                    if (name && name.trim() && name.trim() !== l.name) saveLocation(l, { name: name.trim() })
                  }}>
                  Rename
                </button>
                <button type="button" className="text-xs text-red-700 px-2" disabled={busy}
                  onClick={() => saveLocation(l, { is_active: false })}>
                  Remove
                </button>
              </div>
            )
          })}
          <div className="flex gap-2">
            <input className={inputCls} placeholder="New location, e.g. Chiller 1" value={newName}
              onChange={e => setNewName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addLocation() }} />
            <button type="button" disabled={busy || !newName.trim()} onClick={addLocation}
              className="px-4 rounded-lg bg-brown-btn text-white text-sm font-semibold disabled:opacity-50">
              Add
            </button>
          </div>
          {inactive.length > 0 && (
            <p className="text-xs text-brown-faint">
              Removed: {inactive.map((l, i) => (
                <span key={l.id}>
                  {i > 0 && ', '}
                  <button type="button" className="underline" disabled={busy} aria-label={`Restore ${l.name}`}
                    onClick={() => saveLocation(l, { is_active: true })}>{l.name}</button>
                </span>
              ))} (tap to restore)
            </p>
          )}
        </section>
        {error && <p className="text-sm text-red-700">{error}</p>}
      </div>
    </div>
  )
}
