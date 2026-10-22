import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext'
import { useCan } from '../../../shared/lib/permissions'
import { fetchOpenBills, fetchTables, type OpenBillRow, type TableRow } from './posApi'
import { tableCards, takeawayBills } from './tableStatus'
import { usePosRealtime, type OrderInsert } from './usePosRealtime'
import TablesGrid from './TablesGrid'
import BillPanel from './BillPanel'

export type Selection = { kind: 'table'; tableId: string } | { kind: 'bill'; billId: string } | null

export default function PosPage() {
  const { staff } = useAuth()
  const { can } = useCan()
  const branchId = staff?.branch_id ?? null
  const [tables, setTables] = useState<TableRow[]>([])
  const [bills, setBills] = useState<OpenBillRow[]>([])
  const [newBillIds, setNewBillIds] = useState<Set<string>>(new Set())
  const [selection, setSelection] = useState<Selection>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!branchId) return
    try {
      const [t, b] = await Promise.all([fetchTables(branchId), fetchOpenBills(branchId)])
      setTables(t); setBills(b); setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [branchId])
  useEffect(() => { void reload() }, [reload])

  const onOrder = useCallback((row: OrderInsert) => {
    if (row.source === 'qr') setNewBillIds((s) => new Set(s).add(row.bill_id))
    setRefreshKey((k) => k + 1)
    void reload()
  }, [reload])
  const rtStatus = usePosRealtime(branchId, { onOrder, onSweep: reload })

  const cards = useMemo(() => tableCards(tables, bills, newBillIds), [tables, bills, newBillIds])
  const selectedTable = selection?.kind === 'table' ? tables.find((t) => t.id === selection.tableId) ?? null : null
  const selectedBill = selection?.kind === 'table'
    ? bills.find((b) => b.table_id === selection.tableId) ?? null
    : selection?.kind === 'bill' ? bills.find((b) => b.id === selection.billId) ?? null : null
  const selectedId = selection?.kind === 'table' ? selection.tableId : selection?.kind === 'bill' ? selection.billId : null

  const pick = (tableId: string) => {
    setSelection({ kind: 'table', tableId })
    const bill = bills.find((b) => b.table_id === tableId)
    if (bill) setNewBillIds((s) => { const n = new Set(s); n.delete(bill.id); return n })
  }

  if (!staff) return null
  if (!branchId) {
    return <div className="p-8 text-center">Your account has no branch — ask a manager to set it in Team.</div>
  }
  return (
    <div className="flex h-screen flex-col bg-cream">
      <header className="flex items-center justify-between border-b border-border bg-card px-4 py-2">
        <div className="font-semibold">Craft POS · {staff.branch ?? 'Branch'}</div>
        <div className="flex items-center gap-3 text-xs text-brown-muted">
          <span>Live: {rtStatus}</span>
          {can('access_settings') && <Link to="/pos/settings" className="underline">Tables & printers</Link>}
          <Link to="/profile" className="underline">Exit</Link>
        </div>
      </header>
      {error && <p className="m-3 rounded bg-red-50 p-2 text-sm text-red-700">{error} <button className="underline" onClick={() => void reload()}>Retry</button></p>}
      <div className="grid flex-1 grid-cols-[1fr_380px] gap-4 overflow-hidden p-4">
        <div className="overflow-y-auto">
          <TablesGrid cards={cards} takeaway={takeawayBills(bills)} selectedId={selectedId}
            onPick={pick} onTakeaway={() => setSelection(null)} onPickBill={(billId) => setSelection({ kind: 'bill', billId })} />
        </div>
        {(selectedTable || selectedBill) && (
          <BillPanel table={selectedTable} bill={selectedBill} refreshKey={refreshKey} onAddItems={() => undefined} />
        )}
      </div>
    </div>
  )
}
