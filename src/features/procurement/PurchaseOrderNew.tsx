import { useState, useEffect, useMemo } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { useCan } from '../../shared/lib/permissions'
import {
  money, qty, poTotal, isInternalSupplier, isBelowAlert, suggestedOrderPacks, packs,
} from '../../shared/lib/procurement'
import { ITEM_DEPARTMENT_LABELS, ITEM_DEPARTMENTS } from '../../shared/types'
import type { Item, Supplier, Branch, ItemDepartment } from '../../shared/types'
import Stepper from './Stepper'

const inputCls =
  'w-full px-3 py-2.5 rounded-xl border border-[#D4C5B0] bg-white text-base text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'
const labelCls = 'block text-[11px] font-bold uppercase tracking-wide text-brown-faint mb-1'

/** Quantity + price the user has set for one item, keyed by item id. */
interface DraftLine {
  quantity: number
  /** '' = the last price paid. */
  unit_price: string
}

/** Branch stock of one item, base units. */
interface StockInfo {
  onHand: number
  onOrder: number
}

type ItemFilter = 'all' | 'low' | ItemDepartment

export default function PurchaseOrderNewPage() {
  const navigate = useNavigate()
  const { staff } = useAuth()
  const { can } = useCan()
  const allBranches = can('all_branches')

  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [branches, setBranches] = useState<Branch[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [stock, setStock] = useState<Record<string, StockInfo>>({})
  const [loading, setLoading] = useState(true)
  const [loadingItems, setLoadingItems] = useState(false)

  const [supplierId, setSupplierId] = useState('')
  const [branchId, setBranchId] = useState('')
  const [notes, setNotes] = useState('')
  // Internal POs only: RM, optional. Recorded on the PO, never in item cost.
  const [deliveryFee, setDeliveryFee] = useState('')
  const [lines, setLines] = useState<Record<string, DraftLine>>({})
  const [filter, setFilter] = useState<ItemFilter>('all')
  const [reviewing, setReviewing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    async function load() {
      const [supRes, branchRes] = await Promise.all([
        supabase.from('suppliers').select('*').eq('status', 'active').order('name'),
        supabase.from('branches').select('*').eq('is_active', true).order('name'),
      ])
      setSuppliers((supRes.data as Supplier[]) ?? [])
      setBranches((branchRes.data as Branch[]) ?? [])
      // Supervisors order for their own branch only; managers choose.
      if (!allBranches && staff?.branch_id) setBranchId(staff.branch_id)
      setLoading(false)
    }
    load()
  }, [allBranches, staff?.branch_id])

  const supplier = suppliers.find(s => s.id === supplierId) ?? null
  // Internal PO: the supplier row is HQ, so the order is a transfer from HQ.
  const internal = isInternalSupplier(supplier)
  const branchName = branches.find(b => b.id === branchId)?.name ?? ''

  // A branch cannot order from itself: hide the HQ row when ordering for HQ.
  const supplierOptions = suppliers.filter(s => !s.internal_branch_id || s.internal_branch_id !== branchId)

  // Switching the branch to HQ while HQ is the supplier would be refused by the DB.
  useEffect(() => {
    if (supplier?.internal_branch_id && supplier.internal_branch_id === branchId) setSupplierId('')
  }, [branchId, supplier?.internal_branch_id])

  // Reload items and the branch's stock whenever the supplier or branch
  // changes. Typed lines are replaced by the suggestions for the new list, so
  // quantities can't carry over onto a different supplier's order.
  useEffect(() => {
    if (!supplierId) { setItems([]); setStock({}); setLines({}); return }
    let cancelled = false
    async function loadItems() {
      setLoadingItems(true)
      // HQ can send any active item; a supplier only the items it supplies.
      let query = supabase.from('items').select('*')
      if (!internal) query = query.eq('supplier_id', supplierId)
      const [itemRes, balRes, openRes] = await Promise.all([
        query.eq('status', 'active').order('name'),
        branchId
          ? supabase.from('inventory_valuation').select('item_id, balance').eq('branch_id', branchId)
          : Promise.resolve({ data: [] }),
        // Ordered but not yet received at this branch (sent, not drafts).
        branchId
          ? supabase
            .from('purchase_order_items')
            .select('item_id, quantity_ordered, received_quantity, conversion_rate_used, po:purchase_orders!inner(branch_id, status)')
            .eq('po.branch_id', branchId)
            .in('po.status', ['sent', 'partially_received'])
          : Promise.resolve({ data: [] }),
      ])
      if (cancelled) return
      const loaded = (itemRes.data as Item[]) ?? []
      const rateOf = new Map(loaded.map(i => [i.id, Number(i.conversion_rate)]))
      const next: Record<string, StockInfo> = {}
      for (const b of (balRes.data ?? []) as { item_id: string; balance: number }[]) {
        next[b.item_id] = { onHand: Number(b.balance), onOrder: 0 }
      }
      for (const l of (openRes.data ?? []) as {
        item_id: string; quantity_ordered: number; received_quantity: number; conversion_rate_used: number | null
      }[]) {
        const open = Math.max(Number(l.quantity_ordered) - Number(l.received_quantity), 0)
        const rate = Number(l.conversion_rate_used ?? rateOf.get(l.item_id) ?? 0)
        const cur = next[l.item_id] ?? { onHand: 0, onOrder: 0 }
        next[l.item_id] = { ...cur, onOrder: cur.onOrder + open * rate }
      }
      setItems(loaded)
      setStock(next)
      // Pre-fill the suggestion on every low item.
      const prefill: Record<string, DraftLine> = {}
      for (const item of loaded) {
        const s = next[item.id] ?? { onHand: 0, onOrder: 0 }
        const suggested = suggestedOrderPacks({
          onHand: s.onHand, onOrder: s.onOrder,
          minStockAlert: Number(item.min_stock_alert), conversionRate: Number(item.conversion_rate),
        })
        if (suggested > 0) prefill[item.id] = { quantity: suggested, unit_price: '' }
      }
      setLines(prefill)
      setFilter('all')
      setLoadingItems(false)
    }
    loadItems()
    return () => { cancelled = true }
  }, [supplierId, internal, branchId])

  function setLine(itemId: string, patch: Partial<DraftLine>) {
    setLines(prev => {
      const current = prev[itemId] ?? { quantity: 0, unit_price: '' }
      return { ...prev, [itemId]: { ...current, ...patch } }
    })
  }

  function stockOf(item: Item): StockInfo {
    return stock[item.id] ?? { onHand: 0, onOrder: 0 }
  }

  function isLow(item: Item): boolean {
    return isBelowAlert(stockOf(item).onHand, Number(item.min_stock_alert))
  }

  function priceOf(item: Item): number {
    const raw = lines[item.id]?.unit_price
    return raw === '' || raw == null ? (item.latest_price ?? 0) : Number(raw)
  }

  /** Lines with a quantity > 0. */
  const activeLines = useMemo(() => {
    return items
      .map(item => ({ item, quantity_ordered: lines[item.id]?.quantity ?? 0, unit_price: priceOf(item) }))
      .filter(l => l.quantity_ordered > 0)
  }, [items, lines])

  const total = poTotal(activeLines)
  const supervisorHasNoBranch = !allBranches && !staff?.branch_id
  const lowCount = items.filter(isLow).length
  const departments = ITEM_DEPARTMENTS.filter(d => items.some(i => i.department === d))

  const shown = items.filter(i =>
    filter === 'all' ? true : filter === 'low' ? isLow(i) : i.department === filter)
  // Low items first under "All", so what needs reordering is on top.
  const lowShown = filter === 'all' ? shown.filter(isLow) : []
  const restShown = filter === 'all' ? shown.filter(i => !isLow(i)) : shown

  function review() {
    if (!branchId) return setError('Pick a branch for this order.')
    if (activeLines.length === 0) return setError('Add at least one item.')
    setError('')
    setReviewing(true)
    window.scrollTo({ top: 0 })
  }

  async function save(markSent: boolean) {
    if (!supplierId) return setError('Pick a supplier first.')
    if (!branchId) return setError('Pick a branch for this order.')
    if (activeLines.length === 0) return setError('Add at least one item.')
    if (activeLines.some(l => !(l.unit_price >= 0))) return setError('Unit price cannot be negative.')
    const fee = internal && deliveryFee.trim() !== '' ? Number(deliveryFee) : null
    if (fee != null && !(fee >= 0)) return setError('Delivery fee must be zero or more.')

    setSaving(true)
    setError('')

    // po_number is filled in by a DB trigger, so it is deliberately absent here.
    const { data: po, error: poErr } = await supabase
      .from('purchase_orders')
      .insert({
        supplier_id: supplierId,
        branch_id: branchId,
        created_by: staff?.id ?? null,
        status: markSent ? 'sent' : 'draft',
        total_amount: total,
        notes: notes.trim() || null,
        sent_at: markSent ? new Date().toISOString() : null,
        // Supplier POs send exactly the same payload as before.
        ...(internal ? { delivery_fee: fee } : {}),
      })
      .select()
      .single()

    if (poErr || !po) {
      setSaving(false)
      setError(poErr?.message ?? 'Could not create the purchase order.')
      return
    }

    const { error: linesErr } = await supabase.from('purchase_order_items').insert(
      activeLines.map(l => ({
        po_id: po.id,
        item_id: l.item.id,
        quantity_ordered: l.quantity_ordered,
        unit_price: l.unit_price,
      })),
    )

    if (linesErr) {
      // Don't strand a header with no lines — roll the PO back so the list
      // doesn't fill up with empty orders the user can't make sense of.
      await supabase.from('purchase_orders').delete().eq('id', po.id)
      setSaving(false)
      setError(`Could not save the order lines: ${linesErr.message}`)
      return
    }

    navigate(`/procurement/orders/${po.id}`)
  }

  if (loading) {
    return <div className="min-h-screen bg-cream-light px-4 py-8 text-center text-sm text-brown-faint">Loading…</div>
  }

  // A plain render function, not a component: a component defined in here
  // would remount on every keystroke and drop the stepper's focus.
  function itemCard(item: Item) {
    const s = stockOf(item)
    const rate = Number(item.conversion_rate)
    const min = Number(item.min_stock_alert)
    const low = isLow(item)
    const quantity = lines[item.id]?.quantity ?? 0
    const suggested = suggestedOrderPacks({ onHand: s.onHand, onOrder: s.onOrder, minStockAlert: min, conversionRate: rate })
    const unit = item.purchase_unit
    return (
      <div
        key={item.id}
        className={`bg-white rounded-2xl border p-3.5 ${
          low ? 'border-[#E9B9A8] shadow-[inset_4px_0_0_#9E4A30]'
            : quantity > 0 ? 'border-[#CDB89C] shadow-[inset_4px_0_0_#C4813A]' : 'border-[#EDE5D8]'
        }`}
      >
        <p className="font-bold text-[15px] text-brown-dark leading-snug">{item.name}</p>
        <p className="text-xs text-brown-faint">1 {unit} = {qty(rate)} {item.base_unit}</p>
        <div className="flex flex-wrap gap-1.5 mt-2">
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-md ${
            low ? 'bg-[#FCF0EC] text-[#9E4A30]' : 'bg-[#EBF5EE] text-[#3D7A50]'
          }`}>
            On hand {packs(s.onHand, rate)} {unit}
          </span>
          {min > 0 && (
            <span className="text-xs font-semibold px-2 py-0.5 rounded-md bg-[#F5EDE0] text-brown-muted">
              Min {packs(min, rate)}
            </span>
          )}
          {(s.onOrder > 0 || low) && (
            <span className="text-xs font-semibold px-2 py-0.5 rounded-md bg-[#F5EDE0] text-brown-muted">
              On order {packs(s.onOrder, rate)}
            </span>
          )}
        </div>
        {low && (
          <p className="text-xs font-bold text-[#C4813A] mt-1.5">
            {suggested > 0
              ? `Suggested ${qty(suggested)} ${unit} · back up to 2× minimum`
              : 'Already covered by what is on order'}
          </p>
        )}
        <div className="flex items-center justify-between gap-3 mt-2.5">
          <p className="text-[13px] text-brown-muted">
            {internal && 'Est. '}<span className="font-bold text-brown-dark">{money(priceOf(item))}</span> / {unit}
          </p>
          {quantity > 0 ? (
            <Stepper
              value={quantity}
              onChange={n => setLine(item.id, { quantity: n })}
              label={`${item.name} quantity`}
            />
          ) : (
            <button
              type="button"
              onClick={() => setLine(item.id, { quantity: suggested > 0 ? suggested : 1 })}
              className="h-11 px-4 rounded-xl border border-[#E8DDD0] bg-[#FDFAF6] text-sm font-bold text-brown-btn active:bg-[#F5EDE0]"
            >
              + Add
            </button>
          )}
        </div>
      </div>
    )
  }

  const chip = (key: ItemFilter, label: string) => (
    <button
      key={key}
      type="button"
      onClick={() => setFilter(key)}
      className={`shrink-0 px-3 py-1.5 rounded-full border text-[13px] font-semibold ${
        filter === key ? 'bg-brown-btn border-brown-btn text-white' : 'bg-white border-[#EDE5D8] text-brown-muted'
      }`}
    >
      {label}
    </button>
  )

  const sectionCls = 'text-xs font-bold uppercase tracking-wide text-brown-muted mt-4 mb-2 px-1'

  // ── Review & send ─────────────────────────────────────────────────────────
  if (reviewing) {
    return (
      <div className="min-h-screen bg-cream-light">
        <div className="max-w-xl mx-auto px-3 pt-5 pb-4 sm:px-4 space-y-3">
          <div>
            <button type="button" onClick={() => setReviewing(false)} className="text-sm text-brown-faint hover:text-[#C4813A]">
              ← Back to items
            </button>
            <h1 className="text-xl font-bold text-brown-dark mt-1">Review order</h1>
            <p className="text-sm text-brown-muted">{supplier?.name} · {branchName}</p>
          </div>

          {error && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-2.5">{error}</p>
          )}

          <section className="bg-white rounded-2xl border border-[#EDE5D8] divide-y divide-[#F0E8DC]">
            {activeLines.map(l => (
              <div key={l.item.id} className="p-3.5">
                <div className="flex justify-between gap-3">
                  <p className="font-bold text-[15px] text-brown-dark">{l.item.name}</p>
                  <p className="font-bold text-brown-dark whitespace-nowrap">{money(l.quantity_ordered * l.unit_price)}</p>
                </div>
                <div className="flex items-center gap-2 mt-2 text-sm text-brown-muted">
                  <span className="whitespace-nowrap">{qty(l.quantity_ordered)} {l.item.purchase_unit} ×</span>
                  <span className="text-brown-faint">RM</span>
                  <input
                    type="number" inputMode="decimal" step="0.01" min="0"
                    aria-label={`${l.item.name} unit price`}
                    className="w-24 px-2.5 py-2 rounded-lg border border-[#D4C5B0] bg-white text-base text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]"
                    value={lines[l.item.id]?.unit_price ?? ''}
                    onChange={e => setLine(l.item.id, { unit_price: e.target.value })}
                    placeholder={(l.item.latest_price ?? 0).toFixed(2)}
                  />
                </div>
              </div>
            ))}
          </section>
          {internal && (
            <p className="text-xs text-brown-faint px-1">Prices are estimates. HQ sets the actual cost when shipping.</p>
          )}

          <section className="bg-white rounded-2xl border border-[#EDE5D8] p-3.5 space-y-3">
            <div>
              <label htmlFor="po-notes" className={labelCls}>{internal ? 'Notes for HQ' : 'Notes for the supplier'}</label>
              <textarea
                id="po-notes"
                rows={2}
                className={`${inputCls} resize-none`}
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="e.g. Deliver before 10am"
              />
            </div>
            {internal && (
              <div>
                <label htmlFor="po-delivery-fee" className={labelCls}>Delivery fee (RM, optional)</label>
                <input
                  id="po-delivery-fee"
                  type="number" inputMode="decimal" step="0.01" min="0"
                  className={`${inputCls} w-40`}
                  value={deliveryFee}
                  onChange={e => setDeliveryFee(e.target.value)}
                  placeholder="0.00"
                />
                <p className="text-xs text-brown-faint mt-1">E.g. Lalamove. Recorded on the order only, not added to item cost.</p>
              </div>
            )}
          </section>
        </div>

        <div className="sticky bottom-0 bg-white border-t border-[#EDE5D8] px-3.5 pt-3 pb-4">
          <div className="max-w-xl mx-auto">
            <div className="flex justify-between text-[13px] text-brown-muted mb-2.5">
              <span>{activeLines.length} item{activeLines.length > 1 ? 's' : ''}{internal ? ' · estimate' : ''}</span>
              <span className="text-base font-bold text-brown-dark">{money(total)}</span>
            </div>
            <button
              type="button"
              onClick={() => save(true)}
              disabled={saving || supervisorHasNoBranch}
              className="w-full h-[52px] rounded-2xl bg-brown-btn text-white text-base font-bold active:bg-brown-btn-hover disabled:opacity-50"
            >
              {saving ? 'Saving…' : internal ? 'Send to HQ' : 'Save & mark as sent'}
            </button>
            <button
              type="button"
              onClick={() => save(false)}
              disabled={saving || supervisorHasNoBranch}
              className="w-full h-11 mt-1 text-sm font-semibold text-brown-muted disabled:opacity-50"
            >
              Save as draft
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Pick items ────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-xl mx-auto px-3 pt-5 pb-4 sm:px-4">
        <div className="mb-3">
          <Link to="/procurement/orders" className="text-sm text-brown-faint hover:text-[#C4813A]">
            ← Purchase Orders
          </Link>
          <h1 className="text-xl font-bold text-brown-dark mt-1">New purchase order</h1>
          {branchName && !allBranches && <p className="text-sm text-brown-muted">{branchName}</p>}
        </div>

        {supervisorHasNoBranch && (
          <div className="bg-[#FCF0EC] border border-[#C0624A40] rounded-xl px-4 py-3 mb-3">
            <p className="text-sm text-[#9E4A30] font-semibold">Your account has no branch yet</p>
            <p className="text-xs text-[#9E4A30] mt-1">
              A purchase order must belong to a branch so stock is posted correctly. Ask a manager
              to set your branch in Staff Management, then come back.
            </p>
          </div>
        )}

        {error && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-2.5 mb-3">{error}</p>
        )}

        <section className="bg-white rounded-2xl border border-[#EDE5D8] p-3.5 space-y-3">
          <div>
            <label htmlFor="po-supplier" className={labelCls}>Supplier</label>
            <select id="po-supplier" className={inputCls} value={supplierId} onChange={e => setSupplierId(e.target.value)}>
              <option value="">Select a supplier…</option>
              {supplierOptions.map(s => (
                <option key={s.id} value={s.id}>
                  {isInternalSupplier(s) ? `Internal — ${s.name}` : s.name}
                </option>
              ))}
            </select>
            {suppliers.length === 0 && (
              <p className="text-xs text-brown-faint mt-1">
                No active suppliers. <Link to="/procurement/suppliers" className="text-[#C4813A] hover:underline">Add one first.</Link>
              </p>
            )}
            {internal && (
              <p className="text-xs text-[#2E6E9E] mt-1">Internal transfer. HQ ships it and sets the actual cost when shipping.</p>
            )}
          </div>
          {allBranches && (
            <div>
              <label htmlFor="po-branch" className={labelCls}>Branch</label>
              <select id="po-branch" className={inputCls} value={branchId} onChange={e => setBranchId(e.target.value)}>
                <option value="">Select a branch…</option>
                {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
          )}
        </section>

        {supplierId && (
          loadingItems ? (
            <p className="text-sm text-brown-faint text-center py-8">Loading items…</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-brown-faint text-center py-8">
              {internal ? 'There are no active items.' : 'This supplier has no active items.'}{' '}
              <Link to="/procurement/items" className="text-[#C4813A] hover:underline">Add some in Items.</Link>
            </p>
          ) : (
            <>
              <div className="flex gap-2 overflow-x-auto mt-3 pb-1 -mx-3 px-3 sm:mx-0 sm:px-0">
                {chip('all', `All ${items.length}`)}
                {lowCount > 0 && chip('low', `Low ${lowCount}`)}
                {departments.map(d => chip(d, ITEM_DEPARTMENT_LABELS[d]))}
              </div>

              {lowShown.length > 0 && <p className={sectionCls}>Below minimum</p>}
              <div className="space-y-2">
                {lowShown.map(itemCard)}
              </div>
              {lowShown.length > 0 && restShown.length > 0 && <p className={sectionCls}>Everything else</p>}
              <div className={`space-y-2 ${lowShown.length === 0 ? 'mt-3' : ''}`}>
                {restShown.map(itemCard)}
              </div>
              {shown.length === 0 && (
                <p className="text-sm text-brown-faint text-center py-6">Nothing in this filter.</p>
              )}
            </>
          )
        )}
      </div>

      {supplierId && items.length > 0 && (
        <div className="sticky bottom-0 bg-white border-t border-[#EDE5D8] px-3.5 pt-3 pb-4">
          <div className="max-w-xl mx-auto">
            <div className="flex justify-between text-[13px] text-brown-muted mb-2.5">
              <span>{activeLines.length} item{activeLines.length === 1 ? '' : 's'}</span>
              <span className="text-base font-bold text-brown-dark">{money(total)}</span>
            </div>
            <button
              type="button"
              onClick={review}
              disabled={activeLines.length === 0 || supervisorHasNoBranch}
              className="w-full h-[52px] rounded-2xl bg-brown-btn text-white text-base font-bold active:bg-brown-btn-hover disabled:opacity-40"
            >
              Review &amp; send
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
