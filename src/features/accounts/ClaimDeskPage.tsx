import { useCallback, useEffect, useMemo, useState } from 'react'
import { Sparkles, Download } from 'lucide-react'
import { supabase } from '../../shared/lib/supabase'
import { PageHeader, SegmentedTabs, Button } from '../../shared/components/ui'
import { aiRead, loadAccounts } from './api'
import {
  PLATFORM, SOURCE_LABEL, STATUS, buildAutoCountCsv, monthRange, money, todayMYT,
  type AccountDoc, type AccountRow, type DocSource, type DocStatus,
} from './claimDesk'
import { downloadBlob } from './imaging'
import { DocDrawer } from './DocDrawer'
import { ScanDocTab } from './ScanDocTab'
import { InboxTab } from './InboxTab'
import { GuideTab } from './GuideTab'

type Tab = 'register' | 'scan' | 'inbox' | 'guide'

const STATUS_STYLE: Record<DocStatus, string> = {
  'Needs info': 'bg-[#FBEEDC] text-[#A8651F]',
  'Draft': 'bg-[#F7EFE4] text-brown-muted',
  'Reviewed': 'bg-[#E2EDF5] text-[#3A76A0]',
  'Posted to AutoCount': 'bg-ok-bg text-ok',
  'Cancelled': 'bg-bad-bg text-bad',
}

const PORTAL = 'https://myinvois.hasil.gov.my'

