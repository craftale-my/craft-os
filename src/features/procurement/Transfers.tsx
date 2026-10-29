import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { money, qty, canAccessBranch, formatDateTimeMYT } from '../../shared/lib/procurement'
import type { Branch, Item, PoShipment, PoTransferLine, PurchaseOrder } from '../../shared/types'

/** One internal PO with its transfer lines. */
interface TransferPo {
  poId: string
  poNumber: string
  fromBranchId: string
  toBranchId: string
  createdAt: string | null
  lastShippedAt: string | null
  lines: PoTransferLine[]
}

const DATE: Intl.DateTimeFormatOptions = { timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: 'short', year: 'numeric' }

function num(v: number | null | undefined): number {
  return Number(v ?? 0)
}

function EmptyCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-[#E8DDD0] px-6 py-8 text-center">
      <p className="text-sm text-brown-muted">{children}</p>
    </div>
  )
}

export default function TransfersPage() {
  const { staff } = useAuth()

  const [lines, setLines] = useState<PoTransferLine[]>([])
  const [orders, setOrders] = useState<Map<string, Pick<PurchaseOrder, 'id' | 'created_at'>>>(new Map())
  const [shipments, setShipments] = useState<Pick<PoShipment, 'po_id' | 'shipped_at'>[]>([])
  const [items, setItems] = useState<Map<string, Pick<Item, 'id' | 'name' | 'purchase_unit'>>>(new Map())
  const [branches, setBranches] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    async function load() {
      // RLS returns the internal POs the viewer may see: their branch's own
      // orders, plus (for HQ) the orders addressed to HQ.
      const { data, error: lineErr } = await supabase.from('po_transfer_lines').select('*')
      if (lineErr) { setError(lineErr.message); setLoading(false); return }
      const rows = (data as PoTransferLine[]) ?? []
      const poIds = [...new Set(rows.map(r => r.po_id))]
      const itemIds = [...new Set(rows.map(r => r.item_id))]

      const [poRes, shipRes, itemRes, branchRes] = await Promise.all([
        poIds.length
          ? supabase.from('purchase_orders').select('id, created_at').in('id', poIds)
          : Promise.resolve({ data: [], error: null }),
        poIds.length
          ? supabase.from('po_shipments').select('po_id, shipped_at').in('po_id', poIds)
          : Promise.resolve({ data: [], error: null }),
        itemIds.length
          ? supabase.from('items').select('id, name, purchase_unit').in('id', itemIds)
          : Promise.resolve({ data: [], error: null }),
        supabase.from('branches').select('id, name'),
      ])
      const err = poRes.error ?? shipRes.error ?? itemRes.error ?? branchRes.error
      if (err) setError(err.message)
      setLines(rows)
      setOrders(new Map(((poRes.data ?? []) as Pick<PurchaseOrder, 'id' | 'created_at'>[]).map(p => [p.id, p])))
      setShipments((shipRes.data ?? []) as Pick<PoShipment, 'po_id' | 'shipped_at'>[])
      setItems(new Map(((itemRes.data ?? []) as Pick<Item, 'id' | 'name' | 'purchase_unit'>[]).map(i => [i.id, i])))
      setBranches(new Map(((branchRes.data ?? []) as Pick<Branch, 'id' | 'name'>[]).map(b => [b.id, b.name])))
      setLoading(false)
    }
    load()
  }, [])

  const pos = useMemo(() => {
    const lastShipped = new Map<string, string>()
    for (const s of shipments) {
      const prev = lastShipped.get(s.po_id)
      if (!prev || s.shipped_at > prev) lastShipped.set(s.po_id, s.shipped_at)
    }
    const byPo = new Map<string, TransferPo>()
    for (const l of lines) {
      let p = byPo.get(l.po_id)
      if (!p) {
        p = {
          poId: l.po_id,
          poNumber: l.po_number,
          fromBranchId: l.from_branch_id,
          toBranchId: l.to_branch_id,
          createdAt: orders.get(l.po_id)?.created_at ?? null,
          lastShippedAt: lastShipped.get(l.po_id) ?? null,
          lines: [],
        }
        byPo.set(l.po_id, p)
      }
      p.lines.push(l)
    }
    return [...byPo.values()].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
  }, [lines, orders, shipments])

  const branchName = (id: string) => branches.get(id) ?? '—'
  const itemName = (id: string) => items.get(id)?.name ?? 'Unknown item'
  const unitOf = (id: string) => items.get(id)?.purchase_unit ?? ''

  // HQ view: what the viewer can ship.
  const toShip = pos.filter(p => canAccessBranch(staff, p.fromBranchId) && p.lines.some(l => num(l.to_ship_quantity) > 0))
  // Branch view: own orders HQ has not shipped yet (managers who can ship see them under To ship).
  const awaiting = pos.filter(p => !canAccessBranch(staff, p.fromBranchId) && canAccessBranch(staff, p.toBranchId)
    && p.lines.some(l => num(l.to_ship_quantity) > 0))
  const inTransit = pos.filter(p => p.lines.some(l => num(l.in_transit_quantity) > 0))
  const withLoss = pos.filter(p => p.lines.some(l => num(l.transit_loss_quantity) > 0)).slice(0, 10)
  const showToShip = toShip.length > 0 || pos.some(p => canAccessBranch(staff, p.fromBranchId))

  function itemSummary(p: TransferPo, pick: (l: PoTransferLine) => number): string {
    const parts = p.lines.filter(l => pick(l) > 0).map(l => `${itemName(l.item_id)} ${qty(pick(l))} ${unitOf(l.item_id)}`)
    return parts.length > 3 ? `${parts.slice(0, 3).join(', ')} +${parts.length - 3} more` : parts.join(', ')
  }

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-4xl mx-auto px-4 py-8 lg:px-8 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-brown-dark">Transfers</h1>
          <p className="text-sm text-brown-faint mt-0.5">Internal orders from HQ: what to ship and what is on the road.</p>
        </div>

        {error && (
          <div className="bg-[#FCF0EC] border border-[#C0624A40] rounded-xl px-4 py-3">
            <p className="text-sm font-semibold text-[#9E4A30]">Couldn't load transfers.</p>
            <p className="text-xs text-[#9E4A30] mt-0.5">{error}</p>
          </div>
        )}

        {loading ? (
          <p className="text-sm text-brown-faint py-8 text-center">Loading…</p>
        ) : (
          <>
            {showToShip && (
              <section>
                <h2 className="text-sm font-bold text-brown-dark mb-3">To ship ({toShip.length})</h2>
                {toShip.length === 0 ? (
                  <EmptyCard>Nothing waiting to be shipped.</EmptyCard>
                ) : (
                  <div className="space-y-2">
                    {toShip.map(p => {
                      const open = p.lines.filter(l => num(l.to_ship_quantity) > 0)
                      return (
                        <div key={p.poId} className="bg-white rounded-xl border border-[#E8DDD0] p-4 flex items-center gap-3 flex-wrap">
                          <div className="flex-1 min-w-[200px]">
                            <Link
                              to={`/procurement/orders/${p.poId}`}
                              className="text-sm font-semibold text-brown-dark hover:text-[#C4813A] transition-colors"
                            >
                              {p.poNumber}
                            </Link>
                            <p className="text-xs text-brown-faint">
                              For {branchName(p.toBranchId)}
                              {p.createdAt && ` · Raised ${new Date(p.createdAt).toLocaleDateString('en-GB', DATE)}`}
                              {` · ${open.length} line${open.length > 1 ? 's' : ''}`}
                            </p>
                            <p className="text-xs text-brown-muted mt-0.5">{itemSummary(p, l => num(l.to_ship_quantity))}</p>
                          </div>
                          <Link
                            to={`/procurement/transfers/${p.poId}/ship`}
                            className="px-4 py-2 rounded-xl bg-[#2E6E9E] text-white text-sm font-semibold hover:bg-[#24587F] transition-colors flex-shrink-0"
                          >
                            Ship
                          </Link>
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>
            )}

            {awaiting.length > 0 && (
              <section>
                <h2 className="text-sm font-bold text-brown-dark mb-3">Awaiting shipment from HQ ({awaiting.length})</h2>
                <div className="bg-white rounded-xl border border-[#E8DDD0] divide-y divide-[#F0E8DC]">
                  {awaiting.map(p => (
                    <div key={p.poId} className="px-4 py-3">
                      <Link
                        to={`/procurement/orders/${p.poId}`}
                        className="text-sm font-medium text-brown-dark hover:text-[#C4813A] transition-colors"
                      >
                        {p.poNumber}
                      </Link>
                      <p className="text-xs text-brown-faint">
                        {branchName(p.fromBranchId)} → {branchName(p.toBranchId)}
                        {p.createdAt && ` · Raised ${new Date(p.createdAt).toLocaleDateString('en-GB', DATE)}`}
                      </p>
                      <p className="text-xs text-brown-muted mt-0.5">{itemSummary(p, l => num(l.to_ship_quantity))}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section>
              <h2 className="text-sm font-bold text-brown-dark mb-3">In transit ({inTransit.length})</h2>
              {inTransit.length === 0 ? (
                <EmptyCard>Nothing on the road.</EmptyCard>
              ) : (
                <div className="space-y-2">
                  {inTransit.map(p => {
                    const moving = p.lines.filter(l => num(l.in_transit_quantity) > 0)
                    const value = moving.reduce((s, l) => s + num(l.in_transit_value), 0)
                    const canReceive = canAccessBranch(staff, p.toBranchId)
                    return (
                      <div key={p.poId} className="bg-white rounded-xl border border-[#E8DDD0] p-4 space-y-2">
                        <div className="flex items-center gap-3 flex-wrap">
                          <div className="flex-1 min-w-[200px]">
                            <Link
                              to={`/procurement/orders/${p.poId}`}
                              className="text-sm font-semibold text-brown-dark hover:text-[#C4813A] transition-colors"
                            >
                              {p.poNumber}
                            </Link>
                            <p className="text-xs text-brown-faint">
                              {branchName(p.fromBranchId)} → {branchName(p.toBranchId)}
                              {p.lastShippedAt && ` · Shipped ${formatDateTimeMYT(p.lastShippedAt)}`}
                            </p>
                          </div>
                          <span className="text-sm font-semibold text-[#2E6E9E]">{money(value)}</span>
                          {canReceive && (
                            <Link
                              to={`/procurement/receiving/${p.poId}`}
                              className="px-4 py-2 rounded-xl bg-[#3D7A50] text-white text-sm font-semibold hover:bg-[#2E6040] transition-colors flex-shrink-0"
                            >
                              Receive
                            </Link>
                          )}
                        </div>
                        <ul className="text-xs space-y-1">
                          {moving.map(l => (
                            <li key={l.po_item_id} className="flex justify-between gap-3 text-brown-dark">
                              <span>{itemName(l.item_id)}</span>
                              <span className="whitespace-nowrap">
                                {qty(num(l.in_transit_quantity))} {unitOf(l.item_id)}
                                <span className="text-brown-muted">
                                  {' · '}{l.in_transit_value == null ? 'no cost' : money(num(l.in_transit_value))}
                                </span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>

            {withLoss.length > 0 && (
              <section>
                <h2 className="text-sm font-bold text-[#9E4A30] mb-3">Recently received with loss</h2>
                <div className="bg-white rounded-xl border border-[#9E4A3040] divide-y divide-[#F0E8DC]">
                  {withLoss.map(p => {
                    const lost = p.lines.filter(l => num(l.transit_loss_quantity) > 0)
                    const value = lost.reduce((s, l) => s + num(l.transit_loss_value), 0)
                    return (
                      <div key={p.poId} className="px-4 py-3 flex items-start gap-3 flex-wrap">
                        <div className="flex-1 min-w-[200px]">
                          <Link
                            to={`/procurement/orders/${p.poId}`}
                            className="text-sm font-medium text-brown-dark hover:text-[#C4813A] transition-colors"
                          >
                            {p.poNumber}
                          </Link>
                          <p className="text-xs text-brown-faint">
                            {branchName(p.fromBranchId)} → {branchName(p.toBranchId)}
                          </p>
                          <p className="text-xs text-[#9E4A30] mt-0.5">{itemSummary(p, l => num(l.transit_loss_quantity))}</p>
                        </div>
                        <span className="text-sm font-bold text-[#9E4A30]">Lost {money(value)}</span>
                      </div>
                    )
                  })}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
