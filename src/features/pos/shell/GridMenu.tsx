// src/features/pos/shell/GridMenu.tsx
import type { ComponentType } from 'react'
import { ClipboardList, LayoutGrid, Receipt, Settings, UtensilsCrossed } from 'lucide-react'
import { MENU_LABEL, type MenuItem } from './shellMenu'

const ICON: Record<MenuItem, ComponentType<{ size?: number }>> = {
  order: LayoutGrid, menu: UtensilsCrossed, transaction: Receipt, report: ClipboardList, setting: Settings,
}

/** The sheet the bottom bar's grid button opens (spec §1). */
export default function GridMenu({ items, current, onPick, onClose }: {
  items: MenuItem[]             // menuItems(...)
  current: MenuItem | null      // the screen that is open
  onPick: (item: MenuItem) => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-30 bg-black/40" onClick={onClose}>
      <div role="menu" aria-label="POS menu" onClick={(e) => e.stopPropagation()}
        className="absolute bottom-16 left-2 grid w-[420px] grid-cols-3 gap-2 rounded-2xl bg-card p-3 shadow-card-hover">
        {items.map((i) => {
          const Icon = ICON[i]
          return (
            <button key={i} role="menuitem" type="button" onClick={() => onPick(i)}
              className={`flex h-24 flex-col items-center justify-center gap-2 rounded-xl ${current === i ? 'bg-brown-btn text-white' : 'bg-cream text-brown-dark hover:bg-border'}`}>
              <Icon size={28} />
              <span className="text-sm font-medium">{MENU_LABEL[i]}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
