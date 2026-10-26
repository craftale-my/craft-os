import { useState, useEffect } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from '../auth/AuthContext'
import {
  money, qty, calcShortage, priceDelta, toBaseUnits, outstandingQty, applyDelivery, isReceivable,
} from '../../shared/lib/procurement'
import type { PurchaseOrder, PurchaseOrderItem, ReceivingLineInput } from '../../shared/types'

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'
const labelCls = 'block text-xs font-semibold text-brown-medium mb-1'

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

/** Inline problem with a line's quantity, or null if it can be submitted. */
function lineQtyError(line: PurchaseOrderItem, s: LineState): string | null {
  const actual = actualFor(line, s)
  if (!Number.isFinite(actual) || actual < 0) return 'Enter zero or more.'
  const outstanding = outstandingQty(line)
  if (actual > outstanding) {
    return `Only ${qty(outstanding)} ${line.item?.purchase_unit ?? ''} outstanding — you can't receive more than that.`
  }
  return null
}

function LineRow({ line, state, onChange }: {
  line: PurchaseOrderItem
  state: LineState
  onChange: (patch: Partial<LineState>) => void
}) {
  const unit = line.item?.purchase_unit ?? ''
  const outstanding = outstandingQty(line)
  const actual = actualFor(line, state)
  const qtyError = lineQtyError(line, state)
  const shortage = qtyError ? 0 : calcShortage(outstanding, actual)
  const price = priceFor(line, state)
  const delta = priceDelta(line.unit_price, price)
  // The PO line's stamped pack size is what submit_receiving converts with.
  const conv = Number(line.conversion_rate_used ?? line.item?.conversion_rate ?? 0)

  return (
    <div className="bg-white rounded-xl border border-[#E8DDD0] p-5 space-y-4">
      <div>
        <p className="text-base font-semibold text-brown-dark">{line.item?.name ?? 'Unknown item'}</p>
        {line.item?.name_zh && <p className="text-xs text-brown-faint">{line.item.name_zh}</p>}
      </div>

      {/* What is still outstanding is the benchmark this delivery is judged against. */}
      <div>
        <div className="flex items-baseline gap-2">
          <span className="text-xs text-brown-faint">Expected</span>
          <span className="text-3xl font-bold text-brown-dark">{qty(outstanding)}</span>
          <span className="text-sm text-brown-muted">{unit}</span>
        </div>
        {line.received_quantity > 0 && (
          <p className="text-xs text-brown-faint mt-0.5">
            Ordered {qty(line.quantity_ordered)} · Received so far {qty(line.received_quantity)}
          </p>
        )}
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => onChange({ matched: true, actual: '' })}
          className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
            state.matched
              ? 'bg-[#3D7A50] text-white'
              : 'border border-[#D4C5B0] text-brown-medium hover:bg-[#F5EDE0]'
          }`}
        >
          ✓ Matches
        </button>
        <button
          onClick={() => onChange({ matched: false, actual: state.actual || String(outstanding) })}
          className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
            !state.matched
              ? 'bg-[#C4813A] text-white'
              : 'border border-[#D4C5B0] text-brown-medium hover:bg-[#F5EDE0]'
          }`}
        >
          Doesn't match
        </button>
      </div>

      {!state.matched && (
        <div className="rounded-xl border border-[#D4C5B0] bg-[#FBF6EE] p-4">
          <label className={labelCls}>Actual received</label>
          <div className="flex items-center gap-2">
            <input
              type="number" step="any" min="0" max={outstanding}
              className={`${inputCls} w-32 ${qtyError ? 'border-[#9E4A30]' : ''}`}
              value={state.actual}
              onChange={e => onChange({ actual: e.target.value })}
              placeholder="0"
              aria-invalid={qtyError ? true : undefined}
            />
            <span className="text-sm text-brown-muted">{unit}</span>
          </div>
          {qtyError ? (
            <p className="text-sm font-semibold text-[#9E4A30] mt-2.5">{qtyError}</p>
          ) : shortage > 0 && (
            <p className="text-sm font-bold text-[#9E4A30] mt-2.5">
              Shortage: {qty(shortage)} {unit} — stays outstanding for a later delivery.
            </p>
          )}
        </div>
      )}

      <div>
        <label className={labelCls}>Invoice price (RM / {unit})</label>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="number" step="0.01" min="0"
            className={`${inputCls} w-32`}
            value={state.price}
            onChange={e => onChange({ price: e.target.value })}
            placeholder={line.unit_price.toFixed(2)}
          />
          <span className="text-xs text-brown-faint">Ordered at {money(line.unit_price)}</span>
          {delta.direction !== 'same' && (
            <span
              className="text-xs font-bold px-2 py-0.5 rounded-full"
              style={{
                background: delta.direction === 'up' ? '#9E4A3020' : '#3D7A5020',
                color: delta.direction === 'up' ? '#9E4A30' : '#3D7A50',
              }}
            >
              {delta.direction === 'up' ? '↑' : '↓'} {money(delta.amount)}
              {delta.percent !== 0 && ` (${delta.percent > 0 ? '+' : ''}${delta.percent.toFixed(1)}%)`}
            </span>
          )}
        </div>
      </div>

      {!qtyError && actual > 0 && conv > 0 && (
        <p className="text-xs text-brown-faint border-t border-[#EDE5D8] pt-3">
          Stock in {qty(toBaseUnits(actual, conv))} {line.item?.base_unit} · Line total {money(actual * price)}
        </p>
      )}
    </div>
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

  useEffect(() => {
    if (!poId) return
    let cancelled = false

    async function load() {
      const [poRes, lineRes] = await Promise.all([
        supabase
          .from('purchase_orders')
          .select('*, supplier:suppliers(id,name), branch:branches(id,name)')
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
            : `This order has already been closed (${order.status.replace('_', ' ')}).`,
        )
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
      .from('receiving-photos')
      .upload(path, file, { contentType: file.type })
    if (upErr) { setError(`Could not upload the ${kind} photo: ${upErr.message}`); return null }
    return supabase.storage.from('receiving-photos').getPublicUrl(path).data.publicUrl
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

  async function submit() {
    if (!po) return
    if (!invoiceFile) return setError('Invoice / DO photo is required.')
    if (qtyInvalid) return setError('Fix the highlighted quantities first.')
    if (priceInvalid) return setError('Unit prices cannot be negative.')
    if (nothingReceived) return setError('Enter a quantity on at least one line.')

    setSubmitting(true)
    setError('')

    const invoiceUrl = await uploadPhoto(invoiceFile, 'invoice')
    if (!invoiceUrl) { setSubmitting(false); return }

    let goodsUrl: string | null = null
    if (goodsFile) {
      goodsUrl = await uploadPhoto(goodsFile, 'goods')
      if (!goodsUrl) { setSubmitting(false); return }
    }

    // One RPC so the receiving record, stock movements, price history and PO
    // status all land in a single transaction.
    const { error: rpcErr } = await supabase.rpc('submit_receiving', {
      p_po_id: po.id,
      p_invoice_photo_url: invoiceUrl,
      p_goods_photo_url: goodsUrl,
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

  const totals = lines.reduce((acc, l) => {
    const s = states[l.id] ?? DEFAULT_STATE
    const actual = actualFor(l, s)
    return {
      value: acc.value + actual * priceFor(l, s),
      shortages: acc.shortages + (calcShortage(outstandingQty(l), actual) > 0 ? 1 : 0),
    }
  }, { value: 0, shortages: 0 })

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-2xl mx-auto px-4 py-8 lg:px-8 space-y-5">
        <div>
          <Link to="/procurement/receiving" className="text-xs text-brown-faint hover:text-[#C4813A] transition-colors">
            ← Receiving
          </Link>
          <h1 className="text-2xl font-bold text-brown-dark mt-1">
            {po.status === 'partially_received' ? 'Receive remaining' : 'Receive'} {po.po_number}
          </h1>
          <p className="text-sm text-brown-muted">
            {po.supplier?.name ?? '—'} · {po.branch?.name ?? '—'}
          </p>
        </div>

        {error && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">{error}</p>
        )}

        <div className="space-y-3">
          {lines.map(l => (
            <LineRow
              key={l.id}
              line={l}
              state={states[l.id] ?? DEFAULT_STATE}
              onChange={patch => setLineState(l.id, patch)}
            />
          ))}
        </div>

        <section className="bg-white rounded-xl border border-[#E8DDD0] p-5 space-y-4">
          <h2 className="text-sm font-bold text-brown-dark">Proof of Delivery</h2>

          <div>
            <label className={labelCls}>Invoice / DO photo *</label>
            <input
              type="file"
              accept="image/*"
              onChange={e => setInvoiceFile(e.target.files?.[0] ?? null)}
              className="text-xs"
            />
            {invoiceFile
              ? <p className="text-xs text-[#3D7A50] mt-1">✓ {invoiceFile.name}</p>
              : <p className="text-xs text-brown-faint mt-1">Required — a receipt can't be submitted without an invoice photo.</p>}
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
            <label className={labelCls}>Notes</label>
            <textarea
              rows={2}
              className={`${inputCls} resize-none`}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="e.g. 2 packs damaged, driver noted it"
            />
          </div>

          <p className="text-xs text-brown-faint border-t border-[#EDE5D8] pt-3">
            Signed off by <span className="font-semibold text-brown-muted">{staff?.name ?? '—'}</span>
          </p>
        </section>

        <section className="bg-white rounded-xl border border-[#E8DDD0] p-5">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <p className="text-xs text-brown-faint">Received value</p>
              <p className="text-xl font-bold text-brown-dark">{money(totals.value)}</p>
              {!qtyInvalid && totals.shortages > 0 && (
                <p className="text-xs text-[#9E4A30] font-semibold mt-0.5">
                  {totals.shortages} line{totals.shortages > 1 ? 's' : ''} short — the order stays open as
                  partially received for the rest.
                </p>
              )}
              {qtyInvalid && (
                <p className="text-xs text-[#9E4A30] font-semibold mt-0.5">
                  Fix the highlighted quantities before submitting.
                </p>
              )}
              {nothingReceived && (
                <p className="text-xs text-[#9E4A30] font-semibold mt-0.5">
                  Enter a quantity on at least one line — a delivery has to bring something in.
                </p>
              )}
            </div>
            <button
              onClick={submit}
              disabled={submitting || !invoiceFile || qtyInvalid || priceInvalid || nothingReceived}
              className="px-5 py-2.5 rounded-xl bg-[#3D7A50] text-white text-sm font-semibold hover:bg-[#2E6040] transition-colors disabled:opacity-50"
            >
              {submitting ? 'Submitting…' : 'Confirm Receipt'}
            </button>
          </div>
          <p className="text-xs text-brown-faint mt-3">
            Submitting adds the stock, records the invoice prices and updates the order. Anything still short
            stays open for a later delivery.
          </p>
        </section>
      </div>
    </div>
  )
}
