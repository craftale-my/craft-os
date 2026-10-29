import { useState, useEffect } from 'react'
import { useParams, useSearchParams, Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { money, qty, formatUnitCost } from '../../shared/lib/procurement'
import { useBranchPicker } from './useBranchPicker'
import Stepper from './Stepper'
import type { Item, ProductionBatch, ProductionPreview } from '../../shared/types'

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'
const labelCls = 'block text-xs font-semibold text-brown-medium mb-1'

export default function ProducePage() {
  const { itemId } = useParams<{ itemId: string }>()
  const [params] = useSearchParams()
  const { branches, branchId, setBranchId, allBranches, loaded, branchName, staffHasNoBranch } =
    useBranchPicker(params.get('branch'))

  const [item, setItem] = useState<Item | null>(null)
  const [loading, setLoading] = useState(true)
  const [batches, setBatches] = useState('1')
  const [note, setNote] = useState('')
  const [preview, setPreview] = useState<ProductionPreview | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [previewing, setPreviewing] = useState(false)
  // Bumped after a run so on-hand in the preview reloads.
  const [reloadKey, setReloadKey] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<ProductionBatch | null>(null)

  useEffect(() => {
    if (!itemId) return
    let cancelled = false
    supabase.from('items').select('*').eq('id', itemId).maybeSingle().then(({ data }) => {
      if (cancelled) return
      setItem(data as Item | null)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [itemId])

  const batchNum = batches.trim() === '' ? NaN : Number(batches)
  const batchesValid = Number.isFinite(batchNum) && batchNum > 0

  useEffect(() => {
    if (!itemId || !branchId || !batchesValid) {
      setPreview(null)
      setPreviewError('')
      setPreviewing(false)
      return
    }
    let cancelled = false
    setPreviewing(true)
    // Small debounce so typing "2.5" doesn't fire three previews.
    const timer = setTimeout(async () => {
      const { data, error: err } = await supabase.rpc('preview_production', {
        p_item_id: itemId,
        p_branch_id: branchId,
        p_batches: batchNum,
      })
      if (cancelled) return
      setPreviewing(false)
      if (err) { setPreview(null); setPreviewError(err.message); return }
      setPreviewError('')
      setPreview(data as ProductionPreview)
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [itemId, branchId, batchNum, batchesValid, reloadKey])

  async function produce() {
    if (!itemId || !branchId || !batchesValid) return
    setSubmitting(true)
    setError('')
    setDone(null)
    const { data, error: rpcErr } = await supabase.rpc('produce_batch', {
      p_item_id: itemId,
      p_branch_id: branchId,
      p_batches: batchNum,
      p_note: note.trim() || null,
    })
    setSubmitting(false)
    if (rpcErr) { setError(rpcErr.message); return }
    setDone(data as ProductionBatch)
    setNote('')
    setReloadKey(k => k + 1)
  }

  if (loading || !loaded) {
    return <div className="min-h-screen bg-cream-light px-4 py-8 text-center text-sm text-brown-faint">Loading…</div>
  }

  if (!item) {
    return (
      <div className="min-h-screen bg-cream-light px-4 py-8">
        <div className="max-w-3xl mx-auto text-center py-16">
          <p className="text-sm text-brown-muted">Item not found.</p>
          <Link to="/procurement/recipes" className="text-sm text-[#C4813A] font-semibold hover:underline mt-2 inline-block">
            ← Back to Recipes
          </Link>
        </div>
      </div>
    )
  }

  const unit = item.base_unit

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-3xl mx-auto px-4 py-8 lg:px-8 space-y-5">
        <div>
          <Link to={`/procurement/recipes/${item.id}`} className="text-xs text-brown-faint hover:text-[#C4813A] transition-colors">
            ← {item.name}
          </Link>
          <h1 className="text-2xl font-bold text-brown-dark mt-1">Produce {item.name}</h1>
          <p className="text-sm text-brown-faint mt-0.5">
            Takes the ingredients out of stock and puts the batch in, at the branch's current average cost.
          </p>
        </div>

        {staffHasNoBranch && (
          <div className="bg-[#FCF0EC] border border-[#C0624A40] rounded-xl px-4 py-3">
            <p className="text-sm text-[#9E4A30] font-semibold">Your account has no branch yet</p>
            <p className="text-xs text-[#9E4A30] mt-1">
              A batch is made at a branch, so your account must belong to one. Ask a manager to set your branch
              in Staff Management, then come back.
            </p>
          </div>
        )}

        <section className="bg-white rounded-xl border border-[#E8DDD0] p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="produce-branch" className={labelCls}>Branch</label>
              {allBranches ? (
                <select
                  id="produce-branch"
                  className={inputCls}
                  value={branchId}
                  onChange={e => { setBranchId(e.target.value); setDone(null); setError('') }}
                >
                  {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              ) : (
                <p id="produce-branch" className="text-sm font-semibold text-brown-dark py-2">
                  {staffHasNoBranch ? '—' : branchName(branchId)}
                </p>
              )}
            </div>
            <div>
              <label htmlFor="produce-batches" className={labelCls}>Number of batches</label>
              <div id="produce-batches">
                <Stepper
                  value={Number(batches) || 0}
                  onChange={n => { setBatches(String(n)); setDone(null); setError('') }}
                  label="Number of batches"
                />
              </div>
              {!batchesValid && (
                <p className="text-xs font-semibold text-[#9E4A30] mt-1">Number of batches must be greater than zero</p>
              )}
            </div>
          </div>

          <div>
            <label htmlFor="produce-note" className={labelCls}>Note (optional)</label>
            <input
              id="produce-note"
              className={inputCls}
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="e.g. For weekend orders"
            />
          </div>
        </section>

        <section className="bg-white rounded-xl border border-[#E8DDD0] p-5 space-y-4">
          {previewError ? (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">{previewError}</p>
          ) : !preview ? (
            <p className="text-xs text-brown-faint text-center py-6">{previewing ? 'Checking stock…' : '—'}</p>
          ) : (
            <>
              <p className="text-xs text-brown-faint">
                Recipe v{preview.version} (from {preview.effective_from}) · business date {preview.business_date}
                {previewing && ' · updating…'}
              </p>
              <ul className="divide-y divide-[#F0E8DC] border-y border-[#F0E8DC]">
                {preview.lines.map(l => {
                  const need = Number(l.need)
                  const held = Number(l.on_hand)
                  return (
                    <li key={l.item_id} className={`py-2.5 ${l.short ? 'bg-[#FCF0EC] -mx-2 px-2 rounded-lg' : ''}`}>
                      <div className="flex justify-between gap-3">
                        <p className="text-sm font-semibold text-brown-dark">{l.name}</p>
                        <p className="text-sm text-brown-dark whitespace-nowrap">{money(Number(l.line_cost))}</p>
                      </div>
                      <div className="flex justify-between gap-3 mt-0.5 text-xs">
                        <p className="text-brown-muted">
                          Need <span className="font-semibold text-brown-dark">{qty(need)} {l.base_unit}</span>
                          {' · '}on hand {qty(held)}
                          {l.short
                            ? <span className="font-semibold text-[#9E4A30]"> · short {qty(need - Math.max(held, 0))}</span>
                            : <span className="text-[#3D7A50]"> · OK</span>}
                        </p>
                        <p className="text-brown-faint whitespace-nowrap">
                          {formatUnitCost(l.unit_cost == null ? null : Number(l.unit_cost), l.base_unit)}
                        </p>
                      </div>
                    </li>
                  )
                })}
              </ul>

              <div className="rounded-xl bg-[#FBF6EE] border border-[#EDE5D8] px-4 py-3 text-sm space-y-0.5">
                <p className="text-brown-dark">
                  Output: <span className="font-bold">{qty(Number(preview.output_qty))} {unit}</span> of {item.name}
                  <span className="text-xs text-brown-faint">
                    {' '}({qty(Number(preview.batches))} × {qty(Number(preview.yield_qty))} {unit})
                  </span>
                </p>
                <p className="text-brown-dark">Batch cost <span className="font-bold">{money(Number(preview.total_cost))}</span></p>
                <p className="text-xs text-brown-muted">
                  Unit cost {money(Number(preview.total_cost))} / {qty(Number(preview.output_qty))} {unit}
                  {' = '}RM {Number(preview.unit_cost).toFixed(4)} per {unit}
                </p>
                {preview.missing_cost && (
                  <p className="text-xs text-[#B46309]">
                    No cost at this branch for {preview.lines.filter(l => l.unit_cost == null).map(l => l.name).join(', ')}.
                    {' '}Set a price on the item before producing.
                  </p>
                )}
              </div>
            </>
          )}

          <div className="border-t border-[#EDE5D8] pt-4 space-y-3">
            {preview && preview.lines.some(l => l.short) && (
              <p className="text-sm font-semibold text-[#9E4A30]">Not enough stock for this many batches.</p>
            )}
            {preview && preview.missing_cost && (
              <p className="text-sm font-semibold text-[#9E4A30]">Some ingredients have no cost yet, so this batch cannot be costed.</p>
            )}
            {error && (
              <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">{error}</p>
            )}
            {done && (
              <div className="text-sm text-[#3D7A50] bg-[#EBF5EE] border border-[#3D7A5040] rounded-lg px-4 py-2.5 space-y-1">
                <p className="font-semibold">
                  ✓ Produced {qty(Number(done.output_qty))} {unit} of {item.name} at {branchName(done.branch_id)}
                  {' '}({money(Number(done.total_cost))}, {formatUnitCost(Number(done.unit_cost), unit)})
                </p>
                <p className="text-xs flex gap-4">
                  <Link to={`/procurement/inventory/${item.id}?branch=${done.branch_id}`} className="font-semibold hover:underline">
                    View stock movements →
                  </Link>
                  <Link to={`/procurement/recipes/${item.id}`} className="font-semibold hover:underline">
                    Back to recipe →
                  </Link>
                </p>
              </div>
            )}
            <button
              onClick={produce}
              disabled={submitting || previewing || !preview?.can_produce || !branchId}
              className="w-full py-3 rounded-xl bg-[#3D7A50] text-white text-sm font-semibold hover:bg-[#326642] transition-colors disabled:opacity-50"
            >
              {submitting ? 'Producing…' : 'Produce'}
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}
