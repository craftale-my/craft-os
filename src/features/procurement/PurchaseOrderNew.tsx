import { useState, useEffect, useMemo } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from '../auth/AuthContext'
import {
  money, qty, poTotal, isBelowAlert, suggestedOrderPacks, packs,
  seesAllBranches,
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

/** What the basket is for: one department (split per supplier) or a transfer from HQ. */
type Source = ItemDepartment | 'hq'

/** One supplier's share of the basket = one purchase order. */
interface SupplierGroup {
  supplier: Supplier
  lines: { item: Item; quantity_ordered: number; unit_price: number }[]
  total: number
}

const SOURCE_KEY = 'craft.po.source'

function rememberedSource(): Source | null {
  try {
    const v = localStorage.getItem(SOURCE_KEY)
    return v === 'hq' || (ITEM_DEPARTMENTS as string[]).includes(v ?? '') ? (v as Source) : null
  } catch {
    return null
  }
}

function rememberSource(s: Source) {
  try { localStorage.setItem(SOURCE_KEY, s) } catch { /* private mode: not remembered */ }
}

export default function PurchaseOrderNewPage() {
  const navigate = useNavigate()
  const { staff } = useAuth()
  // Procurement follows the DB branch rule, not the All Branches capability.
  const allBranches = seesAllBranches(staff)

  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [branches, setBranches] = useState<Branch[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [stock, setStock] = useState<Record<string, StockInfo>>({})
  const [loading, setLoading] = useState(true)
  const [loadingItems, setLoadingItems] = useState(false)

  const [source, setSource] = useState<Source>(() => rememberedSource() ?? 'cafe_bar')
  const [branchId, setBranchId] = useState('')
  const [notes, setNotes] = useState('')
  // Internal POs only: RM, optional. Recorded on the PO, never in item cost.
  const [deliveryFee, setDeliveryFee] = useState('')
  const [lines, setLines] = useState<Record<string, DraftLine>>({})
  const [lowOnly, setLowOnly] = useState(false)
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

  const internal = source === 'hq'
  // The HQ supplier row; a branch cannot order from itself.
  const hqSupplier = suppliers.find(s => s.internal_branch_id && s.internal_branch_id !== branchId) ?? null
  const supplierById = useMemo(() => new Map(suppliers.map(s => [s.id, s])), [suppliers])
  const branchName = branches.find(b => b.id === branchId)?.name ?? ''

  // HQ itself, or no HQ row: fall back to a department.
  useEffect(() => {
    if (!loading && internal && !hqSupplier) setSource('cafe_bar')
  }, [loading, internal, hqSupplier])

  // Reload items and the branch's stock whenever the source or branch changes.
  // Lines are replaced by the suggestions for the new list.
  useEffect(() => {
    if (loading || !branchId || (internal && !hqSupplier)) { setItems([]); setStock({}); setLines({}); return }
    let cancelled = false
    async function loadItems() {
      setLoadingItems(true)
      // HQ can send any active item; a department orders its own items from
      // their main suppliers.
      let query = supabase.from('items').select('*').eq('status', 'active')
      if (!internal) query = query.contains('departments', [source]).not('supplier_id', 'is', null)
      const [itemRes, balRes, openRes] = await Promise.all([
        query.order('name'),
        supabase.from('inventory_valuation').select('item_id, balance').eq('branch_id', branchId),
        // Ordered but not yet received at this branch (sent, not drafts).
        supabase
          .from('purchase_order_items')
          .select('item_id, quantity_ordered, received_quantity, conversion_rate_used, po:purchase_orders!inner(branch_id, status)')
          .eq('po.branch_id', branchId)
          .in('po.status', ['sent', 'partially_received']),
      ])
      if (cancelled) return
      const loaded = ((itemRes.data as Item[]) ?? [])
        // A department orders only from active, outside suppliers.
        .filter(i => internal || (i.supplier_id != null && supplierById.has(i.supplier_id)
          && !supplierById.get(i.supplier_id)?.internal_branch_id))
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
      setLowOnly(false)
      setLoadingItems(false)
    }
    loadItems()
    return () => { cancelled = true }
  }, [loading, source, internal, branchId, hqSupplier, supplierById])

  function pickSource(s: Source) {
    setSource(s)
    rememberSource(s)
    setReviewing(false)
    setError('')
  }

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

  function supplierOf(item: Item): Supplier | null {
    if (internal) return hqSupplier
    return item.supplier_id ? supplierById.get(item.supplier_id) ?? null : null
  }

  /** The basket, one group per supplier, in supplier-name order. */
  const groups = useMemo<SupplierGroup[]>(() => {
    const bySupplier = new Map<string, SupplierGroup>()
    for (const item of items) {
      const quantity = lines[item.id]?.quantity ?? 0
      const supplier = supplierOf(item)
      if (quantity <= 0 || !supplier) continue
      const g = bySupplier.get(supplier.id) ?? { supplier, lines: [], total: 0 }
      g.lines.push({ item, quantity_ordered: quantity, unit_price: priceOf(item) })
      bySupplier.set(supplier.id, g)
    }
    return [...bySupplier.values()]
      .map(g => ({ ...g, total: poTotal(g.lines) }))
      .sort((a, b) => a.supplier.name.localeCompare(b.supplier.name))
    // priceOf / supplierOf read lines, items, internal, hqSupplier, supplierById.
  }, [items, lines, internal, hqSupplier, supplierById])

  const lineCount = groups.reduce((n, g) => n + g.lines.length, 0)
  const total = groups.reduce((sum, g) => sum + g.total, 0)
  const supervisorHasNoBranch = !allBranches && !staff?.branch_id
  const lowCount = items.filter(isLow).length

  /** Items on screen, grouped by supplier; low items first in each group. */
  const sections = useMemo(() => {
    const shown = items.filter(i => !lowOnly || isLow(i))
    const map = new Map<string, { supplier: Supplier; items: Item[] }>()
    for (const item of shown) {
      const supplier = supplierOf(item)
      if (!supplier) continue
      const s = map.get(supplier.id) ?? { supplier, items: [] }
      s.items.push(item)
      map.set(supplier.id, s)
    }
    return [...map.values()]
      .map(s => ({ ...s, items: [...s.items.filter(isLow), ...s.items.filter(i => !isLow(i))] }))
      .sort((a, b) => a.supplier.name.localeCompare(b.supplier.name))
    // isLow / supplierOf read stock, internal, hqSupplier, supplierById.
  }, [items, lowOnly, stock, internal, hqSupplier, supplierById])

  function review() {
    if (!branchId) return setError('Pick a branch for this order.')
    if (lineCount === 0) return setError('Add at least one item.')
    setError('')
    setReviewing(true)
    window.scrollTo({ top: 0 })
  }

  /** Creates one PO per supplier. Stops at the first failure; what was saved stays saved. */
  async function save(markSent: boolean) {
    if (!branchId) return setError('Pick a branch for this order.')
    if (groups.length === 0) return setError('Add at least one item.')
    if (groups.some(g => g.lines.some(l => !(l.unit_price >= 0)))) return setError('Unit price cannot be negative.')
    const fee = internal && deliveryFee.trim() !== '' ? Number(deliveryFee) : null
    if (fee != null && !(fee >= 0)) return setError('Delivery fee must be zero or more.')

    setSaving(true)
    setError('')
    const created: string[] = []
    const savedItemIds: string[] = []

    for (const g of groups) {
      // po_number is filled in by a DB trigger, so it is deliberately absent here.
      const { data: po, error: poErr } = await supabase
        .from('purchase_orders')
        .insert({
          supplier_id: g.supplier.id,
          branch_id: branchId,
          created_by: staff?.id ?? null,
          status: markSent ? 'sent' : 'draft',
          total_amount: g.total,
          notes: notes.trim() || null,
          sent_at: markSent ? new Date().toISOString() : null,
          ...(internal ? { delivery_fee: fee } : { department: source }),
        })
        .select()
        .single()

      let failure = poErr?.message ?? (po ? null : 'Could not create the purchase order.')
      if (!failure && po) {
        const { error: linesErr } = await supabase.from('purchase_order_items').insert(
          g.lines.map(l => ({
            po_id: po.id,
            item_id: l.item.id,
            quantity_ordered: l.quantity_ordered,
            unit_price: l.unit_price,
          })),
        )
        if (linesErr) {
          // Don't strand a header with no lines.
          await supabase.from('purchase_orders').delete().eq('id', po.id)
          failure = `Could not save the order lines: ${linesErr.message}`
        }
      }
      if (failure) {
        // Drop what was already saved from the basket so it isn't ordered twice.
        setLines(prev => Object.fromEntries(Object.entries(prev).filter(([id]) => !savedItemIds.includes(id))))
        setSaving(false)
        setError(created.length > 0
          ? `${created.length} order${created.length > 1 ? 's were' : ' was'} saved. ${g.supplier.name} failed: ${failure}`
          : `${g.supplier.name}: ${failure}`)
        return
      }
      created.push(po!.id)
      savedItemIds.push(...g.lines.map(l => l.item.id))
    }

    navigate(created.length === 1 ? `/procurement/orders/${created[0]}` : '/procurement/orders')
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
    const shared = !internal && item.departments.length > 1
    return (
      <div
        key={item.id}
        className={`bg-white rounded-2xl border p-3.5 ${
          low ? 'border-[#E9B9A8] shadow-[inset_4px_0_0_#9E4A30]'
            : quantity > 0 ? 'border-[#CDB89C] shadow-[inset_4px_0_0_#C4813A]' : 'border-[#EDE5D8]'
        }`}
      >
        <p className="font-bold text-[15px] text-brown-dark leading-snug">{item.name}</p>
        <p className="text-xs text-brown-faint">
          1 {unit} = {qty(rate)} {item.base_unit}
          {shared && ` · shared with ${item.departments.filter(d => d !== source).map(d => ITEM_DEPARTMENT_LABELS[d]).join(', ')}`}
        </p>
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

  const sourceLabel = internal ? 'From HQ' : ITEM_DEPARTMENT_LABELS[source]
  const sources: { key: Source; label: string }[] = [
    ...ITEM_DEPARTMENTS.map(d => ({ key: d as Source, label: ITEM_DEPARTMENT_LABELS[d] })),
    ...(hqSupplier ? [{ key: 'hq' as Source, label: 'From HQ' }] : []),
  ]
  const sendLabel = internal ? 'Send to HQ'
    : groups.length > 1 ? `Send ${groups.length} orders` : 'Save & mark as sent'

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
            <p className="text-sm text-brown-muted">
              {sourceLabel} · {branchName}
              {!internal && groups.length > 1 && ` · ${groups.length} suppliers, one order each`}
            </p>
          </div>

          {error && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-2.5">{error}</p>
          )}

          {groups.map(g => (
            <section key={g.supplier.id} className="bg-white rounded-2xl border border-[#EDE5D8]">
              <div className="flex justify-between gap-3 px-3.5 pt-3 pb-2 border-b border-[#F0E8DC]">
                <p className="text-sm font-bold text-brown-dark">{g.supplier.name}</p>
                <p className="text-sm font-bold text-brown-dark whitespace-nowrap">{money(g.total)}</p>
              </div>
              <div className="divide-y divide-[#F0E8DC]">
                {g.lines.map(l => (
                  <div key={l.item.id} className="px-3.5 py-3">
                    <div className="flex justify-between gap-3">
                      <p className="font-semibold text-[15px] text-brown-dark">{l.item.name}</p>
                      <p className="text-sm text-brown-muted whitespace-nowrap">{money(l.quantity_ordered * l.unit_price)}</p>
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
              </div>
            </section>
          ))}
          {internal && (
            <p className="text-xs text-brown-faint px-1">Prices are estimates. HQ sets the actual cost when shipping.</p>
          )}

          <section className="bg-white rounded-2xl border border-[#EDE5D8] p-3.5 space-y-3">
            <div>
              <label htmlFor="po-notes" className={labelCls}>
                {internal ? 'Notes for HQ' : groups.length > 1 ? 'Notes (go on every order)' : 'Notes for the supplier'}
              </label>
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
              <span>
                {lineCount} item{lineCount > 1 ? 's' : ''}
                {groups.length > 1 && ` · ${groups.length} suppliers`}
                {internal ? ' · estimate' : ''}
              </span>
              <span className="text-base font-bold text-brown-dark">{money(total)}</span>
            </div>
            <button
              type="button"
              onClick={() => save(true)}
              disabled={saving || supervisorHasNoBranch}
              className="w-full h-[52px] rounded-2xl bg-brown-btn text-white text-base font-bold active:bg-brown-btn-hover disabled:opacity-50"
            >
              {saving ? 'Saving…' : sendLabel}
            </button>
            <button
              type="button"
              onClick={() => save(false)}
              disabled={saving || supervisorHasNoBranch}
              className="w-full h-11 mt-1 text-sm font-semibold text-brown-muted disabled:opacity-50"
            >
              {groups.length > 1 ? 'Save as drafts' : 'Save as draft'}
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

        {allBranches && (
          <section className="bg-white rounded-2xl border border-[#EDE5D8] p-3.5 mb-3">
            <label htmlFor="po-branch" className={labelCls}>Branch</label>
            <select id="po-branch" className={inputCls} value={branchId} onChange={e => setBranchId(e.target.value)}>
              <option value="">Select a branch…</option>
              {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </section>
        )}

        <p className={`${labelCls} px-1`}>Ordering for</p>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Ordering for">
          {sources.map(s => (
            <button
              key={s.key}
              type="button"
              role="radio"
              aria-checked={source === s.key}
              onClick={() => pickSource(s.key)}
              className={`h-12 rounded-xl border text-sm font-bold ${
                source === s.key
                  ? 'bg-brown-btn border-brown-btn text-white'
                  : 'bg-white border-[#EDE5D8] text-brown-muted active:bg-[#F5EDE0]'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        {internal ? (
          <p className="text-xs text-[#2E6E9E] mt-2 px-1">Internal transfer. HQ ships it and sets the actual cost when shipping.</p>
        ) : (
          <p className="text-xs text-brown-faint mt-2 px-1">
            Everything {ITEM_DEPARTMENT_LABELS[source]} uses. Each supplier gets its own order.
          </p>
        )}

        {!branchId ? (
          allBranches && <p className="text-sm text-brown-faint text-center py-8">Pick a branch to see its stock.</p>
        ) : loadingItems ? (
          <p className="text-sm text-brown-faint text-center py-8">Loading items…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-brown-faint text-center py-8">
            {internal
              ? 'There are no active items.'
              : `No items are set up for ${ITEM_DEPARTMENT_LABELS[source]} with a supplier yet.`}{' '}
            <Link to="/procurement/items" className="text-[#C4813A] hover:underline">Set them up in Items.</Link>
          </p>
        ) : (
          <>
            {(lowCount > 0 || lineCount > 0) && (
              <div className="flex items-center gap-2 mt-3">
                {lowCount > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() => setLowOnly(false)}
                      className={`px-3 py-1.5 rounded-full border text-[13px] font-semibold ${
                        !lowOnly ? 'bg-brown-btn border-brown-btn text-white' : 'bg-white border-[#EDE5D8] text-brown-muted'
                      }`}
                    >
                      All {items.length}
                    </button>
                    <button
                      type="button"
                      onClick={() => setLowOnly(true)}
                      className={`px-3 py-1.5 rounded-full border text-[13px] font-semibold ${
                        lowOnly ? 'bg-brown-btn border-brown-btn text-white' : 'bg-white border-[#EDE5D8] text-brown-muted'
                      }`}
                    >
                      Low {lowCount}
                    </button>
                  </>
                )}
                {lineCount > 0 && (
                  // A new branch can start with many suggestions; one tap empties the basket.
                  <button
                    type="button"
                    onClick={() => setLines({})}
                    className="ml-auto px-3 py-1.5 text-[13px] font-semibold text-brown-muted underline underline-offset-2"
                  >
                    Clear all
                  </button>
                )}
              </div>
            )}

            {sections.map(s => {
              const inBasket = groups.find(g => g.supplier.id === s.supplier.id)
              return (
                <div key={s.supplier.id}>
                  <div className="flex items-baseline justify-between gap-3 mt-4 mb-2 px-1">
                    <p className="text-xs font-bold uppercase tracking-wide text-brown-muted">
                      {internal ? 'From HQ' : s.supplier.name}
                    </p>
                    {inBasket && (
                      <p className="text-xs font-semibold text-[#C4813A] whitespace-nowrap">
                        {inBasket.lines.length} in order · {money(inBasket.total)}
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">{s.items.map(itemCard)}</div>
                </div>
              )
            })}
          </>
        )}
      </div>

      {branchId && items.length > 0 && (
        <div className="sticky bottom-0 bg-white border-t border-[#EDE5D8] px-3.5 pt-3 pb-4">
          <div className="max-w-xl mx-auto">
            <div className="flex justify-between text-[13px] text-brown-muted mb-2.5">
              <span>
                {lineCount} item{lineCount === 1 ? '' : 's'}
                {groups.length > 1 && ` · ${groups.length} suppliers`}
              </span>
              <span className="text-base font-bold text-brown-dark">{money(total)}</span>
            </div>
            <button
              type="button"
              onClick={review}
              disabled={lineCount === 0 || supervisorHasNoBranch}
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
