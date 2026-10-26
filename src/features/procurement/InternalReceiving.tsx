import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { RECEIVING_PHOTOS_BUCKET } from '../../shared/lib/photos'
import { useAuth } from '../auth/AuthContext'
import {
  money, qty, toBaseUnits, transferValue, transitShortQty, validateInternalReceipt, canAccessBranch,
} from '../../shared/lib/procurement'
import { InternalBadge } from './badges'
import type { PoTransferLine, PurchaseOrder, PurchaseOrderItem } from '../../shared/types'

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'
const labelCls = 'block text-xs font-semibold text-brown-medium mb-1'

/** Per-line state. `matched` = everything in transit arrived. */
interface LineState {
  matched: boolean
  actual: string
}

const DEFAULT_STATE: LineState = { matched: true, actual: '' }

/** A PO line joined with its po_transfer_lines row. */
interface Line {
  line: PurchaseOrderItem
  /** Purchase units shipped and not yet received or recorded lost. */
  inTransit: number
  conv: number
  /** RM per base unit, weighted over the line's shipments. */
  shippedCost: number | null
}

function actualFor(l: Line, s: LineState): number {
  return s.matched ? l.inTransit : (s.actual.trim() === '' ? 0 : Number(s.actual))
}

/**
 * Receiving screen for an internal PO (transfer from HQ). Expected = what is in
 * transit; the price is HQ's shipped cost, so it is not editable; anything that
 * did not arrive is recorded as lost in transit and needs a note. The RPC is
 * the same submit_receiving the supplier screen uses.
 */
