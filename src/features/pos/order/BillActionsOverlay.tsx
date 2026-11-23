// src/features/pos/order/BillActionsOverlay.tsx
import type { ComponentType } from 'react'
import { ArrowRightLeft, Ban, CheckCheck, CircleX, Eraser, Pause, Percent, Play, QrCode, Scissors, Send, Undo2, UserRound, Users } from 'lucide-react'
import ActionsOverlay from './ActionsOverlay'
import { BILL_ACTION_LABEL, type BillAction } from './billActions'

const ICON: Record<BillAction, ComponentType<{ size?: number }>> = {
  send: Send, mark_served: CheckCheck, move: ArrowRightLeft, split: Scissors, discount_bill: Percent, edit_bill_discount: Percent, remove_bill_discount: Undo2,
  void_bill: Ban, close_empty: CircleX, pax: Users, pause_qr: Pause, resume_qr: Play, clear_qr_cart: Eraser, member: UserRound, open_qr: QrCode,
}

/** The bill's actions (billActions()); Void bill and Close empty bill are red. An action with a note
 *  (e.g. Split / Move items offline, or a bill with a part paid) is shown disabled with the note under it. */
export default function BillActionsOverlay({ title, actions, disabled, notes, onPick, onClose }: {
  title: string
  actions: BillAction[]
  disabled: boolean             // a bill action is already running
  notes?: Partial<Record<BillAction, string>>
  onPick: (a: BillAction) => void
  onClose: () => void
}) {
  return (
    <ActionsOverlay title={title} menuLabel="Bill actions" empty="Nothing to do on this bill yet." disabled={disabled}
      onPick={onPick} onClose={onClose}
      actions={actions.map((a) => ({
        id: a, label: BILL_ACTION_LABEL[a], icon: ICON[a], danger: a === 'void_bill' || a === 'close_empty',
        disabled: !!notes?.[a], note: notes?.[a],
      }))} />
  )
}
