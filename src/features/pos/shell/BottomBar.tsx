// src/features/pos/shell/BottomBar.tsx
import { LayoutGrid } from 'lucide-react'
import { useMinuteClock } from '../order/useMinuteClock'
import { mytClock } from './shellMenu'

/** The bar at the bottom of every POS screen but Payment (spec §1): the grid menu on the left, the
 *  screen's name in the middle, the staff member and the Malaysia time on the right (tap → staff panel). */
export default function BottomBar({ title, staffName, onMenu, onStaff }: {
  title: string
  staffName: string
  onMenu: () => void
  onStaff: () => void
}) {
  const now = useMinuteClock()
  return (
    <nav className="flex h-14 shrink-0 items-center justify-between bg-brown-header px-2 text-cream">
      <button type="button" onClick={onMenu} aria-label="Menu"
        className="flex h-11 w-14 items-center justify-center rounded-lg hover:bg-brown-btn">
        <LayoutGrid size={24} />
      </button>
      <div className="font-semibold tracking-wide">{title}</div>
      <button type="button" onClick={onStaff} aria-label="Staff panel"
        className="flex h-11 items-center gap-3 rounded-lg px-3 hover:bg-brown-btn">
        <span className="font-medium">{staffName}</span>
        <span className="tabular-nums opacity-80">{mytClock(now)}</span>
      </button>
    </nav>
  )
}
