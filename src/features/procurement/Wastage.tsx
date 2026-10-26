import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { useCan } from '../../shared/lib/permissions'
import { RECEIVING_PHOTOS_BUCKET } from '../../shared/lib/photos'
import { useSignedPhotoUrls } from '../../shared/lib/useSignedPhotoUrls'
import { money, qty, validateWastage, weekStartMYT } from '../../shared/lib/procurement'
import type { StockDepartmentFilter } from '../../shared/lib/procurement'
import type { Item, Branch, InventoryValuation, WastageLog, WastageReason } from '../../shared/types'
import {
  ITEM_DEPARTMENTS, ITEM_DEPARTMENT_LABELS, WASTAGE_REASONS, WASTAGE_REASON_LABELS,
} from '../../shared/types'

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'
const labelCls = 'block text-xs font-semibold text-brown-medium mb-1'

const MYT_OFFSET_MS = 8 * 60 * 60 * 1000

function pillCls(active: boolean) {
  return `px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap border transition-colors ${
    active
      ? 'bg-[#C4813A] border-[#C4813A] text-white'
      : 'bg-white border-[#D4C5B0] text-brown-medium hover:bg-[#F5EDE0]'
  }`
}

/** Today's date in Malaysia as yyyy-mm-dd, for the photo path. */
function todayMYT(): string {
  return new Date(Date.now() + MYT_OFFSET_MS).toISOString().slice(0, 10)
}

