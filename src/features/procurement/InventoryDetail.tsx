import { useState, useEffect } from 'react'
import { useParams, useSearchParams, Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { qty, money, isBelowAlert, formatUnitCost, parseTransferNote } from '../../shared/lib/procurement'
import type { Item, Branch, InventoryTransaction, InventoryValuation } from '../../shared/types'
import { TRANSACTION_TYPE_LABELS, WASTAGE_REASON_LABELS } from '../../shared/types'
import type { WastageReason } from '../../shared/types'

/** Reason codes are wastage reasons today; show anything else as stored. */
function reasonLabel(reason: string): string {
  return WASTAGE_REASON_LABELS[reason as WastageReason] ?? reason
}

function isTransfer(t: InventoryTransaction): boolean {
  return t.transaction_type === 'transfer_out' || t.transaction_type === 'transfer_in'
}

/** Receipt id → where a transfer_in came from (the internal PO it was received on). */
type TransferSource = Map<string, { poId: string; poNumber: string; from: string }>

/** "to Puchong · PO-…" / "from Craft Cafe HQ (Cheras) · PO-…", or null when unknown. */
function transferCounterpart(t: InventoryTransaction, sources: TransferSource): string | null {
  if (t.transaction_type === 'transfer_out') {
    const parsed = parseTransferNote(t.notes)
    if (!parsed) return null
    return `to ${parsed.branch}${parsed.poNumber ? ` · ${parsed.poNumber}` : ''}`
  }
  if (t.transaction_type === 'transfer_in' && t.reference_id) {
    const src = sources.get(t.reference_id)
    return src ? `from ${src.from} · ${src.poNumber}` : null
  }
  return null
}

export default function InventoryDetailPage() {
  const { itemId } = useParams<{ itemId: string }>()
  const [params] = useSearchParams()
  const branchParam = params.get('branch')

  const [item, setItem] = useState<Item | null>(null)
  const [branches, setBranches] = useState<Branch[]>([])
  const [balances, setBalances] = useState<InventoryValuation[]>([])
  const [txns, setTxns] = useState<InventoryTransaction[]>([])
  const [transferSources, setTransferSources] = useState<TransferSource>(new Map())
  const [branchFilter, setBranchFilter] = useState<string>(branchParam ?? 'all')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!itemId) return
    let cancelled = false

    async function load() {
      const [itemRes, branchRes, balRes, txnRes] = await Promise.all([
        supabase.from('items').select('*').eq('id', itemId).maybeSingle(),
        supabase.from('branches').select('*').eq('is_active', true).order('name'),
        supabase.from('inventory_valuation').select('*').eq('item_id', itemId),
        supabase
          .from('inventory_transactions')
          .select('*, creator:staff!inventory_transactions_created_by_fkey(id,name)')
          .eq('item_id', itemId)
          .order('created_at', { ascending: false })
          .limit(100),
      ])
      if (cancelled) return
      setItem(itemRes.data as Item | null)
      setBranches((branchRes.data as Branch[]) ?? [])
      setBalances((balRes.data as InventoryValuation[]) ?? [])
      const rows = (txnRes.data as InventoryTransaction[]) ?? []
      setTxns(rows)

      // transfer_in rows point at a receipt; look up its internal PO for the label.
      const receiptIds = [...new Set(rows
        .filter(t => t.transaction_type === 'transfer_in' && t.reference_id)
        .map(t => t.reference_id as string))]
      if (receiptIds.length > 0) {
        const { data } = await supabase
          .from('receivings')
          .select('id, po:purchase_orders(id, po_number, supplier:suppliers(name))')
          .in('id', receiptIds)
        if (cancelled) return
        type Row = { id: string; po: { id: string; po_number: string; supplier: { name: string } | null } | null }
        setTransferSources(new Map(((data as unknown as Row[]) ?? [])
          .filter(r => r.po)
          .map(r => [r.id, { poId: r.po!.id, poNumber: r.po!.po_number, from: r.po!.supplier?.name ?? 'HQ' }])))
      }
      setLoading(false)
    }

    load()
    return () => { cancelled = true }
  }, [itemId])

  if (loading) {
    return <div className="min-h-screen bg-cream-light px-4 py-8 text-center text-sm text-brown-faint">Loading…</div>
  }

  if (!item) {
    return (
      <div className="min-h-screen bg-cream-light px-4 py-8">
        <div className="max-w-3xl mx-auto text-center py-16">
          <p className="text-sm text-brown-muted">Item not found.</p>
          <Link to="/procurement/inventory" className="text-sm text-[#C4813A] font-semibold hover:underline mt-2 inline-block">
            ← Back to Inventory
          </Link>
        </div>
      </div>
    )
  }

  const branchName = (id: string) => branches.find(b => b.id === id)?.name ?? 'Unknown branch'
  const visibleTxns = branchFilter === 'all' ? txns : txns.filter(t => t.branch_id === branchFilter)
  const shownBalance = branchFilter === 'all'
    ? balances.reduce((s, b) => s + Number(b.balance), 0)
    : Number(balances.find(b => b.branch_id === branchFilter)?.balance ?? 0)
  const low = isBelowAlert(shownBalance, item.min_stock_alert)
  // Ledger value over the same rows the balance counts.
  const valuedRows = (branchFilter === 'all' ? balances : balances.filter(b => b.branch_id === branchFilter))
    .filter(b => b.stock_value != null)
  const shownValue = valuedRows.length > 0
    ? valuedRows.reduce((s, b) => s + Number(b.stock_value), 0)
    : null
  const shownAvgCost = shownValue != null && shownBalance > 0 ? shownValue / shownBalance : null

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-3xl mx-auto px-4 py-8 lg:px-8 space-y-5">
        <div>
          <Link to="/procurement/inventory" className="text-xs text-brown-faint hover:text-[#C4813A] transition-colors">
            ← Inventory
          </Link>
          <h1 className="text-2xl font-bold text-brown-dark mt-1">{item.name}</h1>
        </div>

        <section className="bg-white rounded-xl border border-[#E8DDD0] p-5">
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <div>
              <p className="text-xs text-brown-faint mb-1">
                {branchFilter === 'all' ? 'All branches' : branchName(branchFilter)}
              </p>
              <div className="flex items-baseline gap-2">
                <span className={`text-3xl font-bold ${low ? 'text-[#9E4A30]' : 'text-brown-dark'}`}>
                  {qty(shownBalance)}
                </span>
                <span className="text-sm text-brown-muted">{item.base_unit}</span>
              </div>
              {low && (
                <p className="text-xs text-[#9E4A30] font-semibold mt-1">
                  ⚠ At or below the {qty(item.min_stock_alert)} {item.base_unit} alert level
                </p>
              )}
            </div>
            <select
              className="px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]"
              value={branchFilter}
              onChange={e => setBranchFilter(e.target.value)}
            >
              <option value="all">All branches</option>
              {balances.map(b => (
                <option key={b.branch_id} value={b.branch_id}>{branchName(b.branch_id)}</option>
              ))}
            </select>
          </div>
        </section>

        <section className="bg-white rounded-xl border border-[#E8DDD0] p-5">
          <h2 className="text-sm font-bold text-brown-dark mb-3">Stock Movements</h2>
          {visibleTxns.length === 0 ? (
            <p className="text-xs text-brown-faint text-center py-6">
              No movements recorded{branchFilter !== 'all' ? ' for this branch' : ''} yet.
            </p>
          ) : (
            <div className="divide-y divide-[#F0E8DC] border-t border-[#EDE5D8]">
              {visibleTxns.map(t => (
                <div key={t.id} className="flex items-center gap-3 py-3 flex-wrap">
                  <div className="flex-1 min-w-[160px]">
                    <p className="text-sm font-medium text-brown-dark">
                      {TRANSACTION_TYPE_LABELS[t.transaction_type] ?? t.transaction_type}
                      {t.reason && (
                        <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-[#9E4A3014] text-[#9E4A30] ml-2">
                          {reasonLabel(t.reason)}
                        </span>
                      )}
                      {isTransfer(t) ? (
                        transferCounterpart(t, transferSources) && (
                          <span className="text-xs text-[#2E6E9E] font-normal ml-2">
                            {transferCounterpart(t, transferSources)}
                          </span>
                        )
                      ) : t.reference_type && t.reference_type !== t.transaction_type && (
                        <span className="text-xs text-brown-faint font-normal ml-2">
                          from {t.reference_type}
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-brown-faint">
                      {new Date(t.created_at).toLocaleString('en-GB', {
                        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
                      })}
                      {' · '}{branchName(t.branch_id)}
                      {t.creator?.name && ` · ${t.creator.name}`}
                    </p>
                    {/* A transfer_out note is the counterpart, already shown above. */}
                    {t.notes && !(t.transaction_type === 'transfer_out' && parseTransferNote(t.notes)) && (
                      <p className="text-xs text-brown-muted italic mt-0.5">{t.notes}</p>
                    )}
                  </div>
                  <span className={`text-sm font-bold whitespace-nowrap ${
                    Number(t.quantity) >= 0 ? 'text-[#3D7A50]' : 'text-[#9E4A30]'
                  }`}>
                    {Number(t.quantity) >= 0 ? '+' : ''}{qty(Number(t.quantity))} {item.base_unit}
                  </span>
                </div>
              ))}
            </div>
          )}
          {shownValue != null && (
            <p className="text-xs text-brown-faint mt-3 pt-3 border-t border-[#EDE5D8]">
              Valued at {money(shownValue)}
              {shownAvgCost != null && <> at average cost {formatUnitCost(shownAvgCost, item.base_unit)}</>}.
            </p>
          )}
        </section>
      </div>
    </div>
  )
}
