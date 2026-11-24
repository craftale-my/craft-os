// src/features/pos/shell/BottomBar.tsx
import { LayoutGrid } from 'lucide-react'
import { useMinuteClock } from '../order/useMinuteClock'
import { mytClock } from './shellMenu'

/** The bar at the bottom of every POS screen but Payment (spec §1): the grid menu on the left, the
 *  screen's name in the middle, the staff member and the Malaysia time on the right (tap → staff panel).
 *  Printer problems show as a red badge on the staff button, so they are seen without opening the panel. */
export default function BottomBar({ title, staffName, printProblems = 0, onMenu, onStaff }: {
  title: string
  staffName: string
  printProblems?: number        // the print host's problem count (failed, stuck or waiting tickets)
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
        {printProblems > 0 && (
          <span className="rounded-full bg-red-600 px-3 py-1 text-sm font-semibold text-white">Printer problem · {printProblems}</span>
        )}
        <span className="font-medium">{staffName}</span>
        <span className="tabular-nums opacity-80">{mytClock(now)}</span>
      </button>
    </nav>
  )
}
