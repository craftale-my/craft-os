import { useState, useEffect } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { money, qty, calcShortage, priceDelta, toBaseUnits } from '../../shared/lib/procurement'
import type { PurchaseOrder, PurchaseOrderItem, ReceivingLineInput } from '../../shared/types'

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'
const labelCls = 'block text-xs font-semibold text-brown-medium mb-1'

/** Per-line receiving state. `matched` means "arrived exactly as ordered". */
interface LineState {
  matched: boolean
  actual: string
  price: string
}

function LineRow({ line, state, onChange }: {
  line: PurchaseOrderItem
  state: LineState
  onChange: (patch: Partial<LineState>) => void
}) {
  const unit = line.item?.purchase_unit ?? ''
  const actual = state.matched ? line.quantity_ordered : Number(state.actual === '' ? 0 : state.actual)
  const shortage = calcShortage(line.quantity_ordered, actual)
  const price = state.price === '' ? line.unit_price : Number(state.price)
  const delta = priceDelta(line.unit_price, price)
  const conv = line.item?.conversion_rate ?? 0

  return (
    <div className="bg-white rounded-xl border border-[#E8DDD0] p-5 space-y-4">
      <div>
        <p className="text-base font-semibold text-brown-dark">{line.item?.name ?? 'Unknown item'}</p>
        {line.item?.name_zh && <p className="text-xs text-brown-faint">{line.item.name_zh}</p>}
      </div>

      {/* The ordered quantity is the benchmark everything else is judged against. */}
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-brown-faint">应到 Expected</span>
        <span className="text-3xl font-bold text-brown-dark">{qty(line.quantity_ordered)}</span>
        <span className="text-sm text-brown-muted">{unit}</span>
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
          ✓ 数量一致
        </button>
        <button
          onClick={() => onChange({ matched: false, actual: state.actual || String(line.quantity_ordered) })}
          className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
            !state.matched
              ? 'bg-[#C4813A] text-white'
              : 'border border-[#D4C5B0] text-brown-medium hover:bg-[#F5EDE0]'
          }`}
        >
          数量不符
        </button>
      </div>

      {!state.matched && (
        <div className="rounded-xl border border-[#D4C5B0] bg-[#FBF6EE] p-4">
          <label className={labelCls}>实收数量 Actual received</label>
          <div className="flex items-center gap-2">
            <input
              type="number" step="any" min="0"
              className={`${inputCls} w-32`}
              value={state.actual}
              onChange={e => onChange({ actual: e.target.value })}
              placeholder="0"
            />
            <span className="text-sm text-brown-muted">{unit}</span>
          </div>
          {shortage > 0 && (
            <p className="text-sm font-bold text-[#9E4A30] mt-2.5">
              Shortage: {qty(shortage)} {unit}
            </p>
          )}
          {actual > line.quantity_ordered && (
            <p className="text-sm font-semibold text-[#2E6E9E] mt-2.5">
              多到 {qty(actual - line.quantity_ordered)} {unit} — 会按实收数量入库。
            </p>
          )}
        </div>
      )}

      <div>
        <label className={labelCls}>本次单价 Invoice price (RM / {unit})</label>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="number" step="0.01" min="0"
            className={`${inputCls} w-32`}
            value={state.price}
            onChange={e => onChange({ price: e.target.value })}
            placeholder={line.unit_price.toFixed(2)}
          />
          <span className="text-xs text-brown-faint">下单价 {money(line.unit_price)}</span>
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

      {actual > 0 && conv > 0 && (
        <p className="text-xs text-brown-faint border-t border-[#EDE5D8] pt-3">
          入库 {qty(toBaseUnits(actual, conv))} {line.item?.base_unit} · 本行 {money(actual * price)}
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
      if (order.status !== 'sent') {
        setProblem(
          order.status === 'draft'
            ? 'This order is still a draft — mark it as sent before receiving.'
            : `This order has already been closed (${order.status.replace('_', ' ')}).`,
        )
        setPo(order)
        setLoading(false)
        return
      }

      const poLines = (lineRes.data as PurchaseOrderItem[]) ?? []
      setPo(order)
      setLines(poLines)
      // Default every line to "arrived as ordered" — the common case.
      setStates(Object.fromEntries(
        poLines.map(l => [l.id, { matched: true, actual: '', price: '' } as LineState]),
      ))
      setLoading(false)
    }

    load()
    return () => { cancelled = true }
  }, [poId])

  function setLineState(lineId: string, patch: Partial<LineState>) {
    setStates(prev => {
      const current = prev[lineId] ?? { matched: true, actual: '', price: '' }
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

  async function submit() {
    if (!po) return
    if (!invoiceFile) return setError('Invoice / DO photo is required.')

    const payload: ReceivingLineInput[] = lines.map(l => {
      const s = states[l.id] ?? { matched: true, actual: '', price: '' }
      return {
        po_item_id: l.id,
        actual_quantity: s.matched ? l.quantity_ordered : Number(s.actual === '' ? 0 : s.actual),
        unit_price: s.price === '' ? l.unit_price : Number(s.price),
      }
    })

    if (payload.some(l => !(l.actual_quantity >= 0))) {
      return setError('Every line needs a received quantity of zero or more.')
    }
    if (payload.some(l => !(l.unit_price >= 0))) {
      return setError('Unit prices cannot be negative.')
    }

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
    const s = states[l.id] ?? { matched: true, actual: '', price: '' }
    const actual = s.matched ? l.quantity_ordered : Number(s.actual === '' ? 0 : s.actual)
    const price = s.price === '' ? l.unit_price : Number(s.price)
    return {
      value: acc.value + actual * price,
      shortages: acc.shortages + (calcShortage(l.quantity_ordered, actual) > 0 ? 1 : 0),
    }
  }, { value: 0, shortages: 0 })

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-2xl mx-auto px-4 py-8 lg:px-8 space-y-5">
        <div>
          <Link to="/procurement/receiving" className="text-xs text-brown-faint hover:text-[#C4813A] transition-colors">
            ← Receiving
          </Link>
          <h1 className="text-2xl font-bold text-brown-dark mt-1">Receive {po.po_number}</h1>
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
              state={states[l.id] ?? { matched: true, actual: '', price: '' }}
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
              : <p className="text-xs text-brown-faint mt-1">必填 — 没有单据照片不能提交收货。</p>}
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
            签收人 Signed off by <span className="font-semibold text-brown-muted">{staff?.name ?? '—'}</span>
          </p>
        </section>

        <section className="bg-white rounded-xl border border-[#E8DDD0] p-5">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <p className="text-xs text-brown-faint">Received value</p>
              <p className="text-xl font-bold text-brown-dark">{money(totals.value)}</p>
              {totals.shortages > 0 && (
                <p className="text-xs text-[#9E4A30] font-semibold mt-0.5">
                  {totals.shortages} line{totals.shortages > 1 ? 's' : ''} short — the order will close as
                  partially received.
                </p>
              )}
            </div>
            <button
              onClick={submit}
              disabled={submitting || !invoiceFile}
              className="px-5 py-2.5 rounded-xl bg-[#3D7A50] text-white text-sm font-semibold hover:bg-[#2E6040] transition-colors disabled:opacity-50"
            >
              {submitting ? 'Submitting…' : 'Confirm Receipt'}
            </button>
          </div>
          <p className="text-xs text-brown-faint mt-3">
            提交后会入库、记录价格、并关闭这张采购单。Phase 1 每张单只能收一次。
          </p>
        </section>
      </div>
    </div>
  )
}
