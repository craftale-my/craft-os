// src/features/pos/order/BillActionsOverlay.tsx
import type { ComponentType } from 'react'
import { ArrowRightLeft, Ban, CircleX, Pause, Percent, Play, QrCode, Send, Undo2, Users } from 'lucide-react'
import ActionsOverlay from './ActionsOverlay'
import { BILL_ACTION_LABEL, type BillAction } from './billActions'

const ICON: Record<BillAction, ComponentType<{ size?: number }>> = {
  send: Send, move: ArrowRightLeft, discount_bill: Percent, edit_bill_discount: Percent, remove_bill_discount: Undo2,
  void_bill: Ban, close_empty: CircleX, pax: Users, pause_qr: Pause, resume_qr: Play, open_qr: QrCode,
}

/** The bill's actions (billActions()); Void bill and Close empty bill are red. */
export default function BillActionsOverlay({ title, actions, disabled, onPick, onClose }: {
  title: string
  actions: BillAction[]
  disabled: boolean             // a bill action is already running
  onPick: (a: BillAction) => void
  onClose: () => void
}) {
  return (
    <ActionsOverlay title={title} menuLabel="Bill actions" empty="Nothing to do on this bill yet." disabled={disabled}
      onPick={onPick} onClose={onClose}
      actions={actions.map((a) => ({ id: a, label: BILL_ACTION_LABEL[a], icon: ICON[a], danger: a === 'void_bill' || a === 'close_empty' }))} />
  )
}