function formatLoggedAt(iso: string): string {
  return new Date(iso).toLocaleString('en-MY', {
    timeZone: 'Asia/Kuala_Lumpur',
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

/** Wastage photo thumbnail. `url` is the signed URL: undefined while signing, null when unavailable. */
function WastagePhoto({ url }: { url: string | null | undefined }) {
  const [failed, setFailed] = useState(false)
  if (url === undefined || url === null || failed) {
    return (
      <div
        className="flex-shrink-0 w-12 h-12 rounded-lg border border-dashed border-[#D4C5B0] bg-[#FBF6EE] flex items-center justify-center text-center"
        title={url === undefined ? 'Loading photo' : 'Photo unavailable'}
      >
        {url !== undefined && <span className="text-[9px] leading-tight text-brown-faint">Photo unavailable</span>}
      </div>
    )
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" className="flex-shrink-0" aria-label="Open photo">
      <img
        src={url}
        alt=""
        onError={() => setFailed(true)}
        className="w-12 h-12 rounded-lg object-cover border border-[#EDE5D8]"
      />
    </a>
  )
}

/** On-hand and average cost of one item at the selected branch. */
interface StockAt {
  balance: number
  avgCost: number | null
}

export default function WastagePage() {
  const { staff } = useAuth()
  const { can } = useCan()
  const allBranches = can('all_branches')

  const [branches, setBranches] = useState<Branch[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [branchId, setBranchId] = useState('')
  const [stock, setStock] = useState<InventoryValuation[] | null>(null)
  const [logs, setLogs] = useState<WastageLog[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  // Bumped after a successful log so on-hand and the week list reload.
  const [reloadKey, setReloadKey] = useState(0)

  const [search, setSearch] = useState('')
  const [department, setDepartment] = useState<StockDepartmentFilter>('all')
  const [itemId, setItemId] = useState('')
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState<WastageReason | null>(null)
  const [note, setNote] = useState('')
  const [photo, setPhoto] = useState<File | null>(null)
  // Remounts the file input so it clears after a successful log.
  const [photoKey, setPhotoKey] = useState(0)
  const [attempted, setAttempted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    async function load() {
      const [branchRes, itemRes] = await Promise.all([
        supabase.from('branches').select('*').eq('is_active', true).order('name'),
        supabase.from('items').select('*').eq('status', 'active').order('name'),
      ])
      const err = branchRes.error ?? itemRes.error
      if (err) setLoadError(err.message)
      const active = (branchRes.data as Branch[]) ?? []
      setBranches(active)
      setItems((itemRes.data as Item[]) ?? [])
      // Managers choose (defaulting to their own branch); everyone else logs for theirs.
      if (allBranches) {
        const own = active.find(b => b.id === staff?.branch_id)
        setBranchId(own?.id ?? active[0]?.id ?? '')
      } else {
        setBranchId(staff?.branch_id ?? '')
      }
      setLoading(false)
    }
    load()
  }, [allBranches, staff?.branch_id])

  useEffect(() => {
    if (!branchId) { setStock(null); setLogs([]); return }
    let cancelled = false

    async function loadBranch() {
      const [stockRes, logRes] = await Promise.all([
        supabase.from('inventory_valuation').select('*').eq('branch_id', branchId),
        supabase
          .from('wastage_logs')
          .select('*, item:items(id,name,base_unit,department), creator:staff!wastage_logs_created_by_fkey(id,name)')
          .eq('branch_id', branchId)
          .gte('created_at', weekStartMYT(new Date()).toISOString())
          .order('created_at', { ascending: false }),
      ])
      if (cancelled) return
      const err = stockRes.error ?? logRes.error
      if (err) setLoadError(err.message)
      // Null = unknown, so the form leaves the stock check to the RPC.
      setStock(stockRes.error ? null : (stockRes.data as InventoryValuation[]) ?? [])
      setLogs((logRes.data as WastageLog[]) ?? [])
    }

    loadBranch()
    return () => { cancelled = true }
  }, [branchId, reloadKey])

  const stockByItem = useMemo(() => {
    const map = new Map<string, StockAt>()
    for (const row of stock ?? []) {
      map.set(row.item_id, {
        balance: Number(row.balance),
        avgCost: row.avg_unit_cost == null ? null : Number(row.avg_unit_cost),
      })
    }
    return map
  }, [stock])

  /** On-hand at the branch; an item with no ledger rows there holds 0. Null when unknown. */
  function onHandOf(id: string): number | null {
    if (stock == null) return null
    return stockByItem.get(id)?.balance ?? 0
  }

  const hasUnassigned = items.some(i => i.department == null)
  const departmentOptions: { value: StockDepartmentFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    ...ITEM_DEPARTMENTS.map(d => ({ value: d, label: ITEM_DEPARTMENT_LABELS[d] })),
    ...(hasUnassigned ? [{ value: 'unassigned' as const, label: 'Unassigned' }] : []),
  ]

  const visibleItems = useMemo(() => {
    const term = search.trim().toLowerCase()
    return items
      .filter(i => department === 'all'
        || (department === 'unassigned' ? i.department == null : i.department === department))
      .filter(i => !term || i.name.toLowerCase().includes(term))
  }, [items, department, search])

  const selected = items.find(i => i.id === itemId) ?? null
  const onHand = selected ? onHandOf(selected.id) : null
  const avgCost = selected ? stockByItem.get(selected.id)?.avgCost ?? null : null
  const qtyNum = quantity.trim() === '' ? NaN : Number(quantity)
  const estimate = avgCost != null && qtyNum > 0 ? qtyNum * avgCost : null

  const validation = selected
    ? validateWastage({ quantity: qtyNum, reason, note, onHand, baseUnit: selected.base_unit })
    : 'Pick an item'
  // Stay quiet until the user has typed an amount or tried to submit.
  const showValidation = attempted || quantity.trim() !== ''

  const branchName = branches.find(b => b.id === branchId)?.name ?? '—'
  const staffHasNoBranch = !allBranches && !staff?.branch_id
  // Batch-sign this week's thumbnails (private bucket).
  const { urls: photoUrls } = useSignedPhotoUrls(logs.map(l => l.photo_path))

  const weekTotal = logs.reduce((sum, l) => sum + (l.value == null ? 0 : Number(l.value)), 0)

  function selectItem(id: string) {
    setItemId(id)
    setSuccess('')
    setError('')
  }

  async function submit() {
    setAttempted(true)
    setSuccess('')
    setError('')
    if (!branchId || !selected || validation) return

    setSubmitting(true)

    let photoPath: string | null = null
    if (photo) {
      const ext = photo.name.split('.').pop() ?? 'jpg'
      const path = `wastage/${branchId}/${todayMYT()}/${crypto.randomUUID()}.${ext}`
      const { error: upErr } = await supabase.storage
        .from(RECEIVING_PHOTOS_BUCKET)
        .upload(path, photo, { contentType: photo.type })
      if (upErr) {
        setSubmitting(false)
        setError(`Could not upload the photo: ${upErr.message}`)
        return
      }
      photoPath = path
    }

    // The RPC writes the wastage log and the stock movement in one transaction.
    const { data, error: rpcErr } = await supabase.rpc('log_wastage', {
      p_branch_id: branchId,
      p_item_id: selected.id,
      p_quantity: qtyNum,
      p_reason: reason,
      p_note: note.trim() || null,
      p_photo_path: photoPath,
    })

    setSubmitting(false)
    if (rpcErr) { setError(rpcErr.message); return }

    const logged = data as WastageLog | null
    const value = logged?.value == null ? null : Number(logged.value)
    setSuccess(
      `Logged ${qty(qtyNum)} ${selected.base_unit} of ${selected.name}` +
      (value != null ? ` (${money(value)})` : ' (no cost on record)'),
    )
    setQuantity('')
    setReason(null)
    setNote('')
    setPhoto(null)
    setPhotoKey(k => k + 1)
    setAttempted(false)
    setReloadKey(k => k + 1)
  }

  if (loading) {
    return <div className="min-h-screen bg-cream-light px-4 py-8 text-center text-sm text-brown-faint">Loading…</div>
  }

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-3xl mx-auto px-4 py-8 lg:px-8 space-y-5">
        <div>
          <h1 className="text-2xl font-bold text-brown-dark">Wastage</h1>
          <p className="text-sm text-brown-faint mt-0.5">Log what was thrown away, the same day.</p>
        </div>

        {loadError && (
          <div className="bg-[#FCF0EC] border border-[#C0624A40] rounded-xl px-4 py-3">
            <p className="text-sm font-semibold text-[#9E4A30]">Couldn't load everything.</p>
            <p className="text-xs text-[#9E4A30] mt-0.5">{loadError}</p>
          </div>
        )}

        {staffHasNoBranch && (
          <div className="bg-[#FCF0EC] border border-[#C0624A40] rounded-xl px-4 py-3">
            <p className="text-sm text-[#9E4A30] font-semibold">Your account has no branch yet</p>
            <p className="text-xs text-[#9E4A30] mt-1">
              Wastage is taken off a branch's stock, so it must belong to a branch. Ask a manager
              to set your branch in Staff Management, then come back.
            </p>
          </div>
        )}

        <section className="bg-white rounded-xl border border-[#E8DDD0] p-5 space-y-5">
          <div>
            <label htmlFor="wastage-branch" className={labelCls}>Branch</label>
            {allBranches ? (
              <select
                id="wastage-branch"
                className={inputCls}
                value={branchId}
                onChange={e => {
                  // Drop the old branch's numbers so they never show against the new one.
                  setStock(null)
                  setLogs([])
                  setBranchId(e.target.value)
                  setSuccess('')
                  setError('')
                }}
              >
                {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            ) : (
              <p id="wastage-branch" className="text-sm font-semibold text-brown-dark">
                {staffHasNoBranch ? '—' : branchName}
              </p>
            )}
          </div>

          {/* Step 1: item */}
          <div className="space-y-2">
            <label htmlFor="wastage-search" className={labelCls}>Item</label>
            <input
              id="wastage-search"
              className={inputCls}
              placeholder="Search item…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Department">
              {departmentOptions.map(o => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setDepartment(o.value)}
                  className={pillCls(department === o.value)}
                  aria-pressed={department === o.value}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <div
              className="max-h-72 overflow-y-auto rounded-lg border border-[#EDE5D8] divide-y divide-[#F0E8DC]"
              role="listbox"
              aria-label="Items"
            >
              {visibleItems.length === 0 ? (
                <p className="text-xs text-brown-faint text-center py-6">
                  {items.length === 0 ? 'No active items yet.' : 'No items match.'}
                </p>
              ) : visibleItems.map(i => {
                const held = onHandOf(i.id)
                const isSelected = i.id === itemId
                const empty = held != null && held <= 0
                return (
                  <button
                    key={i.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => selectItem(i.id)}
                    className={`w-full flex items-center justify-between gap-3 px-4 py-3 text-left transition-colors ${
                      isSelected ? 'bg-[#C4813A1A]' : 'hover:bg-[#FBF6EE]'
                    } ${empty && !isSelected ? 'opacity-50' : ''}`}
                  >
                    <span className={`text-sm ${isSelected ? 'font-bold text-[#A86C2C]' : 'font-medium text-brown-dark'}`}>
                      {isSelected && '✓ '}{i.name}
                    </span>
                    <span className="text-xs text-brown-muted whitespace-nowrap">
                      {held == null ? '—' : `${qty(held)} ${i.base_unit}`}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Step 2: amount */}
          <div>
            <label htmlFor="wastage-qty" className={labelCls}>
              Quantity{selected ? ` of ${selected.name}` : ''}
            </label>
            <div className="flex items-center gap-2">
              <input
                id="wastage-qty"
                type="number" step="any" min="0" inputMode="decimal"
                className={`${inputCls} w-40`}
                value={quantity}
                onChange={e => { setQuantity(e.target.value); setSuccess('') }}
                placeholder="0"
                disabled={!selected}
              />
              <span className="text-sm text-brown-muted">{selected?.base_unit ?? ''}</span>
            </div>
            {selected && (
              <p className="text-xs text-brown-faint mt-1">
                On hand: {onHand == null ? '—' : `${qty(onHand)} ${selected.base_unit}`}
              </p>
            )}
            {estimate != null && (
              <p className="text-xs text-brown-muted mt-0.5">≈ {money(estimate)} at current average cost</p>
            )}
          </div>

          {/* Step 3: reason */}
          <div>
            <p className={labelCls}>Reason</p>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Reason">
              {WASTAGE_REASONS.map(r => (
                <button
                  key={r}
                  type="button"
                  role="radio"
                  aria-checked={reason === r}
                  onClick={() => setReason(r)}
                  className={`py-3 rounded-xl text-sm font-semibold transition-colors ${
                    reason === r
                      ? 'bg-[#C4813A] text-white'
                      : 'border border-[#D4C5B0] text-brown-medium hover:bg-[#F5EDE0]'
                  }`}
                >
                  {WASTAGE_REASON_LABELS[r]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="wastage-note" className={labelCls}>
              {reason === 'other' ? 'Note (required for Other)' : 'Note (optional)'}
            </label>
            <textarea
              id="wastage-note"
              rows={2}
              className={`${inputCls} resize-none`}
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="e.g. Left out overnight"
              required={reason === 'other'}
            />
          </div>

          <div>
            <label htmlFor="wastage-photo" className={labelCls}>Photo (optional)</label>
            <input
              key={photoKey}
              id="wastage-photo"
              type="file"
              accept="image/*"
              capture="environment"
              onChange={e => setPhoto(e.target.files?.[0] ?? null)}
              className="text-xs"
            />
            {photo && <p className="text-xs text-[#3D7A50] mt-1">✓ {photo.name}</p>}
          </div>

          <div className="border-t border-[#EDE5D8] pt-4 space-y-3">
            {showValidation && validation && (
              <p className="text-sm font-semibold text-[#9E4A30]">{validation}</p>
            )}
            {error && (
              <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">{error}</p>
            )}
            {success && (
              <p className="text-sm font-semibold text-[#3D7A50] bg-[#EBF5EE] border border-[#3D7A5040] rounded-lg px-4 py-2.5">
                ✓ {success}
              </p>
            )}
            <button
              onClick={submit}
              disabled={submitting || !branchId || !selected}
              className="w-full py-3 rounded-xl bg-[#9E4A30] text-white text-sm font-semibold hover:bg-[#843D27] transition-colors disabled:opacity-50"
            >
              {submitting ? 'Logging…' : 'Log wastage'}
            </button>
          </div>
        </section>

        <section className="bg-white rounded-xl border border-[#E8DDD0] p-5">
          <div className="flex items-baseline justify-between gap-3 mb-3">
            <h2 className="text-sm font-bold text-brown-dark">This week</h2>
            <span className="text-sm font-semibold text-brown-dark">{money(weekTotal)}</span>
          </div>
          {logs.length === 0 ? (
            <p className="text-xs text-brown-faint text-center py-6">Nothing logged this week.</p>
          ) : (
            <div className="divide-y divide-[#F0E8DC] border-t border-[#EDE5D8]">
              {logs.map(l => (
                <div key={l.id} className="flex items-start gap-3 py-3">
                  {l.photo_path && <WastagePhoto url={photoUrls[l.photo_path]} />}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-brown-dark">
                      {l.item?.name ?? 'Unknown item'}
                      <span className="text-[#9E4A30] font-bold ml-2 whitespace-nowrap">
                        {qty(Number(l.quantity))} {l.item?.base_unit ?? ''}
                      </span>
                    </p>
                    <p className="text-xs text-brown-faint">
                      {formatLoggedAt(l.created_at)}
                      {' · '}{WASTAGE_REASON_LABELS[l.reason] ?? l.reason}
                      {l.creator?.name && ` · ${l.creator.name}`}
                    </p>
                    {l.note && <p className="text-xs text-brown-muted italic mt-0.5">{l.note}</p>}
                  </div>
                  <span className="text-sm font-semibold text-brown-dark whitespace-nowrap">
                    {l.value == null ? '—' : money(Number(l.value))}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
