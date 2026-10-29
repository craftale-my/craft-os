import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { RECEIVING_PHOTOS_BUCKET } from '../../shared/lib/photos'
import { useAuth } from '../auth/AuthContext'
import {
  money, qty, toBaseUnits, transferValue, transitShortQty, validateInternalReceipt, canAccessBranch,
} from '../../shared/lib/procurement'
import { InternalBadge } from './badges'
import Stepper from './Stepper'
import PhotoButton from './PhotoButton'
import type { PoTransferLine, PurchaseOrder, PurchaseOrderItem } from '../../shared/types'

const inputCls =
  'w-full px-3 py-2.5 rounded-xl border border-[#D4C5B0] bg-white text-base text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'
const labelCls = 'block text-[11px] font-bold uppercase tracking-wide text-brown-faint mb-1'

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
  // Line opened with Edit.
  const [openId, setOpenId] = useState<string | null>(null)

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

  const allArrived = !anyLoss

  function toggle(l: Line) {
    if (openId === l.line.id) {
      // Closing a line that ended up as shipped puts it back to "arrived".
      const s = states[l.line.id] ?? DEFAULT_STATE
      if (actualFor(l, s) === l.inTransit) setLineState(l.line.id, DEFAULT_STATE)
      setOpenId(null)
    } else {
      setOpenId(l.line.id)
    }
  }

  const header = (
    <div>
      <Link to="/procurement/receiving" className="text-sm text-brown-faint hover:text-[#C4813A]">
        ← Receiving
      </Link>
      <h1 className="text-xl font-bold text-brown-dark mt-1 flex items-center gap-2 flex-wrap">
        Receive {po.po_number} <InternalBadge />
      </h1>
      <p className="text-sm text-brown-muted">
        Transfer from {po.supplier?.name ?? 'HQ'} · {po.branch?.name ?? '—'}
      </p>
    </div>
  )

  if (!ownsPo || moving.length === 0) {
    return (
      <div className="min-h-screen bg-cream-light">
        <div className="max-w-xl mx-auto px-3 pt-5 pb-4 sm:px-4 space-y-3">
          {header}
          <div className="bg-white rounded-2xl border border-[#EDE5D8] px-5 py-8 text-center">
            {!ownsPo ? (
              <p className="text-sm text-brown-muted">Only {po.branch?.name ?? 'the receiving branch'} can receive this transfer.</p>
            ) : (
              <>
                <p className="text-sm font-semibold text-brown-dark">Waiting for HQ to ship</p>
                <p className="text-xs text-brown-faint mt-1">Nothing has been shipped on this order yet, so there is nothing to receive.</p>
              </>
            )}
            <Link to={`/procurement/orders/${po.id}`} className="text-sm text-[#C4813A] font-semibold hover:underline mt-3 inline-block">
              ← Back to the order
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-xl mx-auto px-3 pt-5 pb-4 sm:px-4 space-y-3">
        {header}

        {error && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-2.5">{error}</p>
        )}

        <PhotoButton
          file={photoFile}
          onFile={setPhotoFile}
          title="Delivery photo"
          hint="Required · opens the camera"
          required
        />

        <p className="text-xs font-bold uppercase tracking-wide text-brown-muted px-1 pt-1">
          {moving.length} item{moving.length > 1 ? 's' : ''} on the way
        </p>
        <div className="space-y-2">
          {moving.map((l, i) => {
            const unit = l.line.item?.purchase_unit ?? ''
            const actual = checks[i].actual
            const invalid = !Number.isFinite(actual) || actual < 0 || actual > l.inTransit
            const short = invalid ? 0 : transitShortQty(l.inTransit, actual)
            const shortValue = transferValue(short, l.conv, l.shippedCost)
            const differs = invalid || short > 0
            const open = openId === l.line.id
            return (
              <div
                key={l.line.id}
                className={`bg-white rounded-2xl border p-3.5 ${
                  differs ? 'border-[#E9B9A8] shadow-[inset_4px_0_0_#9E4A30]' : 'border-[#EDE5D8]'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-bold text-[15px] text-brown-dark leading-snug">{l.line.item?.name ?? 'Unknown item'}</p>
                    <p className="text-xs text-brown-faint">{qty(l.inTransit)} {unit} shipped by HQ</p>
                    {differs && !open && (
                      <p className="text-xs font-semibold text-[#9E4A30] mt-0.5">
                        {invalid ? 'Check the quantity' : `Arrived ${qty(actual)} · ${qty(short)} lost on the way`}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <button type="button" onClick={() => toggle(l)} className="h-11 px-2 text-sm font-bold text-brown-btn" aria-expanded={open}>
                      {open ? 'Done' : 'Edit'}
                    </button>
                    <span
                      aria-hidden
                      className={`w-8 h-8 rounded-full grid place-items-center font-extrabold ${
                        differs ? 'bg-[#FCF0EC] text-[#9E4A30]' : 'bg-[#EBF5EE] text-[#3D7A50]'
                      }`}
                    >
                      {differs ? '!' : '✓'}
                    </span>
                  </div>
                </div>

                {open && (
                  <div className="mt-3 pt-3 border-t border-[#E8DDD0] space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-semibold text-brown-muted">
                        Arrived
                        <span className="block text-xs font-normal text-brown-faint">{unit}</span>
                      </span>
                      <Stepper
                        value={Number.isFinite(actual) ? actual : 0}
                        max={l.inTransit}
                        onChange={n => setLineState(l.line.id, { matched: false, actual: String(n) })}
                        label={`${l.line.item?.name ?? 'Item'} arrived`}
                        tone={differs ? 'warn' : 'normal'}
                      />
                    </div>
                    {invalid ? (
                      <p className="text-[13px] font-semibold text-[#9E4A30] bg-[#FCF0EC] rounded-lg px-3 py-2">
                        Enter between 0 and {qty(l.inTransit)}, no more than was shipped.
                      </p>
                    ) : short > 0 && (
                      <p className="text-[13px] font-semibold text-[#9E4A30] bg-[#FCF0EC] rounded-lg px-3 py-2">
                        {qty(short)} {unit} lost on the way{shortValue != null && ` (${money(shortValue)} at shipped cost)`}.
                        HQ can send it again.
                      </p>
                    )}
                    {!invalid && actual > 0 && l.conv > 0 && (
                      <p className="text-xs text-brown-faint">
                        Stock in {qty(toBaseUnits(actual, l.conv))} {l.line.item?.base_unit} at the shipped cost
                        {(() => {
                          const v = transferValue(actual, l.conv, l.shippedCost)
                          return v != null ? ` · ${money(v)}` : ''
                        })()}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        {allArrived && (
          <p className="text-[13px] text-brown-muted px-1">
            Something missing or broken? Tap <span className="font-bold">Edit</span> on that line only.
          </p>
        )}

        {resting.length > 0 && (
          <div className="rounded-2xl border border-[#EDE5D8] bg-white/60 p-3.5">
            <p className="text-xs font-semibold text-brown-muted mb-1">Not shipped yet</p>
            <ul className="text-xs text-brown-faint space-y-0.5">
              {resting.map(l => (
                <li key={l.line.id} className="flex justify-between gap-3">
                  <span>{l.line.item?.name ?? 'Unknown item'}</span>
                  <span className="whitespace-nowrap">
                    {qty(Number(l.line.received_quantity))} of {qty(Number(l.line.quantity_ordered))} {l.line.item?.purchase_unit}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <label htmlFor="internal-receiving-notes" className={`${labelCls} px-1`}>
            {anyLoss ? 'Note (needed: what was lost on the way)' : 'Note (optional)'}
          </label>
          <textarea
            id="internal-receiving-notes"
            rows={2}
            className={`${inputCls} resize-none ${noteMissing ? 'border-[#9E4A30]' : ''}`}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder={anyLoss ? 'e.g. 1 bag torn in the van, thrown away' : 'Anything to tell HQ'}
            required={anyLoss}
            aria-invalid={noteMissing ? true : undefined}
          />
        </div>

        <PhotoButton file={goodsFile} onFile={setGoodsFile} title="Goods photo" hint="Optional" />

        <p className="text-xs text-brown-faint px-1">
          Signed off by <span className="font-semibold text-brown-muted">{staff?.name ?? '—'}</span>.
          Stock comes in at HQ&apos;s shipped cost; anything short is recorded as lost on the way.
        </p>
      </div>

      <div className="sticky bottom-0 bg-white border-t border-[#EDE5D8] px-3.5 pt-3 pb-4">
        <div className="max-w-xl mx-auto">
          <div className="flex justify-between text-[13px] text-brown-muted mb-2.5">
            <span>Received value{anyLoss ? ` · lost ${money(lossValue)}` : ''}</span>
            <span className="text-base font-bold text-brown-dark">{money(receivedValue)}</span>
          </div>
          <button
            type="button"
            onClick={submit}
            disabled={submitting || !!validation}
            className="w-full h-[52px] rounded-2xl bg-[#3D7A50] text-white text-base font-bold active:bg-[#2E6040] disabled:opacity-45"
          >
            {submitting ? 'Submitting…' : allArrived ? 'All arrived — confirm' : 'Confirm receipt'}
          </button>
          {validation && !submitting && (
            <p className="text-xs text-center text-brown-muted mt-2">{validation}</p>
          )}
        </div>
      </div>
    </div>
  )
}
