import { useState, useEffect, useRef } from 'react'
import { supabase } from '../../shared/lib/supabase'
import type { Supplier } from '../../shared/types'

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

function SupplierModal({ supplier, onClose, onSaved }: {
  supplier: Partial<Supplier> | null
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    name: supplier?.name ?? '',
    contact_person: supplier?.contact_person ?? '',
    phone: supplier?.phone ?? '',
    whatsapp: supplier?.whatsapp ?? '',
    email: supplier?.email ?? '',
    address: supplier?.address ?? '',
    payment_terms: supplier?.payment_terms ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function handleSave() {
    if (!form.name.trim()) {
      setError('Supplier name is required.')
      return
    }
    setSaving(true)
    setError('')
    const payload = {
      name: form.name.trim(),
      contact_person: form.contact_person.trim() || null,
      phone: form.phone.trim() || null,
      whatsapp: form.whatsapp.trim() || null,
      email: form.email.trim() || null,
      address: form.address.trim() || null,
      payment_terms: form.payment_terms.trim() || null,
    }
    const { error: err } = supplier?.id
      ? await supabase.from('suppliers').update(payload).eq('id', supplier.id)
      : await supabase.from('suppliers').insert(payload)
    setSaving(false)
    if (err) { setError(err.message); return }
    onSaved()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-cream-light rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E8DDD0] sticky top-0 bg-cream-light">
          <h2 className="font-bold text-brown-dark text-lg">
            {supplier?.id ? 'Edit Supplier' : 'Add Supplier'}
          </h2>
          <button onClick={onClose} className="text-brown-faint hover:text-brown-dark text-xl leading-none">✕</button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
          <div>
            <label className={labelCls}>Supplier Name *</label>
            <input className={inputCls} value={form.name} onChange={set('name')} placeholder="e.g. ABC Trading Sdn Bhd" />
          </div>
          <div>
            <label className={labelCls}>Contact Person</label>
            <input className={inputCls} value={form.contact_person} onChange={set('contact_person')} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Phone</label>
              <input className={inputCls} value={form.phone} onChange={set('phone')} placeholder="03-1234 5678" />
            </div>
            <div>
              <label className={labelCls}>WhatsApp</label>
              <input className={inputCls} value={form.whatsapp} onChange={set('whatsapp')} placeholder="012-345 6789" />
            </div>
          </div>
          <div>
            <label className={labelCls}>Email</label>
            <input type="email" className={inputCls} value={form.email} onChange={set('email')} />
          </div>
          <div>
            <label className={labelCls}>Address</label>
            <textarea rows={2} className={`${inputCls} resize-none`} value={form.address} onChange={set('address')} />
          </div>
          <div>
            <label className={labelCls}>Payment Terms</label>
            <input className={inputCls} value={form.payment_terms} onChange={set('payment_terms')} placeholder="e.g. 30 days / COD" />
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
              {saving ? 'Saving...' : 'Save Supplier'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [modalTarget, setModalTarget] = useState<Partial<Supplier> | null | 'new'>(null)
  const { toast, show } = useToast()

  async function load() {
    const { data } = await supabase.from('suppliers').select('*').order('name')
    setSuppliers((data as Supplier[]) ?? [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function toggleStatus(s: Supplier) {
    const next = s.status === 'active' ? 'inactive' : 'active'
    await supabase.from('suppliers').update({ status: next }).eq('id', s.id)
    load()
    show(next === 'active' ? 'Supplier activated' : 'Supplier deactivated')
  }

  const term = search.trim().toLowerCase()
  const visible = suppliers
    .filter(s => showInactive || s.status === 'active')
    .filter(s => !term
      || s.name.toLowerCase().includes(term)
      || (s.contact_person ?? '').toLowerCase().includes(term))

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-5xl mx-auto px-4 py-8 lg:px-8 space-y-6">
        {toast && <Toast message={toast} />}

        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-brown-dark">Suppliers</h1>
            <p className="text-sm text-brown-faint mt-0.5">供应商管理 · Who you buy from.</p>
          </div>
          <button
            onClick={() => setModalTarget('new')}
            className="px-4 py-2 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors"
          >
            + Add Supplier
          </button>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <input
            className={`${inputCls} max-w-xs`}
            placeholder="Search name or contact…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
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
              {suppliers.length === 0 ? 'No suppliers yet.' : 'No suppliers match that search.'}
            </p>
            {suppliers.length === 0 && (
              <p className="text-xs text-brown-faint mt-1">Add your first supplier to start raising purchase orders.</p>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {visible.map(s => (
              <div
                key={s.id}
                className={`bg-white rounded-xl border border-[#E8DDD0] p-4 flex items-center gap-4 flex-wrap ${
                  s.status === 'inactive' ? 'opacity-60' : ''
                }`}
              >
                <div className="flex-1 min-w-[200px]">
                  <p className="text-sm font-semibold text-brown-dark">{s.name}</p>
                  <p className="text-xs text-brown-faint">{s.contact_person || '—'}</p>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-xs text-brown-muted">
                    {s.phone && <span>📞 {s.phone}</span>}
                    {s.whatsapp && <span>💬 {s.whatsapp}</span>}
                    {s.payment_terms && <span>💳 {s.payment_terms}</span>}
                  </div>
                </div>
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                  s.status === 'active' ? 'bg-[#EBF5EE] text-[#3D7A50]' : 'bg-[#F0E8DC] text-brown-faint'
                }`}>
                  {s.status === 'active' ? 'Active' : 'Inactive'}
                </span>
                <div className="flex gap-2 flex-shrink-0">
                  <button
                    onClick={() => setModalTarget(s)}
                    className="px-3 py-1.5 text-xs rounded-lg border border-[#D4C5B0] text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => toggleStatus(s)}
                    className="px-3 py-1.5 text-xs rounded-lg border border-[#D4C5B0] text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors"
                  >
                    {s.status === 'active' ? 'Deactivate' : 'Activate'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {modalTarget && (
        <SupplierModal
          supplier={modalTarget === 'new' ? null : modalTarget}
          onClose={() => setModalTarget(null)}
          onSaved={() => { load(); show('Supplier saved') }}
        />
      )}
    </div>
  )
}