export default function ClaimDeskPage() {
  const [tab, setTab] = useState<Tab>(() => {
    const h = window.location.hash.slice(1)
    return (['register', 'scan', 'inbox', 'guide'] as Tab[]).includes(h as Tab) ? h as Tab : 'register'
  })
  const [period, setPeriod] = useState(todayMYT().slice(0, 7))
  const [source, setSource] = useState<'all' | DocSource>('all')
  const [statusFilter, setStatusFilter] = useState<DocStatus | null>(null)
  const [docs, setDocs] = useState<AccountDoc[] | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [accounts, setAccounts] = useState<AccountRow[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [toast, setToast] = useState('')
  const [aiBusy, setAiBusy] = useState(false)

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 4000) }
  const switchTab = (t: Tab) => { setTab(t); history.replaceState(null, '', `#${t}`) }

  const load = useCallback(async () => {
    const { from, to } = monthRange(period)
    const { data, error } = await supabase.from('account_docs').select('*')
      .gte('doc_date', from).lte('doc_date', to)
      .order('doc_date', { ascending: false }).order('created_at', { ascending: false })
    if (error) { setLoadErr(error.message); setDocs([]); return }
    setLoadErr('')
    setDocs((data as AccountDoc[]) ?? [])
  }, [period])

  useEffect(() => { setDocs(null); load() }, [load])
  const reloadAccounts = useCallback(() => { loadAccounts().then(setAccounts) }, [])
  useEffect(reloadAccounts, [reloadAccounts])

  const base = useMemo(() => (docs ?? []).filter(d => source === 'all' || d.source === source), [docs, source])
  const rows = useMemo(() => base.filter(d => !statusFilter || d.status === statusFilter), [base, statusFilter])
  const open = docs?.find(d => d.id === openId) ?? null

  function exportCsv() {
    const r = buildAutoCountCsv(rows, accounts)
    if (!r.rows) { flash('Nothing to export for this month'); return }
    downloadBlob(`AutoCount_${period}${source === 'all' ? '' : '_' + source}.csv`, new Blob([r.csv], { type: 'text/csv;charset=utf-8' }))
    if (r.missing) flash(`${r.missing} document${r.missing > 1 ? 's are' : ' is'} still missing an account or amount — those cells are blank`)
  }

  async function suggestAccounts() {
    const todo = (docs ?? []).filter(d => !d.gl_account && d.supplier && d.status !== 'Cancelled')
    if (!todo.length) { flash('Every document this month already has an account'); return }
    setAiBusy(true)
    const names = [...new Set(todo.map(d => d.supplier!))].slice(0, 100)
    const accountNames = accounts.map(a => a.name)
    const r = await aiRead<{ supplier: string; account: string; platform: string }[]>('suggest', { suppliers: names }, accountNames)
    if (!r.ok) { setAiBusy(false); flash(r.error); return }
    const by = new Map((Array.isArray(r.data) ? r.data : []).map(x => [x.supplier, x]))
    let n = 0
    for (const d of todo) {
      const s = by.get(d.supplier!)
      if (!s || !accountNames.includes(s.account)) continue
      await supabase.from('account_docs').update({
        gl_account: s.account,
        platform: d.platform || ((PLATFORM as readonly string[]).includes(s.platform) ? s.platform : null),
        notes: `${d.notes ?? ''} [AI suggested account]`.trim(),
      }).eq('id', d.id)
      n++
    }
    setAiBusy(false)
    flash(`AI filled in ${n} account${n === 1 ? '' : 's'} — please check them`)
    load()
  }

  function goTo(id: string, docDate: string) {
    switchTab('register')
    const p = docDate.slice(0, 7)
    if (p !== period) setPeriod(p)
    else load()
    setOpenId(id)
  }

  return (
    <div className="min-h-screen bg-cream">
      <div className="max-w-6xl mx-auto px-4 py-8 lg:px-8 space-y-5">
        <PageHeader eyebrow="Accounts" title="Claim Desk" subtitle="Documents → classification → AutoCount" />
        <SegmentedTabs label="Claim Desk sections" value={tab} onChange={switchTab} tabs={[
          { id: 'register', label: 'Register' },
          { id: 'scan', label: 'Scan document' },
          { id: 'inbox', label: 'e-Invoice inbox' },
          { id: 'guide', label: 'Guide & accounts' },
        ]} />

        {tab === 'register' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                <div>
                  <label className="block text-[11px] font-semibold text-brown-muted mb-1">Period</label>
                  <input type="month" className="px-2.5 py-1.5 rounded-lg border border-border-mid bg-white text-sm" value={period}
                    onChange={e => { if (e.target.value) { setPeriod(e.target.value); setStatusFilter(null) } }} />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-brown-muted mb-1">Source</label>
                  <select className="px-2.5 py-1.5 rounded-lg border border-border-mid bg-white text-sm" value={source} onChange={e => setSource(e.target.value as typeof source)}>
                    <option value="all">All</option>
                    {(Object.keys(SOURCE_LABEL) as DocSource[]).map(s => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
                  </select>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" icon={<Sparkles size={14} />} onClick={suggestAccounts} disabled={aiBusy || !docs}>
                  {aiBusy ? 'AI is thinking…' : 'AI: suggest missing accounts'}
                </Button>
                <Button variant="dark" size="sm" icon={<Download size={14} />} onClick={exportCsv} disabled={!docs}>Export AutoCount CSV</Button>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {STATUS.map(s => {
                const list = base.filter(d => d.status === s)
                if (!list.length && s === 'Cancelled') return null
                const sum = list.reduce((t, d) => t + (Number(d.amount_myr) || 0), 0)
                const on = statusFilter === s
                return (
                  <button key={s} type="button" aria-pressed={on} onClick={() => setStatusFilter(on ? null : s)}
                    className={`text-left rounded-xl bg-white shadow-card px-3 py-2 min-w-[128px] border ${on ? 'border-accent' : 'border-transparent'}`}>
                    <span className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded-full ${STATUS_STYLE[s]}`}>{s}</span>
                    <span className="block text-lg font-bold font-mono text-brown-dark">{list.length}</span>
                    <span className="block text-[11px] font-mono text-brown-muted">RM {money(sum)}</span>
                  </button>
                )
              })}
            </div>

            {loadErr && <p className="text-sm text-bad">Could not load the Register: {loadErr}</p>}

            <div className="overflow-x-auto rounded-2xl bg-white shadow-card">
              <table className="w-full min-w-[820px] text-sm">
                <thead className="bg-canvas text-[11px] uppercase tracking-wider text-brown-muted">
                  <tr>
                    <th className="text-left p-3">Date</th><th className="text-left p-3">Source</th><th className="text-left p-3">Supplier</th>
                    <th className="text-left p-3">Ref</th><th className="text-right p-3">MYR</th><th className="text-left p-3">Account</th>
                    <th className="text-left p-3">Status</th><th className="text-left p-3">Voucher</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {docs === null && <tr><td colSpan={8} className="p-8 text-center text-brown-faint">Loading {period}…</td></tr>}
                  {docs !== null && rows.length === 0 && (
                    <tr><td colSpan={8} className="p-8 text-center text-brown-faint">
                      Nothing in {period} yet. Scan a paper invoice, sync the e-Invoice inbox, or approve a staff claim.
                    </td></tr>
                  )}
                  {rows.map(d => (
                    <tr key={d.id} onClick={() => setOpenId(d.id)} className="cursor-pointer hover:bg-[#F7EFE4] align-top">
                      <td className="p-3 font-mono text-xs whitespace-nowrap">{d.doc_date}</td>
                      <td className="p-3">
                        <span className="text-[11px] font-bold uppercase tracking-wide text-brown-muted">{SOURCE_LABEL[d.source]}</span>
                        {d.platform && <div className="text-xs text-brown-faint">{d.platform}</div>}
                      </td>
                      <td className="p-3 min-w-[180px]">
                        {d.supplier || '—'}
                        <div className="text-xs text-brown-faint">{d.doc_type}</div>
                      </td>
                      <td className="p-3 font-mono text-xs">{d.supplier_ref}</td>
                      <td className="p-3 text-right font-mono whitespace-nowrap">
                        {money(d.amount_myr)}
                        {d.currency !== 'MYR' && d.amount != null && <div className="text-[11px] text-brown-faint">{d.currency} {money(d.amount)}</div>}
                      </td>
                      <td className="p-3 min-w-[150px]">{d.gl_account || <span className="text-brown-faint">Unclassified</span>}</td>
                      <td className="p-3">
                        <span className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap ${STATUS_STYLE[d.status]}`}>{d.status}</span>
                        {d.self_billed === 'Required – pending' && <div className="text-[11px] text-[#A8651F] mt-0.5">Self-billed due</div>}
                      </td>
                      <td className="p-3 font-mono text-xs">{d.voucher_no}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'scan' && <ScanDocTab accounts={accounts} onCreated={goTo} />}
        {tab === 'inbox' && <InboxTab onSynced={m => { if (m === period) load() }} />}
        {tab === 'guide' && <GuideTab accounts={accounts} onSaved={reloadAccounts} />}
      </div>

      {open && (
        <DocDrawer key={open.id} doc={open} accounts={accounts} portal={PORTAL}
          onClose={() => setOpenId(null)}
          onSaved={m => { setOpenId(null); flash(m); load() }} />
      )}
      {toast && (
        <div role="status" className="fixed left-1/2 -translate-x-1/2 bottom-6 z-[60] bg-brown-dark text-cream px-4 py-2.5 rounded-lg text-sm shadow-lg max-w-[calc(100%-32px)]">
          {toast}
        </div>
      )}
    </div>
  )
}