export default function InternalReceiving({ po }: { po: PurchaseOrder }) {
  const navigate = useNavigate()
  const { staff } = useAuth()

  const [lines, setLines] = useState<Line[]>([])
  const [states, setStates] = useState<Record<string, LineState>>({})
  const [photoFile, setPhotoFile] = useState<File | null>(null)
  const [goodsFile, setGoodsFile] = useState<File | null>(null)
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      const [lineRes, transferRes] = await Promise.all([
        supabase.from('purchase_order_items').select('*, item:items(*)').eq('po_id', po.id),
        supabase.from('po_transfer_lines').select('*').eq('po_id', po.id),
      ])
      if (cancelled) return
      const err = lineRes.error ?? transferRes.error
      if (err) setError(err.message)
      const transfer = new Map(((transferRes.data as PoTransferLine[]) ?? []).map(t => [t.po_item_id, t]))
      const joined = ((lineRes.data as PurchaseOrderItem[]) ?? []).map(l => {
        const t = transfer.get(l.id)
        return {
          line: l,
          inTransit: Number(t?.in_transit_quantity ?? 0),
          conv: Number(t?.conversion_rate ?? l.conversion_rate_used ?? l.item?.conversion_rate ?? 0),
          shippedCost: t?.shipped_unit_cost == null ? null : Number(t.shipped_unit_cost),
        }
      })
      setLines(joined)
      setStates(Object.fromEntries(joined.map(l => [l.line.id, DEFAULT_STATE])))
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [po.id])

  function setLineState(id: string, patch: Partial<LineState>) {
    setStates(prev => ({ ...prev, [id]: { ...(prev[id] ?? DEFAULT_STATE), ...patch } }))
  }

  async function uploadPhoto(file: File, kind: string): Promise<string | null> {
    const ext = file.name.split('.').pop() ?? 'jpg'
    const path = `${po.id}/${Date.now()}-${kind}.${ext}`
    const { error: upErr } = await supabase.storage
      .from(RECEIVING_PHOTOS_BUCKET)
      .upload(path, file, { contentType: file.type })
    if (upErr) { setError(`Could not upload the ${kind} photo: ${upErr.message}`); return null }
    // The bucket is private: submit the storage path, never a URL.
    return path
  }

  if (loading) {
    return <div className="min-h-screen bg-cream-light px-4 py-8 text-center text-sm text-brown-faint">Loading…</div>
  }

  const ownsPo = canAccessBranch(staff, po.branch_id)
  // Every line with goods in transit must be in the receipt.
  const moving = lines.filter(l => l.inTransit > 0)
  const resting = lines.filter(l => l.inTransit <= 0)
  const checks = moving.map(l => ({
    inTransit: l.inTransit,
    actual: actualFor(l, states[l.line.id] ?? DEFAULT_STATE),
    name: l.line.item?.name,
  }))
  const anyLoss = checks.some(c => transitShortQty(c.inTransit, c.actual) > 0)
  const noteMissing = anyLoss && notes.trim() === ''
  const validation = validateInternalReceipt({ lines: checks, note: notes, hasPhoto: !!photoFile })
  const lossValue = moving.reduce((s, l, i) => {
    const v = transferValue(transitShortQty(l.inTransit, checks[i].actual), l.conv, l.shippedCost)
    return s + (v ?? 0)
  }, 0)
  const receivedValue = moving.reduce((s, l, i) => {
    const v = transferValue(Math.max(checks[i].actual, 0), l.conv, l.shippedCost)
    return s + (v ?? 0)
  }, 0)

  async function submit() {
    if (validation || !photoFile) { setError(validation ?? 'A delivery photo is required'); return }
    setSubmitting(true)
    setError('')

    const photoPath = await uploadPhoto(photoFile, 'delivery')
    if (!photoPath) { setSubmitting(false); return }
    let goodsPath: string | null = null
    if (goodsFile) {
      goodsPath = await uploadPhoto(goodsFile, 'goods')
      if (!goodsPath) { setSubmitting(false); return }
    }

    // unit_price is ignored for internal POs: stock enters at the shipped cost.
    const { error: rpcErr } = await supabase.rpc('submit_receiving', {
      p_po_id: po.id,
      p_invoice_photo_url: photoPath,
      p_goods_photo_url: goodsPath,
      p_notes: notes.trim() || null,
      p_lines: moving.map((l, i) => ({ po_item_id: l.line.id, actual_quantity: checks[i].actual })),
    })
    setSubmitting(false)
    if (rpcErr) { setError(rpcErr.message); return }
    navigate(`/procurement/orders/${po.id}`)
  }

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-2xl mx-auto px-4 py-8 lg:px-8 space-y-5">
        <div>
          <Link to="/procurement/receiving" className="text-xs text-brown-faint hover:text-[#C4813A] transition-colors">
            ← Receiving
          </Link>
          <h1 className="text-2xl font-bold text-brown-dark mt-1 flex items-center gap-2">
            Receive {po.po_number} <InternalBadge />
          </h1>
          <p className="text-sm text-brown-muted">
            Transfer from {po.supplier?.name ?? 'HQ'} · {po.branch?.name ?? '—'}
          </p>
        </div>

        {error && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">{error}</p>
        )}

        {!ownsPo ? (
          <div className="bg-white rounded-xl border border-[#E8DDD0] px-6 py-8 text-center">
            <p className="text-sm text-brown-muted">Only {po.branch?.name ?? 'the receiving branch'} can receive this transfer.</p>
            <Link to={`/procurement/orders/${po.id}`} className="text-sm text-[#C4813A] font-semibold hover:underline mt-2 inline-block">
              ← Back to the order
            </Link>
          </div>
        ) : moving.length === 0 ? (
          <div className="bg-white rounded-xl border border-[#E8DDD0] px-6 py-8 text-center">
            <p className="text-sm font-semibold text-brown-dark">Waiting for HQ to ship</p>
            <p className="text-xs text-brown-faint mt-1">Nothing has been shipped on this order yet, so there is nothing to receive.</p>
            <button
              disabled
              className="mt-4 px-5 py-2.5 rounded-xl bg-[#3D7A50] text-white text-sm font-semibold opacity-50"
            >
              Confirm Receipt
            </button>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {moving.map((l, i) => {
                const s = states[l.line.id] ?? DEFAULT_STATE
                const unit = l.line.item?.purchase_unit ?? ''
                const actual = checks[i].actual
                const invalid = !Number.isFinite(actual) || actual < 0 || actual > l.inTransit
                const short = invalid ? 0 : transitShortQty(l.inTransit, actual)
                const shortValue = transferValue(short, l.conv, l.shippedCost)
                return (
                  <div key={l.line.id} className="bg-white rounded-xl border border-[#E8DDD0] p-5 space-y-4">
                    <p className="text-base font-semibold text-brown-dark">{l.line.item?.name ?? 'Unknown item'}</p>
                    <div>
                      <div className="flex items-baseline gap-2">
                        <span className="text-xs text-brown-faint">Expected (in transit)</span>
                        <span className="text-3xl font-bold text-brown-dark">{qty(l.inTransit)}</span>
                        <span className="text-sm text-brown-muted">{unit}</span>
                      </div>
                      <p className="text-xs text-brown-faint mt-0.5">
                        Ordered {qty(Number(l.line.quantity_ordered))} · Shipped {qty(Number(l.line.shipped_quantity ?? 0))}
                        {' · '}Received so far {qty(Number(l.line.received_quantity))}
                      </p>
                    </div>

                    <div className="flex gap-2">
                      <button
                        onClick={() => setLineState(l.line.id, { matched: true, actual: '' })}
                        className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
                          s.matched ? 'bg-[#3D7A50] text-white' : 'border border-[#D4C5B0] text-brown-medium hover:bg-[#F5EDE0]'
                        }`}
                      >
                        ✓ Matches
                      </button>
                      <button
                        onClick={() => setLineState(l.line.id, { matched: false, actual: s.actual || String(l.inTransit) })}
                        className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
                          !s.matched ? 'bg-[#C4813A] text-white' : 'border border-[#D4C5B0] text-brown-medium hover:bg-[#F5EDE0]'
                        }`}
                      >
                        Doesn't match
                      </button>
                    </div>

                    {!s.matched && (
                      <div className="rounded-xl border border-[#D4C5B0] bg-[#FBF6EE] p-4">
                        <label htmlFor={`recv-${l.line.id}`} className={labelCls}>Actual received</label>
                        <div className="flex items-center gap-2">
                          <input
                            id={`recv-${l.line.id}`}
                            type="number" step="any" min="0" max={l.inTransit}
                            className={`${inputCls} w-32 ${invalid ? 'border-[#9E4A30]' : ''}`}
                            value={s.actual}
                            onChange={e => setLineState(l.line.id, { actual: e.target.value })}
                            placeholder="0"
                            aria-invalid={invalid ? true : undefined}
                          />
                          <span className="text-sm text-brown-muted">{unit}</span>
                        </div>
                        {invalid ? (
                          <p className="text-sm font-semibold text-[#9E4A30] mt-2.5">
                            Enter between 0 and {qty(l.inTransit)} — no more than was shipped.
                          </p>
                        ) : short > 0 && (
                          <p className="text-sm font-bold text-[#9E4A30] bg-[#9E4A3012] border border-[#9E4A3040] rounded-lg px-3 py-2 mt-2.5">
                            Short: {qty(short)} {unit} — will be recorded as lost in transit
                            {shortValue != null && ` (${money(shortValue)} at shipped cost)`}.
                          </p>
                        )}
                      </div>
                    )}

                    {!invalid && actual > 0 && l.conv > 0 && (
                      <p className="text-xs text-brown-faint border-t border-[#EDE5D8] pt-3">
                        Stock in {qty(toBaseUnits(actual, l.conv))} {l.line.item?.base_unit} at the shipped cost
                        {(() => {
                          const v = transferValue(actual, l.conv, l.shippedCost)
                          return v != null ? ` · ${money(v)}` : ''
                        })()}
                      </p>
                    )}
                  </div>
                )
              })}

              {resting.length > 0 && (
                <div className="bg-white rounded-xl border border-[#E8DDD0] p-4 opacity-60">
                  <p className="text-xs font-semibold text-brown-muted mb-1">Nothing in transit on these lines</p>
                  <ul className="text-xs text-brown-faint space-y-0.5">
                    {resting.map(l => (
                      <li key={l.line.id} className="flex justify-between gap-3">
                        <span>{l.line.item?.name ?? 'Unknown item'}</span>
                        <span>
                          Received {qty(Number(l.line.received_quantity))} of {qty(Number(l.line.quantity_ordered))}{' '}
                          {l.line.item?.purchase_unit}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <section className="bg-white rounded-xl border border-[#E8DDD0] p-5 space-y-4">
              <h2 className="text-sm font-bold text-brown-dark">Proof of Delivery</h2>
              <div>
                <label className={labelCls}>Delivery photo *</label>
                <input
                  type="file"
                  accept="image/*"
                  onChange={e => setPhotoFile(e.target.files?.[0] ?? null)}
                  className="text-xs"
                />
                {photoFile
                  ? <p className="text-xs text-[#3D7A50] mt-1">✓ {photoFile.name}</p>
                  : <p className="text-xs text-brown-faint mt-1">Required — a transfer can't be received without a delivery photo.</p>}
              </div>
              <div>
                <label className={labelCls}>Goods photo (optional)</label>
                <input
                  type="file"
                  accept="image/*"
                  onChange={e => setGoodsFile(e.target.files?.[0] ?? null)}
                  className="text-xs"
                />
                {goodsFile && <p className="text-xs text-[#3D7A50] mt-1">✓ {goodsFile.name}</p>}
              </div>
              <div>
                <label htmlFor="internal-receiving-notes" className={labelCls}>Notes{anyLoss ? ' *' : ''}</label>
                <textarea
                  id="internal-receiving-notes"
                  rows={2}
                  className={`${inputCls} resize-none ${noteMissing ? 'border-[#9E4A30]' : ''}`}
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder={anyLoss ? 'e.g. 1 bag torn in the van, thrown away' : 'Optional'}
                  required={anyLoss}
                  aria-invalid={noteMissing ? true : undefined}
                />
                {anyLoss && (
                  <p className={`text-xs mt-1 font-semibold ${noteMissing ? 'text-[#9E4A30]' : 'text-brown-faint'}`}>
                    Note required — explain what was lost in transit
                  </p>
                )}
              </div>
              <p className="text-xs text-brown-faint border-t border-[#EDE5D8] pt-3">
                Signed off by <span className="font-semibold text-brown-muted">{staff?.name ?? '—'}</span>
              </p>
            </section>

            <section className="bg-white rounded-xl border border-[#E8DDD0] p-5">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div>
                  <p className="text-xs text-brown-faint">Received value (shipped cost)</p>
                  <p className="text-xl font-bold text-brown-dark">{money(receivedValue)}</p>
                  {anyLoss && (
                    <p className="text-xs text-[#9E4A30] font-semibold mt-0.5">
                      Lost in transit: {money(lossValue)}
                    </p>
                  )}
                  {validation && <p className="text-xs text-[#9E4A30] font-semibold mt-0.5">{validation}</p>}
                </div>
                <button
                  onClick={submit}
                  disabled={submitting || !!validation}
                  className="px-5 py-2.5 rounded-xl bg-[#3D7A50] text-white text-sm font-semibold hover:bg-[#2E6040] transition-colors disabled:opacity-50"
                >
                  {submitting ? 'Submitting…' : 'Confirm Receipt'}
                </button>
              </div>
              <p className="text-xs text-brown-faint mt-3">
                Submitting adds the stock at HQ's shipped cost and settles everything in transit. Anything short is
                recorded as lost in transit; HQ can re-ship it or a manager can close the order short.
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  )
}
