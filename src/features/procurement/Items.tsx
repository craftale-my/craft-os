import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { useCan } from '../../shared/lib/permissions'
import { money, qty, isBelowAlert } from '../../shared/lib/procurement'
import type { Item, Supplier, ItemCategory, InventoryBalance } from '../../shared/types'
import {
  ITEM_CATEGORIES, ITEM_CATEGORY_LABELS,
  PURCHASE_UNIT_SUGGESTIONS, BASE_UNIT_SUGGESTIONS,
} from '../../shared/types'

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'
const labelCls = 'block text-xs font-semibold text-brown-medium mb-1'

function Toast({ message }: { message: string }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 bg-[#3D2410] text-white text-sm font-medium px-4 py-2.5 rounded-xl shadow-xl">
      ✅ {message}
    </div>
  )
}

function useToast() {
  const [toast, setToast] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function show(msg: string) {
    setToast(msg)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setToast(''), 2200)
  }
  return { toast, show }
}

// ─── Add / edit modal ─────────────────────────────────────────────────────────

function ItemModal({ item, suppliers, onClose, onSaved }: {
  item: Partial<Item> | null
  suppliers: Supplier[]
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    name: item?.name ?? '',
    name_zh: item?.name_zh ?? '',
    category: (item?.category ?? 'raw') as ItemCategory,
    supplier_id: item?.supplier_id ?? '',
    purchase_unit: item?.purchase_unit ?? '',
    base_unit: item?.base_unit ?? '',
    conversion_rate: item?.conversion_rate != null ? String(item.conversion_rate) : '',
    latest_price: item?.latest_price != null ? String(item.latest_price) : '',
    min_stock_alert: item?.min_stock_alert != null ? String(item.min_stock_alert) : '0',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  const rate = Number(form.conversion_rate)
  const pu = form.purchase_unit.trim() || '采购单位'
  const bu = form.base_unit.trim() || '基础单位'

  async function handleSave() {
    if (!form.name.trim()) return setError('Item name is required.')
    if (!form.purchase_unit.trim()) return setError('Purchase unit is required (e.g. 包).')
    if (!form.base_unit.trim()) return setError('Base unit is required (e.g. g).')
    if (!form.conversion_rate || !(rate > 0)) return setError('Conversion rate must be greater than 0.')

    setSaving(true)
    setError('')
    const payload = {
      name: form.name.trim(),
      name_zh: form.name_zh.trim() || null,
      category: form.category,
      supplier_id: form.supplier_id || null,
      purchase_unit: form.purchase_unit.trim(),
      base_unit: form.base_unit.trim(),
      conversion_rate: rate,
      latest_price: form.latest_price === '' ? null : Number(form.latest_price),
      min_stock_alert: form.min_stock_alert === '' ? 0 : Number(form.min_stock_alert),
    }
    const { error: err } = item?.id
      ? await supabase.from('items').update(payload).eq('id', item.id)
      : await supabase.from('items').insert(payload)
    setSaving(false)
    if (err) { setError(err.message); return }
    onSaved()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-cream-light rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E8DDD0] sticky top-0 bg-cream-light z-10">
          <h2 className="font-bold text-brown-dark text-lg">{item?.id ? 'Edit Item' : 'Add Item'}</h2>
          <button onClick={onClose} className="text-brown-faint hover:text-brown-dark text-xl leading-none">✕</button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Item Name *</label>
              <input className={inputCls} value={form.name} onChange={set('name')} placeholder="Coffee Beans" />
            </div>
            <div>
              <label className={labelCls}>中文名</label>
              <input className={inputCls} value={form.name_zh} onChange={set('name_zh')} placeholder="咖啡豆" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Category</label>
              <select className={inputCls} value={form.category} onChange={set('category')}>
                {ITEM_CATEGORIES.map(c => (
                  <option key={c} value={c}>{ITEM_CATEGORY_LABELS[c]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Main Supplier</label>
              <select className={inputCls} value={form.supplier_id} onChange={set('supplier_id')}>
                <option value="">None</option>
                {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </div>

          {/* Unit conversion — the heart of the form. */}
          <div className="rounded-xl border border-[#D4C5B0] bg-[#FBF6EE] p-4">
            <label className={labelCls}>Unit Conversion *</label>
            <p className="text-xs text-brown-faint mb-3">
              采购按「{pu}」下单,库存按「{bu}」记账。
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-brown-dark">1</span>
              <input
                className={`${inputCls} w-24`}
                list="purchase-units"
                value={form.purchase_unit}
                onChange={set('purchase_unit')}
                placeholder="包"
              />
              <datalist id="purchase-units">
                {PURCHASE_UNIT_SUGGESTIONS.map(u => <option key={u} value={u} />)}
              </datalist>

              <span className="text-sm font-semibold text-brown-dark">=</span>

              <input
                type="number"
                step="any"
                min="0"
                className={`${inputCls} w-28`}
                value={form.conversion_rate}
                onChange={set('conversion_rate')}
                placeholder="2000"
              />
              <input
                className={`${inputCls} w-24`}
                list="base-units"
                value={form.base_unit}
                onChange={set('base_unit')}
                placeholder="g"
              />
              <datalist id="base-units">
                {BASE_UNIT_SUGGESTIONS.map(u => <option key={u} value={u} />)}
              </datalist>
            </div>
            {rate > 0 && form.purchase_unit && form.base_unit && (
              <p className="text-xs text-[#3D7A50] mt-2.5 font-medium">
                ✓ 1 {form.purchase_unit} = {qty(rate)} {form.base_unit}
                {' · '}下单 10 {form.purchase_unit} 会入库 {qty(rate * 10)} {form.base_unit}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Latest Price (RM / {pu})</label>
              <input
                type="number" step="0.01" min="0"
                className={inputCls}
                value={form.latest_price}
                onChange={set('latest_price')}
                placeholder="45.00"
              />
              <p className="text-xs text-brown-faint mt-1">收货时会按 invoice 自动更新。</p>
            </div>
            <div>
              <label className={labelCls}>Low Stock Alert ({bu})</label>
              <input
                type="number" step="any" min="0"
                className={inputCls}
                value={form.min_stock_alert}
                onChange={set('min_stock_alert')}
                placeholder="1000"
              />
              <p className="text-xs text-brown-faint mt-1">0 = 不提醒。</p>
            </div>
          </div>

          <div className="flex gap-3 pt-1">
            <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-[#D4C5B0] text-sm text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 py-2.5 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors disabled:opacity-60"
            >
              {saving ? 'Saving...' : 'Save Item'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ItemsPage() {
  const { can } = useCan()
  const [items, setItems] = useState<Item[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [stock, setStock] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<ItemCategory | 'all'>('all')
  const [showInactive, setShowInactive] = useState(false)
  const [modalTarget, setModalTarget] = useState<Partial<Item> | null | 'new'>(null)
  const { toast, show } = useToast()

  async function load() {
    const [itemsRes, supRes, balRes] = await Promise.all([
      supabase.from('items').select('*, supplier:suppliers(id,name)').order('name'),
      supabase.from('suppliers').select('*').eq('status', 'active').order('name'),
      supabase.from('inventory_balances').select('*'),
    ])
    setItems((itemsRes.data as Item[]) ?? [])
    setSuppliers((supRes.data as Supplier[]) ?? [])

    // Sum across every branch the viewer can see; the detail page breaks it down.
    const totals: Record<string, number> = {}
    for (const b of ((balRes.data as InventoryBalance[]) ?? [])) {
      totals[b.item_id] = (totals[b.item_id] ?? 0) + Number(b.balance)
    }
    setStock(totals)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function toggleStatus(it: Item) {
    const next = it.status === 'active' ? 'inactive' : 'active'
    await supabase.from('items').update({ status: next }).eq('id', it.id)
    load()
    show(next === 'active' ? 'Item activated' : 'Item deactivated')
  }

  const term = search.trim().toLowerCase()
  const visible = items
    .filter(i => showInactive || i.status === 'active')
    .filter(i => categoryFilter === 'all' || i.category === categoryFilter)
    .filter(i => !term
      || i.name.toLowerCase().includes(term)
      || (i.name_zh ?? '').toLowerCase().includes(term))

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-6xl mx-auto px-4 py-8 lg:px-8 space-y-6">
        {toast && <Toast message={toast} />}

        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-brown-dark">Items</h1>
            <p className="text-sm text-brown-faint mt-0.5">物料管理 · What you buy and stock.</p>
          </div>
          {can('manage_procurement') && (
            <button
              onClick={() => setModalTarget('new')}
              className="px-4 py-2 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors"
            >
              + Add Item
            </button>
          )}
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <input
            className={`${inputCls} max-w-xs`}
            placeholder="Search name…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select
            className={`${inputCls} w-auto`}
            value={categoryFilter}
            onChange={e => setCategoryFilter(e.target.value as ItemCategory | 'all')}
          >
            <option value="all">All categories</option>
            {ITEM_CATEGORIES.map(c => <option key={c} value={c}>{ITEM_CATEGORY_LABELS[c]}</option>)}
          </select>
          <label className="flex items-center gap-2 text-xs text-brown-muted cursor-pointer">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={e => setShowInactive(e.target.checked)}
              className="accent-[#C4813A]"
            />
            Show inactive
          </label>
        </div>

        {loading ? (
          <p className="text-sm text-brown-faint py-8 text-center">Loading…</p>
        ) : visible.length === 0 ? (
          <div className="bg-white rounded-xl border border-[#E8DDD0] px-6 py-10 text-center">
            <p className="text-sm text-brown-muted">
              {items.length === 0 ? 'No items yet.' : 'No items match those filters.'}
            </p>
            {items.length === 0 && (
              <p className="text-xs text-brown-faint mt-1">Add items so you can put them on a purchase order.</p>
            )}
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-[#E8DDD0] overflow-x-auto">
            <table className="w-full text-sm min-w-[760px]">
              <thead>
                <tr className="text-left text-xs text-brown-faint border-b border-[#EDE5D8]">
                  <th className="px-4 py-3 font-semibold">Item</th>
                  <th className="px-4 py-3 font-semibold">Category</th>
                  <th className="px-4 py-3 font-semibold">Supplier</th>
                  <th className="px-4 py-3 font-semibold">Conversion</th>
                  <th className="px-4 py-3 font-semibold text-right">Latest Price</th>
                  <th className="px-4 py-3 font-semibold text-right">In Stock</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F0E8DC]">
                {visible.map(i => {
                  const balance = stock[i.id] ?? 0
                  const low = isBelowAlert(balance, i.min_stock_alert)
                  return (
                    <tr key={i.id} className={i.status === 'inactive' ? 'opacity-60' : ''}>
                      <td className="px-4 py-3">
                        <Link to={`/procurement/items/${i.id}`} className="font-medium text-brown-dark hover:text-[#C4813A] transition-colors">
                          {i.name}
                        </Link>
                        {i.name_zh && <p className="text-xs text-brown-faint">{i.name_zh}</p>}
                      </td>
                      <td className="px-4 py-3 text-xs text-brown-muted">{ITEM_CATEGORY_LABELS[i.category]}</td>
                      <td className="px-4 py-3 text-xs text-brown-muted">{i.supplier?.name ?? '—'}</td>
                      <td className="px-4 py-3 text-xs text-brown-muted whitespace-nowrap">
                        1 {i.purchase_unit} = {qty(i.conversion_rate)} {i.base_unit}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {i.latest_price == null ? (
                          <span className="text-xs text-brown-faint">—</span>
                        ) : (
                          <span className="text-brown-dark">{money(i.latest_price)}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <span className={low ? 'text-[#9E4A30] font-semibold' : 'text-brown-dark'}>
                          {qty(balance)} {i.base_unit}
                        </span>
                        {low && <p className="text-[10px] text-[#9E4A30]">below {qty(i.min_stock_alert)}</p>}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {can('manage_procurement') && (
                          <div className="flex gap-2 justify-end">
                            <button
                              onClick={() => setModalTarget(i)}
                              className="px-3 py-1.5 text-xs rounded-lg border border-[#D4C5B0] text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => toggleStatus(i)}
                              className="px-3 py-1.5 text-xs rounded-lg border border-[#D4C5B0] text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors"
                            >
                              {i.status === 'active' ? 'Deactivate' : 'Activate'}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modalTarget && (
        <ItemModal
          item={modalTarget === 'new' ? null : modalTarget}
          suppliers={suppliers}
          onClose={() => setModalTarget(null)}
          onSaved={() => { load(); show('Item saved') }}
        />
      )}
    </div>
  )
}
