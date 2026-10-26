import { useState, useEffect } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from '../auth/AuthContext'
import {
  money, qty, toBaseUnits, toPurchaseUnits, toShipQty, isInternalSupplier, canAccessBranch, validateShipLines,
  formatUnitCost,
} from '../../shared/lib/procurement'
import { InternalBadge } from './badges'
import type { InventoryValuation, PurchaseOrder, PurchaseOrderItem, ShipLineInput } from '../../shared/types'

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'
const labelCls = 'block text-xs font-semibold text-brown-medium mb-1'

/** HQ stock of one item: base units on hand and moving-average cost. */
interface HqStock {
  balance: number
  avgCost: number | null
}

function convOf(line: PurchaseOrderItem): number {
  return Number(line.conversion_rate_used ?? line.item?.conversion_rate ?? 0)
}

/** Rounds down to 3 decimals so a default never exceeds what is on hand. */
function floor3(n: number): number {
  return Math.floor(n * 1000) / 1000
}

export default function TransferShipPage() {
  const { poId } = useParams<{ poId: string }>()
  const navigate = useNavigate()
  const { staff } = useAuth()

  const [po, setPo] = useState<PurchaseOrder | null>(null)
  const [lines, setLines] = useState<PurchaseOrderItem[]>([])
  const [stock, setStock] = useState<Map<string, HqStock> | null>(null)
  const [quantities, setQuantities] = useState<Record<string, string>>({})
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
          .select('*, supplier:suppliers(*), branch:branches(id,name)')
          .eq('id', poId)
          .maybeSingle(),
        supabase.from('purchase_order_items').select('*, item:items(*)').eq('po_id', poId),
      ])
      if (cancelled) return

      const order = poRes.data as PurchaseOrder | null
      if (!order) { setProblem('Purchase order not found.'); setLoading(false); return }
      setPo(order)
      if (!isInternalSupplier(order.supplier)) {
        setProblem('Only internal purchase orders (to HQ) can be shipped.')
        setLoading(false)
        return
      }
      const fromBranch = order.supplier!.internal_branch_id!
      if (!canAccessBranch(staff, fromBranch)) {
        setProblem('Only HQ staff can ship this order.')
        setLoading(false)
        return
      }

      const all = (lineRes.data as PurchaseOrderItem[]) ?? []
      if (!all.some(l => toShipQty(l, order.status) > 0)) {
        setProblem(order.status === 'draft'
          ? 'This order is still a draft — the branch has not sent it to HQ yet.'
          : 'Nothing is left to ship on this order.')
        setLoading(false)
        return
      }

      const { data: valData, error: valErr } = await supabase
        .from('inventory_valuation')
        .select('*')
        .eq('branch_id', fromBranch)
        .in('item_id', all.map(l => l.item_id))
      if (cancelled) return

      // Null = unknown: no on-hand defaults or warnings, the RPC still checks.
      const byItem = valErr ? null : new Map(((valData as InventoryValuation[]) ?? []).map(v => [v.item_id, {
        balance: Number(v.balance),
        avgCost: v.avg_unit_cost == null ? null : Number(v.avg_unit_cost),
      }]))
      setStock(byItem)
      setLines(all)
      // Default: everything left to ship, capped at what HQ holds.
      setQuantities(Object.fromEntries(all.map(l => {
        const toShip = toShipQty(l, order.status)
        const onHand = byItem ? toPurchaseUnits(byItem.get(l.item_id)?.balance ?? 0, convOf(l)) : toShip
        return [l.id, String(Math.max(0, floor3(Math.min(toShip, onHand))))]
      })))
      setLoading(false)
    }

    load()
    return () => { cancelled = true }
  }, [poId, staff?.id, staff?.branch_id, staff?.system_role, staff?.rank])

  if (loading) {
    return <div className="min-h-screen bg-cream-light px-4 py-8 text-center text-sm text-brown-faint">Loading…</div>
  }

  if (problem || !po) {
    return (
      <div className="min-h-screen bg-cream-light px-4 py-8">
        <div className="max-w-2xl mx-auto text-center py-16">
          <p className="text-sm text-brown-muted">{problem || 'Purchase order not found.'}</p>
          <Link
            to={po ? `/procurement/orders/${po.id}` : '/procurement/transfers'}
            className="text-sm text-[#C4813A] font-semibold hover:underline mt-2 inline-block"
          >
            {po ? '← Back to the order' : '← Back to Transfers'}
          </Link>
        </div>
      </div>
    )
  }

  const shippable = lines.filter(l => toShipQty(l, po.status) > 0)
  const qtyOf = (l: PurchaseOrderItem) => {
    const raw = quantities[l.id] ?? ''
    return raw.trim() === '' ? 0 : Number(raw)
  }
  const validation = validateShipLines(shippable.map(l => ({
    quantity: qtyOf(l),
    toShip: toShipQty(l, po.status),
    name: l.item?.name,
    unit: l.item?.purchase_unit,
  })))
  const overOnHand = stock == null ? [] : shippable.filter(l => {
    const held = stock.get(l.item_id)?.balance ?? 0
    return toBaseUnits(qtyOf(l), convOf(l)) > held
  })
  const estTotal = shippable.reduce((s, l) => {
    const cost = stock?.get(l.item_id)?.avgCost
    const q = qtyOf(l)
    return cost == null || !(q > 0) ? s : s + toBaseUnits(q, convOf(l)) * cost
  }, 0)

  async function submit() {
    if (!po || validation) return
    setSubmitting(true)
    setError('')
    const payload: ShipLineInput[] = shippable
      .filter(l => qtyOf(l) > 0)
      .map(l => ({ po_item_id: l.id, quantity: qtyOf(l) }))
    // One RPC: shipment, transfer_out at HQ and shipped quantities in one transaction.
    const { error: rpcErr } = await supabase.rpc('ship_internal_po', {
      p_po_id: po.id,
      p_lines: payload,
      p_notes: notes.trim() || null,
    })
    setSubmitting(false)
    if (rpcErr) { setError(rpcErr.message); return }
    navigate(`/procurement/orders/${po.id}`, {
      state: { toast: `Shipped ${payload.length} line${payload.length > 1 ? 's' : ''} to ${po.branch?.name ?? 'the branch'}` },
    })
  }

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-3xl mx-auto px-4 py-8 lg:px-8 space-y-5">
        <div>
          <Link to="/procurement/transfers" className="text-xs text-brown-faint hover:text-[#C4813A] transition-colors">
            ← Transfers
          </Link>
          <h1 className="text-2xl font-bold text-brown-dark mt-1 flex items-center gap-2">
            Ship {po.po_number} <InternalBadge />
          </h1>
          <p className="text-sm text-brown-muted">
            From {po.supplier?.name ?? 'HQ'} → {po.branch?.name ?? '—'}
          </p>
        </div>

        {error && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">{error}</p>
        )}

        <div className="space-y-3">
          {lines.map(l => {
            const unit = l.item?.purchase_unit ?? ''
            const baseUnit = l.item?.base_unit ?? ''
            const conv = convOf(l)
            const toShip = toShipQty(l, po.status)
            const held = stock?.get(l.item_id)
            const heldBase = held?.balance ?? 0
            const q = qtyOf(l)
            const over = stock != null && toBaseUnits(q, conv) > heldBase
            const est = held?.avgCost != null && q > 0 ? toBaseUnits(q, conv) * held.avgCost : null
            const done = toShip <= 0
            return (
              <div
                key={l.id}
                className={`bg-white rounded-xl border border-[#E8DDD0] p-5 space-y-3 ${done ? 'opacity-50' : ''}`}
              >
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <p className="text-base font-semibold text-brown-dark">{l.item?.name ?? 'Unknown item'}</p>
                  <p className="text-xs text-brown-faint">1 {unit} = {qty(conv)} {baseUnit}</p>
                </div>
                <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <div><dt className="text-brown-faint">Ordered</dt><dd className="font-semibold text-brown-dark">{qty(Number(l.quantity_ordered))} {unit}</dd></div>
                  <div><dt className="text-brown-faint">Already shipped</dt><dd className="font-semibold text-brown-dark">{qty(Number(l.shipped_quantity ?? 0))} {unit}</dd></div>
                  <div><dt className="text-brown-faint">Left to ship</dt><dd className="font-semibold text-brown-dark">{qty(toShip)} {unit}</dd></div>
                  <div>
                    <dt className="text-brown-faint">HQ on hand</dt>
                    <dd className="font-semibold text-brown-dark">
                      {stock == null ? '—' : <>{qty(toPurchaseUnits(heldBase, conv))} {unit} <span className="font-normal text-brown-faint">({qty(heldBase)} {baseUnit})</span></>}
                    </dd>
                  </div>
                </dl>
                {done ? (
                  <p className="text-xs text-brown-faint">Fully shipped.</p>
                ) : (
                  <div>
                    <label htmlFor={`ship-${l.id}`} className={labelCls}>Quantity to ship</label>
                    <div className="flex items-center gap-2 flex-wrap">
                      <input
                        id={`ship-${l.id}`}
                        type="number" step="any" min="0" inputMode="decimal"
                        className={`${inputCls} w-32 ${over ? 'border-[#B46309]' : ''}`}
                        value={quantities[l.id] ?? ''}
                        onChange={e => setQuantities(prev => ({ ...prev, [l.id]: e.target.value }))}
                        placeholder="0"
                      />
                      <span className="text-sm text-brown-muted">{unit}</span>
                      <span className="text-xs text-brown-faint">
                        {est != null
                          ? <>≈ {money(est)} at HQ avg cost {formatUnitCost(held?.avgCost ?? null, baseUnit)}</>
                          : q > 0 ? 'No cost on record at HQ' : null}
                      </span>
                    </div>
                    {over && (
                      <p className="text-xs font-semibold text-[#B46309] mt-1.5">
                        More than HQ has on hand ({qty(heldBase)} {baseUnit}) — shipping will be refused.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <section className="bg-white rounded-xl border border-[#E8DDD0] p-5 space-y-4">
          <div>
            <label htmlFor="ship-notes" className={labelCls}>Notes (optional)</label>
            <textarea
              id="ship-notes"
              rows={2}
              className={`${inputCls} resize-none`}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="e.g. Sent by Lalamove, driver Ali"
            />
          </div>
          <div className="flex items-center justify-between gap-4 flex-wrap border-t border-[#EDE5D8] pt-4">
            <div>
              <p className="text-xs text-brown-faint">Est. value shipped</p>
              <p className="text-xl font-bold text-brown-dark">{money(estTotal)}</p>
              {validation && <p className="text-xs text-[#9E4A30] font-semibold mt-0.5">{validation}</p>}
              {!validation && overOnHand.length > 0 && (
                <p className="text-xs text-[#B46309] font-semibold mt-0.5">
                  {overOnHand.length} line{overOnHand.length > 1 ? 's' : ''} above HQ on hand.
                </p>
              )}
            </div>
            <button
              onClick={submit}
              disabled={submitting || !!validation}
              className="px-5 py-2.5 rounded-xl bg-[#2E6E9E] text-white text-sm font-semibold hover:bg-[#24587F] transition-colors disabled:opacity-50"
            >
              {submitting ? 'Shipping…' : 'Confirm shipment'}
            </button>
          </div>
          <p className="text-xs text-brown-faint">
            Shipping takes the stock out of HQ at its current average cost. It enters the branch when they receive it.
          </p>
        </section>
      </div>
    </div>
  )
}
