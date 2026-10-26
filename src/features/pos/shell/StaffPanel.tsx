// src/features/pos/shell/StaffPanel.tsx
import { Link } from 'react-router-dom'
import { X } from 'lucide-react'
import PrintHostPanel from '../order/PrintHostPanel'
import ShiftBar from '../shift/ShiftBar'

/** The right-side staff panel (spec §1): the shift (Open / Close shift, Pay in / out), printers,
 *  My PIN, the live status and Logout. It stays MOUNTED and is only hidden when closed: the print
 *  host inside it prints the browser-route tickets of this iPad, and the shift bar keeps a pay in /
 *  pay out whose reply was lost, so neither may unmount when the cashier closes the panel. */
export default function StaffPanel({ open, branchId, branchName, staffName, refreshKey, liveStatus, onShiftChanged, onMyPin, onClose }: {
  open: boolean
  branchId: string
  branchName: string
  staffName: string
  refreshKey: number
  liveStatus: string            // usePosRealtime's status
  onShiftChanged: () => void
  onMyPin: () => void
  onClose: () => void
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
            <ShiftBar branchId={branchId} refreshKey={refreshKey} canSupervise={false} onChanged={onShiftChanged} />
          </div>
        </section>
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-brown-muted">Printers</h3>
          <div className="text-sm [&_button]:min-h-11">
            <PrintHostPanel branchId={branchId} />
          </div>
        </section>
        <button type="button" onClick={onMyPin} className="min-h-12 rounded-xl border border-border-mid px-4 text-left text-brown-dark">My PIN</button>
        <div className="text-sm text-brown-muted">Live: {liveStatus}</div>
        <Link to="/profile" className="mt-auto flex min-h-12 items-center justify-center rounded-xl bg-brown-btn font-medium text-white hover:bg-brown-btn-hover">
          Logout
        </Link>
      </aside>
    </div>
  )
}
