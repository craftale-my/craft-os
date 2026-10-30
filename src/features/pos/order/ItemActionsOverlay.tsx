// src/features/pos/order/ItemActionsOverlay.tsx
import type { ComponentType } from 'react'
import { Ban, Percent, Undo2 } from 'lucide-react'
import ActionsOverlay from './ActionsOverlay'
import { ITEM_ACTION_LABEL, type ItemAction } from './billActions'

const ICON: Record<ItemAction, ComponentType<{ size?: number }>> = {
  discount_item: Percent, edit_item_discount: Percent, remove_item_discount: Undo2, void_item: Ban,
}

/** What a tapped sent item offers: discount it (or edit / remove its discount) and void it (red). */
export default function ItemActionsOverlay({ title, actions, disabled, onPick, onClose }: {
  title: string
  actions: ItemAction[]
  disabled: boolean
  onPick: (a: ItemAction) => void
  onClose: () => void
}) {
  return (
    <ActionsOverlay title={title} menuLabel="Item actions" empty="Nothing to do on this item." disabled={disabled}
      onPick={onPick} onClose={onClose}
      actions={actions.map((a) => ({ id: a, label: ITEM_ACTION_LABEL[a], icon: ICON[a], danger: a === 'void_item' }))} />
  )
}
