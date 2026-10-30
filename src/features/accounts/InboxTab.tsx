import { useEffect, useRef, useState } from 'react'
import { Card, Button } from '../../shared/components/ui'
import { inbox } from './api'
import { todayMYT } from './claimDesk'

interface Status { configured: boolean; connected?: boolean; environment?: string; portal?: string; error?: unknown }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Pull the e-Invoices other businesses issued to the company from LHDN MyInvois. */
export function InboxTab({ onSynced }: { onSynced: (month: string) => void }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [statusErr, setStatusErr] = useState('')
  const [month, setMonth] = useState(todayMYT().slice(0, 7))
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const stop = useRef(false)

  useEffect(() => {
    inbox('status').then(r => {
      if (r.ok) setStatus(r.data as unknown as Status)
      else setStatusErr(r.code === 'forbidden' ? 'You do not have access to the e-Invoice inbox.' : `Could not reach the inbox service (${r.code || r.error}).`)
    })
  }, [])

  const line = (s: string) => setLog(l => [...l, s])

  async function sync() {
    stop.current = false
    setRunning(true); setLog([])
    line(`Searching MyInvois for e-Invoices received in ${month}…`)
    let page = 1, pages = 1
    const tally = { created: 0, updated: 0, cancelled: 0, total: 0 }
    try {
      do {
        const r = await inbox('sync', { month, page })
        if (!r.ok) {
          if (r.code === 'rate_limited') { line('LHDN asks us to slow down — waiting 30 s…'); await sleep(30_000); continue }
          line(`Stopped: ${r.error}`)
          break
        }
        const d = r.data as Record<string, number>
        pages = d.totalPages || 1
        tally.created += d.created; tally.updated += d.updated; tally.cancelled += d.cancelled; tally.total = d.totalCount
        line(`Page ${page} of ${pages}: ${d.seen} documents — ${d.created} new, ${d.updated} already in the Register, ${d.cancelled} cancelled.`)
        page++
        // LHDN allows one search every 5 seconds per taxpayer.
        if (page <= pages && !stop.current) await sleep(5500)
      } while (page <= pages && !stop.current)
      line(`Done${stop.current ? ' (stopped)' : ''}: ${tally.total} e-Invoices in ${month}; ${tally.created} added, ${tally.cancelled} cancelled.`)
      onSynced(month)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-brown-dark">e-Invoice inbox (MyInvois)</h2>
        <p className="text-sm text-brown-muted max-w-2xl">
          Every e-Invoice a supplier issues to the company's TIN — Shopee sellers, Lalamove, bank fees, food suppliers — is pulled
          straight from LHDN with its amount, so nothing has to be typed from the Gmail notices.
        </p>
      </div>
      <div className="rounded-xl bg-[#E2EDF5] text-[#2F5F82] text-sm px-4 py-3">
        On Shopee, press <b>Request e-Invoice</b> on each order and enter the company TIN. Otherwise the seller only issues a consolidated e-Invoice and it never reaches this inbox.
      </div>

      {statusErr && <p className="text-sm text-bad">{statusErr}</p>}
      {!status && !statusErr && <p className="text-sm text-brown-faint">Checking the MyInvois connection…</p>}

      {status && !status.configured && (
        <Card className="space-y-3">
          <p className="font-semibold text-brown-dark">Not connected to MyInvois yet</p>
          <p className="text-sm text-brown-muted">The company director (or a representative with MyInvois access) needs to register Craft OS once:</p>
          <ol className="list-decimal pl-5 text-sm text-brown-dark space-y-1.5">
            <li>Log in to <a className="underline" href="https://mytax.hasil.gov.my" target="_blank" rel="noopener noreferrer">MyTax</a> and open <b>MyInvois</b>, acting for CRAFTALE SDN. BHD.</li>
            <li>In the taxpayer profile, open <b>View and Register ERP</b> → <b>Register ERP</b>, and add a system named <b>Craft OS</b>.</li>
            <li>Copy the <b>Client ID</b> and <b>Client Secret</b> it shows. Save them straight away — do not send them in a group chat.</li>
            <li>Give both to whoever looks after Craft OS. They are saved as <code>MYINVOIS_CLIENT_ID</code> and <code>MYINVOIS_CLIENT_SECRET</code> in the server settings — never in the app itself.</li>
          </ol>
          <p className="text-xs text-brown-faint">Reading received e-Invoices does not need a digital certificate. The Client Secret has an expiry date; register a new one before it runs out.</p>
        </Card>
      )}

      {status?.configured && (
        <Card className="space-y-3">
          <p className="text-sm">
            {status.connected
              ? <span className="text-ok font-semibold">Connected to MyInvois ({status.environment}).</span>
              : <span className="text-bad font-semibold">MyInvois refused the credentials ({status.environment}). Check the Client ID / Secret.</span>}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="block text-[11px] font-semibold text-brown-muted mb-1">Month (issue date)</label>
              <input type="month" className="px-2.5 py-1.5 rounded-lg border border-border-mid bg-canvas text-sm" value={month}
                max={todayMYT().slice(0, 7)} onChange={e => setMonth(e.target.value)} />
            </div>
            <Button variant="dark" onClick={sync} disabled={running || !status.connected || !month}>{running ? 'Syncing…' : 'Sync from MyInvois'}</Button>
            {running && <Button variant="secondary" onClick={() => { stop.current = true }}>Stop</Button>}
          </div>
          <p className="text-xs text-brown-faint">About 100 e-Invoices every 6 seconds (LHDN's limit), so 800 take a little over a minute. Running it again only adds new ones and marks cancellations.</p>
          {log.length > 0 && (
            <pre className="text-xs font-mono bg-cream rounded-lg p-3 max-h-56 overflow-auto whitespace-pre-wrap">{log.join('\n')}</pre>
          )}
        </Card>
      )}
    </div>
  )
}
