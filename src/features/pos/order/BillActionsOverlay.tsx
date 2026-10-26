// src/features/pos/order/BillActionsOverlay.tsx
import type { ComponentType } from 'react'
import { ArrowRightLeft, Ban, CircleX, Pause, Play, QrCode, Send, Users, X } from 'lucide-react'
import { BILL_ACTION_LABEL, type BillAction } from './billActions'

const ICON: Record<BillAction, ComponentType<{ size?: number }>> = {
  send: Send, move: ArrowRightLeft, void_bill: Ban, close_empty: CircleX, pax: Users,
  pause_qr: Pause, resume_qr: Play, open_qr: QrCode,
}

/** The dark overlay of round action buttons the bill's grid button opens (spec §3, Feedme style).
 *  Shows only the actions billActions() gives; Void bill and Close empty bill are red. */
export default function BillActionsOverlay({ title, actions, disabled, onPick, onClose }: {
  title: string
  actions: BillAction[]
  disabled: boolean             // a bill action is already running
  onPick: (a: BillAction) => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-30 flex flex-col items-center justify-center bg-brown-dark/90 p-6" onClick={onClose}>
      <h2 className="mb-8 text-xl font-semibold text-cream">{title}</h2>
      <div role="menu" aria-label="Bill actions" className="flex max-w-3xl flex-wrap justify-center gap-6" onClick={(e) => e.stopPropagation()}>
        {actions.map((a) => {
          const Icon = ICON[a]
          const danger = a === 'void_bill' || a === 'close_empty'
          return (
            <button key={a} type="button" role="menuitem" disabled={disabled} onClick={() => onPick(a)}
              className="flex w-24 flex-col items-center gap-2 text-cream disabled:opacity-40">
              <span className={`flex h-20 w-20 items-center justify-center rounded-full ${danger ? 'bg-red-700 text-white' : 'bg-cream text-brown-dark'}`}><Icon size={30} /></span>
              <span className="text-center text-sm font-medium">{BILL_ACTION_LABEL[a]}</span>
            </button>
          )
        })}
        {actions.length === 0 && <p className="text-cream">Nothing to do on this bill yet.</p>}
      </div>
      <button type="button" onClick={onClose} aria-label="Close bill actions"
        className="mt-10 flex h-14 w-14 items-center justify-center rounded-full border border-cream/50 text-cream"><X size={26} /></button>
    </div>
  )
}
