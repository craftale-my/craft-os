import { useState, useEffect } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { RECEIVING_PHOTOS_BUCKET } from '../../shared/lib/photos'
import { useAuth } from '../auth/AuthContext'
import {
  money, qty, calcShortage, priceDelta, toBaseUnits, outstandingQty, applyDelivery, isReceivable,
  overQty, deliveryNeedsNote, isInternalSupplier,
} from '../../shared/lib/procurement'
import InternalReceiving from './InternalReceiving'
import Stepper from './Stepper'
import type { PurchaseOrder, PurchaseOrderItem, ReceivingLineInput } from '../../shared/types'

const inputCls =
  'w-full px-3 py-2.5 rounded-xl border border-[#D4C5B0] bg-white text-base text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'
const labelCls = 'block text-[11px] font-bold uppercase tracking-wide text-brown-faint mb-1'

/** Per-line receiving state. `matched` means "everything outstanding arrived". */
interface LineState {
  matched: boolean
  actual: string
  price: string
}

const DEFAULT_STATE: LineState = { matched: true, actual: '', price: '' }

/** Quantity this delivery brings in on a line, in purchase units. */
function actualFor(line: PurchaseOrderItem, s: LineState): number {
  return s.matched ? outstandingQty(line) : Number(s.actual === '' ? 0 : s.actual)
}

function priceFor(line: PurchaseOrderItem, s: LineState): number {
  return s.price === '' ? line.unit_price : Number(s.price)
}

/** The line differs from "all arrived at the ordered price". */
function lineDiffers(line: PurchaseOrderItem, s: LineState): boolean {
  return actualFor(line, s) !== outstandingQty(line) || priceFor(line, s) !== line.unit_price
}

