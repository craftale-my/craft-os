// src/features/pos/shell/StaffPanel.tsx
import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import PrintHostPanel from '../order/PrintHostPanel'
import ShiftBar from '../shift/ShiftBar'

/** The right-side staff panel (spec §1): the shift (Open / Close shift, Pay in / out), printers,
 *  My PIN (Craft OS), the live status, Unpair this device (POS app, managers) and the sign-off
 *  button (Exit POS in Craft OS, Lock in the POS app). It stays MOUNTED and is only hidden when
 *  closed: the print host inside it prints the browser-route tickets of this iPad, and the shift
 *  bar keeps a pay in / pay out whose reply was lost, so neither may unmount when the cashier
 *  closes the panel. Only the outlet's printing tablet runs a print host. The POS app runs its
 *  own above the till (it prints on the lock screen too) and hands it in as `printSlot`. */
export default function StaffPanel({ open, branchId, branchName, staffName, refreshKey, liveStatus, canSupervise, prints, locked = false, onShiftChanged, onMyPin, onClose, signOff, onUnpair, onPrintProblems, printSlot }: {
  open: boolean
  branchId: string
  branchName: string
  staffName: string
  refreshKey: number
  liveStatus: string            // usePosRealtime's status
  canSupervise: boolean         // pos_supervise: the shift bar's Shifts button
  prints: boolean               // this device prints the outlet's tickets
  locked?: boolean              // POS app: the tablet is locked, so the shift sheets close
  onShiftChanged: () => void
  onMyPin?: () => void          // Craft OS only
  onClose: () => void
  signOff: { label: string; onClick: () => void }   // Exit POS (asks about unsent items first) or Lock
  onUnpair?: () => void         // POS app, a manager of this outlet signed in
  onPrintProblems: (count: number) => void   // the print host's problem count, for the bottom bar's badge
  printSlot?: HTMLElement       // POS app: the element its one print host renders into; none here then
}) {
  return (
    <div className={open ? 'fixed inset-0 z-30 bg-black/40' : 'hidden'} onClick={onClose}>
      <aside aria-label="Staff panel" onClick={(e) => e.stopPropagation()}
        className="absolute bottom-0 right-0 top-0 flex w-[380px] flex-col gap-5 overflow-y-auto bg-card p-5 shadow-card-hover">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-lg font-semibold text-brown-dark">{staffName}</div>
            <div className="text-sm text-brown-muted">{branchName}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close staff panel"
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-border"><X size={20} /></button>
        </div>
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-brown-muted">Shift</h3>
          <div className="flex flex-wrap items-center gap-2 text-sm [&_button]:min-h-11">
            <ShiftBar branchId={branchId} refreshKey={refreshKey} canSupervise={canSupervise} locked={locked} onChanged={onShiftChanged} />
          </div>
        </section>
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-brown-muted">Printers</h3>
          <div className="text-sm [&_button]:min-h-11">
            {prints
              ? printSlot ? <Slot el={printSlot} /> : <PrintHostPanel branchId={branchId} inline onProblems={onPrintProblems} />
              : <p className="text-brown-muted">This tablet does not print. Tickets print on this outlet's printing tablet.</p>}
          </div>
        </section>
        {onMyPin && <button type="button" onClick={onMyPin} className="min-h-12 rounded-xl border border-border-mid px-4 text-left text-brown-dark">My PIN</button>}
        <div className="text-sm text-brown-muted">Live: {liveStatus}</div>
        {onUnpair && (
          <button type="button" onClick={onUnpair} className="min-h-12 rounded-xl border border-red-300 px-4 text-left text-red-700">
            Unpair this device
          </button>
        )}
        <button type="button" onClick={signOff.onClick} className="mt-auto flex min-h-12 items-center justify-center rounded-xl bg-brown-btn font-medium text-white hover:bg-brown-btn-hover">
          {signOff.label}
        </button>
      </aside>
    </div>
  )
}

/** Shows an element rendered elsewhere (the POS app's print host) in place, without remounting it. */
function Slot({ el }: { el: HTMLElement }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const b = box.current
    b?.appendChild(el)
    return () => { if (el.parentNode === b) b?.removeChild(el) }
  }, [el])
  return <div ref={box} />
}
