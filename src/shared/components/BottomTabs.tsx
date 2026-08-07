import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  User, CalendarCheck, CalendarDays, Target,
  LayoutDashboard, CheckSquare, ShoppingCart, Menu,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useCan } from '../lib/permissions'
import { pickTabIds } from '../lib/tabs'
import type { TabId } from '../lib/tabs'
import { SidebarContent } from './Sidebar'

interface TabView {
  label: string
  to: string
  icon: LucideIcon
  /** Prefix-matched paths that light this tab up. */
  activePaths: string[]
}

const TABS: Record<TabId, TabView> = {
  profile:    { label: 'Profile',    to: '/profile',            icon: User,            activePaths: ['/profile'] },
  attendance: { label: 'Attendance', to: '/hr/attendance',      icon: CalendarCheck,   activePaths: ['/hr/attendance'] },
  schedule:   { label: 'Schedule',   to: '/schedule',           icon: CalendarDays,    activePaths: ['/schedule'] },
  missions:   { label: 'Missions',   to: '/missions',           icon: Target,          activePaths: ['/missions'] },
  team:       { label: 'Team',       to: '/dashboard',          icon: LayoutDashboard, activePaths: ['/dashboard', '/staff/'] },
  tasks:      { label: 'Tasks',      to: '/tasks',              icon: CheckSquare,     activePaths: ['/tasks'] },
  // The rest of procurement lives in More, so any procurement page keeps this
  // tab lit rather than leaving nothing selected.
  orders:     { label: 'Orders',     to: '/procurement/orders', icon: ShoppingCart,    activePaths: ['/procurement'] },
}

function TabButton({ view, active, onClick }: {
  view: TabView
  active: boolean
  onClick?: () => void
}) {
  const Icon = view.icon
  return (
    <Link
      to={view.to}
      onClick={onClick}
      className={`relative flex flex-1 flex-col items-center justify-center gap-0.5 min-h-[44px] select-none ${
        active ? 'text-cream' : 'text-[#D4C4B0]'
      }`}
    >
      {active && (
        <span className="absolute top-0 h-[2.5px] w-6 rounded-b bg-xp" aria-hidden />
      )}
      <Icon size={20} strokeWidth={active ? 2.4 : 1.9} />
      <span className={`text-[9.5px] leading-none ${active ? 'font-bold' : 'font-medium'}`}>
        {view.label}
      </span>
    </Link>
  )
}

/**
 * Mobile-only bottom navigation. Replaces the old hamburger top bar: the four
 * destinations that matter for the signed-in user's role sit in the bar, and
 * everything else stays reachable through More, which opens the same sidebar
 * drawer as before.
 */
export function BottomTabs() {
  const { can } = useCan()
  const { pathname } = useLocation()
  const [moreOpen, setMoreOpen] = useState(false)

  useEffect(() => { setMoreOpen(false) }, [pathname])

  // Freeze the page behind the drawer, otherwise scrolling the drawer drags the
  // page underneath it on iOS.
  useEffect(() => {
    if (!moreOpen) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [moreOpen])

  const ids = pickTabIds(can)

  return (
    <>
      <nav
        className="sm:hidden fixed bottom-0 left-0 right-0 z-30 flex bg-brown-header
                   pb-[var(--safe-bottom)] pl-[var(--safe-left)] pr-[var(--safe-right)]"
      >
        {/* The border lives on the inner box, not the nav, so that box-sizing
            folds it into --tabbar-h — otherwise the bar stands 1px taller than
            the space AppLayout reserves for it. */}
        <div className="flex w-full h-[var(--tabbar-h)] border-t border-[#5A3A22]">
          {ids.map(id => {
            const view = TABS[id]
            const active = view.activePaths.some(
              p => pathname === p || pathname.startsWith(p),
            )
            return <TabButton key={id} view={view} active={active} />
          })}

          <button
            onClick={() => setMoreOpen(true)}
            aria-label="More"
            aria-expanded={moreOpen}
            className={`relative flex flex-1 flex-col items-center justify-center gap-0.5
                        min-h-[44px] select-none ${
                          moreOpen ? 'text-cream' : 'text-[#D4C4B0]'
                        }`}
          >
            {moreOpen && (
              <span className="absolute top-0 h-[2.5px] w-6 rounded-b bg-xp" aria-hidden />
            )}
            <Menu size={20} strokeWidth={moreOpen ? 2.4 : 1.9} />
            <span className={`text-[9.5px] leading-none ${moreOpen ? 'font-bold' : 'font-medium'}`}>
              More
            </span>
          </button>
        </div>
      </nav>

      {moreOpen && (
        <>
          <div
            className="sm:hidden fixed inset-0 z-40 bg-black/50"
            onClick={() => setMoreOpen(false)}
          />
          <aside
            className="sm:hidden fixed left-0 top-0 h-full w-64 z-50 bg-brown-header shadow-xl
                       pt-[var(--safe-top)] pb-[var(--safe-bottom)] pl-[var(--safe-left)]"
          >
            <SidebarContent
              onNavigate={() => setMoreOpen(false)}
              onClose={() => setMoreOpen(false)}
            />
          </aside>
        </>
      )}
    </>
  )
}