function LineRow({ line, state, open, onToggle, onChange }: {
  line: PurchaseOrderItem
  state: LineState
  open: boolean
  onToggle: () => void
  onChange: (patch: Partial<LineState>) => void
}) {
  const unit = line.item?.purchase_unit ?? ''
  const outstanding = outstandingQty(line)
  const actual = actualFor(line, state)
  const qtyInvalid = !Number.isFinite(actual) || actual < 0
  const shortage = qtyInvalid ? 0 : calcShortage(outstanding, actual)
  const over = qtyInvalid ? 0 : overQty(outstanding, actual)
  const price = priceFor(line, state)
  const delta = priceDelta(line.unit_price, price)
  const differs = lineDiffers(line, state)
  // The PO line's stamped pack size is what submit_receiving converts with.
  const conv = Number(line.conversion_rate_used ?? line.item?.conversion_rate ?? 0)

  return (
    <div
      className={`bg-white rounded-2xl border p-3.5 ${
        differs ? 'border-[#E9B9A8] shadow-[inset_4px_0_0_#9E4A30]' : 'border-[#EDE5D8]'
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-bold text-[15px] text-brown-dark leading-snug">{line.item?.name ?? 'Unknown item'}</p>
          <p className="text-xs text-brown-faint">
            {qty(outstanding)} {unit} {line.received_quantity > 0 ? 'still to come' : 'ordered'}
            {line.received_quantity > 0 && ` · ${qty(line.received_quantity)} received earlier`}
          </p>
          {differs && !open && (
            <p className="text-xs font-semibold text-[#9E4A30] mt-0.5">
              {shortage > 0 && `Arrived ${qty(actual)} · ${qty(shortage)} short`}
              {over > 0 && `Arrived ${qty(actual)} · ${qty(over)} extra`}
              {shortage === 0 && over === 0 && `Price ${money(price)} (ordered ${money(line.unit_price)})`}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={onToggle}
            className="h-11 px-2 text-sm font-bold text-brown-btn"
            aria-expanded={open}
          >
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
              onChange={n => onChange({ matched: false, actual: String(n) })}
              label={`${line.item?.name ?? 'Item'} arrived`}
              tone={differs ? 'warn' : 'normal'}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <label htmlFor={`price-${line.id}`} className="text-sm font-semibold text-brown-muted">
              Invoice price / {unit}
            </label>
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-brown-faint">RM</span>
              <input
                id={`price-${line.id}`}
                type="number" inputMode="decimal" step="0.01" min="0"
                className="w-24 px-2.5 py-2 rounded-lg border border-[#D4C5B0] bg-white text-base text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]"
                value={state.price}
                onChange={e => onChange({ price: e.target.value })}
                placeholder={line.unit_price.toFixed(2)}
              />
            </div>
          </div>
          {delta.direction !== 'same' && (
            <p className={`text-xs font-bold ${delta.direction === 'up' ? 'text-[#9E4A30]' : 'text-[#3D7A50]'}`}>
              {delta.direction === 'up' ? '↑' : '↓'} {money(delta.amount)} vs ordered {money(line.unit_price)}
              {delta.percent !== 0 && ` (${delta.percent > 0 ? '+' : ''}${delta.percent.toFixed(1)}%)`}
            </p>
          )}
          {shortage > 0 && (
            <p className="text-[13px] font-semibold text-[#9E4A30] bg-[#FCF0EC] rounded-lg px-3 py-2">
              {qty(shortage)} {unit} short. The order stays open for the rest.
            </p>
          )}
          {over > 0 && (
            <p className="text-[13px] font-semibold text-[#B46309] bg-[#B4630912] rounded-lg px-3 py-2">
              {qty(over)} {unit} more than expected. The extra is stocked in.
            </p>
          )}
          {!qtyInvalid && actual > 0 && conv > 0 && (
            <p className="text-xs text-brown-faint">
              Stock in {qty(toBaseUnits(actual, conv))} {line.item?.base_unit} · Line total {money(actual * price)}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/** Big tap target that opens the camera (falls back to the file picker). */
function PhotoButton({ file, onFile, title, hint, required }: {
  file: File | null
  onFile: (f: File | null) => void
  title: string
  hint: string
  required?: boolean
}) {
  return (
    <label
      className={`flex items-center gap-3 rounded-2xl p-3.5 cursor-pointer border ${
        file ? 'border-[#B9D6C2] bg-[#EBF5EE]'
          : required ? 'border-dashed border-[#CDB89C] bg-white border-[1.5px]' : 'border-[#EDE5D8] bg-white'
      }`}
    >
      <span className={`w-12 h-12 rounded-xl grid place-items-center shrink-0 ${file ? 'bg-white' : 'bg-[#F5EDE0]'}`}>
        {file ? (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#3D7A50" strokeWidth="2.4" aria-hidden><path d="M5 12l5 5 9-10" /></svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6B4C35" strokeWidth="2" aria-hidden>
            <path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" />
          </svg>
        )}
      </span>
      <span className="min-w-0">
        <span className="block font-bold text-[15px] text-brown-dark">{file ? `${title} added` : title}</span>
        <span className="block text-xs text-brown-muted truncate">{file ? 'Tap to retake' : hint}</span>
      </span>
      <input
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={e => onFile(e.target.files?.[0] ?? null)}
      />
    </label>
  )
}

export default function ReceivingPage() {
  const { poId } = useParams<{ poId: string }>()
  const navigate = useNavigate()
  const { staff } = useAuth()

  const [po, setPo] = useState<PurchaseOrder | null>(null)
  // Only lines with something still outstanding.
  const [lines, setLines] = useState<PurchaseOrderItem[]>([])
  const [states, setStates] = useState<Record<string, LineState>>({})
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null)
  const [goodsFile, setGoodsFile] = useState<File | null>(null)
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  // Internal PO (transfer from HQ): received by InternalReceiving instead.
  const [internal, setInternal] = useState(false)
  // Line opened with Edit (one at a time keeps the screen short).
  const [openId, setOpenId] = useState<string | null>(null)

  useEffect(() => {
    if (!poId) return
    let cancelled = false

    async function load() {
      const [poRes, lineRes] = await Promise.all([
        supabase
          .from('purchase_orders')
          .select('*, supplier:suppliers(id,name,internal_branch_id), branch:branches(id,name)')
          .eq('id', poId)
          .maybeSingle(),
        supabase.from('purchase_order_items').select('*, item:items(*)').eq('po_id', poId),
      ])
      if (cancelled) return

      const order = poRes.data as PurchaseOrder | null
      if (!order) { setProblem('Purchase order not found.'); setLoading(false); return }
      setPo(order)
      if (!isReceivable(order.status)) {
        setProblem(
          order.status === 'draft'
            ? 'This order is still a draft — mark it as sent before receiving.'
            : order.status === 'closed_short'
            ? 'This order was closed short — nothing more can be received on it.'
            : `This order has already been closed (${order.status.replace('_', ' ')}).`,
        )
        setLoading(false)
        return
      }

      if (isInternalSupplier(order.supplier)) {
        setInternal(true)
        setLoading(false)
        return
      }

      const openLines = ((lineRes.data as PurchaseOrderItem[]) ?? []).filter(l => outstandingQty(l) > 0)
      if (openLines.length === 0) {
        setProblem('Nothing is outstanding on this order.')
        setLoading(false)
        return
      }
      setLines(openLines)
      // Default every line to "everything outstanding arrived" — the common case.
      setStates(Object.fromEntries(openLines.map(l => [l.id, DEFAULT_STATE])))
      setLoading(false)
    }

    load()
    return () => { cancelled = true }
  }, [poId])

  function setLineState(lineId: string, patch: Partial<LineState>) {
    setStates(prev => {
      const current = prev[lineId] ?? DEFAULT_STATE
      return { ...prev, [lineId]: { ...current, ...patch } }
    })
  }

  async function uploadPhoto(file: File, kind: string): Promise<string | null> {
    const ext = file.name.split('.').pop() ?? 'jpg'
    const path = `${poId}/${Date.now()}-${kind}.${ext}`
    const { error: upErr } = await supabase.storage
      .from(RECEIVING_PHOTOS_BUCKET)
      .upload(path, file, { contentType: file.type })
    if (upErr) { setError(`Could not upload the ${kind} photo: ${upErr.message}`); return null }
    // The bucket is private: submit the storage path, never a URL.
    return path
  }

  // Every visible line is sent, including zeros (= nothing arrived this time).
  const payload: ReceivingLineInput[] = lines.map(l => {
    const s = states[l.id] ?? DEFAULT_STATE
    return { po_item_id: l.id, actual_quantity: actualFor(l, s), unit_price: priceFor(l, s) }
  })

  // Same checks as the RPC, so the button only enables for a submittable delivery.
  let qtyInvalid = false
  try { applyDelivery(lines, payload) } catch { qtyInvalid = true }
  const priceInvalid = payload.some(l => !(l.unit_price >= 0))
  const nothingReceived = !qtyInvalid && !payload.some(l => l.actual_quantity > 0)
  // submit_receiving requires a note when any line is over-delivered; the
  // screen also asks for one when something is short, so the gap is explained.
  const deliveryLines = lines.map((l, i) => ({ outstanding: outstandingQty(l), actual: payload[i].actual_quantity }))
  const anyShort = !qtyInvalid && deliveryLines.some(l => calcShortage(l.outstanding, l.actual) > 0)
  const needsNote = !qtyInvalid && (deliveryNeedsNote(deliveryLines) || anyShort)
  const noteMissing = needsNote && notes.trim() === ''

  async function submit() {
    if (!po) return
    if (!invoiceFile) return setError('Invoice / DO photo is required.')
    if (qtyInvalid) return setError('Fix the highlighted quantities first.')
    if (priceInvalid) return setError('Unit prices cannot be negative.')
    if (nothingReceived) return setError('Enter a quantity on at least one line.')
    if (noteMissing) return setError('Add a note saying what was short or extra.')

    setSubmitting(true)
    setError('')

    const invoicePath = await uploadPhoto(invoiceFile, 'invoice')
    if (!invoicePath) { setSubmitting(false); return }

    let goodsPath: string | null = null
    if (goodsFile) {
      goodsPath = await uploadPhoto(goodsFile, 'goods')
      if (!goodsPath) { setSubmitting(false); return }
    }

    // One RPC so the receiving record, stock movements, price history and PO
    // status all land in a single transaction.
    const { error: rpcErr } = await supabase.rpc('submit_receiving', {
      p_po_id: po.id,
      p_invoice_photo_url: invoicePath,
      p_goods_photo_url: goodsPath,
      p_notes: notes.trim() || null,
      p_lines: payload,
    })

    setSubmitting(false)
    if (rpcErr) { setError(rpcErr.message); return }
    navigate(`/procurement/orders/${po.id}`)
  }

  if (loading) {
    return <div className="min-h-screen bg-cream-light px-4 py-8 text-center text-sm text-brown-faint">Loading…</div>
  }

  if (problem) {
    return (
      <div className="min-h-screen bg-cream-light px-4 py-8">
        <div className="max-w-2xl mx-auto text-center py-16">
          <p className="text-sm text-brown-muted">{problem}</p>
          <Link
            to={po ? `/procurement/orders/${po.id}` : '/procurement/receiving'}
            className="text-sm text-[#C4813A] font-semibold hover:underline mt-2 inline-block"
          >
            {po ? '← Back to the order' : '← Back to Receiving'}
          </Link>
        </div>
      </div>
    )
  }

  if (!po) return null

  if (internal) return <InternalReceiving po={po} />

  const totals = lines.reduce((acc, l) => {
    const s = states[l.id] ?? DEFAULT_STATE
    const actual = actualFor(l, s)
    return {
      value: acc.value + actual * priceFor(l, s),
      shortages: acc.shortages + (calcShortage(outstandingQty(l), actual) > 0 ? 1 : 0),
      overs: acc.overs + (overQty(outstandingQty(l), actual) > 0 ? 1 : 0),
    }
  }, { value: 0, shortages: 0, overs: 0 })
  const allAsOrdered = lines.every(l => !lineDiffers(l, states[l.id] ?? DEFAULT_STATE))

  function toggle(line: PurchaseOrderItem) {
    if (openId === line.id) {
      // Closing a line that ended up exactly as ordered puts it back to "arrived".
      const s = states[line.id] ?? DEFAULT_STATE
      if (!lineDiffers(line, s)) setLineState(line.id, DEFAULT_STATE)
      setOpenId(null)
    } else {
      setOpenId(line.id)
    }
  }

  const summary = [
    totals.shortages > 0 && `${totals.shortages} short`,
    totals.overs > 0 && `${totals.overs} extra`,
  ].filter(Boolean).join(' · ')

  const blocker = !invoiceFile ? 'Take the invoice photo first.'
    : qtyInvalid ? 'Fix the highlighted quantities.'
    : nothingReceived ? 'At least one line must have arrived.'
    : noteMissing ? 'Add a note saying what was short or extra.'
    : priceInvalid ? 'Unit prices cannot be negative.'
    : ''

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-xl mx-auto px-3 pt-5 pb-4 sm:px-4 space-y-3">
        <div>
          <Link to="/procurement/receiving" className="text-sm text-brown-faint hover:text-[#C4813A]">
            ← Receiving
          </Link>
          <h1 className="text-xl font-bold text-brown-dark mt-1">
            {po.status === 'partially_received' ? 'Receive the rest of' : 'Receive'} {po.po_number}
          </h1>
          <p className="text-sm text-brown-muted">
            {po.supplier?.name ?? '—'} · {po.branch?.name ?? '—'}
          </p>
        </div>

        {error && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-2.5">{error}</p>
        )}

        <PhotoButton
          file={invoiceFile}
          onFile={setInvoiceFile}
          title="Photo of invoice"
          hint="Required · opens the camera"
          required
        />

        <p className="text-xs font-bold uppercase tracking-wide text-brown-muted px-1 pt-1">
          {lines.length} item{lines.length > 1 ? 's' : ''}
        </p>
        <div className="space-y-2">
          {lines.map(l => (
            <LineRow
              key={l.id}
              line={l}
              state={states[l.id] ?? DEFAULT_STATE}
              open={openId === l.id}
              onToggle={() => toggle(l)}
              onChange={patch => setLineState(l.id, patch)}
            />
          ))}
        </div>
        {allAsOrdered && (
          <p className="text-[13px] text-brown-muted px-1">
            Something missing, extra or a different price? Tap <span className="font-bold">Edit</span> on that line only.
          </p>
        )}

        <div>
          <label htmlFor="receiving-notes" className={`${labelCls} px-1`}>
            {needsNote ? 'Note (needed: something is short or extra)' : 'Note (optional)'}
          </label>
          <textarea
            id="receiving-notes"
            rows={2}
            className={`${inputCls} resize-none ${noteMissing ? 'border-[#B46309]' : ''}`}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder={needsNote
              ? 'e.g. Supplier will send the other carton tomorrow'
              : 'e.g. 2 packs damaged, driver noted it'}
            required={needsNote}
            aria-invalid={noteMissing ? true : undefined}
          />
        </div>

        <PhotoButton
          file={goodsFile}
          onFile={setGoodsFile}
          title="Goods photo"
          hint="Optional"
        />

        <p className="text-xs text-brown-faint px-1">
          Signed off by <span className="font-semibold text-brown-muted">{staff?.name ?? '—'}</span>.
          Confirming adds the stock and records the invoice prices.
        </p>
      </div>

      <div className="sticky bottom-0 bg-white border-t border-[#EDE5D8] px-3.5 pt-3 pb-4">
        <div className="max-w-xl mx-auto">
          <div className="flex justify-between text-[13px] text-brown-muted mb-2.5">
            <span>Invoice total{summary ? ` · ${summary}` : ''}</span>
            <span className="text-base font-bold text-brown-dark">{money(totals.value)}</span>
          </div>
          <button
            type="button"
            onClick={submit}
            disabled={submitting || !!blocker}
            className="w-full h-[52px] rounded-2xl bg-[#3D7A50] text-white text-base font-bold active:bg-[#2E6040] disabled:opacity-45"
          >
            {submitting ? 'Submitting…' : allAsOrdered ? 'All arrived — confirm' : 'Confirm delivery'}
          </button>
          {blocker && !submitting && (
            <p className="text-xs text-center text-brown-muted mt-2">{blocker}</p>
          )}
        </div>
      </div>
    </div>
  )
}
