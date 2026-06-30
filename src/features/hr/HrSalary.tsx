import { useState, useEffect } from 'react'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from '../auth/AuthContext'
import type { Staff, SalaryRecord } from '../../shared/types'
import { MONTHS_FULL } from '../../shared/types'
import { toCSV, downloadCSV } from '../../shared/lib/csv'

const inputCls = 'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'
const labelCls = 'block text-xs font-semibold text-brown-medium mb-1'

function money(n: number): string {
  return `RM ${n.toFixed(2)}`
}

// ─── Salary modal ──────────────────────────────────────────────────────────────

function SalaryModal({ staffMember, record, month, year, managerId, onClose, onSaved }: {
  staffMember: Staff
  record: SalaryRecord | null
  month: number
  year: number
  managerId: string | undefined
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    basic_salary: record?.basic_salary ?? 0,
    allowances: record?.allowances ?? 0,
    overtime: record?.overtime ?? 0,
    deductions: record?.deductions ?? 0,
    bonus: record?.bonus ?? 0,
    epf_employee: record?.epf_employee ?? 0,
    socso_employee: record?.socso_employee ?? 0,
    eis_employee: record?.eis_employee ?? 0,
    pcb: record?.pcb ?? 0,
    payment_date: record?.payment_date ?? '',
    payment_method: record?.payment_method ?? 'bank_transfer',
    notes: record?.notes ?? '',
  })
  const [saving, setSaving] = useState(false)

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  const numField = (k: keyof typeof form, label: string) => (
    <div>
      <label className={labelCls}>{label}</label>
      <input type="number" step="0.01" className={inputCls} value={form[k]} onChange={set(k)} />
    </div>
  )

  async function handleSave() {
    setSaving(true)
    const payload = {
      staff_id: staffMember.id,
      month,
      year,
      basic_salary: Number(form.basic_salary),
      allowances: Number(form.allowances),
      overtime: Number(form.overtime),
      deductions: Number(form.deductions),
      bonus: Number(form.bonus),
      epf_employee: Number(form.epf_employee),
      socso_employee: Number(form.socso_employee),
      eis_employee: Number(form.eis_employee),
      pcb: Number(form.pcb),
      payment_date: form.payment_date || null,
      payment_method: form.payment_method,
      notes: form.notes.trim() || null,
      created_by: managerId ?? null,
    }
    await supabase.from('salary_records').upsert(payload, { onConflict: 'staff_id,month,year' })
    setSaving(false)
    onSaved()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-cream-light rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E8DDD0]">
          <h2 className="font-bold text-brown-dark text-lg">{staffMember.name} — {MONTHS_FULL[month - 1]} {year}</h2>
          <button onClick={onClose} className="text-brown-faint hover:text-brown-dark text-xl leading-none">✕</button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {numField('basic_salary', 'Basic Salary (RM)')}
            {numField('allowances', 'Allowances (RM)')}
            {numField('overtime', 'Overtime (RM)')}
            {numField('bonus', 'Bonus (RM)')}
            {numField('deductions', 'Deductions (RM)')}
          </div>
          <div className="border-t border-[#E8DDD0] pt-3">
            <p className="text-xs font-semibold text-brown-faint uppercase tracking-wide mb-2">Statutory Deductions</p>
            <div className="grid grid-cols-2 gap-3">
              {numField('epf_employee', 'EPF (RM)')}
              {numField('socso_employee', 'SOCSO (RM)')}
              {numField('eis_employee', 'EIS (RM)')}
              {numField('pcb', 'PCB (RM)')}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Payment Date</label>
              <input type="date" className={inputCls} value={form.payment_date} onChange={set('payment_date')} />
            </div>
            <div>
              <label className={labelCls}>Payment Method</label>
              <select className={inputCls} value={form.payment_method} onChange={set('payment_method')}>
                <option value="bank_transfer">Bank Transfer</option>
                <option value="cash">Cash</option>
                <option value="cheque">Cheque</option>
              </select>
            </div>
          </div>
          <div>
            <label className={labelCls}>Notes</label>
            <textarea rows={2} className={`${inputCls} resize-none`} value={form.notes} onChange={set('notes')} />
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
              {saving ? 'Saving...' : 'Save Record'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function openPayslip(staffMember: Staff, record: SalaryRecord) {
  const win = window.open('', '_blank')
  if (!win) return
  win.document.write(`
    <html><head><title>Payslip — ${staffMember.name}</title>
    <style>
      body { font-family: -apple-system, sans-serif; padding: 40px; color: #3D2410; }
      h1 { font-size: 20px; margin-bottom: 0; }
      .sub { color: #8B7355; font-size: 13px; margin-bottom: 24px; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
      td { padding: 6px 0; border-bottom: 1px solid #EDE5D8; font-size: 14px; }
      td.amt { text-align: right; }
      .total td { font-weight: bold; border-top: 2px solid #3D2410; border-bottom: none; }
    </style></head>
    <body>
      <h1>Craft Cafe — Payslip</h1>
      <p class="sub">${staffMember.name} · ${MONTHS_FULL[record.month - 1]} ${record.year}</p>
      <table>
        <tr><td>Basic Salary</td><td class="amt">${money(record.basic_salary)}</td></tr>
        <tr><td>Allowances</td><td class="amt">${money(record.allowances)}</td></tr>
        <tr><td>Overtime</td><td class="amt">${money(record.overtime)}</td></tr>
        <tr><td>Bonus</td><td class="amt">${money(record.bonus)}</td></tr>
        <tr><td>Deductions</td><td class="amt">-${money(record.deductions)}</td></tr>
        <tr class="total"><td>Gross Salary</td><td class="amt">${money(record.gross_salary)}</td></tr>
        <tr><td>EPF (Employee)</td><td class="amt">-${money(record.epf_employee)}</td></tr>
        <tr><td>SOCSO (Employee)</td><td class="amt">-${money(record.socso_employee)}</td></tr>
        <tr><td>EIS (Employee)</td><td class="amt">-${money(record.eis_employee)}</td></tr>
        <tr><td>PCB</td><td class="amt">-${money(record.pcb)}</td></tr>
        <tr class="total"><td>Net Salary</td><td class="amt">${money(record.net_salary)}</td></tr>
      </table>
      <p class="sub">Payment: ${record.payment_method.replace('_', ' ')} ${record.payment_date ? `· ${record.payment_date}` : ''}</p>
      <script>window.print()</script>
    </body></html>
  `)
  win.document.close()
}

// ─── Manager view ───────────────────────────────────────────────────────────────

function ManagerSalaryView({ allStaff, managerId }: { allStaff: Staff[]; managerId: string | undefined }) {
  const now = new Date()
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [year, setYear] = useState(now.getFullYear())
  const [records, setRecords] = useState<Record<string, SalaryRecord>>({})
  const [modalTarget, setModalTarget] = useState<Staff | null>(null)
  const [copying, setCopying] = useState(false)
  const [exporting, setExporting] = useState(false)

  async function load() {
    const { data } = await supabase.from('salary_records').select('*').eq('month', month).eq('year', year)
    const map: Record<string, SalaryRecord> = {}
    ;(data as SalaryRecord[] | null)?.forEach(r => { map[r.staff_id] = r })
    setRecords(map)
  }

  useEffect(() => { load() }, [month, year])

  async function copyLastMonth() {
    setCopying(true)
    const prevMonth = month === 1 ? 12 : month - 1
    const prevYear = month === 1 ? year - 1 : year
    const { data } = await supabase.from('salary_records').select('*').eq('month', prevMonth).eq('year', prevYear)
    if (data && data.length > 0) {
      const rows = (data as SalaryRecord[]).map(r => ({
        staff_id: r.staff_id,
        month, year,
        basic_salary: r.basic_salary,
        allowances: r.allowances,
        overtime: 0,
        deductions: 0,
        bonus: 0,
        epf_employee: r.epf_employee,
        socso_employee: r.socso_employee,
        eis_employee: r.eis_employee,
        pcb: r.pcb,
        payment_method: r.payment_method,
        created_by: managerId ?? null,
      }))
      await supabase.from('salary_records').upsert(rows, { onConflict: 'staff_id,month,year' })
      load()
    }
    setCopying(false)
  }

  async function exportPayroll() {
    setExporting(true)
    const rows = allStaff.map(s => {
      const r = records[s.id]
      if (!r) return [s.name, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
      return [s.name, r.basic_salary, r.allowances, r.overtime, r.bonus, r.deductions, r.gross_salary, r.epf_employee, r.socso_employee, r.eis_employee, r.pcb, r.net_salary]
    })
    downloadCSV(
      `payroll_${MONTHS_FULL[month - 1]}_${year}.csv`,
      toCSV(['Name', 'Basic', 'Allowances', 'OT', 'Bonus', 'Deductions', 'Gross', 'EPF', 'SOCSO', 'EIS', 'PCB', 'Net'], rows)
    )
    setExporting(false)
  }

  const selectCls = 'px-3 py-1.5 rounded-lg border border-[#D4C5B0] bg-white text-xs text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select className={selectCls} value={month} onChange={e => setMonth(Number(e.target.value))}>
          {MONTHS_FULL.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
        <input type="number" className={`${selectCls} w-24`} value={year} onChange={e => setYear(Number(e.target.value))} />
        <button onClick={copyLastMonth} disabled={copying} className="px-3 py-1.5 rounded-lg border border-[#D4C5B0] text-xs text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors disabled:opacity-60">
          {copying ? 'Copying...' : 'Copy last month records'}
        </button>
        <button onClick={exportPayroll} disabled={exporting} className="px-3 py-1.5 rounded-lg border border-[#D4C5B0] text-xs text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors disabled:opacity-60">
          {exporting ? 'Exporting...' : 'Export Payroll CSV'}
        </button>
      </div>

      <div className="bg-white rounded-xl border border-[#E8DDD0] overflow-x-auto">
        <table className="w-full text-xs min-w-[900px]">
          <thead>
            <tr className="border-b border-[#EDE5D8]">
              {['Name', 'Basic', 'Allowances', 'OT', 'Bonus', 'Deductions', 'Gross', 'EPF', 'SOCSO', 'EIS', 'PCB', 'Net', ''].map(h => (
                <th key={h} className="text-left px-3 py-2.5 font-semibold text-brown-faint whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {allStaff.map((s, i) => {
              const r = records[s.id]
              return (
                <tr key={s.id} className={i > 0 ? 'border-t border-[#F0E8DC]' : ''}>
                  <td className="px-3 py-2 font-medium text-brown-dark whitespace-nowrap">{s.name}</td>
                  <td className="px-3 py-2">{r ? money(r.basic_salary) : '—'}</td>
                  <td className="px-3 py-2">{r ? money(r.allowances) : '—'}</td>
                  <td className="px-3 py-2">{r ? money(r.overtime) : '—'}</td>
                  <td className="px-3 py-2">{r ? money(r.bonus) : '—'}</td>
                  <td className="px-3 py-2">{r ? money(r.deductions) : '—'}</td>
                  <td className="px-3 py-2 font-semibold">{r ? money(r.gross_salary) : '—'}</td>
                  <td className="px-3 py-2">{r ? money(r.epf_employee) : '—'}</td>
                  <td className="px-3 py-2">{r ? money(r.socso_employee) : '—'}</td>
                  <td className="px-3 py-2">{r ? money(r.eis_employee) : '—'}</td>
                  <td className="px-3 py-2">{r ? money(r.pcb) : '—'}</td>
                  <td className="px-3 py-2 font-bold text-[#3D7A50]">{r ? money(r.net_salary) : '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <button onClick={() => setModalTarget(s)} className="text-xs font-semibold text-[#C4813A] hover:underline mr-2">
                      {r ? 'Edit' : 'Add'}
                    </button>
                    {r && <button onClick={() => openPayslip(s, r)} className="text-xs font-semibold text-brown-muted hover:underline">Payslip</button>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {modalTarget && (
        <SalaryModal
          staffMember={modalTarget}
          record={records[modalTarget.id] ?? null}
          month={month}
          year={year}
          managerId={managerId}
          onClose={() => setModalTarget(null)}
          onSaved={load}
        />
      )}
    </div>
  )
}

// ─── Staff view ─────────────────────────────────────────────────────────────────

function MySalaryView({ staffId }: { staffId: string }) {
  const [records, setRecords] = useState<SalaryRecord[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    supabase.from('salary_records').select('*').eq('staff_id', staffId).order('year', { ascending: false }).order('month', { ascending: false })
      .then(({ data }) => { if (data) setRecords(data as SalaryRecord[]) })
  }, [staffId])

  return (
    <div className="space-y-3">
      {records.length === 0 ? (
        <div className="bg-white rounded-xl border border-[#E8DDD0] px-6 py-8 text-center">
          <p className="text-sm text-brown-faint">No salary records yet.</p>
        </div>
      ) : (
        records.map(r => (
          <div key={r.id} className="bg-white rounded-xl border border-[#E8DDD0] overflow-hidden">
            <button
              onClick={() => setExpanded(e => e === r.id ? null : r.id)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-[#FAF6F1] transition-colors text-left"
            >
              <div>
                <p className="text-sm font-semibold text-brown-dark">{MONTHS_FULL[r.month - 1]} {r.year}</p>
                <p className="text-xs text-brown-faint">{r.payment_date ? `Paid ${r.payment_date}` : 'Not yet paid'}</p>
              </div>
              <div className="text-right">
                <p className="text-sm font-bold text-[#3D7A50]">{money(r.net_salary)}</p>
                <p className="text-xs text-brown-faint">Net pay</p>
              </div>
            </button>
            {expanded === r.id && (
              <div className="px-4 pb-4 pt-2 border-t border-[#EDE5D8] space-y-1.5">
                {[
                  ['Basic Salary', r.basic_salary], ['Allowances', r.allowances], ['Overtime', r.overtime],
                  ['Bonus', r.bonus], ['Deductions', -r.deductions], ['Gross Salary', r.gross_salary],
                  ['EPF', -r.epf_employee], ['SOCSO', -r.socso_employee], ['EIS', -r.eis_employee], ['PCB', -r.pcb],
                  ['Net Salary', r.net_salary],
                ].map(([label, val]) => (
                  <div key={label as string} className="flex justify-between text-xs">
                    <span className="text-brown-muted">{label}</span>
                    <span className={typeof val === 'number' && val < 0 ? 'text-[#9E4A30]' : 'text-brown-dark font-medium'}>
                      {money(val as number)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))
      )}
      <p className="text-xs text-brown-faint">For questions about your salary, contact your manager.</p>
    </div>
  )
}

// ─── Page ───────────────────────────────────────────────────────────────────────

export default function HrSalaryPage() {
  const { staff } = useAuth()
  const [allStaff, setAllStaff] = useState<Staff[]>([])
  const isManager = staff?.rank === 'manager'

  useEffect(() => {
    if (isManager) supabase.from('staff').select('*').order('name').then(({ data }) => { if (data) setAllStaff(data as Staff[]) })
  }, [isManager])

  if (!staff) return null

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-6xl mx-auto px-4 py-8 lg:px-8">
        <h1 className="text-2xl font-bold text-brown-dark mb-1">Salary Records</h1>
        <p className="text-sm text-brown-faint mb-6">
          {isManager ? 'Manage monthly salary records for all staff.' : 'View your monthly salary records.'}
        </p>
        {isManager ? (
          <ManagerSalaryView allStaff={allStaff} managerId={staff.id} />
        ) : (
          <MySalaryView staffId={staff.id} />
        )}
      </div>
    </div>
  )
}
