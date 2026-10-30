import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Card, Button } from '../../shared/components/ui'
import { supabase } from '../../shared/lib/supabase'
import type { AccountRow } from './claimDesk'

const cellInput = 'w-full px-2 py-1.5 rounded-md border border-border-mid bg-canvas text-sm'

/** The classification guide in short, and the chart of accounts with AutoCount codes. */
export function GuideTab({ accounts, onSaved }: { accounts: AccountRow[]; onSaved: () => void }) {
  const [rows, setRows] = useState<AccountRow[]>(accounts)
  const [msg, setMsg] = useState('')
  useEffect(() => setRows(accounts), [accounts])

  async function save() {
    const clean = rows.map(a => ({ name: a.name.trim(), code: a.code.trim() })).filter(a => a.name)
    const { error, count } = await supabase.from('account_config').update({ accounts: clean, updated_at: new Date().toISOString() }, { count: 'exact' }).eq('id', 1)
    setMsg(error ? error.message : count === 0 ? 'Not saved — you may not have access.' : 'Saved.')
    if (!error) onSaved()
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-brown-dark">Classification guide</h2>
        <p className="text-sm text-brown-muted max-w-2xl">Every document is a Source Document that must match one Voucher in AutoCount — that is the Audit Trail. Keep records in English or Malay for 7 years (ITA 1967 s82).</p>
      </div>
      <div className="overflow-x-auto rounded-2xl bg-white shadow-card">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-canvas text-[11px] uppercase tracking-wider text-brown-muted">
            <tr><th className="text-left p-3">Source</th><th className="text-left p-3">Audit document name</th><th className="text-left p-3">AutoCount</th><th className="text-left p-3">e-Invoice</th></tr>
          </thead>
          <tbody className="divide-y divide-line text-brown-dark align-top">
            <tr><td className="p-3 font-semibold">Paper invoice<br /><span className="font-normal text-brown-muted">local supplier</span></td><td className="p-3">Supplier Invoice; Tax Invoice with SST; Cash Bill / Receipt when small</td><td className="p-3">On credit: Purchase Invoice (Creditor)<br />Paid: Cash Book → Payment Voucher</td><td className="p-3">Supplier should issue an e-Invoice; paper is supporting</td></tr>
            <tr><td className="p-3 font-semibold">Taobao<br /><span className="font-normal text-brown-muted">staff paid</span></td><td className="p-3">Foreign Supplier Purchase → Staff Expense Claim, with order screenshots, proof of payment and English translation</td><td className="p-3">Expense Claim → Payment Voucher to the staff member; record CNY, rate and MYR</td><td className="p-3">Company issues a <b>self-billed e-Invoice</b></td></tr>
            <tr><td className="p-3 font-semibold">Shopee and other e-Invoices</td><td className="p-3">Validated e-Invoice (UUID + QR)</td><td className="p-3">Purchase Invoice or Cash Purchase</td><td className="p-3">Request e-Invoice with the company TIN</td></tr>
          </tbody>
        </table>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="space-y-2">
          <p className="text-[11px] font-bold uppercase tracking-wider text-brown-muted">The 4 fields on every document</p>
          <ol className="list-decimal pl-5 text-sm space-y-1">
            <li><b>Document Type</b> — invoice, receipt, e-Invoice, expense claim, credit note</li>
            <li><b>Account</b> — Purchases (Cost of Sales), operating expenses, or Fixed Asset (PPE)</li>
            <li><b>Tax Treatment</b> — allowable (s33), capital allowance (≤ RM2,000 is a Small Value Asset), non-allowable</li>
            <li><b>Payment</b> — unpaid (Accounts Payable), paid by company, staff-paid (reimbursement)</li>
          </ol>
        </Card>
        <Card className="space-y-2">
          <p className="text-[11px] font-bold uppercase tracking-wider text-brown-muted">Monthly routine</p>
          <ol className="list-decimal pl-5 text-sm space-y-1">
            <li>e-Invoice inbox → Sync the month from MyInvois</li>
            <li>Scan the month's paper invoices</li>
            <li>Approve staff claims in HR → Claims (they appear here)</li>
            <li>Check Account and Tax Treatment, set status Reviewed</li>
            <li>Export the AutoCount CSV, then set status Posted</li>
            <li>Issue the month's self-billed e-Invoices in MyInvois and record their UUIDs</li>
          </ol>
        </Card>
      </div>
      <p className="text-xs text-brown-faint">Confirm self-billed e-Invoice deadlines and the company's e-Invoice phase with the tax agent.</p>

      <Card className="space-y-3">
        <div>
          <p className="font-semibold text-brown-dark">Chart of accounts</p>
          <p className="text-sm text-brown-muted">Fill in the AutoCount account code for each name — the CSV export carries it. Staff see these names when they claim.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <thead className="text-[11px] uppercase tracking-wider text-brown-muted"><tr><th className="text-left p-2">Account name</th><th className="text-left p-2 w-40">AutoCount code</th><th className="w-10" /></tr></thead>
            <tbody>
              {rows.map((a, i) => (
                <tr key={i}>
                  <td className="p-1"><input className={cellInput} value={a.name} onChange={e => setRows(r => r.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} /></td>
                  <td className="p-1"><input className={`${cellInput} font-mono`} placeholder="e.g. 610-000" value={a.code} onChange={e => setRows(r => r.map((x, j) => j === i ? { ...x, code: e.target.value } : x))} /></td>
                  <td className="p-1"><button type="button" aria-label="Remove account" className="p-1.5 text-bad" onClick={() => setRows(r => r.filter((_, j) => j !== i))}><Trash2 size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex gap-2 items-center">
          <Button variant="secondary" size="sm" onClick={() => setRows(r => [...r, { name: '', code: '' }])}>Add account</Button>
          <Button variant="dark" size="sm" onClick={save}>Save accounts</Button>
          {msg && <span className="text-xs text-brown-muted" role="status">{msg}</span>}
        </div>
      </Card>
    </div>
  )
}
