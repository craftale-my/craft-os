import { useState, useEffect, useMemo } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { useCan } from '../../shared/lib/permissions'
import { money, qty, poTotal } from '../../shared/lib/procurement'
import type { Item, Supplier, Branch } from '../../shared/types'

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'
const labelCls = 'block text-xs font-semibold text-brown-medium mb-1'

/** Quantity + price the user has typed for one item, keyed by item id. */
interface DraftLine {
  quantity: string
  unit_price: string
}

export default function PurchaseOrderNewPage() {
  const navigate = useNavigate()
  const { staff } = useAuth()
  const { can } = useCan()
  const allBranches = can('all_branches')

  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [branches, setBranches] = useState<Branch[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)

  const [supplierId, setSupplierId] = useState('')
  const [branchId, setBranchId] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<Record<string, DraftLine>>({})
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

  // Reload the item list whenever the supplier changes; clear any typed lines
  // so quantities can't carry over onto a different supplier's order.
  useEffect(() => {
    if (!supplierId) { setItems([]); setLines({}); return }
    let cancelled = false
    async function loadItems() {
      const { data } = await supabase
        .from('items')
        .select('*')
        .eq('supplier_id', supplierId)
        .eq('status', 'active')
        .order('name')
      if (cancelled) return
      setItems((data as Item[]) ?? [])
      setLines({})
    }
    loadItems()
    return () => { cancelled = true }
  }, [supplierId])

  function setLine(itemId: string, patch: Partial<DraftLine>) {
    setLines(prev => {
      const current = prev[itemId] ?? { quantity: '', unit_price: '' }
      return { ...prev, [itemId]: { ...current, ...patch } }
    })
  }

  /** Lines the user actually filled in — quantity > 0. */
  const activeLines = useMemo(() => {
    return items
      .map(item => {
        const draft = lines[item.id]
        const quantity = Number(draft?.quantity ?? '')
        const priceRaw = draft?.unit_price
        const unit_price = priceRaw === '' || priceRaw == null
          ? (item.latest_price ?? 0)
          : Number(priceRaw)
        return { item, quantity_ordered: quantity, unit_price }
      })
      .filter(l => l.quantity_ordered > 0)
  }, [items, lines])

  const total = poTotal(activeLines)
  const supervisorHasNoBranch = !allBranches && !staff?.branch_id

  async function save(markSent: boolean) {
    if (!supplierId) return setError('Pick a supplier first.')
    if (!branchId) return setError('Pick a branch for this order.')
    if (activeLines.length === 0) return setError('Enter a quantity for at least one item.')
    if (activeLines.some(l => l.unit_price < 0)) return setError('Unit price cannot be negative.')

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

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-4xl mx-auto px-4 py-8 lg:px-8 space-y-5">
        <div>
          <Link to="/procurement/orders" className="text-xs text-brown-faint hover:text-[#C4813A] transition-colors">
            ← Purchase Orders
          </Link>
          <h1 className="text-2xl font-bold text-brown-dark mt-1">New Purchase Order</h1>
          <p className="text-sm text-brown-faint mt-0.5">下单 · Pick a supplier, then enter quantities.</p>
        </div>

        {supervisorHasNoBranch && (
          <div className="bg-[#FCF0EC] border border-[#C0624A40] rounded-xl px-4 py-3">
            <p className="text-sm text-[#9E4A30] font-semibold">你的账号还没有绑定分店</p>
            <p className="text-xs text-[#9E4A30] mt-1">
              采购单必须归属到一个分店,库存才记得上账。请让 manager 在 Staff Management
              里给你设置 branch,然后再回来下单。
            </p>
          </div>
        )}

        {error && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">{error}</p>
        )}

        <section className="bg-white rounded-xl border border-[#E8DDD0] p-5 space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Supplier *</label>
              <select className={inputCls} value={supplierId} onChange={e => setSupplierId(e.target.value)}>
                <option value="">Select a supplier…</option>
                {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              {suppliers.length === 0 && (
                <p className="text-xs text-brown-faint mt-1">
                  No active suppliers. <Link to="/procurement/suppliers" className="text-[#C4813A] hover:underline">Add one first.</Link>
                </p>
              )}
            </div>
            <div>
              <label className={labelCls}>Branch *</label>
              <select
                className={inputCls}
                value={branchId}
                onChange={e => setBranchId(e.target.value)}
                disabled={!allBranches}
              >
                <option value="">Select a branch…</option>
                {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              {!allBranches && (
                <p className="text-xs text-brown-faint mt-1">Locked to your own branch.</p>
              )}
            </div>
          </div>
        </section>

        {supplierId && (
          <section className="bg-white rounded-xl border border-[#E8DDD0] overflow-hidden">
            <div className="px-5 pt-5 pb-3">
              <h2 className="text-sm font-bold text-brown-dark">Items from this supplier</h2>
              <p className="text-xs text-brown-faint mt-0.5">
                Leave a quantity blank to skip that item. Prices default to the last price paid.
              </p>
            </div>

            {items.length === 0 ? (
              <p className="px-5 pb-6 text-xs text-brown-faint">
                This supplier has no active items.{' '}
                <Link to="/procurement/items" className="text-[#C4813A] hover:underline">Add some in Items.</Link>
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[620px]">
                  <thead>
                    <tr className="text-left text-xs text-brown-faint border-y border-[#EDE5D8] bg-[#FBF6EE]">
                      <th className="px-5 py-2.5 font-semibold">Item</th>
                      <th className="px-3 py-2.5 font-semibold w-32">Quantity</th>
                      <th className="px-3 py-2.5 font-semibold w-32">Unit Price</th>
                      <th className="px-5 py-2.5 font-semibold text-right w-28">Line Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#F0E8DC]">
                    {items.map(item => {
                      const draft = lines[item.id]
                      const q = Number(draft?.quantity ?? '')
                      const p = draft?.unit_price === '' || draft?.unit_price == null
                        ? (item.latest_price ?? 0)
                        : Number(draft.unit_price)
                      const active = q > 0
                      return (
                        <tr key={item.id} className={active ? 'bg-[#FBF6EE]' : ''}>
                          <td className="px-5 py-3">
                            <p className="font-medium text-brown-dark">{item.name}</p>
                            <p className="text-xs text-brown-faint">
                              {item.name_zh ? `${item.name_zh} · ` : ''}
                              1 {item.purchase_unit} = {qty(item.conversion_rate)} {item.base_unit}
                            </p>
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex items-center gap-1.5">
                              <input
                                type="number" step="any" min="0"
                                className={`${inputCls} w-20`}
                                value={draft?.quantity ?? ''}
                                onChange={e => setLine(item.id, { quantity: e.target.value })}
                                placeholder="0"
                              />
                              <span className="text-xs text-brown-muted whitespace-nowrap">{item.purchase_unit}</span>
                            </div>
                          </td>
                          <td className="px-3 py-3">
                            <input
                              type="number" step="0.01" min="0"
                              className={`${inputCls} w-24`}
                              value={draft?.unit_price ?? ''}
                              onChange={e => setLine(item.id, { unit_price: e.target.value })}
                              placeholder={item.latest_price != null ? item.latest_price.toFixed(2) : '0.00'}
                            />
                          </td>
                          <td className="px-5 py-3 text-right whitespace-nowrap">
                            {active
                              ? <span className="font-semibold text-brown-dark">{money(q * p)}</span>
                              : <span className="text-xs text-brown-faint">—</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {activeLines.length > 0 && (
          <section className="bg-white rounded-xl border border-[#E8DDD0] p-5 space-y-4">
            <div>
              <label className={labelCls}>Notes for the supplier</label>
              <textarea
                rows={2}
                className={`${inputCls} resize-none`}
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="e.g. Deliver before 10am"
              />
            </div>

            <div className="flex items-center justify-between pt-1 border-t border-[#EDE5D8]">
              <div className="pt-3">
                <p className="text-xs text-brown-faint">{activeLines.length} item{activeLines.length > 1 ? 's' : ''}</p>
                <p className="text-xl font-bold text-brown-dark">{money(total)}</p>
              </div>
              <div className="flex gap-2 pt-3 flex-wrap justify-end">
                <button
                  onClick={() => save(false)}
                  disabled={saving || supervisorHasNoBranch}
                  className="px-4 py-2.5 rounded-xl border border-[#D4C5B0] text-sm text-brown-medium font-semibold hover:bg-[#F5EDE0] transition-colors disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save as Draft'}
                </button>
                <button
                  onClick={() => save(true)}
                  disabled={saving || supervisorHasNoBranch}
                  className="px-4 py-2.5 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors disabled:opacity-60"
                >
                  {saving ? 'Saving…' : 'Save & Mark as Sent'}
                </button>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
