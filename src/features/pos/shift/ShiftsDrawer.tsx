import { useCallback, useEffect, useRef, useState } from 'react'
import { formatSen } from '../order/cart'
import { formatMyt } from '../print/ticket'
import type { ZReport } from '../print/zreport'
import { fetchShiftList, fetchShiftZReport, reprintZReport } from './shiftApi'
import ZReportView from './ZReportView'
import { varianceLabel, type ShiftListRow } from './shift'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Shifts (Approve POS voids & refunds): the last 30 closed shifts; each opens its frozen Z report with Reprint. */
export default function ShiftsDrawer({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<ShiftListRow[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [open, setOpen] = useState<ShiftListRow | null>(null)
  const [report, setReport] = useState<ZReport | null>(null)
  const [reportError, setReportError] = useState<string | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [printing, setPrinting] = useState(false)
  const printingRef = useRef(false)
  const listSeq = useRef(0)
  const reportSeq = useRef(0)

  const loadList = useCallback(async () => {
    const id = ++listSeq.current
    setListError(null)
    try { const r = await fetchShiftList(); if (id === listSeq.current) setRows(r) } catch (e) { if (id === listSeq.current) setListError(msg(e)) }
  }, [])
  useEffect(() => { void loadList() }, [loadList])

  const loadReport = async (row: ShiftListRow) => {
    const id = ++reportSeq.current                 // a slow reply for a shift no longer open is dropped
    setOpen(row); setReport(null); setReportError(null); setNote(null)
    try { const r = await fetchShiftZReport(row.id); if (id === reportSeq.current) setReport(r) } catch (e) { if (id === reportSeq.current) setReportError(msg(e)) }
  }

  const reprint = async () => {
    if (!open || printingRef.current) return
    printingRef.current = true; setPrinting(true); setNote(null)
    try { await reprintZReport(open.id); setNote({ ok: true, text: 'Z report sent to the receipt printer' }) } catch (e) { setNote({ ok: false, text: msg(e) }) }
    finally { printingRef.current = false; setPrinting(false) }
  }

  const back = () => { reportSeq.current++; setOpen(null); setReport(null); setReportError(null); setNote(null) }
  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/30" onClick={onClose}>
      <div className="flex h-full w-full max-w-xl flex-col bg-card" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border p-4">
          <h2 className="text-lg font-semibold">{open ? `Shift closed ${formatMyt(open.closedAt)}` : 'Shifts'}</h2>
          <div className="flex gap-2">
            {open && <button onClick={back} className="rounded border border-border px-3 py-1 text-sm">Back</button>}
            <button onClick={onClose} className="rounded border border-border px-3 py-1 text-sm">Close</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-3 text-sm">
          {!open && (
            <>
              {listError && <p role="alert" className="rounded bg-red-50 p-2 text-red-700">{listError} <button className="underline" onClick={() => void loadList()}>Try again</button></p>}
              {!listError && rows === null && <p className="text-brown-muted">Loading…</p>}
              {rows?.length === 0 && <p className="text-brown-muted">No closed shifts yet.</p>}
              {rows?.map((r) => (
                <button key={r.id} onClick={() => void loadReport(r)} className="mb-2 flex w-full items-center justify-between rounded-lg border border-border p-2 text-left">
                  <div>
                    <div className="font-medium">{formatMyt(r.openedAt)} – {formatMyt(r.closedAt)}</div>
                    <div className="text-xs text-brown-muted">Opened by {r.openedBy ?? '—'} · closed by {r.closedBy ?? '—'}</div>
                  </div>
                  <div className="text-right">
                    <div>{formatSen(r.nettSen)}</div>
                    <div className={`text-xs ${r.varianceSen === 0 ? 'text-brown-muted' : 'text-red-700'}`}>{varianceLabel(r.varianceSen)}</div>
                  </div>
                </button>
              ))}
            </>
          )}
          {open && (
            <div className="space-y-3">
              {reportError && <p role="alert" className="rounded bg-red-50 p-2 text-red-700">{reportError} <button className="underline" onClick={() => void loadReport(open)}>Try again</button></p>}
              {!reportError && !report && <p className="text-brown-muted">Loading…</p>}
              {report && (
                <>
                  <div className="flex items-center gap-3">
                    <button onClick={() => void reprint()} disabled={printing} className="rounded bg-brown-btn px-3 py-2 text-white disabled:opacity-40">
                      {printing ? 'Printing…' : 'Reprint'}
                    </button>
                    {note && <p role={note.ok ? 'status' : 'alert'} className={note.ok ? 'text-green-800' : 'text-red-700'}>{note.text}</p>}
                  </div>
                  <ZReportView report={report} />
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
