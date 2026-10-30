// src/features/pos/order/ActionsOverlay.tsx
import type { ComponentType } from 'react'
import { X } from 'lucide-react'

export interface OverlayAction<A extends string> {
  id: A
  label: string
  icon: ComponentType<{ size?: number }>
  danger?: boolean
}

/** The dark overlay of round action buttons (spec §3, Feedme style) that the bill's grid button and
 *  a tapped sent item open. Danger actions are red. */
export default function ActionsOverlay<A extends string>({ title, menuLabel, empty, actions, disabled, onPick, onClose }: {
  title: string
  menuLabel: string             // "Bill actions"
  empty: string                 // shown when there is nothing to offer
  actions: OverlayAction<A>[]
  disabled: boolean             // an action is already running
  onPick: (a: A) => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-30 flex flex-col items-center justify-center bg-brown-dark/90 p-6" onClick={onClose}>
      <h2 className="mb-8 text-xl font-semibold text-cream">{title}</h2>
      <div role="menu" aria-label={menuLabel} className="flex max-w-3xl flex-wrap justify-center gap-6" onClick={(e) => e.stopPropagation()}>
        {actions.map(({ id, label, icon: Icon, danger }) => (
          <button key={id} type="button" role="menuitem" disabled={disabled} onClick={() => onPick(id)}
            className="flex w-24 flex-col items-center gap-2 text-cream disabled:opacity-40">
            <span className={`flex h-20 w-20 items-center justify-center rounded-full ${danger ? 'bg-red-700 text-white' : 'bg-cream text-brown-dark'}`}><Icon size={30} /></span>
            <span className="text-center text-sm font-medium">{label}</span>
          </button>
        ))}
        {actions.length === 0 && <p className="text-cream">{empty}</p>}
      </div>
      <button type="button" onClick={onClose} aria-label={`Close ${menuLabel.toLowerCase()}`}
        className="mt-10 flex h-14 w-14 items-center justify-center rounded-full border border-cream/50 text-cream"><X size={26} /></button>
    </div>
  )
}
