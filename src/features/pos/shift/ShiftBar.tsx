import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { fetchShiftStatus } from './shiftApi'
import { shiftLabel, staleShiftNote, type OpenShift, type ShiftStatus } from './shift'
import OpenShiftSheet from './OpenShiftSheet'
import CashMoveSheet from './CashMoveSheet'
import CloseShiftSheet from './CloseShiftSheet'
import ShiftsDrawer from './ShiftsDrawer'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
type Sheet = 'open' | 'move' | 'shifts' | null
const NOTE_MS = 8_000                              // "Shift opened" and the like fade after a while

/** The shift part of the POS top bar: Open shift, or "Shift open · since 09:02" with Pay in / out
 *  and Close shift; Shifts for supervisors. Read again whenever the POS page refreshes
 *  (`refreshKey`: a bill changed here or on another iPad, and every 15 s). The sheets render
 *  into document.body, so they do not take the header's small muted text. */
export default function ShiftBar({ branchId, refreshKey, canSupervise }: { branchId: string; refreshKey: number; canSupervise: boolean }) {
  const [status, setStatus] = useState<ShiftStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sheet, setSheet] = useState<Sheet>(null)
  const [note, setNote] = useState<string | null>(null)
  // kept from when Close shift was pressed: a status read meanwhile (the shift now closed) must not unmount the sheet
  const [closing, setClosing] = useState<{ shift: OpenShift; openBillCount: number } | null>(null)
  const seq = useRef(0)

  const load = useCallback(async () => {
    const id = ++seq.current                       // only the newest reply counts
    try {
      const s = await fetchShiftStatus()
      if (id === seq.current) { setStatus(s); setError(null) }
    } catch (e) { if (id === seq.current) setError(msg(e)) }
  }, [])
  useEffect(() => { void load() }, [load, refreshKey])
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), NOTE_MS)
    return () => clearTimeout(t)
  }, [note])

  const closeSheet = () => { setSheet(null); setClosing(null); void load() }
  const btn = 'rounded border border-border px-3 py-1'
  const stale = status ? staleShiftNote(status) : null
  return (
    <>
      {error ? (
        // without a known shift nothing that moves money is offered
        <span role="alert" className="text-red-700">Shift: {error} <button className="underline" onClick={() => void load()}>Try again</button></span>
      ) : !status ? (
        <span>Shift…</span>
      ) : !status.shift ? (
        <button onClick={() => { setNote(null); setSheet('open') }} className="rounded bg-brown-btn px-3 py-1 text-white">Open shift</button>
      ) : (
        <>
          <span className="font-medium text-brown-dark">{shiftLabel(status)}</span>
          {stale && <span role="status" className="rounded bg-amber-100 px-2 py-0.5 text-amber-800">{stale}</span>}
          <button onClick={() => { setNote(null); setSheet('move') }} className={btn}>Pay in / out</button>
          <button onClick={() => { setNote(null); setClosing({ shift: status.shift as OpenShift, openBillCount: status.openBillCount }) }}
            className={btn}>Close shift</button>
        </>
      )}
      {note && <span role="status" className="text-green-800">{note}</span>}
      {canSupervise && <button onClick={() => setSheet('shifts')} className={btn}>Shifts</button>}
      {createPortal(
        <>
          {sheet === 'open' && status && (
            <OpenShiftSheet lastFloatSen={status.lastFloatSen} onClose={closeSheet}
              onOpened={(s) => { seq.current++; setStatus(s); setSheet(null); setNote('Shift opened') }} />
          )}
          {sheet === 'move' && (
            <CashMoveSheet branchId={branchId} onClose={closeSheet} onRecorded={(text) => { setNote(text); closeSheet() }} />
          )}
          {closing && (
            <CloseShiftSheet branchId={branchId} shift={closing.shift} openBillCount={closing.openBillCount}
              onClose={closeSheet} onClosed={() => { setNote('Shift closed'); closeSheet() }} />
          )}
          {sheet === 'shifts' && <ShiftsDrawer onClose={() => setSheet(null)} />}
        </>,
        document.body,
      )}
    </>
  )
}
