import { useState, useEffect } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from '../auth/AuthContext'
import {
  money, qty, toBaseUnits, toPurchaseUnits, toShipQty, isInternalSupplier, canAccessBranch, validateShipLines,
  formatUnitCost, packs,
} from '../../shared/lib/procurement'
import { InternalBadge } from './badges'
import Stepper from './Stepper'
import type { InventoryValuation, PurchaseOrder, PurchaseOrderItem, ShipLineInput } from '../../shared/types'

const inputCls =
  'w-full px-3 py-2.5 rounded-xl border border-[#D4C5B0] bg-white text-base text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'
const labelCls = 'block text-[11px] font-bold uppercase tracking-wide text-brown-faint mb-1'

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

  const done = lines.filter(l => toShipQty(l, po.status) <= 0)
  const shipCount = shippable.filter(l => qtyOf(l) > 0).length
  const blocker = validation
    ?? (shipCount === 0 ? 'Set a quantity on at least one line.' : null)

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-xl mx-auto px-3 pt-5 pb-4 sm:px-4 space-y-3">
        <div>
          <Link to="/procurement/transfers" className="text-sm text-brown-faint hover:text-[#C4813A]">
            ← Transfers
          </Link>
          <h1 className="text-xl font-bold text-brown-dark mt-1 flex items-center gap-2 flex-wrap">
            Ship {po.po_number} <InternalBadge />
          </h1>
          <p className="text-sm text-brown-muted">
            From {po.supplier?.name ?? 'HQ'} → {po.branch?.name ?? '—'}
          </p>
        </div>

        {error && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-2.5">{error}</p>
        )}

        <p className="text-xs font-bold uppercase tracking-wide text-brown-muted px-1 pt-1">
          {shippable.length} item{shippable.length > 1 ? 's' : ''} to ship
        </p>
        <div className="space-y-2">
          {shippable.map(l => {
            const unit = l.item?.purchase_unit ?? ''
            const baseUnit = l.item?.base_unit ?? ''
            const conv = convOf(l)
            const toShip = toShipQty(l, po.status)
            const held = stock?.get(l.item_id)
            const heldBase = held?.balance ?? 0
            const q = qtyOf(l)
            const over = stock != null && toBaseUnits(q, conv) > heldBase
            const short = q < toShip
            const est = held?.avgCost != null && q > 0 ? toBaseUnits(q, conv) * held.avgCost : null
            return (
              <div
                key={l.id}
                className={`bg-white rounded-2xl border p-3.5 ${
                  over ? 'border-[#E9B9A8] shadow-[inset_4px_0_0_#B46309]'
                    : q > 0 ? 'border-[#CDB89C] shadow-[inset_4px_0_0_#2E6E9E]' : 'border-[#EDE5D8]'
                }`}
              >
                <p className="font-bold text-[15px] text-brown-dark leading-snug">{l.item?.name ?? 'Unknown item'}</p>
                <p className="text-xs text-brown-faint">1 {unit} = {qty(conv)} {baseUnit}</p>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-md bg-[#F5EDE0] text-brown-muted">
                    Asked {qty(toShip)} {unit}
                  </span>
                  {Number(l.shipped_quantity ?? 0) > 0 && (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-md bg-[#F5EDE0] text-brown-muted">
                      Sent before {qty(Number(l.shipped_quantity))}
                    </span>
                  )}
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-md ${
                    stock == null ? 'bg-[#F5EDE0] text-brown-muted'
                      : toBaseUnits(toShip, conv) > heldBase ? 'bg-[#FCF0EC] text-[#9E4A30]' : 'bg-[#EBF5EE] text-[#3D7A50]'
                  }`}>
                    HQ has {stock == null ? '—' : `${packs(heldBase, conv)} ${unit}`}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3 mt-2.5">
                  <p className="text-[13px] text-brown-muted min-w-0">
                    {est != null
                      ? <>≈ <span className="font-bold text-brown-dark">{money(est)}</span> at {formatUnitCost(held?.avgCost ?? null, baseUnit)}</>
                      : q > 0 ? 'No cost on record at HQ' : 'Not sending this time'}
                  </p>
                  <Stepper
                    value={q}
                    max={toShip}
                    onChange={n => setQuantities(prev => ({ ...prev, [l.id]: String(n) }))}
                    label={`${l.item?.name ?? 'Item'} to ship`}
                    tone={over ? 'warn' : 'normal'}
                  />
                </div>
                {over ? (
                  <p className="text-[13px] font-semibold text-[#B46309] bg-[#B4630912] rounded-lg px-3 py-2 mt-2.5">
                    More than HQ has ({packs(heldBase, conv)} {unit}). Shipping will be refused.
                  </p>
                ) : q > 0 && short && (
                  <p className="text-xs text-brown-faint mt-2">
                    {qty(toShip - q)} {unit} stays open; you can send it later.
                  </p>
                )}
              </div>
            )
          })}
        </div>

        {done.length > 0 && (
          <div className="rounded-2xl border border-[#EDE5D8] bg-white/60 p-3.5">
            <p className="text-xs font-semibold text-brown-muted mb-1">Already fully shipped</p>
            <ul className="text-xs text-brown-faint space-y-0.5">
              {done.map(l => <li key={l.id}>{l.item?.name ?? 'Unknown item'}</li>)}
            </ul>
          </div>
        )}

        <div>
          <label htmlFor="ship-notes" className={`${labelCls} px-1`}>Note (optional)</label>
          <textarea
            id="ship-notes"
            rows={2}
            className={`${inputCls} resize-none`}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="e.g. Sent by Lalamove, driver Ali"
          />
        </div>
        <p className="text-xs text-brown-faint px-1">
          Shipping takes the stock out of HQ at its current average cost. It enters the branch when they receive it.
        </p>
      </div>

      <div className="sticky bottom-0 bg-white border-t border-[#EDE5D8] px-3.5 pt-3 pb-4">
        <div className="max-w-xl mx-auto">
          <div className="flex justify-between text-[13px] text-brown-muted mb-2.5">
            <span>
              {shipCount} item{shipCount === 1 ? '' : 's'} · est. value
              {overOnHand.length > 0 && ` · ${overOnHand.length} above HQ stock`}
            </span>
            <span className="text-base font-bold text-brown-dark">{money(estTotal)}</span>
          </div>
          <button
            type="button"
            onClick={submit}
            disabled={submitting || !!blocker}
            className="w-full h-[52px] rounded-2xl bg-[#2E6E9E] text-white text-base font-bold active:bg-[#24587F] disabled:opacity-45"
          >
            {submitting ? 'Shipping…' : `Ship to ${po.branch?.name ?? 'branch'}`}
          </button>
          {blocker && !submitting && (
            <p className="text-xs text-center text-brown-muted mt-2">{blocker}</p>
          )}
        </div>
      </div>
    </div>
  )
}
